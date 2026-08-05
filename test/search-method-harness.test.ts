import { describe, expect, it } from "vitest";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";

import { InferenceMetricsReporter } from "../src/inference/metrics.js";
import type { InferenceModelRegistry } from "../src/inference/registry.js";
import { prepareRetrievalQueries } from "../src/retrieval/pipeline.js";
import { TaskLimiter } from "../src/shared/concurrency.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";
import { FakeHhemClient } from "./hhem-fixture.js";
import { buildTestModelCapabilities } from "./model-capabilities-fixture.js";

describe("application search method harness", () => {
  it("embeds only the methods that execute dense document retrieval", async () => {
    const scenarios = [
      { expectedEmbeddingCalls: 0, mode: "bm25" as const },
      { expectedEmbeddingCalls: 1, mode: "dense" as const },
      { expectedEmbeddingCalls: 1, mode: "hybrid" as const },
    ];

    for (const scenario of scenarios) {
      const embedding = buildEmbeddingModel();
      const config = readEqualWeightTestConfig({
        runtime: {
          queryExpansions: 0,
          searchMethod: scenario.mode,
        },
      });
      const queries = await prepareRetrievalQueries(
        config,
        buildModelRegistry(embedding),
        "What changed?",
        () => undefined,
        new TaskLimiter(1),
        null,
        new AbortController().signal,
        { seed: 1, temperature: 0 },
      );

      expect(embedding.doEmbedCalls).toHaveLength(
        scenario.expectedEmbeddingCalls,
      );
      expect(queries).toEqual([{
        embedding: scenario.mode === "bm25" ? null : [1],
        kind: "original",
        text: "What changed?",
      }]);
    }
  });
});

function buildEmbeddingModel(): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    doEmbed: async ({ values }) => ({
      embeddings: values.map(() => [1]),
      usage: { tokens: values.length },
      warnings: [],
    }),
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: true,
  });
}

function buildModelRegistry(
  embedding: MockEmbeddingModelV4,
): InferenceModelRegistry {
  const languageModel = new MockLanguageModelV4();
  return {
    answer: languageModel,
    answerBudget: {
      maximumOutputTokens: 16_384,
      minimumOutputTokens: 256,
      providerSafetyMarginTokens: 0,
    },
    readAnswerCapabilities: async () => buildTestModelCapabilities(),
    claimVerifier: new FakeHhemClient(),
    documentEmbedding: embedding,
    metrics: new InferenceMetricsReporter({ enabled: false }),
    queryExpansion: languageModel,
    queryEmbedding: embedding,
    reranker: null,
    summary: languageModel,
    timeouts: {
      answerMs: 900_000,
      embeddingMs: 600_000,
      queryExpansionMs: 900_000,
      summarizationMs: 900_000,
    },
  };
}
