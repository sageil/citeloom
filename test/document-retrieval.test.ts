import { describe, expect, it } from "vitest";

import {
  allocateCandidatesByDocument,
  buildMatchedDocuments,
  selectTopRetrievedElements,
} from "../src/retrieval/document-retrieval.js";
import type { RetrievedElement } from "../src/retrieval/document-retrieval.js";
import {
  createCandidateSourceAliases,
  type FusedCandidate,
} from "../src/retrieval/ranking/rank-fusion.js";
import {
  buildRetrievedElementProvenance,
  buildSourceLocation,
} from "./source-element-fixture.js";

describe("document-aware retrieval", () => {
  it("allocates a bounded candidate pool across ranked documents", () => {
    const candidates = [
      buildCandidate("a", "1"),
      buildCandidate("a", "2"),
      buildCandidate("a", "3"),
      buildCandidate("b", "4"),
      buildCandidate("c", "5"),
    ];

    const allocated = allocateCandidatesByDocument(candidates, 5);

    expect(allocated.map((candidate) => candidate.parentId)).toEqual([
      "1".repeat(64),
      "4".repeat(64),
      "5".repeat(64),
      "2".repeat(64),
      "3".repeat(64),
    ]);
  });

  it("preserves relevance order when one document dominates the context", () => {
    const ranked = [
      buildRetrievedElement("a", "1"),
      buildRetrievedElement("a", "2"),
      buildRetrievedElement("a", "3"),
      buildRetrievedElement("a", "4"),
      buildRetrievedElement("b", "5"),
    ];

    const selected = selectTopRetrievedElements(ranked, 4);

    expect(selected).toEqual(ranked.slice(0, 4));
  });

  it("does not force a distant alternative into focused context", () => {
    const ranked: RetrievedElement[] = [];
    for (let index = 0; index < 9; index += 1) {
      ranked.push(buildRetrievedElement("a", String(index)));
    }
    ranked.push(buildRetrievedElement("b", "f"));

    const selected = selectTopRetrievedElements(ranked, 3);

    expect(selected).toEqual(ranked.slice(0, 3));
  });

  it("does not reduce context when only one document is available", () => {
    const ranked = [
      buildRetrievedElement("a", "1"),
      buildRetrievedElement("a", "2"),
      buildRetrievedElement("a", "3"),
    ];

    const selected = selectTopRetrievedElements(ranked, 2);

    expect(selected).toEqual(ranked.slice(0, 2));
  });

  it("keeps distinct retrieval windows from the same canonical source element", () => {
    const bestWindow = buildRetrievedElement("a", "1");
    bestWindow.evidenceContent = "Best matching window.";
    const secondWindow = buildRetrievedElement("a", "1");
    secondWindow.evidenceContent = "Another window from the same element.";
    secondWindow.provenance = buildRetrievedElementProvenance("f".repeat(64));
    const otherElement = buildRetrievedElement("a", "2");

    const selected = selectTopRetrievedElements([
      bestWindow,
      secondWindow,
      otherElement,
    ], 3);

    expect(selected).toEqual([bestWindow, secondWindow, otherElement]);
  });

  it("preserves overlapping evidence when the content is not exact", () => {
    const bestWindow = buildRetrievedElement("a", "1");
    bestWindow.evidenceContent = "A complete matching evidence passage.";
    const overlappingWindow = buildRetrievedElement("a", "1");
    overlappingWindow.evidenceContent = "matching evidence passage";
    const otherElement = buildRetrievedElement("a", "2");

    const selected = selectTopRetrievedElements([
      bestWindow,
      overlappingWindow,
      otherElement,
    ], 3);

    expect(selected).toEqual([bestWindow, overlappingWindow, otherElement]);
  });

  it("reports unique matched documents with retrieved element counts", () => {
    const retrieved = [
      buildRetrievedElement("a", "1"),
      buildRetrievedElement("a", "2"),
      buildRetrievedElement("b", "3"),
    ];

    expect(buildMatchedDocuments(retrieved)).toEqual([
      {
        documentId: "a".repeat(64),
        retrievedElementCount: 2,
        sourceFile: "/documents/a.pdf",
      },
      {
        documentId: "b".repeat(64),
        retrievedElementCount: 1,
        sourceFile: "/documents/b.pdf",
      },
    ]);
  });
});

function buildCandidate(
  documentCharacter: string,
  elementCharacter: string,
): FusedCandidate {
  return {
    bm25Score: 1,
    denseDistance: 0.1,
    documentId: documentCharacter.repeat(64),
    elementSetId: "e".repeat(64),
    evidenceContent: `Summary ${elementCharacter}`,
    fusedScore: 1,
    parentId: elementCharacter.repeat(64),
    representationHits: [],
    retrievalId: `${elementCharacter.repeat(63)}1`,
    sourceAliases: createCandidateSourceAliases({
      evidenceRetrievalId: `${elementCharacter.repeat(63)}1`,
      sourceFile: `/documents/${documentCharacter}.pdf`,
    }),
    sourceFile: `/documents/${documentCharacter}.pdf`,
    descriptionAffected: false,
  };
}

function buildRetrievedElement(
  documentCharacter: string,
  elementCharacter: string,
): RetrievedElement {
  return {
    distance: 0.1,
    documentVersionId: "00000000-0000-4000-8000-000000000001",
    element: {
      content: `Content ${elementCharacter}`,
      documentId: documentCharacter.repeat(64),
      id: elementCharacter.repeat(64),
      detectedTypes: ["paragraph"],
      kind: "text",
      ...buildSourceLocation(1),
      sourceFile: `/documents/${documentCharacter}.pdf`,
    },
    evidenceContent: `Summary ${elementCharacter}`,
    provenance: buildRetrievedElementProvenance(
      `${elementCharacter.repeat(63)}1`,
    ),
  };
}
