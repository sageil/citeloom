import { hostname } from "node:os";

import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { ApplicationRuntime } from "../app/runtime.js";
import type { AppConfig, WorkloadClass } from "../config/index.js";
import {
  openDatabase,
  type CiteLoomDatabase,
} from "../database/client.js";
import {
  inferenceSchedulingEvents,
  telemetryRuns,
  telemetryStages,
} from "../database/schema.js";
import type {
  AnswerResponseFailureCategory,
  RunTelemetrySink,
  TelemetryRunCompletionRecord,
  TelemetryRunKind,
  TelemetryRunStartRecord,
  TelemetryStageRecord,
} from "./run.js";
import {
  telemetryStageNameSchema,
  type TelemetryStageName,
} from "./stage.js";
import { ApplicationErrorReporter } from "./application-errors.js";

const TELEMETRY_WINDOW_HOURS = 24;

export interface TelemetryPercentiles {
  p50: number | null;
  p95: number | null;
  p99: number | null;
}

export interface TelemetryRequestSummary {
  abortRate: number;
  errorRate: number;
  fallbackRate: number;
  kind: TelemetryRunKind;
  requestLatencyMs: TelemetryPercentiles;
  sampleCount: number;
  streamDurationMs: TelemetryPercentiles;
  timeToFirstTokenMs: TelemetryPercentiles;
}

export interface TelemetryStageSummary {
  abortRate: number;
  durationMs: TelemetryPercentiles;
  errorRate: number;
  fallbackRate: number;
  modelId: string | null;
  name: TelemetryStageName;
  provider: string | null;
  providerDurationMs: TelemetryPercentiles;
  sampleCount: number;
  schedulerWaitMs: TelemetryPercentiles;
}

export interface TelemetrySchedulingSummary {
  abortRate: number;
  errorRate: number;
  executionDurationMs: TelemetryPercentiles;
  queueWaitMs: TelemetryPercentiles;
  resourceGroup: string;
  sampleCount: number;
  workload: WorkloadClass;
}

export interface TelemetryCorrectionSummary {
  count: number;
  provider: string;
  reason: AnswerResponseFailureCategory;
}

export interface TelemetryDashboardSummary {
  corrections: TelemetryCorrectionSummary[];
  enabled: boolean;
  generatedAt: string;
  requests: TelemetryRequestSummary[];
  scheduling: TelemetrySchedulingSummary[];
  stages: TelemetryStageSummary[];
  windowHours: number;
}

export interface TelemetryRunSample {
  durationMs: number;
  fallbackCount: number;
  kind: TelemetryRunKind;
  outcome: "abort" | "error" | "success";
  streamDurationMs: number | null;
  timeToFirstTokenMs: number | null;
}

export interface TelemetryStageSample {
  durationMs: number;
  modelId: string | null;
  name: TelemetryStageName;
  outcome: "abort" | "error" | "fallback" | "success";
  provider: string | null;
  providerDurationMs: number | null;
  schedulerWaitMs: number | null;
}

export interface TelemetrySchedulingSample {
  executionDurationMs: number | null;
  outcome: "abort" | "error" | "success";
  queueWaitMs: number;
  resourceGroup: string;
  workload: WorkloadClass;
}

const runSampleSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  fallbackCount: z.number().int().nonnegative(),
  kind: z.enum(["answer", "benchmark", "chat", "retrieval", "search"]),
  outcome: z.enum(["abort", "error", "success"]),
  streamDurationMs: z.number().int().nonnegative().nullable(),
  timeToFirstTokenMs: z.number().int().nonnegative().nullable(),
}).strict();

const stageSampleSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  modelId: z.string().min(1).nullable(),
  name: telemetryStageNameSchema,
  outcome: z.enum(["abort", "error", "fallback", "success"]),
  provider: z.string().min(1).nullable(),
  providerDurationMs: z.number().int().nonnegative().nullable(),
  schedulerWaitMs: z.number().int().nonnegative().nullable(),
}).strict().superRefine((value, context) => {
  if ((value.modelId === null) !== (value.provider === null)) {
    context.addIssue({
      code: "custom",
      message: "model ID and provider must both be present or absent",
      path: ["modelId"],
    });
  }
});

