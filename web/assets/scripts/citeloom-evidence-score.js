function formatScore(value) {
  return value.toFixed(3);
}

function scoreAlignment(value) {
  if (value <= 0.12) {
    return "start";
  }
  if (value >= 0.88) {
    return "end";
  }
  return "center";
}

function scorePosition(value) {
  return `${(value * 100).toFixed(4)}%`;
}

function createScoreMarker(value, supportThreshold) {
  return {
    alignment: scoreAlignment(value),
    label: formatScore(value),
    position: scorePosition(value),
    status: value >= supportThreshold ? "supported" : "unsupported",
  };
}

export function buildEvidenceScoreScale(
  claims,
  citationNumber,
  supportThreshold,
) {
  if (citationNumber === null || supportThreshold === null) {
    return null;
  }
  const scoreSet = new Set();
  for (const claim of claims) {
    for (const evidenceUnit of claim.evidenceUnits) {
      if (
        evidenceUnit.citationNumber === citationNumber
        && evidenceUnit.supportProbability !== null
      ) {
        scoreSet.add(evidenceUnit.supportProbability);
      }
    }
  }
  const scores = [...scoreSet].sort((left, right) => left - right);
  const minimumScore = scores[0];
  if (minimumScore === undefined) {
    return null;
  }
  const maximumScore = scores[scores.length - 1] ?? minimumScore;
  const markers = [createScoreMarker(minimumScore, supportThreshold)];
  if (maximumScore !== minimumScore) {
    markers.push(createScoreMarker(maximumScore, supportThreshold));
  }
  const thresholdLabel = formatScore(supportThreshold);
  const scoreLabel = maximumScore === minimumScore
    ? `HHEM score ${formatScore(minimumScore)}`
    : `HHEM score range ${formatScore(minimumScore)} to ${formatScore(maximumScore)}`;
  return {
    ariaLabel: `${scoreLabel}. Global support threshold ${thresholdLabel}.`,
    markers,
    thresholdAlignment: scoreAlignment(supportThreshold),
    thresholdLabel,
    thresholdPosition: scorePosition(supportThreshold),
  };
}
