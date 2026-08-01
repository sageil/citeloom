import { describe, expect, it } from "vitest";

import {
  buildCandidateBudgetTelemetry,
  type RetrievalCandidateRankings,
} from "../src/retrieval/indexing/query-store.js";
import {
  selectEnglishCandidateAdmission,
} from "../src/retrieval/evidence-language.js";
import {
  selectNonOverlappingCandidatesWithTrace,
} from "../src/retrieval/document-retrieval.js";
import {
  createRetrievalWindowPolicy,
  createRetrievalWindowPolicyContract,
} from "../src/retrieval/window-policy.js";
import type {
  DenseCandidate,
  FusedCandidate,
  LexicalCandidate,
} from "../src/retrieval/ranking/rank-fusion.js";
import {
  buildExactCandidateRepresentation,
} from "./source-element-fixture.js";

describe("retrieval candidate telemetry", () => {
  it("records window and distinct-parent counts without changing admissions", () => {
    const retrievalWindowPolicy = createRetrievalWindowPolicyContract(
      createRetrievalWindowPolicy("structured-token-v3", 512, 2_048),
    );
    const firstParentBest = buildFusedCandidate(
      "window-a",
      "parent-a",
      "document-a",
      "/documents/a.pdf",
    );
    const firstParentSecond = buildFusedCandidate(
      "window-b",
      "parent-a",
      "document-a",
      "/documents/a.pdf",
    );
    firstParentSecond.evidenceContent = firstParentBest.evidenceContent;
    const secondParent = buildFusedCandidate(
      "window-c",
      "parent-b",
      "document-b",
      "/documents/b.pdf",
    );
    const thirdParent = buildFusedCandidate(
      "window-d",
      "parent-c",
      "document-c",
      "/documents/c.pdf",
    );
    const fused = [
      firstParentBest,
      firstParentSecond,
      secondParent,
      thirdParent,
    ];
    const rankings: RetrievalCandidateRankings = {
      dense: [[
        buildDenseCandidate(firstParentBest),
        buildDenseCandidate(firstParentSecond),
        buildDenseCandidate(secondParent),
      ]],
      lexical: [[
        buildLexicalCandidate(firstParentBest),
        buildLexicalCandidate(thirdParent),
      ]],
    };
    const selection = selectNonOverlappingCandidatesWithTrace(
      fused,
      2,
      "fused-order",
    );
    expect(() => buildCandidateBudgetTelemetry(
      rankings,
      [{ embedding: null, text: "telemetry query" }],
      2,
      retrievalWindowPolicy,
      selection,
      selection.selected,
    )).toThrow("exceeded the channel limit of 2");

    const telemetry = buildCandidateBudgetTelemetry(
      rankings,
      [{ embedding: null, text: "telemetry query" }],
      3,
      retrievalWindowPolicy,
      selection,
      selection.selected,
    );

    expect(telemetry).toEqual({
      allocationPolicy: "fused-order",
      admittedCandidates: [{
        admissionRank: 1,
        documentId: "document-a",
        fusedRank: 1,
        highestFusedRankForParent: 1,
        hydrated: true,
        isParentRepresentative: true,
        parentElementId: "parent-a",
        representationHits: [],
        rerankerInputRank: 1,
        retrievalWindowId: "window-a",
        sourceFile: "/documents/a.pdf",
        descriptionAffected: false,
      }, {
        admissionRank: 2,
        documentId: "document-a",
        fusedRank: 2,
        highestFusedRankForParent: 1,
        hydrated: true,
        isParentRepresentative: false,
        parentElementId: "parent-a",
        representationHits: [],
        rerankerInputRank: 2,
        retrievalWindowId: "window-b",
        sourceFile: "/documents/a.pdf",
        descriptionAffected: false,
      }],
      admittedDistinctParentCount: 1,
      admittedWindowCount: 2,
      candidateK: 2,
      fusedCandidates: [{
        admissionRank: 1,
        documentId: "document-a",
        exclusionReason: null,
        fusedRank: 1,
        fusion: {
          bm25Score: 1,
          denseDistance: 0.1,
          fusedScore: 1,
        },
        parentElementId: "parent-a",
        representationHits: [],
        representativeRetrievalWindowId: "window-a",
        retrievalWindowId: "window-a",
        sourceFile: "/documents/a.pdf",
        descriptionAffected: false,
      }, {
        admissionRank: 2,
        documentId: "document-a",
        exclusionReason: null,
        fusedRank: 2,
        fusion: {
          bm25Score: 1,
          denseDistance: 0.1,
          fusedScore: 1,
        },
        parentElementId: "parent-a",
        representationHits: [],
        representativeRetrievalWindowId: "window-b",
        retrievalWindowId: "window-b",
        sourceFile: "/documents/a.pdf",
        descriptionAffected: false,
      }, {
        admissionRank: null,
        documentId: "document-b",
        exclusionReason: "candidate-budget",
        fusedRank: 3,
        fusion: {
          bm25Score: 1,
          denseDistance: 0.1,
          fusedScore: 1,
        },
        parentElementId: "parent-b",
        representationHits: [],
        representativeRetrievalWindowId: "window-c",
        retrievalWindowId: "window-c",
        sourceFile: "/documents/b.pdf",
        descriptionAffected: false,
      }, {
        admissionRank: null,
        documentId: "document-c",
        exclusionReason: "candidate-budget",
        fusedRank: 4,
        fusion: {
          bm25Score: 1,
          denseDistance: 0.1,
          fusedScore: 1,
        },
        parentElementId: "parent-c",
        representationHits: [],
        representativeRetrievalWindowId: "window-d",
        retrievalWindowId: "window-d",
        sourceFile: "/documents/c.pdf",
        descriptionAffected: false,
      }],
      fusedDistinctParentCount: 3,
      fusedWindowCount: 4,
      hydratedDistinctParentCount: 1,
      hydratedWindowCount: 2,
      queries: [{
        channels: [{
          candidateLimit: 3,
          candidates: [{
            channelRank: 1,
            documentId: "document-a",
            fusionInputPosition: 1,
            limitDecision: "admitted",
            parentElementId: "parent-a",
            ...buildExpectedRepresentationTelemetry("window-a"),
            retrievalWindowId: "window-a",
            score: 0.1,
            sourceFile: "/documents/a.pdf",
          }, {
            channelRank: 2,
            documentId: "document-a",
            fusionInputPosition: 2,
            limitDecision: "admitted",
            parentElementId: "parent-a",
            ...buildExpectedRepresentationTelemetry("window-b"),
            retrievalWindowId: "window-b",
            score: 0.1,
            sourceFile: "/documents/a.pdf",
          }, {
            channelRank: 3,
            documentId: "document-b",
            fusionInputPosition: 3,
            limitDecision: "admitted",
            parentElementId: "parent-b",
            ...buildExpectedRepresentationTelemetry("window-c"),
            retrievalWindowId: "window-c",
            score: 0.1,
            sourceFile: "/documents/b.pdf",
          }],
          channel: "dense",
          orderingPolicy: "channel-score-then-retrieval-id-v1",
          scoreDirection: "ascending",
          scoreKind: "cosine-distance",
        }, {
          candidateLimit: 3,
          candidates: [{
            channelRank: 1,
            documentId: "document-a",
            fusionInputPosition: 1,
            limitDecision: "admitted",
            parentElementId: "parent-a",
            ...buildExpectedRepresentationTelemetry("window-a"),
            retrievalWindowId: "window-a",
            score: 1,
            sourceFile: "/documents/a.pdf",
          }, {
            channelRank: 2,
            documentId: "document-c",
            fusionInputPosition: 2,
            limitDecision: "admitted",
            parentElementId: "parent-c",
            ...buildExpectedRepresentationTelemetry("window-d"),
            retrievalWindowId: "window-d",
            score: 1,
            sourceFile: "/documents/c.pdf",
          }],
          channel: "lexical",
          orderingPolicy: "channel-score-then-retrieval-id-v1",
          scoreDirection: "descending",
          scoreKind: "bm25-relevance",
        }],
        denseDistinctParentCount: 2,
        denseWindowCount: 3,
        embeddingSha256: null,
        lexicalDistinctParentCount: 2,
        lexicalWindowCount: 2,
        queryFingerprintSha256:
          "b8f76c6aa776c4ed986c32142dfb8cc0a3d47ec40849b11977c0afc817687251",
        queryIndex: 0,
        queryKind: "original",
      }],
      retrievalWindowPolicy,
    });
  });

  it("records English-compatible admission and unsupported-language exclusions", () => {
    const retrievalWindowPolicy = createRetrievalWindowPolicyContract(
      createRetrievalWindowPolicy("structured-token-v3", 512, 2_048),
    );
    const french = buildFusedCandidate(
      "window-french",
      "parent-french",
      "document-french",
      "/documents/human-rights.pdf",
      [
        "La présente loi a pour objet de compléter la législation",
        "canadienne et de protéger le droit de tous les individus",
        "à l'égalité des chances sans pratiques discriminatoires.",
      ].join(" "),
    );
    const english = buildFusedCandidate(
      "window-english",
      "parent-english",
      "document-english",
      "/documents/human-rights.pdf",
      [
        "The purpose of this Act is to protect equal opportunity and",
        "prevent discriminatory practices within matters under",
        "Parliament's legislative authority in Canada.",
      ].join(" "),
    );
    const undetermined = buildFusedCandidate(
      "window-undetermined",
      "parent-undetermined",
      "document-undetermined",
      "/documents/human-rights.pdf",
      "§ 2",
    );
    const rankings: RetrievalCandidateRankings = {
      dense: [[
        buildDenseCandidate(french),
        buildDenseCandidate(undetermined),
        buildDenseCandidate(english),
      ]],
      lexical: [[]],
    };
    const admission = selectEnglishCandidateAdmission([
      french,
      undetermined,
      english,
    ], 2);

    const telemetry = buildCandidateBudgetTelemetry(
      rankings,
      [{ embedding: null, text: "human rights in Canada" }],
      3,
      retrievalWindowPolicy,
      admission.selection,
      admission.selection.selected,
      admission.trace,
    );

    expect(telemetry.languageAdmission).toEqual({
      admittedEnglishRepresentativeCount: 1,
      admittedUndeterminedRepresentativeCount: 1,
      englishRepresentativeCount: 1,
      fusedCandidateCount: 3,
      nonEnglishRepresentativeCount: 1,
      representativeCandidateCount: 3,
      supportedLanguage: "eng",
      undeterminedRepresentativeCount: 1,
    });
    expect(telemetry.fusedCandidates.map((candidate) => ({
      admissionRank: candidate.admissionRank,
      detectedLanguage: candidate.detectedLanguage,
      exclusionReason: candidate.exclusionReason,
      fusedRank: candidate.fusedRank,
    }))).toEqual([
      {
        admissionRank: null,
        detectedLanguage: "fra",
        exclusionReason: "unsupported-language",
        fusedRank: 1,
      },
      {
        admissionRank: 1,
        detectedLanguage: "und",
        exclusionReason: null,
        fusedRank: 2,
      },
      {
        admissionRank: 2,
        detectedLanguage: "eng",
        exclusionReason: null,
        fusedRank: 3,
      },
    ]);
  });
});

