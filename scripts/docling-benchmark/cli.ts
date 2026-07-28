import { pathToFileURL } from "node:url";

import { z } from "zod";

import { ApplicationSettingsRepository } from "../../src/app/settings.js";
import {
  readDatabaseConfig,
  readStartupConfig,
} from "../../src/config/index.js";
import {
  readSourceContentBootstrapConfig,
} from "../../src/database/administrator-bootstrap.js";
import { openDatabase } from "../../src/database/client.js";
import {
  runDoclingCorpusBenchmark,
  type RunDoclingBenchmarkInput,
} from "./runner.js";
import type {
  DoclingBenchmarkProcessConfiguration,
} from "./model.js";
import { initializeDoclingBenchmarkSchema } from "./setup.js";

const argumentsSchema = z.object({
  includeQualityTradeoffs: z.boolean(),
  processOnly: z.boolean(),
  runId: z.uuid().optional(),
}).strict();
const benchmarkProcessEnvironmentSchema = z.object({
  DOCLING_NUM_THREADS: z.coerce.number().int().positive().max(1_024).default(4),
  DOCLING_SERVE_BATCH_POLLING_INTERVAL_SECONDS: z.coerce
    .number()
    .positive()
    .max(60)
    .default(0.5),
  DOCLING_SERVE_ENG_LOC_NUM_WORKERS: z.coerce
    .number()
    .int()
    .positive()
    .max(64)
    .default(1),
  DOCLING_SERVE_ENG_LOC_SHARE_MODELS: z.enum(["true", "false"]).default("true"),
  DOCLING_SERVE_LAYOUT_BATCH_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .max(1_024)
    .default(4),
  DOCLING_SERVE_LOAD_MODELS_AT_BOOT: z.enum(["true", "false"]).default("true"),
  DOCLING_SERVE_OCR_BATCH_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .max(1_024)
    .default(4),
  DOCLING_SERVE_OPTIONS_CACHE_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .max(64)
    .default(2),
  DOCLING_SERVE_QUEUE_MAX_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .max(10_000)
    .default(8),
  DOCLING_SERVE_RESULT_REMOVAL_DELAY: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(86_400)
    .default(300),
  DOCLING_SERVE_SINGLE_USE_RESULTS: z.enum(["true", "false"]).default("true"),
  DOCLING_SERVE_TABLE_BATCH_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .max(1_024)
    .default(4),
});

export async function main(arguments_: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseDoclingBenchmarkArguments(arguments_);
  const databaseConfig = readDatabaseConfig(process.env);
  const startup = readStartupConfig(process.env);
  const session = await openDatabase(databaseConfig);
  try {
    await initializeDoclingBenchmarkSchema(session.database);
    const settingsRepository = new ApplicationSettingsRepository(
      session.database,
    );
    const effectiveSettings = await settingsRepository.read(
      databaseConfig,
      startup.doclingTopology,
    );
    const declaredProcess =
      readDoclingBenchmarkProcessConfiguration(process.env);
    const sourceContent =
      readSourceContentBootstrapConfig(process.env);
    const input: RunDoclingBenchmarkInput = {
      baselineConfig: effectiveSettings.config.docling,
      baselineProcess: declaredProcess,
      baselineSettingsVersion: effectiveSettings.version,
      processOnly: options.processOnly,
      reportProgress: (message): void => {
        console.log(`[${new Date().toISOString()}] ${message}`);
      },
      resultDatabase: session.database,
      sourceContent,
      sourceDatabase: session.database,
    };
    if (options.runId !== undefined) {
      input.runId = options.runId;
    }
    if (options.includeQualityTradeoffs) {
      input.includeQualityTradeoffs = true;
    }
    const report = await runDoclingCorpusBenchmark(input);
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await session.close();
  }
}

export function readDoclingBenchmarkProcessConfiguration(
  environment: NodeJS.ProcessEnv,
): DoclingBenchmarkProcessConfiguration {
  const result = benchmarkProcessEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    throw new Error(
      `Invalid Docling benchmark process configuration: ${result.error.message}`,
    );
  }
  return {
    batchPollingIntervalSeconds:
      result.data.DOCLING_SERVE_BATCH_POLLING_INTERVAL_SECONDS,
    layoutBatchSize: result.data.DOCLING_SERVE_LAYOUT_BATCH_SIZE,
    loadModelsAtBoot:
      result.data.DOCLING_SERVE_LOAD_MODELS_AT_BOOT === "true",
    localModelsShared:
      result.data.DOCLING_SERVE_ENG_LOC_SHARE_MODELS === "true",
    localWorkerCount: result.data.DOCLING_SERVE_ENG_LOC_NUM_WORKERS,
    numThreads: result.data.DOCLING_NUM_THREADS,
    ocrBatchSize: result.data.DOCLING_SERVE_OCR_BATCH_SIZE,
    optionsCacheSize: result.data.DOCLING_SERVE_OPTIONS_CACHE_SIZE,
    profilePipelineTimings: true,
    queueMaxSize: result.data.DOCLING_SERVE_QUEUE_MAX_SIZE,
    resultRemovalDelaySeconds:
      result.data.DOCLING_SERVE_RESULT_REMOVAL_DELAY,
    singleUseResults:
      result.data.DOCLING_SERVE_SINGLE_USE_RESULTS === "true",
    tableBatchSize: result.data.DOCLING_SERVE_TABLE_BATCH_SIZE,
  };
}

export function parseDoclingBenchmarkArguments(
  arguments_: string[],
): z.output<typeof argumentsSchema> {
  let includeQualityTradeoffs = false;
  let processOnly = false;
  let runId: string | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--include-quality-tradeoffs") {
      if (includeQualityTradeoffs) {
        throw new Error("The quality-tradeoff flag was provided more than once.");
      }
      includeQualityTradeoffs = true;
      continue;
    }
    if (argument === "--process-only") {
      if (processOnly) {
        throw new Error("The process-only flag was provided more than once.");
      }
      processOnly = true;
      continue;
    }
    if (argument === "--resume") {
      if (runId !== undefined) {
        throw new Error("The benchmark resume ID was provided more than once.");
      }
      const value = arguments_[index + 1];
      if (value === undefined) {
        throw new Error("The benchmark resume ID is missing.");
      }
      runId = value;
      index += 1;
      continue;
    }
    throw new Error(
      "Usage: pnpm docling:benchmark [--resume <run-id>] [--include-quality-tradeoffs] [--process-only]",
    );
  }
  const input: {
    includeQualityTradeoffs: boolean;
    processOnly: boolean;
    runId?: string;
  } = {
    includeQualityTradeoffs,
    processOnly,
  };
  if (runId !== undefined) {
    input.runId = runId;
  }
  const result = argumentsSchema.safeParse(input);
  if (!result.success) {
    throw new Error("The Docling benchmark resume ID is invalid.");
  }
  return result.data;
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}
