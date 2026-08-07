import { describe, expect, it } from "vitest";

import type {
  CiteLoomDatabase,
  SqlQueryExecutor,
} from "../src/database/client.js";
import {
  retrieveRelevantElements,
  readEmbedding,
} from "../src/retrieval/indexing/index.js";
import { rankRetrievalCandidates } from "../src/retrieval/indexing/query-store.js";
import { createCandidateSourceAliases } from "../src/retrieval/ranking/rank-fusion.js";
import {
  startRunTelemetry,
  type RunTelemetrySink,
  type TelemetryRunCompletionRecord,
  type TelemetryRunStartRecord,
  type TelemetryStageRecord,
} from "../src/observability/run.js";
import type { SourceDocumentStore } from "../src/documents/storage/source-document-store.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";
import {
  buildExactCandidateRepresentation,
  buildSourceLocation,
} from "./source-element-fixture.js";

describe("retrieval embedding validation", () => {
  it("accepts EmbeddingGemma's 768-dimensional output", () => {
    const embedding = Array.from({ length: 768 }, () => 0.25);
    expect(readEmbedding(embedding, 768, "test embedding")).toEqual(embedding);
  });

  it("rejects a vector with the wrong dimensions", () => {
    expect(() => readEmbedding([0.25], 768, "test embedding")).toThrow(
      "expected 768 finite numbers with at least one nonzero value",
    );
  });

  it("rejects non-finite values before they reach PostgreSQL", () => {
    const embedding = Array.from({ length: 768 }, () => 0.25);
    embedding[400] = Number.NaN;
    expect(() => readEmbedding(embedding, 768, "test embedding")).toThrow(
      "expected 768 finite numbers with at least one nonzero value",
    );
  });

  it("rejects an all-zero vector because cosine distance is undefined", () => {
    const embedding = Array.from({ length: 768 }, () => 0);
    expect(() => readEmbedding(embedding, 768, "test embedding")).toThrow(
      "at least one nonzero value",
    );
  });
});

describe("retrieval telemetry", () => {
  it("records lexical retrieval, fusion, hydration, and request counts", async () => {
    const config = readEqualWeightTestConfig();
    config.retrieval = {
      ...config.retrieval,
      candidateK: 5,
      mode: "bm25",
      queryExpansions: 0,
      topK: 2,
    };
    const documentId = "a".repeat(64);
    const elementId = "b".repeat(64);
    const evidenceContent = (
      "This relevant English evidence window explains the requested policy."
    );
    const queryExecutor: SqlQueryExecutor = {
      execute: async () => {
        return [{
          bm25Score: 3,
          documentId,
          elementSetId: "c".repeat(64),
          evidenceContent,
          evidenceRetrievalId: elementId,
          generationId: "00000000-0000-4000-8000-000000000001",
          kind: "text",
          parentId: elementId,
          representationContent: evidenceContent,
          representationId: elementId,
          representationType: "exact-window",
          sourceFile: "/documents/source.pdf",
        }];
      },
    };
    const documentStore = {
      readManyForRetrievalFrom: async () => [{
        content: "Relevant source content.",
        documentId,
        id: elementId,
        kind: "text" as const,
        ...buildSourceLocation(1),
        sourceFile: "/documents/source.pdf",
      }],
    } as unknown as SourceDocumentStore;
    const aliasRows = [{
      documentId,
      documentVersionId: "00000000-0000-4000-8000-000000000001",
      elementSetId: "c".repeat(64),
      evidenceContent,
      evidenceRetrievalId: elementId,
      parentId: elementId,
      sourceFile: "/documents/source.pdf",
    }];
    const activeWindowRows = [{
      documentId,
      evidenceContent,
      generationId: "00000000-0000-4000-8000-000000000001",
      id: elementId,
      nextRetrievalId: null,
      previousRetrievalId: null,
      sourceFile: "/documents/source.pdf",
    }];
    const databaseSelections = [
      [{ pointerCount: 1, representationCount: 1 }],
      [{ representationCount: 1 }],
      aliasRows,
      activeWindowRows,
    ];
    let databaseSelectionIndex = 0;
    const readNextDatabaseSelection = async (): Promise<unknown[]> => {
      const rows = databaseSelections[databaseSelectionIndex];
      if (rows === undefined) {
        throw new Error("Retrieval issued an unexpected database selection.");
      }
      databaseSelectionIndex += 1;
      return rows;
    };
    const database = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: readNextDatabaseSelection,
          }),
          where: readNextDatabaseSelection,
        }),
      }),
    } as unknown as CiteLoomDatabase;
    const sink = new RecordingTelemetrySink();
    const telemetry = await startRunTelemetry(config, "retrieval", sink);
    telemetry.setScopeSize(1);
    telemetry.setQueryVariantCount(1);

    const retrieved = await retrieveRelevantElements(
      database,
      queryExecutor,
      documentStore,
      config.embeddingSpace,
      "private question",
      [{ embedding: null, text: "private question" }],
      config.retrieval,
      [{
        documentId,
        generationId: "00000000-0000-4000-8000-000000000001",
        sourceFile: "/documents/source.pdf",
      }],
      null,
      null,
      new AbortController().signal,
      telemetry,
    );
    await telemetry.finish("success");

    expect(retrieved).toHaveLength(1);
    expect(databaseSelectionIndex).toBe(databaseSelections.length);
    expect(sink.stages.map((stage) => stage.name)).toEqual([
      "lexical-retrieval",
      "fusion",
      "hydration",
    ]);
    expect(sink.completions[0]).toMatchObject({
      candidateCount: 1,
      hydratedContextCount: 1,
      queryVariantCount: 1,
      scopeSize: 1,
    });
    expect(JSON.stringify(sink)).not.toContain("private question");
    expect(JSON.stringify(sink)).not.toContain("Relevant source content");
  });
});

