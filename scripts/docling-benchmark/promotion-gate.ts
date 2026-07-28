import type { DoclingPromotionAssessment } from "./model.js";
import type { StoredDoclingBenchmarkResult } from "./store.js";

export interface EvaluateDoclingPromotionInput {
  baselineCandidateId: string;
  candidateId: string;
  expectedDocumentCount: number;
  p95LatencyRegressionLimit: number;
  peakMemoryRegressionLimit: number;
  performanceThreshold: number;
  repetitions: number;
  results: StoredDoclingBenchmarkResult[];
}

export function evaluateDoclingPromotion(
  input: EvaluateDoclingPromotionInput,
): DoclingPromotionAssessment {
  const baseline = selectFinalResults(input.results, input.baselineCandidateId);
  const candidate = selectFinalResults(input.results, input.candidateId);
  const reasons: string[] = [];
  const expectedResultCount = input.expectedDocumentCount * input.repetitions;
  requireCompleteSuccessfulResults(
    "baseline",
    baseline,
    expectedResultCount,
    reasons,
  );
  requireCompleteSuccessfulResults(
    "candidate",
    candidate,
    expectedResultCount,
    reasons,
  );
  requireOutputEquivalence("baseline", baseline, reasons);
  requireOutputEquivalence("candidate", candidate, reasons);
  const candidateDocuments = readSuccessfulDocumentIds(candidate);
  if (candidateDocuments.size !== input.expectedDocumentCount) {
    reasons.push(
      `Candidate covered ${candidateDocuments.size} of ${input.expectedDocumentCount} documents.`,
    );
  }

  const baselineWall = readSuccessfulMeasurements(baseline, "totalWallMs");
  const candidateWall = readSuccessfulMeasurements(candidate, "totalWallMs");
  const baselineCorpusWall = readFullCorpusWallTimes(
    baseline,
    input.expectedDocumentCount,
    input.repetitions,
  );
  const candidateCorpusWall = readFullCorpusWallTimes(
    candidate,
    input.expectedDocumentCount,
    input.repetitions,
  );
  if (baselineCorpusWall === null) {
    reasons.push("Baseline full-corpus repetition timings are incomplete.");
  }
  if (candidateCorpusWall === null) {
    reasons.push("Candidate full-corpus repetition timings are incomplete.");
  }
  const baselineMedianWallMs = medianOrNull(baselineCorpusWall ?? []);
  const candidateMedianWallMs = medianOrNull(candidateCorpusWall ?? []);
  const baselineP95WallMs = percentileOrNull(baselineWall, 0.95);
  const candidateP95WallMs = percentileOrNull(candidateWall, 0.95);
  const performanceImprovement = calculateImprovement(
    baselineMedianWallMs,
    candidateMedianWallMs,
  );
  const latencyP95Regression = calculateRegression(
    baselineP95WallMs,
    candidateP95WallMs,
  );
  if (
    performanceImprovement === null
    || performanceImprovement < input.performanceThreshold
  ) {
    reasons.push(
      `Median wall-time improvement did not meet the preregistered ${(input.performanceThreshold * 100).toFixed(1)}% threshold.`,
    );
  }
  const repetitionImprovements = calculateRepetitionImprovements(
    baselineCorpusWall,
    candidateCorpusWall,
  );
  if (
    repetitionImprovements === null
    || repetitionImprovements.some((improvement) => {
      return improvement < input.performanceThreshold;
    })
  ) {
    reasons.push(
      `Every full-corpus repetition must meet the preregistered ${(input.performanceThreshold * 100).toFixed(1)}% improvement threshold.`,
    );
  }
  if (
    latencyP95Regression === null
    || latencyP95Regression > input.p95LatencyRegressionLimit
  ) {
    reasons.push(
      `P95 wall-time regression exceeded the preregistered ${(input.p95LatencyRegressionLimit * 100).toFixed(1)}% limit.`,
    );
  }

  const baselineMemory = readSuccessfulMeasurements(
    baseline,
    "peakResidentBytes",
  );
  const candidateMemory = readSuccessfulMeasurements(
    candidate,
    "peakResidentBytes",
  );
  const memoryRegression = calculateRegression(
    percentileOrNull(baselineMemory, 0.95),
    percentileOrNull(candidateMemory, 0.95),
  );
  if (
    memoryRegression === null
    || memoryRegression > input.peakMemoryRegressionLimit
  ) {
    reasons.push(
      `P95 resident-memory regression exceeded the preregistered ${(input.peakMemoryRegressionLimit * 100).toFixed(1)}% limit.`,
    );
  }
  return {
    baselineCandidateId: input.baselineCandidateId,
    baselineMedianWallMs,
    baselineP95WallMs,
    candidateMedianWallMs,
    candidateP95WallMs,
    eligible: reasons.length === 0,
    evaluatedDocumentCount: candidateDocuments.size,
    expectedDocumentCount: input.expectedDocumentCount,
    latencyP95Regression,
    memoryRegression,
    performanceImprovement,
    promotionCandidateId: input.candidateId,
    reasons,
  };
}

