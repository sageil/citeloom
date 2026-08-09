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

function findClaimCitationScore(claims, claimIndex, citationNumber) {
  if (claimIndex === null) {
    return null;
  }
  for (const claim of claims) {
    if (claim.claimIndex !== claimIndex) {
      continue;
    }
    for (const evidenceUnit of claim.evidenceUnits) {
      if (
        evidenceUnit.citationNumber !== citationNumber
        || evidenceUnit.supportProbability === null
      ) {
        continue;
      }
      return evidenceUnit.supportProbability;
    }
    return null;
  }
  return null;
}

export function buildEvidenceScoreScale(
  claims,
  claimIndex,
  citationNumber,
  supportThreshold,
) {
  if (
    claimIndex === null
    || citationNumber === null
    || supportThreshold === null
  ) {
    return null;
  }
  const claimScore = findClaimCitationScore(
    claims,
    claimIndex,
    citationNumber,
  );
  if (claimScore === null) {
    return null;
  }
  const markerPosition = claimScore < supportThreshold
    ? SCORE_DISPLAY_POSITIONS.lower
    : SCORE_DISPLAY_POSITIONS.upper;
  const marker = createScoreMarker(
    claimScore,
    supportThreshold,
    markerPosition,
  );
  const thresholdLabel = formatScore(supportThreshold);
  const scoreLabel = `HHEM claim score ${formatScore(claimScore)}`;
  return {
    ariaLabel: `${scoreLabel}. Global support threshold ${thresholdLabel}.`,
    markers: [marker],
    thresholdLabel,
    thresholdPosition: SCORE_DISPLAY_POSITIONS.center,
  };
}
