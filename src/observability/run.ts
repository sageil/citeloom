import { randomUUID } from "node:crypto";

import type {
  TaskTimingObserver,
} from "../shared/concurrency.js";
import type { AppConfig, RetrievalMode } from "../config/index.js";
import type {
  CandidateAllocationPolicy,
  PreRerankCandidateExclusionReason,
} from "../retrieval/document-retrieval.js";
import type {
  ChannelOrderingPolicy,
} from "../retrieval/ranking/channel-ordering.js";
import type {
  RetrievalWindowPolicyContract,
} from "../retrieval/window-policy.js";
import type {
  RepresentationHit,
} from "../retrieval/ranking/rank-fusion.js";
import type {
  RetrievalRepresentationType,
} from "../retrieval/representations.js";
import type { TelemetryStageName } from "./stage.js";

export type { TelemetryStageName } from "./stage.js";

export type TelemetryRunKind =
  | "answer"
  | "benchmark"
  | "retrieval"
  | "search";

export type TelemetryRunOutcome = "abort" | "error" | "success";

export type TelemetryStageOutcome =
  | "abort"
  | "error"
  | "fallback"
  | "success";

export interface RerankerRankingTelemetry {
  modelId: string;
  outcome: "not-assessed";
  reason: "ranking-only";
  strongestScore: number;
  threshold: null;
}

export interface ContextSelectionCandidateTelemetry {
  documentId: string;
  documentVersionId: string;
  finalContextRank: number | null;
  fusedRank: number;
  fusion: {
    bm25Score: number | null;
    denseDistance: number | null;
    fusedScore: number;
  };
  parentElementId: string;
  rerankerInputRank: number;
  reason:
    | "duplicate-source-element"
    | "maximum-context"
    | "maximum-context-limit"
    | "relevance-cliff-tail"
    | "relevance-cliff";
  rerankerRank: number;
  rerankerScore: number;
  representationHits: RepresentationHit[];
  retrievalWindowId: string;
  selected: boolean;
  sourceFile: string;
  descriptionAffected: boolean;
  evidenceSha256: string;
}

export interface CandidateBudgetAdmissionTelemetry {
  admissionRank: number;
  documentId: string;
  fusedRank: number;
  highestFusedRankForParent: number;
  hydrated: boolean;
  isParentRepresentative: boolean;
  parentElementId: string;
  representationHits: RepresentationHit[];
  rerankerInputRank: number | null;
  retrievalWindowId: string;
  sourceFile: string;
  descriptionAffected: boolean;
}

export interface CandidateBudgetDecisionTelemetry {
  admissionRank: number | null;
  documentId: string;
  exclusionReason: PreRerankCandidateExclusionReason | null;
  fusedRank: number;
  fusion: {
    bm25Score: number | null;
    denseDistance: number | null;
    fusedScore: number;
  };
  parentElementId: string;
  representationHits: RepresentationHit[];
  representativeRetrievalWindowId: string;
  retrievalWindowId: string;
  sourceFile: string;
  descriptionAffected: boolean;
}

export interface ChannelCandidateTelemetry {
  channelRank: number;
  documentId: string;
  fusionInputPosition: number;
  limitDecision: "admitted";
  parentElementId: string;
  representationId: string;
  representationType: RetrievalRepresentationType;
  retrievalWindowId: string;
  score: number;
  sourceFile: string;
}

export interface CandidateBudgetChannelTelemetry {
  candidateLimit: number;
  candidates: ChannelCandidateTelemetry[];
  channel: "dense" | "lexical";
  orderingPolicy: ChannelOrderingPolicy;
  scoreDirection: "ascending" | "descending";
  scoreKind: "bm25-relevance" | "cosine-distance";
}

export interface CandidateBudgetQueryTelemetry {
  channels: CandidateBudgetChannelTelemetry[];
  denseDistinctParentCount: number;
  denseWindowCount: number;
  embeddingSha256: string | null;
  lexicalDistinctParentCount: number;
  lexicalWindowCount: number;
  queryFingerprintSha256: string;
  queryIndex: number;
  queryKind: "expansion" | "original";
}

