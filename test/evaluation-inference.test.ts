import { describe, expect, it } from "vitest";

import {
  decodeEvaluationQuestionResponse,
  decodeEvaluationRelevanceResponse,
} from "../tools/evaluation/inference.js";

describe("evaluation AI response decoding", () => {
  it("decodes a plain benchmark question at the provider boundary", () => {
    expect(decodeEvaluationQuestionResponse(
      "  When is veterinary treatment required?  ",
    )).toBe("When is veterinary treatment required?");
  });

  it("rejects non-question text", () => {
    expect(() => decodeEvaluationQuestionResponse("Here is a question"))
      .toThrow("must end with a question mark");
  });

  it("decodes exact relevance decisions", () => {
    expect(decodeEvaluationRelevanceResponse(" TRUE ")).toBe(true);
    expect(decodeEvaluationRelevanceResponse("false")).toBe(false);
  });

  it("rejects explanatory relevance output", () => {
    expect(() => decodeEvaluationRelevanceResponse("true because it matches"))
      .toThrow("Evaluation relevance response is invalid");
  });
});
