import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestModelCapabilities } from "./model-capabilities-fixture.js";
import type { LanguageModelV4, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import {
  APICallError,
  simulateStreamingMiddleware,
  type UIMessageStreamWriter,
  wrapLanguageModel,
} from "ai";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";

const saveTurnMock = vi.hoisted(() => vi.fn());

vi.mock("../src/research/store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/research/store.js")>();
  return {
    ...actual,
    ResearchStore: class {
      public async saveTurn(input: SaveResearchTurnInput): Promise<ResearchTurn> {
        return saveTurnMock(input);
      }
    },
  };
});

import type { CiteLoomUIMessage } from "../src/answers/stream.js";
import type { AppConfig } from "../src/config/index.js";
import { TaskLimiter } from "../src/shared/concurrency.js";
import type { DatabaseSession } from "../src/database/client.js";
import type { RetrievedElement } from "../src/retrieval/document-retrieval.js";
import { InferenceMetricsReporter } from "../src/inference/metrics.js";
import type { InferenceModelRegistry } from "../src/inference/registry.js";
import {
  type PreparedRetrieval,
  readAnswerStreamError,
  writeStreamedAnswer,
} from "../src/retrieval/pipeline.js";
import type {
  ResearchTurn,
  StoredCitationRecord,
  StoredClaimCheck,
} from "../src/research/types.js";
import type { SaveResearchTurnInput } from "../src/research/store.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";
import { FakeHhemClient } from "./hhem-fixture.js";
import { InvalidAnswerDraftError } from "../src/answers/inference.js";
import {
  buildRetrievedElementProvenance,
  buildSourceLocation,
} from "./source-element-fixture.js";

const threadId = "00000000-0000-4000-8000-000000000001";

type WrittenChunk = Parameters<
  UIMessageStreamWriter<CiteLoomUIMessage>["write"]
>[0];

