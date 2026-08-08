import { afterEach, describe, expect, it, vi } from "vitest";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";

import type { ApplicationRuntime } from "../src/app/runtime.js";
import {
  processNextVerificationJobWithRuntime,
  type ClaimedVerificationJob,
  type VerificationJobStore,
} from "../src/answers/verification-worker.js";
import type { InferenceModelRegistry } from "../src/inference/registry.js";
import { InferenceMetricsReporter } from "../src/inference/metrics.js";
import type { ClaimVerificationResult } from "../src/research/types.js";
import { TaskLimiter } from "../src/shared/concurrency.js";
import { FakeHhemClient } from "./hhem-fixture.js";
import { buildTestModelCapabilities } from "./model-capabilities-fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shared evidence verification worker", () => {
  it("completes a claimed job with verified evidence", async () => {
    const store = new FakeVerificationJobStore(buildJob());
    const models = buildModels(new FakeHhemClient());

    await expect(processNextVerificationJobWithRuntime(
      buildRuntime(),
      models,
      "answer",
      store,
      new AbortController().signal,
    )).resolves.toBe(true);

    expect(store.completed).toHaveLength(1);
    expect(store.completed[0]?.claims).toEqual([
      expect.objectContaining({ status: "supported" }),
    ]);
    expect(store.failures).toEqual([]);
  });

  it("retries transient failures and makes the third failure terminal", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const verifier = new FakeHhemClient(0.5, async () => {
      throw new Error("verifier unavailable");
    });
    const retryingStore = new FakeVerificationJobStore(buildJob());

    await processNextVerificationJobWithRuntime(
      buildRuntime(),
      buildModels(verifier),
      "answer",
      retryingStore,
      new AbortController().signal,
    );

    expect(retryingStore.failures).toHaveLength(1);
    expect(retryingStore.failures[0]?.retryAt).toBeInstanceOf(Date);

    const terminalStore = new FakeVerificationJobStore(buildJob(2));
    await processNextVerificationJobWithRuntime(
      buildRuntime(),
      buildModels(verifier),
      "chat",
      terminalStore,
      new AbortController().signal,
    );

    expect(terminalStore.failures).toHaveLength(1);
    expect(terminalStore.failures[0]?.retryAt).toBeNull();
  });
});

class FakeVerificationJobStore implements VerificationJobStore {
  public readonly completed: Array<{
    claims: readonly ClaimVerificationResult[];
    id: string;
  }> = [];
  public readonly failures: Array<{
    id: string;
    retryAt: Date | null;
  }> = [];
  private claimed = false;

  public constructor(private readonly job: ClaimedVerificationJob) {}

  public async claimNextVerificationJob(): Promise<ClaimedVerificationJob | null> {
    if (this.claimed) {
      return null;
    }
    this.claimed = true;
    return this.job;
  }

  public async completeVerificationJob(
    id: string,
    _attemptCount: number,
    claims: readonly ClaimVerificationResult[],
  ): Promise<boolean> {
    this.completed.push({ claims, id });
    return true;
  }

  public async releaseVerificationJob(): Promise<boolean> {
    return true;
  }

  public async settleVerificationFailure(
    id: string,
    _attemptCount: number,
    _error: unknown,
    retryAt: Date | null,
  ): Promise<boolean> {
    this.failures.push({ id, retryAt });
    return true;
  }
}

function buildJob(failureCount = 0): ClaimedVerificationJob {
  return {
    attemptCount: failureCount + 1,
    claims: [{
      citationNumbers: [1],
      claim: "Revenue increased.",
      claimIndex: 0,
    }],
    failureCount,
    id: "00000000-0000-4000-8000-000000000001",
    sources: [{
      citationNumber: 1,
      evidence: { excerpt: "Revenue increased.", kind: "text" },
      sectionPath: ["Results"],
    }],
  };
}

function buildModels(verifier: FakeHhemClient): InferenceModelRegistry {
  const embedding = new MockEmbeddingModelV4();
  const language = new MockLanguageModelV4();
  return {
    answer: language,
    answerBudget: {
      minimumOutputTokens: 256,
      providerSafetyMarginTokens: 0,
    },
    claimVerifier: verifier,
    documentEmbedding: embedding,
    indexing: language,
    metrics: new InferenceMetricsReporter({ enabled: false }),
    queryEmbedding: embedding,
    queryExpansion: null,
    readAnswerCapabilities: async () => buildTestModelCapabilities(),
    reranker: null,
    timeouts: {
      answerMs: 1_000,
      embeddingMs: 1_000,
      indexingMs: 1_000,
      queryExpansionMs: null,
    },
  };
}

function buildRuntime(): Pick<ApplicationRuntime, "scheduler"> {
  return {
    scheduler: () => new TaskLimiter(1),
  };
}