function requireOutputEquivalence(
  label: string,
  results: StoredDoclingBenchmarkResult[],
  reasons: string[],
): void {
  let qualityFailures = 0;
  for (const result of results) {
    if (result.qualityPassed !== true) {
      qualityFailures += 1;
    }
  }
  if (qualityFailures > 0) {
    reasons.push(`${qualityFailures} ${label} result(s) failed output equivalence.`);
  }
}

function readSuccessfulDocumentIds(
  results: StoredDoclingBenchmarkResult[],
): Set<string> {
  const documentIds = new Set<string>();
  for (const result of results) {
    if (result.outcome === "success") {
      documentIds.add(result.documentId);
    }
  }
  return documentIds;
}

function selectFinalResults(
  results: StoredDoclingBenchmarkResult[],
  candidateId: string,
): StoredDoclingBenchmarkResult[] {
  const selected: StoredDoclingBenchmarkResult[] = [];
  for (const result of results) {
    if (result.candidateId === candidateId) {
      selected.push(result);
    }
  }
  return selected;
}

function requireCompleteSuccessfulResults(
  label: string,
  results: StoredDoclingBenchmarkResult[],
  expectedCount: number,
  reasons: string[],
): void {
  if (results.length !== expectedCount) {
    reasons.push(
      `${label} has ${results.length} of ${expectedCount} required measured results.`,
    );
  }
  let failures = 0;
  for (const result of results) {
    if (result.outcome !== "success") {
      failures += 1;
    }
  }
  if (failures > 0) {
    reasons.push(`${label} has ${failures} conversion failure(s) or timeout(s).`);
  }
}

function readSuccessfulMeasurements(
  results: StoredDoclingBenchmarkResult[],
  field: "peakResidentBytes" | "totalWallMs",
): number[] {
  const values: number[] = [];
  for (const result of results) {
    const value = result[field];
    if (result.outcome === "success" && value !== null) {
      values.push(value);
    }
  }
  return values;
}

function readFullCorpusWallTimes(
  results: StoredDoclingBenchmarkResult[],
  expectedDocumentCount: number,
  repetitions: number,
): number[] | null {
  const totals = new Map<number, { count: number; totalWallMs: number }>();
  for (const result of results) {
    if (result.outcome !== "success" || result.totalWallMs === null) {
      return null;
    }
    const current = totals.get(result.repetition) ?? {
      count: 0,
      totalWallMs: 0,
    };
    current.count += 1;
    current.totalWallMs += result.totalWallMs;
    totals.set(result.repetition, current);
  }
  const ordered: number[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const total = totals.get(repetition);
    if (total === undefined || total.count !== expectedDocumentCount) {
      return null;
    }
    ordered.push(total.totalWallMs);
  }
  if (totals.size !== repetitions) {
    return null;
  }
  return ordered;
}

function calculateRepetitionImprovements(
  baseline: number[] | null,
  candidate: number[] | null,
): number[] | null {
  if (baseline === null || candidate === null || baseline.length !== candidate.length) {
    return null;
  }
  const improvements: number[] = [];
  for (let index = 0; index < baseline.length; index += 1) {
    const improvement = calculateImprovement(
      baseline[index] ?? null,
      candidate[index] ?? null,
    );
    if (improvement === null) {
      return null;
    }
    improvements.push(improvement);
  }
  return improvements;
}

function medianOrNull(values: number[]): number | null {
  return percentileOrNull(values, 0.5);
}

function percentileOrNull(
  values: number[],
  percentile: number,
): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index] ?? null;
}

function calculateImprovement(
  baseline: number | null,
  candidate: number | null,
): number | null {
  if (baseline === null || candidate === null || baseline <= 0) {
    return null;
  }
  return (baseline - candidate) / baseline;
}

function calculateRegression(
  baseline: number | null,
  candidate: number | null,
): number | null {
  if (baseline === null || candidate === null || baseline <= 0) {
    return null;
  }
  return (candidate - baseline) / baseline;
}
