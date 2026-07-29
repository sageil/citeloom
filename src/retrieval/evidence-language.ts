import { francAll } from "franc-min";

import {
  selectNonOverlappingCandidatesWithTrace,
  type NonOverlappingCandidateSelection,
  type PreRerankCandidateExclusionReason,
} from "./document-retrieval.js";
import type { FusedCandidate } from "./ranking/rank-fusion.js";

export interface EvidenceLanguageClassification {
  alternativeCode: string | null;
  alternativeScore: number | null;
  code: string;
  score: number;
}

export interface CandidateLanguageAdmissionTrace {
  classifications: Array<{
    candidate: FusedCandidate;
    language: EvidenceLanguageClassification;
  }>;
}

export interface EnglishCandidateAdmission {
  selection: NonOverlappingCandidateSelection;
  trace: CandidateLanguageAdmissionTrace;
}

export function classifyEvidenceLanguage(
  evidenceContent: string,
): EvidenceLanguageClassification {
  const rankings = francAll(evidenceContent);
  const strongest = rankings[0] ?? ["und", 1];
  const alternative = rankings[1];
  return {
    alternativeCode: alternative?.[0] ?? null,
    alternativeScore: alternative?.[1] ?? null,
    code: strongest[0],
    score: strongest[1],
  };
}

export function selectEnglishCandidateAdmission(
  rankedCandidates: FusedCandidate[],
  limit: number,
): EnglishCandidateAdmission {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Retrieval candidate limit must be a positive integer.");
  }
  const structuralSelection = selectNonOverlappingCandidatesWithTrace(
    rankedCandidates,
    Math.max(1, rankedCandidates.length),
    "fused-order",
  );
  const classifications: CandidateLanguageAdmissionTrace["classifications"] = [];
  const languageByCandidate = new Map<
    FusedCandidate,
    EvidenceLanguageClassification
  >();
  for (const decision of structuralSelection.decisions) {
    const candidate = decision.candidate;
    const language = classifyEvidenceLanguage(candidate.evidenceContent);
    languageByCandidate.set(candidate, language);
    classifications.push({ candidate, language });
  }
  const selected: FusedCandidate[] = [];
  for (const candidate of structuralSelection.selected) {
    const language = readCandidateLanguage(languageByCandidate, candidate);
    if (!isEnglishCompatibleLanguage(language)) {
      continue;
    }
    selected.push(candidate);
    if (selected.length === limit) {
      break;
    }
  }
  const admissionRankByCandidate = new Map<FusedCandidate, number>();
  for (let index = 0; index < selected.length; index += 1) {
    const candidate = selected[index];
    if (candidate !== undefined) {
      admissionRankByCandidate.set(candidate, index + 1);
    }
  }
  const decisions: NonOverlappingCandidateSelection["decisions"] = [];
  for (const structuralDecision of structuralSelection.decisions) {
    if (structuralDecision.exclusionReason === "duplicate-evidence") {
      decisions.push(structuralDecision);
      continue;
    }
    const candidate = structuralDecision.candidate;
    const language = readCandidateLanguage(languageByCandidate, candidate);
    const admissionRank = admissionRankByCandidate.get(candidate) ?? null;
    let exclusionReason: PreRerankCandidateExclusionReason | null = null;
    if (!isEnglishCompatibleLanguage(language)) {
      exclusionReason = "unsupported-language";
    } else if (admissionRank === null) {
      exclusionReason = "candidate-budget";
    }
    decisions.push({
      admissionRank,
      candidate,
      exclusionReason,
      fusedRank: structuralDecision.fusedRank,
      representativeRetrievalWindowId:
        structuralDecision.representativeRetrievalWindowId,
    });
  }
  return {
    selection: {
      allocationPolicy: structuralSelection.allocationPolicy,
      candidateK: limit,
      decisions,
      selected,
    },
    trace: { classifications },
  };
}

function isEnglishCompatibleLanguage(
  language: EvidenceLanguageClassification,
): boolean {
  return language.code === "eng" || language.code === "und";
}

function readCandidateLanguage(
  languageByCandidate: ReadonlyMap<
    FusedCandidate,
    EvidenceLanguageClassification
  >,
  candidate: FusedCandidate,
): EvidenceLanguageClassification {
  const language = languageByCandidate.get(candidate);
  if (language === undefined) {
    throw new Error(
      `Fused candidate ${candidate.retrievalId} has no language classification.`,
    );
  }
  return language;
}
