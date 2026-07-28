import { readClaimsFromAnswerMarkup } from "./claims.js";
import { parseAnswerMarkup } from "./markup.js";
import {
  createNoAnswerDocument,
  decodePublishedAnswerDocument,
  readPublishedAnswerClaims,
  type PublishedAnswerCitation,
  type PublishedAnswerDocument,
  type PublishedAnswerStatement,
} from "./published.js";
import type { TaskScheduler } from "../shared/concurrency.js";
import {
  HhemClientError,
  readHhemScoreItemLimitFailure,
  type HhemScoreItem,
  type HhemScoreResult,
} from "../verification/hhem-client.js";
import type { InferenceModelRegistry } from "../inference/registry.js";
import type {
  AnswerClaim,
  CitationEvidence,
  ClaimVerificationResult,
} from "../research/types.js";
import {
  createTelemetryStageResult,
  noopRunTelemetry,
  readTelemetryFailureOutcome,
  type RunTelemetry,
} from "../observability/run.js";

interface PreparedDirectClaimVerification {
  claim: AnswerClaim;
  citationNumber: number | null;
  kind: "direct";
  outcome: "not-evaluated" | "verifier-incompatible";
  rationale: string;
}

interface PreparedModelClaimVerification {
  claim: AnswerClaim;
  citationNumber: number;
  item: HhemScoreItem;
  kind: "model";
}

type PreparedClaimVerification =
  | PreparedDirectClaimVerification
  | PreparedModelClaimVerification;

type PendingCitationSetVerification =
  | {
    candidateCitationNumbers: number[];
    check: ClaimVerificationResult;
    kind: "independent-support";
    purpose: "prune-unsupported";
  }
  | {
    candidateCitationNumbers: number[];
    check: ClaimVerificationResult;
    kind: "model";
    item: HhemScoreItem;
    limitFailure: string | null;
    purpose: "collective-support" | "prune-unsupported";
  }
  | {
    candidateCitationNumbers: [number];
    check: ClaimVerificationResult;
    kind: "single";
    purpose: "collective-support" | "prune-unsupported";
  };

interface ClaimPublicationDecision {
  check: ClaimVerificationResult;
  citationNumbers: number[];
  publish: boolean;
}

interface ResolvedCitationSetVerification {
  citationNumbers: number[];
  check: ClaimVerificationResult;
  publish: boolean;
}

type ClaimVerificationFailureCategory =
  | "aborted"
  | "http-error"
  | "invalid-evidence"
  | "invalid-response"
  | "service-unavailable"
  | "timeout"
  | "unexpected";

interface ClaimVerificationFailure {
  category: ClaimVerificationFailureCategory;
  retryable: boolean;
  statusCode: number | null;
}

class ClaimVerificationDataError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ClaimVerificationDataError";
  }
}

export interface ClaimEvidenceSource {
  citationNumber: number;
  evidence: CitationEvidence;
  sectionPath: string[];
}

export interface VerifiedPublishedAnswer {
  answerDocument: PublishedAnswerDocument;
  claims: ClaimVerificationResult[];
}

export function readAnswerClaims(answer: string): AnswerClaim[] {
  const markup = parseAnswerMarkup(answer);
  return readClaimsFromAnswerMarkup(markup);
}

