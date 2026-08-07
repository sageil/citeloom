import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  readDocumentCatalog,
  registerPage,
} from "../web/assets/scripts/citeloom-documents.js";

describe("CiteLoom document ingestion controls", () => {
  it("uses the stage-aware indexing presenter in the document inspector", () => {
    let pageFactory = null;
    registerPage({
      data(name, factory) {
        expect(name).toBe("citeloomDocumentsPage");
        pageFactory = factory;
      },
    });
    const page = pageFactory();
    const document = {
      displayStatus: "running",
      embeddingProgress: {
        completedElements: 2,
        state: "in-progress",
        totalElements: 5,
      },
      images: 0,
      indexingActivity: "embedding",
      mediaDescriptionProgress: {
        completedImages: 0,
        completedTables: 0,
      },
      tables: 0,
      totalElements: 5,
    };

    expect(page.indexingActivityDetail(document)).toBe(
      "2 of 5 elements indexed",
    );
    expect(page.indexingProgressDeterminate(document)).toBe(true);
    expect(page.indexingProgressStyle(document)).toBe("width: 40%");
    expect(page.indexingProgressDeterminate({
      ...document,
      indexingActivity: "building_outline",
    })).toBe(false);
  });

  it("does not create indexing activity bindings for pre-indexing documents", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/documents.html", import.meta.url),
      "utf8",
    );

    expect(fragment).toContain(
      '<template x-if="indexingProgressVisible(selectedDocument)">',
    );
    expect(fragment).not.toContain(
      'x-show="indexingProgressVisible(selectedDocument)"',
    );
  });

  it("shows controls to administrators and to the uploader", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/documents.html", import.meta.url),
      "utf8",
    );

    expect(fragment).toContain(
      "(currentRole === 'admin' || (currentUserId !== null &amp;&amp; selectedDocument.uploadedByUserId === currentUserId))",
    );
  });

  it("requires a durable activity for an indexing catalog entry", () => {
    const catalog = buildIndexingCatalog("building_outline");

    expect(readDocumentCatalog(catalog).documents[0]?.indexingActivity).toBe(
      "building_outline",
    );
    expect(() => readDocumentCatalog(buildIndexingCatalog(null))).toThrow(
      "Indexing activity does not match the document phase.",
    );
  });

  it("uses the document management action layout for ingestion controls", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/documents.html", import.meta.url),
      "utf8",
    );
    const actionLayoutMatches = fragment.match(
      /class="inspector-management-actions inspector-control-actions"/g,
    );

    expect(actionLayoutMatches).toHaveLength(2);
    expect(fragment).toMatch(
      /class="button secondary"[\s\S]*?Pause ingestion/,
    );
    expect(fragment).toMatch(
      /class="button danger"[\s\S]*?Cancel ingestion/,
    );
    expect(fragment).toContain(
      "This stops the reindex and keeps the current version available.",
    );
  });
});

function buildIndexingCatalog(indexingActivity) {
  const document = {
    activeDocumentId: null,
    activeVersionId: null,
    attemptCount: 0,
    byteLength: 4_096,
    controlError: null,
    controlState: "active",
    displayStatus: "running",
    documentId: "a".repeat(64),
    embeddingProgress: {
      completedElements: 16,
      state: "in-progress",
      totalElements: 32,
    },
    embeddingSpaceIds: [],
    errorMessage: null,
    images: 1,
    indexingActivity,
    maxAttempts: 3,
    mediaDescriptionProgress: {
      completedImages: 1,
      completedTables: 1,
    },
    nextAttemptAt: "2026-08-07T12:00:00.000Z",
    pageCount: 3,
    phase: "normalized",
    queryStatus: "running",
    sourceFile: "/documents/report.pdf",
    status: "running",
    tables: 1,
    tags: [],
    textChunks: 30,
    totalElements: 32,
    updatedAt: "2026-08-07T12:00:00.000Z",
    uploadedByUserId: null,
  };
  const facets = {
    failed: 0,
    pending: 0,
    processing: 1,
    queryable: 0,
    queryableTags: [],
    ready: 0,
    reindexRequired: 0,
    running: 1,
    tags: [],
    total: 1,
    untagged: 1,
    uploads: 0,
  };
  return {
    attention: { documents: [document], total: 1 },
    documents: [document],
    facets,
    page: 1,
    pageSize: 25,
    total: 1,
  };
}