beforeEach(() => {
  saveTurnMock.mockReset();
  saveTurnMock.mockImplementation(async (input: SaveResearchTurnInput) => {
    return buildSavedTurn(input);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("atomic structured answer publication", () => {
  it("reports provider parameter incompatibility as a model-selection error", () => {
    const unsupportedParameters = new APICallError({
      message: "No endpoints found",
      requestBodyValues: {},
      responseBody: JSON.stringify({
        error: {
          message:
            "No endpoints found that support all requested parameters.",
        },
      }),
      statusCode: 404,
      url: "https://openrouter.ai/api/v1/chat/completions",
    });
    const unknownModel = new APICallError({
      message: "Model not found",
      requestBodyValues: {},
      responseBody: JSON.stringify({
        error: { message: "The requested model was not found." },
      }),
      statusCode: 404,
      url: "https://openrouter.ai/api/v1/chat/completions",
    });

    expect(readAnswerStreamError(unsupportedParameters)).toBe(
      "The selected model does not support the response format CiteLoom requires. Select a different model in Settings, then try again.",
    );
    expect(readAnswerStreamError(unknownModel)).toBe(
      "The AI provider could not find the configured model or endpoint. Check the provider URL and model ID in Settings.",
    );
  });

  it("verifies, persists, and then publishes one completed answer entity", async () => {
    const events: string[] = [];
    const answerModel = buildAnswerModel(
      buildVerifiableAnsweredDraft(["EVID_A"]),
    );
    const verifier = new FakeHhemClient(0.5, async (items) => {
      events.push("verify");
      return items.map((item) => ({
        id: item.id,
        outcome: "scored" as const,
        supportProbability: 0.9,
      }));
    });
    saveTurnMock.mockImplementation(async (input: SaveResearchTurnInput) => {
      events.push("persist");
      return buildSavedTurn(input);
    });
    const stream = buildWriter((chunk) => {
      if (chunk.type === "data-answer-content") {
        events.push("content");
      } else if (chunk.type === "data-answer") {
        events.push("publish");
      }
    });

    await runStreamedAnswer(
      buildPrepared(answerModel, verifier),
      stream.writer,
    );

    expect(events).toEqual(["content", "verify", "persist", "publish"]);
    const answers = readChunks(stream.chunks, "data-answer");
    expect(answers).toHaveLength(1);
    expect(answers[0]?.data).toMatchObject({
      answerDocument: {
        citations: [expect.objectContaining({ citationNumber: 1 })],
        content: "The report describes a revenue change.",
        schemaVersion: 1,
        statements: [
          expect.objectContaining({ content: "Revenue increased." }),
        ],
      },
      claims: [{
        citationNumbers: [1],
        claim: "Revenue increased.",
        claimIndex: 0,
        status: "supported",
      }],
      matchedDocuments: [{
        documentId: "a".repeat(64),
        retrievedElementCount: 1,
        sourceFile: "/tmp/report.pdf",
      }],
      runDetails: expect.objectContaining({
        modelId: "answer-model",
        sourceCount: 1,
      }),
      turn: expect.objectContaining({ threadId }),
    });
    expect(readChunks(stream.chunks, "finish")).toHaveLength(1);
    expect(saveTurnMock).toHaveBeenCalledOnce();
    expect(readSavedTurnInput()).toMatchObject({
      answerDocument: {
        content: "The report describes a revenue change.",
        statements: [
          expect.objectContaining({ content: "Revenue increased." }),
        ],
      },
      claims: [{
        citationNumbers: [1],
        claim: "Revenue increased.",
        status: "supported",
      }],
    });
  });

  it("keeps unsupported content and publishes advisory verification results", async () => {
    const verifier = new FakeHhemClient(0.5, async (items) => {
      return items.map((item) => ({
        id: item.id,
        outcome: "scored" as const,
        supportProbability: item.claim === "Revenue decreased."
          && item.id.endsWith("citation-2")
          ? 0.9
          : 0.1,
      }));
    });
    const answerModel = buildAnswerModel({
      answer: {
        content: "Unsupported statement.",
        findings: [{
          content: "Revenue decreased.",
          evidenceRefs: ["EVID_B", "EVID_A"],
        }],
      },
    });
    const stream = buildWriter();

    await runStreamedAnswer(
      buildPrepared(
        answerModel,
        verifier,
        [buildTextRetrieved(), buildContradictingTextRetrieved()],
      ),
      stream.writer,
    );

    const saved = readSavedTurnInput();
    const published = readChunks(stream.chunks, "data-answer")[0]?.data;
    if (published === undefined) {
      throw new Error("Expected a published answer.");
    }
    expect(saved.answerDocument).toEqual(published.answerDocument);
    expect(saved.answerDocument.citations).toHaveLength(2);
    expect(saved.answerDocument.content).toBe("Unsupported statement.");
    expect(saved.answerDocument.statements.map((statement) => statement.content))
      .toEqual(["Revenue decreased."]);
    expect(saved.claims.map((claim) => claim.status)).toEqual([
      "partially-supported",
    ]);
    expect(saved.claims).toEqual(published.claims.map((claim) => {
      const {
        createdAt: _createdAt,
        id: _id,
        turnId: _turnId,
        ...savedClaim
      } = claim;
      return savedClaim;
    }));
    expect(published.runDetails?.sourceCount).toBe(2);
    expect(JSON.stringify(published)).toContain("Unsupported statement.");
    expect(JSON.stringify(published)).toContain("b".repeat(64));
  });

  it("applies citation validation to a recovered answer draft", async () => {
    let requestCount = 0;
    const answerModel = new MockLanguageModelV4({
      doGenerate: async () => {
        requestCount += 1;
        const draft = requestCount === 1
          ? buildVerifiableAnsweredDraft(["EVID_C"])
          : buildVerifiableAnsweredDraft(["EVID_A", "EVID_B"]);
        return buildTextGeneration(JSON.stringify(draft));
      },
      modelId: "answer-model:answer",
    });
    const verifier = new FakeHhemClient(0.5, async (items) => {
      return items.map((item) => ({
        id: item.id,
        outcome: "scored" as const,
        supportProbability: item.id.endsWith("citation-1") ? 0.9 : 0.1,
      }));
    });
    const first = buildTextRetrieved();
    const second = buildContradictingTextRetrieved();
    second.documentVersionId = first.documentVersionId;
    second.element.documentId = first.element.documentId;
    second.element.sourceFile = first.element.sourceFile;
    const stream = buildWriter();

    await runStreamedAnswer(
      buildPrepared(answerModel, verifier, [first, second]),
      stream.writer,
    );

    expect(requestCount).toBe(2);
    expect(readSavedTurnInput()).toMatchObject({
      answerDocument: {
        citations: [{
          citationNumber: 1,
          elementId: "b".repeat(64),
        }, {
          citationNumber: 2,
          elementId: "d".repeat(64),
        }],
        content: "The report describes a revenue change.",
        statements: [{
          content: "Revenue increased.",
        }],
      },
    });
    expect(readSavedTurnInput()).toMatchObject({
      claims: [{
        citationNumbers: [1, 2],
        status: "partially-supported",
      }],
    });
  });

  it("publishes unsupported verification as advisory metadata", async () => {
    const verifier = new FakeHhemClient(0.5, async (items) => {
      return items.map((item) => ({
        id: item.id,
        outcome: "scored" as const,
        supportProbability: 0.1,
      }));
    });
    const stream = buildWriter();

    await runStreamedAnswer(
      buildPrepared(
        buildAnswerModel(buildVerifiableAnsweredDraft(["EVID_A"])),
        verifier,
      ),
      stream.writer,
    );

    const saved = readSavedTurnInput();
    const published = readChunks(stream.chunks, "data-answer")[0]?.data;
    expect(saved.answerDocument.citations).toHaveLength(1);
    expect(saved.answerDocument.content).toBe(
      "The report describes a revenue change.",
    );
    expect(saved.answerDocument.statements).toEqual([
      expect.objectContaining({ content: "Revenue increased." }),
    ]);
    expect(saved.claims).toEqual([
      expect.objectContaining({
        claim: "Revenue increased.",
        status: "unsupported",
      }),
    ]);
    expect(published?.answerDocument).toEqual(saved.answerDocument);
    expect(published?.claims).toHaveLength(1);
    expect(published?.runDetails?.sourceCount).toBe(1);
    expect(JSON.stringify(published)).toContain("Revenue increased.");
  });

  it("verifies and atomically publishes independently cited opposing findings", async () => {
    const verifiedClaims: string[] = [];
    const verifier = new FakeHhemClient(0.5, async (items) => {
      for (const item of items) {
        verifiedClaims.push(item.claim);
      }
      return items.map((item) => ({
        id: item.id,
        outcome: "scored" as const,
        supportProbability: 0.9,
      }));
    });
    const draft = {
      answer: {
        content: "The reports describe opposite revenue changes.",
        findings: [{
          content: "Revenue increased.",
          evidenceRefs: ["EVID_A"],
        }, {
          content: "Revenue decreased.",
          evidenceRefs: ["EVID_B"],
        }],
      },
    };
    const stream = buildWriter();

    await runStreamedAnswer(
      buildPrepared(
        buildAnswerModel(draft),
        verifier,
        [buildTextRetrieved(), buildContradictingTextRetrieved()],
      ),
      stream.writer,
    );

    expect(verifiedClaims).toContain("Revenue increased.");
    expect(verifiedClaims).toContain("Revenue decreased.");
    expect(verifiedClaims).not.toContain(
      "The reports describe opposite revenue changes.",
    );
    const published = readChunks(stream.chunks, "data-answer")[0]?.data;
    if (published === undefined) {
      throw new Error("Expected a published conflict answer.");
    }
    expect(published.answerDocument.citations).toHaveLength(2);
    expect(published.answerDocument.statements.map((statement) => statement.section))
      .toEqual(["key-points", "key-points"]);
    expect(published.answerDocument.statements[0]?.citationIds).toEqual([
      published.answerDocument.citations[0]?.id,
    ]);
    expect(published.answerDocument.statements[1]?.citationIds).toEqual([
      published.answerDocument.citations[1]?.id,
    ]);
    expect(saveTurnMock).toHaveBeenCalledOnce();
  });

  it("rejects an invalid model draft without persistence or publication", async () => {
    const answerModel = buildAnswerModel({
      answer: {
        content: "Revenue increased.",
        findings: [{
          content: "Revenue increased.",
          evidenceRefs: ["EVID_B"],
        }],
      },
    });
    const verifier = new FakeHhemClient();
    const stream = buildWriter();

    await expect(runStreamedAnswer(
      buildPrepared(answerModel, verifier),
      stream.writer,
    )).rejects.toBeInstanceOf(InvalidAnswerDraftError);

    expect(answerModel.doGenerateCalls).toHaveLength(2);
    expect(verifier.scoreCalls).toEqual([]);
    expect(saveTurnMock).not.toHaveBeenCalled();
    expect(readChunks(stream.chunks, "data-answer")).toEqual([]);
    expect(readChunks(stream.chunks, "finish")).toEqual([]);
  });

  it("completes after verifier failure while preserving the unverified answer", async () => {
    const verifierError = new Error("verifier unavailable");
    const verifier = new FakeHhemClient(0.5, async () => {
      throw verifierError;
    });
    const stream = buildWriter();

    await runStreamedAnswer(
      buildPrepared(
        buildAnswerModel(buildVerifiableAnsweredDraft(["EVID_A"])),
        verifier,
      ),
      stream.writer,
    );

    expect(saveTurnMock).toHaveBeenCalledOnce();
    expect(readChunks(stream.chunks, "data-answer")).toHaveLength(1);
    expect(readChunks(stream.chunks, "data-answer")[0]?.data.claims).toEqual([
      expect.objectContaining({ status: "unverified" }),
    ]);
    expect(readChunks(stream.chunks, "finish")).toHaveLength(1);
  });

  it("does not send an overview-only Ask answer to the verifier", async () => {
    const verifier = new FakeHhemClient();
    const stream = buildWriter();

    await runStreamedAnswer(
      buildPrepared(
        buildAnswerModel(buildAnsweredDraft()),
        verifier,
        [buildTextRetrieved(), buildContradictingTextRetrieved()],
      ),
      stream.writer,
    );

    expect(verifier.scoreCalls).toHaveLength(0);
    expect(saveTurnMock).toHaveBeenCalledOnce();
    expect(readChunks(stream.chunks, "data-answer")).toHaveLength(1);
    expect(readChunks(stream.chunks, "finish")).toHaveLength(1);
  });

  it("completes after collective finding verification fails", async () => {
    const verifierError = new Error("collective verifier unavailable");
    let scoreRequestCount = 0;
    const verifier = new FakeHhemClient(0.5, async (items) => {
      scoreRequestCount += 1;
      if (scoreRequestCount === 2) {
        throw verifierError;
      }
      return items.map((item) => ({
        id: item.id,
        outcome: "scored" as const,
        supportProbability: 0.1,
      }));
    });
    const stream = buildWriter();

    await runStreamedAnswer(
      buildPrepared(
        buildAnswerModel(buildVerifiableAnsweredDraft(["EVID_A", "EVID_B"])),
        verifier,
        [buildTextRetrieved(), buildContradictingTextRetrieved()],
      ),
      stream.writer,
    );

    expect(scoreRequestCount).toBe(2);
    expect(saveTurnMock).toHaveBeenCalledOnce();
    expect(readChunks(stream.chunks, "data-answer")).toHaveLength(1);
    expect(readChunks(stream.chunks, "finish")).toHaveLength(1);
  });

  it("preserves cancellation without persisting or publishing", async () => {
    const controller = new AbortController();
    const answerModel = new MockLanguageModelV4({
      doGenerate: async () => {
        controller.abort(new Error("cancelled"));
        return buildTextGeneration(JSON.stringify(buildAnsweredDraft()));
      },
    });
    const stream = buildWriter();

    await expect(runStreamedAnswer(
      buildPrepared(answerModel, new FakeHhemClient()),
      stream.writer,
      controller.signal,
    )).rejects.toThrow();

    expect(saveTurnMock).not.toHaveBeenCalled();
    expect(readChunks(stream.chunks, "data-answer")).toEqual([]);
    expect(readChunks(stream.chunks, "finish")).toEqual([]);
  });

  it("preserves persistence failure without publishing", async () => {
    const persistenceError = new Error("research persistence failed");
    saveTurnMock.mockRejectedValue(persistenceError);
    const stream = buildWriter();

    await expect(runStreamedAnswer(
      buildPrepared(
        buildAnswerModel(buildAnsweredDraft()),
        new FakeHhemClient(),
      ),
      stream.writer,
    )).rejects.toBe(persistenceError);

    expect(saveTurnMock).toHaveBeenCalledOnce();
    expect(readChunks(stream.chunks, "data-answer")).toEqual([]);
    expect(readChunks(stream.chunks, "finish")).toEqual([]);
  });

  it("preserves cancellation after persistence without publishing", async () => {
    const controller = new AbortController();
    saveTurnMock.mockImplementation(async (input: SaveResearchTurnInput) => {
      controller.abort(new Error("cancelled after persistence"));
      return buildSavedTurn(input);
    });
    const stream = buildWriter();

    await expect(runStreamedAnswer(
      buildPrepared(
        buildAnswerModel(buildAnsweredDraft()),
        new FakeHhemClient(),
      ),
      stream.writer,
      controller.signal,
    )).rejects.toThrow("cancelled after persistence");

    expect(saveTurnMock).toHaveBeenCalledOnce();
    expect(readChunks(stream.chunks, "data-answer")).toEqual([]);
    expect(readChunks(stream.chunks, "finish")).toEqual([]);
  });
});

async function runStreamedAnswer(
  prepared: PreparedRetrieval,
  writer: UIMessageStreamWriter<CiteLoomUIMessage>,
  abortSignal: AbortSignal = new AbortController().signal,
): Promise<void> {
  await writeStreamedAnswer(
    buildConfig(),
    buildDatabaseSession(),
    "What changed?",
    { kind: "all" },
    threadId,
    () => undefined,
    abortSignal,
    writer,
    async () => prepared,
  );
}

function buildPrepared(
  answerModel: LanguageModelV4,
  verifier: FakeHhemClient,
  retrieved: RetrievedElement[] = [buildTextRetrieved()],
): PreparedRetrieval {
  const scheduler = new TaskLimiter(1);
  return {
    generationSettings: {
      answer: { seed: 1, temperature: 0 },
      queryExpansion: { seed: 2, temperature: 0 },
      seedMode: "stable",
    },
    answerScheduler: scheduler,
    models: buildModelRegistry(answerModel, verifier),
    rerankingScheduler: scheduler,
    retrievalTrace: {
      generation: {
        answer: { seed: 1, temperature: 0 },
        queryExpansion: { seed: 2, temperature: 0 },
        seedMode: "stable",
      },
      orderedSources: [],
      queries: [{ kind: "original", text: "What changed?" }],
      version: 3,
    },
    retrieved,
  };
}

function buildModelRegistry(
  answerModel: LanguageModelV4,
  verifier: FakeHhemClient,
): InferenceModelRegistry {
  const embedding = new MockEmbeddingModelV4();
  return {
    answer: wrapLanguageModel({
      middleware: simulateStreamingMiddleware(),
      model: answerModel,
    }),
    answerBudget: { maximumOutputTokens: 16_384, minimumOutputTokens: 256, providerSafetyMarginTokens: 0 },
    readAnswerCapabilities: async () => buildTestModelCapabilities(),
    claimVerifier: verifier,
    documentEmbedding: embedding,
    metrics: new InferenceMetricsReporter({ enabled: false }),
    queryExpansion: answerModel,
    queryEmbedding: embedding,
    reranker: null,
    summary: answerModel,
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
    doGenerate: buildTextGeneration(JSON.stringify(draft)),
    modelId: "answer-model:answer",
  });
}

function buildAnsweredDraft() {
  return {
    answer: {
      content: "Revenue increased.",
      findings: [],
    },
  };
}

function buildVerifiableAnsweredDraft(evidenceRefs: string[]) {
  return {
    answer: {
      content: "The report describes a revenue change.",
      findings: [{
        content: "Revenue increased.",
        evidenceRefs,
      }],
    },
  };
}

function buildTextGeneration(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ text, type: "text" }],
    finishReason: { raw: "stop", unified: "stop" },
    usage: {
      inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
      outputTokens: { reasoning: 0, text: 6, total: 6 },
    },
    warnings: [],
  };
}

