import {
  answerContextSelectionConfig,
  selectAnswerContextCutoff,
  type AnswerContextSelection,
} from "./context-selection.js";

export interface RerankerCandidateIdentity {
  documentId: string;
  documentVersionId: string;
  elementId: string;
  representativeRetrievalWindowId: string;
  sourceFile: string;
}

export interface ScoredRerankerCandidate<Item> {
  identity: RerankerCandidateIdentity;
  item: Item;
  relevanceScore: number;
  rerankerInputRank: number;
}

export type ContextSelectionPolicy = "relevance-cliff" | "top-k";

export type PostRerankCandidateExclusionReason =
  | "duplicate-evidence"
  | "maximum-context"
  | "relevance-cliff";

export interface RankedRerankerCandidate<Item>
  extends ScoredRerankerCandidate<Item> {
  rerankerRank: number;
}

export interface PostRerankCandidateDecision<Item> {
  candidate: RankedRerankerCandidate<Item>;
  exclusionReason: PostRerankCandidateExclusionReason | null;
  selectedContextRank: number | null;
}

export interface PostRerankCandidateSelection<Item> {
  cutoff: AnswerContextSelection;
  decisions: PostRerankCandidateDecision<Item>[];
  excluded: PostRerankCandidateDecision<Item>[];
  ranking: RankedRerankerCandidate<Item>[];
  selected: RankedRerankerCandidate<Item>[];
}

export function selectRerankedContext<Item>(
  candidates: readonly ScoredRerankerCandidate<Item>[],
  maximumContextSize: number,
  policy: ContextSelectionPolicy,
): PostRerankCandidateSelection<Item> {
  const ranking = rankRerankerCandidates(candidates);
  const cutoff = readContextCutoff(ranking, maximumContextSize, policy);
  const withinCutoff = ranking.slice(0, cutoff.cutoffRank);
  const selectionCandidates = cutoff.reason === "maximum-context"
    ? ranking
    : withinCutoff;
  const uniqueCandidates = removeDuplicateEvidence(
    selectionCandidates,
  );
  const selected = uniqueCandidates.slice(0, cutoff.cutoffRank);
  const selectedContextRankByCandidate = new Map<
    RankedRerankerCandidate<Item>,
    number
  >();
  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index];
    if (candidate === undefined) {
      continue;
    }
    selectedContextRankByCandidate.set(candidate, index + 1);
  }
  const decisions: PostRerankCandidateDecision<Item>[] = [];
  const excluded: PostRerankCandidateDecision<Item>[] = [];
  for (const candidate of ranking) {
    const selectedContextRank = selectedContextRankByCandidate.get(candidate)
      ?? null;
    const exclusionReason = readExclusionReason(
      candidate,
      cutoff,
      selectedContextRank,
    );
    const decision = {
      candidate,
      exclusionReason,
      selectedContextRank,
    };
    decisions.push(decision);
    if (exclusionReason !== null) {
      excluded.push(decision);
    }
  }
  return {
    cutoff,
    decisions,
    excluded,
    ranking,
    selected,
  };
}

export function rankRerankerCandidates<Item>(
  candidates: readonly ScoredRerankerCandidate<Item>[],
): RankedRerankerCandidate<Item>[] {
  validateScoredCandidates(candidates);
  const ranking = [...candidates];
  ranking.sort(compareRerankerCandidates);
  const ranked: RankedRerankerCandidate<Item>[] = [];
  for (let index = 0; index < ranking.length; index += 1) {
    const candidate = ranking[index];
    if (candidate === undefined) {
      continue;
    }
    ranked.push({
      ...candidate,
      rerankerRank: index + 1,
    });
  }
  return ranked;
}

export function compareRerankerCandidates<Item>(
  left: ScoredRerankerCandidate<Item>,
  right: ScoredRerankerCandidate<Item>,
): number {
  const scoreDifference = right.relevanceScore - left.relevanceScore;
  if (scoreDifference !== 0) {
    return scoreDifference;
  }
  const identityDifference = compareRerankerCandidateIdentity(
    left.identity,
    right.identity,
  );
  if (identityDifference !== 0) {
    return identityDifference;
  }
  return left.rerankerInputRank - right.rerankerInputRank;
}

export function compareRerankerCandidateIdentity(
  left: RerankerCandidateIdentity,
  right: RerankerCandidateIdentity,
): number {
  const leftIdentity = createPersistentSourceIdentity(left);
  const rightIdentity = createPersistentSourceIdentity(right);
  if (leftIdentity < rightIdentity) {
    return -1;
  }
  if (leftIdentity > rightIdentity) {
    return 1;
  }
  if (
    left.representativeRetrievalWindowId
    < right.representativeRetrievalWindowId
  ) {
    return -1;
  }
  if (
    left.representativeRetrievalWindowId
    > right.representativeRetrievalWindowId
  ) {
    return 1;
  }
  return 0;
}

export function createPersistentSourceIdentity(
  identity: RerankerCandidateIdentity,
): string {
  return [
    identity.documentId,
    identity.documentVersionId,
    identity.sourceFile,
    identity.elementId,
  ].join("\u0000");
}

function validateScoredCandidates<Item>(
  candidates: readonly ScoredRerankerCandidate<Item>[],
): void {
  const inputRanks = new Set<number>();
  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.relevanceScore)) {
      throw new Error("Reranker scores must be finite.");
    }
    if (
      !Number.isInteger(candidate.rerankerInputRank)
      || candidate.rerankerInputRank < 1
    ) {
      throw new Error("Reranker input ranks must be positive integers.");
    }
    if (inputRanks.has(candidate.rerankerInputRank)) {
      throw new Error("Reranker input ranks must be unique.");
    }
    inputRanks.add(candidate.rerankerInputRank);
  }
}

function readContextCutoff<Item>(
  ranking: readonly RankedRerankerCandidate<Item>[],
  maximumContextSize: number,
  policy: ContextSelectionPolicy,
): AnswerContextSelection {
  if (policy === "relevance-cliff") {
    return selectAnswerContextCutoff(
      ranking,
      maximumContextSize,
      answerContextSelectionConfig,
    );
  }
  return {
    cutoffRank: Math.min(maximumContextSize, ranking.length),
    reason: "maximum-context",
  };
}

function removeDuplicateEvidence<Item>(
  ranking: readonly RankedRerankerCandidate<Item>[],
): RankedRerankerCandidate<Item>[] {
  const unique: RankedRerankerCandidate<Item>[] = [];
  const seenIdentities = new Set<string>();
  for (const candidate of ranking) {
    const identity = createEvidenceIdentity(candidate.identity);
    if (seenIdentities.has(identity)) {
      continue;
    }
    seenIdentities.add(identity);
    unique.push(candidate);
  }
  return unique;
}

function readExclusionReason<Item>(
  candidate: RankedRerankerCandidate<Item>,
  cutoff: AnswerContextSelection,
  selectedContextRank: number | null,
): PostRerankCandidateExclusionReason | null {
  if (selectedContextRank !== null) {
    return null;
  }
  if (candidate.rerankerRank <= cutoff.cutoffRank) {
    return "duplicate-evidence";
  }
  return cutoff.reason;
}

function createEvidenceIdentity(identity: RerankerCandidateIdentity): string {
  return [
    identity.documentId,
    identity.sourceFile,
    identity.representativeRetrievalWindowId,
  ].join("\u0000");
}
