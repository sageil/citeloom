export type RetrievalSearchStrategy = "exact" | "indexed";

const NARROW_EXACT_SCOPE_MAXIMUM = 8;
const INDEXED_CANDIDATE_FALLBACK_LIMIT = 4_096;

export class CandidateBudgetSearch {
  private readonly initialCandidateBudget: number;
  public rawLimit: number;
  public strategy: RetrievalSearchStrategy;

  public constructor(candidateBudget: number, resolvedScopeSize: number) {
    if (!Number.isInteger(candidateBudget) || candidateBudget < 1) {
      throw new Error("Candidate budget must be a positive integer.");
    }
    if (!Number.isInteger(resolvedScopeSize) || resolvedScopeSize < 1) {
      throw new Error("Resolved retrieval scope cannot be empty.");
    }
    this.initialCandidateBudget = candidateBudget;
    this.rawLimit = candidateBudget;
    this.strategy = resolvedScopeSize <= NARROW_EXACT_SCOPE_MAXIMUM
      ? "exact"
      : "indexed";
  }

  public advance(rawCount: number, uniqueEvidenceCount: number): boolean {
    if (uniqueEvidenceCount >= this.initialCandidateBudget) {
      return false;
    }
    if (rawCount < this.rawLimit) {
      return false;
    }
    if (
      this.strategy === "indexed"
      && this.rawLimit >= INDEXED_CANDIDATE_FALLBACK_LIMIT
    ) {
      this.strategy = "exact";
      this.rawLimit = this.initialCandidateBudget;
      return true;
    }
    this.rawLimit *= 2;
    return true;
  }
}