export async function verifyPublishedAnswer(
  models: InferenceModelRegistry,
  answerDocument: PublishedAnswerDocument,
  scheduler: TaskScheduler,
  abortSignal: AbortSignal,
  runTelemetry: RunTelemetry = noopRunTelemetry,
): Promise<VerifiedPublishedAnswer> {
  if (answerDocument.status === "no_answer") {
    return { answerDocument, claims: [] };
  }
  const claims = readPublishedAnswerClaims(answerDocument);
  const verifier = models.claimVerifier;
  const stage = runTelemetry.startStage({
    model: {
      modelId: verifier.modelId,
      provider: verifier.provider,
    },
    name: "claim-verification",
    retrievalMode: null,
  });
  const finishMetric = models.metrics.start(
    "claim-verification",
    verifier.provider,
    verifier.modelId,
  );
  try {
    const preparedClaims = prepareClaimVerifications(
      claims,
      answerDocument.citations,
    );
    const scores = await scorePreparedClaimVerifications(
      preparedClaims,
      verifier.score.bind(verifier),
      scheduler,
      abortSignal,
      stage.timingObserver,
    );
    const initialChecks = buildClaimVerificationResults(
      preparedClaims,
      scores,
      verifier.modelId,
      verifier.supportThreshold,
    );
    const pendingSets = prepareCitationSetVerifications(
      initialChecks,
      answerDocument.citations,
    );
    const setScores = await scorePendingCitationSets(
      pendingSets,
      verifier.score.bind(verifier),
      scheduler,
      abortSignal,
      stage.timingObserver,
    );
    const decisions = resolveClaimPublicationDecisions(
      initialChecks,
      pendingSets,
      setScores,
      verifier.supportThreshold,
    );
    applyConflictGroupPublicationDecisions(
      answerDocument.statements,
      decisions,
    );
    const verified = buildVerifiedPublishedAnswer(
      answerDocument,
      decisions,
    );
    finishMetric({
      finishReason: "stop",
      inputTokens: null,
      outputTokens: null,
    });
    const stageOutcome = verified.answerDocument.status === "no_answer"
      ? "fallback"
      : "success";
    await stage.finish(createTelemetryStageResult(stageOutcome, {
      inputCount: claims.length,
      outputCount: verified.claims.length,
    }));
    return verified;
  } catch (error: unknown) {
    const failure = readClaimVerificationFailure(error, abortSignal);
    finishMetric({
      finishReason: failure.category,
      inputTokens: null,
      outputTokens: null,
    });
    await stage.finish(createTelemetryStageResult(
      readTelemetryFailureOutcome(abortSignal),
      { inputCount: claims.length },
    ));
    reportClaimVerificationFailure(failure);
    throw error;
  }
}

export async function verifyAnswerClaims(
  models: InferenceModelRegistry,
  claims: readonly AnswerClaim[],
  sources: readonly ClaimEvidenceSource[],
  scheduler: TaskScheduler,
  abortSignal: AbortSignal,
  runTelemetry: RunTelemetry = noopRunTelemetry,
): Promise<ClaimVerificationResult[]> {
  if (claims.length === 0) {
    return [];
  }

  const verifier = models.claimVerifier;
  const stage = runTelemetry.startStage({
    model: {
      modelId: verifier.modelId,
      provider: verifier.provider,
    },
    name: "claim-verification",
    retrievalMode: null,
  });
  const finishMetric = models.metrics.start(
    "claim-verification",
    verifier.provider,
    verifier.modelId,
  );
  try {
    const preparedClaims = prepareClaimVerifications(claims, sources);
    const scores = await scorePreparedClaimVerifications(
      preparedClaims,
      verifier.score.bind(verifier),
      scheduler,
      abortSignal,
      stage.timingObserver,
    );
    const checks = buildClaimVerificationResults(
      preparedClaims,
      scores,
      verifier.modelId,
      verifier.supportThreshold,
    );
    finishMetric({
      finishReason: "stop",
      inputTokens: null,
      outputTokens: null,
    });
    await stage.finish(createTelemetryStageResult("success", {
      inputCount: claims.length,
      outputCount: checks.length,
    }));
    return checks;
  } catch (error: unknown) {
    const failure = readClaimVerificationFailure(error, abortSignal);
    finishMetric({
      finishReason: failure.category,
      inputTokens: null,
      outputTokens: null,
    });
    await stage.finish(createTelemetryStageResult(
      readTelemetryFailureOutcome(abortSignal),
      { inputCount: claims.length },
    ));
    reportClaimVerificationFailure(failure);
    throw error;
  }
}

function prepareClaimVerifications(
  claims: readonly AnswerClaim[],
  sources: readonly ClaimEvidenceSource[],
): PreparedClaimVerification[] {
  const sourceByNumber = new Map<number, ClaimEvidenceSource>();
  for (const source of sources) {
    sourceByNumber.set(source.citationNumber, source);
  }
  const seenClaimIndexes = new Set<number>();
  const preparedClaims: PreparedClaimVerification[] = [];
  for (const claim of claims) {
    if (seenClaimIndexes.has(claim.claimIndex)) {
      throw new ClaimVerificationDataError(
        `Claim index ${claim.claimIndex} is duplicated.`,
      );
    }
    seenClaimIndexes.add(claim.claimIndex);
    if (claim.citationNumbers.length === 0) {
      preparedClaims.push({
        claim,
        citationNumber: null,
        kind: "direct",
        outcome: "not-evaluated",
        rationale: "The claim has no citation to verify.",
      });
      continue;
    }
    for (const citationNumber of claim.citationNumbers) {
      const source = sourceByNumber.get(citationNumber);
      if (source === undefined) {
        throw new ClaimVerificationDataError(
          `Claim ${claim.claimIndex} references unavailable citation ${citationNumber}.`,
        );
      }
      const textEvidence = readTextEvidence(source.evidence);
      if (textEvidence === null) {
        preparedClaims.push({
          claim,
          citationNumber,
          kind: "direct",
          outcome: "verifier-incompatible",
          rationale:
            "The claim has no text or table citation that this verifier can assess; the cited evidence is verifier-incompatible.",
        });
        continue;
      }
      const evidenceUnit = buildTextEvidenceUnit(source);
      if (evidenceUnit === null) {
        throw new ClaimVerificationDataError(
          `Claim ${claim.claimIndex} has unavailable text evidence for citation ${citationNumber}.`,
        );
      }
      const item: HhemScoreItem = {
        claim: claim.claim,
        evidence: evidenceUnit,
        id: buildClaimItemId(claim.claimIndex, citationNumber),
      };
      const limitFailure = readHhemScoreItemLimitFailure(item);
      if (limitFailure !== null) {
        preparedClaims.push({
          claim,
          citationNumber,
          kind: "direct",
          outcome: "not-evaluated",
          rationale: limitFailure,
        });
        continue;
      }
      preparedClaims.push({
        claim,
        citationNumber,
        item,
        kind: "model",
      });
    }
  }
  return preparedClaims;
}

