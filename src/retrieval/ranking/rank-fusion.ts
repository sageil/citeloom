import type {
  RetrievalRepresentationType,
} from "../representations.js";

export interface CandidateRepresentation {
  content: string;
  id: string;
  type: RetrievalRepresentationType;
}

interface RankedCandidateBase {
  documentId: string;
  evidenceContent: string;
  evidenceRetrievalId: string;
  parentId: string;
  representation: CandidateRepresentation;
  sourceFile: string;
}

export interface DenseCandidate extends RankedCandidateBase {
  distance: number;
}

export interface LexicalCandidate extends RankedCandidateBase {
  bm25Score: number;
}

export interface RepresentationHit {
  channel: "dense" | "lexical";
  queryIndex: number;
  rank: number;
  representationId: string;
  representationType: CandidateRepresentation["type"];
}

export interface FusedCandidate {
  bm25Score: number | null;
  denseDistance: number | null;
  documentId: string;
  evidenceContent: string;
  fusedScore: number;
  parentId: string;
  representationHits: RepresentationHit[];
  retrievalId: string;
  sourceFile: string;
  descriptionAffected: boolean;
}

type MutableFusedCandidate = FusedCandidate;

export type RankedCandidate = DenseCandidate | LexicalCandidate;

export interface WeightedRanking {
  candidates: readonly RankedCandidate[];
  channel: "dense" | "lexical";
  queryIndex: number;
  weight: number;
}

export function fuseRankedCandidates(
  rankings: readonly WeightedRanking[],
  rrfK: number,
  limit: number,
): FusedCandidate[] {
  validateRankFusionOptions(rrfK, limit);
  const fusedByEvidence = new Map<string, MutableFusedCandidate>();
  for (const ranking of rankings) {
    validateRankingWeight(ranking.weight);
    addRanking(fusedByEvidence, ranking, rrfK);
  }
  const mutable = [...fusedByEvidence.values()];
  mutable.sort(compareFusedCandidates);
  const fused: FusedCandidate[] = [];
  for (const candidate of mutable.slice(0, limit)) {
    fused.push({
      bm25Score: candidate.bm25Score,
      denseDistance: candidate.denseDistance,
      documentId: candidate.documentId,
      evidenceContent: candidate.evidenceContent,
      fusedScore: candidate.fusedScore,
      parentId: candidate.parentId,
      representationHits: candidate.representationHits,
      retrievalId: candidate.retrievalId,
      sourceFile: candidate.sourceFile,
      descriptionAffected: candidate.descriptionAffected,
    });
  }
  return fused;
}

function validateRankingWeight(weight: number): void {
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new Error("RRF ranking weight must be a positive finite number.");
  }
}

function validateRankFusionOptions(rrfK: number, limit: number): void {
  if (!Number.isInteger(rrfK) || rrfK < 1) {
    throw new Error("RRF k must be a positive integer.");
  }
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("RRF result limit must be a positive integer.");
  }
}

function addRanking(
  fusedByEvidence: Map<string, MutableFusedCandidate>,
  ranking: WeightedRanking,
  rrfK: number,
): void {
  const seenEvidence = new Set<string>();
  for (let index = 0; index < ranking.candidates.length; index += 1) {
    const candidate = ranking.candidates[index];
    if (candidate === undefined) {
      continue;
    }
    const evidenceKey = createEvidenceKey(candidate);
    const fused = readOrCreateCandidate(
      fusedByEvidence,
      evidenceKey,
      candidate,
    );
    addRepresentationHit(fused, candidate, ranking, index);
    if (candidate.representation.type !== "exact-window") {
      fused.descriptionAffected = true;
    }
    if (seenEvidence.has(evidenceKey)) {
      continue;
    }
    seenEvidence.add(evidenceKey);
    const contribution = ranking.weight * reciprocalRank(index, rrfK);
    updateChannelScore(fused, candidate);
    fused.fusedScore += contribution;
  }
}

function addRepresentationHit(
  fused: MutableFusedCandidate,
  candidate: RankedCandidate,
  ranking: WeightedRanking,
  index: number,
): void {
  const hit: RepresentationHit = {
    channel: ranking.channel,
    queryIndex: ranking.queryIndex,
    rank: index + 1,
    representationId: candidate.representation.id,
    representationType: candidate.representation.type,
  };
  fused.representationHits.push(hit);
}

function updateChannelScore(
  fused: MutableFusedCandidate,
  candidate: RankedCandidate,
): void {
  if ("distance" in candidate) {
    const existing = fused.denseDistance;
    fused.denseDistance = existing === null
      ? candidate.distance
      : Math.min(existing, candidate.distance);
    return;
  }
  const existing = fused.bm25Score;
  fused.bm25Score = existing === null
    ? candidate.bm25Score
    : Math.max(existing, candidate.bm25Score);
}

function readOrCreateCandidate(
  candidates: Map<string, MutableFusedCandidate>,
  evidenceKey: string,
  candidate: RankedCandidate,
): MutableFusedCandidate {
  const existing = candidates.get(evidenceKey);
  if (existing !== undefined) {
    if (
      existing.documentId !== candidate.documentId
      || existing.sourceFile !== candidate.sourceFile
      || existing.parentId !== candidate.parentId
      || existing.retrievalId !== candidate.evidenceRetrievalId
      || existing.evidenceContent !== candidate.evidenceContent
    ) {
      throw new Error(
        `Retrieval metadata differs for evidence ${candidate.evidenceRetrievalId}.`,
      );
    }
    return existing;
  }
  const created: MutableFusedCandidate = {
    bm25Score: null,
    denseDistance: null,
    documentId: candidate.documentId,
    evidenceContent: candidate.evidenceContent,
    fusedScore: 0,
    parentId: candidate.parentId,
    representationHits: [],
    retrievalId: candidate.evidenceRetrievalId,
    sourceFile: candidate.sourceFile,
    descriptionAffected: false,
  };
  candidates.set(evidenceKey, created);
  return created;
}

function reciprocalRank(index: number, rrfK: number): number {
  return 1 / (rrfK + index + 1);
}

function compareFusedCandidates(
  left: FusedCandidate,
  right: FusedCandidate,
): number {
  const scoreDifference = right.fusedScore - left.fusedScore;
  if (scoreDifference !== 0) {
    return scoreDifference;
  }
  return createEvidenceKey(left).localeCompare(createEvidenceKey(right));
}

function createEvidenceKey(
  candidate: Pick<
    RankedCandidate,
    "documentId" | "evidenceRetrievalId" | "sourceFile"
  > | Pick<FusedCandidate, "documentId" | "retrievalId" | "sourceFile">,
): string {
  const retrievalId = "evidenceRetrievalId" in candidate
    ? candidate.evidenceRetrievalId
    : candidate.retrievalId;
  return [
    candidate.documentId,
    candidate.sourceFile,
    retrievalId,
  ].join("\0");
}
