import { describe, expect, it } from "vitest";

import {
  answerContextSelectionConfig,
  selectAnswerContextCutoff,
} from "../src/retrieval/ranking/context-selection.js";

describe("answer context selection", () => {
  it("cuts an unrelated trailing cluster without filling topK", () => {
    const selection = selectAnswerContextCutoff(
      scores([0.99, 0.96, 0.93, 0.9, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03]),
      10,
    );

    expect(selection).toEqual({ cutoffRank: 4, reason: "relevance-cliff" });
  });

  it("cuts the reproduced Robert retrieval window after its relevant cluster", () => {
    const selection = selectAnswerContextCutoff(
      scores([
        0.08984375,
        0.053466796875,
        0.0419921875,
        0.03955078125,
        0.00860595703125,
        0.00141143798828125,
        0.000335693359375,
        0.0002956390380859375,
        0.0002956390380859375,
        0.00020313262939453125,
        0.00009632110595703125,
      ]),
      10,
    );

    expect(selection).toEqual({ cutoffRank: 5, reason: "relevance-cliff" });
  });

  it("keeps a gradual relevant distribution up to topK", () => {
    const selection = selectAnswerContextCutoff(
      scores([0.95, 0.87, 0.8, 0.72, 0.65, 0.58, 0.52, 0.46, 0.41, 0.36, 0.02]),
      10,
    );

    expect(selection).toEqual({ cutoffRank: 10, reason: "maximum-context" });
  });

  it("is query-relative across different provider score ranges", () => {
    const highRange = selectAnswerContextCutoff(
      scores([0.98, 0.91, 0.84, 0.08, 0.06]),
      5,
    );
    const lowRange = selectAnswerContextCutoff(
      scores([0.0098, 0.0091, 0.0084, 0.0008, 0.0006]),
      5,
    );

    expect(lowRange).toEqual(highRange);
    expect(lowRange.cutoffRank).toBe(3);
  });

  it("does not invent a cliff when two gaps are similarly plausible", () => {
    const selection = selectAnswerContextCutoff(
      scores([0.95, 0.9, 0.62, 0.58, 0.31, 0.28]),
      6,
    );

    expect(selection).toEqual({ cutoffRank: 6, reason: "maximum-context" });
  });

  it("exposes the complete versioned policy configuration", () => {
    expect(answerContextSelectionConfig).toEqual({
      minimumLogGapMedianMultiplier: 3,
      minimumScoreRatio: 3,
      policy: "relative-relevance-cliff-v2",
    });
  });
});

function scores(values: number[]): Array<{ relevanceScore: number }> {
  return values.map((relevanceScore) => ({ relevanceScore }));
}