function readTextEvidence(evidence: CitationEvidence): string | null {
  if (evidence.kind === "text") {
    return evidence.excerpt;
  }
  if (evidence.kind === "table") {
    return evidence.content;
  }
  return null;
}

function buildTextEvidenceUnit(source: ClaimEvidenceSource): string | null {
  const textEvidence = readTextEvidence(source.evidence);
  if (textEvidence === null) {
    return null;
  }
  const evidenceParts = [`[Citation ${source.citationNumber}]`];
  if (source.sectionPath.length > 0) {
    evidenceParts.push(`Section: ${source.sectionPath.join(" > ")}`);
  }
  evidenceParts.push(textEvidence);
  return evidenceParts.join("\n");
}

function readModelClaimVerifications(
  preparedClaims: readonly PreparedClaimVerification[],
): PreparedModelClaimVerification[] {
  const modelClaims: PreparedModelClaimVerification[] = [];
  for (const prepared of preparedClaims) {
    if (prepared.kind !== "model") {
      continue;
    }
    modelClaims.push(prepared);
  }
  return modelClaims;
}

async function scorePreparedClaimVerifications(
  preparedClaims: readonly PreparedClaimVerification[],
  score: (
    items: readonly HhemScoreItem[],
    abortSignal: AbortSignal,
  ) => Promise<HhemScoreResult[]>,
  scheduler: TaskScheduler,
  abortSignal: AbortSignal,
  timingObserver: Parameters<TaskScheduler["run"]>[2],
): Promise<HhemScoreResult[]> {
  const modelClaims = readModelClaimVerifications(preparedClaims);
  if (modelClaims.length === 0) {
    return [];
  }
  const items: HhemScoreItem[] = [];
  for (const prepared of modelClaims) {
    items.push(prepared.item);
  }
  return scheduler.run(
    (requestSignal) => score(items, requestSignal),
    abortSignal,
    timingObserver,
  );
}

function prepareCitationSetVerifications(
  checks: readonly ClaimVerificationResult[],
  sources: readonly ClaimEvidenceSource[],
): PendingCitationSetVerification[] {
  const sourceByNumber = new Map<number, ClaimEvidenceSource>();
  for (const source of sources) {
    sourceByNumber.set(source.citationNumber, source);
  }
  const pending: PendingCitationSetVerification[] = [];
  for (const check of checks) {
    const supportedNumbers = readCitationNumbersByOutcome(check, "supported");
    const unsupportedNumbers = readCitationNumbersByOutcome(check, "unsupported");
    const uncertainNumbers = readUncertainCitationNumbers(check);
    if (unsupportedNumbers.length === 0) {
      continue;
    }
    let candidateCitationNumbers: number[];
    let purpose: PendingCitationSetVerification["purpose"];
    if (supportedNumbers.length > 0) {
      candidateCitationNumbers = check.citationNumbers.filter((citationNumber) => {
        return !unsupportedNumbers.includes(citationNumber);
      });
      purpose = "prune-unsupported";
      if (uncertainNumbers.length > 0) {
        pending.push({
          candidateCitationNumbers,
          check,
          kind: "independent-support",
          purpose,
        });
        continue;
      }
    } else {
      if (uncertainNumbers.length > 0) {
        continue;
      }
      candidateCitationNumbers = [...check.citationNumbers];
      purpose = "collective-support";
    }
    if (candidateCitationNumbers.length === 1) {
      const candidateCitationNumber = candidateCitationNumbers[0];
      if (candidateCitationNumber === undefined) {
        throw new ClaimVerificationDataError(
          `Claim ${check.claimIndex} has an empty single-citation set.`,
        );
      }
      pending.push({
        candidateCitationNumbers: [candidateCitationNumber],
        check,
        kind: "single",
        purpose,
      });
      continue;
    }
    const item = buildCitationSetScoreItem(
      check,
      candidateCitationNumbers,
      sourceByNumber,
    );
    pending.push({
      candidateCitationNumbers,
      check,
      kind: "model",
      item,
      limitFailure: readHhemScoreItemLimitFailure(item),
      purpose,
    });
  }
  return pending;
}

