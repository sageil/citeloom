import { describe, expect, it } from "vitest";
import { buildTestModelCapabilities } from "./model-capabilities-fixture.js";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";

import { TaskLimiter } from "../src/shared/concurrency.js";
import { embedQuestions } from "../src/embedding/inference.js";
import { InferenceMetricsReporter } from "../src/inference/metrics.js";
import {
  formatEmbeddingInputs,
  type InferenceModelRegistry,
} from "../src/inference/registry.js";
import { mapRetrievalVariants } from "../src/retrieval/indexing/query-store.js";
import { createDeferred } from "./deferred-fixture.js";
import { FakeHhemClient } from "./hhem-fixture.js";
import { TEST_EMBEDDING_INPUT_FORMAT } from "./config-fixture.js";

describe("batched retrieval queries", () => {
  it("embeds every query variant in one provider batch", async () => {
    const embeddingModel = buildEmbeddingModel();
    const questions = ["original", "first expansion", "second expansion"];

    const embeddings = await embedQuestions(
      buildModelRegistry(embeddingModel),
      questions,
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(embeddingModel.doEmbedCalls).toHaveLength(1);
    expect(embeddingModel.doEmbedCalls[0]?.values).toEqual(questions);
    expect(embeddings).toEqual(questions.map(buildExpectedEmbedding));
  });

  it("matches sequential embeddings within the declared numeric tolerance", async () => {
    const questions = ["original", "first expansion", "second expansion"];
    const batchModel = buildEmbeddingModel();
    const sequentialModel = buildEmbeddingModel();
    const signal = new AbortController().signal;
    const batch = await embedQuestions(
      buildModelRegistry(batchModel),
      questions,
      new TaskLimiter(1),
      signal,
    );
    const sequential: number[][] = [];
    for (const question of questions) {
      const result = await embedQuestions(
        buildModelRegistry(sequentialModel),
        [question],
        new TaskLimiter(1),
        signal,
      );
      const embedding = result[0];
      if (embedding === undefined) {
        throw new Error("Sequential query embedding is missing.");
      }
      sequential.push(embedding);
    }

    const tolerance = 1e-12;
    expect(batch).toHaveLength(sequential.length);
    for (let queryIndex = 0; queryIndex < batch.length; queryIndex += 1) {
      const batchEmbedding = batch[queryIndex];
      const sequentialEmbedding = sequential[queryIndex];
      if (batchEmbedding === undefined || sequentialEmbedding === undefined) {
        throw new Error(`Missing comparison embedding at index ${queryIndex}.`);
      }
      expect(batchEmbedding).toHaveLength(sequentialEmbedding.length);
      for (let valueIndex = 0; valueIndex < batchEmbedding.length; valueIndex += 1) {
        const batchValue = batchEmbedding[valueIndex];
        const sequentialValue = sequentialEmbedding[valueIndex];
        if (batchValue === undefined || sequentialValue === undefined) {
          throw new Error(`Missing embedding value at index ${valueIndex}.`);
        }
        expect(Math.abs(batchValue - sequentialValue)).toBeLessThanOrEqual(tolerance);
      }
    }
  });

  it("formats every value in the query batch with the query middleware profile", () => {
    const config = {
      adapter: "openai-compatible-embedding" as const,
      apiToken: null,
      baseUrl: "http://127.0.0.1:1234/v1",
      inputFormat: TEST_EMBEDDING_INPUT_FORMAT,
      providerId: "embedding",
      maximumInputTokens: 2_048,
      model: "embedding-model",
      runtimeName: "test runtime",
      timeoutMs: 600_000,
    };

    expect(formatEmbeddingInputs(config, "query", ["one", "two"])).toEqual([
      "task: search result | query: one",
      "task: search result | query: two",
    ]);
  });
});

describe("bounded retrieval variant concurrency", () => {
  it("preserves input ordering while enforcing the configured bound", async () => {
    let active = 0;
    let maximumActive = 0;
    const gates = Array.from({ length: 4 }, () => createDeferred());
    const operation = mapRetrievalVariants(
      [0, 1, 2, 3],
      2,
      new AbortController().signal,
      async (value) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gates[value]?.promise;
        active -= 1;
        return `result-${value}`;
      },
    );

    await waitFor(() => active === 2);
    gates[1]?.resolve();
    await waitFor(() => active === 2);
    gates[0]?.resolve();
    await waitFor(() => active === 2);
    gates[3]?.resolve();
    gates[2]?.resolve();

    await expect(operation).resolves.toEqual([
      "result-0",
      "result-1",
      "result-2",
      "result-3",
    ]);
    expect(maximumActive).toBe(2);
  });

  it("does not start queued variants after cancellation", async () => {
    const abortController = new AbortController();
    const gate = createDeferred();
    const started: number[] = [];
    const operation = mapRetrievalVariants(
      [0, 1, 2, 3],
      2,
      abortController.signal,
      async (value) => {
        started.push(value);
        await gate.promise;
        return value;
      },
    );

    await waitFor(() => started.length === 2);
    abortController.abort(new Error("retrieval cancelled"));
    gate.resolve();

    await expect(operation).rejects.toThrow("retrieval cancelled");
    expect(started).toEqual([0, 1]);
  });
});

function buildEmbeddingModel(): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    doEmbed: async ({ values }) => ({
      embeddings: values.map(buildExpectedEmbedding),
      usage: { tokens: values.length },
      warnings: [],
    }),
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: true,
  });
}

function buildExpectedEmbedding(value: string): number[] {
  return [value.length / 100, value.charCodeAt(0) / 1_000];
}

function buildModelRegistry(
  embeddingModel: MockEmbeddingModelV4,
): InferenceModelRegistry {
  const languageModel = new MockLanguageModelV4();
  return {
    answer: languageModel,
    answerBudget: { maximumOutputTokens: 16_384, minimumOutputTokens: 256, providerSafetyMarginTokens: 0 },
    readAnswerCapabilities: async () => buildTestModelCapabilities(),
    claimVerifier: new FakeHhemClient(),
    documentEmbedding: embeddingModel,
    metrics: new InferenceMetricsReporter({ enabled: false }),
    queryExpansion: languageModel,
    queryEmbedding: embeddingModel,
    reranker: null,
    summary: languageModel,
    timeouts: {
      answerMs: 900_000,
      embeddingMs: 600_000,
      summarizationMs: 900_000,
      queryExpansionMs: 900_000,
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for test condition.");
}
