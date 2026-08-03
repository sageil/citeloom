import { createHash } from "node:crypto";

import type { EmbeddingSpaceConfig } from "../../config/index.js";
import {
  createCandidateParentKey,
  type NonOverlappingCandidateSelection,
} from "../document-retrieval.js";
import type {
  DenseCandidate,
  FusedCandidate,
  LexicalCandidate,
} from "../ranking/rank-fusion.js";
import { CHANNEL_ORDERING_POLICY } from "../ranking/channel-ordering.js";
import type {
  CandidateBudgetAdmissionTelemetry,
  CandidateBudgetChannelTelemetry,
  CandidateBudgetQueryTelemetry,
  CandidateBudgetTelemetry,
} from "../../observability/run.js";
import type {
  RetrievalCandidateRankings,
  RetrievalQuery,
} from "./query-types.js";

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
    fusedCandidates: selection.decisions.map((decision) => (
      buildCandidateBudgetDecisionTelemetry(decision)
    )),
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

function buildCandidateBudgetDecisionTelemetry(
  decision: NonOverlappingCandidateSelection["decisions"][number],
): CandidateBudgetTelemetry["fusedCandidates"][number] {
  return {
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
      queryKind: retrievalQuery.kind
        ?? (queryIndex === 0 ? "original" : "expansion"),
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
