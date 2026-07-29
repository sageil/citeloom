import { describe, expect, it } from "vitest";

import {
  classifyEvidenceLanguage,
  selectEnglishCandidateAdmission,
} from "../src/retrieval/evidence-language.js";
import type {
  FusedCandidate,
} from "../src/retrieval/ranking/rank-fusion.js";

const englishPurpose = [
  "The purpose of this Act is to extend the laws in Canada to give effect",
  "to the principle that all individuals should have an opportunity equal",
  "with other individuals to make for themselves the lives that they are",
  "able and wish to have without discriminatory practices.",
].join(" ");

const secondEnglishPassage = [
  "The Canadian Human Rights Act protects equal opportunity and prohibits",
  "discrimination based on protected personal characteristics within",
  "matters under Parliament's legislative authority.",
].join(" ");

const frenchPurpose = [
  "La présente loi a pour objet de compléter la législation canadienne",
  "en donnant effet au principe du droit de tous les individus à",
  "l'égalité des chances sans pratiques discriminatoires.",
].join(" ");

describe("English-compatible evidence admission", () => {
  it("admits English and undetermined representatives before applying the candidate budget", () => {
    const french = buildCandidate("french", frenchPurpose);
    const firstEnglish = buildCandidate("english-a", englishPurpose);
    const undetermined = buildCandidate("undetermined", "§ 2");
    const secondEnglish = buildCandidate(
      "english-b",
      secondEnglishPassage,
    );

    const admission = selectEnglishCandidateAdmission([
      french,
      firstEnglish,
      undetermined,
      secondEnglish,
    ], 2);

    expect(admission.selection.selected).toEqual([
      firstEnglish,
      undetermined,
    ]);
    expect(admission.selection.decisions.map((decision) => ({
      admissionRank: decision.admissionRank,
      exclusionReason: decision.exclusionReason,
      fusedRank: decision.fusedRank,
    }))).toEqual([
      {
        admissionRank: null,
        exclusionReason: "unsupported-language",
        fusedRank: 1,
      },
      {
        admissionRank: 1,
        exclusionReason: null,
        fusedRank: 2,
      },
      {
        admissionRank: 2,
        exclusionReason: null,
        fusedRank: 3,
      },
      {
        admissionRank: null,
        exclusionReason: "candidate-budget",
        fusedRank: 4,
      },
    ]);
    expect(admission.trace.classifications.map((entry) => (
      entry.language.code
    ))).toEqual(["fra", "eng", "und", "eng"]);
  });

  it("preserves duplicate-evidence decisions before language admission", () => {
    const representative = buildCandidate("representative", englishPurpose);
    const duplicate = buildCandidate("duplicate", englishPurpose);
    duplicate.documentId = representative.documentId;

    const admission = selectEnglishCandidateAdmission([
      representative,
      duplicate,
    ], 2);

    expect(admission.selection.selected).toEqual([representative]);
    expect(admission.selection.decisions.map((decision) => (
      decision.exclusionReason
    ))).toEqual([null, "duplicate-evidence"]);
  });

  it("admits undetermined evidence when no evidence is classified as English", () => {
    const undetermined = buildCandidate("undetermined", "§ 2");
    const admission = selectEnglishCandidateAdmission([
      buildCandidate("french", frenchPurpose),
      undetermined,
    ], 2);

    expect(admission.selection.selected).toEqual([undetermined]);
    expect(admission.selection.decisions.map((decision) => (
      decision.exclusionReason
    ))).toEqual([
      "unsupported-language",
      null,
    ]);
  });

  it("classifies the supported and rejected evidence languages explicitly", () => {
    expect(classifyEvidenceLanguage(englishPurpose).code).toBe("eng");
    expect(classifyEvidenceLanguage(frenchPurpose).code).toBe("fra");
    expect(classifyEvidenceLanguage("§ 2").code).toBe("und");
  });
});

function buildCandidate(
  identity: string,
  evidenceContent: string,
): FusedCandidate {
  return {
    bm25Score: null,
    denseDistance: 0.1,
    descriptionAffected: false,
    documentId: `document-${identity}`,
    evidenceContent,
    fusedScore: 1,
    parentId: `parent-${identity}`,
    representationHits: [],
    retrievalId: `window-${identity}`,
    sourceFile: "/documents/human-rights.pdf",
  };
}
