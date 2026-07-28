import { describe, expect, it } from "vitest";

import {
  readDocumentVersions,
  readIngestionControlResponse,
} from "../web/assets/scripts/citeloom-documents.js";

function createDocumentVersionResponse() {
  return {
    createdAt: "2026-07-24T05:03:27.369Z",
    documentId: "a".repeat(64),
    elementCount: 37,
    elementSetId: "b".repeat(64),
    generationId: "00000000-0000-4000-8000-000000000002",
    id: "00000000-0000-4000-8000-000000000001",
    pageCount: 12,
    sourceFile: "/documents/test.pdf",
    version: 1,
  };
}

describe("document version browser boundary", () => {
  it("reads the bounded element count from the current response contract", () => {
    const versions = readDocumentVersions([createDocumentVersionResponse()]);

    expect(versions).toEqual([
      {
        createdAt: "2026-07-24T05:03:27.369Z",
        documentId: "a".repeat(64),
        elementCount: 37,
        id: "00000000-0000-4000-8000-000000000001",
        pageCount: 12,
        sourceFile: "/documents/test.pdf",
        version: 1,
      },
    ]);
  });
});

describe("ingestion control browser boundary", () => {
  it("accepts a completed cancellation response", () => {
    expect(readIngestionControlResponse({
      action: "cancel",
      sourceFile: "/documents/test.pdf",
      state: "canceled",
    })).toEqual({
      action: "cancel",
      sourceFile: "/documents/test.pdf",
      state: "canceled",
    });
  });
});
