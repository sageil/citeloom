import type {
  LanguageModelV4,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { buildTestModelCapabilities } from "./model-capabilities-fixture.js";

import { TaskLimiter } from "../src/shared/concurrency.js";
import type { SourceElement } from "../src/domain/source-elements.js";
import { regenerateDuplicateQuestions } from "../tools/evaluation/question-deduplicator.js";
import { InferenceMetricsReporter } from "../src/inference/metrics.js";
import type { EvaluationModelRegistry } from "../tools/evaluation/models.js";
import { FakeHhemClient } from "./hhem-fixture.js";
import { buildSourceLocation } from "./source-element-fixture.js";

describe("evaluation question deduplication", () => {
  it("regenerates a duplicate question and preserves case order", async () => {
    const evaluationModel = new MockLanguageModelV4({
      doGenerate: buildTextGeneration("What changed during the period?"),
    });
    const cases = [buildCase("a"), buildCase("b")];
    const elements = [buildElement("a"), buildElement("b")];
    const progress: string[] = [];

    const result = await regenerateDuplicateQuestions(
      cases,
      elements,
      { domain: "finance" },
      buildModelRegistry(evaluationModel),
      new TaskLimiter(1),
      (message) => progress.push(message),
    );

    expect(result.map((evaluationCase) => evaluationCase.id)).toEqual([
      "case-a",
      "case-b",
    ]);
    expect(result.map((evaluationCase) => evaluationCase.question)).toEqual([
      "How much did revenue increase?",
      "What changed during the period?",
    ]);
    expect(evaluationModel.doGenerateCalls).toHaveLength(1);
    expect(progress).toEqual([
      "Regenerating duplicate question for case-b, attempt 1/4",
    ]);
  });

  it("fails clearly after four duplicate regeneration attempts", async () => {
    const evaluationModel = new MockLanguageModelV4({
      doGenerate: buildTextGeneration("How much did revenue increase?"),
    });
    const cases = [buildCase("a"), buildCase("b")];
    const elements = [buildElement("a"), buildElement("b")];

    await expect(regenerateDuplicateQuestions(
      cases,
      elements,
      { domain: "finance" },
      buildModelRegistry(evaluationModel),
      new TaskLimiter(1),
      () => undefined,
    )).rejects.toThrow("after 4 attempts");
    expect(evaluationModel.doGenerateCalls).toHaveLength(4);
  });
});

function buildCase(marker: string) {
  return {
    id: `case-${marker}`,
    question: "How much did revenue increase?",
  };
}

function buildElement(marker: string): SourceElement {
  return {
    content: `Revenue increased by ${marker === "a" ? "12" : "18"} percent.`,
    documentId: marker.repeat(64),
    id: marker.repeat(64),
    detectedTypes: ["paragraph"],
    kind: "text",
    ...buildSourceLocation(1),
    sourceFile: `/tmp/report-${marker}.pdf`,
  };
}

function buildModelRegistry(
  evaluation: LanguageModelV4,
): EvaluationModelRegistry {
  const embedding = new MockEmbeddingModelV4();
  return {
    answer: evaluation,
    answerBudget: { minimumOutputTokens: 256, providerSafetyMarginTokens: 0 },
    readAnswerCapabilities: async () => buildTestModelCapabilities(),
    claimVerifier: new FakeHhemClient(),
    documentEmbedding: embedding,
    evaluation,
    metrics: new InferenceMetricsReporter({ enabled: false }),
    queryExpansion: evaluation,
    queryEmbedding: embedding,
    reranker: null,
    indexing: evaluation,
    timeouts: {
      answerMs: 900_000,
      embeddingMs: 600_000,
      indexingMs: 900_000,
      queryExpansionMs: 900_000,
    },
  };
}

function buildTextGeneration(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ text, type: "text" }],
    finishReason: { raw: "stop", unified: "stop" },
    usage: {
      inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 10, total: 10 },
      outputTokens: { reasoning: 0, text: 6, total: 6 },
    },
    warnings: [],
  };
}
