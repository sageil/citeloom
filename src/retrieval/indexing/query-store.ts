import { createHash } from "node:crypto";

import { z } from "zod";

import { mapWithConcurrency, type TaskScheduler } from "../../shared/concurrency.js";
import type {
  EmbeddingSpaceConfig,
  RankFusionConfig,
  RetrievalConfig,
  RetrievalMode,
} from "../../config/index.js";
import type { CiteLoomDatabase, SqlQueryExecutor } from "../../database/client.js";
import { indexedDocuments } from "../../database/schema.js";
import {
  createCandidateParentKey,
  selectNonOverlappingCandidatesWithTrace,
  selectSourceDiverseCandidates,
  selectSourceDiverseElements,
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
import { queryDenseCandidates } from "./vector-query-store.js";
import {
  queryDenseEvidenceCandidates,
  queryDenseDescriptionCandidates,
} from "./vector-query-store.js";
import {
  createTelemetryStageResult,
  noopRunTelemetry,
  readTelemetryFailureOutcome,
  type RunTelemetry,
  type TelemetryStage,
  type CandidateBudgetAdmissionTelemetry,
  type CandidateBudgetChannelTelemetry,
  type CandidateBudgetQueryTelemetry,
  type CandidateBudgetTelemetry,
  type ContextSelectionCandidateTelemetry,
} from "../../observability/run.js";
import { answerContextSelectionConfig } from "../ranking/context-selection.js";
import { CHANNEL_ORDERING_POLICY } from "../ranking/channel-ordering.js";
import {
  createDiscoveryDocumentKey,
  type KeywordDiscoveryMatch,
  type KeywordDiscoveryPage,
} from "../discovery/model.js";
import type { SourceDocumentStore } from "../../documents/storage/source-document-store.js";
import {
  splitResolvedQueryScopeTargets,
  type ResolvedQueryScopeTarget,
} from "../../domain/query-scope.js";
import { contentIdSchema } from "../../domain/validation.js";
import type {
  RetrievalRepresentationType,
} from "../representations.js";

const passiveAbortSignal = new AbortController().signal;
const retrievalIdentifierSchema = z.string().regex(
  /^[a-f0-9]{64}(?:-description)?$/u,
);
const exactDenseRetrievalRowSchema = z.object({
  distance: z.number().finite().nonnegative(),
  documentId: contentIdSchema,
  evidenceContent: z.string().min(1),
  evidenceRetrievalId: retrievalIdentifierSchema,
  kind: z.enum(["table", "text"]),
  parentId: contentIdSchema,
  representationContent: z.string().min(1),
  representationId: retrievalIdentifierSchema,
  sourceFile: z.string().min(1),
});
const exactLexicalRetrievalRowSchema = z.object({
  bm25Score: z.number().finite().nonnegative(),
  documentId: contentIdSchema,
  evidenceContent: z.string().min(1),
  evidenceRetrievalId: retrievalIdentifierSchema,
  kind: z.enum(["table", "text"]),
  parentId: contentIdSchema,
  representationContent: z.string().min(1),
  representationId: retrievalIdentifierSchema,
  sourceFile: z.string().min(1),
});
const descriptionDenseRetrievalRowBase = {
  distance: z.number().finite().nonnegative(),
  documentId: contentIdSchema,
  parentId: contentIdSchema,
  representationContent: z.string().min(1),
  representationId: retrievalIdentifierSchema,
  sourceFile: z.string().min(1),
};
const descriptionDenseRetrievalRowSchema = z.discriminatedUnion("kind", [
  z.object({
    ...descriptionDenseRetrievalRowBase,
    kind: z.literal("table"),
  }),
  z.object({
    ...descriptionDenseRetrievalRowBase,
    kind: z.literal("image"),
  }),
]);
const descriptionLexicalRetrievalRowBase = {
  bm25Score: z.number().finite().nonnegative(),
  documentId: contentIdSchema,
  evidenceContent: z.string().min(1),
  evidenceRetrievalId: retrievalIdentifierSchema,
  parentId: contentIdSchema,
  representationContent: z.string().min(1),
  representationId: retrievalIdentifierSchema,
  sourceFile: z.string().min(1),
};
const descriptionLexicalRetrievalRowSchema = z.discriminatedUnion("kind", [
  z.object({
    ...descriptionLexicalRetrievalRowBase,
    kind: z.literal("table"),
  }),
  z.object({
    ...descriptionLexicalRetrievalRowBase,
    kind: z.literal("image"),
  }),
]);
const exactEvidenceRowSchema = z.object({
  distance: z.number().finite().nonnegative(),
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

export interface RetrievalCandidateRankings {
  dense: DenseCandidate[][];
  lexical: LexicalCandidate[][];
}

export interface RetrievalQuery {
  embedding: number[] | null;
  text: string;
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
  const candidateSelection = config.mode === "hybrid-reranked"
    ? selectRerankingCandidatesWithTrace(
      originalQuestion,
      rankedCandidates,
      config.candidateK,
    )
    : selectNonOverlappingCandidatesWithTrace(
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
  if (config.mode !== "hybrid-reranked") {
    const selected = selectSourceDiverseElements(retrieved, config.topK);
    runTelemetry.setHydratedContextCount(selected.length);
    return {
      rerankerModelId: null,
      retrieved: selected,
      strongestRerankerScore: null,
    };
  }
  if (config.reranker === null) {
    throw new Error("Hybrid reranking requires a configured reranker.");
  }
  if (reranker === null) {
    throw new Error("The configured reranker model was not resolved.");
  }
  if (rerankerScheduler === null) {
    throw new Error("Hybrid reranking requires an inference scheduler.");
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
    return {
      rerankerModelId: reranker.model.modelId,
      retrieved: reranked.retrieved,
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
  const results = await mapRetrievalVariants(
    queries,
    config.variantConcurrency,
    abortSignal,
    async (query) => {
      const rows = await queryRetrievalCandidates(
        database,
        queryExecutor,
        space,
        query,
        config,
        scopeTargets,
        runTelemetry,
      );
      return decodeRetrievalCandidateRankings(rows);
    },
  );
  const denseRankings: DenseCandidate[][] = [];
  const lexicalRankings: LexicalCandidate[][] = [];
  for (const result of results) {
    denseRankings.push(result.dense);
    lexicalRankings.push(result.lexical);
  }
  return { dense: denseRankings, lexical: lexicalRankings };
}

export async function mapRetrievalVariants<Input, Output>(
  inputs: readonly Input[],
  concurrency: number,
  abortSignal: AbortSignal,
  retrieve: (input: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  return mapWithConcurrency(inputs, concurrency, async (input, index) => {
    abortSignal.throwIfAborted();
    return retrieve(input, index);
  });
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
): FusedCandidate[] {
  const activeRankings = readActiveRankings(
    mode,
    rankings.dense,
    rankings.lexical,
    fusion,
  );
  let maximumCandidateCount = 0;
  for (const ranking of activeRankings) {
    maximumCandidateCount += ranking.candidates.length;
  }
  const fusionLimit = Math.max(1, maximumCandidateCount);
  return fuseRankedCandidates(activeRankings, rrfK, fusionLimit);
}

export function selectPreparedRetrievalCandidates(
  mode: RetrievalMode,
  question: string,
  rankings: RetrievalCandidateRankings,
  candidateK: number,
  topK: number,
  rrfK: number,
  fusion: RankFusionConfig,
): FusedCandidate[] {
  const ranked = rankRetrievalCandidates(mode, rankings, rrfK, fusion);
  if (mode === "hybrid-reranked") {
    return selectRerankingCandidates(question, ranked, candidateK);
  }
  const candidates = ranked.slice(0, candidateK);
  return selectSourceDiverseCandidates(candidates, topK);
}

export function selectPreparedRerankingCandidatesWithTrace(
  question: string,
  rankings: RetrievalCandidateRankings,
  candidateK: number,
  rrfK: number,
  fusion: RankFusionConfig,
): NonOverlappingCandidateSelection {
  const ranked = rankRetrievalCandidates(
    "hybrid-reranked",
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

export function buildCandidateBudgetTelemetry(
  rankings: RetrievalCandidateRankings,
  queries: readonly RetrievalQuery[],
  channelCandidateLimit: number,
  retrievalWindowPolicy: EmbeddingSpaceConfig["retrievalWindow"],
  selection: NonOverlappingCandidateSelection,
  hydratedCandidates: readonly FusedCandidate[],
): CandidateBudgetTelemetry {
  const fusedCandidates = selection.decisions.map((decision) => (
    decision.candidate
  ));
  const admittedCandidates = selection.selected;
  const fusedRankByWindowId = new Map<string, number>();
  const highestFusedRankByParent = new Map<string, number>();
  for (let index = 0; index < fusedCandidates.length; index += 1) {
    const candidate = fusedCandidates[index];
    if (candidate === undefined) {
      continue;
    }
    const fusedRank = index + 1;
    fusedRankByWindowId.set(candidate.retrievalId, fusedRank);
    const parentKey = createCandidateParentKey(candidate);
    if (!highestFusedRankByParent.has(parentKey)) {
      highestFusedRankByParent.set(parentKey, fusedRank);
    }
  }

  const admissions: CandidateBudgetAdmissionTelemetry[] = [];
  const admittedParentKeys = new Set<string>();
  const rerankerInputRankByWindowId = new Map<string, number>();
  for (let index = 0; index < hydratedCandidates.length; index += 1) {
    const candidate = hydratedCandidates[index];
    if (candidate !== undefined) {
      rerankerInputRankByWindowId.set(candidate.retrievalId, index + 1);
    }
  }
  for (let index = 0; index < admittedCandidates.length; index += 1) {
    const candidate = admittedCandidates[index];
    if (candidate === undefined) {
      continue;
    }
    const fusedRank = fusedRankByWindowId.get(candidate.retrievalId);
    if (fusedRank === undefined) {
      throw new Error(
        `Admitted retrieval window ${candidate.retrievalId} is absent from the fused ranking.`,
      );
    }
    const parentKey = createCandidateParentKey(candidate);
    const highestFusedRankForParent = highestFusedRankByParent.get(parentKey);
    if (highestFusedRankForParent === undefined) {
      throw new Error(
        `Admitted parent ${candidate.parentId} is absent from the fused ranking.`,
      );
    }
    const isParentRepresentative = !admittedParentKeys.has(parentKey);
    admittedParentKeys.add(parentKey);
    admissions.push({
      admissionRank: index + 1,
      documentId: candidate.documentId,
      fusedRank,
      highestFusedRankForParent,
      hydrated: rerankerInputRankByWindowId.has(candidate.retrievalId),
      isParentRepresentative,
      parentElementId: candidate.parentId,
      representationHits: candidate.representationHits,
      rerankerInputRank:
        rerankerInputRankByWindowId.get(candidate.retrievalId) ?? null,
      retrievalWindowId: candidate.retrievalId,
      sourceFile: candidate.sourceFile,
      descriptionAffected: candidate.descriptionAffected,
    });
  }

  return {
    allocationPolicy: selection.allocationPolicy,
    admittedCandidates: admissions,
    admittedDistinctParentCount: admittedParentKeys.size,
    admittedWindowCount: admittedCandidates.length,
    candidateK: selection.candidateK,
    fusedCandidates: selection.decisions.map((decision) => ({
      admissionRank: decision.admissionRank,
      documentId: decision.candidate.documentId,
      exclusionReason: decision.exclusionReason,
      fusedRank: decision.fusedRank,
      fusion: {
        bm25Score: decision.candidate.bm25Score ?? null,
        denseDistance: decision.candidate.denseDistance,
        fusedScore: decision.candidate.fusedScore,
      },
      parentElementId: decision.candidate.parentId,
      representationHits: decision.candidate.representationHits,
      representativeRetrievalWindowId:
        decision.representativeRetrievalWindowId,
      retrievalWindowId: decision.candidate.retrievalId,
      sourceFile: decision.candidate.sourceFile,
      descriptionAffected: decision.candidate.descriptionAffected,
    })),
    fusedDistinctParentCount: countDistinctCandidateParents(fusedCandidates),
    fusedWindowCount: fusedCandidates.length,
    hydratedDistinctParentCount: countDistinctCandidateParents(hydratedCandidates),
    hydratedWindowCount: hydratedCandidates.length,
    queries: buildCandidateBudgetQueryTelemetry(
      rankings,
      queries,
      channelCandidateLimit,
    ),
    retrievalWindowPolicy,
  };
}

function buildCandidateBudgetQueryTelemetry(
  rankings: RetrievalCandidateRankings,
  retrievalQueries: readonly RetrievalQuery[],
  candidateLimit: number,
): CandidateBudgetQueryTelemetry[] {
  if (!Number.isInteger(candidateLimit) || candidateLimit <= 0) {
    throw new Error("Retrieval telemetry channel limit must be a positive integer.");
  }
  const queryCount = Math.max(rankings.dense.length, rankings.lexical.length);
  if (retrievalQueries.length !== queryCount) {
    throw new Error(
      `Retrieval telemetry expected ${queryCount} queries but received ${retrievalQueries.length}.`,
    );
  }
  const queries: CandidateBudgetQueryTelemetry[] = [];
  for (let queryIndex = 0; queryIndex < queryCount; queryIndex += 1) {
    const retrievalQuery = retrievalQueries[queryIndex];
    if (retrievalQuery === undefined) {
      throw new Error(`Missing retrieval telemetry query at index ${queryIndex}.`);
    }
    const dense = rankings.dense[queryIndex] ?? [];
    const lexical = rankings.lexical[queryIndex] ?? [];
    if (dense.length > candidateLimit || lexical.length > candidateLimit) {
      throw new Error(
        `Retrieval query ${queryIndex} exceeded the channel limit of ${candidateLimit}.`,
      );
    }
    const channels: CandidateBudgetChannelTelemetry[] = [
      buildDenseChannelTelemetry(dense, candidateLimit),
      buildLexicalChannelTelemetry(lexical, candidateLimit),
    ];
    queries.push({
      channels,
      denseDistinctParentCount: countDistinctCandidateParents(dense),
      denseWindowCount: dense.length,
      embeddingSha256: retrievalQuery.embedding === null
        ? null
        : createHash("sha256")
          .update(JSON.stringify(retrievalQuery.embedding))
          .digest("hex"),
      lexicalDistinctParentCount: countDistinctCandidateParents(lexical),
      lexicalWindowCount: lexical.length,
      queryFingerprintSha256: createHash("sha256")
        .update(retrievalQuery.text)
        .digest("hex"),
      queryIndex,
      queryKind: queryIndex === 0 ? "original" : "expansion",
    });
  }
  return queries;
}

function buildDenseChannelTelemetry(
  candidates: readonly DenseCandidate[],
  candidateLimit: number,
): CandidateBudgetChannelTelemetry {
  const records: CandidateBudgetChannelTelemetry["candidates"] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) {
      continue;
    }
    records.push({
      channelRank: index + 1,
      documentId: candidate.documentId,
      fusionInputPosition: index + 1,
      limitDecision: "admitted",
      parentElementId: candidate.parentId,
      representationId: candidate.representation.id,
      representationType: candidate.representation.type,
      retrievalWindowId: candidate.evidenceRetrievalId,
      score: candidate.distance,
      sourceFile: candidate.sourceFile,
    });
  }
  return {
    candidateLimit,
    candidates: records,
    channel: "dense",
    orderingPolicy: CHANNEL_ORDERING_POLICY,
    scoreDirection: "ascending",
    scoreKind: "cosine-distance",
  };
}

function buildLexicalChannelTelemetry(
  candidates: readonly LexicalCandidate[],
  candidateLimit: number,
): CandidateBudgetChannelTelemetry {
  const records: CandidateBudgetChannelTelemetry["candidates"] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) {
      continue;
    }
    records.push({
      channelRank: index + 1,
      documentId: candidate.documentId,
      fusionInputPosition: index + 1,
      limitDecision: "admitted",
      parentElementId: candidate.parentId,
      representationId: candidate.representation.id,
      representationType: candidate.representation.type,
      retrievalWindowId: candidate.evidenceRetrievalId,
      score: candidate.bm25Score,
      sourceFile: candidate.sourceFile,
    });
  }
  return {
    candidateLimit,
    candidates: records,
    channel: "lexical",
    orderingPolicy: CHANNEL_ORDERING_POLICY,
    scoreDirection: "descending",
    scoreKind: "bm25-relevance",
  };
}

function countDistinctCandidateParents(
  candidates: readonly Pick<
    FusedCandidate,
    "documentId" | "parentId" | "sourceFile"
  >[],
): number {
  const parentKeys = new Set<string>();
  for (const candidate of candidates) {
    parentKeys.add(createCandidateParentKey(candidate));
  }
  return parentKeys.size;
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
  for (const candidate of scopedCandidates) {
    candidateTargets.push({
      documentId: candidate.documentId,
      sourceFile: candidate.sourceFile,
    });
  }
  const versionRows = await database
    .select({
      documentId: indexedDocuments.documentId,
      sourceFile: indexedDocuments.sourceFile,
      versionId: indexedDocuments.versionId,
    })
    .from(indexedDocuments)
    .where(matchesResolvedQueryScope(
      indexedDocuments.documentId,
      indexedDocuments.sourceFile,
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
    | "maximum-context"
    | "relevance-cliff"
    | "source-diversity"
    | null,
  selectionReason: "maximum-context" | "relevance-cliff",
): ContextSelectionCandidateTelemetry["reason"] {
  if (exclusionReason === null) {
    return selectionReason;
  }
  if (exclusionReason === "source-diversity") {
    return "duplicate-source-element";
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
      () => queryDenseRepresentationCandidates(
        database,
        space,
        normalizedEmbedding,
        config.mode,
        config.candidateK,
        scopeTargets,
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
      ),
    );
  }
  const [dense, lexical] = await Promise.all([
    denseRowsPromise,
    lexicalRowsPromise,
  ]);
  return { dense, lexical };
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
  const isHybrid = mode === "hybrid" || mode === "hybrid-reranked";
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
  mode: RetrievalMode,
  candidateK: number,
  scopeTargets: ResolvedQueryScopeTarget[],
): Promise<DenseCandidate[]> {
  const exactRowsPromise = queryDenseCandidates(
    database,
    space,
    embedding,
    candidateK,
    scopeTargets,
  );
  let descriptionRowsPromise: Promise<unknown[]> = Promise.resolve([]);
  if (retrievalModeUsesDescriptions(mode)) {
    descriptionRowsPromise = queryDenseDescriptionCandidates(
      database,
      space,
      embedding,
      candidateK,
      scopeTargets,
    );
  }
  const [exactRows, descriptionRows] = await Promise.all([
    exactRowsPromise,
    descriptionRowsPromise,
  ]);
  const exact = decodeExactDenseCandidates(exactRows);
  const descriptionMetadata = decodeRows(
    descriptionDenseRetrievalRowSchema,
    descriptionRows,
    "dense description retrieval",
  );
  const evidenceByParent = await resolveDenseExactEvidence(
    database,
    space,
    embedding,
    scopeTargets,
    descriptionMetadata,
  );
  const descriptions: DenseCandidate[] = [];
  for (const row of descriptionMetadata) {
    const evidence = readDescriptionEvidence(row, evidenceByParent);
    descriptions.push({
      distance: row.distance,
      documentId: row.documentId,
      evidenceContent: evidence.evidenceContent,
      evidenceRetrievalId: evidence.evidenceRetrievalId,
      parentId: row.parentId,
      representation: {
        content: row.representationContent,
        id: row.representationId,
        type: row.kind === "table"
          ? "table-description"
          : "image-description",
      },
      sourceFile: row.sourceFile,
    });
  }
  return mergeRepresentationRankings(exact, descriptions, candidateK);
}

async function queryLexicalRepresentationCandidates(
  queryExecutor: SqlQueryExecutor,
  space: EmbeddingSpaceConfig,
  question: string,
  scopeTargets: ResolvedQueryScopeTarget[],
  candidateK: number,
): Promise<LexicalCandidate[]> {
  const scopeColumns = splitResolvedQueryScopeTargets(scopeTargets);
  const exactRowsPromise = queryExecutor.execute(
    "retrieve-lexical-candidates",
    [
      question,
      space.id,
      scopeColumns.documentIds,
      scopeColumns.sourceFiles,
      candidateK,
    ],
  );
  const descriptionRowsPromise = queryExecutor.execute(
    "retrieve-description-lexical-candidates",
    [
      question,
      space.id,
      scopeColumns.documentIds,
      scopeColumns.sourceFiles,
      candidateK,
    ],
  );
  const [exactRows, descriptionRows] = await Promise.all([
    exactRowsPromise,
    descriptionRowsPromise,
  ]);
  const decodedExact = decodeExactLexicalCandidates(exactRows);
  const exact: LexicalCandidate[] = [];
  for (const candidate of decodedExact) {
    if (candidate.bm25Score > 0) {
      exact.push(candidate);
    }
  }
  const decodedDescriptionMetadata = decodeRows(
    descriptionLexicalRetrievalRowSchema,
    descriptionRows,
    "lexical description retrieval",
  );
  const descriptionMetadata = [];
  for (const row of decodedDescriptionMetadata) {
    if (row.bm25Score > 0) {
      descriptionMetadata.push(row);
    }
  }
  const descriptions: LexicalCandidate[] = [];
  for (const row of descriptionMetadata) {
    descriptions.push({
      bm25Score: row.bm25Score,
      documentId: row.documentId,
      evidenceContent: row.evidenceContent,
      evidenceRetrievalId: row.evidenceRetrievalId,
      parentId: row.parentId,
      representation: {
        content: row.representationContent,
        id: row.representationId,
        type: row.kind === "table"
          ? "table-description"
          : "image-description",
      },
      sourceFile: row.sourceFile,
    });
  }
  return mergeRepresentationRankings(exact, descriptions, candidateK);
}

function decodeExactDenseCandidates(rows: unknown[]): DenseCandidate[] {
  const decoded = decodeRows(
    exactDenseRetrievalRowSchema,
    rows,
    "dense exact retrieval",
  );
  const candidates: DenseCandidate[] = [];
  for (const row of decoded) {
    candidates.push({
      distance: row.distance,
      documentId: row.documentId,
      evidenceContent: row.evidenceContent,
      evidenceRetrievalId: row.evidenceRetrievalId,
      parentId: row.parentId,
      representation: buildExactRepresentation(row),
      sourceFile: row.sourceFile,
    });
  }
  return candidates;
}

function decodeExactLexicalCandidates(rows: unknown[]): LexicalCandidate[] {
  const decoded = decodeRows(
    exactLexicalRetrievalRowSchema,
    rows,
    "lexical exact retrieval",
  );
  const candidates: LexicalCandidate[] = [];
  for (const row of decoded) {
    candidates.push({
      bm25Score: row.bm25Score,
      documentId: row.documentId,
      evidenceContent: row.evidenceContent,
      evidenceRetrievalId: row.evidenceRetrievalId,
      parentId: row.parentId,
      representation: buildExactRepresentation(row),
      sourceFile: row.sourceFile,
    });
  }
  return candidates;
}

function buildExactRepresentation(row: {
  representationContent: string;
  representationId: string;
}): {
  content: string;
  id: string;
  type: RetrievalRepresentationType;
} {
  return {
    content: row.representationContent,
    id: row.representationId,
    type: "exact-window",
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
    sourceFile: string;
  }[],
): Promise<Map<string, ExactEvidenceRow>> {
  const parentIds: string[] = [];
  for (const row of descriptionRows) {
    if (row.kind === "image") {
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
    sourceFile: string;
  },
  evidenceByParent: ReadonlyMap<string, ExactEvidenceRow>,
): ExactEvidenceRow {
  if (description.kind === "image") {
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

function mergeRepresentationRankings<
  Candidate extends DenseCandidate | LexicalCandidate,
>(
  exact: readonly Candidate[],
  descriptions: readonly Candidate[],
  candidateK: number,
): Candidate[] {
  const selectedByEvidence = new Map<string, RankedRepresentation<Candidate>>();
  addRepresentationRanking(selectedByEvidence, exact, false);
  addRepresentationRanking(selectedByEvidence, descriptions, true);
  const selected = [...selectedByEvidence.values()];
  selected.sort((left, right) => {
    const rankDifference = left.rank - right.rank;
    if (rankDifference !== 0) {
      return rankDifference;
    }
    return createRepresentationEvidenceKey(left.candidate).localeCompare(
      createRepresentationEvidenceKey(right.candidate),
    );
  });
  const candidates: Candidate[] = [];
  for (const entry of selected.slice(0, candidateK)) {
    candidates.push(entry.candidate);
  }
  return candidates;
}

interface RankedRepresentation<
  Candidate extends DenseCandidate | LexicalCandidate,
> {
  candidate: Candidate;
  rank: number;
  description: boolean;
}

function addRepresentationRanking<
  Candidate extends DenseCandidate | LexicalCandidate,
>(
  selectedByEvidence: Map<string, RankedRepresentation<Candidate>>,
  ranking: readonly Candidate[],
  description: boolean,
): void {
  for (let index = 0; index < ranking.length; index += 1) {
    const candidate = ranking[index];
    if (candidate === undefined) {
      continue;
    }
    const evidenceKey = createRepresentationEvidenceKey(candidate);
    const existing = selectedByEvidence.get(evidenceKey);
    const rank = index + 1;
    if (
      existing === undefined
      || rank < existing.rank
      || (rank === existing.rank && existing.description && !description)
    ) {
      selectedByEvidence.set(evidenceKey, { candidate, rank, description });
    }
  }
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

function retrievalModeUsesDescriptions(mode: RetrievalMode): boolean {
  return mode !== "bm25";
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
