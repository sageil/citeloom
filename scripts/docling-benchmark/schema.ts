import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import type {
  DoclingBenchmarkCandidate,
  DoclingBenchmarkEnvironment,
  DoclingBenchmarkProcessConfiguration,
  DoclingPromotionAssessment,
  DoclingQualityComparison,
} from "./model.js";
import type {
  DoclingRequestConfiguration,
} from "../../src/docling/protocol/run-metadata.js";

export const DOCLING_BENCHMARK_SCHEMA_NAME = "citeloom_benchmark";

const benchmarkSchema = pgSchema(DOCLING_BENCHMARK_SCHEMA_NAME);

export const doclingBenchmarkRuns = benchmarkSchema.table(
  "runs",
  {
    candidates: jsonb("candidates").$type<DoclingBenchmarkCandidate[]>().notNull(),
    assessment: jsonb("assessment").$type<DoclingPromotionAssessment>(),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    corpusDocumentCount: integer("corpus_document_count").notNull(),
    environment: jsonb("environment").$type<DoclingBenchmarkEnvironment>().notNull(),
    errorCategory: varchar("error_category", { length: 64 }),
    id: uuid("id").primaryKey(),
    orderSeed: integer("order_seed").notNull(),
    p95LatencyRegressionLimit: doublePrecision("p95_latency_regression_limit")
      .notNull(),
    peakMemoryRegressionLimit: doublePrecision("peak_memory_regression_limit")
      .notNull(),
    performanceThreshold: doublePrecision("performance_threshold").notNull(),
    repetitions: integer("repetitions").notNull(),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    status: varchar("status", { length: 16 }).notNull(),
  },
  (table) => [
    index("runs_started_at_idx").on(table.startedAt),
    check(
      "runs_threshold_check",
      sql`${table.performanceThreshold} > 0 AND ${table.performanceThreshold} < 1`,
    ),
    check(
      "runs_p95_limit_check",
      sql`${table.p95LatencyRegressionLimit} >= 0 AND ${table.p95LatencyRegressionLimit} < 1`,
    ),
    check(
      "runs_memory_limit_check",
      sql`${table.peakMemoryRegressionLimit} >= 0 AND ${table.peakMemoryRegressionLimit} < 1`,
    ),
    check("runs_repetitions_check", sql`${table.repetitions} >= 3`),
    check(
      "runs_status_check",
      sql`${table.status} IN ('running', 'completed', 'failed')`,
    ),
    check(
      "runs_completion_check",
      sql`(${table.status} = 'running' AND ${table.completedAt} IS NULL) OR (${table.status} IN ('completed', 'failed') AND ${table.completedAt} IS NOT NULL)`,
    ),
  ],
);

export const doclingBenchmarkResults = benchmarkSchema.table(
  "results",
  {
    candidateId: varchar("candidate_id", { length: 128 }).notNull(),
    completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
    comparison: jsonb("comparison").$type<DoclingQualityComparison>(),
    cpuTimeMs: integer("cpu_time_ms"),
    documentId: varchar("document_id", { length: 64 }).notNull(),
    errorCategory: varchar("error_category", { length: 64 }),
    id: uuid("id").primaryKey(),
    imageCount: integer("image_count"),
    httpRequestCount: integer("http_request_count"),
    httpRequestDurationMs: doublePrecision("http_request_duration_ms"),
    outcome: varchar("outcome", { length: 32 }),
    outputFingerprint: varchar("output_fingerprint", { length: 64 }),
    pageCount: integer("page_count"),
    pagesPerSecond: doublePrecision("pages_per_second"),
    peakResidentBytes: bigint("peak_resident_bytes", { mode: "number" }),
    processConfig: jsonb("process_config")
      .$type<DoclingBenchmarkProcessConfiguration>()
      .notNull(),
    processingMs: integer("processing_ms"),
    qualityPassed: boolean("quality_passed"),
    repetition: integer("repetition").notNull(),
    requestConfig: jsonb("request_config")
      .$type<DoclingRequestConfiguration>()
      .notNull(),
    resultRetrievalMs: integer("result_retrieval_ms"),
    runId: uuid("run_id")
      .notNull()
      .references(() => doclingBenchmarkRuns.id, { onDelete: "cascade" }),
    runOrder: integer("run_order").notNull(),
    schedulerWaitMs: integer("scheduler_wait_ms"),
    startedAt: timestamp("started_at", { mode: "date", withTimezone: true }),
    tableCount: integer("table_count"),
    taskWaitMs: integer("task_wait_ms"),
    textCount: integer("text_count"),
    totalElementCount: integer("total_element_count"),
    totalWallMs: integer("total_wall_ms"),
    uploadMs: integer("upload_ms"),
  },
  (table) => [
    uniqueIndex("results_identity_idx").on(
      table.runId,
      table.documentId,
      table.candidateId,
      table.repetition,
    ),
    index("results_candidate_idx").on(table.runId, table.candidateId),
    check("results_repetition_check", sql`${table.repetition} > 0`),
    check(
      "results_completion_check",
      sql`(${table.completedAt} IS NULL AND ${table.outcome} IS NULL) OR (${table.completedAt} IS NOT NULL AND ${table.outcome} IS NOT NULL)`,
    ),
    check(
      "results_outcome_check",
      sql`${table.outcome} IS NULL OR ${table.outcome} IN ('success', 'error', 'timeout')`,
    ),
  ],
);

export const doclingBenchmarkProfilingStages = benchmarkSchema.table(
  "profiling_stages",
  {
    benchmarkResultId: uuid("benchmark_result_id")
      .notNull()
      .references(() => doclingBenchmarkResults.id, { onDelete: "cascade" }),
    count: integer("count").notNull(),
    id: uuid("id").primaryKey(),
    maximumDurationMs: doublePrecision("maximum_duration_ms").notNull(),
    medianDurationMs: doublePrecision("median_duration_ms").notNull(),
    minimumDurationMs: doublePrecision("minimum_duration_ms").notNull(),
    p95DurationMs: doublePrecision("p95_duration_ms").notNull(),
    scope: varchar("scope", { length: 16 }).notNull(),
    stage: varchar("stage", { length: 200 }).notNull(),
    totalDurationMs: doublePrecision("total_duration_ms").notNull(),
  },
  (table) => [
    index("profiling_stages_result_idx").on(table.benchmarkResultId),
  ],
);
