export interface AnswerContextSelectionConfig {
  minimumLogGapMedianMultiplier: number;
  minimumScoreRatio: number;
  minimumTailGapFraction: number;
  minimumTailScoreRatio: number;
  policy: "relative-relevance-cliff-v3";
}

export interface ScoredCandidate {
  relevanceScore: number;
}

export interface AnswerContextSelection {
  cutoffRank: number;
  reason: "maximum-context" | "relevance-cliff";
}

export const answerContextSelectionConfig: AnswerContextSelectionConfig = {
  minimumLogGapMedianMultiplier: 3,
  minimumScoreRatio: 3,
  minimumTailGapFraction: 0.5,
  minimumTailScoreRatio: 1.25,
  policy: "relative-relevance-cliff-v3",
};

export function selectAnswerContextCutoff(
  ranking: readonly ScoredCandidate[],
  maximumContextSize: number,
  config: AnswerContextSelectionConfig = answerContextSelectionConfig,
): AnswerContextSelection {
  validateSelectionInput(ranking, maximumContextSize, config);
  const maximumSelected = Math.min(maximumContextSize, ranking.length);
  if (maximumSelected <= 1) {
    return { cutoffRank: maximumSelected, reason: "maximum-context" };
  }

  const comparisonEnd = maximumSelected;
  const logGaps: number[] = [];
  for (let index = 0; index < comparisonEnd - 1; index += 1) {
    const current = ranking[index];
    const next = ranking[index + 1];
    if (current === undefined || next === undefined) {
      throw new Error(`Missing reranker score at index ${index}.`);
    }
    if (current.relevanceScore <= 0 || next.relevanceScore <= 0) {
      return { cutoffRank: maximumSelected, reason: "maximum-context" };
    }
    logGaps.push(Math.max(
      0,
      Math.log(current.relevanceScore) - Math.log(next.relevanceScore),
    ));
  }
  if (logGaps.length === 0) {
    return { cutoffRank: maximumSelected, reason: "maximum-context" };
  }

  let largestLogGap = 0;
  let largestLogGapIndex = -1;
  for (let index = 0; index < logGaps.length; index += 1) {
    const gap = logGaps[index] ?? 0;
    if (gap > largestLogGap) {
      largestLogGap = gap;
      largestLogGapIndex = index;
    }
  }
  if (largestLogGapIndex < 0 || largestLogGap === 0) {
    return { cutoffRank: maximumSelected, reason: "maximum-context" };
  }

  const medianLogGap = readMedian(logGaps);
  const cutoffRank = largestLogGapIndex + 1;
  const current = ranking[largestLogGapIndex];
  const next = ranking[largestLogGapIndex + 1];
  if (current === undefined || next === undefined) {
    throw new Error("Reranker relevance cliff is incomplete.");
  }
  const scoreRatio = current.relevanceScore / next.relevanceScore;
  const medianMultiplier = medianLogGap > 0
    ? largestLogGap / medianLogGap
    : Number.POSITIVE_INFINITY;
  const strongestScore = ranking[0]?.relevanceScore ?? 0;
  const weakestScore = ranking[maximumSelected - 1]?.relevanceScore ?? 0;
  const scoreRange = strongestScore - weakestScore;
  const scoreGap = current.relevanceScore - next.relevanceScore;
  const tailGapFraction = scoreRange > 0 ? scoreGap / scoreRange : 0;
  const stronglySeparated = scoreRatio >= config.minimumScoreRatio;
  const isolatedTail = scoreRatio >= config.minimumTailScoreRatio
    && tailGapFraction >= config.minimumTailGapFraction;
  if (
    cutoffRank < maximumSelected
    && (stronglySeparated || isolatedTail)
    && medianMultiplier >= config.minimumLogGapMedianMultiplier
  ) {
    return { cutoffRank, reason: "relevance-cliff" };
  }
  return { cutoffRank: maximumSelected, reason: "maximum-context" };
}

function validateSelectionInput(
  ranking: readonly ScoredCandidate[],
  maximumContextSize: number,
  config: AnswerContextSelectionConfig,
): void {
  if (!Number.isInteger(maximumContextSize) || maximumContextSize < 1) {
    throw new Error("Maximum answer context size must be a positive integer.");
  }
  if (
    !Number.isFinite(config.minimumLogGapMedianMultiplier)
    || config.minimumLogGapMedianMultiplier < 1
  ) {
    throw new Error("Minimum log-gap median multiplier must be at least one.");
  }
  if (
    !Number.isFinite(config.minimumScoreRatio)
    || config.minimumScoreRatio <= 1
  ) {
    throw new Error("Minimum adjacent score ratio must be greater than one.");
  }
  if (
    !Number.isFinite(config.minimumTailScoreRatio)
    || config.minimumTailScoreRatio <= 1
  ) {
    throw new Error("Minimum tail score ratio must be greater than one.");
  }
  if (
    !Number.isFinite(config.minimumTailGapFraction)
    || config.minimumTailGapFraction <= 0
    || config.minimumTailGapFraction > 1
  ) {
    throw new Error(
      "Minimum tail gap fraction must be greater than zero and at most one.",
    );
  }
  for (const candidate of ranking) {
    if (!Number.isFinite(candidate.relevanceScore)) {
      throw new Error("Reranker scores must be finite.");
    }
  }
}

function readMedian(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const value = sorted[middle];
  if (value === undefined) {
    throw new Error("Cannot calculate a median without values.");
  }
  if (sorted.length % 2 === 1) {
    return value;
  }
  const lower = sorted[middle - 1];
  if (lower === undefined) {
    throw new Error("Median comparison window is incomplete.");
  }
  return (lower + value) / 2;
}
