import { sql } from "drizzle-orm";

import type { CiteLoomDatabase } from "../../src/database/client.js";

export async function initializeDoclingBenchmarkSchema(
  database: CiteLoomDatabase,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE SCHEMA IF NOT EXISTS citeloom_benchmark`);
    await transaction.execute(sql`
      CREATE TABLE IF NOT EXISTS citeloom_benchmark.runs (
        candidates jsonb NOT NULL,
        assessment jsonb,
        completed_at timestamp with time zone,
        corpus_document_count integer NOT NULL,
        environment jsonb NOT NULL,
        error_category varchar(64),
        id uuid PRIMARY KEY,
        order_seed integer NOT NULL,
        p95_latency_regression_limit double precision NOT NULL,
        peak_memory_regression_limit double precision NOT NULL,
        performance_threshold double precision NOT NULL,
        repetitions integer NOT NULL,
        started_at timestamp with time zone DEFAULT now() NOT NULL,
        status varchar(16) NOT NULL,
        CONSTRAINT runs_threshold_check
          CHECK (performance_threshold > 0 AND performance_threshold < 1),
        CONSTRAINT runs_p95_limit_check
          CHECK (p95_latency_regression_limit >= 0 AND p95_latency_regression_limit < 1),
        CONSTRAINT runs_memory_limit_check
          CHECK (peak_memory_regression_limit >= 0 AND peak_memory_regression_limit < 1),
        CONSTRAINT runs_repetitions_check CHECK (repetitions >= 3),
        CONSTRAINT runs_status_check
          CHECK (status IN ('running', 'completed', 'failed')),
        CONSTRAINT runs_completion_check
          CHECK (
            (status = 'running' AND completed_at IS NULL)
            OR
            (status IN ('completed', 'failed') AND completed_at IS NOT NULL)
          )
      )
    `);
    await transaction.execute(sql`
      CREATE TABLE IF NOT EXISTS citeloom_benchmark.results (
        candidate_id varchar(128) NOT NULL,
        completed_at timestamp with time zone,
        comparison jsonb,
        cpu_time_ms integer,
        document_id varchar(64) NOT NULL,
        error_category varchar(64),
        id uuid PRIMARY KEY,
        image_count integer,
        http_request_count integer,
        http_request_duration_ms double precision,
        outcome varchar(32),
        output_fingerprint varchar(64),
        page_count integer,
        pages_per_second double precision,
        peak_resident_bytes bigint,
        process_config jsonb NOT NULL,
        processing_ms integer,
        quality_passed boolean,
        repetition integer NOT NULL,
        request_config jsonb NOT NULL,
        result_retrieval_ms integer,
        run_id uuid NOT NULL
          REFERENCES citeloom_benchmark.runs(id) ON DELETE CASCADE,
        run_order integer NOT NULL,
        scheduler_wait_ms integer,
        started_at timestamp with time zone,
        table_count integer,
        task_wait_ms integer,
        text_count integer,
        total_element_count integer,
        total_wall_ms integer,
        upload_ms integer,
        CONSTRAINT results_repetition_check CHECK (repetition > 0),
        CONSTRAINT results_completion_check
          CHECK (
            (completed_at IS NULL AND outcome IS NULL)
            OR
            (completed_at IS NOT NULL AND outcome IS NOT NULL)
          ),
        CONSTRAINT results_outcome_check
          CHECK (outcome IS NULL OR outcome IN ('success', 'error', 'timeout'))
      )
    `);
    await transaction.execute(sql`
      CREATE TABLE IF NOT EXISTS citeloom_benchmark.profiling_stages (
        benchmark_result_id uuid NOT NULL
          REFERENCES citeloom_benchmark.results(id) ON DELETE CASCADE,
        count integer NOT NULL,
        id uuid PRIMARY KEY,
        maximum_duration_ms double precision NOT NULL,
        median_duration_ms double precision NOT NULL,
        minimum_duration_ms double precision NOT NULL,
        p95_duration_ms double precision NOT NULL,
        scope varchar(16) NOT NULL,
        stage varchar(200) NOT NULL,
        total_duration_ms double precision NOT NULL
      )
    `);
    await transaction.execute(sql`
      CREATE INDEX IF NOT EXISTS runs_started_at_idx
      ON citeloom_benchmark.runs (started_at)
    `);
    await transaction.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS results_identity_idx
      ON citeloom_benchmark.results (
        run_id,
        document_id,
        candidate_id,
        repetition
      )
    `);
    await transaction.execute(sql`
      CREATE INDEX IF NOT EXISTS results_candidate_idx
      ON citeloom_benchmark.results (run_id, candidate_id)
    `);
    await transaction.execute(sql`
      CREATE INDEX IF NOT EXISTS profiling_stages_result_idx
      ON citeloom_benchmark.profiling_stages (benchmark_result_id)
    `);
  });
}