function readCitationNumbersByOutcome(
  check: ClaimVerificationResult,
  outcome: ClaimVerificationResult["evidenceUnits"][number]["outcome"],
): number[] {
  const citationNumbers: number[] = [];
  for (const unit of check.evidenceUnits) {
    if (unit.outcome === outcome) {
      citationNumbers.push(unit.citationNumber);
    }
  }
  return citationNumbers;
}

function readUncertainCitationNumbers(
  check: ClaimVerificationResult,
): number[] {
  const citationNumbers: number[] = [];
  for (const unit of check.evidenceUnits) {
    if (
      unit.outcome === "not-evaluated"
      || unit.outcome === "verifier-incompatible"
    ) {
      citationNumbers.push(unit.citationNumber);
    }
  }
  return citationNumbers;
}

function buildCitationSetScoreItem(
  check: ClaimVerificationResult,
  citationNumbers: readonly number[],
  sourceByNumber: ReadonlyMap<number, ClaimEvidenceSource>,
): HhemScoreItem {
  const evidenceParts: string[] = [];
  for (const citationNumber of citationNumbers) {
    const source = sourceByNumber.get(citationNumber);
    if (source === undefined) {
      throw new ClaimVerificationDataError(
        `Claim ${check.claimIndex} references unavailable citation ${citationNumber}.`,
      );
    }
    const evidence = buildTextEvidenceUnit(source);
    if (evidence === null) {
      throw new ClaimVerificationDataError(
        `Claim ${check.claimIndex} has verifier-incompatible citation ${citationNumber} in a citation-set verification.`,
      );
    }
    evidenceParts.push(evidence);
  }
  return {
    claim: check.claim,
    evidence: evidenceParts.join("\n\n"),
    id: `claim-${check.claimIndex}-citation-set`,
  };
}

async function scorePendingCitationSets(
  pending: readonly PendingCitationSetVerification[],
  score: (
    items: readonly HhemScoreItem[],
    abortSignal: AbortSignal,
  ) => Promise<HhemScoreResult[]>,
  scheduler: TaskScheduler,
  abortSignal: AbortSignal,
  timingObserver: Parameters<TaskScheduler["run"]>[2],
): Promise<HhemScoreResult[]> {
  const items: HhemScoreItem[] = [];
  for (const item of pending) {
    if (item.kind === "model" && item.limitFailure === null) {
      items.push(item.item);
    }
  }
  if (items.length === 0) {
    return [];
  }
  return scheduler.run(
    (requestSignal) => score(items, requestSignal),
    abortSignal,
    timingObserver,
  );
}

