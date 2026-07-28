import { describe, expect, it } from "vitest";

import {
  calculateBootstrapMeanInterval,
  createEvaluationStatisticalDesign,
} from "../tools/evaluation/statistics.js";

describe("evaluation confidence intervals", () => {
  it("returns deterministic percentile bootstrap intervals", () => {
    const first = calculateBootstrapMeanInterval([0, 0.5, 1], "dataset", 2_000);
    const second = calculateBootstrapMeanInterval([0, 0.5, 1], "dataset", 2_000);

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      confidenceLevel: 0.95,
      method: "percentile-bootstrap",
      resamples: 2_000,
    });
    expect(first.lower).toBeGreaterThanOrEqual(0);
    expect(first.upper).toBeLessThanOrEqual(1);
  });

  it("uses the observed value for a singleton interval", () => {
    expect(calculateBootstrapMeanInterval([0.75], "singleton")).toEqual({
      confidenceLevel: 0.95,
      lower: 0.75,
      method: "percentile-bootstrap",
      resamples: 10_000,
      upper: 0.75,
    });
  });

  it("derives paired case count from the minimum detectable effect", () => {
    expect(createEvaluationStatisticalDesign(0.1, 0.25)).toEqual({
      alpha: 0.05,
      alternative: "two-sided",
      assumedPairedNdcgDeltaStandardDeviation: 0.25,
      method: "normal-approximation-paired-mean",
      minimumDetectableNdcgDelta: 0.1,
      power: 0.8,
      requiredCaseCount: 50,
    });
  });
});
