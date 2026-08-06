import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import type { TaskScheduler } from "../../shared/concurrency.js";
import type {
  EmbeddingSpaceConfig,
  RankFusionConfig,
  RetrievalConfig,
  RetrievalMode,
} from "../../config/index.js";
import type { CiteLoomDatabase, SqlQueryExecutor } from "../../database/client.js";
import {
  indexedDocuments,
  indexedDocumentSpaces,
} from "../../database/schema.js";
import {
  selectNonOverlappingCandidatesWithTrace,
  selectTopCandidates,
  selectTopRetrievedElements,
  type NonOverlappingCandidateSelection,
} from "../document-retrieval.js";
import type { RetrievedElement } from "../document-retrieval.js";
import type { RetrievalSourceElement } from "../../domain/source-elements.js";
import {
  fuseRankedCandidates,
  type DenseCandidate,
  type FusedCandidate,
  type LexicalCandidate,
  type WeightedRanking,
} from "../ranking/rank-fusion.js";
import {
  rerankRetrievedElementsWithScores,
  type ResolvedReranker,
} from "../ranking/reranker.js";
import type {
  PostRerankCandidateSelection,
  RerankerCandidateIdentity,
} from "../ranking/candidate-selection.js";
import { readEmbedding } from "./index-store.js";
import { matchesResolvedQueryScope } from "./query-scope-filter.js";
import {
  queryDenseCandidates,
} from "./vector-query-store.js";
import {
  CandidateBudgetSearch,
  type RetrievalSearchStrategy,
} from "./candidate-budget-search.js";
import {
  createActiveProjectionKey,
  queryDenseEvidenceCandidates,
  readActiveRetrievalWindows,
} from "./vector-query-store.js";
import {
  createTelemetryStageResult,
  noopRunTelemetry,
  readTelemetryFailureOutcome,
  type RunTelemetry,
  type TelemetryStage,
  type CandidateBudgetTelemetry,
  type ContextSelectionCandidateTelemetry,
} from "../../observability/run.js";
import { answerContextSelectionConfig } from "../ranking/context-selection.js";
import {
  createDiscoveryDocumentKey,
  type KeywordDiscoveryMatch,
  type KeywordDiscoveryPage,
} from "../discovery/model.js";
import type { SourceDocumentStore } from "../../documents/storage/source-document-store.js";
import {
  createResolvedQueryScopeTargetKey,
  splitResolvedQueryScopeTargets,
  type ResolvedQueryScopeTarget,
} from "../../domain/query-scope.js";
import { contentIdSchema } from "../../domain/validation.js";
import type {
  RetrievalRepresentationType,
} from "../representations.js";
import {
  createDocumentTocRanking,
} from "../toc/expansion.js";
import { buildCandidateBudgetTelemetry } from "./candidate-telemetry.js";
import type {
  RetrievalCandidateRankings,
  RetrievalQuery,
} from "./query-types.js";

export { buildCandidateBudgetTelemetry } from "./candidate-telemetry.js";
export type {
  RetrievalCandidateRankings,
  RetrievalQuery,
} from "./query-types.js";

const passiveAbortSignal = new AbortController().signal;
const RETRIEVAL_STATEMENT_TIMEOUT_MS = 30_000;
const retrievalIdentifierSchema = z.string().regex(
  /^[a-f0-9]{64}(?:-description)?$/u,
);
const denseRetrievalRowBase = {
  distance: z.number().nonnegative(),
  documentId: contentIdSchema,
  evidenceContent: z.string().min(1),
  evidenceRetrievalId: retrievalIdentifierSchema,
  generationId: z.uuid(),
  parentId: contentIdSchema,
  representationContent: z.string().min(1),
  representationId: retrievalIdentifierSchema,
  sourceFile: z.string().min(1),
};
const denseRetrievalRowSchema = z.discriminatedUnion("representationType", [
  z.object({
    ...denseRetrievalRowBase,
    kind: z.enum(["table", "text"]),
    representationType: z.literal("exact-window"),
  }),
  z.object({
    ...denseRetrievalRowBase,
    kind: z.literal("image"),
    representationType: z.literal("image-description"),
  }),
  z.object({
    ...denseRetrievalRowBase,
    kind: z.literal("table"),
    representationType: z.literal("table-description"),
  }),
]);
const lexicalRetrievalRowBase = {
  bm25Score: z.number().nonnegative(),
  documentId: contentIdSchema,
  evidenceContent: z.string().min(1),
  evidenceRetrievalId: retrievalIdentifierSchema,
  generationId: z.uuid(),
  parentId: contentIdSchema,
  representationContent: z.string().min(1),
  representationId: retrievalIdentifierSchema,
  sourceFile: z.string().min(1),
};
const lexicalRetrievalRowSchema = z.discriminatedUnion(
  "representationType",
  [
    z.object({
      ...lexicalRetrievalRowBase,
      kind: z.enum(["table", "text"]),
      representationType: z.literal("exact-window"),
    }),
    z.object({
      ...lexicalRetrievalRowBase,
      kind: z.literal("image"),
      representationType: z.literal("image-description"),
    }),
    z.object({
      ...lexicalRetrievalRowBase,
      kind: z.literal("table"),
      representationType: z.literal("table-description"),
    }),
  ],
);
type DenseRetrievalRow = z.output<typeof denseRetrievalRowSchema>;
type DescriptionDenseRetrievalRow = Exclude<
  DenseRetrievalRow,
  { representationType: "exact-window" }
>;
const exactEvidenceRowSchema = z.object({
  distance: z.number().nonnegative(),
  documentId: contentIdSchema,
  evidenceContent: z.string().min(1),
  evidenceRetrievalId: retrievalIdentifierSchema,
  parentId: contentIdSchema,
  sourceFile: z.string().min(1),
});
const keywordDiscoveryRowSchema = z.object({
  documentId: contentIdSchema,
  evidenceContent: z.string().min(1),
  matchingPassageCount: z.number().int().positive(),
  parentId: contentIdSchema,
  sourceFile: z.string().min(1),
});
const keywordDiscoveryResultSchema = z.object({
  result: z.object({
    matches: z.array(keywordDiscoveryRowSchema),
    totalDocuments: z.number().int().nonnegative(),
  }),
});
const keywordDocumentRowSchema = z.object({
  documentId: contentIdSchema,
  sourceFile: z.string().min(1),
});

interface RetrievalCandidateRows {
  dense: DenseCandidate[];
  lexical: LexicalCandidate[];
}

