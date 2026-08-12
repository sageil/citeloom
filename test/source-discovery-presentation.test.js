import { describe, expect, it } from "vitest";

import {
  registerPage,
} from "../web/assets/scripts/ask.js";
import { readDiscoveryResponse } from "../web/assets/scripts/ask-schema.js";

describe("source discovery browser presentation", () => {
  it("presents exact and related lanes with passage-level provenance", () => {
    const response = readDiscoveryResponse({
      query: "criminal",
      results: {
        exact: {
          documents: [buildDocument("a", "b", "keyword")],
          page: 2,
          pageSize: 10,
          totalDocuments: 24,
        },
        kind: "exact-and-related",
        related: {
          documents: [
            buildDocument("a", "b", "semantic"),
            buildDocument("c", "d", "semantic"),
          ],
          limit: 12,
          matchedPassageCount: 2,
          reviewedPassageCount: 20,
        },
      },
    });
    const page = createPage();
    page.discoveryResult = response;

    const groups = page.discoveryGroups();
    expect(groups.map((group) => group.title)).toEqual([
      "Exact matches",
      "Related by meaning",
    ]);
    expect(groups[0].entries[0].rank).toBe(11);
    expect(groups[1].entries).toHaveLength(1);
    expect(groups[1].entries[0].document.documentId).toBe("c".repeat(64));
    expect(groups[1].entries[0].document.passages[0].matchKind).toBe("semantic");
    expect(page.discoveryExcerptSegments(
      groups[1].entries[0].document.passages[0],
    )).toEqual([{
      highlighted: false,
      key: `${"d".repeat(64)}:0`,
      text: "A relevant excerpt.",
    }]);
    expect(page.discoveryOrderLabel()).toBe(
      "Exact matches first, then related by meaning",
    );
    expect(page.discoverySummary()).toBe(
      "24 exact-match documents and 1 related document.",
    );
    expect(page.discoveryTotalPages()).toBe(3);
  });

  it("paginates exhaustive exact results", () => {
    const response = readDiscoveryResponse({
      query: "criminal",
      results: {
        documents: [buildDocument("a", "b", "keyword")],
        kind: "exact",
        page: 2,
        pageSize: 10,
        totalDocuments: 24,
      },
    });
    const page = createPage();
    page.discoveryResult = response;

    expect(page.discoveryDocumentRank("exact", 0)).toBe(11);
    expect(page.discoveryPageNumbers()).toEqual([1, 2, 3]);
    expect(page.discoveryPageSummary()).toBe(
      "Showing 11-20 of 24 exact matches",
    );
    expect(page.discoverySummary()).toBe("24 exact-match documents.");
  });
});

function createPage() {
  let pageFactory;
  registerPage({
    data(_name, factory) {
      pageFactory = factory;
    },
  });
  if (pageFactory === undefined) {
    throw new Error("Ask page registration did not provide a page factory.");
  }
  return pageFactory();
}

function buildDocument(documentCharacter, passageCharacter, matchKind) {
  return {
    documentId: documentCharacter.repeat(64),
    matchingPassageCount: 1,
    passages: [{
      excerpt: "A relevant excerpt.",
      id: passageCharacter.repeat(64),
      kind: "text",
      matchKind,
      pageNumbers: [2],
      regions: [],
      sectionPath: ["Section"],
    }],
    sourceFile: "/documents/source.pdf",
  };
}