export interface CandidateBudgetTelemetry {
  allocationPolicy: CandidateAllocationPolicy;
  admittedCandidates: CandidateBudgetAdmissionTelemetry[];
  admittedDistinctParentCount: number;
  admittedWindowCount: number;
  candidateK: number;
  fusedCandidates: CandidateBudgetDecisionTelemetry[];
  fusedDistinctParentCount: number;
  fusedWindowCount: number;
  hydratedDistinctParentCount: number;
  hydratedWindowCount: number;
  queries: CandidateBudgetQueryTelemetry[];
  retrievalWindowPolicy: RetrievalWindowPolicyContract;
}

export interface ContextSelectionTelemetry {
  candidateBudget: CandidateBudgetTelemetry;
  candidates: ContextSelectionCandidateTelemetry[];
  configuration: {
    maximumContextSize: number;
    minimumLogGapMedianMultiplier: number;
    minimumScoreRatio: number;
  };
  cutoff: {
    rank: number;
    reason: "maximum-context" | "relevance-cliff";
  };
  policy: "relative-relevance-cliff-v2";
  recovery: { attempted: false; result: "not-applicable" };
}

export interface AnswerBudgetTelemetry {
  availableInputTokens: number | null;
  contextCapacityTokens: number | null;
  failureReason:
    | "minimum-structured-output"
    | "model-capabilities-unavailable"
    | "no-complete-evidence-window"
    | null;
  inputTokenUpperBound: number | null;
  outputBudgetTokens: number | null;
  providerSafetyMarginTokens: number;
  requests: AnswerGenerationRequestTelemetry[];
  windows: Array<{
    evidenceSha256: string;
    elementId: string;
    reason: "capacity" | "included";
    retrievalRank: number;
    retrievalWindowId: string;
    tokenUpperBound: number;
  }>;
}

export interface AnswerGenerationRequestTelemetry {
  evidence: Array<{
    evidenceSha256: string;
    elementId: string;
    retrievalWindowId: string;
  }>;
  phase: "initial" | "recovery";
}

export interface TelemetryModelIdentity {
  modelId: string;
  provider: string;
}

export interface TelemetryStageDefinition {
  model: TelemetryModelIdentity | null;
  name: TelemetryStageName;
  retrievalMode: RetrievalMode | null;
}

export interface TelemetryStageResult {
  inputCount: number | null;
  inputTokens: number | null;
  outcome: TelemetryStageOutcome;
  outputCount: number | null;
  outputTokens: number | null;
}

export interface TelemetryRunStartRecord {
  embeddingSpaceId: string;
  id: string;
  kind: TelemetryRunKind;
  retrievalMode: RetrievalMode;
  settingsVersion: number;
  startedAt: Date;
  workloadId: string | null;
}

export interface TelemetryStageRecord {
  durationMs: number;
  fallback: boolean;
  id: string;
  inputCount: number | null;
  inputTokens: number | null;
  modelId: string | null;
  name: TelemetryStageName;
  outcome: TelemetryStageOutcome;
  outputCount: number | null;
  outputTokens: number | null;
  provider: string | null;
  providerDurationMs: number | null;
  retrievalMode: RetrievalMode | null;
  runId: string;
  schedulerWaitMs: number | null;
  sequence: number;
  startedAt: Date;
}

export interface TelemetryRunCompletionRecord {
  answerBudget: AnswerBudgetTelemetry | null;
  candidateBudget: CandidateBudgetTelemetry | null;
  candidateCount: number | null;
  completedAt: Date;
  durationMs: number;
  fallbackCount: number;
  hydratedContextCount: number | null;
  id: string;
  inputTokens: number | null;
  outcome: TelemetryRunOutcome;
  outputTokens: number | null;
  queryVariantCount: number | null;
  contextSelection: ContextSelectionTelemetry | null;
  rerankerRanking: RerankerRankingTelemetry | null;
  scopeSize: number | null;
  streamDurationMs: number | null;
  timeToFirstTokenMs: number | null;
}

