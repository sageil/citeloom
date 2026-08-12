import { describe, expect, it } from "vitest";

import { decodeIngestionJob } from "../src/documents/catalog/records.js";

function buildIngestionJobRow() {
  return {
    attemptCount: 0,
    controlError: null,
    controlState: "active",
    documentId: "a".repeat(64),
    doclingAttemptConfig: null,
    doclingRunId: null,
    elementSetId: "b".repeat(64),
    embeddingSpaceId: "test:plain:768",
    errorMessage: null,
    fileExtension: ".pdf",
    generationId: "00000000-0000-4000-8000-000000000001",
    images: 1,
    indexingActivity: "building_outline",
    leaseExpiresAt: null,
    maxAttempts: 3,
    mediaType: "application/pdf",
    nextAttemptAt: new Date("2026-08-07T12:00:00.000Z"),
    ownerId: null,
    pageCount: 2,
    phase: "normalized",
    sourceFile: "/documents/report.pdf",
    sourceLibraryId: null,
    state: "pending",
    tables: 1,
    tags: [],
    textChunks: 2,
    totalElements: 4,
    updatedAt: new Date("2026-08-07T12:00:00.000Z"),
    uploadedByUserId: null,
  };
}

describe("ingestion job records", () => {
  it("decodes the durable indexing activity", () => {
    expect(decodeIngestionJob(buildIngestionJobRow())).toMatchObject({
      indexingActivity: "building_outline",
      phase: "normalized",
    });
  });

  it("rejects a normalized job without an indexing activity", () => {
    expect(() => decodeIngestionJob({
      ...buildIngestionJobRow(),
      indexingActivity: null,
    })).toThrow(
      "indexing activity does not match phase",
    );
  });

  it("rejects an indexing activity outside the normalized phase", () => {
    expect(() => decodeIngestionJob({
      ...buildIngestionJobRow(),
      phase: "indexed",
    })).toThrow(
      "indexing activity does not match phase",
    );
  });
});