function buildClaimVerificationResults(
  preparedClaims: readonly PreparedClaimVerification[],
  scores: readonly HhemScoreResult[],
  verifierModel: string,
  supportThreshold: number,
): ClaimVerificationResult[] {
  const scoreById = new Map<string, HhemScoreResult>();
  for (const score of scores) {
    scoreById.set(score.id, score);
  }
  const unitsByClaimIndex = new Map<number, ClaimVerificationResult["evidenceUnits"]>();
  for (const prepared of preparedClaims) {
    const units = unitsByClaimIndex.get(prepared.claim.claimIndex) ?? [];
    if (prepared.kind === "direct") {
      if (prepared.citationNumber !== null) {
        units.push({
          citationNumber: prepared.citationNumber,
          outcome: prepared.outcome,
          rationale: prepared.rationale,
          supportProbability: null,
          unitId: buildClaimItemId(
            prepared.claim.claimIndex,
            prepared.citationNumber,
          ),
        });
      }
      unitsByClaimIndex.set(prepared.claim.claimIndex, units);
      continue;
    }
    const score = scoreById.get(prepared.item.id);
    if (score === undefined) {
      throw new ClaimVerificationDataError(
        `HHEM omitted score for claim ${prepared.claim.claimIndex}.`,
      );
    }
    if (score.outcome === "model-context-capacity") {
      units.push({
        citationNumber: prepared.citationNumber,
        outcome: "not-evaluated",
        rationale: "The evidence unit exceeds the HHEM model context capacity.",
        supportProbability: null,
        unitId: prepared.item.id,
      });
      unitsByClaimIndex.set(prepared.claim.claimIndex, units);
      continue;
    }
    const supportProbability = score.supportProbability;
    const supported = supportProbability >= supportThreshold;
    units.push({
      citationNumber: prepared.citationNumber,
      outcome: supported ? "supported" : "unsupported",
      rationale: buildScoreRationale(
        supportProbability,
        supportThreshold,
        supported,
      ),
      supportProbability,
      unitId: prepared.item.id,
    });
    unitsByClaimIndex.set(prepared.claim.claimIndex, units);
  }
  const results: ClaimVerificationResult[] = [];
  for (const claim of readUniqueClaims(preparedClaims)) {
    const evidenceUnits = unitsByClaimIndex.get(claim.claimIndex) ?? [];
    const supportedCount = evidenceUnits.filter((unit) => unit.outcome === "supported").length;
    const unsupportedCount = evidenceUnits.filter((unit) => unit.outcome === "unsupported").length;
    let status: ClaimVerificationResult["status"] = "unverified";
    if (supportedCount > 0 && unsupportedCount === 0) {
      status = "supported";
    } else if (supportedCount > 0) {
      status = "partially-supported";
    } else if (unsupportedCount > 0) {
      status = "unsupported";
    }
    results.push({
      ...claim,
      evidenceUnits,
      rationale: buildClaimRationale(evidenceUnits, status),
      status,
      verifierModel,
    });
  }
  return results;
}

function resolveClaimPublicationDecisions(
  checks: readonly ClaimVerificationResult[],
  pendingSets: readonly PendingCitationSetVerification[],
  setScores: readonly HhemScoreResult[],
  supportThreshold: number,
): ClaimPublicationDecision[] {
  const pendingByClaimIndex = new Map<number, PendingCitationSetVerification>();
  for (const pending of pendingSets) {
    pendingByClaimIndex.set(pending.check.claimIndex, pending);
  }
  const scoreById = new Map<string, HhemScoreResult>();
  for (const score of setScores) {
    scoreById.set(score.id, score);
  }
  const decisions: ClaimPublicationDecision[] = [];
  for (const check of checks) {
    const pending = pendingByClaimIndex.get(check.claimIndex);
    if (pending === undefined) {
      decisions.push(resolveClaimWithoutCitationSet(check));
      continue;
    }
    const resolved = resolveCitationSetVerification(
      pending,
      scoreById,
      supportThreshold,
    );
    decisions.push({
      check: resolved.check,
      citationNumbers: resolved.citationNumbers,
      publish: resolved.publish,
    });
  }
  return decisions;
}

function resolveClaimWithoutCitationSet(
  check: ClaimVerificationResult,
): ClaimPublicationDecision {
  const unsupportedNumbers = readCitationNumbersByOutcome(check, "unsupported");
  const uncertainNumbers = readUncertainCitationNumbers(check);
  if (unsupportedNumbers.length > 0 && uncertainNumbers.length > 0) {
    return {
      check: {
        ...check,
        rationale: buildClaimRationale(check.evidenceUnits, "unverified"),
        status: "unverified",
      },
      citationNumbers: [...check.citationNumbers],
      publish: true,
    };
  }
  return {
    check,
    citationNumbers: [...check.citationNumbers],
    publish: true,
  };
}