function buildTextRetrieved(): RetrievedElement {
  return {
    distance: 0.1,
    documentVersionId: "00000000-0000-4000-8000-000000000002",
    element: {
      content: "Revenue increased during the reporting period.",
      documentId: "a".repeat(64),
      id: "b".repeat(64),
      detectedTypes: ["paragraph"],
      kind: "text",
      ...buildSourceLocation(3),
      sourceFile: "/tmp/report.pdf",
    },
    evidenceContent: "Revenue growth",
    provenance: buildRetrievedElementProvenance("b".repeat(64)),
  };
}

function buildContradictingTextRetrieved(): RetrievedElement {
  return {
    distance: 0.2,
    documentVersionId: "00000000-0000-4000-8000-000000000004",
    element: {
      content: "Revenue decreased during the reporting period.",
      documentId: "c".repeat(64),
      id: "d".repeat(64),
      detectedTypes: ["paragraph"],
      kind: "text",
      ...buildSourceLocation(4),
      sourceFile: "/tmp/contradicting-report.pdf",
    },
    evidenceContent: "Revenue decline",
    provenance: buildRetrievedElementProvenance("c".repeat(64)),
  };
}

function buildConfig(): AppConfig {
  return readEqualWeightTestConfig();
}

function buildDatabaseSession(): DatabaseSession {
  return { database: {} } as DatabaseSession;
}

