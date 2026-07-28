import { describe, expect, it } from "vitest";

import type { TextElement } from "../src/domain/source-elements.js";
import {
  buildRetrievalElementEmbeddingText,
  countRetrievalEmbeddingInputTokens,
} from "../src/retrieval/windows.js";
import {
  linkRetrievalRepresentationNeighbors,
  splitRetrievalRepresentationAtTokenLimit,
  type RetrievalRepresentation,
} from "../src/retrieval/representations.js";
import { buildSourceLocation } from "./source-element-fixture.js";

describe("retrieval representation splitting", () => {
  it("gives repeated split pieces unique identities and neighbor links", () => {
    const content = "repeat ".repeat(30).trim();
    const element = buildTextElement(content);
    const representation = buildRepresentation(element);
    const split = splitRetrievalRepresentationAtTokenLimit(
      representation,
      element,
      "plain",
      12,
    );
    const linked = linkRetrievalRepresentationNeighbors(split);

    expect(linked.length).toBeGreaterThan(2);
    expect(new Set(linked.map((piece) => piece.id)).size).toBe(linked.length);
    expect(linked.map((piece) => piece.content).join(" ")).toBe(content);
    expect(linked.every((piece) => (
      countRetrievalEmbeddingInputTokens(piece.content, element, "plain") <= 12
    ))).toBe(true);
    expect(linked[0]?.previousRetrievalId).toBeNull();
    expect(linked[0]?.nextRetrievalId).toBe(linked[1]?.id);
    expect(linked.at(-1)?.nextRetrievalId).toBeNull();
    expect(linked.at(-1)?.previousRetrievalId).toBe(linked.at(-2)?.id);
  });
});

function buildTextElement(content: string): TextElement {
  return {
    content,
    documentId: "a".repeat(64),
    id: "b".repeat(64),
    detectedTypes: ["paragraph"],
    kind: "text",
    ...buildSourceLocation(1),
    sourceFile: "/tmp/repeated.txt",
  };
}

function buildRepresentation(
  element: TextElement,
): RetrievalRepresentation {
  return {
    content: element.content,
    documentId: element.documentId,
    embeddingContent: element.content,
    embeddingText: buildRetrievalElementEmbeddingText(
      element.content,
      element,
    ),
    id: "c".repeat(64),
    kind: "text",
    nextRetrievalId: null,
    pageNumber: element.pageNumber,
    parentId: element.id,
    parentOrdinal: 0,
    partOrdinal: 0,
    policyFingerprint: "d".repeat(64),
    policyId: "citeloom/retrieval-window:structured-token-v3",
    previousRetrievalId: null,
    sourceFile: element.sourceFile,
    type: "exact-window",
  };
}