function resolveCitationSetVerification(
  pending: PendingCitationSetVerification,
  scoreById: ReadonlyMap<string, HhemScoreResult>,
  supportThreshold: number,
): ResolvedCitationSetVerification {
  if (pending.kind === "independent-support") {
    return resolveIndependentSupportPrune(pending);
  }
  if (pending.kind === "single") {
    return resolveSingleCitationSet(pending);
  }
  if (pending.limitFailure !== null) {
    return preserveUnverifiedCitationSet(pending, pending.limitFailure);
  }
  const score = scoreById.get(pending.item.id);
  if (score === undefined) {
    throw new ClaimVerificationDataError(
      `HHEM omitted citation-set score for claim ${pending.check.claimIndex}.`,
    );
  }
  if (score.outcome === "model-context-capacity") {
    return preserveUnverifiedCitationSet(
      pending,
      "The complete citation set exceeds the HHEM model context capacity.",
    );
  }
  const supported = score.supportProbability >= supportThreshold;
  if (pending.purpose === "collective-support") {
    if (!supported) {
      return {
        check: pending.check,
        citationNumbers: [],
        publish: false,
      };
    }
    return {
      check: {
        ...pending.check,
        rationale: buildCitationSetScoreRationale(
          score.supportProbability,
          supportThreshold,
        ),
        status: "supported",
      },
      citationNumbers: [...pending.candidateCitationNumbers],
      publish: true,
    };
  }
  if (!supported) {
    return {
      check: pending.check,
      citationNumbers: [...pending.check.citationNumbers],
      publish: true,
    };
  }
  const evidenceUnits = pending.check.evidenceUnits.filter((unit) => {
    return pending.candidateCitationNumbers.includes(unit.citationNumber);
  });
  return {
    check: {
      ...pending.check,
      citationNumbers: [...pending.candidateCitationNumbers],
      evidenceUnits,
      rationale: buildCitationSetScoreRationale(
        score.supportProbability,
        supportThreshold,
      ),
      status: "supported",
    },
    citationNumbers: [...pending.candidateCitationNumbers],
    publish: true,
  };
}

function resolveIndependentSupportPrune(
  pending: Extract<
    PendingCitationSetVerification,
    { kind: "independent-support" }
  >,
): ResolvedCitationSetVerification {
  const evidenceUnits = pending.check.evidenceUnits.filter((unit) => {
    return pending.candidateCitationNumbers.includes(unit.citationNumber);
  });
  let hasSupportedEvidence = false;
  for (const unit of evidenceUnits) {
    if (unit.outcome === "supported") {
      hasSupportedEvidence = true;
    }
  }
  if (!hasSupportedEvidence) {
    throw new ClaimVerificationDataError(
      `Claim ${pending.check.claimIndex} has no independent support after pruning.`,
    );
  }
  return {
    check: {
      ...pending.check,
      citationNumbers: [...pending.candidateCitationNumbers],
      evidenceUnits,
      rationale: buildClaimRationale(evidenceUnits, "supported"),
      status: "supported",
    },
    citationNumbers: [...pending.candidateCitationNumbers],
    publish: true,
  };
}

function resolveSingleCitationSet(
  pending: Extract<PendingCitationSetVerification, { kind: "single" }>,
): ResolvedCitationSetVerification {
  const citationNumber = pending.candidateCitationNumbers[0];
  const unit = pending.check.evidenceUnits.find((candidate) => {
    return candidate.citationNumber === citationNumber;
  });
  if (unit === undefined) {
    throw new ClaimVerificationDataError(
      `Claim ${pending.check.claimIndex} has no evidence unit for citation ${citationNumber}.`,
    );
  }
  if (pending.purpose === "collective-support") {
    return {
      check: pending.check,
      citationNumbers: [],
      publish: false,
    };
  }
  if (unit.outcome !== "supported") {
    throw new ClaimVerificationDataError(
      `Claim ${pending.check.claimIndex} cannot prune to unsupported citation ${citationNumber}.`,
    );
  }
  return {
    check: {
      ...pending.check,
      citationNumbers: [citationNumber],
      evidenceUnits: [unit],
      rationale: unit.rationale,
      status: "supported",
    },
    citationNumbers: [citationNumber],
    publish: true,
  };
}

function preserveUnverifiedCitationSet(
  pending: PendingCitationSetVerification,
  rationale: string,
): ResolvedCitationSetVerification {
  return {
    check: {
      ...pending.check,
      rationale,
      status: "unverified",
    },
    citationNumbers: [...pending.check.citationNumbers],
    publish: true,
  };
}

function buildCitationSetScoreRationale(
  supportProbability: number,
  supportThreshold: number,
): string {
  const score = supportProbability.toFixed(3);
  const threshold = supportThreshold.toFixed(3);
  return `HHEM support probability ${score} for the complete citation set meets the configured ${threshold} threshold.`;
}

function applyConflictGroupPublicationDecisions(
  statements: readonly PublishedAnswerStatement[],
  decisions: ClaimPublicationDecision[],
): void {
  const groups = readConflictStatementGroups(statements);
  for (const group of groups) {
    let omitGroup = false;
    for (const statementIndex of group) {
      const decision = decisions[statementIndex];
      if (decision === undefined) {
        throw new ClaimVerificationDataError(
          `Missing publication decision for conflict statement ${statementIndex}.`,
        );
      }
      if (!decision.publish) {
        omitGroup = true;
      }
    }
    if (!omitGroup) {
      continue;
    }
    for (const statementIndex of group) {
      const decision = decisions[statementIndex];
      if (decision !== undefined) {
        decision.publish = false;
        decision.citationNumbers = [];
      }
    }
  }
}