function buildFusedCandidate(
  retrievalId: string,
  parentId: string,
  documentId: string,
  sourceFile: string,
  evidenceContent: string = `Summary for ${retrievalId}`,
): FusedCandidate {
  return {
    bm25Score: 1,
    denseDistance: 0.1,
    documentId,
    evidenceContent,
    fusedScore: 1,
    parentId,
    representationHits: [],
    retrievalId,
    sourceFile,
    descriptionAffected: false,
  };
}

function buildDenseCandidate(candidate: FusedCandidate): DenseCandidate {
  return {
    distance: candidate.denseDistance ?? 0,
    documentId: candidate.documentId,
    evidenceContent: candidate.evidenceContent,
    evidenceRetrievalId: candidate.retrievalId,
    parentId: candidate.parentId,
    representation: buildExactCandidateRepresentation(
      candidate.retrievalId,
      candidate.evidenceContent,
    ),
    sourceFile: candidate.sourceFile,
  };
}

function buildLexicalCandidate(candidate: FusedCandidate): LexicalCandidate {
  return {
    bm25Score: candidate.bm25Score ?? 0,
    documentId: candidate.documentId,
    evidenceContent: candidate.evidenceContent,
    evidenceRetrievalId: candidate.retrievalId,
    parentId: candidate.parentId,
    representation: buildExactCandidateRepresentation(
      candidate.retrievalId,
      candidate.evidenceContent,
    ),
    sourceFile: candidate.sourceFile,
  };
}

function buildExpectedRepresentationTelemetry(retrievalWindowId: string) {
  const representation = buildExactCandidateRepresentation(
    retrievalWindowId,
    "unused",
  );
  return {
    representationId: representation.id,
    representationType: representation.type,
  };
}