export interface RetrievedElementsResult {
  rerankerModelId: string | null;
  retrieved: RetrievedElement[];
  strongestRerankerScore: number | null;
}

export async function retrieveRelevantElements(
  database: CiteLoomDatabase,
  queryExecutor: SqlQueryExecutor,
  documentStore: SourceDocumentStore,
  space: EmbeddingSpaceConfig,
  originalQuestion: string,
  queries: RetrievalQuery[],
  config: RetrievalConfig,
  scopeTargets: ResolvedQueryScopeTarget[],
  reranker: ResolvedReranker | null,
  rerankerScheduler: TaskScheduler | null = null,
  abortSignal: AbortSignal = passiveAbortSignal,
  runTelemetry: RunTelemetry = noopRunTelemetry,
  useDocumentToc = false,
): Promise<RetrievedElement[]> {
  const result = await retrieveRelevantElementsWithScores(
    database,
    queryExecutor,
    documentStore,
    space,
    originalQuestion,
    queries,
    config,
    scopeTargets,
    reranker,
    rerankerScheduler,
    abortSignal,
    runTelemetry,
    useDocumentToc,
  );
  return result.retrieved;
}

export async function retrieveRelevantElementsWithScores(
  database: CiteLoomDatabase,
  queryExecutor: SqlQueryExecutor,
  documentStore: SourceDocumentStore,
  space: EmbeddingSpaceConfig,
  originalQuestion: string,
  queries: RetrievalQuery[],
  config: RetrievalConfig,
  scopeTargets: ResolvedQueryScopeTarget[],
  reranker: ResolvedReranker | null,
  rerankerScheduler: TaskScheduler | null = null,
  abortSignal: AbortSignal = passiveAbortSignal,
  runTelemetry: RunTelemetry = noopRunTelemetry,
  useDocumentToc = false,
): Promise<RetrievedElementsResult> {
  if (scopeTargets.length === 0) {
    return {
      rerankerModelId: null,
      retrieved: [],
      strongestRerankerScore: null,
    };
  }
  if (queries.length === 0) {
    throw new Error("Retrieval requires at least one query.");
  }
  const rankings = await queryRetrievalCandidateRankings(
    database,
    queryExecutor,
    space,
    queries,
    config,
    scopeTargets,
    abortSignal,
    runTelemetry,
  );
  const fusionStage = runTelemetry.startStage({
    model: null,
    name: "fusion",
    retrievalMode: config.mode,
  });
  let rankedCandidates: FusedCandidate[];
  try {
    rankedCandidates = rankRetrievalCandidates(
      config.mode,
      rankings,
      config.rrfK,
      config.fusion,
    );
    if (
      useDocumentToc
      && retrievalModeUsesDense(config.mode)
      && queries[0]?.embedding !== null
      && queries[0]?.embedding !== undefined
    ) {
      const tocRanking = await createDocumentTocRanking(
        database,
        space,
        config.mode,
        queries[0].embedding,
        rankedCandidates,
        config.candidateK,
        config.fusion,
        abortSignal,
        runTelemetry,
      );
      if (tocRanking !== null) {
        rankedCandidates = rankRetrievalCandidates(
          config.mode,
          rankings,
          config.rrfK,
          config.fusion,
          [tocRanking],
        );
      }
    }
    await fusionStage.finish(createTelemetryStageResult("success", {
      inputCount: countRankedCandidates(rankings),
      outputCount: rankedCandidates.length,
    }));
  } catch (error: unknown) {
    await fusionStage.finish(createTelemetryStageResult("error", {
      inputCount: countRankedCandidates(rankings),
    }));
    throw error;
  }
  const candidateSelection = selectNonOverlappingCandidatesWithTrace(
    rankedCandidates,
    config.candidateK,
    "fused-order",
  );
  const candidatesToLoad = candidateSelection.selected;
  runTelemetry.setCandidateCount(candidatesToLoad.length);
  const hydrationStage = runTelemetry.startStage({
    model: null,
    name: "hydration",
    retrievalMode: config.mode,
  });
  let retrieved: RetrievedElement[];
  let hydratedCandidates: FusedCandidate[];
  try {
    const hydrated = await loadRetrievalCandidatesWithMetadata(
      database,
      documentStore,
      candidatesToLoad,
      scopeTargets,
    );
    retrieved = hydrated.retrieved;
    hydratedCandidates = hydrated.candidates;
    await hydrationStage.finish(createTelemetryStageResult("success", {
      inputCount: candidatesToLoad.length,
      outputCount: retrieved.length,
    }));
  } catch (error: unknown) {
    await hydrationStage.finish(createTelemetryStageResult("error", {
      inputCount: candidatesToLoad.length,
    }));
    throw error;
  }
  const candidateBudget = buildCandidateBudgetTelemetry(
    rankings,
    queries,
    config.candidateK,
    space.retrievalWindow,
    candidateSelection,
    hydratedCandidates,
  );
  runTelemetry.recordCandidateBudget(candidateBudget);
  if (config.reranker === null) {
    const selected = selectTopRetrievedElements(retrieved, config.topK);
    const contextualized = await addAdjacentRetrievalContext(
      database,
      space,
      selected,
      scopeTargets,
    );
    runTelemetry.setHydratedContextCount(contextualized.length);
    return {
      rerankerModelId: null,
      retrieved: contextualized,
      strongestRerankerScore: null,
    };
  }
  if (reranker === null) {
    throw new Error("The configured reranker model was not resolved.");
  }
  if (rerankerScheduler === null) {
    throw new Error("The configured reranker scheduler was not resolved.");
  }
  const rerankerCandidateIdentities = buildRerankerCandidateIdentities(
    hydratedCandidates,
    retrieved,
  );
  const rerankingStage = runTelemetry.startStage({
    model: {
      modelId: reranker.model.modelId,
      provider: reranker.model.provider,
    },
    name: "reranking",
    retrievalMode: config.mode,
  });
  try {
    const reranked = await rerankerScheduler.run(
      (requestSignal) => rerankRetrievedElementsWithScores(
        reranker,
        originalQuestion,
        retrieved,
        config.topK,
        requestSignal,
        rerankerCandidateIdentities,
      ),
      abortSignal,
      rerankingStage.timingObserver,
    );
    await rerankingStage.finish(createTelemetryStageResult("success", {
      inputCount: retrieved.length,
      outputCount: reranked.retrieved.length,
    }));
    runTelemetry.setHydratedContextCount(reranked.retrieved.length);
    runTelemetry.recordContextSelection({
      candidateBudget,
      candidates: buildContextSelectionCandidates(
        candidateBudget,
        hydratedCandidates,
        retrieved,
        reranked.candidateSelection,
      ),
      configuration: {
        maximumContextSize: config.topK,
        minimumLogGapMedianMultiplier:
          answerContextSelectionConfig.minimumLogGapMedianMultiplier,
        minimumScoreRatio: answerContextSelectionConfig.minimumScoreRatio,
      },
      cutoff: {
        rank: reranked.selection.cutoffRank,
        reason: reranked.selection.reason,
      },
      policy: answerContextSelectionConfig.policy,
      recovery: { attempted: false, result: "not-applicable" },
    });
    const contextualized = await addAdjacentRetrievalContext(
      database,
      space,
      reranked.retrieved,
      scopeTargets,
    );
    return {
      rerankerModelId: reranker.model.modelId,
      retrieved: contextualized,
      strongestRerankerScore: readStrongestRerankerScore(reranked.ranking),
    };
  } catch (error: unknown) {
    await rerankingStage.finish(createTelemetryStageResult(
      readTelemetryFailureOutcome(abortSignal),
      { inputCount: retrieved.length },
    ));
    throw error;
  }
}