function buildWriter(
  onWrite: (chunk: WrittenChunk) => void = () => undefined,
): {
  chunks: WrittenChunk[];
  writer: UIMessageStreamWriter<CiteLoomUIMessage>;
} {
  const chunks: WrittenChunk[] = [];
  const writer = {
    write(chunk: WrittenChunk) {
      chunks.push(chunk);
      onWrite(chunk);
    },
  } as unknown as UIMessageStreamWriter<CiteLoomUIMessage>;
  return { chunks, writer };
}

function readChunks<Type extends WrittenChunk["type"]>(
  chunks: readonly WrittenChunk[],
  type: Type,
): Array<Extract<WrittenChunk, { type: Type }>> {
  const matches: Array<Extract<WrittenChunk, { type: Type }>> = [];
  for (const chunk of chunks) {
    if (chunk.type === type) {
      matches.push(chunk as Extract<WrittenChunk, { type: Type }>);
    }
  }
  return matches;
}

function readSavedTurnInput(): SaveResearchTurnInput {
  const input = saveTurnMock.mock.calls[0]?.[0];
  if (input === undefined) {
    throw new Error("Expected a saved research turn input.");
  }
  return input as SaveResearchTurnInput;
}

function buildSavedTurn(input: SaveResearchTurnInput): ResearchTurn {
  const turnId = "00000000-0000-4000-8000-000000000003";
  const claims = buildStoredClaims(input.claims, turnId);
  const citations = buildStoredCitations(input, turnId);
  return {
    answerDocument: input.answerDocument,
    citations,
    claims,
    completedAt: input.completedAt.toISOString(),
    id: turnId,
    question: input.question,
    reproducibility: { available: true, unavailableDependencies: [] },
    retrievedContext: [...input.retrievedContext],
    retrievalTrace: input.retrievalTrace,
    runConfiguration: input.runConfiguration,
    runId: input.runId,
    scope: input.scope,
    sequence: 1,
    threadId: input.threadId,
  };
}

function buildStoredClaims(
  claims: SaveResearchTurnInput["claims"],
  turnId: string,
): StoredClaimCheck[] {
  const stored: StoredClaimCheck[] = [];
  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index];
    if (claim === undefined) {
      throw new Error(`Missing saved claim at index ${index}.`);
    }
    stored.push({
      ...claim,
      createdAt: "2026-07-18T00:00:00.000Z",
      id: `00000000-0000-4000-8000-${String(index + 4).padStart(12, "0")}`,
      turnId,
    });
  }
  return stored;
}

function buildStoredCitations(
  input: SaveResearchTurnInput,
  turnId: string,
): StoredCitationRecord[] {
  const stored: StoredCitationRecord[] = [];
  for (const citation of input.answerDocument.citations) {
    stored.push({
      ...citation,
      createdAt: "2026-07-18T00:00:00.000Z",
      stale: false,
      turnId,
    });
  }
  return stored;
}
