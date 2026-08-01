import type {
  FusedCandidate,
  RepresentationHit,
} from "./ranking/rank-fusion.js";
import type {
  RetrievalSourceElement,
} from "../domain/source-elements.js";

export interface RetrievedElementProvenance {
  evidenceSha256: string;
  representationHits: RepresentationHit[];
  retrievalWindowId: string;
  descriptionAffected: boolean;
}

export interface RetrievedElement {
  adjacentContext?: {
    following: string | null;
    preceding: string | null;
    retrievalWindowIds: string[];
  };
  distance: number | null;
  documentVersionId: string;
  element: RetrievalSourceElement;
  evidenceContent: string;
  provenance: RetrievedElementProvenance;
}

export interface MatchedDocument {
  documentId: string;
  retrievedElementCount: number;
  sourceFile: string;
}

export type CandidateAllocationPolicy =
  | "document-round-robin"
  | "fused-order";

export type PreRerankCandidateExclusionReason =
  | "candidate-budget"
  | "duplicate-evidence"
  | "unsupported-language";

export interface PreRerankCandidateDecision {
  admissionRank: number | null;
  candidate: FusedCandidate;
  exclusionReason: PreRerankCandidateExclusionReason | null;
  fusedRank: number;
  representativeRetrievalWindowId: string;
}

export interface NonOverlappingCandidateSelection {
  allocationPolicy: CandidateAllocationPolicy;
  candidateK: number;
  decisions: PreRerankCandidateDecision[];
  selected: FusedCandidate[];
}

export function createCandidateParentKey(
  candidate: Pick<FusedCandidate, "documentId" | "parentId" | "sourceFile">,
): string {
  return `${candidate.documentId}\u0000${candidate.sourceFile}\u0000${candidate.parentId}`;
}

export function selectNonOverlappingCandidates(
  rankedCandidates: FusedCandidate[],
  limit: number,
  allocationPolicy: CandidateAllocationPolicy = "fused-order",
): FusedCandidate[] {
  return selectNonOverlappingCandidatesWithTrace(
    rankedCandidates,
    limit,
    allocationPolicy,
  ).selected;
}

export function selectNonOverlappingCandidatesWithTrace(
  rankedCandidates: FusedCandidate[],
  limit: number,
  allocationPolicy: CandidateAllocationPolicy = "fused-order",
): NonOverlappingCandidateSelection {
  validateLimit(limit);
  const representatives: FusedCandidate[] = [];
  const representativeByCandidate = new Map<FusedCandidate, FusedCandidate>();
  const representativeByEvidence = new Map<string, FusedCandidate>();
  for (const candidate of rankedCandidates) {
    const evidenceKey = createCandidateEvidenceKey(candidate);
    const representative = representativeByEvidence.get(evidenceKey);
    if (representative !== undefined) {
      representativeByCandidate.set(candidate, representative);
      continue;
    }
    representativeByEvidence.set(evidenceKey, candidate);
    representativeByCandidate.set(candidate, candidate);
    representatives.push(candidate);
  }
  let selected: FusedCandidate[];
  if (allocationPolicy === "document-round-robin") {
    selected = allocateCandidatesByDocument(representatives, limit);
  } else {
    selected = representatives.slice(0, limit);
  }
  const admissionRankByRepresentative = new Map<FusedCandidate, number>();
  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index];
    if (candidate === undefined) {
      continue;
    }
    admissionRankByRepresentative.set(candidate, index + 1);
  }
  const decisions: PreRerankCandidateDecision[] = [];
  for (let index = 0; index < rankedCandidates.length; index += 1) {
    const candidate = rankedCandidates[index];
    if (candidate === undefined) {
      continue;
    }
    const representative = representativeByCandidate.get(candidate);
    if (representative === undefined) {
      throw new Error(
        `Fused candidate ${candidate.retrievalId} has no evidence representative.`,
      );
    }
    const admissionRank = admissionRankByRepresentative.get(representative)
      ?? null;
    let exclusionReason: PreRerankCandidateExclusionReason | null = null;
    if (candidate !== representative) {
      exclusionReason = "duplicate-evidence";
    } else if (admissionRank === null) {
      exclusionReason = "candidate-budget";
    }
    decisions.push({
      admissionRank: candidate === representative ? admissionRank : null,
      candidate,
      exclusionReason,
      fusedRank: index + 1,
      representativeRetrievalWindowId: representative.retrievalId,
    });
  }
  return {
    allocationPolicy,
    candidateK: limit,
    decisions,
    selected,
  };
}

interface CandidateGroup {
  candidates: FusedCandidate[];
}

export function allocateCandidatesByDocument(
  rankedCandidates: FusedCandidate[],
  limit: number,
): FusedCandidate[] {
  validateLimit(limit);
  const groups = groupCandidatesByDocument(rankedCandidates);
  const allocated: FusedCandidate[] = [];
  let groupPosition = 0;
  while (allocated.length < limit) {
    let addedCandidate = false;
    for (const group of groups) {
      const candidate = group.candidates[groupPosition];
      if (candidate === undefined) {
        continue;
      }
      allocated.push(candidate);
      addedCandidate = true;
      if (allocated.length === limit) {
        return allocated;
      }
    }
    if (!addedCandidate) {
      break;
    }
    groupPosition += 1;
  }
  return allocated;
}