async function addAdjacentRetrievalContext(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
  retrieved: readonly RetrievedElement[],
  scopeTargets: ResolvedQueryScopeTarget[],
): Promise<RetrievedElement[]> {
  const retrievalIds: string[] = [];
  for (const item of retrieved) {
    retrievalIds.push(item.provenance.retrievalWindowId);
  }
  const primaryRows = await readActiveRetrievalWindows(
    database,
    space,
    scopeTargets,
    retrievalIds,
  );
  const primaryByKey = new Map(primaryRows.map((row) => [
    createActiveProjectionKey(
      row.documentId,
      row.generationId,
      row.id,
      row.sourceFile,
    ),
    row,
  ]));
  const neighborIds = new Set<string>();
  for (const row of primaryRows) {
    if (row.previousRetrievalId !== null) {
      neighborIds.add(row.previousRetrievalId);
    }
    if (row.nextRetrievalId !== null) {
      neighborIds.add(row.nextRetrievalId);
    }
  }
  const neighborRows = await readActiveRetrievalWindows(
    database,
    space,
    scopeTargets,
    [...neighborIds],
  );
  const neighborByKey = new Map(neighborRows.map((row) => [
    createActiveProjectionKey(
      row.documentId,
      row.generationId,
      row.id,
      row.sourceFile,
    ),
    row,
  ]));
  const targetByDocument = new Map<string, ResolvedQueryScopeTarget>();
  for (const target of scopeTargets) {
    targetByDocument.set(
      createDiscoveryDocumentKey(target.documentId, target.sourceFile),
      target,
    );
  }
  const selectedKeys = new Set<string>();
  for (const item of retrieved) {
    const target = targetByDocument.get(createDiscoveryDocumentKey(
      item.element.documentId,
      item.element.sourceFile,
    ));
    if (target === undefined) {
      continue;
    }
    selectedKeys.add(createActiveProjectionKey(
      target.documentId,
      target.generationId,
      item.provenance.retrievalWindowId,
      target.sourceFile,
    ));
  }
  const contextualized: RetrievedElement[] = [];
  for (const item of retrieved) {
    const retrievalId = item.provenance.retrievalWindowId;
    const target = targetByDocument.get(createDiscoveryDocumentKey(
      item.element.documentId,
      item.element.sourceFile,
    ));
    if (target === undefined) {
      contextualized.push(item);
      continue;
    }
    const primaryKey = createActiveProjectionKey(
      target.documentId,
      target.generationId,
      retrievalId,
      target.sourceFile,
    );
    const primary = primaryByKey.get(primaryKey);
    if (primary === undefined) {
      contextualized.push(item);
      continue;
    }
    let preceding: string | null = null;
    let following: string | null = null;
    const contextWindowIds: string[] = [];
    if (
      primary.previousRetrievalId !== null
    ) {
      const previousKey = createActiveProjectionKey(
        target.documentId,
        target.generationId,
        primary.previousRetrievalId,
        target.sourceFile,
      );
      const previous = selectedKeys.has(previousKey)
        ? undefined
        : neighborByKey.get(previousKey);
      if (previous !== undefined) {
        preceding = readPrecedingContext(
          previous.evidenceContent,
          item.evidenceContent,
        );
        if (preceding !== null) {
          contextWindowIds.push(previous.id);
        }
      }
    }
    contextWindowIds.push(retrievalId);
    if (
      primary.nextRetrievalId !== null
    ) {
      const nextKey = createActiveProjectionKey(
        target.documentId,
        target.generationId,
        primary.nextRetrievalId,
        target.sourceFile,
      );
      const next = selectedKeys.has(nextKey)
        ? undefined
        : neighborByKey.get(nextKey);
      if (next !== undefined) {
        following = readFollowingContext(
          next.evidenceContent,
          item.evidenceContent,
        );
        if (following !== null) {
          contextWindowIds.push(next.id);
        }
      }
    }
    if (preceding === null && following === null) {
      contextualized.push(item);
      continue;
    }
    contextualized.push({
      ...item,
      adjacentContext: {
        following,
        preceding,
        retrievalWindowIds: contextWindowIds,
      },
    });
  }
  return contextualized;
}

function readPrecedingContext(
  candidate: string,
  primary: string,
): string | null {
  const normalized = candidate.trim();
  if (
    normalized === ""
    || primary.includes(normalized)
    || normalized === primary.trim()
  ) {
    return null;
  }
  const overlapLength = readBoundaryOverlapLength(normalized, primary.trim());
  const context = normalized.slice(0, normalized.length - overlapLength).trim();
  return context === "" ? null : context;
}

function readFollowingContext(
  candidate: string,
  primary: string,
): string | null {
  const normalized = candidate.trim();
  if (
    normalized === ""
    || primary.includes(normalized)
    || normalized === primary.trim()
  ) {
    return null;
  }
  const overlapLength = readBoundaryOverlapLength(primary.trim(), normalized);
  const context = normalized.slice(overlapLength).trim();
  return context === "" ? null : context;
}

function readBoundaryOverlapLength(left: string, right: string): number {
  const maximumLength = Math.min(left.length, right.length);
  for (let length = maximumLength; length > 0; length -= 1) {
    if (left.endsWith(right.slice(0, length))) {
      return length;
    }
  }
  return 0;
}