export interface TelemetryStageSnapshot {
  durationMs: number;
  inputCount: number | null;
  inputTokens: number | null;
  modelId: string | null;
  name: TelemetryStageName;
  outcome: TelemetryStageOutcome;
  outputCount: number | null;
  outputTokens: number | null;
  provider: string | null;
  providerDurationMs: number | null;
  retrievalMode: RetrievalMode | null;
  schedulerWaitMs: number | null;
  sequence: number;
}

export interface TelemetryRunSnapshot {
  durationMs: number;
  fallbackCount: number;
  outcome: TelemetryRunOutcome;
  runId: string;
  stages: TelemetryStageSnapshot[];
  streamDurationMs: number | null;
  timeToFirstTokenMs: number | null;
}

export interface RunTelemetrySink {
  completeRun: (record: TelemetryRunCompletionRecord) => Promise<void>;
  recordStage: (record: TelemetryStageRecord) => Promise<void>;
  reportPersistenceFailure?: (
    error: unknown,
    runId: string,
  ) => Promise<void>;
  startRun: (record: TelemetryRunStartRecord) => Promise<void>;
}

export interface TelemetryStage {
  finish: (result: TelemetryStageResult) => Promise<void>;
  timingObserver: TaskTimingObserver;
}

export interface RunTelemetry {
  readonly runId: string | null;
  finish: (outcome: TelemetryRunOutcome) => Promise<TelemetryRunSnapshot | null>;
  markFirstToken: () => void;
  markStreamCompleted: () => void;
  markStreamStarted: () => void;
  recordAnswerRequest: (value: AnswerGenerationRequestTelemetry) => void;
  recordCandidateBudget: (value: CandidateBudgetTelemetry) => void;
  recordContextSelection: (value: ContextSelectionTelemetry) => void;
  recordAnswerBudget: (value: AnswerBudgetTelemetry) => void;
  setCandidateCount: (value: number) => void;
  setHydratedContextCount: (value: number) => void;
  setQueryVariantCount: (value: number) => void;
  recordRerankerRankingScore: (
    modelId: string,
    strongestScore: number,
  ) => void;
  setScopeSize: (value: number) => void;
  setTokenCounts: (inputTokens: number | null, outputTokens: number | null) => void;
  startStage: (definition: TelemetryStageDefinition) => TelemetryStage;
}

interface TelemetryClock {
  monotonicNow: () => number;
  wallNow: () => Date;
}

const systemClock: TelemetryClock = {
  monotonicNow: () => performance.now(),
  wallNow: () => new Date(),
};

export const noopRunTelemetry: RunTelemetry = {
  finish: async () => null,
  markFirstToken: () => undefined,
  markStreamCompleted: () => undefined,
  markStreamStarted: () => undefined,
  recordAnswerRequest: () => undefined,
  recordCandidateBudget: () => undefined,
  recordContextSelection: () => undefined,
  recordAnswerBudget: () => undefined,
  runId: null,
  setCandidateCount: () => undefined,
  setHydratedContextCount: () => undefined,
  setQueryVariantCount: () => undefined,
  recordRerankerRankingScore: () => undefined,
  setScopeSize: () => undefined,
  setTokenCounts: () => undefined,
  startStage: () => noopTelemetryStage,
};

const noopTelemetryStage: TelemetryStage = {
  finish: async () => undefined,
  timingObserver: {
    completed: () => undefined,
    started: () => undefined,
  },
};

export async function startRunTelemetry(
  config: AppConfig,
  kind: TelemetryRunKind,
  sink: RunTelemetrySink | null,
  workloadId: string | null = null,
): Promise<RunTelemetry> {
  return RunTelemetryRecorder.start(
    {
      embeddingSpaceId: config.embeddingSpace.id,
      id: randomUUID(),
      kind,
      retrievalMode: config.retrieval.mode,
      settingsVersion: config.settingsVersion,
      startedAt: systemClock.wallNow(),
      workloadId,
    },
    sink,
    systemClock,
  );
}