export function partitionCandidateWindowsByParentOccurrence(
  rankedCandidates: readonly FusedCandidate[],
): FusedCandidate[][] {
  const occurrenceByParent = new Map<string, number>();
  const batches: FusedCandidate[][] = [];
  for (const candidate of rankedCandidates) {
    const parentKey = createCandidateParentKey(candidate);
    const occurrence = occurrenceByParent.get(parentKey) ?? 0;
    occurrenceByParent.set(parentKey, occurrence + 1);
    const existingBatch = batches[occurrence];
    if (existingBatch === undefined) {
      batches.push([candidate]);
    } else {
      existingBatch.push(candidate);
    }
  }
  return batches;
}

export function selectSourceDiverseElements(
  rankedElements: RetrievedElement[],
  limit: number,
): RetrievedElement[] {
  const uniqueElements: RetrievedElement[] = [];
  const evidenceIdentities = new Set<string>();
  for (const item of rankedElements) {
    const identity = createRetrievedEvidenceKey(item);
    if (evidenceIdentities.has(identity)) {
      continue;
    }
    evidenceIdentities.add(identity);
    uniqueElements.push(item);
  }
  return selectSourceDiverseItems(
    uniqueElements,
    limit,
    (item) => createDocumentKey(
      item.element.documentId,
      item.element.sourceFile,
    ),
  );
}

export function selectSourceDiverseCandidates(
  rankedCandidates: FusedCandidate[],
  limit: number,
): FusedCandidate[] {
  return selectSourceDiverseItems(
    rankedCandidates,
    limit,
    (candidate) => createDocumentKey(
      candidate.documentId,
      candidate.sourceFile,
    ),
  );
}

export function selectSourceDiverseItems<Item>(
  rankedItems: Item[],
  limit: number,
  readDocumentKey: (item: Item) => string,
): Item[] {
  validateLimit(limit);
  const selected = rankedItems.slice(0, limit);
  if (rankedItems.length <= limit || limit === 1) {
    return selected;
  }

  const selectedDocumentKeys = new Set<string>();
  for (const item of selected) {
    selectedDocumentKeys.add(readDocumentKey(item));
  }
  if (selectedDocumentKeys.size !== 1) {
    return selected;
  }
  const dominantDocumentKey = selectedDocumentKeys.values().next().value;
  if (dominantDocumentKey === undefined) {
    return selected;
  }

  const diversityWindowEnd = Math.min(rankedItems.length, limit * 3);
  for (let index = limit; index < diversityWindowEnd; index += 1) {
    const alternative = rankedItems[index];
    if (alternative === undefined) {
      continue;
    }
    const alternativeDocumentKey = readDocumentKey(alternative);
    if (alternativeDocumentKey === dominantDocumentKey) {
      continue;
    }
    selected[limit - 1] = alternative;
    return selected;
  }
  return selected;
}

export function buildMatchedDocuments(
  retrieved: RetrievedElement[],
): MatchedDocument[] {
  const matchedByKey = new Map<string, MatchedDocument>();
  for (const item of retrieved) {
    const documentId = item.element.documentId;
    const sourceFile = item.element.sourceFile;
    const documentKey = createDocumentKey(documentId, sourceFile);
    const existing = matchedByKey.get(documentKey);
    if (existing === undefined) {
      matchedByKey.set(documentKey, {
        documentId,
        retrievedElementCount: 1,
        sourceFile,
      });
      continue;
    }
    existing.retrievedElementCount += 1;
  }
  return [...matchedByKey.values()];
}

function groupCandidatesByDocument(
  rankedCandidates: FusedCandidate[],
): CandidateGroup[] {
  const groupsByKey = new Map<string, CandidateGroup>();
  for (const candidate of rankedCandidates) {
    const documentKey = createDocumentKey(
      candidate.documentId,
      candidate.sourceFile,
    );
    const existing = groupsByKey.get(documentKey);
    if (existing !== undefined) {
      existing.candidates.push(candidate);
      continue;
    }
    groupsByKey.set(documentKey, { candidates: [candidate] });
  }
  return [...groupsByKey.values()];
}

function createDocumentKey(documentId: string, sourceFile: string): string {
  return `${documentId}\u0000${sourceFile}`;
}

function createCandidateEvidenceKey(candidate: FusedCandidate): string {
  return [
    candidate.documentId,
    candidate.sourceFile,
    candidate.retrievalId,
  ].join("\u0000");
}

function createRetrievedEvidenceKey(item: RetrievedElement): string {
  return [
    item.element.documentId,
    item.element.sourceFile,
    item.provenance.retrievalWindowId,
  ].join("\u0000");
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("A retrieval result limit must be a positive integer.");
  }
}