function readStrongestRerankerScore(
  ranking: readonly { relevanceScore: number }[],
): number | null {
  let strongestScore: number | null = null;
  for (const entry of ranking) {
    if (strongestScore === null || entry.relevanceScore > strongestScore) {
      strongestScore = entry.relevanceScore;
    }
  }
  return strongestScore;
}

export function selectRerankingCandidates(
  question: string,
  rankedCandidates: FusedCandidate[],
  limit: number,
): FusedCandidate[] {
  return selectRerankingCandidatesWithTrace(
    question,
    rankedCandidates,
    limit,
  ).selected;
}

export function selectRerankingCandidatesWithTrace(
  _question: string,
  rankedCandidates: FusedCandidate[],
  limit: number,
): NonOverlappingCandidateSelection {
  return selectNonOverlappingCandidatesWithTrace(
    rankedCandidates,
    limit,
    "fused-order",
  );
}

export async function queryRetrievalCandidateRankings(
  database: CiteLoomDatabase,
  queryExecutor: SqlQueryExecutor,
  space: EmbeddingSpaceConfig,
  queries: RetrievalQuery[],
  config: RetrievalConfig,
  scopeTargets: ResolvedQueryScopeTarget[],
  abortSignal: AbortSignal,
  runTelemetry: RunTelemetry = noopRunTelemetry,
): Promise<RetrievalCandidateRankings> {
  const pendingResults: Array<Promise<{
    dense: DenseCandidate[];
    lexical: LexicalCandidate[];
  }>> = [];
  for (const query of queries) {
    abortSignal.throwIfAborted();
    const pendingResult = queryRetrievalCandidates(
      database,
      queryExecutor,
      space,
      query,
      config,
      scopeTargets,
      abortSignal,
      runTelemetry,
    ).then(decodeRetrievalCandidateRankings);
    pendingResults.push(pendingResult);
  }
  const results = await Promise.all(pendingResults);
  const denseRankings: DenseCandidate[][] = [];
  const lexicalRankings: LexicalCandidate[][] = [];
  for (const result of results) {
    denseRankings.push(result.dense);
    lexicalRankings.push(result.lexical);
  }
  return { dense: denseRankings, lexical: lexicalRankings };
}

function decodeRetrievalCandidateRankings(
  rows: RetrievalCandidateRows,
): { dense: DenseCandidate[]; lexical: LexicalCandidate[] } {
  const lexical: LexicalCandidate[] = [];
  for (const candidate of rows.lexical) {
    if (candidate.bm25Score > 0) {
      lexical.push(candidate);
    }
  }
  return { dense: rows.dense, lexical };
}

export function rankRetrievalCandidates(
  mode: RetrievalMode,
  rankings: RetrievalCandidateRankings,
  rrfK: number,
  fusion: RankFusionConfig,
  supplementalRankings: readonly WeightedRanking[] = [],
): FusedCandidate[] {
  const baseRankings = readActiveRankings(
    mode,
    rankings.dense,
    rankings.lexical,
    fusion,
  );
  const activeRankings = [...baseRankings, ...supplementalRankings];
  let maximumCandidateCount = 0;
  for (const ranking of activeRankings) {
    maximumCandidateCount += ranking.candidates.length;
  }
  const fusionLimit = Math.max(1, maximumCandidateCount);
  return fuseRankedCandidates(activeRankings, rrfK, fusionLimit);
}

export function selectPreparedRetrievalCandidates(
  mode: RetrievalMode,
  _question: string,
  rankings: RetrievalCandidateRankings,
  candidateK: number,
  topK: number,
  rrfK: number,
  fusion: RankFusionConfig,
): FusedCandidate[] {
  const ranked = rankRetrievalCandidates(mode, rankings, rrfK, fusion);
  const admission = selectNonOverlappingCandidatesWithTrace(
    ranked,
    candidateK,
    "fused-order",
  );
  const candidates = admission.selected;
  return selectTopCandidates(candidates, topK);
}

export function selectPreparedRerankingCandidatesWithTrace(
  question: string,
  rankings: RetrievalCandidateRankings,
  candidateK: number,
  rrfK: number,
  fusion: RankFusionConfig,
): NonOverlappingCandidateSelection {
  const ranked = rankRetrievalCandidates(
    "hybrid",
    rankings,
    rrfK,
    fusion,
  );
  return selectRerankingCandidatesWithTrace(question, ranked, candidateK);
}

export async function loadRetrievalCandidates(
  database: CiteLoomDatabase,
  documentStore: SourceDocumentStore,
  candidatesToLoad: FusedCandidate[],
  scopeTargets: ResolvedQueryScopeTarget[],
): Promise<RetrievedElement[]> {
  const loaded = await loadRetrievalCandidatesWithMetadata(
    database,
    documentStore,
    candidatesToLoad,
    scopeTargets,
  );
  return loaded.retrieved;
}

interface LoadedRetrievalCandidates {
  candidates: FusedCandidate[];
  retrieved: RetrievedElement[];
}

