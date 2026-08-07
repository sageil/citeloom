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

  it("keeps the reproduced hypertension evidence band and cuts the unrelated tail", () => {
    const selection = selectAnswerContextCutoff(
      scores([
        0.9678303003311157,
        0.9672468900680542,
        0.9668961763381958,
        0.9627615809440613,
        0.9624517560005188,
        0.9612139463424683,
        0.9602217078208923,
        0.9599061608314514,
        0.9586285352706909,
        0.9584800601005554,
        0.958349883556366,
        0.9575690627098083,
        0.9558097720146179,
        0.9542057514190674,
        0.9529860019683838,
        0.9525855183601379,
        0.9523143172264099,
        0.9522246718406677,
        0.9522071480751038,
        0.9516226053237915,
        0.9509137272834778,
        0.9494642019271851,
        0.9490433931350708,
        0.9476617574691772,
        0.9469627141952515,
        0.9458957314491272,
        0.9445202946662903,
        0.9444233775138855,
        0.9433098435401917,
        0.943254828453064,
        0.9430137276649475,
        0.9429445266723633,
        0.942156195640564,
        0.9420648217201233,
        0.941472053527832,
        0.9398826956748962,
        0.9363453388214111,
        0.9342208504676819,
        0.9336098432540894,
        0.933053731918335,
        0.9329855442047119,
        0.9318833351135254,
        0.9316516518592834,
        0.9300733804702759,
        0.9291808605194092,
        0.9282968044281006,
        0.9280565977096558,
        0.926908016204834,
        0.9226776957511902,
        0.669868528842926,
      ]),
      50,
    );

    expect(selection).toEqual({ cutoffRank: 49, reason: "relevance-cliff" });
  });

  it("exposes the complete versioned policy configuration", () => {
    expect(answerContextSelectionConfig).toEqual({
      minimumLogGapMedianMultiplier: 3,
      minimumScoreRatio: 3,
      minimumTailGapFraction: 0.5,
      minimumTailScoreRatio: 1.25,
      policy: "relative-relevance-cliff-v3",
    });
  });
});

function scores(values: number[]): Array<{ relevanceScore: number }> {
  return values.map((relevanceScore) => ({ relevanceScore }));
}
