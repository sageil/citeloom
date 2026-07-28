import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  BenchmarkEvaluationCase,
  BenchmarkEvaluationDataset,
} from "../tools/evaluation/dataset.js";
import {
  decodeEvaluationDataset,
  readBenchmarkEvaluationDataset,
  readEvaluationDataset,
  readTuningEvaluationDataset,
  writeEvaluationDataset,
} from "../tools/evaluation/dataset.js";

describe("evaluation dataset boundary", () => {
  it("accepts versioned cases from multiple domains", () => {
    const legalCase = benchmarkCase("legal-case-1", "a", "text");
    const veterinaryCase = benchmarkCase(
      "veterinary-case-1",
      "b",
      "table",
    );
    veterinaryCase.domain = "veterinary";
    const dataset = decodeTestDataset([legalCase, veterinaryCase], {
      atK: 10,
      name: "mixed-development",
    });

    expect(dataset.cases.map((evaluationCase) => evaluationCase.domain)).toEqual([
      "legal",
      "veterinary",
    ]);
  });

  it("rejects a case without a relevance label", () => {
    const evaluationCase = benchmarkCase("missing-label", "a", "text");
    evaluationCase.relevantElementIds = [];
    expect(() => decodeTestDataset([evaluationCase], {
      name: "veterinary-development",
    })).toThrow("must name at least one relevant document or element");
  });
  it("rejects a generated case that does not label its origin element", () => {
    const evaluationCase = benchmarkCase(
      "legal-development-case",
      "c",
      "text",
    );
    evaluationCase.origin = {
      documentId: "a".repeat(64),
      elementId: "b".repeat(64),
      kind: "generated",
      pageNumber: 1,
      sourceFile: "documents/legal/act.pdf",
      sourceKind: "text",
    };
    expect(() => decodeTestDataset([evaluationCase], {
      name: "legal-development",
    })).toThrow("must label the generated origin element as relevant");
  });

  it("rejects duplicate case IDs and questions", () => {
    const firstCase = benchmarkCase("duplicate-case", "a", "text");
    const secondCase = benchmarkCase("duplicate-case", "b", "text");
    secondCase.question = firstCase.question.toUpperCase();

    expect(() => decodeTestDataset([firstCase, secondCase], {
      name: "legal-development",
    })).toThrow("must not contain duplicate case IDs");
  });

  it("accepts reviewed version 2 judgments with benchmark metadata", () => {
    const dataset = decodeTestDataset([
      benchmarkCase("reviewed-case", "a", "text"),
    ], {
      atK: 10,
      name: "mixed-development-v2",
    });

    expect(readBenchmarkEvaluationDataset(dataset, "test input")).toEqual(
      dataset,
    );
    expect(readTuningEvaluationDataset(dataset, "test input")).toEqual(
      dataset,
    );
  });

  it("rejects unreviewed judgments at the benchmark readiness gate", () => {
    const evaluationCase = benchmarkCase("pending-case", "a", "text");
    const pendingJudgment = evaluationCase.judgments[0];
    if (pendingJudgment === undefined) {
      throw new Error("Missing test judgment.");
    }
    pendingJudgment.review = {
      auditStatus: "pending",
      rationale: "Awaiting an independent relevance review.",
      reviewedAt: null,
      reviewer: {
        kind: "process",
        name: "evaluation-generator",
        version: "2",
      },
    };
    const dataset = decodeTestDataset([evaluationCase], {
      name: "pending-development-v2",
    });

    expect(() => readBenchmarkEvaluationDataset(dataset, "test input"))
      .toThrow("pending or rejected judgments");
  });

  it("rejects repeated visual artifacts even when their element IDs differ", () => {
    const firstCase = benchmarkCase("image-case-1", "a", "image");
    const secondCase = benchmarkCase("image-case-2", "b", "image");
    secondCase.question = "Which finding is visible in the second image?";

    expect(() => decodeTestDataset([firstCase, secondCase], {
      name: "image-development-v2",
    })).toThrow("must not repeat the same visual artifact");
  });

  it("rejects labels that do not match the graded judgments", () => {
    const evaluationCase = benchmarkCase("mismatched-case", "a", "table");
    evaluationCase.relevantElementIds = ["b".repeat(64)];

    expect(() => decodeTestDataset([evaluationCase], {
      name: "mismatched-development-v2",
    })).toThrow("must match reviewed positive element judgments");
  });

  it("rejects source metadata that misstates a generated origin kind", () => {
    const evaluationCase = benchmarkCase("wrong-source-kind", "a", "text");
    evaluationCase.origin = {
      documentId: "d".repeat(64),
      elementId: "a".repeat(64),
      kind: "generated",
      pageNumber: 1,
      sourceFile: "documents/legal/act.pdf",
      sourceKind: "image",
    };
    const originJudgment = evaluationCase.judgments[0];
    if (originJudgment === undefined) {
      throw new Error("Missing test judgment.");
    }
    originJudgment.provenance = { kind: "origin" };

    expect(() => decodeTestDataset([evaluationCase], {
      name: "wrong-source-kind-development-v2",
    })).toThrow("must match the generated origin source kind");
  });

  it("reserves sealed access for holdout datasets", () => {
    expect(() => decodeTestDataset([
      benchmarkCase("sealed-case", "a", "text"),
    ], {
      access: "sealed",
      name: "invalid-sealed-v2",
    })).toThrow("must use development access");
  });

  it("keeps regression and sealed datasets out of the tuning boundary", () => {
    for (const access of ["regression", "sealed"] as const) {
      const dataset = decodeTestDataset([
        benchmarkCase(`${access}-case`, "a", "text"),
      ], {
        access,
        name: `${access}-holdout-v2`,
        split: "holdout",
      });

      expect(() => readTuningEvaluationDataset(dataset, "test input"))
        .toThrow("not available to tuning code");
    }
  });

  it("rejects a dataset smaller than its paired statistical design", () => {
    expect(() => decodeTestDataset([
      benchmarkCase("underpowered-case", "a", "text"),
    ], {
      name: "underpowered-development-v2",
      statisticalDesign: {
        alpha: 0.05,
        alternative: "two-sided",
        assumedPairedNdcgDeltaStandardDeviation: 0.25,
        method: "normal-approximation-paired-mean",
        minimumDetectableNdcgDelta: 0.1,
        power: 0.8,
        requiredCaseCount: 50,
      },
    })).toThrow("must contain at least 50 cases");
  });

  it("requires sealed datasets and paths to classify each other", async () => {
    const sealed = decodeTestDataset([
      benchmarkCase("sealed-case", "a", "text"),
    ], {
      access: "sealed",
      name: "final-holdout-v2",
      split: "holdout",
    });
    const development = decodeTestDataset([
      benchmarkCase("development-case", "b", "text"),
    ], {
      name: "development-v2",
    });

    await expect(writeEvaluationDataset(
      "/missing/final.json",
      sealed,
      false,
    )).rejects.toThrow("path classification differ");
    await expect(writeEvaluationDataset(
      "/missing/final.sealed.json",
      development,
      false,
    )).rejects.toThrow("path classification differ");
  });

  it("writes validated JSON without replacing an existing dataset by default", async () => {
    const directory = await mkdtemp(join(tmpdir(), "citeloom-evaluation-"));
    const filePath = join(directory, "dataset.json");
    const dataset = decodeTestDataset([
      benchmarkCase("veterinary-case-1", "a", "text"),
    ], {
      name: "veterinary-development",
    });

    try {
      await writeEvaluationDataset(filePath, dataset, false);
      await expect(writeEvaluationDataset(filePath, dataset, false)).rejects.toThrow();
      expect(await readEvaluationDataset(filePath)).toEqual(dataset);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

interface TestDatasetOptions {
  access?: BenchmarkEvaluationDataset["access"];
  atK?: number;
  name?: string;
  split?: BenchmarkEvaluationDataset["split"];
  statisticalDesign?: BenchmarkEvaluationDataset["statisticalDesign"];
}

function decodeTestDataset(
  cases: BenchmarkEvaluationCase[],
  options: TestDatasetOptions = {},
): BenchmarkEvaluationDataset {
  return decodeEvaluationDataset({
    access: "development",
    cases,
    name: "test-development",
    split: "development",
    statisticalDesign: singleCaseStatisticalDesign(),
    version: 2,
    ...options,
  }, "test input");
}

function benchmarkCase(
  id: string,
  idCharacter: string,
  sourceKind: "image" | "table" | "text",
): BenchmarkEvaluationCase {
  const elementId = idCharacter.repeat(64);
  const source = sourceKind === "image"
    ? { kind: "image" as const, visualIdentitySha256: "f".repeat(64) }
    : { kind: sourceKind };
  return {
    domain: "legal",
    id,
    judgments: [{
      provenance: { kind: "pooled" as const, methods: ["hybrid" as const] },
      relevance: "direct" as const,
      review: {
        auditStatus: "accepted" as const,
        rationale: "The source directly supports the expected answer.",
        reviewedAt: "2026-07-15T12:00:00.000Z",
        reviewer: { id: "reviewer-1", kind: "human" as const },
      },
      target: { id: elementId, kind: "element" as const },
    }],
    metadata: {
      language: "en",
      questionType: "factoid" as const,
      source,
    },
    origin: { kind: "manual" as const },
    question: `What fact is supported by case ${id}?`,
    relevantDocumentIds: [],
    relevantElementIds: [elementId],
  };
}

function singleCaseStatisticalDesign() {
  return {
    alpha: 0.05 as const,
    alternative: "two-sided" as const,
    assumedPairedNdcgDeltaStandardDeviation: 0.1,
    method: "normal-approximation-paired-mean" as const,
    minimumDetectableNdcgDelta: 1,
    power: 0.8 as const,
    requiredCaseCount: 1,
  };
}