async function loadRetrievalCandidatesWithMetadata(
  database: CiteLoomDatabase,
  documentStore: SourceDocumentStore,
  candidatesToLoad: FusedCandidate[],
  scopeTargets: ResolvedQueryScopeTarget[],
): Promise<LoadedRetrievalCandidates> {
  const targetKeys = buildResolvedScopeTargetKeys(scopeTargets);
  const scopedCandidates: FusedCandidate[] = [];
  for (const candidate of candidatesToLoad) {
    const candidateKey = createDiscoveryDocumentKey(
      candidate.documentId,
      candidate.sourceFile,
    );
    if (targetKeys.has(candidateKey)) {
      scopedCandidates.push(candidate);
    }
  }
  if (scopedCandidates.length === 0) {
    return { candidates: [], retrieved: [] };
  }
  const candidateTargets: ResolvedQueryScopeTarget[] = [];
  const scopeTargetsByDocument = new Map<string, ResolvedQueryScopeTarget>();
  for (const target of scopeTargets) {
    const targetKey = createDiscoveryDocumentKey(
      target.documentId,
      target.sourceFile,
    );
    scopeTargetsByDocument.set(targetKey, target);
  }
  for (const candidate of scopedCandidates) {
    const candidateKey = createDiscoveryDocumentKey(
      candidate.documentId,
      candidate.sourceFile,
    );
    const target = scopeTargetsByDocument.get(candidateKey);
    if (target !== undefined) {
      candidateTargets.push(target);
    }
  }
  const versionRows = await database
    .select({
      documentId: indexedDocuments.documentId,
      sourceFile: indexedDocuments.sourceFile,
      versionId: indexedDocuments.versionId,
    })
    .from(indexedDocuments)
    .innerJoin(
      indexedDocumentSpaces,
      and(
        eq(indexedDocumentSpaces.documentId, indexedDocuments.documentId),
        eq(indexedDocumentSpaces.sourceFile, indexedDocuments.sourceFile),
      ),
    )
    .where(matchesResolvedQueryScope(
      indexedDocumentSpaces.documentId,
      indexedDocumentSpaces.generationId,
      indexedDocumentSpaces.sourceFile,
      candidateTargets,
    ));
  const versionIds = new Map<string, string>();
  for (const row of versionRows) {
    versionIds.set(`${row.documentId}\0${row.sourceFile}`, row.versionId);
  }
  const activeCandidates: Array<{
    candidate: FusedCandidate;
    versionId: string;
  }> = [];
  for (const candidate of scopedCandidates) {
    const versionId = versionIds.get(
      `${candidate.documentId}\0${candidate.sourceFile}`,
    );
    if (versionId === undefined) {
      continue;
    }
    activeCandidates.push({ candidate, versionId });
  }
  const parentIds = activeCandidates.map((entry) => entry.candidate.parentId);
  const elements = await documentStore.readManyForRetrieval(parentIds);
  const retrieved: RetrievedElement[] = [];
  for (let index = 0; index < activeCandidates.length; index += 1) {
    const activeCandidate = activeCandidates[index];
    const element = elements[index];
    if (activeCandidate === undefined || element === undefined) {
      throw new Error(`Incomplete retrieval result at index ${index}.`);
    }
    const row = activeCandidate.candidate;
    const canonicalElement = replaceSourceFile(element, row.sourceFile);
    const evidenceContent = row.evidenceContent;
    retrieved.push({
      distance: row.denseDistance,
      documentVersionId: activeCandidate.versionId,
      element: canonicalElement,
      evidenceContent,
      provenance: {
        evidenceSha256: createHash("sha256")
          .update(evidenceContent)
          .digest("hex"),
        representationHits: row.representationHits,
        retrievalWindowId: row.retrievalId,
        descriptionAffected: row.descriptionAffected,
      },
    });
  }
  return {
    candidates: activeCandidates.map((entry) => entry.candidate),
    retrieved,
  };
}

function buildRerankerCandidateIdentities(
  candidates: readonly FusedCandidate[],
  retrieved: readonly RetrievedElement[],
): RerankerCandidateIdentity[] {
  if (candidates.length !== retrieved.length) {
    throw new Error(
      "Hydrated candidate identity count does not match the reranker input.",
    );
  }
  const identities: RerankerCandidateIdentity[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const item = retrieved[index];
    if (candidate === undefined || item === undefined) {
      throw new Error(`Incomplete reranker input at index ${index}.`);
    }
    identities.push({
      documentId: candidate.documentId,
      documentVersionId: item.documentVersionId,
      elementId: candidate.parentId,
      representativeRetrievalWindowId: candidate.retrievalId,
      sourceFile: candidate.sourceFile,
    });
  }
  return identities;
}

function buildContextSelectionCandidates(
  candidateBudget: CandidateBudgetTelemetry,
  candidates: readonly FusedCandidate[],
  retrieved: readonly RetrievedElement[],
  selection: PostRerankCandidateSelection<RetrievedElement>,
): ContextSelectionCandidateTelemetry[] {
  const admissionByWindowId = new Map(
    candidateBudget.admittedCandidates.map((candidate) => (
      [candidate.retrievalWindowId, candidate] as const
    )),
  );
  const records: ContextSelectionCandidateTelemetry[] = [];
  for (const decision of selection.decisions) {
    const ranked = decision.candidate;
    const inputIndex = ranked.rerankerInputRank - 1;
    const candidate = candidates[inputIndex];
    const item = retrieved[inputIndex];
    if (candidate === undefined || item === undefined) {
      throw new Error(
        `Incomplete reranker telemetry candidate at rank ${ranked.rerankerRank}.`,
      );
    }
    const admission = admissionByWindowId.get(candidate.retrievalId);
    if (admission?.rerankerInputRank === null || admission === undefined) {
      throw new Error(
        `Reranker candidate ${candidate.retrievalId} has no hydrated admission.`,
      );
    }
    const finalContextRank = decision.selectedContextRank;
    records.push({
      documentId: candidate.documentId,
      documentVersionId: item.documentVersionId,
      evidenceSha256: item.provenance.evidenceSha256,
      finalContextRank,
      fusedRank: admission.fusedRank,
      fusion: {
        bm25Score: candidate.bm25Score,
        denseDistance: candidate.denseDistance,
        fusedScore: candidate.fusedScore,
      },
      parentElementId: candidate.parentId,
      rerankerInputRank: admission.rerankerInputRank,
      reason: readContextSelectionReason(
        decision.exclusionReason,
        selection.cutoff.reason,
      ),
      representationHits: candidate.representationHits,
      rerankerRank: ranked.rerankerRank,
      rerankerScore: ranked.relevanceScore,
      retrievalWindowId: candidate.retrievalId,
      selected: finalContextRank !== null,
      sourceFile: candidate.sourceFile,
      descriptionAffected: candidate.descriptionAffected,
    });
  }
  return records;
}

function readContextSelectionReason(
  exclusionReason:
    | "duplicate-evidence"
    | "maximum-context"
    | "relevance-cliff"
    | null,
  selectionReason: "maximum-context" | "relevance-cliff",
): ContextSelectionCandidateTelemetry["reason"] {
  if (exclusionReason === null) {
    return selectionReason;
  }
  if (exclusionReason === "duplicate-evidence") {
    return "duplicate-evidence";
  }
  if (exclusionReason === "relevance-cliff") {
    return "relevance-cliff-tail";
  }
  return "maximum-context-limit";
}