export function createTelemetryStageResult(
  outcome: TelemetryStageOutcome,
  counts: {
    inputCount?: number | null;
    inputTokens?: number | null;
    outputCount?: number | null;
    outputTokens?: number | null;
  } = {},
): TelemetryStageResult {
  return {
    inputCount: normalizeCount(counts.inputCount ?? null),
    inputTokens: normalizeCount(counts.inputTokens ?? null),
    outcome,
    outputCount: normalizeCount(counts.outputCount ?? null),
    outputTokens: normalizeCount(counts.outputTokens ?? null),
  };
}

export function readTelemetryFailureOutcome(
  abortSignal?: AbortSignal,
): "abort" | "error" {
  return abortSignal?.aborted === true ? "abort" : "error";
}

export class RunTelemetryRecorder implements RunTelemetry {
  private answerBudget: AnswerBudgetTelemetry | null = null;
  private candidateBudget: CandidateBudgetTelemetry | null = null;
  private candidateCount: number | null = null;
  private completed = false;
  private fallbackCount = 0;
  private hydratedContextCount: number | null = null;
  private inputTokens: number | null = null;
  private outputTokens: number | null = null;
  private persistenceAvailable: boolean;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private queryVariantCount: number | null = null;
  private contextSelection: ContextSelectionTelemetry | null = null;
  private rerankerRanking: RerankerRankingTelemetry | null = null;
  private readonly runStartedAt: number;
  private scopeSize: number | null = null;
  private sequence = 0;
  private readonly stageSnapshots: TelemetryStageSnapshot[] = [];
  private streamCompletedAt: number | null = null;
  private streamStartedAt: number | null = null;
  private timeToFirstTokenMs: number | null = null;

  private constructor(
    private readonly startRecord: TelemetryRunStartRecord,
    private readonly sink: RunTelemetrySink | null,
    private readonly clock: TelemetryClock,
  ) {
    this.persistenceAvailable = sink !== null;
    this.runStartedAt = clock.monotonicNow();
  }

  public static async start(
    startRecord: TelemetryRunStartRecord,
    sink: RunTelemetrySink | null,
    clock: TelemetryClock = systemClock,
  ): Promise<RunTelemetryRecorder> {
    const recorder = new RunTelemetryRecorder(startRecord, sink, clock);
    await recorder.persistImmediately(() => sink?.startRun(startRecord));
    return recorder;
  }

  public get runId(): string {
    return this.startRecord.id;
  }

  public startStage(definition: TelemetryStageDefinition): TelemetryStage {
    if (this.completed) {
      throw new Error("Cannot start a telemetry stage after run completion.");
    }
    const sequence = this.sequence;
    this.sequence += 1;
    return new RecordedTelemetryStage(
      this,
      definition,
      sequence,
      this.clock,
    );
  }

  public setCandidateCount(value: number): void {
    this.candidateCount = requireCount(value, "Candidate count");
  }

  public setHydratedContextCount(value: number): void {
    this.hydratedContextCount = requireCount(value, "Hydrated context count");
  }

  public setQueryVariantCount(value: number): void {
    this.queryVariantCount = requireCount(value, "Query variant count");
  }

  public recordRerankerRankingScore(
    modelId: string,
    strongestScore: number,
  ): void {
    if (!Number.isFinite(strongestScore)) {
      throw new Error("Reranker ranking score must be finite.");
    }
    this.rerankerRanking = {
      modelId,
      outcome: "not-assessed",
      reason: "ranking-only",
      strongestScore,
      threshold: null,
    };
  }

  public recordContextSelection(value: ContextSelectionTelemetry): void {
    this.contextSelection = value;
  }

  public recordCandidateBudget(value: CandidateBudgetTelemetry): void {
    this.candidateBudget = structuredClone(value);
  }

  public recordAnswerBudget(value: AnswerBudgetTelemetry): void {
    this.answerBudget = structuredClone(value);
  }

