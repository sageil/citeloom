function formatScore(value) {
  return value.toFixed(3);
}

const SCORE_DISPLAY_POSITIONS = {
  lower: "12.5%",
  center: "50%",
  upper: "87.5%",
};

function createScoreMarker(value, supportThreshold, position) {
  return {
    label: formatScore(value),
    position,
    status: value >= supportThreshold ? "supported" : "unsupported",
  };
}

function findMinimumCitationScore(claims, citationNumber) {
  let citationScore = null;
  for (const claim of claims) {
    for (const evidenceUnit of claim.evidenceUnits) {
      if (
        evidenceUnit.citationNumber !== citationNumber
        || evidenceUnit.supportProbability === null
      ) {
        continue;
      }
      if (
        citationScore === null
        || evidenceUnit.supportProbability < citationScore
      ) {
        citationScore = evidenceUnit.supportProbability;
      }
    }
  }
  return citationScore;
}

export function buildEvidenceScoreScale(
  claims,
  citationNumber,
  supportThreshold,
) {
  if (citationNumber === null || supportThreshold === null) {
    return null;
  }
  const citationScore = findMinimumCitationScore(claims, citationNumber);
  if (citationScore === null) {
    return null;
  }
  const markerPosition = citationScore < supportThreshold
    ? SCORE_DISPLAY_POSITIONS.lower
    : SCORE_DISPLAY_POSITIONS.upper;
  const marker = createScoreMarker(
    citationScore,
    supportThreshold,
    markerPosition,
  );
  const thresholdLabel = formatScore(supportThreshold);
  const scoreLabel = `HHEM citation score ${formatScore(citationScore)}`;
  return {
    ariaLabel: `${scoreLabel}. Global support threshold ${thresholdLabel}.`,
    markers: [marker],
    thresholdLabel,
    thresholdPosition: SCORE_DISPLAY_POSITIONS.center,
  };
}
