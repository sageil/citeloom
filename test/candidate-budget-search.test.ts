import { describe, expect, it } from "vitest";

import {
  CandidateBudgetSearch,
} from "../src/retrieval/indexing/candidate-budget-search.js";

describe("candidate budget search", () => {
  it("uses exact retrieval for narrow scopes and continues after duplicates", () => {
    const search = new CandidateBudgetSearch(10, 2);

    expect(search.strategy).toBe("exact");
    expect(search.rawLimit).toBe(10);
    expect(search.advance(10, 6)).toBe(true);
    expect(search.rawLimit).toBe(20);
    expect(search.strategy).toBe("exact");
  });

  it("uses indexed retrieval for broad scopes and falls back to exact", () => {
    const search = new CandidateBudgetSearch(256, 20);

    expect(search.strategy).toBe("indexed");
    while (search.rawLimit < 4_096) {
      expect(search.advance(search.rawLimit, 5)).toBe(true);
    }
    expect(search.advance(search.rawLimit, 5)).toBe(true);
    expect(search.strategy).toBe("exact");
    expect(search.rawLimit).toBe(256);
  });

  it("stops when the evidence budget is full or raw scope is exhausted", () => {
    const filled = new CandidateBudgetSearch(10, 20);
    expect(filled.advance(10, 10)).toBe(false);

    const exhausted = new CandidateBudgetSearch(10, 20);
    expect(exhausted.advance(9, 4)).toBe(false);
  });
});