export async function retrieveKeywordDiscoveryPage(
  queryExecutor: SqlQueryExecutor,
  documentStore: SourceDocumentStore,
  query: string,
  embeddingSpaceId: string,
  scopeTargets: ResolvedQueryScopeTarget[],
  page: number,
  pageSize: number,
  passagesPerDocument: number,
): Promise<KeywordDiscoveryPage> {
  const offset = (page - 1) * pageSize;
  const scopeColumns = splitResolvedQueryScopeTargets(scopeTargets);
  const rows = await queryExecutor.execute("retrieve-keyword-discovery", [
    query,
    embeddingSpaceId,
    scopeColumns.documentIds,
    scopeColumns.generationIds,
    scopeColumns.sourceFiles,
    pageSize,
    offset,
    passagesPerDocument,
  ]);
  const result = keywordDiscoveryResultSchema.safeParse(rows[0]);
  if (!result.success) {
    throw new Error(`Invalid keyword discovery rows: ${result.error.message}`);
  }

  const targetKeys = buildResolvedScopeTargetKeys(scopeTargets);
  const parentIds: string[] = [];
  for (const row of result.data.result.matches) {
    const rowKey = createDiscoveryDocumentKey(row.documentId, row.sourceFile);
    if (!targetKeys.has(rowKey)) {
      throw new Error(
        `Keyword discovery returned source outside the resolved scope: ${row.sourceFile}.`,
      );
    }
    parentIds.push(row.parentId);
  }
  const elements = await documentStore.readMany(parentIds);
  const matches: KeywordDiscoveryMatch[] = [];
  for (let index = 0; index < result.data.result.matches.length; index += 1) {
    const row = result.data.result.matches[index];
    const element = elements[index];
    if (row === undefined || element === undefined) {
      throw new Error(`Incomplete keyword discovery result at index ${index}.`);
    }
    if (element.documentId !== row.documentId) {
      throw new Error(
        `Keyword discovery metadata differs for source element ${row.parentId}.`,
      );
    }
    matches.push({
      element: replaceSourceFile(element, row.sourceFile),
      evidenceContent: row.evidenceContent,
      matchingPassageCount: row.matchingPassageCount,
    });
  }
  return {
    matches,
    totalDocuments: result.data.result.totalDocuments,
  };
}

export async function readKeywordMatchingDocumentKeys(
  queryExecutor: SqlQueryExecutor,
  query: string,
  embeddingSpaceId: string,
  scopeTargets: ResolvedQueryScopeTarget[],
): Promise<Set<string>> {
  if (scopeTargets.length === 0) {
    return new Set();
  }
  const scopeColumns = splitResolvedQueryScopeTargets(scopeTargets);
  const rows = await queryExecutor.execute("match-keyword-documents", [
    query,
    embeddingSpaceId,
    scopeColumns.documentIds,
    scopeColumns.generationIds,
    scopeColumns.sourceFiles,
  ]);
  const targetKeys = buildResolvedScopeTargetKeys(scopeTargets);
  const documentKeys = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    const result = keywordDocumentRowSchema.safeParse(rows[index]);
    if (!result.success) {
      throw new Error(
        `Invalid keyword document row ${index + 1}: ${result.error.message}`,
      );
    }
    const documentKey = createDiscoveryDocumentKey(
      result.data.documentId,
      result.data.sourceFile,
    );
    if (!targetKeys.has(documentKey)) {
      throw new Error(
        `Keyword matching returned source outside the resolved scope: ${result.data.sourceFile}.`,
      );
    }
    documentKeys.add(documentKey);
  }
  return documentKeys;
}

function buildResolvedScopeTargetKeys(
  scopeTargets: readonly ResolvedQueryScopeTarget[],
): Set<string> {
  const targetKeys = new Set<string>();
  for (const target of scopeTargets) {
    targetKeys.add(createDiscoveryDocumentKey(
      target.documentId,
      target.sourceFile,
    ));
  }
  return targetKeys;
}

export function retrievalModeUsesDense(mode: RetrievalMode): boolean {
  return mode !== "bm25";
}

function retrievalModeUsesLexical(mode: RetrievalMode): boolean {
  return mode !== "dense";
}

async function queryRetrievalCandidates(
  database: CiteLoomDatabase,
  queryExecutor: SqlQueryExecutor,
  space: EmbeddingSpaceConfig,
  query: RetrievalQuery,
  config: RetrievalConfig,
  scopeTargets: ResolvedQueryScopeTarget[],
  abortSignal: AbortSignal,
  runTelemetry: RunTelemetry,
): Promise<RetrievalCandidateRows> {
  let denseRowsPromise: Promise<DenseCandidate[]> = Promise.resolve([]);
  if (retrievalModeUsesDense(config.mode)) {
    if (query.embedding === null) {
      throw new Error(`Retrieval mode ${config.mode} requires a query embedding.`);
    }
    const normalizedEmbedding = readEmbedding(
      query.embedding,
      space.dimensions,
      "query embedding",
    );
    const denseStage = runTelemetry.startStage({
      model: null,
      name: "dense-retrieval",
      retrievalMode: config.mode,
    });
    denseRowsPromise = runCandidateQueryStage(
      denseStage,
      scopeTargets.length,
      () => runRetrievalDatabaseOperation(
        queryExecutor,
        database,
        abortSignal,
        (operationDatabase) => queryDenseRepresentationCandidates(
          operationDatabase,
          space,
          normalizedEmbedding,
          config.candidateK,
          scopeTargets,
          abortSignal,
        ),
      ),
    );
  }

  let lexicalRowsPromise: Promise<LexicalCandidate[]> = Promise.resolve([]);
  if (retrievalModeUsesLexical(config.mode)) {
    const lexicalStage = runTelemetry.startStage({
      model: null,
      name: "lexical-retrieval",
      retrievalMode: config.mode,
    });
    lexicalRowsPromise = runCandidateQueryStage(
      lexicalStage,
      scopeTargets.length,
      () => queryLexicalRepresentationCandidates(
        queryExecutor,
        space,
        query.text,
        scopeTargets,
        config.candidateK,
        abortSignal,
      ),
    );
  }
  const [dense, lexical] = await Promise.all([
    denseRowsPromise,
    lexicalRowsPromise,
  ]);
  return { dense, lexical };
}

function runRetrievalDatabaseOperation<Result>(
  queryExecutor: SqlQueryExecutor,
  database: CiteLoomDatabase,
  abortSignal: AbortSignal,
  operation: (operationDatabase: CiteLoomDatabase) => Promise<Result>,
): Promise<Result> {
  if (queryExecutor.withDatabase === undefined) {
    abortSignal.throwIfAborted();
    return operation(database);
  }
  return queryExecutor.withDatabase(operation, {
    abortSignal,
    statementTimeoutMs: RETRIEVAL_STATEMENT_TIMEOUT_MS,
  });
}

async function runCandidateQueryStage<
  Candidate extends DenseCandidate | LexicalCandidate,
