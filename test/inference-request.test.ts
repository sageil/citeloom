import { describe, expect, it } from "vitest";

import {
  createInferenceRequestSignal,
  InferenceFeatureTimeoutError,
  throwInferenceRequestFailure,
} from "../src/inference/request.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";

describe("feature-specific inference deadlines", () => {
  it("normalizes independent generous feature deadlines", () => {
    const config = readEqualWeightTestConfig({
      runtime: {
        answerTimeoutSeconds: 1_200,
        embeddingTimeoutSeconds: 28_800,
        queryExpansionTimeoutSeconds: 800,
        summaryTimeoutSeconds: 1_000,
      },
    });
    const queryExpansion = config.inference.queryExpansion;
    if (queryExpansion === null) {
      throw new Error("Expected query expansion to be configured.");
    }

    expect(config.inference.answer.timeoutMs).toBe(1_200_000);
    expect(config.inference.embedding.timeoutMs).toBe(28_800_000);
    expect(queryExpansion.timeoutMs).toBe(800_000);
    expect(config.inference.summary.timeoutMs).toBe(1_000_000);
  });

  it("classifies an expired feature deadline", async () => {
    const signals = createInferenceRequestSignal(1);
    await waitForAbort(signals.timeoutSignal);

    expect(() => throwInferenceRequestFailure(
      signals.timeoutSignal.reason,
      "embedding",
      1,
      signals.timeoutSignal,
    )).toThrow(InferenceFeatureTimeoutError);
  });

  it("preserves caller cancellation ahead of timeout classification", () => {
    const abortController = new AbortController();
    const callerReason = new Error("caller stopped");
    abortController.abort(callerReason);
    const signals = createInferenceRequestSignal(60_000, abortController.signal);

    expect(() => throwInferenceRequestFailure(
      signals.requestSignal.reason,
      "answer",
      60_000,
      signals.timeoutSignal,
      abortController.signal,
    )).toThrow(callerReason);
  });
});

async function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return;
  }
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
