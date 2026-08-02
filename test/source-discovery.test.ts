import { describe, expect, it } from "vitest";

import type { SourceDiscoveryConfig } from "../src/config/index.js";
import type { RetrievedElement } from "../src/retrieval/document-retrieval.js";
import type { SourceElement } from "../src/domain/source-elements.js";
import {
  buildSourceDiscoveryResponse,
  createSourceExcerpt,
  type KeywordDiscoveryMatch,
} from "../src/retrieval/discovery/model.js";
import type { SourceDiscoveryRequest } from "../src/retrieval/discovery/schema.js";
import {
  buildRetrievedElementProvenance,
  buildSourceLocation,
} from "./source-element-fixture.js";

describe("source discovery presentation", () => {
  it("groups keyword passages by document and excludes them from related results", () => {
    const keywordElement = buildElement("a", "1", "A mortgage is a secured loan.");
    const secondKeywordElement = buildElement("a", "2", "Loan repayment terms apply.");
    const relatedElement = buildElement("b", "3", "Mortgage financing is available.");
    const keywordMatches: KeywordDiscoveryMatch[] = [
      buildKeywordMatch(keywordElement, 2),
      buildKeywordMatch(secondKeywordElement, 2),
    ];
    const response = buildSourceDiscoveryResponse({
      keyword: { status: "complete", warning: null },
      keywordPage: { matches: keywordMatches, totalDocuments: 1 },
      lexicalDocumentKeys: new Set([createDocumentKey(keywordElement)]),
      related: { status: "complete", warning: null },
      relatedElements: [
        buildRetrievedElement(keywordElement),
        buildRetrievedElement(relatedElement),
      ],
      request: buildRequest(),
      settings: buildSettings(),
    });

    expect(response.keyword.documents).toHaveLength(1);
    expect(response.keyword.documents[0]).toMatchObject({
      documentId: "a".repeat(64),
      matchingPassageCount: 2,
      matchKinds: ["keyword", "semantic"],
    });
    expect(response.keyword.documents[0]?.passages).toHaveLength(2);
    expect(response.related.documents.map((document) => document.documentId)).toEqual([
      "b".repeat(64),
    ]);
  });

  it("limits related documents and representative passages deterministically", () => {
    const relatedElements: RetrievedElement[] = [];
    for (let index = 0; index < 5; index += 1) {
      relatedElements.push(buildRetrievedElement(buildElement(
        index < 4 ? "a" : "b",
        String(index),
        `Related passage ${index}`,
      )));
    }
    const request = buildRequest();
    const response = buildSourceDiscoveryResponse({
      keyword: { status: "complete", warning: null },
      keywordPage: { matches: [], totalDocuments: 0 },
      lexicalDocumentKeys: new Set(),
      related: { status: "complete", warning: null },
      relatedElements,
      request,
      settings: buildSettings({ resultsPerGroup: 1 }),
    });

    expect(response.related.documents).toHaveLength(1);
    expect(response.related.documents[0]?.matchingPassageCount).toBe(4);
    expect(response.related.documents[0]?.passages).toHaveLength(3);
  });

  it("centers a long excerpt near the query", () => {
    const element = buildElement(
      "a",
      "1",
      `${"Opening context. ".repeat(30)}mortgage financing appears here.${" Closing context.".repeat(20)}`,
    );

    const excerpt = createSourceExcerpt(element, "retrieval evidence", "mortgage");

    expect(excerpt).toContain("mortgage financing appears here");
    expect(excerpt.length).toBeLessThanOrEqual(366);
    expect(excerpt.startsWith("...")).toBe(true);
    expect(excerpt.endsWith("...")).toBe(true);
  });

  it("returns a renderable excerpt when source text and retrieval evidence are blank", () => {
    const element = buildElement("a", "1", "   ");

    expect(createSourceExcerpt(element, " ", "loan")).toBe(
      "Source excerpt unavailable.",
    );
  });
});

function buildRequest(
  overrides: Partial<SourceDiscoveryRequest> = {},
): SourceDiscoveryRequest {
  return {
    includeRelated: true,
    keywordPage: 1,
    query: "loan",
    scope: { kind: "all" },
    ...overrides,
  };
}

function buildSettings(
  overrides: Partial<SourceDiscoveryConfig> = {},
): SourceDiscoveryConfig {
  return {
    passagesPerDocument: 3,
    resultsPerGroup: 10,
    ...overrides,
  };
}

function buildElement(
  documentCharacter: string,
  elementCharacter: string,
  content: string,
): SourceElement {
  return {
    content,
    documentId: documentCharacter.repeat(64),
    id: elementCharacter.repeat(64),
    detectedTypes: ["paragraph"],
    kind: "text",
    ...buildSourceLocation(2),
    sourceFile: `/documents/${documentCharacter}.pdf`,
  };
}

function buildKeywordMatch(
  element: SourceElement,
  matchingPassageCount: number,
): KeywordDiscoveryMatch {
  return {
    element,
    evidenceContent: "Exact retrieval evidence.",
    matchingPassageCount,
  };
}

function buildRetrievedElement(element: SourceElement): RetrievedElement {
  return {
    distance: 0.2,
    documentVersionId: "00000000-0000-4000-8000-000000000001",
    element,
    evidenceContent: "A semantically related retrieval passage.",
    provenance: buildRetrievedElementProvenance(element.id),
  };
}

function createDocumentKey(element: SourceElement): string {
  return `${element.documentId}\u0000${element.sourceFile}`;
}