const schedulingSampleSchema = z.object({
  executionDurationMs: z.number().int().nonnegative().nullable(),
  outcome: z.enum(["abort", "error", "success"]),
  queueWaitMs: z.number().int().nonnegative(),
  resourceGroup: z.string().min(1).max(100),
  workload: z.enum([
    "offline-tool",
    "ingestion",
    "interactive-answer",
    "interactive-search",
    "maintenance",
  ]),
}).strict();

const correctionSummarySchema = z.object({
  count: z.coerce.number().int().positive(),
  provider: z.string().min(1),
  reason: z.enum([
    "invalid-content",
    "invalid-json",
    "invalid-structure",
    "unknown-evidence-reference",
  ]),
}).strict();

export class DatabaseRunTelemetrySink implements RunTelemetrySink {
  public constructor(private readonly database: CiteLoomDatabase) {}

  public async reportPersistenceFailure(
    error: unknown,
    runId: string,
  ): Promise<void> {
    const reporter = new ApplicationErrorReporter(this.database);
    await reporter.report(error, {
      category: "database-operation",
      code: "run_telemetry_persistence_failed",
      instance: hostname(),
      operation: "persist-run-telemetry",
      origin: "database-operation",
      retryable: true,
      runId,
      service: "web",
      severity: "warning",
    });
  }

  public async startRun(record: TelemetryRunStartRecord): Promise<void> {
    await this.database.insert(telemetryRuns).values({
      embeddingSpaceId: record.embeddingSpaceId,
      id: record.id,
      kind: record.kind,
      retrievalMode: record.retrievalMode,
      settingsVersion: record.settingsVersion,
      startedAt: record.startedAt,
      workloadId: record.workloadId,
    });
  }

  public async recordStage(record: TelemetryStageRecord): Promise<void> {
    await this.database.insert(telemetryStages).values(record);
  }

  public async completeRun(
    record: TelemetryRunCompletionRecord,
  ): Promise<void> {
    const rerankerRanking = record.rerankerRanking;
    await this.database
      .update(telemetryRuns)
      .set({
        answerBudget: record.answerBudget,
        candidateBudget: record.candidateBudget,
        candidateCount: record.candidateCount,
        contextSelection: record.contextSelection,
        completedAt: record.completedAt,
        durationMs: record.durationMs,
        fallbackCount: record.fallbackCount,
        hydratedContextCount: record.hydratedContextCount,
        inputTokens: record.inputTokens,
        outcome: record.outcome,
        outputTokens: record.outputTokens,
        queryVariantCount: record.queryVariantCount,
        retrievalSufficiencyModelId: rerankerRanking?.modelId ?? null,
        retrievalSufficiencyOutcome: rerankerRanking?.outcome ?? null,
        retrievalSufficiencyReason: rerankerRanking?.reason ?? null,
        retrievalSufficiencyScore: rerankerRanking?.strongestScore ?? null,
        scopeSize: record.scopeSize,
        streamDurationMs: record.streamDurationMs,
        timeToFirstTokenMs: record.timeToFirstTokenMs,
      })
      .where(eq(telemetryRuns.id, record.id));
  }
}

export class TelemetryRepository {
  public constructor(private readonly database: CiteLoomDatabase) {}

