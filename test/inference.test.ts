import { createHash } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTestModelCapabilities } from "./model-capabilities-fixture.js";
import {
  APICallError,
  embedMany,
  generateText,
  jsonSchema,
  Output,
  simulateStreamingMiddleware,
  wrapLanguageModel,
} from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import {
  buildRetrievedElementProvenance,
  buildSourceLocation,
  buildTableStructure,
} from "./source-element-fixture.js";
import type {
  LanguageModelV4,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";

import { InferenceMetricsReporter } from "../src/inference/metrics.js";
import {
  createAnswerModelResponseSchema,
  createEvidenceReferences,
} from "../src/answers/draft.js";
import type { EvaluationModelRegistry } from "../tools/evaluation/models.js";
import {
  buildAppConfig,
  type EmbeddingInferenceConfig,
} from "../src/config/index.js";
import { TaskLimiter } from "../src/shared/concurrency.js";
import type { RetrievedElement } from "../src/retrieval/document-retrieval.js";
import type {
  SourceElement,
  TableElement,
} from "../src/domain/source-elements.js";
import {
  buildThinkingProviderOptions,
  createInferenceModelRegistry,
  formatDocumentEmbeddingInput,
  formatQueryEmbeddingInput,
} from "../src/inference/registry.js";
import {
  createTestRuntimeSettings,
  readEqualWeightTestConfig,
  TEST_EMBEDDING_INPUT_FORMAT,
  TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
} from "./config-fixture.js";
import { createTestProviderSettings } from "./provider-settings-fixture.js";
import {
  answerQuestion,
  buildAnswerContent,
  InvalidAnswerDraftError,
  streamAnswerQuestion,
} from "../src/answers/inference.js";
import {
  createAnswerContentCitationKey,
  type AnswerContentSnapshot,
} from "../src/answers/content-snapshot.js";
import {
  noopRunTelemetry,
  type RunTelemetry,
} from "../src/observability/run.js";
import {
  decodeQueryExpansions,
  expandRetrievalQuery,
} from "../src/retrieval/query-expansion.js";
import {
  createRetrievalDescriptionContext,
  describeRetrievalElement,
  doesRetrievalDescriptionMatchElement,
} from "../src/ingestion/retrieval-description.js";
import { generateEvaluationQuestion } from "../tools/evaluation/inference.js";
import { HHEM_DISPLAY_MODEL } from "../src/verification/hhem-client.js";
import { FakeHhemClient } from "./hhem-fixture.js";
import {
  DOCUMENT_EMBEDDING_BATCH_SIZE,
  embedDocumentInputs,
  embedDocumentTexts,
} from "../src/embedding/inference.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function buildTestEmbedding(
  dimensions: number,
  firstValue: number,
): number[] {
  const embedding = Array.from({ length: dimensions }, () => 0);
  embedding[0] = firstValue;
  return embedding;
}

function createOpenAIChatResponse(value: unknown): Response {
  const content = typeof value === "string" ? value : JSON.stringify(value);
  return Response.json({
    choices: [{
      finish_reason: "stop",
      index: 0,
      message: { content, role: "assistant" },
    }],
    created: 1_784_976_000,
    id: "openrouter-completion",
    model: "openrouter/free",
    object: "chat.completion",
    usage: {
      completion_tokens: 5,
      prompt_tokens: 10,
      total_tokens: 15,
    },
  });
}

