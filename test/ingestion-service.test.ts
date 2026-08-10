import { describe, expect, it, vi } from "vitest";

import type { PublishedDocument } from "../src/documents/catalog/index.js";
import { readStoredReindexSource } from "../src/ingestion/service.js";
import type {
  StoredSourceDocumentReference,
} from "../src/documents/storage/source-content-store.js";

describe("stored document reindex source", () => {
  it("reuses persisted bytes without resolving the historical source path", async () => {
    const indexedDocument = buildIndexedDocument(
      "/Users/example/project/documents/legal/interpretation-act.pdf",
    );
    const storedDocument: StoredSourceDocumentReference = {
      byteLength: 23,
      documentId: indexedDocument.documentId,
      openContent: async () => {
        throw new Error("Content should not be opened by source discovery.");
      },
    };
    const readDocumentReference = vi.fn(async () => storedDocument);

    await expect(readStoredReindexSource(
      { readDocumentReference },
      indexedDocument,
      1_024,
    )).resolves.toEqual({
      ...storedDocument,
      ...indexedDocument.format,
      kind: "file",
      sourceFile: indexedDocument.sourceFile,
    });
    expect(readDocumentReference).toHaveBeenCalledOnce();
    expect(readDocumentReference).toHaveBeenCalledWith(indexedDocument.documentId);
  });

  it("preserves the configured document size limit for stored sources", async () => {
    const indexedDocument = buildIndexedDocument("/documents/large.pdf");
    const storedDocument: StoredSourceDocumentReference = {
      byteLength: 5,
      documentId: indexedDocument.documentId,
      openContent: async () => {
        throw new Error("Content should not be opened when enforcing limits.");
      },
    };

    await expect(readStoredReindexSource(
      { readDocumentReference: async () => storedDocument },
      indexedDocument,
      4,
    )).rejects.toThrow(
      "Document exceeds the configured 4 byte limit: /documents/large.pdf",
    );
  });

  it("surfaces a missing persisted source at the storage boundary", async () => {
    const indexedDocument = buildIndexedDocument("/documents/missing.pdf");
    const readDocumentReference =
      async (): Promise<StoredSourceDocumentReference> => {
      throw new Error(`Stored source document is missing or invalid: ${indexedDocument.documentId}`);
    };

    await expect(readStoredReindexSource(
      { readDocumentReference },
      indexedDocument,
      1_024,
    )).rejects.toThrow(
      `Stored source document is missing or invalid: ${indexedDocument.documentId}`,
    );
  });
});

function buildIndexedDocument(sourceFile: string): PublishedDocument {
  return {
    documentId: "a".repeat(64),
    elementSetId: "b".repeat(64),
    format: {
      extension: ".pdf",
      mediaType: "application/pdf",
    },
    generationId: "00000000-0000-4000-8000-000000000001",
    images: 0,
    indexedAt: "2026-07-17T14:00:00.000Z",
    pageCount: 1,
    sourceFile,
    tables: 0,
    tags: ["legal"],
    textChunks: 1,
    totalElements: 1,
    versionId: "00000000-0000-4000-8000-000000000001",
  };
}
