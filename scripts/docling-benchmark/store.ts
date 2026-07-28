import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { CiteLoomDatabase } from "../../src/database/client.js";
import {
  isDoclingTaskDeadlineFailure,
  readDoclingErrorCategory,
} from "../../src/docling/client/index.js";
import {
  doclingBenchmarkProfilingStages,
  doclingBenchmarkResults,
  doclingBenchmarkRuns,
} from "./schema.js";
import {
  decodeDoclingBenchmarkProcessConfiguration,
  decodeDoclingBenchmarkCandidate,
  decodeDoclingBenchmarkEnvironment,
  type DoclingBenchmarkCandidate,
  type DoclingBenchmarkEnvironment,
  type DoclingBenchmarkProcessConfiguration,
  type DoclingPromotionAssessment,
  type DoclingQualityComparison,
} from "./model.js";
import {
  decodeDoclingRequestConfiguration,
  type DoclingProfilingSummary,
  type DoclingRequestConfiguration,
} from "../../src/docling/protocol/run-metadata.js";
import { contentIdSchema } from "../../src/domain/validation.js";

const benchmarkRunRowSchema = z.object({
  candidates: z.array(z.unknown()).min(1),
  corpusDocumentCount: z.number().int().nonnegative(),
  environment: z.unknown(),
  id: z.uuid(),
  orderSeed: z.number().int(),
  p95LatencyRegressionLimit: z.number().min(0).max(0.999_999),
  peakMemoryRegressionLimit: z.number().min(0).max(0.999_999),
  performanceThreshold: z.number().positive().max(0.999_999),
  repetitions: z.number().int().min(3),
  status: z.enum(["completed", "failed", "running"]),
});
const benchmarkResultRowSchema = z.object({
  completedAt: z.date().nullable(),
  id: z.uuid(),
  outcome: z.string().nullable(),
});
const storedBenchmarkResultRowSchema = z.object({
  candidateId: z.string().min(1).max(128),
  comparison: z.object({
    differences: z.array(z.object({
      actual: z.string().regex(/^[a-f0-9]{64}$/),
      expected: z.string().regex(/^[a-f0-9]{64}$/),
      path: z.string().min(1),
    })),
    passed: z.boolean(),
  }).strict().nullable(),
  documentId: contentIdSchema,
  outcome: z.enum(["error", "success", "timeout"]).nullable(),
  peakResidentBytes: z.number().int().nonnegative().nullable(),
  qualityPassed: z.boolean().nullable(),
  repetition: z.number().int().positive(),
  totalWallMs: z.number().int().nonnegative().nullable(),
});

export interface StoredDoclingBenchmarkResult {
  candidateId: string;
  comparison: DoclingQualityComparison | null;
  documentId: string;
  outcome: "error" | "success" | "timeout" | null;
  peakResidentBytes: number | null;
  qualityPassed: boolean | null;
  repetition: number;
  totalWallMs: number | null;
}

export interface StartDoclingBenchmarkInput {
  candidates: DoclingBenchmarkCandidate[];
  corpusDocumentCount: number;
  environment: DoclingBenchmarkEnvironment;
  orderSeed: number;
  p95LatencyRegressionLimit: number;
  peakMemoryRegressionLimit: number;
  performanceThreshold: number;
  repetitions: number;
  runId?: string;
}

export interface BeginDoclingBenchmarkResultInput {
  candidateId: string;
  documentId: string;
  processConfig: DoclingBenchmarkProcessConfiguration;
  repetition: number;
  requestConfig: DoclingRequestConfiguration;
  runOrder: number;
}

export interface CompleteDoclingBenchmarkResultInput {
  comparison: DoclingQualityComparison | null;
  cpuTimeMs: number | null;
  imageCount: number;
  httpRequestCount: number | null;
  httpRequestDurationMs: number | null;
  outputFingerprint: string;
  pageCount: number | null;
  pagesPerSecond: number | null;
  peakResidentBytes: number | null;
  processingMs: number;
  profiling: DoclingProfilingSummary[];
  resultRetrievalMs: number;
  schedulerWaitMs: number;
  tableCount: number;
  taskWaitMs: number;
  textCount: number;
  totalElementCount: number;
  totalWallMs: number;
  uploadMs: number;
}

export class DoclingBenchmarkStore {
  public constructor(private readonly database: CiteLoomDatabase) {}

