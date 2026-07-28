export interface AnswerContextSelectionConfig {
  minimumLogGapMedianMultiplier: number;
  minimumScoreRatio: number;
  policy: "relative-relevance-cliff-v2";
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
  policy: "relative-relevance-cliff-v2",
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
  if (
    cutoffRank < maximumSelected
    && scoreRatio >= config.minimumScoreRatio
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
