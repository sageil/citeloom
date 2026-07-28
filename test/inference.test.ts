import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTestModelCapabilities } from "./model-capabilities-fixture.js";
import { APICallError, embedMany, generateText, Output } from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
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
  createAnswerDraftSchema,
  type AnswerDraft,
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

const mandatoryNoAnswer = "I couldn't find the answer to your question in the available information.";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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
  it("keeps distinct close variants and preserves the original separately", () => {
    expect(decodeQueryExpansions(
      "1. sexual orientation discrimination\n- homosexuality equality rights\ngay\n",
      "gay",
      2,
    )).toEqual([
      "sexual orientation discrimination",
      "homosexuality equality rights",
    ]);
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

    expect(models.answer.modelId).toBe("vision-model:answer");
    expect(models.claimVerifier.modelId).toBe(HHEM_DISPLAY_MODEL);
    expect(models.claimVerifier.provider).toBe("HHEM-2.1-Open");
    expect(models.queryExpansion.modelId).toBe(
      "expansion-model:query-expansion",
    );
    expect(models.summary.modelId).toBe("summary-model:summary");
  });

  it("uses Cohere native chat and embedding request contracts", async () => {
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
            content: [{ text: "Cohere answer", type: "text" }],
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
          embeddings: { float: [[0.1, 0.2]] },
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
      prompt: "Hello",
    });
    const embedding = await embedMany({
      maxRetries: 0,
      model: models.documentEmbedding,
      values: ["Document"],
    });

    expect(answer.text).toBe("Cohere answer");
    expect(embedding.embeddings).toEqual([[0.1, 0.2]]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      body: { model: "configured-chat" },
      url: "https://api.cohere.com/v2/chat",
    });
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
        inferenceThinkingMode: "disabled",
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
            content: JSON.stringify({ status: "no_answer" }),
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
      inferenceThinkingMode: "disabled",
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
        schema: createAnswerDraftSchema(1),
      }),
      prompt: "Return no_answer.",
      seed: 42,
    });

    expect(result.output).toEqual({ status: "no_answer" });
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
    expect(requestBodies[0]).not.toHaveProperty("reasoning_effort");
    expect(requestBodies[0]).not.toHaveProperty("seed");
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
          content: JSON.stringify({ status: "no_answer" }),
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
      inferenceThinkingMode: "disabled",
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
        schema: createAnswerDraftSchema(1),
      }),
      prompt: "Return no_answer.",
    });

    expect(result.output).toEqual({ status: "no_answer" });
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toMatchObject({
      format: {
        oneOf: expect.arrayContaining([
          expect.objectContaining({ additionalProperties: false }),
        ]),
      },
      model: "gemma4:12b",
      options: {
        num_ctx: 131_072,
        temperature: 0.1,
      },
      think: false,
    });
  });

  it("uses Ollama's native embedding request contract", async () => {
    const requestBodies: unknown[] = [];
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(
        "http://host.docker.internal:11434/api/embed",
      );
      requestBodies.push(JSON.parse(String(init?.body)));
      return Promise.resolve(Response.json({
        embeddings: [[0.1, 0.2]],
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

    expect(result.embeddings).toEqual([[0.1, 0.2]]);
    expect(requestBodies).toEqual([{
      input: "Document",
      model: "embeddinggemma",
      options: {
        num_ctx: 2_048,
      },
    }]);
  });

  it("uses Jina's OpenAI-compatible embedding request contract", async () => {
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("https://api.jina.ai/v1/embeddings");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer jina-secret",
      );
      expect(JSON.parse(String(init?.body))).toMatchObject({
        encoding_format: "float",
        input: ["Document"],
        model: "configured-jina-embedding",
      });
      return Promise.resolve(Response.json({
        data: [{ embedding: [0.3, 0.4] }],
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

    expect(result.embeddings).toEqual([[0.3, 0.4]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
  it("requests a strict structured draft and compiles server-owned citations", async () => {
    const answerModel = new MockLanguageModelV4({
      doGenerate: buildTextGeneration(JSON.stringify({
        conflictGroups: [],
        statements: [{
          content: "Revenue increased.",
          presentation: "paragraph",
          section: "answer",
          sourceNumbers: [1],
        }],
        status: "answered",
      }), "stop"),
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
      schemaVersion: 1,
      status: "answered",
      statements: [{
        content: "Revenue increased.",
        presentation: "paragraph",
        section: "answer",
      }],
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
      [1],
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
      [1, 2],
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

  it("returns a valid no-answer response without retrying", async () => {
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
      conflictGroups: [],
      statements: [],
      status: "no_answer",
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
      reason: "model-no-answer",
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
    const runTelemetry: RunTelemetry = {
      ...noopRunTelemetry,
      recordAnswerRequest,
    };
    const answerModel = buildSequentialAnswerModel([
      buildAnsweredDraft("Invalid source reference.", [3]),
      buildAnsweredDraft("The documents provide privacy protections.", [1, 2]),
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
    expect(repairPrompt).toContain("RETRY INSTRUCTION:");
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
      phase: "recovery",
    }]);
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
    const answerModel = buildAnswerModel({
      conflictGroups: [],
      statements: [{
        content: longContent,
        presentation: "paragraph",
        section: "answer",
        sourceNumbers: [1],
      }],
      status: "answered",
    });

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "Provide the complete supported account.",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      generationSettings,
    );

    expect(result.outcome).toBe("answered");
    expect(result.answerDocument.statements[0]?.content).toBe(longContent);
  });

  it.each([
    "a general rule and a specific exception",
    "different jurisdictions",
    "different proceedings and conditions",
    "different definitions and scopes",
    "different time periods",
    "a qualification and additional detail",
  ])("publishes compatible %s as ordinary evidence", async (content) => {
    const answerModel = buildAnswerModel({
      conflictGroups: [],
      statements: [{
        content: `The sources describe ${content}.`,
        presentation: "paragraph",
        section: "answer",
        sourceNumbers: [1],
      }],
      status: "answered",
    });

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "What are the applicable rules?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      generationSettings,
    );

    expect(result.outcome).toBe("answered");
    expect(result.answer).not.toContain("Conflicting evidence");
    expect(result.answerDocument.statements[0]?.section).toBe("answer");
  });

  it("accepts the structured no-answer variant as a fixed fallback", async () => {
    const answerModel = new MockLanguageModelV4({
      doGenerate: buildTextGeneration(
        JSON.stringify({
          conflictGroups: [],
          statements: [],
          status: "no_answer",
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
      answer: mandatoryNoAnswer,
      answerDocument: {
        citations: [],
        schemaVersion: 1,
        statements: [],
        status: "no_answer",
      },
      claims: [],
      outcome: "fallback",
      reason: "model-no-answer",
      sources: [],
    });
  });

  it("rejects when both structured responses violate the contract", async () => {
    const answerModel = new MockLanguageModelV4({
      doGenerate: buildTextGeneration(
        JSON.stringify({
          conflictGroups: [],
          statements: [{
            content: "Revenue increased.",
            presentation: "paragraph",
            section: "answer",
            sourceNumbers: [2],
          }],
          status: "answered",
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
    const answerModel = buildAnswerModel({
      conflictGroups: [],
      statements: [{
        content: "Revenue increased [1].",
        presentation: "paragraph",
        section: "answer",
        sourceNumbers: [1],
      }],
      status: "answered",
    });

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "What changed?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      generationSettings,
    );

    expect(result.outcome).toBe("answered");
    expect(result.answerDocument.statements[0]?.content).toBe("Revenue increased.");
    expect(result.answer).toContain("Revenue increased\\. [1]");
  });

  it("normalizes model citation decoration in the streamed answer path", async () => {
    const answerModel = buildAnswerModel({
      conflictGroups: [],
      statements: [{
        content: "Treatment options include phenobarbital [1].",
        presentation: "paragraph",
        section: "answer",
        sourceNumbers: [1],
      }],
      status: "answered",
    });

    const result = await streamAnswerQuestion(
      buildModelRegistry(answerModel),
      "What treatments are recommended?",
      [buildRetrievedElement("a", "b")],
      new TaskLimiter(1),
      new AbortController().signal,
      generationSettings,
    );

    expect(result.outcome).toBe("answered");
    expect(result.answerDocument.statements[0]?.content)
      .toBe("Treatment options include phenobarbital.");
  });

  it("uses sourceNumbers as citation authority instead of model citation decoration", async () => {
    const answerModel = buildAnswerModel({
      conflictGroups: [],
      statements: [{
        content: "Revenue increased. [2]",
        presentation: "paragraph",
        section: "answer",
        sourceNumbers: [1],
      }],
      status: "answered",
    });

    const result = await answerQuestion(
      buildModelRegistry(answerModel),
      "What changed?",
      [buildRetrievedElement("a", "b"), buildRetrievedElement("c", "d")],
      new TaskLimiter(1),
      generationSettings,
    );

    expect(result.outcome).toBe("answered");
    expect(result.answerDocument.statements[0]?.content).toBe("Revenue increased.");
    expect(result.answerDocument.citations).toHaveLength(1);
    expect(result.answerDocument.citations[0]?.elementId).toBe("b".repeat(64));
  });

  it("preserves cancellation as an abort", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    const answerModel = new MockLanguageModelV4({
      doGenerate: buildTextGeneration(
        JSON.stringify({ status: "no_answer" }),
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
        JSON.stringify({ status: "no_answer" }),
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
    answer: summary,
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
  sourceNumbers: number[],
): AnswerDraft {
  return {
    conflictGroups: [],
    statements: [{
      content,
      presentation: "paragraph",
      section: "answer",
      sourceNumbers,
    }],
    status: "answered",
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
    elementId: source.element.id,
    evidenceSha256: source.provenance.evidenceSha256,
    retrievalWindowId: source.provenance.retrievalWindowId,
  };
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
