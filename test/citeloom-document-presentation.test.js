import { describe, expect, it } from "vitest";

import {
  buildPhaseStages,
  readDocumentStatusCopy,
  readIndexingActivityDetail,
  readIndexingActivityLabel,
} from "../web/assets/scripts/citeloom-document-presentation.js";

function buildIndexingDocument(indexingActivity) {
  return {
    displayStatus: "running",
    embeddingProgress: {
      completedElements: 16,
      state: "in-progress",
      totalElements: 32,
    },
    images: 2,
    indexingActivity,
    mediaDescriptionProgress: {
      completedImages: 1,
      completedTables: 1,
    },
    phase: "normalized",
    status: "running",
    tables: 1,
  };
}

describe("CiteLoom document indexing presentation", () => {
  it.each([
    ["preparing", "Preparing search index"],
    ["describing", "Describing tables and images"],
    ["embedding", "Embedding search content"],
    ["building_outline", "Building document outline"],
  ])("presents the %s worker activity", (activity, label) => {
    expect(readIndexingActivityLabel(buildIndexingDocument(activity))).toBe(label);
  });

  it("keeps indexing as the user-facing phase while exposing the worker activity", () => {
    const document = buildIndexingDocument("building_outline");

    expect(readDocumentStatusCopy(document)).toEqual({
      detail: "Building document outline",
      label: "Indexing",
    });
    expect(readIndexingActivityDetail(document)).toBe(
      "16 of 32 elements indexed",
    );
    expect(buildPhaseStages(document)).toEqual([
      { label: "Stored", state: "complete" },
      { label: "Normalized", state: "complete" },
      { label: "Indexing", state: "current" },
      { label: "Ready", state: "upcoming" },
    ]);
  });

  it("reports exact media description progress", () => {
    const document = buildIndexingDocument("describing");

    expect(readIndexingActivityDetail(document)).toBe(
      "2 of 3 tables and images described",
    );
  });
});