  public async startOrResumeRun(
    input: StartDoclingBenchmarkInput,
  ): Promise<string> {
    const runId = input.runId ?? randomUUID();
    const existingRows = await this.database
      .select({
        candidates: doclingBenchmarkRuns.candidates,
        corpusDocumentCount: doclingBenchmarkRuns.corpusDocumentCount,
        environment: doclingBenchmarkRuns.environment,
        id: doclingBenchmarkRuns.id,
        orderSeed: doclingBenchmarkRuns.orderSeed,
        p95LatencyRegressionLimit:
          doclingBenchmarkRuns.p95LatencyRegressionLimit,
        peakMemoryRegressionLimit:
          doclingBenchmarkRuns.peakMemoryRegressionLimit,
        performanceThreshold: doclingBenchmarkRuns.performanceThreshold,
        repetitions: doclingBenchmarkRuns.repetitions,
        status: doclingBenchmarkRuns.status,
      })
      .from(doclingBenchmarkRuns)
      .where(eq(doclingBenchmarkRuns.id, runId))
      .limit(1);
    if (existingRows[0] !== undefined) {
      const existing = decodeBenchmarkRun(existingRows[0]);
      if (existing.status === "completed") {
        throw new Error(`Docling benchmark ${runId} is already complete.`);
      }
      requireMatchingBenchmarkRun(existing, input);
      if (existing.status === "failed") {
        await this.database
          .update(doclingBenchmarkRuns)
          .set({ completedAt: null, errorCategory: null, status: "running" })
          .where(eq(doclingBenchmarkRuns.id, runId));
      }
      return existing.id;
    }
    const candidates: DoclingBenchmarkCandidate[] = [];
    for (const candidate of input.candidates) {
      candidates.push(decodeDoclingBenchmarkCandidate(candidate));
    }
    const environment = decodeDoclingBenchmarkEnvironment(input.environment);
    await this.database.insert(doclingBenchmarkRuns).values({
      candidates,
      corpusDocumentCount: readNonnegativeInteger(
        input.corpusDocumentCount,
        "corpus document count",
      ),
      environment,
      id: runId,
      orderSeed: readInteger(input.orderSeed, "benchmark order seed"),
      p95LatencyRegressionLimit: readRegressionLimit(
        input.p95LatencyRegressionLimit,
        "p95 latency regression limit",
      ),
      peakMemoryRegressionLimit: readRegressionLimit(
        input.peakMemoryRegressionLimit,
        "peak memory regression limit",
      ),
      performanceThreshold: readPerformanceThreshold(input.performanceThreshold),
      repetitions: readMinimumRepetitions(input.repetitions),
      startedAt: new Date(),
      status: "running",
    });
    return runId;
  }

  public async beginResult(
    runId: string,
    input: BeginDoclingBenchmarkResultInput,
  ): Promise<{ complete: boolean; id: string }> {
    const id = randomUUID();
    const processConfig =
      decodeDoclingBenchmarkProcessConfiguration(input.processConfig);
    const requestConfig = decodeDoclingRequestConfiguration(
      input.requestConfig,
    );
    await this.database
      .insert(doclingBenchmarkResults)
      .values({
        candidateId: readCandidateId(input.candidateId),
        documentId: readDocumentId(input.documentId),
        id,
        processConfig,
        repetition: readPositiveInteger(input.repetition, "benchmark repetition"),
        requestConfig,
        runId,
        runOrder: readNonnegativeInteger(input.runOrder, "benchmark run order"),
        startedAt: new Date(),
      })
      .onConflictDoNothing();
    const rows = await this.database
      .select({
        completedAt: doclingBenchmarkResults.completedAt,
        id: doclingBenchmarkResults.id,
        outcome: doclingBenchmarkResults.outcome,
      })
      .from(doclingBenchmarkResults)
      .where(and(
        eq(doclingBenchmarkResults.runId, runId),
        eq(doclingBenchmarkResults.documentId, input.documentId),
        eq(doclingBenchmarkResults.candidateId, input.candidateId),
        eq(doclingBenchmarkResults.repetition, input.repetition),
      ))
      .limit(1);
    const stored = decodeBenchmarkResult(rows[0]);
    return { complete: stored.completedAt !== null, id: stored.id };
  }

  public async readNextRunOrder(runId: string): Promise<number> {
    const rows = await this.database
      .select({
        maximum: sql<number>`coalesce(max(${doclingBenchmarkResults.runOrder}), -1)`,
      })
      .from(doclingBenchmarkResults)
      .where(eq(doclingBenchmarkResults.runId, runId));
    const maximum = Number(rows[0]?.maximum ?? -1);
    if (!Number.isInteger(maximum) || maximum < -1) {
      throw new Error("Invalid stored benchmark run order.");
    }
    return maximum + 1;
  }