function readConflictStatementGroups(
  statements: readonly PublishedAnswerStatement[],
): number[][] {
  const groups: number[][] = [];
  let statementIndex = 0;
  while (statementIndex < statements.length) {
    const statement = statements[statementIndex];
    if (statement === undefined) {
      throw new ClaimVerificationDataError(
        `Missing published statement at index ${statementIndex}.`,
      );
    }
    if (statement.section !== "conflicting-evidence") {
      statementIndex += 1;
      continue;
    }
    const group: number[] = [];
    if (statement.presentation !== "paragraph") {
      throw new ClaimVerificationDataError(
        `Conflict group at statement ${statementIndex} has no scope paragraph.`,
      );
    }
    group.push(statementIndex);
    statementIndex += 1;
    let positionCount = 0;
    while (statementIndex < statements.length) {
      const position = statements[statementIndex];
      if (
        position === undefined
        || position.section !== "conflicting-evidence"
        || position.presentation !== "bullet"
      ) {
        break;
      }
      group.push(statementIndex);
      positionCount += 1;
      statementIndex += 1;
    }
    if (positionCount < 2) {
      throw new ClaimVerificationDataError(
        "A published conflict group must contain at least two positions.",
      );
    }
    const explanation = statements[statementIndex];
    if (
      explanation === undefined
      || explanation.section !== "conflicting-evidence"
      || explanation.presentation !== "paragraph"
    ) {
      throw new ClaimVerificationDataError(
        "A published conflict group must end with an explanation paragraph.",
      );
    }
    group.push(statementIndex);
    statementIndex += 1;
    groups.push(group);
  }
  return groups;
}

function buildVerifiedPublishedAnswer(
  answerDocument: Extract<PublishedAnswerDocument, { status: "answered" }>,
  decisions: readonly ClaimPublicationDecision[],
): VerifiedPublishedAnswer {
  const originalCitationByNumber = new Map<number, PublishedAnswerCitation>();
  for (const citation of answerDocument.citations) {
    originalCitationByNumber.set(citation.citationNumber, citation);
  }
  const keptStatements: PublishedAnswerStatement[] = [];
  const keptDecisions: ClaimPublicationDecision[] = [];
  const referencedCitationIds = new Set<string>();
  for (let index = 0; index < answerDocument.statements.length; index += 1) {
    const statement = answerDocument.statements[index];
    const decision = decisions[index];
    if (statement === undefined || decision === undefined) {
      throw new ClaimVerificationDataError(
        `Missing publication state for statement ${index}.`,
      );
    }
    if (!decision.publish) {
      continue;
    }
    const citationIds: string[] = [];
    for (const citationNumber of decision.citationNumbers) {
      const citation = originalCitationByNumber.get(citationNumber);
      if (citation === undefined) {
        throw new ClaimVerificationDataError(
          `Statement ${index} references unavailable citation ${citationNumber}.`,
        );
      }
      citationIds.push(citation.id);
      referencedCitationIds.add(citation.id);
    }
    if (citationIds.length === 0) {
      throw new ClaimVerificationDataError(
        `Statement ${index} has no citation after verification.`,
      );
    }
    keptStatements.push({ ...statement, citationIds });
    keptDecisions.push(decision);
  }
  if (keptStatements.length === 0) {
    return {
      answerDocument: createNoAnswerDocument(),
      claims: [],
    };
  }
  const citations: PublishedAnswerCitation[] = [];
  for (const citation of answerDocument.citations) {
    if (!referencedCitationIds.has(citation.id)) {
      continue;
    }
    citations.push({
      ...citation,
      citationNumber: citations.length + 1,
    });
  }
  const verifiedDocument = decodePublishedAnswerDocument({
    citations,
    schemaVersion: 1,
    statements: keptStatements,
    status: "answered",
  });
  if (verifiedDocument.status !== "answered") {
    throw new ClaimVerificationDataError(
      "Verified statements compiled into a no-answer document.",
    );
  }
  const claims = buildFinalClaimChecks(
    answerDocument.citations,
    verifiedDocument,
    keptDecisions,
  );
  return {
    answerDocument: verifiedDocument,
    claims,
  };
}

