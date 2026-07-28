import { createHash } from "node:crypto";

const DEFAULT_RESAMPLES = 10_000;
const TWO_SIDED_95_PERCENT_Z_SCORE = 1.959963984540054;
const EIGHTY_PERCENT_POWER_Z_SCORE = 0.8416212335729143;

export interface EvaluationConfidenceInterval {
  confidenceLevel: 0.95;
  lower: number;
  method: "percentile-bootstrap";
  resamples: number;
  upper: number;
}

export interface EvaluationStatisticalDesign {
  alpha: 0.05;
  alternative: "two-sided";
  assumedPairedNdcgDeltaStandardDeviation: number;
  method: "normal-approximation-paired-mean";
  minimumDetectableNdcgDelta: number;
  power: 0.8;
  requiredCaseCount: number;
}

export function createEvaluationStatisticalDesign(
  minimumDetectableNdcgDelta: number,
  assumedPairedNdcgDeltaStandardDeviation: number,
): EvaluationStatisticalDesign {
  return {
    alpha: 0.05,
    alternative: "two-sided",
    assumedPairedNdcgDeltaStandardDeviation,
    method: "normal-approximation-paired-mean",
    minimumDetectableNdcgDelta,
    power: 0.8,
    requiredCaseCount: calculateRequiredPairedCaseCount(
      minimumDetectableNdcgDelta,
      assumedPairedNdcgDeltaStandardDeviation,
    ),
  };
}

export function calculateRequiredPairedCaseCount(
  minimumDetectableDelta: number,
  assumedPairedDeltaStandardDeviation: number,
): number {
  if (
    !Number.isFinite(minimumDetectableDelta) ||
    minimumDetectableDelta <= 0 ||
    minimumDetectableDelta > 1
  ) {
    throw new Error(
      "The minimum detectable paired delta must be greater than 0 and at most 1.",
    );
  }
  if (
    !Number.isFinite(assumedPairedDeltaStandardDeviation) ||
    assumedPairedDeltaStandardDeviation <= 0 ||
    assumedPairedDeltaStandardDeviation > 1
  ) {
    throw new Error(
      "The assumed paired delta standard deviation must be greater than 0 and at most 1.",
    );
  }
  const zScore = TWO_SIDED_95_PERCENT_Z_SCORE +
    EIGHTY_PERCENT_POWER_Z_SCORE;
  const standardizedRequirement = (
    zScore * assumedPairedDeltaStandardDeviation
  ) / minimumDetectableDelta;
  return Math.max(1, Math.ceil(standardizedRequirement ** 2));
}

export function calculateBootstrapMeanInterval(
  values: number[],
  seed: string,
  resamples: number = DEFAULT_RESAMPLES,
): EvaluationConfidenceInterval {
  if (values.length === 0) {
    throw new Error("A confidence interval requires at least one value.");
  }
  if (!Number.isInteger(resamples) || resamples < 1_000) {
    throw new Error("Bootstrap resamples must be an integer of at least 1000.");
  }
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error("Confidence interval values must be finite.");
    }
  }
  if (values.length === 1) {
    const value = values[0];
    if (value === undefined) {
      throw new Error("Missing confidence interval value.");
    }
    return createInterval(value, value, resamples);
  }

  const random = createDeterministicRandom(seed);
  const means: number[] = [];
  for (let iteration = 0; iteration < resamples; iteration += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      const sampleIndex = Math.floor(random() * values.length);
      const sample = values[sampleIndex];
      if (sample === undefined) {
        throw new Error(`Missing bootstrap sample at index ${sampleIndex}.`);
      }
      total += sample;
    }
    means.push(total / values.length);
  }
  means.sort((left, right) => left - right);
  return createInterval(
    readPercentile(means, 0.025),
    readPercentile(means, 0.975),
    resamples,
  );
}

function createInterval(
  lower: number,
  upper: number,
  resamples: number,
): EvaluationConfidenceInterval {
  return {
    confidenceLevel: 0.95,
    lower,
    method: "percentile-bootstrap",
    resamples,
    upper,
  };
}

function readPercentile(sortedValues: number[], percentile: number): number {
  const index = Math.floor((sortedValues.length - 1) * percentile);
  const value = sortedValues[index];
  if (value === undefined) {
    throw new Error(`Missing bootstrap percentile ${percentile}.`);
  }
  return value;
}

function createDeterministicRandom(seed: string): () => number {
  const digest = createHash("sha256").update(seed).digest();
  let state = digest.readUInt32BE(0);
  if (state === 0) {
    state = 0x9e3779b9;
  }
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}