  public async completeResult(
    resultId: string,
    input: CompleteDoclingBenchmarkResultInput,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          completedAt: doclingBenchmarkResults.completedAt,
          id: doclingBenchmarkResults.id,
          outcome: doclingBenchmarkResults.outcome,
        })
        .from(doclingBenchmarkResults)
        .where(eq(doclingBenchmarkResults.id, resultId))
        .limit(1)
        .for("update");
      const result = decodeBenchmarkResult(rows[0]);
      if (result.completedAt !== null) {
        if (result.outcome !== "success") {
          throw new Error(
            `Benchmark result ${resultId} already completed with ${result.outcome}.`,
          );
        }
        return;
      }
      await transaction
        .update(doclingBenchmarkResults)
        .set({
          comparison: input.comparison,
          completedAt: new Date(),
          cpuTimeMs: readOptionalNonnegativeNumber(input.cpuTimeMs),
          imageCount: input.imageCount,
          httpRequestCount: readOptionalNonnegativeInteger(
            input.httpRequestCount,
          ),
          httpRequestDurationMs: readOptionalNonnegativeNumber(
            input.httpRequestDurationMs,
          ),
          outcome: "success",
          outputFingerprint: readFingerprint(input.outputFingerprint),
          pageCount: input.pageCount,
          pagesPerSecond: input.pagesPerSecond,
          peakResidentBytes: readOptionalNonnegativeNumber(
            input.peakResidentBytes,
          ),
          processingMs: input.processingMs,
          qualityPassed: input.comparison?.passed ?? null,
          resultRetrievalMs: input.resultRetrievalMs,
          schedulerWaitMs: input.schedulerWaitMs,
          tableCount: input.tableCount,
          taskWaitMs: input.taskWaitMs,
          textCount: input.textCount,
          totalElementCount: input.totalElementCount,
          totalWallMs: input.totalWallMs,
          uploadMs: input.uploadMs,
        })
        .where(eq(doclingBenchmarkResults.id, resultId));
      await transaction
        .delete(doclingBenchmarkProfilingStages)
        .where(eq(doclingBenchmarkProfilingStages.benchmarkResultId, resultId));
      if (input.profiling.length === 0) {
        return;
      }
      const profilingRows: Array<
        typeof doclingBenchmarkProfilingStages.$inferInsert
      > = [];
      for (const stage of input.profiling) {
        profilingRows.push({
          benchmarkResultId: resultId,
          count: stage.count,
          id: randomUUID(),
          maximumDurationMs: stage.maximumDurationMs,
          medianDurationMs: stage.medianDurationMs,
          minimumDurationMs: stage.minimumDurationMs,
          p95DurationMs: stage.p95DurationMs,
          scope: stage.scope,
          stage: stage.stage,
          totalDurationMs: stage.totalDurationMs,
        });
      }
      await transaction
        .insert(doclingBenchmarkProfilingStages)
        .values(profilingRows);
    });
  }

  public async failResult(resultId: string, error: unknown): Promise<void> {
    const errorCategory = readErrorCategory(error);
    await this.database
      .update(doclingBenchmarkResults)
      .set({
        completedAt: new Date(),
        errorCategory,
        outcome: isDoclingTaskDeadlineFailure(error) ? "timeout" : "error",
        qualityPassed: false,
      })
      .where(and(
        eq(doclingBenchmarkResults.id, resultId),
        isNull(doclingBenchmarkResults.completedAt),
      ));
  }

  public async failIncompleteResults(
    runId: string,
    error: unknown,
  ): Promise<number> {
    const errorCategory = readErrorCategory(error);
    const rows = await this.database
      .update(doclingBenchmarkResults)
      .set({
        completedAt: new Date(),
        errorCategory,
        outcome: "error",
        qualityPassed: false,
      })
      .where(and(
        eq(doclingBenchmarkResults.runId, runId),
        isNull(doclingBenchmarkResults.completedAt),
      ))
      .returning({ id: doclingBenchmarkResults.id });
    return rows.length;
  }

  public async completeRun(
    runId: string,
    assessment: DoclingPromotionAssessment,
  ): Promise<void> {
    await this.database
      .update(doclingBenchmarkRuns)
      .set({ assessment, completedAt: new Date(), status: "completed" })
      .where(and(
        eq(doclingBenchmarkRuns.id, runId),
        eq(doclingBenchmarkRuns.status, "running"),
      ));
  }

  public async listResults(
    runId: string,
  ): Promise<StoredDoclingBenchmarkResult[]> {
    const rows = await this.database
      .select({
        candidateId: doclingBenchmarkResults.candidateId,
        comparison: doclingBenchmarkResults.comparison,
        documentId: doclingBenchmarkResults.documentId,
        outcome: doclingBenchmarkResults.outcome,
        peakResidentBytes: doclingBenchmarkResults.peakResidentBytes,
        qualityPassed: doclingBenchmarkResults.qualityPassed,
        repetition: doclingBenchmarkResults.repetition,
        totalWallMs: doclingBenchmarkResults.totalWallMs,
      })
      .from(doclingBenchmarkResults)
      .where(eq(doclingBenchmarkResults.runId, runId));
    const results: StoredDoclingBenchmarkResult[] = [];
    for (const row of rows) {
      const decoded = storedBenchmarkResultRowSchema.safeParse(row);
      if (!decoded.success) {
        throw new Error(
          `Invalid stored Docling benchmark result: ${decoded.error.message}`,
        );
      }
      results.push(decoded.data);
    }
    return results;
  }

  public async failRun(runId: string, error: unknown): Promise<void> {
    await this.database
      .update(doclingBenchmarkRuns)
      .set({
        completedAt: new Date(),
        errorCategory: readErrorCategory(error),
        status: "failed",
      })
      .where(and(
        eq(doclingBenchmarkRuns.id, runId),
        eq(doclingBenchmarkRuns.status, "running"),
      ));
  }
}