describe("weighted retrieval ranking", () => {
  it("combines modality, original-question, expansion, and decay weights", () => {
    const ranked = rankRetrievalCandidates(
      "hybrid",
      {
        dense: [
          [buildDenseCandidate("original-dense")],
          [buildDenseCandidate("first-expansion-dense")],
          [buildDenseCandidate("second-expansion-dense")],
        ],
        lexical: [
          [buildLexicalCandidate("original-lexical")],
          [buildLexicalCandidate("first-expansion-lexical")],
          [buildLexicalCandidate("second-expansion-lexical")],
        ],
      },
      60,
      {
        denseWeight: 2,
        expansionDecay: 0.5,
        expansionQueryWeight: 4,
        lexicalWeight: 1,
        originalQueryWeight: 3,
      },
    );
    const scoreByParentId = new Map(
      ranked.map((candidate) => [candidate.parentId, candidate.fusedScore]),
    );
    const reciprocalRank = 1 / 61;

    expect(scoreByParentId.get("original-dense")).toBeCloseTo(
      6 * reciprocalRank,
    );
    expect(scoreByParentId.get("original-lexical")).toBeCloseTo(
      3 * reciprocalRank,
    );
    expect(scoreByParentId.get("first-expansion-dense")).toBeCloseTo(
      8 * reciprocalRank,
    );
    expect(scoreByParentId.get("first-expansion-lexical")).toBeCloseTo(
      4 * reciprocalRank,
    );
    expect(scoreByParentId.get("second-expansion-dense")).toBeCloseTo(
      4 * reciprocalRank,
    );
    expect(scoreByParentId.get("second-expansion-lexical")).toBeCloseTo(
      2 * reciprocalRank,
    );
  });

  it("rejects incomplete hybrid query rankings", () => {
    expect(() => rankRetrievalCandidates(
      "hybrid",
      {
        dense: [[buildDenseCandidate("dense")]],
        lexical: [],
      },
      60,
      {
        denseWeight: 1,
        expansionDecay: 1,
        expansionQueryWeight: 1,
        lexicalWeight: 1,
        originalQueryWeight: 1,
      },
    )).toThrow("one dense and lexical ranking per query");
  });
});

class RecordingTelemetrySink implements RunTelemetrySink {
  public readonly completions: TelemetryRunCompletionRecord[] = [];
  public readonly stages: TelemetryStageRecord[] = [];
  public readonly starts: TelemetryRunStartRecord[] = [];

  public async startRun(record: TelemetryRunStartRecord): Promise<void> {
    this.starts.push(record);
  }

  public async recordStage(record: TelemetryStageRecord): Promise<void> {
    this.stages.push(record);
  }

  public async completeRun(
    record: TelemetryRunCompletionRecord,
  ): Promise<void> {
    this.completions.push(record);
  }
}

function buildDenseCandidate(parentId: string) {
  const content = `Dense summary for ${parentId}`;
  return {
    distance: 0.1,
    documentId: "a".repeat(64),
    elementSetId: "b".repeat(64),
    evidenceContent: content,
    evidenceRetrievalId: parentId,
    parentId,
    representation: buildExactCandidateRepresentation(parentId, content),
    sourceAliases: createCandidateSourceAliases({
      evidenceRetrievalId: parentId,
      sourceFile: "/documents/source.pdf",
    }),
    sourceFile: "/documents/source.pdf",
  };
}

function buildLexicalCandidate(parentId: string) {
  const content = `Lexical summary for ${parentId}`;
  return {
    bm25Score: 1,
    documentId: "a".repeat(64),
    elementSetId: "b".repeat(64),
    evidenceContent: content,
    evidenceRetrievalId: parentId,
    parentId,
    representation: buildExactCandidateRepresentation(parentId, content),
    sourceAliases: createCandidateSourceAliases({
      evidenceRetrievalId: parentId,
      sourceFile: "/documents/source.pdf",
    }),
    sourceFile: "/documents/source.pdf",
  };
}
