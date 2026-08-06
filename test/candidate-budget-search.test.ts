import { describe, expect, it } from "vitest";

import {
  CandidateBudgetSearch,
} from "../src/retrieval/indexing/candidate-budget-search.js";

describe("candidate budget search", () => {
  it("uses exact retrieval when the complete scope fits in the budget", () => {
    const search = new CandidateBudgetSearch(10, {
      scopedRepresentationCount: 8,
      totalRepresentationCount: 2_000,
    });

    expect(search.strategy).toBe("exact");
    expect(search.rawLimit).toBe(8);
    expect(search.advance(8, 6)).toBe(false);
  });

  it("uses indexed retrieval until exact scope scoring is cheaper", () => {
    const search = new CandidateBudgetSearch(50, {
      scopedRepresentationCount: 1_000,
      totalRepresentationCount: 5_000,
    });

    expect(search.strategy).toBe("indexed");
    while (search.rawLimit < 800) {
      expect(search.advance(search.rawLimit, 5)).toBe(true);
    }
    expect(search.advance(search.rawLimit, 5)).toBe(true);
    expect(search.strategy).toBe("exact");
    expect(search.rawLimit).toBe(800);
    expect(search.advance(800, 5)).toBe(true);
    expect(search.rawLimit).toBe(1_000);
    expect(search.advance(1_000, 5)).toBe(false);
  });

  it("stops when the evidence budget is full", () => {
    const filled = new CandidateBudgetSearch(10, {
      scopedRepresentationCount: 20,
      totalRepresentationCount: 20,
    });
    expect(filled.advance(10, 10)).toBe(false);
  });

  it("uses exact retrieval to prove exhaustion after a short indexed scan", () => {
    const search = new CandidateBudgetSearch(10, {
      scopedRepresentationCount: 200,
      totalRepresentationCount: 1_000,
    });
    expect(search.advance(9, 4)).toBe(true);
    expect(search.strategy).toBe("exact");
    expect(search.rawLimit).toBe(10);
  });
});