function decodeBenchmarkRun(value: unknown) {
  const result = benchmarkRunRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid Docling benchmark run row: ${result.error.message}`);
  }
  const candidates: DoclingBenchmarkCandidate[] = [];
  for (const candidate of result.data.candidates) {
    candidates.push(decodeDoclingBenchmarkCandidate(candidate));
  }
  return {
    ...result.data,
    candidates,
    environment: decodeDoclingBenchmarkEnvironment(result.data.environment),
  };
}

function requireMatchingBenchmarkRun(
  existing: ReturnType<typeof decodeBenchmarkRun>,
  input: StartDoclingBenchmarkInput,
): void {
  const candidates: DoclingBenchmarkCandidate[] = [];
  for (const candidate of input.candidates) {
    candidates.push(decodeDoclingBenchmarkCandidate(candidate));
  }
  const environment = decodeDoclingBenchmarkEnvironment(input.environment);
  const expected = {
    candidates,
    corpusDocumentCount: input.corpusDocumentCount,
    environment,
    orderSeed: input.orderSeed,
    p95LatencyRegressionLimit: input.p95LatencyRegressionLimit,
    peakMemoryRegressionLimit: input.peakMemoryRegressionLimit,
    performanceThreshold: input.performanceThreshold,
    repetitions: input.repetitions,
  };
  const actual = {
    candidates: existing.candidates,
    corpusDocumentCount: existing.corpusDocumentCount,
    environment: existing.environment,
    orderSeed: existing.orderSeed,
    p95LatencyRegressionLimit: existing.p95LatencyRegressionLimit,
    peakMemoryRegressionLimit: existing.peakMemoryRegressionLimit,
    performanceThreshold: existing.performanceThreshold,
    repetitions: existing.repetitions,
  };
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error("Resumed Docling benchmark configuration does not match its stored run.");
  }
}

function decodeBenchmarkResult(value: unknown) {
  const result = benchmarkResultRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid Docling benchmark result row: ${result.error.message}`);
  }
  return result.data;
}

function readDocumentId(value: string): string {
  const result = contentIdSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Invalid benchmark document id.");
  }
  return result.data;
}

function readCandidateId(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > 128
    || !/^[a-z0-9][a-z0-9:._-]*$/.test(normalized)
  ) {
    throw new Error("Invalid benchmark candidate id.");
  }
  return normalized;
}

function readFingerprint(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Invalid benchmark output fingerprint.");
  }
  return value;
}

function readMinimumRepetitions(value: number): number {
  const repetitions = readPositiveInteger(value, "benchmark repetitions");
  if (repetitions < 3) {
    throw new Error("A finalist benchmark requires at least three repetitions.");
  }
  return repetitions;
}

function readPerformanceThreshold(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error("Invalid benchmark performance threshold.");
  }
  return value;
}

function readRegressionLimit(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function readInteger(value: number, name: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function readPositiveInteger(value: number, name: string): number {
  const normalized = readInteger(value, name);
  if (normalized <= 0) {
    throw new Error(`Invalid ${name}.`);
  }
  return normalized;
}

function readNonnegativeInteger(value: number, name: string): number {
  const normalized = readInteger(value, name);
  if (normalized < 0) {
    throw new Error(`Invalid ${name}.`);
  }
  return normalized;
}

function readOptionalNonnegativeNumber(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Invalid optional benchmark measurement.");
  }
  return Math.round(value);
}

function readOptionalNonnegativeInteger(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  return readNonnegativeInteger(value, "optional benchmark count");
}

function readErrorCategory(error: unknown): string {
  if (isDoclingTaskDeadlineFailure(error)) {
    return "DoclingTaskDeadlineError";
  }
  return readDoclingErrorCategory(error);
}
