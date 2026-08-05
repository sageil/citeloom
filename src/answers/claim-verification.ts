import { readClaimsFromAnswerMarkup } from "./claims.js";
import { parseAnswerMarkup } from "./markup.js";
import {
  isPublishedUncitedAnswerDocument,
  readPublishedAnswerClaims,
  type PublishedAnswerDocument,
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

interface PendingCollectiveCitationSetVerification {
  candidateCitationNumbers: number[];
  check: ClaimVerificationResult;
  item: HhemScoreItem;
  limitFailure: string | null;
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

export function createPendingAnswerClaimChecks(
  models: InferenceModelRegistry,
  claims: readonly AnswerClaim[],
  sources: readonly ClaimEvidenceSource[],
): ClaimVerificationResult[] {
  if (claims.length === 0) {
    return [];
  }
  const preparedClaims = prepareClaimVerifications(claims, sources);
  const verifierModel = models.claimVerifier.modelId;
  const unitsByClaimIndex = new Map<
    number,
    ClaimVerificationResult["evidenceUnits"]
  >();
  for (const prepared of preparedClaims) {
    const claimIndex = prepared.claim.claimIndex;
    const units = unitsByClaimIndex.get(claimIndex) ?? [];
    if (prepared.citationNumber !== null) {
      const outcome = prepared.kind === "direct"
        ? prepared.outcome
        : "not-evaluated";
      const rationale = prepared.kind === "direct"
        ? prepared.rationale
        : "Automated evidence verification is pending.";
      units.push({
        citationNumber: prepared.citationNumber,
        outcome,
        rationale,
        supportProbability: null,
        unitId: buildClaimItemId(claimIndex, prepared.citationNumber),
      });
    }
    unitsByClaimIndex.set(claimIndex, units);
  }
  const pending: ClaimVerificationResult[] = [];
  for (const claim of readUniqueClaims(preparedClaims)) {
    const evidenceUnits = unitsByClaimIndex.get(claim.claimIndex) ?? [];
    pending.push({
      ...claim,
      evidenceUnits,
      rationale: evidenceUnits.length === 0
        ? "The claim has no citation to verify."
        : "Automated evidence verification is pending.",
      status: "unverified",
      verifierModel,
    });
  }
  return pending;
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
  const claims = readPublishedAnswerClaims(answerDocument);
  return verifyPublishedAnswerClaims(
    models,
    answerDocument,
    claims,
    scheduler,
    abortSignal,
    runTelemetry,
  );
}

export async function verifyPublishedAnswerClaims(
  models: InferenceModelRegistry,
  answerDocument: PublishedAnswerDocument,
  claims: readonly AnswerClaim[],
  scheduler: TaskScheduler,
  abortSignal: AbortSignal,
  runTelemetry: RunTelemetry = noopRunTelemetry,
): Promise<VerifiedPublishedAnswer> {
  if (isPublishedUncitedAnswerDocument(answerDocument)) {
    return { answerDocument, claims: [] };
  }
  if (claims.length === 0) {
    return { answerDocument, claims: [] };
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
    const pendingSets = prepareRetainedCollectiveCitationSetVerifications(
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
    const checks = resolveRetainedCollectiveSupport(
      initialChecks,
      pendingSets,
      setScores,
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
    return {
      answerDocument,
      claims: checks,
    };
  } catch (error: unknown) {
    const failure = readClaimVerificationFailure(error, abortSignal);
    finishMetric({
      finishReason: failure.category,
      inputTokens: null,
      outputTokens: null,
    });
    const advisoryFailure = isAdvisoryVerifierFailure(failure);
    const stageOutcome = advisoryFailure
      ? "fallback"
      : readTelemetryFailureOutcome(abortSignal);
    await stage.finish(createTelemetryStageResult(stageOutcome, {
      inputCount: claims.length,
      outputCount: advisoryFailure ? claims.length : 0,
    }));
    reportClaimVerificationFailure(failure);
    if (advisoryFailure) {
      return {
        answerDocument,
        claims: createUnavailableAnswerClaimChecks(
          models,
          claims,
          answerDocument.citations,
          failure.category,
        ),
      };
    }
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
    const pendingSets = prepareRetainedCollectiveCitationSetVerifications(
      checks,
      sources,
    );
    const setScores = await scorePendingCitationSets(
      pendingSets,
      verifier.score.bind(verifier),
      scheduler,
      abortSignal,
      stage.timingObserver,
    );
    const retainedChecks = resolveRetainedCollectiveSupport(
      checks,
      pendingSets,
      setScores,
      verifier.supportThreshold,
    );
    finishMetric({
      finishReason: "stop",
      inputTokens: null,
      outputTokens: null,
    });
    await stage.finish(createTelemetryStageResult("success", {
      inputCount: claims.length,
      outputCount: retainedChecks.length,
    }));
    return retainedChecks;
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
  return scoreUniqueHhemItems(
    items,
    score,
    scheduler,
    abortSignal,
    timingObserver,
  );
}

function prepareRetainedCollectiveCitationSetVerifications(
  checks: readonly ClaimVerificationResult[],
  sources: readonly ClaimEvidenceSource[],
): PendingCollectiveCitationSetVerification[] {
  const sourceByNumber = new Map<number, ClaimEvidenceSource>();
  for (const source of sources) {
    sourceByNumber.set(source.citationNumber, source);
  }
  const pending: PendingCollectiveCitationSetVerification[] = [];
  for (const check of checks) {
    if (check.citationNumbers.length < 2) {
      continue;
    }
    const unsupportedNumbers = readCitationNumbersByOutcome(
      check,
      "unsupported",
    );
    if (unsupportedNumbers.length !== check.citationNumbers.length) {
      continue;
    }
    const candidateCitationNumbers = [...check.citationNumbers]
      .sort((left, right) => left - right);
    const item = buildCitationSetScoreItem(
      check,
      candidateCitationNumbers,
      sourceByNumber,
    );
    pending.push({
      candidateCitationNumbers,
      check,
      item,
      limitFailure: readHhemScoreItemLimitFailure(item),
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
  pending: readonly PendingCollectiveCitationSetVerification[],
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
    if (item.limitFailure === null) {
      items.push(item.item);
    }
  }
  if (items.length === 0) {
    return [];
  }
  return scoreUniqueHhemItems(
    items,
    score,
    scheduler,
    abortSignal,
    timingObserver,
  );
}

interface HhemScoreItemGroup {
  item: HhemScoreItem;
  resultIds: string[];
}

async function scoreUniqueHhemItems(
  items: readonly HhemScoreItem[],
  score: (
    items: readonly HhemScoreItem[],
    abortSignal: AbortSignal,
  ) => Promise<HhemScoreResult[]>,
  scheduler: TaskScheduler,
  abortSignal: AbortSignal,
  timingObserver: Parameters<TaskScheduler["run"]>[2],
): Promise<HhemScoreResult[]> {
  const groupsByContent = new Map<string, HhemScoreItemGroup>();
  const groups: HhemScoreItemGroup[] = [];
  for (const item of items) {
    const contentKey = JSON.stringify([item.claim, item.evidence]);
    const existing = groupsByContent.get(contentKey);
    if (existing !== undefined) {
      existing.resultIds.push(item.id);
      continue;
    }
    const group: HhemScoreItemGroup = {
      item,
      resultIds: [item.id],
    };
    groupsByContent.set(contentKey, group);
    groups.push(group);
  }
  const uniqueItems: HhemScoreItem[] = [];
  for (const group of groups) {
    uniqueItems.push(group.item);
  }
  const uniqueResults = await scheduler.run(
    (requestSignal) => score(uniqueItems, requestSignal),
    abortSignal,
    timingObserver,
  );
  const uniqueResultById = new Map<string, HhemScoreResult>();
  for (const result of uniqueResults) {
    uniqueResultById.set(result.id, result);
  }
  const results: HhemScoreResult[] = [];
  for (const group of groups) {
    const result = uniqueResultById.get(group.item.id);
    if (result === undefined) {
      continue;
    }
    for (const resultId of group.resultIds) {
      if (result.outcome === "scored") {
        results.push({
          id: resultId,
          outcome: "scored",
          supportProbability: result.supportProbability,
        });
        continue;
      }
      results.push({ id: resultId, outcome: "model-context-capacity" });
    }
  }
  return results;
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

function resolveRetainedCollectiveSupport(
  checks: readonly ClaimVerificationResult[],
  pendingSets: readonly PendingCollectiveCitationSetVerification[],
  setScores: readonly HhemScoreResult[],
  supportThreshold: number,
): ClaimVerificationResult[] {
  const pendingByClaimIndex = new Map<
    number,
    PendingCollectiveCitationSetVerification
  >();
  for (const pending of pendingSets) {
    pendingByClaimIndex.set(pending.check.claimIndex, pending);
  }
  const scoreById = new Map<string, HhemScoreResult>();
  for (const score of setScores) {
    scoreById.set(score.id, score);
  }
  const resolved: ClaimVerificationResult[] = [];
  for (const check of checks) {
    const pending = pendingByClaimIndex.get(check.claimIndex);
    if (pending === undefined || pending.limitFailure !== null) {
      resolved.push(check);
      continue;
    }
    const score = scoreById.get(pending.item.id);
    if (score === undefined) {
      throw new ClaimVerificationDataError(
        `HHEM omitted citation-set score for claim ${check.claimIndex}.`,
      );
    }
    if (
      score.outcome === "model-context-capacity"
      || score.supportProbability < supportThreshold
    ) {
      resolved.push(check);
      continue;
    }
    resolved.push({
      ...check,
      rationale: buildCitationSetScoreRationale(
        score.supportProbability,
        supportThreshold,
      ),
      status: "supported",
    });
  }
  return resolved;
}

function buildCitationSetScoreRationale(
  supportProbability: number,
  supportThreshold: number,
): string {
  const score = supportProbability.toFixed(3);
  const threshold = supportThreshold.toFixed(3);
  return `HHEM support probability ${score} for the complete citation set meets the configured ${threshold} threshold.`;
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

function isAdvisoryVerifierFailure(
  failure: ClaimVerificationFailure,
): boolean {
  return failure.category === "http-error"
    || failure.category === "invalid-response"
    || failure.category === "service-unavailable"
    || failure.category === "timeout";
}

function createUnavailableAnswerClaimChecks(
  models: InferenceModelRegistry,
  claims: readonly AnswerClaim[],
  sources: readonly ClaimEvidenceSource[],
  category: ClaimVerificationFailureCategory,
): ClaimVerificationResult[] {
  const pendingChecks = createPendingAnswerClaimChecks(models, claims, sources);
  const rationale = readUnavailableVerifierRationale(category);
  const unavailableChecks: ClaimVerificationResult[] = [];
  for (const check of pendingChecks) {
    const evidenceUnits: ClaimVerificationResult["evidenceUnits"] = [];
    for (const unit of check.evidenceUnits) {
      if (unit.outcome !== "not-evaluated") {
        evidenceUnits.push(unit);
        continue;
      }
      evidenceUnits.push({
        ...unit,
        rationale,
      });
    }
    unavailableChecks.push({
      ...check,
      evidenceUnits,
      rationale,
      status: "unverified",
    });
  }
  return unavailableChecks;
}

function readUnavailableVerifierRationale(
  category: ClaimVerificationFailureCategory,
): string {
  switch (category) {
    case "timeout":
      return "HHEM verification timed out. The cited answer was retained because verification is advisory.";
    case "service-unavailable":
      return "HHEM verification was unavailable. The cited answer was retained because verification is advisory.";
    case "invalid-response":
      return "HHEM returned an invalid response. The cited answer was retained because verification is advisory.";
    case "http-error":
      return "HHEM verification returned an HTTP error. The cited answer was retained because verification is advisory.";
    case "aborted":
    case "invalid-evidence":
    case "unexpected":
      throw new ClaimVerificationDataError(
        `Failure category ${category} cannot be converted to an advisory result.`,
      );
  }
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
