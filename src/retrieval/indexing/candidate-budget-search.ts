export type RetrievalSearchStrategy = "exact" | "indexed";

export interface RetrievalScopeCardinality {
  scopedRepresentationCount: number;
  totalRepresentationCount: number;
}

export class CandidateBudgetSearch {
  private readonly initialCandidateBudget: number;
  private readonly scopedRepresentationCount: number;
  private readonly totalRepresentationCount: number;
  public rawLimit: number;
  public strategy: RetrievalSearchStrategy;

  public constructor(
    candidateBudget: number,
    cardinality: RetrievalScopeCardinality,
  ) {
    if (!Number.isInteger(candidateBudget) || candidateBudget < 1) {
      throw new Error("Candidate budget must be a positive integer.");
    }
    if (
      !Number.isInteger(cardinality.scopedRepresentationCount)
      || cardinality.scopedRepresentationCount < 1
    ) {
      throw new Error("Resolved retrieval scope cannot be empty.");
    }
    if (
      !Number.isInteger(cardinality.totalRepresentationCount)
      || cardinality.totalRepresentationCount
        < cardinality.scopedRepresentationCount
    ) {
      throw new Error("Total retrieval cardinality is smaller than the scope.");
    }
    this.initialCandidateBudget = candidateBudget;
    this.scopedRepresentationCount = cardinality.scopedRepresentationCount;
    this.totalRepresentationCount = cardinality.totalRepresentationCount;
    this.strategy = cardinality.scopedRepresentationCount <= candidateBudget
      ? "exact"
      : "indexed";
    this.rawLimit = Math.min(
      candidateBudget,
      this.strategy === "exact"
        ? this.scopedRepresentationCount
        : this.totalRepresentationCount,
    );
  }

  public advance(rawCount: number, uniqueEvidenceCount: number): boolean {
    if (uniqueEvidenceCount >= this.initialCandidateBudget) {
      return false;
    }
    if (this.strategy === "exact") {
      if (
        rawCount < this.rawLimit
        || this.rawLimit >= this.scopedRepresentationCount
      ) {
        return false;
      }
      this.rawLimit = Math.min(
        this.rawLimit * 2,
        this.scopedRepresentationCount,
      );
      return true;
    }
    const nextIndexedLimit = Math.min(
      this.rawLimit * 2,
      this.totalRepresentationCount,
    );
    if (
      rawCount < this.rawLimit
      || nextIndexedLimit >= this.scopedRepresentationCount
      || nextIndexedLimit === this.rawLimit
    ) {
      this.strategy = "exact";
      this.rawLimit = Math.min(
        Math.max(this.rawLimit, this.initialCandidateBudget),
        this.scopedRepresentationCount,
      );
      return true;
    }
    this.rawLimit = nextIndexedLimit;
    return true;
  }
}