  public async readDashboard(
    now: Date = new Date(),
  ): Promise<TelemetryDashboardSummary> {
    const windowStartedAt = new Date(
      now.getTime() - (TELEMETRY_WINDOW_HOURS * 60 * 60 * 1_000),
    );
    const [rawRuns, rawStages, rawScheduling, rawCorrections] = await Promise.all([
      this.database
        .select({
          durationMs: telemetryRuns.durationMs,
          fallbackCount: telemetryRuns.fallbackCount,
          kind: telemetryRuns.kind,
          outcome: telemetryRuns.outcome,
          streamDurationMs: telemetryRuns.streamDurationMs,
          timeToFirstTokenMs: telemetryRuns.timeToFirstTokenMs,
        })
        .from(telemetryRuns)
        .where(and(
          gte(telemetryRuns.startedAt, windowStartedAt),
          isNotNull(telemetryRuns.completedAt),
          isNotNull(telemetryRuns.durationMs),
          isNotNull(telemetryRuns.outcome),
        )),
      this.database
        .select({
          durationMs: telemetryStages.durationMs,
          modelId: telemetryStages.modelId,
          name: telemetryStages.name,
          outcome: telemetryStages.outcome,
          provider: telemetryStages.provider,
          providerDurationMs: telemetryStages.providerDurationMs,
          schedulerWaitMs: telemetryStages.schedulerWaitMs,
        })
        .from(telemetryStages)
        .where(gte(telemetryStages.startedAt, windowStartedAt)),
      this.database
        .select({
          executionDurationMs: inferenceSchedulingEvents.executionDurationMs,
          outcome: inferenceSchedulingEvents.outcome,
          queueWaitMs: inferenceSchedulingEvents.queueWaitMs,
          resourceGroup: inferenceSchedulingEvents.resourceGroup,
          workload: inferenceSchedulingEvents.workload,
        })
        .from(inferenceSchedulingEvents)
        .where(gte(inferenceSchedulingEvents.completedAt, windowStartedAt)),
      this.database.execute(sql`
        SELECT
          count(*)::integer AS "count",
          diagnostic->>'provider' AS "provider",
          diagnostic->>'failureCategory' AS "reason"
        FROM "telemetry_runs" run
        CROSS JOIN LATERAL jsonb_array_elements(
          COALESCE(run."answer_budget"->'responseDiagnostics', '[]'::jsonb)
        ) diagnostic
        WHERE run."started_at" >= ${windowStartedAt}
          AND run."completed_at" IS NOT NULL
          AND diagnostic->>'phase' = 'initial'
          AND diagnostic->>'correctionOutcome' <> 'not-needed'
          AND diagnostic->>'failureCategory' IS NOT NULL
        GROUP BY diagnostic->>'provider', diagnostic->>'failureCategory'
        ORDER BY diagnostic->>'provider', diagnostic->>'failureCategory'
      `),
    ]);
    const runs = decodeRunSamples(rawRuns);
    const stages = decodeTelemetryStageSamples(rawStages);
    const scheduling = decodeSchedulingSamples(rawScheduling);
    const corrections = decodeCorrectionSummaries(rawCorrections.rows);
    return summarizeTelemetry(runs, stages, now, scheduling, corrections);
  }
}

export async function readTelemetryDashboard(
  config: AppConfig,
): Promise<TelemetryDashboardSummary> {
  if (!config.inferenceMetrics.enabled) {
    return createEmptyTelemetryDashboard(false);
  }
  const session = await openDatabase(config.database);
  try {
    const repository = new TelemetryRepository(session.database);
    return await repository.readDashboard();
  } finally {
    await session.close();
  }
}

export async function readTelemetryDashboardWithRuntime(
  runtime: ApplicationRuntime,
): Promise<TelemetryDashboardSummary> {
  if (!runtime.config.inferenceMetrics.enabled) {
    return createEmptyTelemetryDashboard(false);
  }
  const repository = new TelemetryRepository(runtime.database);
  return repository.readDashboard();
}

