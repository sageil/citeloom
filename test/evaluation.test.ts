import { describe, expect, it } from "vitest";

import type { RetrievedElement } from "../src/retrieval/document-retrieval.js";
import type { SourceElement } from "../src/domain/source-elements.js";
import type { EvaluationJudgment } from "../tools/evaluation/dataset.js";
import {
  calculateGradedNdcgAtK,
  calculateNdcgAtK,
  readAvailableEvaluationModes,
  summarizeEvaluationMethod,
} from "../tools/evaluation/index.js";
import {
  buildRetrievedElementProvenance,
  buildSourceLocation,
} from "./source-element-fixture.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";

function retrieved(
  elementId: string,
  documentId: string,
): RetrievedElement {
  const element: SourceElement = {
    content: "content",
    documentId,
    id: elementId,
    detectedTypes: ["paragraph"],
    kind: "text",
    ...buildSourceLocation(1),
    sourceFile: `${documentId}.pdf`,
  };
  return {
    distance: 0.1,
    documentVersionId: "00000000-0000-4000-8000-000000000001",
    element,
    evidenceContent: "retrieval evidence",
    provenance: buildRetrievedElementProvenance(element.id),
  };
}

describe("NDCG evaluation", () => {
  it("scores a relevant first result as perfect", () => {
    const result = calculateNdcgAtK(
      [retrieved("a".repeat(64), "1".repeat(64))],
      ["1".repeat(64)],
      [],
      10,
    );

    expect(result).toEqual({ ndcg: 1, recall: 1, relevantRetrieved: 1 });
  });

  it("discounts relevant results that appear later", () => {
    const result = calculateNdcgAtK(
      [
        retrieved("a".repeat(64), "1".repeat(64)),
        retrieved("b".repeat(64), "2".repeat(64)),
      ],
      ["2".repeat(64)],
      [],
      10,
    );

    expect(result.ndcg).toBeCloseTo(1 / Math.log2(3));
    expect(result.relevantRetrieved).toBe(1);
    expect(result.recall).toBe(1);
  });

  it("counts a relevant document only once when it returns several results", () => {
    const documentId = "3".repeat(64);
    const result = calculateNdcgAtK(
      [
        retrieved("a".repeat(64), documentId),
        retrieved("b".repeat(64), documentId),
      ],
      [documentId],
      [],
      10,
    );

    expect(result).toEqual({ ndcg: 1, recall: 1, relevantRetrieved: 1 });
  });

  it("calculates recall against all relevant labels beyond the result cutoff", () => {
    const firstDocumentId = "4".repeat(64);
    const secondDocumentId = "5".repeat(64);
    const results = [retrieved("c".repeat(64), firstDocumentId)];

    const result = calculateNdcgAtK(
      results,
      [firstDocumentId, secondDocumentId],
      [],
      1,
    );

    expect(result).toEqual({ ndcg: 1, recall: 0.5, relevantRetrieved: 1 });
  });

  it("gives direct relevance more gain than partial relevance", () => {
    const directElementId = "d".repeat(64);
    const partialElementId = "e".repeat(64);
    const judgments = [
      acceptedJudgment(directElementId, "direct"),
      acceptedJudgment(partialElementId, "partial"),
    ];

    const ideal = calculateGradedNdcgAtK([
      retrieved(directElementId, "1".repeat(64)),
      retrieved(partialElementId, "2".repeat(64)),
    ], judgments, 2);
    const reversed = calculateGradedNdcgAtK([
      retrieved(partialElementId, "2".repeat(64)),
      retrieved(directElementId, "1".repeat(64)),
    ], judgments, 2);

    expect(ideal).toEqual({ ndcg: 1, recall: 1, relevantRetrieved: 2 });
    expect(reversed.ndcg).toBeLessThan(ideal.ndcg);
    expect(reversed.recall).toBe(1);
  });

  it("reports case-weighted and domain macro means separately", () => {
    const method = summarizeEvaluationMethod("hybrid", [
      evaluationCaseResult("legal-1", "legal", 1),
      evaluationCaseResult("legal-2", "legal", 0),
      evaluationCaseResult("vet-1", "veterinary", 1),
    ]);

    expect(method.meanNdcg).toBeCloseTo(2 / 3);
    expect(method.macroMeanNdcg).toBeCloseTo(0.75);
    expect(method.meanRecall).toBeCloseTo(2 / 3);
    expect(method.macroMeanRecall).toBeCloseTo(0.75);
    expect(method.domains).toEqual([
      { caseCount: 2, domain: "legal", meanNdcg: 0.5, meanRecall: 0.5 },
      { caseCount: 1, domain: "veterinary", meanNdcg: 1, meanRecall: 1 },
    ]);
  });

  it("skips only the reranked comparison when no reranker is configured", () => {
    const config = readEqualWeightTestConfig();

    expect(readAvailableEvaluationModes(config)).toEqual({
      available: ["bm25", "dense", "hybrid"],
      skipped: ["hybrid-reranked"],
    });
  });

  it("includes all four comparisons when a reranker is configured", () => {
    const config = readEqualWeightTestConfig({
      providerOptions: {
        rerankBaseUrl: "http://localhost:9000/v1",
        rerankEnabled: true,
      },
    });

    expect(readAvailableEvaluationModes(config)).toEqual({
      available: ["bm25", "dense", "hybrid", "hybrid-reranked"],
      skipped: [],
    });
  });
});

function evaluationCaseResult(id: string, domain: string, ndcg: number) {
  return {
    domain,
    id,
    language: "en" as const,
    ndcg,
    questionType: "factoid" as const,
    question: `${id}?`,
    recall: ndcg > 0 ? 1 : 0,
    relevantRetrieved: ndcg > 0 ? 1 : 0,
    retrieved: 10,
    sourceKind: "text" as const,
  };
}

function acceptedJudgment(
  elementId: string,
  relevance: "direct" | "partial",
): EvaluationJudgment {
  return {
    provenance: { kind: "pooled", methods: ["hybrid"] },
    relevance,
    review: {
      auditStatus: "accepted",
      rationale: "Reviewed test relevance judgment.",
      reviewedAt: "2026-07-15T12:00:00.000Z",
      reviewer: { id: "reviewer-1", kind: "human" },
    },
    target: { id: elementId, kind: "element" },
  };
}