>(
  stage: TelemetryStage,
  inputCount: number,
  query: () => Promise<Candidate[]>,
): Promise<Candidate[]> {
  try {
    const rows = await query();
    await stage.finish(createTelemetryStageResult("success", {
      inputCount,
      outputCount: rows.length,
    }));
    return rows;
  } catch (error: unknown) {
    await stage.finish(createTelemetryStageResult("error", { inputCount }));
    throw error;
  }
}

function countRankedCandidates(rankings: RetrievalCandidateRankings): number {
  let count = 0;
  for (const ranking of rankings.dense) {
    count += ranking.length;
  }
  for (const ranking of rankings.lexical) {
    count += ranking.length;
  }
  return count;
}

function readActiveRankings(
  mode: RetrievalMode,
  denseRankings: DenseCandidate[][],
  lexicalRankings: LexicalCandidate[][],
  fusion: RankFusionConfig,
): WeightedRanking[] {
  const isHybrid = mode === "hybrid";
  if (isHybrid && denseRankings.length !== lexicalRankings.length) {
    throw new Error(
      "Hybrid retrieval requires one dense and lexical ranking per query.",
    );
  }
  const rankings: WeightedRanking[] = [];
  const queryCount = mode === "bm25"
    ? lexicalRankings.length
    : denseRankings.length;
  for (let queryIndex = 0; queryIndex < queryCount; queryIndex += 1) {
    const queryWeight = readQueryWeight(queryIndex, fusion);
    if (mode !== "bm25") {
      const dense = denseRankings[queryIndex];
      if (dense === undefined) {
        throw new Error(`Dense ranking ${queryIndex + 1} is missing.`);
      }
      rankings.push({
        candidates: dense,
        channel: "dense",
        queryIndex,
        weight: fusion.denseWeight * queryWeight,
      });
    }
    if (mode !== "dense") {
      const lexical = lexicalRankings[queryIndex];
      if (lexical === undefined) {
        throw new Error(`Lexical ranking ${queryIndex + 1} is missing.`);
      }
      rankings.push({
        candidates: lexical,
        channel: "lexical",
        queryIndex,
        weight: fusion.lexicalWeight * queryWeight,
      });
    }
  }
  return rankings;
}

function readQueryWeight(
  queryIndex: number,
  fusion: RankFusionConfig,
): number {
  if (queryIndex === 0) {
    return fusion.originalQueryWeight;
  }
  return fusion.expansionQueryWeight * (fusion.expansionDecay ** (queryIndex - 1));
}

async function queryDenseRepresentationCandidates(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
  embedding: number[],
  candidateK: number,
  scopeTargets: ResolvedQueryScopeTarget[],
  abortSignal: AbortSignal,
): Promise<DenseCandidate[]> {
  const search = new CandidateBudgetSearch(candidateK, scopeTargets.length);
  while (true) {
    abortSignal.throwIfAborted();
    const rawRows = await queryDenseCandidates(
      database,
      space,
      embedding,
      search.rawLimit,
      scopeTargets,
      search.strategy,
    );
    abortSignal.throwIfAborted();
    const decodedRows = decodeRows(
      denseRetrievalRowSchema,
      rawRows,
      "dense retrieval",
    );
    const rows = filterRowsToResolvedScope(decodedRows, scopeTargets);
    const candidates = await buildDenseRepresentationCandidates(
      database,
      space,
      embedding,
      scopeTargets,
      rows,
    );
    const selected = selectStrongestRepresentations(candidates, candidateK);
    if (!search.advance(rawRows.length, selected.length)) {
      return selected;
    }
  }
}

async function buildDenseRepresentationCandidates(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
  embedding: number[],
  scopeTargets: ResolvedQueryScopeTarget[],
  rows: DenseRetrievalRow[],
): Promise<DenseCandidate[]> {
  const descriptionMetadata: DescriptionDenseRetrievalRow[] = [];
  for (const row of rows) {
    if (row.representationType !== "exact-window") {
      descriptionMetadata.push(row);
    }
  }
  const evidenceByParent = await resolveDenseExactEvidence(
    database,
    space,
    embedding,
    scopeTargets,
    descriptionMetadata,
  );
  const candidates: DenseCandidate[] = [];
  for (const row of rows) {
    if (row.representationType === "exact-window") {
      candidates.push({
        distance: row.distance,
        documentId: row.documentId,
        evidenceContent: row.evidenceContent,
        evidenceRetrievalId: row.evidenceRetrievalId,
        parentId: row.parentId,
        representation: buildExactRepresentation(row),
        sourceFile: row.sourceFile,
      });
      continue;
    }
    const evidence = readDescriptionEvidence(row, evidenceByParent);
    candidates.push({
      distance: row.distance,
      documentId: row.documentId,
      evidenceContent: evidence.evidenceContent,
      evidenceRetrievalId: evidence.evidenceRetrievalId,
      parentId: row.parentId,
      representation: buildDescriptionCandidateRepresentation(row),
      sourceFile: row.sourceFile,
    });
  }
  return candidates;
}

async function queryLexicalRepresentationCandidates(
  queryExecutor: SqlQueryExecutor,
  space: EmbeddingSpaceConfig,
  question: string,
  scopeTargets: ResolvedQueryScopeTarget[],
  candidateK: number,
  abortSignal: AbortSignal,
): Promise<LexicalCandidate[]> {
  const search = new CandidateBudgetSearch(candidateK, scopeTargets.length);
  while (true) {
    abortSignal.throwIfAborted();
    const rawRows = await queryLexicalCandidateBatch(
      queryExecutor,
      space.id,
      question,
      scopeTargets,
      search.rawLimit,
      search.strategy,
      abortSignal,
    );
    abortSignal.throwIfAborted();
    const decodedRows = decodeRows(
      lexicalRetrievalRowSchema,
      rawRows,
      "lexical retrieval",
    );
    const rows = filterRowsToResolvedScope(decodedRows, scopeTargets);
    const candidates: LexicalCandidate[] = [];
    for (const row of rows) {
      if (row.bm25Score <= 0) {
        continue;
      }
      const representation = row.representationType === "exact-window"
        ? buildExactRepresentation(row)
        : buildDescriptionCandidateRepresentation(row);
      candidates.push({
        bm25Score: row.bm25Score,
        documentId: row.documentId,
        evidenceContent: row.evidenceContent,
        evidenceRetrievalId: row.evidenceRetrievalId,
        parentId: row.parentId,
        representation,
        sourceFile: row.sourceFile,
      });
    }
    const selected = selectStrongestRepresentations(candidates, candidateK);
    if (!search.advance(rawRows.length, selected.length)) {
      return selected;
    }
  }
}

