import { describe, expect, it } from "vitest";

import { resolveDocumentQueryScope } from "../src/documents/catalog/query-scope.js";
import type { IndexedDocument } from "../src/documents/catalog/model.js";

describe("document query scope", () => {
  it("returns every unique available source for an all-documents scope", () => {
    const documents = [
      buildDocument("a", "/documents/a.pdf"),
      buildDocument("b", "/documents/b.pdf"),
      buildDocument("c", "/documents/a.pdf"),
    ];

    expect(resolveDocumentQueryScope(
      { kind: "all" },
      "embedding-space",
      documents,
    )).toEqual([
      { documentId: "a", sourceFile: "/documents/a.pdf" },
      { documentId: "b", sourceFile: "/documents/b.pdf" },
    ]);
  });

  it("resolves requested document IDs once and preserves request order", () => {
    const documents = [
      buildDocument("a", "/documents/a.pdf"),
      buildDocument("b", "/documents/b.pdf"),
    ];

    expect(resolveDocumentQueryScope(
      { documentIds: ["b", "a", "b"], kind: "documentIds" },
      "embedding-space",
      documents,
    )).toEqual([
      { documentId: "b", sourceFile: "/documents/b.pdf" },
      { documentId: "a", sourceFile: "/documents/a.pdf" },
    ]);
  });

  it("rejects unavailable requested document IDs", () => {
    expect(() => resolveDocumentQueryScope(
      { documentIds: ["missing"], kind: "documentIds" },
      "embedding-space",
      [buildDocument("a", "/documents/a.pdf")],
    )).toThrow(
      "Document is not indexed in embedding space embedding-space: missing",
    );
  });

  it("resolves source files once and preserves request order", () => {
    const documents = [
      buildDocument("a", "/documents/a.pdf"),
      buildDocument("b", "/documents/b.pdf"),
    ];

    expect(resolveDocumentQueryScope(
      {
        kind: "sourceFiles",
        sourceFiles: ["/documents/b.pdf", "/documents/a.pdf", "/documents/b.pdf"],
      },
      "embedding-space",
      documents,
    )).toEqual([
      { documentId: "b", sourceFile: "/documents/b.pdf" },
      { documentId: "a", sourceFile: "/documents/a.pdf" },
    ]);
  });

  it("rejects unavailable requested source files", () => {
    expect(() => resolveDocumentQueryScope(
      { kind: "sourceFiles", sourceFiles: ["/documents/missing.pdf"] },
      "embedding-space",
      [buildDocument("a", "/documents/a.pdf")],
    )).toThrow(
      "Source is not indexed in embedding space embedding-space: /documents/missing.pdf",
    );
  });

  it("matches any normalized requested tag", () => {
    const documents = [
      buildDocument("a", "/documents/a.pdf", ["legal"]),
      buildDocument("b", "/documents/b.pdf", ["veterinary"]),
      buildDocument("c", "/documents/c.pdf", ["finance"]),
    ];

    expect(resolveDocumentQueryScope(
      { kind: "tags", tags: [" Legal ", "VETERINARY", "legal"] },
      "embedding-space",
      documents,
    )).toEqual([
      { documentId: "a", sourceFile: "/documents/a.pdf" },
      { documentId: "b", sourceFile: "/documents/b.pdf" },
    ]);
  });

  it("rejects empty or unmatched tag scopes", () => {
    const documents = [
      buildDocument("a", "/documents/a.pdf", ["legal"]),
    ];

    expect(() => resolveDocumentQueryScope(
      { kind: "tags", tags: [" "] },
      "embedding-space",
      documents,
    )).toThrow("At least one non-empty tag is required.");
    expect(() => resolveDocumentQueryScope(
      { kind: "tags", tags: ["veterinary"] },
      "embedding-space",
      documents,
    )).toThrow(
      "No documents in embedding space embedding-space match tags: veterinary",
    );
  });
});

function buildDocument(
  documentId: string,
  sourceFile: string,
  tags: string[] = [],
): IndexedDocument {
  return {
    documentId,
    elementSetId: `${documentId}-elements`,
    generationId: "00000000-0000-4000-8000-000000000001",
    images: 0,
    indexedAt: "2026-08-04T00:00:00.000Z",
    pageCount: 1,
    sourceFile,
    tables: 0,
    tags,
    textChunks: 1,
    totalElements: 1,
    versionId: "00000000-0000-4000-8000-000000000002",
  };
}