export function summarizeTelemetry(
  runs: TelemetryRunSample[],
  stages: TelemetryStageSample[],
  generatedAt: Date = new Date(),
  scheduling: TelemetrySchedulingSample[] = [],
  corrections: TelemetryCorrectionSummary[] = [],
): TelemetryDashboardSummary {
  const requestsByKind = new Map<TelemetryRunKind, TelemetryRunSample[]>();
  for (const run of runs) {
    const existing = requestsByKind.get(run.kind);
    if (existing === undefined) {
      requestsByKind.set(run.kind, [run]);
    } else {
      existing.push(run);
    }
  }
  const requestKinds = [...requestsByKind.keys()];
  requestKinds.sort();
  const requests: TelemetryRequestSummary[] = [];
  for (const kind of requestKinds) {
    const samples = requestsByKind.get(kind);
    if (samples === undefined) {
      continue;
    }
    requests.push(summarizeRequestKind(kind, samples));
  }

  const stagesByIdentity = new Map<string, TelemetryStageSample[]>();
  for (const stage of stages) {
    const key = createStageIdentity(stage);
    const existing = stagesByIdentity.get(key);
    if (existing === undefined) {
      stagesByIdentity.set(key, [stage]);
    } else {
      existing.push(stage);
    }
  }
  const stageKeys = [...stagesByIdentity.keys()];
  stageKeys.sort();
  const stageSummaries: TelemetryStageSummary[] = [];
  for (const key of stageKeys) {
    const samples = stagesByIdentity.get(key);
    if (samples === undefined || samples.length === 0) {
      continue;
    }
    stageSummaries.push(summarizeStage(samples));
  }
  const schedulingByIdentity = new Map<string, TelemetrySchedulingSample[]>();
  for (const sample of scheduling) {
    const key = `${sample.resourceGroup}\u0000${sample.workload}`;
    const existing = schedulingByIdentity.get(key);
    if (existing === undefined) {
      schedulingByIdentity.set(key, [sample]);
    } else {
      existing.push(sample);
    }
  }
  const schedulingKeys = [...schedulingByIdentity.keys()];
  schedulingKeys.sort();
  const schedulingSummaries: TelemetrySchedulingSummary[] = [];
  for (const key of schedulingKeys) {
    const samples = schedulingByIdentity.get(key);
    if (samples === undefined || samples.length === 0) {
      continue;
    }
    schedulingSummaries.push(summarizeScheduling(samples));
  }
  return {
    corrections: [...corrections],
    enabled: true,
    generatedAt: generatedAt.toISOString(),
    requests,
    scheduling: schedulingSummaries,
    stages: stageSummaries,
    windowHours: TELEMETRY_WINDOW_HOURS,
  };
}

function createEmptyTelemetryDashboard(
  enabled: boolean,
): TelemetryDashboardSummary {
  return {
    corrections: [],
    enabled,
    generatedAt: new Date().toISOString(),
    requests: [],
    scheduling: [],
    stages: [],
    windowHours: TELEMETRY_WINDOW_HOURS,
  };
}

function decodeCorrectionSummaries(
  rows: unknown[],
): TelemetryCorrectionSummary[] {
  const summaries: TelemetryCorrectionSummary[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const result = correctionSummarySchema.safeParse(rows[index]);
    if (!result.success) {
      throw new Error(
        `Invalid correction telemetry row ${index + 1}: ${result.error.message}`,
      );
    }
    summaries.push(result.data);
  }
  return summaries;
}

function decodeRunSamples(rows: unknown[]): TelemetryRunSample[] {
  const samples: TelemetryRunSample[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const result = runSampleSchema.safeParse(rows[index]);
    if (!result.success) {
      throw new Error(
        `Invalid telemetry run row ${index + 1}: ${result.error.message}`,
      );
    }
    samples.push(result.data);
  }
  return samples;
}

export function decodeTelemetryStageSamples(
  rows: unknown[],
): TelemetryStageSample[] {
  const samples: TelemetryStageSample[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const result = stageSampleSchema.safeParse(rows[index]);
    if (!result.success) {
      throw new Error(
        `Invalid telemetry stage row ${index + 1}: ${result.error.message}`,
      );
    }
    samples.push(result.data);
  }
  return samples;
}

function decodeSchedulingSamples(rows: unknown[]): TelemetrySchedulingSample[] {
  const samples: TelemetrySchedulingSample[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const result = schedulingSampleSchema.safeParse(rows[index]);
    if (!result.success) {
      throw new Error(
        `Invalid scheduling telemetry row ${index + 1}: ${result.error.message}`,
      );
    }
    samples.push(result.data);
  }
  return samples;
}