function createOpenAIChatStreamResponse(contentParts: readonly string[]): Response {
  const events: string[] = [];
  for (const content of contentParts) {
    events.push(`data: ${JSON.stringify({
      choices: [{
        delta: { content, role: "assistant" },
        finish_reason: null,
        index: 0,
      }],
      created: 1_784_976_000,
      id: "openrouter-stream",
      model: "openrouter/free",
      object: "chat.completion.chunk",
    })}\n\n`);
  }
  events.push(`data: ${JSON.stringify({
    choices: [{
      delta: {},
      finish_reason: "stop",
      index: 0,
    }],
    created: 1_784_976_000,
    id: "openrouter-stream",
    model: "openrouter/free",
    object: "chat.completion.chunk",
    usage: {
      completion_tokens: 5,
      prompt_tokens: 10,
      total_tokens: 15,
    },
  })}\n\n`);
  events.push("data: [DONE]\n\n");
  return new Response(events.join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("document embedding worksets", () => {
  it("isolates provider inputs and preserves deterministic output order", async () => {
    const values = Array.from(
      { length: DOCUMENT_EMBEDDING_BATCH_SIZE * 2 + 3 },
      (_, index) => `embedding input ${index}`,
    );
    const observedBatches: string[][] = [];
    const embeddingModel = new MockEmbeddingModelV4({
      doEmbed: async ({ values: batch }) => {
        observedBatches.push([...batch]);
        return {
          embeddings: batch.map((value) => [Number(value.split(" ").at(-1))]),
          usage: { tokens: batch.length },
          warnings: [],
        };
      },
      maxEmbeddingsPerCall: 1_000,
      supportsParallelCalls: true,
    });
    const languageModel = new MockLanguageModelV4();
    const models = buildModelRegistry(languageModel);
    models.documentEmbedding = embeddingModel;

    const embeddings = await embedDocumentTexts(
      models,
      values,
      new TaskLimiter(1),
    );

    expect(observedBatches).toHaveLength(values.length);
    expect(observedBatches.every((batch) => batch.length === 1)).toBe(true);
    expect(observedBatches.flat()).toEqual(values);
    expect(embeddings).toEqual(
      values.map((_, index) => [index]),
    );
  });

  it("splits only a rejected oversized input and retries smaller pieces", async () => {
    const observedInputs: string[] = [];
    const embeddingModel = new MockEmbeddingModelV4({
      doEmbed: async ({ values }) => {
        const value = values[0];
        if (value === undefined) {
          throw new Error("Expected one embedding value.");
        }
        observedInputs.push(value);
        if (value === "original") {
          throw new APICallError({
            message: "maximum context length exceeded",
            requestBodyValues: { input: value },
            responseBody: JSON.stringify({
              code: "context_length_exceeded",
            }),
            statusCode: 400,
            url: "https://embedding.test/v1/embeddings",
          });
        }
        return {
          embeddings: [[value.length]],
          usage: { tokens: value.length },
          warnings: [],
        };
      },
      maxEmbeddingsPerCall: 1,
      supportsParallelCalls: true,
    });
    const models = buildModelRegistry(new MockLanguageModelV4());
    models.documentEmbedding = embeddingModel;

    const embedded = await embedDocumentInputs(
      models,
      [
        {
          inputTokens: 3,
          source: "accepted",
          value: "accepted",
        },
        {
          inputTokens: 10,
          source: "original",
          value: "original",
        },
      ],
      new TaskLimiter(1),
      undefined,
      (input, maximumInputTokens) => {
        expect(input.source).toBe("original");
        expect(maximumInputTokens).toBe(5);
        return [
          { inputTokens: 4, source: "left", value: "left" },
          { inputTokens: 4, source: "right", value: "right" },
        ];
      },
    );

    expect(observedInputs).toEqual([
      "accepted",
      "original",
      "left",
      "right",
    ]);
    expect(embedded).toEqual([
      { embedding: [8], source: "accepted" },
      { embedding: [4], source: "left" },
      { embedding: [5], source: "right" },
    ]);
  });

  it("does not retry an unchanged rejected embedding input", async () => {
    const observedInputs: string[] = [];
    const embeddingModel = new MockEmbeddingModelV4({
      doEmbed: async ({ values }) => {
        const value = values[0] ?? "";
        observedInputs.push(value);
        throw new APICallError({
          message: "input is too long",
          requestBodyValues: { input: value },
          statusCode: 413,
          url: "https://embedding.test/v1/embeddings",
        });
      },
      maxEmbeddingsPerCall: 1,
      supportsParallelCalls: true,
    });
    const models = buildModelRegistry(new MockLanguageModelV4());
    models.documentEmbedding = embeddingModel;

    await expect(embedDocumentInputs(
      models,
      [{
        inputTokens: 10,
        source: "original",
        value: "original",
      }],
      new TaskLimiter(1),
      undefined,
      (input) => [input],
    )).rejects.toThrow(
      "An oversized embedding input must split into at least two pieces.",
    );
    expect(observedInputs).toEqual(["original"]);
  });
});

describe("evaluation question generation", () => {
  it("tells regeneration attempts which existing questions to avoid", async () => {
    const evaluationModel = new MockLanguageModelV4({
      doGenerate: buildTextGeneration("What changed during the period?", "stop"),
    });

    const question = await generateEvaluationQuestion(
      buildModelRegistry(evaluationModel),
      new TaskLimiter(1),
      {
        domain: "finance",
        element: buildTextElement(),
        excludedQuestions: ["How much did revenue increase?"],
        seed: 42,
      },
    );

    expect(question).toBe("What changed during the period?");
    expect(JSON.stringify(evaluationModel.doGenerateCalls[0]?.prompt)).toContain(
      "How much did revenue increase?",
    );
  });
});

describe("retrieval description context", () => {
  it("uses adjacent text from the same section around a captioned image", () => {
    const documentId = "a".repeat(64);
    const sourceFile = "/tmp/report.pdf";
    const elements: SourceElement[] = [
      {
        content: "The architecture separates source processing from retrieval.",
        documentId,
        id: "b".repeat(64),
        detectedTypes: ["paragraph"],
        kind: "text",
        ...buildSourceLocation(3),
        sourceFile,
      },
      {
        caption: "Document architecture",
        content: Buffer.from("image bytes").toString("base64"),
        detectedType: "picture",
        documentId,
        id: "c".repeat(64),
        kind: "image",
        mimeType: "image/png",
        ...buildSourceLocation(3),
        sourceFile,
      },
      {
        content: "The indexed representations are stored separately.",
        documentId,
        id: "d".repeat(64),
        detectedTypes: ["paragraph"],
        kind: "text",
        ...buildSourceLocation(3),
        sourceFile,
      },
    ];

    expect(createRetrievalDescriptionContext(elements, 1)).toEqual({
      followingText: "The indexed representations are stored separately.",
      precedingText:
        "The architecture separates source processing from retrieval.",
    });
  });
});

describe("query expansion boundary", () => {
  it("keeps searches that use different terminology", () => {
    expect(decodeQueryExpansions(
      "1. sexual orientation discrimination\n- homosexuality equality rights\ngay\n",
      "gay",
      2,
    )).toEqual([
      "sexual orientation discrimination",
      "homosexuality equality rights",
    ]);
  });

  it("does not guess that a differently normalized query is a restatement", () => {
    expect(decodeQueryExpansions(
      "list of suppletive rules\nsuppletive rule exceptions\nsuppletive rule conditions",
      "List all suppletive rules",
      3,
    )).toEqual([
      "list of suppletive rules",
      "suppletive rule exceptions",
      "suppletive rule conditions",
    ]);
  });

  it("does not apply English command-to-question rules", () => {
    expect(decodeQueryExpansions(
      "What are human rights?\nhuman rights historical development",
      "Explain human rights",
      2,
    )).toEqual([
      "What are human rights?",
      "human rights historical development",
    ]);
  });

  it("does not apply English relationship-word rules", () => {
    expect(decodeQueryExpansions(
      [
        "causes of transient high blood pressure in domestic animals",
        "situational hypertension etiology in cats and dogs",
      ].join("\n"),
      "What causes situational hypertension in cats and dogs?",
      2,
    )).toEqual([
      "causes of transient high blood pressure in domestic animals",
      "situational hypertension etiology in cats and dogs",
    ]);
  });

  it("leaves semantic drift detection to the planner boundary", () => {
    expect(decodeQueryExpansions(
      "cats stopping eating condition\ndogs stopping eating condition",
      "What is situational hypertension in cats and dogs?",
      2,
    )).toEqual([
      "cats stopping eating condition",
      "dogs stopping eating condition",
    ]);
  });

  it("allows the model to return no extra search queries", async () => {
    const summaryModel = new MockLanguageModelV4({
      doGenerate: buildTextGeneration(JSON.stringify({
        queries: [],
      }), "stop"),
    });

    const expansions = await expandRetrievalQuery(
      buildModelRegistry(summaryModel),
      "When was Project Northstar launched?",
      2,
      new TaskLimiter(1),
      new AbortController().signal,
      { seed: 42, temperature: 0 },
    );

    expect(expansions).toEqual([]);
  });

  it("applies deterministic generation settings for prepared evaluations", async () => {
    const summaryModel = new MockLanguageModelV4({
      doGenerate: buildTextGeneration(JSON.stringify({
        queries: ["fixed expansion"],
      }), "stop"),
    });

    const expansions = await expandRetrievalQuery(
      buildModelRegistry(summaryModel),
      "original question",
      1,
      new TaskLimiter(1),
      new AbortController().signal,
      { seed: 42, temperature: 0 },
    );

    expect(expansions).toEqual(["fixed expansion"]);
    expect(summaryModel.doGenerateCalls[0]?.seed).toBe(42);
    expect(summaryModel.doGenerateCalls[0]?.temperature).toBe(0);
  });
});

describe("createInferenceModelRegistry", () => {
  it("uses a dedicated HHEM verifier without replacing answer generation", () => {
    const config = readEqualWeightTestConfig({
      providerOptions: {
        queryExpansionModel: "expansion-model",
      },
      runtime: {
        claimVerifierBaseUrl: "http://localhost:8088",
      },
    });

    const models = createInferenceModelRegistry(config);
    const queryExpansion = models.queryExpansion;
    if (queryExpansion === null) {
      throw new Error("Expected query expansion to be configured.");
    }

    expect(models.answer.modelId).toBe("vision-model:answer");
    expect(models.claimVerifier.modelId).toBe(HHEM_DISPLAY_MODEL);
    expect(models.claimVerifier.provider).toBe("HHEM-2.1-Open");
    expect(queryExpansion.modelId).toBe(
      "expansion-model:query-expansion",
    );
    expect(models.summary.modelId).toBe("summary-model:summary");
  });

  it("uses Cohere native chat and embedding request contracts", async () => {
    const providerEmbedding = buildTestEmbedding(768, 0.1);
    const requests: Array<{ body: unknown; headers: Headers; url: string }> = [];
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        body: JSON.parse(String(init?.body)),
        headers: new Headers(init?.headers),
        url,
      });
      if (url === "https://api.cohere.com/v2/chat") {
        return Promise.resolve(Response.json({
          finish_reason: "COMPLETE",
          message: {
            content: [{
              text: JSON.stringify({
                answer: {
                  content: "The source material does not identify the requested information.",
                  findings: [],
                },
              }),
              type: "text",
            }],
            role: "assistant",
          },
          usage: {
            billed_units: { input_tokens: 1, output_tokens: 1 },
            tokens: { input_tokens: 1, output_tokens: 1 },
          },
        }));
      }
      if (url === "https://api.cohere.com/v2/embed") {
        return Promise.resolve(Response.json({
          embeddings: { float: [providerEmbedding] },
          meta: { billed_units: { input_tokens: 1 } },
        }));
      }
      throw new Error(`Unexpected Cohere request URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeSettings = createTestRuntimeSettings();
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });
    const providers = createTestProviderSettings();
    providers.connections.cohere.apiToken = "cohere-secret";
    providers.connections.cohere.answer.model = "configured-chat";
    providers.connections.cohere.answer.contextCapacityTokens = 131_072;
    providers.connections.cohere.embedding.model = "configured-embedding";
    providers.connections.cohere.embedding.contextCapacityTokens = 2_048;
    providers.routing.answer = "cohere";
    providers.routing.embedding = "cohere";
    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.doclingServices,
      startup.sourceContent,
      TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
    );

    const models = createInferenceModelRegistry(config);
    expect(fetchMock).not.toHaveBeenCalled();
    const answer = await generateText({
      maxRetries: 0,
      model: models.answer,
      output: Output.object({
        schema: jsonSchema(z.toJSONSchema(
          createAnswerModelResponseSchema(createEvidenceReferences(1)),
        )),
      }),
      prompt: "Hello",
    });
    const embedding = await embedMany({
      maxRetries: 0,
      model: models.documentEmbedding,
      values: ["Document"],
    });

    expect(answer.output).toEqual({
      answer: {
        content: "The source material does not identify the requested information.",
        findings: [],
      },
    });
    expect(embedding.embeddings).toEqual([providerEmbedding]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      body: {
        model: "configured-chat",
        response_format: {
          type: "json_object",
        },
      },
      url: "https://api.cohere.com/v2/chat",
    });
    const cohereSchema = JSON.stringify(
      (requests[0]?.body as { response_format?: { json_schema?: unknown } })
        .response_format?.json_schema,
    );
    expect(cohereSchema).toContain('"findings"');
    expect(cohereSchema).toContain('"evidenceRefs"');
    expect(cohereSchema).toContain('"EVID_A"');
    expect(requests[1]).toMatchObject({
      body: {
        input_type: "search_document",
        model: "configured-embedding",
        texts: ["Document"],
      },
      url: "https://api.cohere.com/v2/embed",
    });
    expect(requests.every((request) => {
      return request.headers.get("authorization") === "Bearer cohere-secret";
    })).toBe(true);
  });

  it("uses OpenAI-compatible structured output for table descriptions", async () => {
    const requestBodies: unknown[] = [];
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://localhost:1234/v1/chat/completions");
      requestBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(Response.json({
        choices: [{
          finish_reason: "stop",
          index: 0,
          message: {
            content: JSON.stringify({
              keyFacts: ["Q1 revenue was $1 million."],
              keywords: ["quarterly revenue", "Q1"],
              retrievalText:
                "Quarterly revenue table reporting Q1 revenue of $1 million.",
            }),
            role: "assistant",
          },
        }],
        created: 1_753_814_400,
        id: "description-completion",
        model: "environment-description",
        object: "chat.completion",
        usage: {
          completion_tokens: 8,
          prompt_tokens: 20,
          total_tokens: 28,
        },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const config = readEqualWeightTestConfig({
      runtime: {
      },
    });
    const models = createInferenceModelRegistry(config);

    const description = await describeRetrievalElement(
      models,
      buildLongTableElement(),
      { followingText: null, precedingText: null },
      new TaskLimiter(1),
    );

    expect(description.result).toMatchObject({
      description: {
        retrievalText:
          "Quarterly revenue table reporting Q1 revenue of $1 million.",
      },
      status: "described",
    });
    expect(description.inputFingerprint).toBe(
      "bbef63ce047af3c42d5a4c88ec4a30406d6cda2986f8af2c78ee9300428eed6b",
    );
    expect(description).not.toHaveProperty("protocolVersion");
    expect(doesRetrievalDescriptionMatchElement(
      description,
      buildLongTableElement(),
      { followingText: null, precedingText: null },
    )).toBe(true);
    expect(doesRetrievalDescriptionMatchElement(
      description,
      buildLongTableElement(),
      { followingText: "Changed context.", precedingText: null },
    )).toBe(false);
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toMatchObject({
      model: "summary-model",
      reasoning_effort: "none",
      response_format: {
        json_schema: {
          name: "table_retrieval_description",
          schema: {
            additionalProperties: false,
          },
        },
        type: "json_schema",
      },
    });
  });

  it("uses DeepSeek's OpenAI-compatible request contract", async () => {
    const requestBodies: unknown[] = [];
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://api.deepseek.com/chat/completions",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer deepseek-secret",
      );
      requestBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(Response.json({
        choices: [{
          finish_reason: "stop",
          index: 0,
          message: {
            content: JSON.stringify({
              answer: {
                content: "The source material does not identify the requested information.",
                findings: [],
              },
            }),
            role: "assistant",
          },
        }],
        created: 1_784_976_000,
        id: "deepseek-completion",
        model: "deepseek-v4-flash",
        object: "chat.completion",
        usage: {
          completion_tokens: 5,
          prompt_tokens: 10,
          total_tokens: 15,
        },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeSettings = createTestRuntimeSettings({
    });
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });
    const providers = createTestProviderSettings();
    providers.connections.deepseek.apiToken = "deepseek-secret";
    providers.connections.deepseek.answer.model = "deepseek-v4-flash";
    providers.routing.answer = "deepseek";
    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.doclingServices,
      startup.sourceContent,
      TEST_EMBEDDING_INPUT_FORMAT,
    );
    const models = createInferenceModelRegistry(config);

    const result = await generateText({
      maxRetries: 0,
      model: models.answer,
      output: Output.object({
        schema: jsonSchema(z.toJSONSchema(
          createAnswerModelResponseSchema(createEvidenceReferences(1)),
        )),
      }),
      prompt: "Return an uncited response.",
      seed: 42,
    });

    expect(result.output).toEqual({
      answer: {
        content: "The source material does not identify the requested information.",
        findings: [],
      },
    });
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toMatchObject({
      messages: expect.arrayContaining([
        {
          content: expect.stringContaining("JSON Schema"),
          role: "system",
        },
      ]),
      model: "deepseek-v4-flash",
      response_format: {
        type: "json_object",
      },
      thinking: {
        type: "disabled",
      },
    });
    expect(JSON.stringify(requestBodies[0])).toContain("evidenceRefs");
    expect(JSON.stringify(requestBodies[0])).toContain("EVID_A");
    expect(requestBodies[0]).not.toHaveProperty("reasoning_effort");
    expect(requestBodies[0]).not.toHaveProperty("seed");
  });

  it("uses prompted JSON for OpenRouter Answer and Chat streaming", async () => {
    const requestBodies: unknown[] = [];
    const responseValue = {
      answer: {
        content: "The source material does not identify the requested information.",
        findings: [],
      },
    };
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://openrouter.ai/api/v1/chat/completions",
      );
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer openrouter-secret",
      );
      requestBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(createOpenAIChatResponse(responseValue));
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeSettings = createTestRuntimeSettings();
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });
    const providers = createTestProviderSettings();
    providers.connections.openrouter.apiToken = "openrouter-secret";
    providers.connections.openrouter.answer.model = "openrouter/free";
    providers.routing.answer = "openrouter";
    providers.routing.chat = "openrouter";
    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.doclingServices,
      startup.sourceContent,
      TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
    );
    const models = createInferenceModelRegistry(config);
    const chatModel = models.chat;
    if (chatModel === undefined) {
      throw new Error("Expected a configured Chat model.");
    }
    const output = Output.object({
      schema: jsonSchema(z.toJSONSchema(
        createAnswerModelResponseSchema(createEvidenceReferences(1)),
      )),
    });

    const answer = await generateText({
      maxRetries: 0,
      model: models.answer,
      output,
      prompt: "Return an uncited response.",
    });
    const chat = await generateText({
      maxRetries: 0,
      model: chatModel,
      output,
      prompt: "Return an uncited response.",
    });

    expect(answer.output).toEqual(responseValue);
    expect(chat.output).toEqual(responseValue);
    expect(requestBodies).toHaveLength(2);
    for (const requestBody of requestBodies) {
      expect(requestBody).toMatchObject({
        messages: expect.arrayContaining([{
          content: expect.stringContaining("JSON Schema"),
          role: "system",
        }]),
        model: "openrouter/free",
        reasoning: { effort: "none" },
      });
      expect(requestBody).not.toHaveProperty("reasoning_effort");
      expect(requestBody).not.toHaveProperty("response_format");
    }
  });

  it("requires OpenRouter parameter support for strict structured workloads", async () => {
    const requestBodies: unknown[] = [];
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://openrouter.ai/api/v1/chat/completions",
      );
      requestBodies.push(JSON.parse(String(init?.body)));
      const responseValue = requestBodies.length === 1
        ? { summary: "Summary" }
        : { queries: ["expanded search"] };
      return Promise.resolve(createOpenAIChatResponse(responseValue));
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeSettings = createTestRuntimeSettings();
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });
    const providers = createTestProviderSettings();
    providers.connections.openrouter.apiToken = "openrouter-secret";
    providers.connections.openrouter.queryExpansion.model = "openrouter/free";
    providers.connections.openrouter.summarization.model = "openrouter/free";
    providers.routing.queryExpansion = "openrouter";
    providers.routing.summarization = "openrouter";
    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.doclingServices,
      startup.sourceContent,
      TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
    );
    const models = createInferenceModelRegistry(config);

    const result = await generateText({
      maxRetries: 0,
      model: models.summary,
      output: Output.object({
        schema: jsonSchema(z.toJSONSchema(z.object({ summary: z.string() }).strict())),
      }),
      prompt: "Summarize this.",
      providerOptions: {
        citeloomInference: {
          provider: { sort: "throughput" },
          reasoningEffort: "none",
        },
      },
    });
    const expansions = await expandRetrievalQuery(
      models,
      "What changed?",
      1,
      new TaskLimiter(1),
      new AbortController().signal,
      { seed: 42, temperature: 0 },
    );

    expect(result.output).toEqual({ summary: "Summary" });
    expect(expansions).toEqual(["expanded search"]);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toMatchObject({
      provider: {
        require_parameters: true,
        sort: "throughput",
      },
      reasoning: { effort: "none" },
      response_format: {
        type: "json_schema",
      },
    });
    expect(requestBodies[0]).not.toHaveProperty("reasoning_effort");
    expect(requestBodies[1]).toMatchObject({
      provider: { require_parameters: true },
      reasoning: { effort: "none" },
      response_format: { type: "json_schema" },
    });
    expect(requestBodies[1]).not.toHaveProperty("reasoning_effort");
  });

  it("maps every Thinking mode to OpenRouter's unified reasoning contract", async () => {
    const cases = [
      { expectedEffort: undefined, mode: "auto" as const },
      { expectedEffort: "none", mode: "disabled" as const },
      { expectedEffort: "high", mode: "enabled" as const },
    ];
    for (const testCase of cases) {
      let requestBody: unknown = null;
      const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return Promise.resolve(createOpenAIChatResponse("Hello"));
      });
      vi.stubGlobal("fetch", fetchMock);
      const runtimeSettings = createTestRuntimeSettings();
      const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });
      const providers = createTestProviderSettings();
      providers.connections.openrouter.apiToken = "openrouter-secret";
      providers.connections.openrouter.thinkingMode = testCase.mode;
      providers.routing.answer = "openrouter";
      const config = buildAppConfig(
        startup.database,
        runtimeSettings,
        1,
        providers,
        startup.doclingServices,
        startup.sourceContent,
        TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
      );
      const models = createInferenceModelRegistry(config);

      await generateText({
        maxRetries: 0,
        model: models.answer,
        prompt: "Hello",
      });

      expect(requestBody).not.toHaveProperty("reasoning_effort");
      if (testCase.expectedEffort === undefined) {
        expect(requestBody).not.toHaveProperty("reasoning");
      } else {
        expect(requestBody).toMatchObject({
          reasoning: { effort: testCase.expectedEffort },
        });
      }
    }
  });

  it("publishes incremental OpenRouter Answer content from streamed JSON text", async () => {
    const requestBodies: unknown[] = [];
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://openrouter.ai/api/v1/chat/completions",
      );
      requestBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(createOpenAIChatStreamResponse([
        '{"answer":{"content":"Revenue',
        ' increased',
        '.","findings":[{"content":"Revenue increased.","evidenceRefs":["EVID_A"]}]}}',
      ]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeSettings = createTestRuntimeSettings();
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });
    const providers = createTestProviderSettings();
    providers.connections.openrouter.apiToken = "openrouter-secret";
    providers.connections.openrouter.answer.model = "openrouter/free";
    providers.routing.answer = "openrouter";
    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.doclingServices,
      startup.sourceContent,
      TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
    );
    const models = createInferenceModelRegistry(config);
    const previews: AnswerContentSnapshot[] = [];

    const result = await streamAnswerQuestion(
      models,
      "What changed?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      new AbortController().signal,
      { seed: 1, temperature: 0 },
      undefined,
      { receiveAnswerContent: (content) => previews.push(content) },
    );

    expect(result.answerDocument.content).toBe(
      "Revenue increased.",
    );
    expect(previews.length).toBeGreaterThanOrEqual(2);
    expect(previews[0]?.statements[0]?.content).toBe("Revenue");
    expect(previews.at(-1)?.statements[0]?.content).toBe("Revenue increased.");
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toMatchObject({
      reasoning: { effort: "none" },
      stream: true,
    });
    expect(requestBodies[0]).not.toHaveProperty("response_format");
  });

  it("preserves OpenRouter Answer correction without disabling streaming", async () => {
    const requestBodies: unknown[] = [];
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)));
      const evidenceReference = requestBodies.length === 1
        ? "EVID_B"
        : "EVID_A";
      return Promise.resolve(createOpenAIChatStreamResponse([
        JSON.stringify({
          answer: {
            content: "Revenue increased.",
            findings: [{
              content: "The report records increased revenue.",
              evidenceRefs: [evidenceReference],
            }],
          },
        }),
      ]));
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeSettings = createTestRuntimeSettings();
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });
    const providers = createTestProviderSettings();
    providers.connections.openrouter.apiToken = "openrouter-secret";
    providers.routing.answer = "openrouter";
    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.doclingServices,
      startup.sourceContent,
      TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
    );
    const models = createInferenceModelRegistry(config);

    const result = await streamAnswerQuestion(
      models,
      "What changed?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      new AbortController().signal,
      { seed: 1, temperature: 0 },
    );

    expect(result.answerDocument.content).toBe(
      "Revenue increased.",
    );
    expect(requestBodies).toHaveLength(2);
    for (const requestBody of requestBodies) {
      expect(requestBody).toMatchObject({ stream: true });
      expect(requestBody).not.toHaveProperty("response_format");
    }
  });

  it("uses Ollama's native structured-output and thinking contracts", async () => {
    const requestBodies: Array<{
      format?: unknown;
      model?: unknown;
      options?: { num_predict?: unknown; temperature?: unknown };
      think?: unknown;
    }> = [];
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        "http://host.docker.internal:11434/api/chat",
      );
      requestBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(Response.json({
        created_at: "2026-07-18T12:00:00.000Z",
        done: true,
        done_reason: "stop",
        eval_count: 5,
        eval_duration: 1,
        load_duration: 1,
        message: {
          content: JSON.stringify({
            answer: {
              content: "The source material does not identify the requested information.",
              findings: [],
            },
          }),
          role: "assistant",
        },
        model: "gemma4:12b",
        prompt_eval_count: 10,
        prompt_eval_duration: 1,
        total_duration: 1,
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeSettings = createTestRuntimeSettings({
    });
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });
    const providers = createTestProviderSettings();
    providers.connections.ollama.answer.model = "gemma4:12b";
    providers.routing.answer = "ollama";
    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.doclingServices,
      startup.sourceContent,
      TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
    );

    const models = createInferenceModelRegistry(config);
    const result = await generateText({
      maxRetries: 0,
      model: models.answer,
      output: Output.object({
        schema: jsonSchema(z.toJSONSchema(
          createAnswerModelResponseSchema(createEvidenceReferences(1)),
        )),
      }),
      prompt: "Return an uncited response.",
    });

    expect(result.output).toEqual({
      answer: {
        content: "The source material does not identify the requested information.",
        findings: [],
      },
    });
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toMatchObject({
      format: {
        additionalProperties: false,
      },
      model: "gemma4:12b",
      options: {
        num_ctx: 131_072,
        temperature: 0.1,
      },
      think: false,
    });
    const ollamaSchema = JSON.stringify(
      (requestBodies[0] as { format?: unknown }).format,
    );
    expect(ollamaSchema).toContain('"findings"');
    expect(ollamaSchema).toContain('"evidenceRefs"');
    expect(ollamaSchema).toContain('"EVID_A"');
  });

  it("uses Ollama's native embedding request contract", async () => {
    const embedding = buildTestEmbedding(768, 0.1);
    const requestBodies: unknown[] = [];
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        "http://host.docker.internal:11434/api/embed",
      );
      requestBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(Response.json({
        embeddings: [embedding],
        load_duration: 1,
        model: "embeddinggemma",
        prompt_eval_count: 1,
        total_duration: 1,
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeSettings = createTestRuntimeSettings();
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });
    const providers = createTestProviderSettings();
    providers.routing.embedding = "ollama";
    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.doclingServices,
      startup.sourceContent,
      TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
    );

    expect(config.inference.embedding).toMatchObject({
      adapter: "ollama-embedding",
      baseUrl: "http://host.docker.internal:11434",
      maximumInputTokens: 2_048,
      model: "embeddinggemma",
      providerId: "ollama",
    });
    const models = createInferenceModelRegistry(config);
    const result = await embedMany({
      maxRetries: 0,
      model: models.documentEmbedding,
      values: ["Document"],
    });

    expect(result.embeddings).toEqual([embedding]);
    expect(requestBodies).toEqual([{
      input: "Document",
      model: "embeddinggemma",
      options: {
        num_ctx: 2_048,
      },
    }]);
  });

  it("uses Jina's OpenAI-compatible embedding request contract", async () => {
    const embedding = buildTestEmbedding(768, 0.3);
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.jina.ai/v1/embeddings");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer jina-secret",
      );
      const requestBody: unknown = JSON.parse(String(init?.body));
      expect(requestBody).toMatchObject({
        encoding_format: "float",
        input: ["Document"],
        model: "configured-jina-embedding",
      });
      expect(requestBody).not.toHaveProperty("dimensions");
      return Promise.resolve(Response.json({
        data: [{ embedding }],
        usage: { prompt_tokens: 1 },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeSettings = createTestRuntimeSettings();
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });
    const providers = createTestProviderSettings();
    providers.connections.jina.apiToken = "jina-secret";
    providers.connections.jina.embedding.model = "configured-jina-embedding";
    providers.connections.jina.embedding.contextCapacityTokens = 8_192;
    providers.routing.embedding = "jina";
    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.doclingServices,
      startup.sourceContent,
      TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
    );

    const models = createInferenceModelRegistry(config);
    expect(fetchMock).not.toHaveBeenCalled();
    const result = await embedMany({
      maxRetries: 0,
      model: models.documentEmbedding,
      values: ["Document"],
    });

    expect(result.embeddings).toEqual([embedding]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts OpenRouter output matching application dimensions", async () => {
    const embedding = buildTestEmbedding(2_048, 0.3);
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://openrouter.ai/api/v1/embeddings");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer openrouter-secret",
      );
      const requestBody: unknown = JSON.parse(String(init?.body));
      expect(requestBody).toMatchObject({
        encoding_format: "float",
        input: ["Document"],
        model: "configured-openrouter-embedding",
      });
      expect(requestBody).not.toHaveProperty("dimensions");
      return Promise.resolve(Response.json({
        data: [{ embedding }],
        usage: { prompt_tokens: 1 },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeSettings = createTestRuntimeSettings({
      embeddingDimensions: 2_048,
    });
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });
    const providers = createTestProviderSettings();
    providers.connections.openrouter.apiToken = "openrouter-secret";
    providers.connections.openrouter.embedding.model =
      "configured-openrouter-embedding";
    providers.routing.embedding = "openrouter";
    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.doclingServices,
      startup.sourceContent,
      TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
    );

    const models = createInferenceModelRegistry(config);
    const result = await embedMany({
      maxRetries: 0,
      model: models.documentEmbedding,
      values: ["Document"],
    });

    expect(result.embeddings).toEqual([embedding]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects mismatched provider output at the inference boundary", async () => {
    const fetchMock = vi.fn(() => {
      return Promise.resolve(Response.json({
        data: [{ embedding: [0.3, 0.4] }],
        usage: { prompt_tokens: 1 },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimeSettings = createTestRuntimeSettings({
      embeddingDimensions: 2_048,
    });
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });
    const providers = createTestProviderSettings();
    providers.connections.openrouter.apiToken = "openrouter-secret";
    providers.connections.openrouter.embedding.model =
      "configured-openrouter-embedding";
    providers.routing.embedding = "openrouter";
    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.doclingServices,
      startup.sourceContent,
      TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
    );

    const models = createInferenceModelRegistry(config);
    await expect(embedMany({
      maxRetries: 0,
      model: models.documentEmbedding,
      values: ["Document"],
    })).rejects.toThrow(
      "expected 2048 finite numbers with at least one nonzero value",
    );
  });
});

describe("buildAnswerContent", () => {
  it("sends text, table, and persisted visual evidence in the final prompt", () => {
    const retrieved: RetrievedElement[] = [
      {
        distance: 0.1,
        documentVersionId: "00000000-0000-4000-8000-000000000001",
        element: {
          content: "Revenue increased by 12 percent.",
          documentId: "a".repeat(64),
          id: "b".repeat(64),
          detectedTypes: ["paragraph"],
          kind: "text",
          ...buildSourceLocation(3),
          sourceFile: "/tmp/report.pdf",
        },
        evidenceContent: "Revenue growth",
        provenance: buildRetrievedElementProvenance("b".repeat(64)),
      },
      {
        distance: 0.2,
        documentVersionId: "00000000-0000-4000-8000-000000000001",
        element: {
          caption: null,
          detectedType: "picture",
          documentId: "a".repeat(64),
          id: "c".repeat(64),
          kind: "image",
          mimeType: "image/png",
          ...buildSourceLocation(4),
          sourceFile: "/tmp/report.pdf",
        },
        evidenceContent: "Visual summary: A revenue chart",
        provenance: buildRetrievedElementProvenance("c".repeat(64)),
      },
      {
        distance: 0.3,
        documentVersionId: "00000000-0000-4000-8000-000000000001",
        element: {
          caption: null,
          content: [
            "| Section | Value |",
            "| --- | --- |",
            "| 40 | 18 |",
            "| 41 | 27 |",
          ].join("\n"),
          detectedType: "table",
          documentId: "a".repeat(64),
          id: "d".repeat(64),
          kind: "table",
          ...buildSourceLocation(5),
          sourceFile: "/tmp/report.pdf",
          table: buildTableStructure(),
        },
        evidenceContent: "| Section | Value |\n| --- | --- |\n| 40 | 18 |",
        provenance: {
          evidenceSha256: "e".repeat(64),
          representationHits: [{
            channel: "lexical",
            queryIndex: 0,
            rank: 1,
            representationId: `${"d".repeat(64)}-description`,
            representationType: "table-description",
          }],
          retrievalWindowId: "d".repeat(64),
          descriptionAffected: true,
        },
      },
    ];

    const content = buildAnswerContent("What changed?", retrieved);
    expect(Array.isArray(content)).toBe(true);
    if (!Array.isArray(content)) {
      throw new Error("Expected multipart answer content.");
    }

    const textParts = content.filter((part) => part.type === "text");
    const fileParts = content.filter((part) => part.type === "file");
    expect(textParts[0]?.text).toBe([
      "USER_PROMPT",
      "---------",
      "<retrieved_sources>",
    ].join("\n"));
    expect(textParts[textParts.length - 1]?.text).toBe([
      "</retrieved_sources>",
      "",
      "<current_question>",
      "What changed?",
      "</current_question>",
    ].join("\n"));
    expect(textParts.some((part) => part.text.includes("Revenue growth"))).toBe(
      true,
    );
    expect(
      textParts.some((part) => part.text.includes("Visual summary: A revenue chart")),
    ).toBe(true);
    expect(textParts.some((part) => part.text.includes("| 40 | 18 |"))).toBe(
      true,
    );
    expect(textParts.some((part) => part.text.includes("| 41 | 27 |"))).toBe(
      false,
    );
    const expandedContent = buildAnswerContent(
      "What changed?",
      retrieved,
      new Set(["d".repeat(64)]),
    );
    if (!Array.isArray(expandedContent)) {
      throw new Error("Expected multipart expanded answer content.");
    }
    expect(expandedContent.some((part) => (
      part.type === "text" && part.text.includes("| 41 | 27 |")
    ))).toBe(
      true,
    );
    expect(fileParts).toHaveLength(0);
  });

  it("uses asymmetric EmbeddingGemma retrieval prompts", () => {
    const config: EmbeddingInferenceConfig = {
      adapter: "openai-compatible-embedding",
      apiToken: null,
      baseUrl: "http://localhost:1234/v1",
      inputFormat: TEST_EMBEDDING_INPUT_FORMAT,
      providerId: "embedding",
      maximumInputTokens: 2_048,
      model: "embeddinggemma",
      runtimeName: "test runtime",
      timeoutMs: 600_000,
    };

    expect(formatDocumentEmbeddingInput(config, "document text")).toBe(
      "title: none | text: document text",
    );
    expect(formatQueryEmbeddingInput(config, "a question")).toBe(
      "task: search result | query: a question",
    );
  });

  it("maps an explicit thinking mode through the compatible request body", () => {
    expect(buildThinkingProviderOptions("disabled")).toEqual({
      citeloomInference: {
        reasoningEffort: "none",
      },
    });
    expect(buildThinkingProviderOptions("enabled")).toEqual({
      citeloomInference: {
        reasoningEffort: "high",
      },
    });
    expect(buildThinkingProviderOptions("auto")).toBeUndefined();
  });
});

describe("answer generation", () => {
  const generationSettings = { seed: 42, temperature: 0 };

  it("generates an uncited response when retrieval returns no evidence", async () => {
    const answerModel = buildAnswerModel({
      answer: {
        content: "Hello! How can I help you today?",
        findings: [],
      },
    });

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "Hello",
      [],
      new TaskLimiter(1),
      generationSettings,
    );

    expect(result).toMatchObject({
      answer: "Hello! How can I help you today?",
      answerDocument: {
        citations: [],
        content: "Hello! How can I help you today?",
        statements: [],
      },
      matchedDocuments: [],
      outcome: "fallback",
      reason: "model-uncited",
      sources: [],
    });
    expect(answerModel.doGenerateCalls).toHaveLength(1);
    const prompt = JSON.stringify(answerModel.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain("<retrieved_sources>");
    expect(prompt).toContain("<current_question>\\nHello\\n</current_question>");
  });

  it("requests a strict structured draft and compiles server-owned citations", async () => {
    const answerModel = new MockLanguageModelV4({
      doGenerate: buildTextGeneration(
        JSON.stringify(buildAnsweredDraft("Revenue increased.", ["EVID_A"])),
        "stop",
      ),
      modelId: "answer-model:answer",
    });

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "What changed?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      generationSettings,
    );

    expect(result.outcome).toBe("answered");
    expect(result.answerDocument).toMatchObject({
      content: "Revenue increased.",
      schemaVersion: 1,
      statements: [expect.objectContaining({
        section: "key-points",
      })],
    });
    expect(result.sources).toEqual([
      expect.objectContaining({
        citationNumber: 1,
        documentId: "a".repeat(64),
        elementId: "b".repeat(64),
      }),
    ]);
    expect(result.answer).toContain("Revenue increased");
    expect(result.runDetails).toMatchObject({
      finishReason: "stop",
      inputTokens: 10,
      modelId: "answer-model",
      outputTokens: 6,
    });
    expect(answerModel.doGenerateCalls[0]?.responseFormat).toMatchObject({
      type: "json",
    });
  });

  it("does not request correction for missing presentation metadata", async () => {
    const answerModel = new MockLanguageModelV4({
      doGenerate: buildTextGeneration(
        JSON.stringify(buildAnsweredDraft("Revenue increased.", ["EVID_A"])),
        "stop",
      ),
      modelId: "answer-model:answer",
    });

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "What changed?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      generationSettings,
    );

    expect(result.outcome).toBe("answered");
    expect(answerModel.doGenerateCalls).toHaveLength(1);
    expect(result.answerDocument.content).toBe("Revenue increased.");
    expect(result.answerDocument.statements).toHaveLength(1);
  });

  it("owns direct-answer presentation for a causal question", async () => {
    const answerModel = new MockLanguageModelV4({
      doGenerate: buildTextGeneration(
        JSON.stringify(buildAnsweredDraft(
          "A configuration failure stopped the service.",
          ["EVID_A"],
        )),
        "stop",
      ),
      modelId: "answer-model:answer",
    });

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "Why did the service stop?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      generationSettings,
    );

    expect(result.outcome).toBe("answered");
    expect(answerModel.doGenerateCalls).toHaveLength(1);
    expect(result.answerDocument.content).toBe(
      "A configuration failure stopped the service.",
    );
    expect(result.answerDocument.statements).toHaveLength(1);
    expect(result.answer).toContain("## Key points");
  });

  it("sends every budget-selected source for a document-specific question", async () => {
    const privacySource = buildRetrievedElement(
      "a",
      "b",
      "/tmp/privacy-act.pdf",
    );
    const labourSource = buildRetrievedElement(
      "c",
      "d",
      "/tmp/labour-code.pdf",
    );
    const answerModel = buildAnswerModel(buildAnsweredDraft(
      "The Privacy Act provides protections.",
      ["EVID_A"],
    ));
    const recordAnswerBudget = vi.fn();
    const recordAnswerRequest = vi.fn();
    const finishStage = vi.fn(async () => undefined);
    const runTelemetry: RunTelemetry = {
      ...noopRunTelemetry,
      recordAnswerBudget,
      recordAnswerRequest,
      startStage: () => ({
        finish: finishStage,
        timingObserver: {
          completed: () => undefined,
          started: () => undefined,
        },
      }),
    };

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "What protections are provided by the Privacy Act?",
      [privacySource, labourSource],
      new TaskLimiter(1),
      generationSettings,
      runTelemetry,
    );

    expect(result.outcome).toBe("answered");
    expect(answerModel.doGenerateCalls).toHaveLength(1);
    const prompt = JSON.stringify(answerModel.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain("/tmp/privacy-act.pdf");
    expect(prompt).toContain("/tmp/labour-code.pdf");
    const budget = recordAnswerBudget.mock.calls[0]?.[0];
    expect(budget?.windows).toEqual([
      expect.objectContaining({
        elementId: privacySource.element.id,
        reason: "included",
      }),
      expect.objectContaining({
        elementId: labourSource.element.id,
        reason: "included",
      }),
    ]);
    expect(recordAnswerRequest).toHaveBeenCalledWith({
      evidence: [
        buildAnswerRequestEvidence(privacySource),
        buildAnswerRequestEvidence(labourSource),
      ],
      phase: "initial",
    });
    expect(finishStage).toHaveBeenCalledWith(expect.objectContaining({
      inputCount: 2,
    }));
  });

  it("records the exact context supplied to the answer model", async () => {
    const source = buildRetrievedElement(
      "a",
      "b",
      "/tmp/privacy-act.pdf",
    );
    const precedingRetrievalWindowId = "c".repeat(64);
    const followingRetrievalWindowId = "d".repeat(64);
    source.adjacentContext = {
      following: "The following provision limits the exception.",
      preceding: "The preceding provision defines the protected right.",
      retrievalWindowIds: [
        precedingRetrievalWindowId,
        source.provenance.retrievalWindowId,
        followingRetrievalWindowId,
      ],
    };
    const exactSource = buildRetrievedElement(
      "e",
      "f",
      "/tmp/labour-code.pdf",
    );
    exactSource.evidenceContent = "Revenue increased.";
    const answerModel = buildAnswerModel(buildAnsweredDraft(
      "The Privacy Act provides protections.",
      ["EVID_A"],
    ));
    const recordAnswerRequest = vi.fn();
    const runTelemetry: RunTelemetry = {
      ...noopRunTelemetry,
      recordAnswerRequest,
    };

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "What protections are provided by the Privacy Act?",
      [source, exactSource],
      new TaskLimiter(1),
      generationSettings,
      runTelemetry,
    );

    expect(result.outcome).toBe("answered");
    const sourceTexts = readModelFacingSourceTexts(answerModel);
    expect(sourceTexts).toHaveLength(2);
    expect(sourceTexts[0]).toContain(source.adjacentContext.preceding);
    expect(sourceTexts[0]).toContain(source.adjacentContext.following);
    const adjacentContentSha256 = createHash("sha256")
      .update(sourceTexts[0] ?? "")
      .digest("hex");
    const exactContentSha256 = createHash("sha256")
      .update(sourceTexts[1] ?? "")
      .digest("hex");
    expect(recordAnswerRequest).toHaveBeenCalledWith({
      evidence: [{
        context: {
          contentSha256: adjacentContentSha256,
          mode: "adjacent-retrieval-windows",
          retrievalWindowIds: source.adjacentContext.retrievalWindowIds,
        },
        evidenceSha256: source.provenance.evidenceSha256,
        elementId: source.element.id,
        retrievalWindowId: source.provenance.retrievalWindowId,
      }, {
        context: {
          contentSha256: exactContentSha256,
          mode: "exact-retrieval-window",
          retrievalWindowIds: [exactSource.provenance.retrievalWindowId],
        },
        evidenceSha256: exactSource.provenance.evidenceSha256,
        elementId: exactSource.element.id,
        retrievalWindowId: exactSource.provenance.retrievalWindowId,
      }],
      phase: "initial",
    });
    expect(JSON.stringify(recordAnswerRequest.mock.calls))
      .not.toContain(source.adjacentContext.preceding);
  });

  it("sends every budget-selected source for a cross-document question", async () => {
    const privacySource = buildRetrievedElement(
      "a",
      "b",
      "/tmp/privacy-act.pdf",
    );
    const pipedaSource = buildRetrievedElement(
      "c",
      "d",
      "/tmp/personal-information-protection-and-electronic-documents-act.pdf",
    );
    const answerModel = buildAnswerModel(buildAnsweredDraft(
      "The documents describe different privacy protections.",
      ["EVID_A", "EVID_B"],
    ));

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "Compare the Privacy Act with PIPEDA.",
      [privacySource, pipedaSource],
      new TaskLimiter(1),
      generationSettings,
    );

    expect(result.outcome).toBe("answered");
    expect(answerModel.doGenerateCalls).toHaveLength(1);
    const prompt = JSON.stringify(answerModel.doGenerateCalls[0]?.prompt);
    expect(prompt).toContain("/tmp/privacy-act.pdf");
    expect(prompt).toContain(
      "/tmp/personal-information-protection-and-electronic-documents-act.pdf",
    );
    expect(result.sources.map((source) => source.elementId)).toEqual([
      privacySource.element.id,
      pipedaSource.element.id,
    ]);
  });

  it("returns a valid uncited response without retrying", async () => {
    const privacySource = buildRetrievedElement(
      "a",
      "b",
      "/tmp/privacy-act.pdf",
    );
    const labourSource = buildRetrievedElement(
      "c",
      "d",
      "/tmp/labour-code.pdf",
    );
    const answerModel = buildAnswerModel({
      answer: {
        content: "The source material does not identify the requested information.",
        findings: [],
      },
    });

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "What protections are provided by the Privacy Act?",
      [privacySource, labourSource],
      new TaskLimiter(1),
      generationSettings,
    );

    expect(result).toMatchObject({
      outcome: "fallback",
      reason: "model-uncited",
    });
    expect(answerModel.doGenerateCalls).toHaveLength(1);
    const initialPrompt = JSON.stringify(answerModel.doGenerateCalls[0]?.prompt);
    expect(initialPrompt).toContain("/tmp/privacy-act.pdf");
    expect(initialPrompt).toContain("/tmp/labour-code.pdf");
  });

  it("repairs one invalid response with the same complete evidence", async () => {
    const privacySource = buildRetrievedElement(
      "a",
      "b",
      "/tmp/privacy-act.pdf",
    );
    const pipedaSource = buildRetrievedElement(
      "c",
      "d",
      "/tmp/personal-information-protection-and-electronic-documents-act.pdf",
    );
    const recordAnswerRequest = vi.fn();
    const recordAnswerResponseDiagnostic = vi.fn();
    const runTelemetry: RunTelemetry = {
      ...noopRunTelemetry,
      recordAnswerRequest,
      recordAnswerResponseDiagnostic,
    };
    const answerModel = buildSequentialAnswerModel([
      buildAnsweredDraft("Invalid evidence reference.", ["EVID_C"]),
      buildAnsweredDraft(
        "The documents provide privacy protections.",
        ["EVID_A", "EVID_B"],
      ),
    ]);

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "Compare the Privacy Act with PIPEDA.",
      [privacySource, pipedaSource],
      new TaskLimiter(1),
      generationSettings,
      runTelemetry,
    );

    expect(result.outcome).toBe("answered");
    expect(answerModel.doGenerateCalls).toHaveLength(2);
    const initialPrompt = JSON.stringify(answerModel.doGenerateCalls[0]?.prompt);
    const repairPrompt = JSON.stringify(
      answerModel.doGenerateCalls[1]?.prompt,
    );
    expect(initialPrompt).toContain("/tmp/privacy-act.pdf");
    expect(initialPrompt).toContain(
      "/tmp/personal-information-protection-and-electronic-documents-act.pdf",
    );
    expect(repairPrompt).toContain("CORRECTION REQUEST:");
    expect(repairPrompt).toContain("answer: must contain only allowed evidence references");
    expect(repairPrompt).toContain("EVID_A, EVID_B");
    expect(repairPrompt).toContain("Invalid evidence reference.");
    expect(repairPrompt).toContain("Preserve all supported answer content");
    expect(repairPrompt).toContain("/tmp/privacy-act.pdf");
    expect(repairPrompt).toContain(
      "/tmp/personal-information-protection-and-electronic-documents-act.pdf",
    );
    expect(recordAnswerRequest.mock.calls.map((call) => call[0])).toEqual([{
      evidence: [
        buildAnswerRequestEvidence(privacySource),
        buildAnswerRequestEvidence(pipedaSource),
      ],
      phase: "initial",
    }, {
      evidence: [
        buildAnswerRequestEvidence(privacySource),
        buildAnswerRequestEvidence(pipedaSource),
      ],
      phase: "correction",
    }]);
    expect(recordAnswerResponseDiagnostic.mock.calls.map((call) => call[0]))
      .toEqual([
        expect.objectContaining({
          correctionOutcome: "succeeded",
          failureCategory: "unknown-evidence-reference",
          invalidFieldPaths: ["answer"],
          phase: "initial",
          responseSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          unknownReferenceCount: 1,
        }),
        expect.objectContaining({
          correctionOutcome: "succeeded",
          failureCategory: null,
          invalidFieldPaths: [],
          phase: "correction",
          responseSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          unknownReferenceCount: 0,
        }),
      ]);
    expect(JSON.stringify(recordAnswerResponseDiagnostic.mock.calls))
      .not.toContain("Invalid evidence reference.");
    expect(JSON.stringify(recordAnswerResponseDiagnostic.mock.calls))
      .not.toContain("Compare the Privacy Act with PIPEDA.");
    expect(result.sources.map((source) => source.elementId)).toEqual([
      privacySource.element.id,
      pipedaSource.element.id,
    ]);
  });

  it("publishes a valid structured answer whose output can exceed 1,500 tokens", async () => {
    const longContent = Array.from(
      { length: 2_000 },
      (_value, index) => `supported-fact-${index}`,
    ).join(" ");
    const answerModel = buildAnswerModel(buildAnsweredDraft(
      longContent,
      ["EVID_A"],
    ));

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "Provide the complete supported account.",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      generationSettings,
    );

    expect(result.outcome).toBe("answered");
    expect(result.answerDocument.content).toBe(longContent);
  });

  it.each([
    "a general rule and a specific exception",
    "different jurisdictions",
    "different proceedings and conditions",
    "different definitions and scopes",
    "different time periods",
    "a qualification and additional detail",
  ])("publishes compatible %s as ordinary evidence", async (content) => {
    const answerModel = buildAnswerModel(buildAnsweredDraft(
      `The sources describe ${content}.`,
      ["EVID_A"],
    ));

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "What are the applicable rules?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      generationSettings,
    );

    expect(result.outcome).toBe("answered");
    expect(result.answer).not.toContain("Conflicting evidence");
    expect(result.answerDocument.content).toBe(`The sources describe ${content}.`);
    expect(result.answerDocument.statements).toHaveLength(1);
  });

  it("accepts an uncited structured response as a fallback", async () => {
    const answerModel = new MockLanguageModelV4({
      doGenerate: buildTextGeneration(
        JSON.stringify({
          answer: {
            content: "The source material does not identify the requested information.",
            findings: [],
          },
        }),
        "stop",
      ),
    });

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "What changed?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      generationSettings,
    );

    expect(result).toMatchObject({
      answer: "The source material does not identify the requested information.",
      answerDocument: {
        citations: [],
        content: "The source material does not identify the requested information.",
        schemaVersion: 1,
        statements: [],
      },
      claims: [],
      outcome: "fallback",
      reason: "model-uncited",
      sources: [],
    });
  });

  it("rejects when both structured responses violate the contract", async () => {
    const answerModel = new MockLanguageModelV4({
      doGenerate: buildTextGeneration(
        JSON.stringify({
          answer: {
            content: "Revenue increased.",
            findings: [{
              content: "The report records increased revenue.",
              evidenceRefs: ["EVID_B"],
            }],
          },
        }),
        "stop",
      ),
    });

    await expect(answerQuestion(
      buildModelRegistry(answerModel),
      "What changed?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      generationSettings,
    )).rejects.toBeInstanceOf(InvalidAnswerDraftError);
    expect(answerModel.doGenerateCalls).toHaveLength(2);
  });

  it("publishes an answer after removing model citation decoration", async () => {
    const answerModel = buildAnswerModel(buildAnsweredDraft(
      "Revenue increased [1].",
      ["EVID_A"],
    ));

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "What changed?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      generationSettings,
    );

    expect(result.outcome).toBe("answered");
    expect(result.answerDocument.content).toBe("Revenue increased.");
    expect(result.answer.split("\n")[0]).toBe("Revenue increased\\.");
  });

  it("normalizes model citation decoration in the streamed answer path", async () => {
    const answerModel = buildAnswerModel(buildAnsweredDraft(
      "Treatment options include phenobarbital [1].",
      ["EVID_A"],
    ));

    const result = await streamAnswerQuestion(
      buildModelRegistry(answerModel),
      "What treatments are recommended?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      new AbortController().signal,
      generationSettings,
    );

    expect(result.outcome).toBe("answered");
    expect(result.answerDocument.content)
      .toBe("Treatment options include phenobarbital.");
  });

  it("includes the direct answer and findings in the streamed preview", async () => {
    const answerModel = buildAnswerModel({
      answer: {
        content: "Zardev sold the riparian lots.",
        findings: [{
          content: "The submerged lots were treated as accessories.",
          evidenceRefs: ["EVID_A"],
        }],
      },
    });
    const previews: AnswerContentSnapshot[] = [];

    await streamAnswerQuestion(
      buildModelRegistry(answerModel),
      "What did Zardev sell?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      new AbortController().signal,
      generationSettings,
      undefined,
      { receiveAnswerContent: (content) => previews.push(content) },
    );

    expect(previews).toHaveLength(1);
    const citationKey = createAnswerContentCitationKey(
      "00000000-0000-4000-8000-000000000001",
      "a".repeat(64),
      "b".repeat(64),
    );
    expect(previews.at(-1)).toEqual({
      citations: [{
        key: citationKey,
        pageNumbers: [3],
        sourceFile: "/tmp/report.pdf",
      }],
      statements: [{
        citationKeys: [],
        content: "Zardev sold the riparian lots.",
        presentation: "paragraph",
        section: "answer",
      }, {
        citationKeys: [citationKey],
        content: "The submerged lots were treated as accessories.",
        presentation: "bullet",
        section: "key-points",
      }],
    });
  });

  it("selects only key points for Ask claim verification", async () => {
    const answerModel = buildAnswerModel({
      answer: {
        content: "The report describes one supported change.",
        findings: [{
          content: "Revenue increased by 12 percent.",
          evidenceRefs: ["EVID_A"],
        }],
      },
    });

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "What changed?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      generationSettings,
    );

    expect(result.outcome).toBe("answered");
    expect(result.claims).toEqual([expect.objectContaining({
      citationNumbers: [1],
      claim: "Revenue increased by 12 percent.",
      claimIndex: 0,
    })]);
  });

  it("uses evidenceRefs as citation authority instead of model citation decoration", async () => {
    const answerModel = buildAnswerModel({
      answer: {
        content: "Revenue increased. [2]",
        findings: [{
          content: "The report records increased revenue.",
          evidenceRefs: ["EVID_A"],
        }],
      },
    });

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "What changed?",
      [buildRetrievedElement("a", "b"), buildRetrievedElement("c", "d")],
      new TaskLimiter(1),
      generationSettings,
    );

    expect(result.outcome).toBe("answered");
    expect(result.answerDocument.content).toBe("Revenue increased.");
    expect(result.answerDocument.citations).toHaveLength(1);
    expect(result.answerDocument.citations[0]?.elementId).toBe("b".repeat(64));
  });

  it("preserves cancellation as an abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const answerModel = new MockLanguageModelV4({
      doGenerate: buildTextGeneration(
        JSON.stringify({
          answer: {
            content: "Unsupported.",
            findings: [],
          },
        }),
        "stop",
      ),
    });

    await expect(streamAnswerQuestion(
      buildModelRegistry(answerModel),
      "What changed?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      controller.signal,
      generationSettings,
    )).rejects.toThrow();
  });

  it("preserves provider failures as errors", async () => {
    const providerError = new Error("provider unavailable");
    const answerModel = new MockLanguageModelV4({
      doGenerate: async () => {
        throw providerError;
      },
    });

    await expect(answerQuestion(
      buildModelRegistry(answerModel),
      "What changed?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      generationSettings,
    )).rejects.toBe(providerError);
  });

  it("preserves non-contract provider finish failures as errors", async () => {
    const answerModel = new MockLanguageModelV4({
      doGenerate: buildTextGeneration(
        JSON.stringify({
          answer: {
            content: "Unsupported.",
            findings: [],
          },
        }),
        "content-filter",
      ),
    });

    await expect(answerQuestion(
      buildModelRegistry(answerModel),
      "What changed?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      generationSettings,
    )).rejects.toThrow("provider finish reason content-filter");
  });
});

function buildModelRegistry(summary: LanguageModelV4): EvaluationModelRegistry {
  const embedding = new MockEmbeddingModelV4();
  return {
    answer: wrapLanguageModel({
      middleware: simulateStreamingMiddleware(),
      model: summary,
    }),
    answerBudget: { maximumOutputTokens: 16_384, minimumOutputTokens: 256, providerSafetyMarginTokens: 0 },
    readAnswerCapabilities: async () => buildTestModelCapabilities(),
    claimVerifier: new FakeHhemClient(),
    documentEmbedding: embedding,
    evaluation: summary,
    metrics: new InferenceMetricsReporter({ enabled: false }),
    queryExpansion: summary,
    queryEmbedding: embedding,
    reranker: null,
    summary,
    timeouts: {
      answerMs: 900_000,
      embeddingMs: 600_000,
      summarizationMs: 900_000,
      queryExpansionMs: 900_000,
    },
  };
}

function buildAnswerModel(draft: unknown): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: buildTextGeneration(JSON.stringify(draft), "stop"),
    modelId: "answer-model:answer",
  });
}

function buildAnsweredDraft(
  content: string,
  evidenceRefs: string[],
): unknown {
  return {
    answer: {
      content,
      findings: [{
        content: "The retrieved evidence supports the answer.",
        evidenceRefs,
      }],
    },
  };
}

function buildSequentialAnswerModel(
  drafts: readonly unknown[],
): MockLanguageModelV4 {
  let requestIndex = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const draft = drafts[requestIndex];
      if (draft === undefined) {
        throw new Error(`Missing answer draft for request ${requestIndex + 1}.`);
      }
      requestIndex += 1;
      return buildTextGeneration(JSON.stringify(draft), "stop");
    },
  });
}

function buildTextElement(): SourceElement {
  return {
    content: "Revenue increased by 12 percent during the reporting period.",
    documentId: "a".repeat(64),
    id: "b".repeat(64),
    detectedTypes: ["paragraph"],
    kind: "text",
    ...buildSourceLocation(3),
    sourceFile: "/tmp/report.pdf",
  };
}

function buildLongTableElement(): TableElement {
  return {
    caption: "Quarterly revenue",
    content: "| Quarter | Revenue |\n| --- | --- |\n| Q1 | $1 million |\n".repeat(20),
    detectedType: "table",
    documentId: "a".repeat(64),
    id: "c".repeat(64),
    kind: "table",
    ...buildSourceLocation(4),
    sourceFile: "/tmp/report.pdf",
    table: buildTableStructure(),
  };
}

function buildRetrievedElement(
  documentCharacter: string,
  elementCharacter: string,
  sourceFile = "/tmp/report.pdf",
): RetrievedElement {
  return {
    distance: 0.1,
    documentVersionId: "00000000-0000-4000-8000-000000000001",
    element: {
      content: "Revenue increased.",
      documentId: documentCharacter.repeat(64),
      id: elementCharacter.repeat(64),
      detectedTypes: ["paragraph"],
      kind: "text",
      ...buildSourceLocation(3),
      sourceFile,
    },
    evidenceContent: "Revenue growth",
    provenance: buildRetrievedElementProvenance(
      elementCharacter.repeat(64),
    ),
  };
}

function buildAnswerRequestEvidence(source: RetrievedElement) {
  return {
    context: {
      contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      mode: "parent-source-element",
      retrievalWindowIds: [source.provenance.retrievalWindowId],
    },
    elementId: source.element.id,
    evidenceSha256: source.provenance.evidenceSha256,
    retrievalWindowId: source.provenance.retrievalWindowId,
  };
}

function readModelFacingSourceTexts(model: MockLanguageModelV4): string[] {
  const request = model.doGenerateCalls[0];
  if (request === undefined) {
    throw new Error("Expected an answer model request.");
  }
  const sourceTexts: string[] = [];
  for (const message of request.prompt) {
    if (message.role !== "user") {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "text" && part.text.includes("RETRIEVED EVIDENCE")) {
        sourceTexts.push(part.text);
      }
    }
  }
  return sourceTexts;
}

function buildTextGeneration(
  text: string,
  finishReason: LanguageModelV4GenerateResult["finishReason"]["unified"],
): LanguageModelV4GenerateResult {
  return {
    content: [{ text, type: "text" }],
    finishReason: { raw: finishReason, unified: finishReason },
    usage: {
      inputTokens: {
        cacheRead: 0,
        cacheWrite: 0,
        noCache: 10,
        total: 10,
      },
      outputTokens: {
        reasoning: 0,
        text: 6,
        total: 6,
      },
    },
    warnings: [],
  };
}
