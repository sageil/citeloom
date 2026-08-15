import { describe, expect, it } from "vitest";

import type { SourceDiscoveryConfig } from "../src/config/index.js";
import type { RetrievedElement } from "../src/retrieval/document-retrieval.js";
import type { SourceElement } from "../src/domain/source-elements.js";
import {
  buildExactAndRelatedSourceDiscoveryResponse,
  buildKeywordSourceDiscoveryResponse,
  createSourceExcerpt,
  type KeywordDiscoveryMatch,
} from "../src/retrieval/discovery/model.js";
import type { RepresentationHit } from "../src/retrieval/ranking/rank-fusion.js";
import type { SourceDiscoveryRequest } from "../src/retrieval/discovery/boundary.js";
import {
  buildRetrievedElementProvenance,
  buildSourceLocation,
} from "./source-element-fixture.js";

describe("source discovery presentation", () => {
  it("groups exhaustive keyword passages by document", () => {
    const keywordElement = buildElement("a", "1", "A mortgage is a secured loan.");
    const secondKeywordElement = buildElement("a", "2", "Loan repayment terms apply.");
    const keywordMatches: KeywordDiscoveryMatch[] = [
      buildKeywordMatch(keywordElement, 2),
      buildKeywordMatch(secondKeywordElement, 2),
    ];
    const response = buildKeywordSourceDiscoveryResponse({
      keywordPage: { matches: keywordMatches, totalDocuments: 1 },
      request: buildRequest(),
      settings: buildSettings(),
    });

    if (response.results.kind !== "exact") {
      throw new Error("Expected exact discovery results.");
    }
    expect(response.results.documents).toHaveLength(1);
    expect(response.results.documents[0]).toMatchObject({
      documentId: "a".repeat(64),
      matchingPassageCount: 2,
    });
    expect(response.results.documents[0]?.passages).toHaveLength(2);
    expect(response.results.documents[0]?.passages.map((passage) => (
      passage.matchKind
    ))).toEqual(["keyword", "keyword"]);
  });

  it("separates exact and related passages and removes cross-lane duplicates", () => {
    const lexicalElement = buildElement("a", "1", "Criminal law passage.");
    const semanticElement = buildElement("a", "2", "Trafficking passage.");
    const secondDocument = buildElement("b", "3", "Another semantic passage.");
    const response = buildExactAndRelatedSourceDiscoveryResponse({
      keywordPage: {
        matches: [buildKeywordMatch(lexicalElement, 1)],
        totalDocuments: 1,
      },
      matchedElements: [
        buildRetrievedElement(lexicalElement, ["dense"]),
        buildRetrievedElement(semanticElement, ["dense"]),
        buildRetrievedElement(secondDocument, ["dense"]),
      ],
      request: buildRequest(),
      reviewedPassageCount: 7,
      settings: buildSettings(),
    });

    if (response.results.kind !== "exact-and-related") {
      throw new Error("Expected separated exact and related discovery results.");
    }
    expect(response.results.exact.documents[0]?.passages[0]).toMatchObject({
      id: "1".repeat(64),
      matchKind: "keyword",
    });
    expect(response.results.related.documents.map((document) => document.documentId)).toEqual([
      "a".repeat(64),
      "b".repeat(64),
    ]);
    expect(response.results.related.documents[0]).toMatchObject({
      matchingPassageCount: 1,
    });
    expect(response.results.related.documents[0]?.passages).toEqual([
      expect.objectContaining({
        id: "2".repeat(64),
        matchKind: "semantic",
      }),
    ]);
    expect(response.results.related).toMatchObject({
      matchedPassageCount: 2,
      reviewedPassageCount: 7,
    });
  });

  it("applies configured ranked document and passage limits after ranking", () => {
    const rankedElements: RetrievedElement[] = [];
    for (let index = 0; index < 5; index += 1) {
      rankedElements.push(buildRetrievedElement(
        buildElement(
          index < 4 ? "a" : "b",
          String(index),
          `Related passage ${index}`,
        ),
        ["dense"],
      ));
    }
    const request = buildRequest();
    const response = buildExactAndRelatedSourceDiscoveryResponse({
      keywordPage: { matches: [], totalDocuments: 0 },
      matchedElements: rankedElements,
      request,
      reviewedPassageCount: 5,
      settings: buildSettings({ resultsPerGroup: 1 }),
    });

    if (response.results.kind !== "exact-and-related") {
      throw new Error("Expected separated exact and related discovery results.");
    }
    expect(response.results.related.documents).toHaveLength(1);
    expect(response.results.related.documents[0]?.matchingPassageCount).toBe(4);
    expect(response.results.related.documents[0]?.passages).toHaveLength(3);
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

function buildRetrievedElement(
  element: SourceElement,
  channels: RepresentationHit["channel"][],
): RetrievedElement {
  const provenance = buildRetrievedElementProvenance(element.id);
  provenance.representationHits = channels.map((channel, index) => ({
    channel,
    queryIndex: 0,
    rank: index + 1,
    representationId: element.id,
    representationType: "exact-window",
  }));
  return {
    distance: 0.2,
    documentVersionId: "00000000-0000-4000-8000-000000000001",
    element,
    evidenceContent: "A semantically related retrieval passage.",
    provenance,
  };
}
