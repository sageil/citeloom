import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerPage,
} from "../web/assets/scripts/documents.js";
import { readDocumentCatalog } from "../web/assets/scripts/document-catalog-boundary.js";
import {
  findHtmlElementByAttribute,
  htmlElementHasClass,
  readHtmlElements,
} from "./html-test-helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it("shows ingestion controls to library managers and to the uploader", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/documents.html", import.meta.url),
      "utf8",
    );

    expect(fragment).toContain(
      "(canManageDocument(selectedDocument) || (currentUserId !== null &amp;&amp; selectedDocument.uploadedByUserId === currentUserId))",
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
    const elements = readHtmlElements(fragment);
    const actionLayouts = elements.filter((element) => {
      return htmlElementHasClass(element, "inspector-control-actions");
    });
    const pauseButton = findHtmlElementByAttribute(
      elements,
      "@click",
      "controlIngestion(selectedDocument, 'pause')",
    );
    const cancelButton = findHtmlElementByAttribute(
      elements,
      "@click",
      "actionConfirmation = 'cancel-ingestion'",
    );

    expect(actionLayouts).toHaveLength(2);
    expect(pauseButton.tagName).toBe("button");
    expect(htmlElementHasClass(pauseButton, "secondary")).toBe(true);
    expect(cancelButton.tagName).toBe("button");
    expect(htmlElementHasClass(cancelButton, "danger")).toBe(true);
    expect(fragment).toContain(
      "This stops the reindex and keeps the current version available.",
    );
  });

  it("loads and highlights the shared source selected by administration", async () => {
    const libraryId = "00000000-0000-4000-8000-000000000501";
    vi.stubGlobal("window", {
      location: { search: `?view=documents&source-library=${libraryId}` },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        {
          access: "manage",
          id: "00000000-0000-4000-8000-000000000500",
          kind: "private",
          name: "DefaultSpace",
        },
        {
          access: "manage",
          id: libraryId,
          kind: "shared",
          name: "Common Sources",
        },
      ]), {
        headers: { "content-type": "application/json" },
        status: 200,
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify(buildEmptyCatalog()), {
        headers: { "content-type": "application/json" },
        status: 200,
      }));
    vi.stubGlobal("fetch", fetchMock);
    const page = createDocumentsPage();

    await expect(page.loadSourceLibraryContext()).resolves.toBe(true);
    await page.loadCatalog();

    expect(page.sourceLibraryId).toBe(libraryId);
    expect(page.sharedSourceLibraries).toEqual([{
      access: "manage",
      id: libraryId,
      kind: "shared",
      name: "Common Sources",
    }]);
    expect(page.canManageDocument({ sourceLibraryId: libraryId })).toBe(true);
    expect(page.canManageDocument({
      sourceLibraryId: "00000000-0000-4000-8000-000000000599",
    })).toBe(false);
    const catalogUrl = new URL(fetchMock.mock.calls[1][0], "https://localhost");
    expect(catalogUrl.searchParams.get("sourceLibraryId")).toBe(libraryId);
  });

  it("keeps shared sources separate from document collections", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/documents.html", import.meta.url),
      "utf8",
    );

    expect(fragment).toContain(">Shared sources</p>");
    expect(fragment).toContain("sharedSourceLibraries");
    expect(fragment).toContain("selectSharedSource(library.id)");
    expect(fragment).not.toContain("Add documents");
    expect(fragment).not.toContain("Workspace access");
    expect(fragment).not.toContain("Private collections");
  });
});

function createDocumentsPage() {
  let pageFactory = null;
  registerPage({
    data(_name, factory) {
      pageFactory = factory;
    },
  });
  return pageFactory();
}

function buildEmptyCatalog() {
  return {
    attention: { documents: [], total: 0 },
    documents: [],
    facets: {
      failed: 0,
      pending: 0,
      processing: 0,
      queryable: 0,
      queryableTags: [],
      ready: 0,
      reindexRequired: 0,
      running: 0,
      tags: [],
      total: 0,
      untagged: 0,
      uploads: 0,
    },
    page: 1,
    pageSize: 25,
    total: 0,
  };
}

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
    sourceLibraryId: "00000000-0000-4000-8000-000000000501",
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