function buildFinalClaimChecks(
  originalCitations: readonly PublishedAnswerCitation[],
  answerDocument: Extract<PublishedAnswerDocument, { status: "answered" }>,
  decisions: readonly ClaimPublicationDecision[],
): ClaimVerificationResult[] {
  const originalNumberById = new Map<string, number>();
  for (const citation of originalCitations) {
    originalNumberById.set(citation.id, citation.citationNumber);
  }
  const finalCitationByNumber = new Map<number, PublishedAnswerCitation>();
  for (const citation of answerDocument.citations) {
    finalCitationByNumber.set(citation.citationNumber, citation);
  }
  const finalClaims = readPublishedAnswerClaims(answerDocument);
  const checks: ClaimVerificationResult[] = [];
  for (let index = 0; index < finalClaims.length; index += 1) {
    const claim = finalClaims[index];
    const decision = decisions[index];
    if (claim === undefined || decision === undefined) {
      throw new ClaimVerificationDataError(
        `Missing final claim state at index ${index}.`,
      );
    }
    const unitByOriginalNumber = new Map(
      decision.check.evidenceUnits.map((unit) => [unit.citationNumber, unit]),
    );
    const evidenceUnits: ClaimVerificationResult["evidenceUnits"] = [];
    for (const citationNumber of claim.citationNumbers) {
      const citation = finalCitationByNumber.get(citationNumber);
      const originalNumber = citation === undefined
        ? undefined
        : originalNumberById.get(citation.id);
      const unit = originalNumber === undefined
        ? undefined
        : unitByOriginalNumber.get(originalNumber);
      if (unit === undefined) {
        throw new ClaimVerificationDataError(
          `Final claim ${index} has no verification unit for citation ${citationNumber}.`,
        );
      }
      evidenceUnits.push({
        ...unit,
        citationNumber,
        unitId: buildClaimItemId(index, citationNumber),
      });
    }
    checks.push({
      ...decision.check,
      citationNumbers: [...claim.citationNumbers],
      claim: claim.claim,
      claimIndex: claim.claimIndex,
      evidenceUnits,
    });
  }
  return checks;
}

function readUniqueClaims(
  preparedClaims: readonly PreparedClaimVerification[],
): AnswerClaim[] {
  const claims = new Map<number, AnswerClaim>();
  for (const prepared of preparedClaims) {
    claims.set(prepared.claim.claimIndex, prepared.claim);
  }
  return [...claims.values()];
}

function buildClaimRationale(
  evidenceUnits: readonly ClaimVerificationResult["evidenceUnits"][number][],
  status: ClaimVerificationResult["status"],
): string {
  if (evidenceUnits.length === 0) {
    return "The claim has no citation to verify.";
  }
  if (evidenceUnits.length === 1) {
    return evidenceUnits[0]?.rationale ?? "The verification unit is unavailable.";
  }
  const supported = evidenceUnits.filter((unit) => unit.outcome === "supported").length;
  const unsupported = evidenceUnits.filter((unit) => unit.outcome === "unsupported").length;
  const incompatible = evidenceUnits.filter((unit) => unit.outcome === "verifier-incompatible").length;
  const notEvaluated = evidenceUnits.filter((unit) => unit.outcome === "not-evaluated").length;
  return `${status}: ${supported} supported, ${unsupported} unsupported, ${incompatible} verifier-incompatible, and ${notEvaluated} not evaluated evidence units.`;
}

function buildScoreRationale(
  supportProbability: number,
  supportThreshold: number,
  supported: boolean,
): string {
  const score = supportProbability.toFixed(3);
  const threshold = supportThreshold.toFixed(3);
  if (supported) {
    return `HHEM support probability ${score} meets the configured ${threshold} threshold.`;
  }
  return `HHEM support probability ${score} is below the configured ${threshold} threshold.`;
}

function buildClaimItemId(claimIndex: number, citationNumber: number): string {
  return `claim-${claimIndex}-citation-${citationNumber}`;
}

function readClaimVerificationFailure(
  error: unknown,
  abortSignal: AbortSignal,
): ClaimVerificationFailure {
  if (abortSignal.aborted) {
    return {
      category: "aborted",
      retryable: false,
      statusCode: null,
    };
  }
  if (error instanceof ClaimVerificationDataError) {
    return {
      category: "invalid-evidence",
      retryable: false,
      statusCode: null,
    };
  }
  if (error instanceof HhemClientError) {
    return {
      category: error.category,
      retryable: error.retryable,
      statusCode: error.statusCode,
    };
  }
  return {
    category: "unexpected",
    retryable: false,
    statusCode: null,
  };
}

function reportClaimVerificationFailure(
  failure: ClaimVerificationFailure,
): void {
  console.error(JSON.stringify({
    error: failure,
    level: "error",
    operation: "claim-verification",
  }));
}
