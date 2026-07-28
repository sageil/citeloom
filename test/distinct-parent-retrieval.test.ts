import { MockRerankingModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { InferenceMetricsReporter } from "../src/inference/metrics.js";
import {
  createCandidateParentKey,
  selectNonOverlappingCandidates,
  type RetrievedElement,
} from "../src/retrieval/document-retrieval.js";
import { selectRerankingCandidates } from "../src/retrieval/indexing/query-store.js";
import type { FusedCandidate } from "../src/retrieval/ranking/rank-fusion.js";
import { rerankRetrievedElementsWithResponse } from "../src/retrieval/ranking/reranker.js";
import {
  buildRetrievedElementProvenance,
  buildSourceLocation,
} from "./source-element-fixture.js";

describe("non-overlapping candidate budgeting", () => {
  it("admits distinct windows from the same parent", () => {
    const parentABest = buildCandidate("window-a1", "parent-a");
    const parentASecond = buildCandidate("window-a2", "parent-a");
    const parentB = buildCandidate("window-b1", "parent-b");

    const selected = selectNonOverlappingCandidates([
      parentABest,
      parentASecond,
      parentB,
    ], 2);

    expect(selected).toEqual([parentABest, parentASecond]);
  });

  it("keeps the highest fused representative and stable relative order", () => {
    const parentBBest = buildCandidate("window-b1", "parent-b");
    const parentABest = buildCandidate("window-a1", "parent-a");
    const parentBSecond = buildCandidate("window-b2", "parent-b");
    const parentASecond = buildCandidate("window-a2", "parent-a");
    const parentC = buildCandidate("window-c1", "parent-c");

    const selected = selectNonOverlappingCandidates([
      parentBBest,
      parentABest,
      parentBSecond,
      parentASecond,
      parentC,
    ], 3);

    expect(selected.map((candidate) => candidate.retrievalId)).toEqual([
      "window-b1",
      "window-a1",
      "window-b2",
    ]);
  });

  it("removes contained evidence within one document and source", () => {
    const first = buildCandidate(
      "window-a",
      "shared-parent",
      "document-a",
      "/documents/a.pdf",
    );
    const duplicate = buildCandidate(
      "window-a2",
      "shared-parent",
      "document-a",
      "/documents/a.pdf",
      first.evidenceContent,
    );
    const otherDocument = buildCandidate(
      "window-b",
      "shared-parent",
      "document-b",
      "/documents/a.pdf",
    );
    const otherSourceFile = buildCandidate(
      "window-c",
      "shared-parent",
      "document-a",
      "/documents/c.pdf",
    );

    const selected = selectNonOverlappingCandidates([
      first,
      duplicate,
      otherDocument,
      otherSourceFile,
    ], 4);

    expect(selected).toEqual([first, otherDocument, otherSourceFile]);
    const parentKeys = selected.map(createCandidateParentKey);
    expect(new Set(parentKeys).size).toBe(3);
  });

  it("never exceeds the limit and fills it when enough parents exist", () => {
    const ranked = [
      buildCandidate("window-a1", "parent-a"),
      buildCandidate("window-a2", "parent-a"),
      buildCandidate("window-b1", "parent-b"),
      buildCandidate("window-c1", "parent-c"),
      buildCandidate("window-d1", "parent-d"),
    ];

    const selected = selectNonOverlappingCandidates(ranked, 3);

    expect(selected).toHaveLength(3);
    expect(selected.map((candidate) => candidate.parentId)).toEqual([
      "parent-a",
      "parent-a",
      "parent-b",
    ]);
  });

  it("preserves global fused order for broad-document questions", () => {
    const first = buildCandidate(
      "window-a1",
      "parent-a",
      "document-a",
      "/documents/Prometheus Rising.pdf",
    );
    const second = buildCandidate(
      "window-a2",
      "parent-b",
      "document-a",
      "/documents/Prometheus Rising.pdf",
    );
    const otherDocument = buildCandidate(
      "window-b1",
      "parent-c",
      "document-b",
      "/documents/Other.pdf",
    );

    const selected = selectRerankingCandidates(
      "What is Prometheus Rising?",
      [first, second, otherDocument],
      2,
    );

    expect(selected).toEqual([first, second]);
  });

  it("preserves document allocation after parent representatives are selected", () => {
    const documentAFirst = buildCandidate(
      "window-a1",
      "parent-a1",
      "document-a",
      "/documents/a.pdf",
    );
    const documentAFirstDuplicate = buildCandidate(
      "window-a1-duplicate",
      "parent-a1",
      "document-a",
      "/documents/a.pdf",
      documentAFirst.evidenceContent,
    );
    const documentASecond = buildCandidate(
      "window-a2",
      "parent-a2",
      "document-a",
      "/documents/a.pdf",
    );
    const documentBFirst = buildCandidate(
      "window-b1",
      "parent-b1",
      "document-b",
      "/documents/b.pdf",
    );

    const selected = selectRerankingCandidates(
      "Which passages matter?",
      [
        documentAFirst,
        documentAFirstDuplicate,
        documentASecond,
        documentBFirst,
      ],
      3,
    );

    expect(selected).toEqual([
      documentAFirst,
      documentBFirst,
      documentASecond,
    ]);
  });

  it("sends distinct same-parent evidence to the reranker", async () => {
    const parentABest = buildCandidate("window-a1", "parent-a");
    const parentASecond = buildCandidate("window-a2", "parent-a");
    const parentB = buildCandidate("window-b1", "parent-b");
    const selected = selectRerankingCandidates(
      "Which passages matter?",
      [parentABest, parentASecond, parentB],
      2,
    );
    const hydrated = selected.map(buildRetrievedElement);
    const model = new MockRerankingModelV4({
      doRerank: async (options) => {
        if (options.documents.type !== "text") {
          throw new Error("Expected text reranker documents.");
        }
        expect(options.documents.values).toHaveLength(2);
        expect(options.documents.values[0]).toContain("Summary for window-a1");
        expect(options.documents.values[1]).toContain("Summary for window-a2");
        return {
          ranking: [
            { index: 0, relevanceScore: 0.9 },
            { index: 1, relevanceScore: 0.8 },
          ],
        };
      },
    });

    await rerankRetrievedElementsWithResponse(
      {
        metrics: new InferenceMetricsReporter({ enabled: false }),
        model,
        timeoutMs: 1_000,
      },
      "Which passages matter?",
      hydrated,
      2,
    );
  });
});

function buildCandidate(
  retrievalId: string,
  parentId: string,
  documentId = "document-a",
  sourceFile = "/documents/a.pdf",
  evidenceContent = `Summary for ${retrievalId}`,
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

function buildRetrievedElement(candidate: FusedCandidate): RetrievedElement {
  return {
    distance: candidate.denseDistance,
    documentVersionId: "00000000-0000-4000-8000-000000000001",
    element: {
      content: `Content for ${candidate.parentId}`,
      documentId: candidate.documentId,
      id: candidate.parentId,
      detectedTypes: ["paragraph"],
      kind: "text",
      ...buildSourceLocation(1),
      sourceFile: candidate.sourceFile,
    },
    evidenceContent: candidate.evidenceContent,
    provenance: buildRetrievedElementProvenance(candidate.retrievalId),
  };
}
