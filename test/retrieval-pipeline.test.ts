import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTestModelCapabilities } from "./model-capabilities-fixture.js";
import type { LanguageModelV4, LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { type UIMessageStreamWriter } from "ai";
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
  it("verifies, persists, and then publishes one completed answer entity", async () => {
    const events: string[] = [];
    const answerModel = buildAnswerModel(buildAnsweredDraft([1]));
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
      if (chunk.type === "data-answer") {
        events.push("publish");
      }
    });

    await runStreamedAnswer(
      buildPrepared(answerModel, verifier),
      stream.writer,
    );

    expect(events).toEqual(["verify", "persist", "publish"]);
    const answers = readChunks(stream.chunks, "data-answer");
    expect(answers).toHaveLength(1);
    expect(answers[0]?.data).toMatchObject({
      answerDocument: {
        citations: [expect.objectContaining({ citationNumber: 1 })],
        schemaVersion: 1,
        statements: [expect.objectContaining({ content: "Revenue increased." })],
        status: "answered",
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
      answerDocument: { status: "answered" },
      claims: [{
        citationNumbers: [1],
        claim: "Revenue increased.",
        status: "supported",
      }],
    });
  });

  it("prunes unsupported citations before persistence and deterministic publication", async () => {
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
      conflictGroups: [],
      statements: [{
        content: "Unsupported statement.",
        presentation: "paragraph",
        section: "answer",
        sourceNumbers: [1],
      }, {
        content: "Revenue decreased.",
        presentation: "paragraph",
        section: "answer",
        sourceNumbers: [2, 1],
      }],
      status: "answered",
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
    expect(saved.claims).toEqual(published.claims.map((claim) => {
      const {
        createdAt: _createdAt,
        id: _id,
        turnId: _turnId,
        ...savedClaim
      } = claim;
      return savedClaim;
    }));
    expect(saved.answerDocument).toMatchObject({
      citations: [{
        citationNumber: 1,
        elementId: "d".repeat(64),
        evidence: {
          excerpt: "Revenue decreased during the reporting period.",
          kind: "text",
        },
      }],
      statements: [{
        content: "Revenue decreased.",
      }],
      status: "answered",
    });
    expect(saved.claims).toMatchObject([{
      citationNumbers: [1],
      claim: "Revenue decreased.",
      claimIndex: 0,
      evidenceUnits: [{
        citationNumber: 1,
        outcome: "supported",
        unitId: "claim-0-citation-1",
      }],
      status: "supported",
    }]);
    expect(published.runDetails?.sourceCount).toBe(1);
    expect(JSON.stringify(published)).not.toContain("Unsupported statement.");
    expect(JSON.stringify(published)).not.toContain("b".repeat(64));
  });

  it("applies citation validation to a recovered answer draft", async () => {
    let requestCount = 0;
    const answerModel = new MockLanguageModelV4({
      doGenerate: async () => {
        requestCount += 1;
        const draft = requestCount === 1
          ? buildAnsweredDraft([3])
          : buildAnsweredDraft([1, 2]);
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
        }],
        statements: [{
          content: "Revenue increased.",
        }],
        status: "answered",
      },
      claims: [{
        citationNumbers: [1],
        status: "supported",
      }],
    });
  });

  it("publishes no-answer when every exact citation set is unsupported", async () => {
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
        buildAnswerModel(buildAnsweredDraft([1])),
        verifier,
      ),
      stream.writer,
    );

    const saved = readSavedTurnInput();
    const published = readChunks(stream.chunks, "data-answer")[0]?.data;
    expect(saved.answerDocument).toEqual({
      citations: [],
      schemaVersion: 1,
      statements: [],
      status: "no_answer",
    });
    expect(saved.claims).toEqual([]);
    expect(published?.answerDocument).toEqual(saved.answerDocument);
    expect(published?.claims).toEqual([]);
    expect(published?.runDetails?.sourceCount).toBe(0);
    expect(JSON.stringify(published)).not.toContain("Revenue increased.");
  });

  it("verifies and atomically publishes both sides of a genuine conflict", async () => {
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
      conflictGroups: [{
        explanation: "The same reported revenue cannot both increase and decrease.",
        positions: [{
          claim: "Revenue increased.",
          sourceNumbers: [1],
        }, {
          claim: "Revenue decreased.",
          sourceNumbers: [2],
        }],
        sharedScope: {
          conditions: "the same accounting basis",
          context: "the reporting entity",
          scope: "the annual report",
          timePeriod: "the 2025 fiscal year",
        },
      }],
      statements: [],
      status: "answered",
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
    expect(verifiedClaims).toContain(
      "The same reported revenue cannot both increase and decrease.",
    );
    const published = readChunks(stream.chunks, "data-answer")[0]?.data;
    if (published === undefined) {
      throw new Error("Expected a published conflict answer.");
    }
    expect(published.answerDocument.citations).toHaveLength(2);
    expect(published.answerDocument.statements.map((statement) => statement.section))
      .toEqual([
        "conflicting-evidence",
        "conflicting-evidence",
        "conflicting-evidence",
        "conflicting-evidence",
      ]);
    expect(published.answerDocument.statements[1]?.citationIds).toEqual([
      published.answerDocument.citations[0]?.id,
    ]);
    expect(published.answerDocument.statements[2]?.citationIds).toEqual([
      published.answerDocument.citations[1]?.id,
    ]);
    expect(saveTurnMock).toHaveBeenCalledOnce();
  });

  it("replaces an invalid model draft before persistence and publication", async () => {
    const answerModel = buildAnswerModel(buildAnsweredDraft([2]));
    const verifier = new FakeHhemClient();
    const stream = buildWriter();

    await runStreamedAnswer(
      buildPrepared(answerModel, verifier),
      stream.writer,
    );

    expect(verifier.scoreCalls).toEqual([]);
    expect(readSavedTurnInput().answerDocument).toEqual({
      citations: [],
      schemaVersion: 1,
      statements: [],
      status: "no_answer",
    });
    const published = readChunks(stream.chunks, "data-answer")[0]?.data;
    expect(published?.answerDocument.status).toBe("no_answer");
    expect(JSON.stringify(published)).not.toContain("Revenue increased");
  });

  it("preserves verifier failure without persisting or publishing", async () => {
    const verifierError = new Error("verifier unavailable");
    const verifier = new FakeHhemClient(0.5, async () => {
      throw verifierError;
    });
    const stream = buildWriter();

    await expect(runStreamedAnswer(
      buildPrepared(buildAnswerModel(buildAnsweredDraft([1])), verifier),
      stream.writer,
    )).rejects.toBe(verifierError);

    expect(saveTurnMock).not.toHaveBeenCalled();
    expect(stream.chunks).toEqual([]);
  });

  it("preserves collective verifier failure without persisting or publishing", async () => {
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

    await expect(runStreamedAnswer(
      buildPrepared(
        buildAnswerModel(buildAnsweredDraft([1, 2])),
        verifier,
        [buildTextRetrieved(), buildContradictingTextRetrieved()],
      ),
      stream.writer,
    )).rejects.toBe(verifierError);

    expect(scoreRequestCount).toBe(2);
    expect(saveTurnMock).not.toHaveBeenCalled();
    expect(stream.chunks).toEqual([]);
  });

  it("preserves cancellation without persisting or publishing", async () => {
    const controller = new AbortController();
    const answerModel = new MockLanguageModelV4({
      doGenerate: async () => {
        controller.abort(new Error("cancelled"));
        return buildTextGeneration(JSON.stringify(buildAnsweredDraft([1])));
      },
    });
    const stream = buildWriter();

    await expect(runStreamedAnswer(
      buildPrepared(answerModel, new FakeHhemClient()),
      stream.writer,
      controller.signal,
    )).rejects.toThrow();

    expect(saveTurnMock).not.toHaveBeenCalled();
    expect(stream.chunks).toEqual([]);
  });

  it("preserves persistence failure without publishing", async () => {
    const persistenceError = new Error("research persistence failed");
    saveTurnMock.mockRejectedValue(persistenceError);
    const stream = buildWriter();

    await expect(runStreamedAnswer(
      buildPrepared(
        buildAnswerModel(buildAnsweredDraft([1])),
        new FakeHhemClient(),
      ),
      stream.writer,
    )).rejects.toBe(persistenceError);

    expect(saveTurnMock).toHaveBeenCalledOnce();
    expect(stream.chunks).toEqual([]);
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
        buildAnswerModel(buildAnsweredDraft([1])),
        new FakeHhemClient(),
      ),
      stream.writer,
      controller.signal,
    )).rejects.toThrow("cancelled after persistence");

    expect(saveTurnMock).toHaveBeenCalledOnce();
    expect(stream.chunks).toEqual([]);
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
    answer: answerModel,
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

function buildAnsweredDraft(sourceNumbers: number[]) {
  return {
    conflictGroups: [],
    statements: [{
      content: "Revenue increased.",
      presentation: "paragraph",
      section: "answer",
      sourceNumbers,
    }],
    status: "answered",
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