  public recordAnswerRequest(value: AnswerGenerationRequestTelemetry): void {
    if (this.answerBudget === null) {
      throw new Error("Answer request telemetry requires a recorded answer budget.");
    }
    this.answerBudget.requests.push(structuredClone(value));
  }

  public setScopeSize(value: number): void {
    this.scopeSize = requireCount(value, "Scope size");
  }

  public setTokenCounts(
    inputTokens: number | null,
    outputTokens: number | null,
  ): void {
    this.inputTokens = normalizeCount(inputTokens);
    this.outputTokens = normalizeCount(outputTokens);
  }

  public markStreamStarted(): void {
    if (this.streamStartedAt === null) {
      this.streamStartedAt = this.clock.monotonicNow();
    }
  }

  public markFirstToken(): void {
    if (this.timeToFirstTokenMs !== null) {
      return;
    }
    this.timeToFirstTokenMs = elapsedMilliseconds(
      this.runStartedAt,
      this.clock.monotonicNow(),
    );
  }

  public markStreamCompleted(): void {
    if (this.streamStartedAt === null || this.streamCompletedAt !== null) {
      return;
    }
    this.streamCompletedAt = this.clock.monotonicNow();
  }

  public async finish(
    outcome: TelemetryRunOutcome,
  ): Promise<TelemetryRunSnapshot> {
    if (this.completed) {
      throw new Error("Telemetry run was completed more than once.");
    }
    this.completed = true;
    const completedAtMonotonic = this.clock.monotonicNow();
    const durationMs = elapsedMilliseconds(
      this.runStartedAt,
      completedAtMonotonic,
    );
    const streamDurationMs = this.readStreamDuration();
    const completion: TelemetryRunCompletionRecord = {
      answerBudget: this.answerBudget,
      candidateBudget: this.candidateBudget,
      candidateCount: this.candidateCount,
      completedAt: this.clock.wallNow(),
      durationMs,
      fallbackCount: this.fallbackCount,
      hydratedContextCount: this.hydratedContextCount,
      id: this.runId,
      inputTokens: this.inputTokens,
      outcome,
      outputTokens: this.outputTokens,
      queryVariantCount: this.queryVariantCount,
      contextSelection: this.contextSelection,
      rerankerRanking: this.rerankerRanking,
      scopeSize: this.scopeSize,
      streamDurationMs,
      timeToFirstTokenMs: this.timeToFirstTokenMs,
    };
    await this.persistenceQueue;
    await this.persistImmediately(() => this.sink?.completeRun(completion));
    const stages = [...this.stageSnapshots];
    stages.sort((left, right) => left.sequence - right.sequence);
    return {
      durationMs,
      fallbackCount: this.fallbackCount,
      outcome,
      runId: this.runId,
      stages,
      streamDurationMs,
      timeToFirstTokenMs: this.timeToFirstTokenMs,
    };
  }

  public async recordStage(
    record: TelemetryStageRecord,
  ): Promise<void> {
    if (record.outcome === "fallback") {
      this.fallbackCount += 1;
    }
    if (record.name === "answer") {
      this.setTokenCounts(record.inputTokens, record.outputTokens);
    }
    this.stageSnapshots.push({
      durationMs: record.durationMs,
      inputCount: record.inputCount,
      inputTokens: record.inputTokens,
      modelId: record.modelId,
      name: record.name,
      outcome: record.outcome,
      outputCount: record.outputCount,
      outputTokens: record.outputTokens,
      provider: record.provider,
      providerDurationMs: record.providerDurationMs,
      retrievalMode: record.retrievalMode,
      schedulerWaitMs: record.schedulerWaitMs,
      sequence: record.sequence,
    });
    this.enqueuePersistence(() => this.sink?.recordStage(record));
  }

  private readStreamDuration(): number | null {
    if (this.streamStartedAt === null) {
      return null;
    }
    const completedAt = this.streamCompletedAt ?? this.clock.monotonicNow();
    return elapsedMilliseconds(this.streamStartedAt, completedAt);
  }

