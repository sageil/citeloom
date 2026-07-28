import { afterEach, describe, expect, it, vi } from "vitest";

import { InferenceMetricsReporter } from "../src/inference/metrics.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("InferenceMetricsReporter", () => {
  it("logs one privacy-safe metric per operation", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const reporter = new InferenceMetricsReporter({ enabled: true });
    const finish = reporter.start("answer", "lmstudio.chat", "vision:answer");

    finish({ finishReason: "stop", inputTokens: 12, outputTokens: 7 });
    finish({ finishReason: "error", inputTokens: null, outputTokens: null });

    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"operation":"answer"'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"inputTokens":12'));
  });

  it("does not log when metrics are disabled", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const reporter = new InferenceMetricsReporter({ enabled: false });

    reporter.start("embed-query", "ollama.embedding", "embedding")();

    expect(log).not.toHaveBeenCalled();
  });
});