function summarizeRequestKind(
  kind: TelemetryRunKind,
  samples: TelemetryRunSample[],
): TelemetryRequestSummary {
  const durations: number[] = [];
  const streamDurations: number[] = [];
  const firstTokenDurations: number[] = [];
  let aborts = 0;
  let errors = 0;
  let fallbacks = 0;
  for (const sample of samples) {
    durations.push(sample.durationMs);
    if (sample.streamDurationMs !== null) {
      streamDurations.push(sample.streamDurationMs);
    }
    if (sample.timeToFirstTokenMs !== null) {
      firstTokenDurations.push(sample.timeToFirstTokenMs);
    }
    aborts += sample.outcome === "abort" ? 1 : 0;
    errors += sample.outcome === "error" ? 1 : 0;
    fallbacks += sample.fallbackCount > 0 ? 1 : 0;
  }
  return {
    abortRate: calculateRate(aborts, samples.length),
    errorRate: calculateRate(errors, samples.length),
    fallbackRate: calculateRate(fallbacks, samples.length),
    kind,
    requestLatencyMs: calculatePercentiles(durations),
    sampleCount: samples.length,
    streamDurationMs: calculatePercentiles(streamDurations),
    timeToFirstTokenMs: calculatePercentiles(firstTokenDurations),
  };
}

function summarizeStage(
  samples: TelemetryStageSample[],
): TelemetryStageSummary {
  const first = samples[0];
  if (first === undefined) {
    throw new Error("Cannot summarize telemetry without stage samples.");
  }
  const durations: number[] = [];
  const providerDurations: number[] = [];
  const schedulerWaits: number[] = [];
  let aborts = 0;
  let errors = 0;
  let fallbacks = 0;
  for (const sample of samples) {
    durations.push(sample.durationMs);
    if (sample.providerDurationMs !== null) {
      providerDurations.push(sample.providerDurationMs);
    }
    if (sample.schedulerWaitMs !== null) {
      schedulerWaits.push(sample.schedulerWaitMs);
    }
    aborts += sample.outcome === "abort" ? 1 : 0;
    errors += sample.outcome === "error" ? 1 : 0;
    fallbacks += sample.outcome === "fallback" ? 1 : 0;
  }
  return {
    abortRate: calculateRate(aborts, samples.length),
    durationMs: calculatePercentiles(durations),
    errorRate: calculateRate(errors, samples.length),
    fallbackRate: calculateRate(fallbacks, samples.length),
    modelId: first.modelId,
    name: first.name,
    provider: first.provider,
    providerDurationMs: calculatePercentiles(providerDurations),
    sampleCount: samples.length,
    schedulerWaitMs: calculatePercentiles(schedulerWaits),
  };
}

function summarizeScheduling(
  samples: TelemetrySchedulingSample[],
): TelemetrySchedulingSummary {
  const first = samples[0];
  if (first === undefined) {
    throw new Error("Cannot summarize scheduling telemetry without samples.");
  }
  const executionDurations: number[] = [];
  const queueWaits: number[] = [];
  let aborts = 0;
  let errors = 0;
  for (const sample of samples) {
    if (sample.executionDurationMs !== null) {
      executionDurations.push(sample.executionDurationMs);
    }
    queueWaits.push(sample.queueWaitMs);
    aborts += sample.outcome === "abort" ? 1 : 0;
    errors += sample.outcome === "error" ? 1 : 0;
  }
  return {
    abortRate: calculateRate(aborts, samples.length),
    errorRate: calculateRate(errors, samples.length),
    executionDurationMs: calculatePercentiles(executionDurations),
    queueWaitMs: calculatePercentiles(queueWaits),
    resourceGroup: first.resourceGroup,
    sampleCount: samples.length,
    workload: first.workload,
  };
}

function createStageIdentity(stage: TelemetryStageSample): string {
  return [stage.name, stage.provider ?? "", stage.modelId ?? ""].join("\u0000");
}

function calculatePercentiles(values: number[]): TelemetryPercentiles {
  if (values.length === 0) {
    return { p50: null, p95: null, p99: null };
  }
  const sorted = [...values];
  sorted.sort((left, right) => left - right);
  return {
    p50: readPercentile(sorted, 0.5),
    p95: readPercentile(sorted, 0.95),
    p99: readPercentile(sorted, 0.99),
  };
}

function readPercentile(sorted: number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  const value = sorted[index];
  if (value === undefined) {
    throw new Error("Telemetry percentile index is out of range.");
  }
  return value;
}

function calculateRate(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}
