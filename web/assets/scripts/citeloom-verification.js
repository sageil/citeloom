import {
  readArray,
  readEnum,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullableProbability,
  readPlainObject,
  readPositiveInteger,
} from "./citeloom-boundaries.js";

const verificationRefreshDelayMs = 800;
const verificationStates = Object.freeze([
  "not-applicable",
  "pending",
  "running",
  "completed",
  "failed",
]);
const evidenceUnitOutcomes = Object.freeze([
  "not-evaluated",
  "supported",
  "unsupported",
  "verifier-incompatible",
]);
const claimSupportStatuses = Object.freeze([
  "partially-supported",
  "supported",
  "unsupported",
  "unverified",
]);

function readVerificationClaims(
  value,
  answerDocument,
  labelPrefix,
  readClaimId,
) {
  const values = readArray(value, `${labelPrefix}s`);
  const claims = [];
  const checkedStatementIndexes = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const label = `${labelPrefix} ${index + 1}`;
    const candidate = readPlainObject(values[index], label);
    const claimIndex = readNonNegativeInteger(
      candidate.claimIndex,
      `${label} statement index`,
    );
    if (checkedStatementIndexes.has(claimIndex)) {
      throw new Error(`${label} duplicates statement index ${claimIndex}.`);
    }
    const statement = answerDocument.statements[claimIndex];
    if (statement === undefined) {
      throw new Error(`${label} refers to an unavailable statement.`);
    }
    const claim = readNonEmptyString(candidate.claim, `${label} text`);
    if (claim !== statement.content) {
      throw new Error(`${label} does not match its answer statement.`);
    }
    const evidence = readVerificationEvidenceUnits(
      candidate.evidenceUnits,
      candidate.citationNumbers,
      label,
    );
    checkedStatementIndexes.add(claimIndex);
    claims.push({
      citationNumbers: evidence.citationNumbers,
      claim,
      claimIndex,
      evidenceUnits: evidence.evidenceUnits,
      id: readClaimId(candidate, label),
      rationale: readNonEmptyString(candidate.rationale, `${label} rationale`),
      status: readEnum(
        candidate.status,
        claimSupportStatuses,
        `${label} status`,
      ),
    });
  }
  return claims;
}

export function readAnswerVerificationClaims(
  value,
  answerDocument,
  labelPrefix,
) {
  return readVerificationClaims(
    value,
    answerDocument,
    labelPrefix,
    () => null,
  );
}

export function readStoredAnswerVerificationClaims(
  value,
  answerDocument,
  labelPrefix,
) {
  return readVerificationClaims(
    value,
    answerDocument,
    labelPrefix,
    (candidate, label) => readNonEmptyString(candidate.id, `${label} ID`),
  );
}

export function readVerificationState(value, label) {
  return readEnum(value, verificationStates, label);
}

export function readVerificationEvidenceUnits(
  value,
  citationNumberValue,
  label,
) {
  const citationNumberValues = readArray(
    citationNumberValue,
    `${label} citation numbers`,
  );
  const citationNumbers = [];
  for (const citationNumberValue of citationNumberValues) {
    citationNumbers.push(readPositiveInteger(
      citationNumberValue,
      `${label} citation number`,
    ));
  }

  const values = readArray(value, `${label} evidence units`);
  const evidenceUnits = [];
  const seenCitationNumbers = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const unitLabel = `${label} evidence unit ${index + 1}`;
    const candidate = readPlainObject(values[index], unitLabel);
    const citationNumber = readPositiveInteger(
      candidate.citationNumber,
      `${unitLabel} citation number`,
    );
    if (
      seenCitationNumbers.has(citationNumber)
      || !citationNumbers.includes(citationNumber)
    ) {
      throw new Error(`${unitLabel} has an invalid citation number.`);
    }
    const supportProbability = readNullableProbability(
      candidate.supportProbability,
      `${unitLabel} support probability`,
    );
    readNonEmptyString(candidate.rationale, `${unitLabel} rationale`);
    readNonEmptyString(candidate.unitId, `${unitLabel} ID`);
    seenCitationNumbers.add(citationNumber);
    evidenceUnits.push({
      citationNumber,
      outcome: readEnum(
        candidate.outcome,
        evidenceUnitOutcomes,
        `${unitLabel} outcome`,
      ),
      supportProbability,
    });
  }
  if (seenCitationNumbers.size !== citationNumbers.length) {
    throw new Error(`${label} is missing citation evidence results.`);
  }
  return { citationNumbers, evidenceUnits };
}

export function isVerificationPending(state) {
  return state === "pending" || state === "running";
}

export function verificationLabel(state) {
  if (state === "pending") {
    return "Evidence validation is queued";
  }
  if (state === "running") {
    return "Validating evidence";
  }
  if (state === "completed") {
    return "Evidence validation complete";
  }
  if (state === "failed") {
    return "Evidence validation could not be completed";
  }
  return "Evidence validation is not required";
}

export function verificationStatusLabel(state) {
  if (state === "pending") {
    return "Queued";
  }
  if (state === "running") {
    return "Checking evidence";
  }
  if (state === "completed") {
    return "Verified";
  }
  if (state === "failed") {
    return "Check failed";
  }
  return "";
}

export function verificationProgressValue(state) {
  return state === "completed" ? 100 : null;
}

export function scheduleVerificationRefresh(page) {
  clearVerificationRefresh(page);
  if (!page.hasPendingVerification()) {
    return;
  }
  page.verificationRefreshTimer = window.setTimeout(() => {
    page.verificationRefreshTimer = null;
    void page.refreshVerification();
  }, verificationRefreshDelayMs);
}

export function clearVerificationRefresh(page) {
  if (page.verificationRefreshTimer === null) {
    return;
  }
  window.clearTimeout(page.verificationRefreshTimer);
  page.verificationRefreshTimer = null;
}

export async function runVerificationRefresh(page, refresh) {
  try {
    await refresh();
  } catch {
    // Refresh is best effort. The published answer remains usable.
  } finally {
    scheduleVerificationRefresh(page);
  }
}