function queryLexicalCandidateBatch(
  queryExecutor: SqlQueryExecutor,
  embeddingSpaceId: string,
  question: string,
  scopeTargets: ResolvedQueryScopeTarget[],
  rawLimit: number,
  strategy: RetrievalSearchStrategy,
  abortSignal: AbortSignal,
): Promise<unknown[]> {
  if (strategy === "indexed") {
    return queryExecutor.execute("retrieve-indexed-lexical-candidates", [
      question,
      embeddingSpaceId,
      rawLimit,
    ], {
      abortSignal,
      statementTimeoutMs: RETRIEVAL_STATEMENT_TIMEOUT_MS,
    });
  }
  const scopeColumns = splitResolvedQueryScopeTargets(scopeTargets);
  return queryExecutor.execute("retrieve-lexical-candidates", [
    question,
    embeddingSpaceId,
    scopeColumns.documentIds,
    scopeColumns.generationIds,
    scopeColumns.sourceFiles,
    rawLimit,
  ], {
    abortSignal,
    statementTimeoutMs: RETRIEVAL_STATEMENT_TIMEOUT_MS,
  });
}

function filterRowsToResolvedScope<
  Row extends {
    documentId: string;
    generationId: string;
    sourceFile: string;
  },
>(
  rows: readonly Row[],
  scopeTargets: readonly ResolvedQueryScopeTarget[],
): Row[] {
  const scopeIdentities = new Set<string>();
  for (const target of scopeTargets) {
    scopeIdentities.add(createResolvedQueryScopeTargetKey(target));
  }
  const scopedRows: Row[] = [];
  for (const row of rows) {
    const identity = createResolvedQueryScopeTargetKey(row);
    if (scopeIdentities.has(identity)) {
      scopedRows.push(row);
    }
  }
  return scopedRows;
}

function buildExactRepresentation(row: {
  representationContent: string;
  representationId: string;
}): {
  content: string;
  id: string;
  type: "exact-window";
} {
  return {
    content: row.representationContent,
    id: row.representationId,
    type: "exact-window",
  };
}

function buildDescriptionCandidateRepresentation(row: {
  representationContent: string;
  representationId: string;
  representationType: Exclude<RetrievalRepresentationType, "exact-window">;
}): {
  content: string;
  id: string;
  type: "image-description" | "table-description";
} {
  return {
    content: row.representationContent,
    id: row.representationId,
    type: row.representationType,
  };
}

type ExactEvidenceRow = z.output<typeof exactEvidenceRowSchema>;

async function resolveDenseExactEvidence(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
  embedding: number[],
  scopeTargets: ResolvedQueryScopeTarget[],
  descriptionRows: readonly {
    documentId: string;
    kind: "image" | "table";
    parentId: string;
    representationType: Exclude<RetrievalRepresentationType, "exact-window">;
    sourceFile: string;
  }[],
): Promise<Map<string, ExactEvidenceRow>> {
  const parentIds: string[] = [];
  for (const row of descriptionRows) {
    if (row.representationType === "image-description") {
      continue;
    }
    parentIds.push(row.parentId);
  }
  const rawEvidence = await queryDenseEvidenceCandidates(
    database,
    space,
    embedding,
    scopeTargets,
    parentIds,
  );
  const evidenceRows = decodeRows(
    exactEvidenceRowSchema,
    rawEvidence,
    "description exact-evidence resolution",
  );
  const evidenceByParent = new Map<string, ExactEvidenceRow>();
  for (const row of evidenceRows) {
    const parentKey = createRepresentationParentKey(row);
    if (!evidenceByParent.has(parentKey)) {
      evidenceByParent.set(parentKey, row);
    }
  }
  return evidenceByParent;
}

function readDescriptionEvidence(
  description: {
    documentId: string;
    kind: "image" | "table";
    parentId: string;
    representationContent: string;
    representationType: Exclude<RetrievalRepresentationType, "exact-window">;
    sourceFile: string;
  },
  evidenceByParent: ReadonlyMap<string, ExactEvidenceRow>,
): ExactEvidenceRow {
  if (description.representationType === "image-description") {
    return {
      distance: 0,
      documentId: description.documentId,
      evidenceContent: description.representationContent,
      evidenceRetrievalId: description.parentId,
      parentId: description.parentId,
      sourceFile: description.sourceFile,
    };
  }
  const parentKey = createRepresentationParentKey(description);
  const evidence = evidenceByParent.get(parentKey);
  if (evidence === undefined) {
    throw new Error(
      `Description representation for ${description.parentId} has no exact evidence.`,
    );
  }
  return evidence;
}

function selectStrongestRepresentations<
  Candidate extends DenseCandidate | LexicalCandidate,
>(
  ranking: readonly Candidate[],
  candidateK: number,
): Candidate[] {
  const selected: Candidate[] = [];
  const selectedEvidence = new Set<string>();
  for (const candidate of ranking) {
    const evidenceKey = createRepresentationEvidenceKey(candidate);
    if (selectedEvidence.has(evidenceKey)) {
      continue;
    }
    selectedEvidence.add(evidenceKey);
    selected.push(candidate);
    if (selected.length === candidateK) {
      break;
    }
  }
  return selected;
}

function createRepresentationEvidenceKey(candidate: {
  documentId: string;
  evidenceRetrievalId: string;
  sourceFile: string;
}): string {
  return [
    candidate.documentId,
    candidate.sourceFile,
    candidate.evidenceRetrievalId,
  ].join("\0");
}

function createRepresentationParentKey(candidate: {
  documentId: string;
  parentId: string;
  sourceFile: string;
}): string {
  return [
    candidate.documentId,
    candidate.sourceFile,
    candidate.parentId,
  ].join("\0");
}

function decodeRows<Output>(
  schema: z.ZodType<Output>,
  rows: unknown[],
  label: string,
): Output[] {
  const decoded: Output[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const result = schema.safeParse(rows[index]);
    if (!result.success) {
      throw new Error(
        `Invalid ${label} row ${index + 1}: ${result.error.message}`,
      );
    }
    decoded.push(result.data);
  }
  return decoded;
}

function replaceSourceFile<Element extends RetrievalSourceElement>(
  element: Element,
  sourceFile: string,
): Element {
  return { ...element, sourceFile };
}
