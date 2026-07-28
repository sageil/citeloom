import { describe, expect, it } from "vitest";

import type { SourceElement } from "../src/domain/source-elements.js";
import {
  buildRetrievedElementProvenance,
  buildSourceLocation,
  buildTableStructure,
} from "./source-element-fixture.js";
import {
  belongsToEvaluationSplit,
  createEvaluationModelSeed,
  mergePooledEvaluationCandidates,
  readPortableSourceFile,
  selectEvaluationElements,
} from "../tools/evaluation/generator.js";

describe("evaluation sampling", () => {
  it("assigns every document to exactly one stable split", () => {
    for (let index = 0; index < 100; index += 1) {
      const documentId = index.toString(16).padStart(64, "0");
      const development = belongsToEvaluationSplit(
        documentId,
        "development",
        "stable-seed",
      );
      const holdout = belongsToEvaluationSplit(
        documentId,
        "holdout",
        "stable-seed",
      );
      expect(development).toBe(!holdout);
    }
  });

  it("selects deterministically across available source kinds", () => {
    const elements = [
      buildElement("text", "1"),
      buildElement("text", "2"),
      buildElement("table", "3"),
      buildElement("table", "4"),
      buildElement("image", "5"),
      buildElement("image", "6"),
    ];

    const first = selectEvaluationElements(elements, 3, "stable-seed");
    const second = selectEvaluationElements(elements, 3, "stable-seed");

    expect(second.map((element) => element.id)).toEqual(
      first.map((element) => element.id),
    );
    expect(new Set(first.map((element) => element.kind))).toEqual(
      new Set(["text", "table", "image"]),
    );
    expect(new Set(first.map((element) => element.documentId)).size).toBe(3);
  });

  it("rejects a request larger than the selected split", () => {
    expect(() => selectEvaluationElements(
      [buildElement("text", "1")],
      2,
      "stable-seed",
    )).toThrow("contains only 1 source elements");
  });

  it("does not treat duplicate image bytes as distinct visual cases", () => {
    const first = buildElement("image", "5");
    const duplicate = {
      ...buildElement("image", "7"),
      content: first.content,
    };

    expect(() => selectEvaluationElements([
      first,
      duplicate,
      buildElement("image", "6"),
    ], 3, "stable-seed")).toThrow("Could not select 3 evaluation elements");
  });

  it("unions candidate pools and records every contributing method", () => {
    const shared = retrievedElement("text", "1");
    const denseOnly = retrievedElement("table", "2");

    const pooled = mergePooledEvaluationCandidates([
      { mode: "bm25", retrieved: [shared] },
      { mode: "dense", retrieved: [shared, denseOnly] },
      { mode: "hybrid", retrieved: [shared] },
    ]);

    expect(pooled).toHaveLength(2);
    expect(pooled[0]?.methods).toEqual(["bm25", "dense", "hybrid"]);
    expect(pooled[1]?.methods).toEqual(["dense"]);
  });

  it("derives stable purpose-specific model seeds", () => {
    const first = createEvaluationModelSeed(
      "stable-seed",
      "question",
      "element-1",
    );
    const second = createEvaluationModelSeed(
      "stable-seed",
      "question",
      "element-1",
    );
    const relevance = createEvaluationModelSeed(
      "stable-seed",
      "relevance",
      "element-1",
    );

    expect(second).toBe(first);
    expect(relevance).not.toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(2_147_483_647);
  });

  it("records source provenance relative to the working directory", () => {
    expect(readPortableSourceFile(
      "/workspace/documents/legal/act.pdf",
      "/workspace",
    )).toBe("documents/legal/act.pdf");
  });
});

function buildElement(
  kind: SourceElement["kind"],
  marker: string,
): SourceElement {
  const base = {
    content: kind === "image" ? Buffer.from(marker).toString("base64") : marker,
    documentId: marker.repeat(64),
    id: marker.toUpperCase().repeat(64).toLowerCase(),
    ...buildSourceLocation(1),
    sourceFile: `/documents/${marker}.pdf`,
  };
  if (kind === "image") {
    return {
      ...base,
      caption: null,
      detectedType: "picture",
      kind,
      mimeType: "image/png",
    };
  }
  if (kind === "table") {
    return {
      ...base,
      caption: null,
      detectedType: "table",
      kind,
      table: buildTableStructure(),
    };
  }
  return { ...base, detectedTypes: ["paragraph"], kind };
}

function retrievedElement(kind: SourceElement["kind"], marker: string) {
  const element = buildElement(kind, marker);
  return {
    distance: 0.1,
    documentVersionId: "00000000-0000-4000-8000-000000000001",
    element,
    evidenceContent: `Summary ${marker}`,
    provenance: buildRetrievedElementProvenance(element.id),
  };
}