  private enqueuePersistence(
    operation: () => Promise<void> | undefined,
  ): void {
    if (!this.persistenceAvailable) {
      return;
    }
    this.persistenceQueue = this.persistenceQueue.then(async () => {
      if (!this.persistenceAvailable) {
        return;
      }
      try {
        await operation();
      } catch (error: unknown) {
        await this.disablePersistence(error);
      }
    });
  }

  private async persistImmediately(
    operation: () => Promise<void> | undefined,
  ): Promise<void> {
    if (!this.persistenceAvailable) {
      return;
    }
    try {
      await operation();
    } catch (error: unknown) {
      await this.disablePersistence(error);
    }
  }

  private async disablePersistence(error: unknown): Promise<void> {
    this.persistenceAvailable = false;
    if (this.sink?.reportPersistenceFailure !== undefined) {
      try {
        await this.sink.reportPersistenceFailure(error, this.runId);
        return;
      } catch {
        // Fall through to the non-recursive structured container log.
      }
    }
    console.error(JSON.stringify({
      error: {
        category: "database-operation",
        code: "run_telemetry_persistence_failed",
        runId: this.runId,
      },
      level: "error",
      operation: "persist-run-telemetry",
    }));
  }
}

class RecordedTelemetryStage implements TelemetryStage {
  private executionCompletedAt: number | null = null;
  private executionStartedAt: number | null = null;
  private finished = false;
  private readonly stageStartedAt: number;
  private readonly wallStartedAt: Date;

  public readonly timingObserver: TaskTimingObserver = {
    completed: () => {
      if (this.executionStartedAt !== null && this.executionCompletedAt === null) {
        this.executionCompletedAt = this.clock.monotonicNow();
      }
    },
    started: () => {
      if (this.executionStartedAt === null) {
        this.executionStartedAt = this.clock.monotonicNow();
      }
    },
  };

  public constructor(
    private readonly run: RunTelemetryRecorder,
    private readonly definition: TelemetryStageDefinition,
    private readonly sequence: number,
    private readonly clock: TelemetryClock,
  ) {
    this.stageStartedAt = clock.monotonicNow();
    this.wallStartedAt = clock.wallNow();
  }

  public async finish(result: TelemetryStageResult): Promise<void> {
    if (this.finished) {
      return;
    }
    this.finished = true;
    const finishedAt = this.clock.monotonicNow();
    const executionCompletedAt = this.executionCompletedAt
      ?? (this.executionStartedAt === null ? null : finishedAt);
    const model = this.definition.model;
    const record: TelemetryStageRecord = {
      durationMs: elapsedMilliseconds(this.stageStartedAt, finishedAt),
      fallback: result.outcome === "fallback",
      id: randomUUID(),
      inputCount: result.inputCount,
      inputTokens: result.inputTokens,
      modelId: model?.modelId ?? null,
      name: this.definition.name,
      outcome: result.outcome,
      outputCount: result.outputCount,
      outputTokens: result.outputTokens,
      provider: model?.provider ?? null,
      providerDurationMs: readExecutionDuration(
        this.executionStartedAt,
        executionCompletedAt,
      ),
      retrievalMode: this.definition.retrievalMode,
      runId: this.run.runId,
      schedulerWaitMs: this.executionStartedAt === null
        ? null
        : elapsedMilliseconds(this.stageStartedAt, this.executionStartedAt),
      sequence: this.sequence,
      startedAt: this.wallStartedAt,
    };
    await this.run.recordStage(record);
  }
}

function readExecutionDuration(
  startedAt: number | null,
  completedAt: number | null,
): number | null {
  if (startedAt === null || completedAt === null) {
    return null;
  }
  return elapsedMilliseconds(startedAt, completedAt);
}

function elapsedMilliseconds(startedAt: number, completedAt: number): number {
  return Math.max(0, Math.round(completedAt - startedAt));
}

function requireCount(value: number, label: string): number {
  const normalized = normalizeCount(value);
  if (normalized === null) {
    throw new Error(`${label} must be a nonnegative integer.`);
  }
  return normalized;
}

function normalizeCount(value: number | null): number | null {
  if (value === null || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}
