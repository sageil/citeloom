import { z } from "zod";

import type {
  ApplicationErrorRetentionConfig,
  DatabaseConfig,
  DoclingProcessConfiguration,
  DoclingServiceTopology,
  RuntimeSettings,
} from "./types.js";

const httpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "must use http or https");
const runtimeNameSchema = z.string().trim().min(1).max(100);
const databaseEnvironmentSchema = z.object({
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100),
  DATABASE_URL: z.url().refine(isPostgresUrl, "must use postgres or postgresql"),
});
const doclingProcessEnvironmentSchema = z.object({
  DOCLING_DEBUG_PROFILE_PIPELINE_TIMINGS: z.enum(["true", "false"]),
  DOCLING_NUM_THREADS: z.coerce.number().int().positive().max(1_024),
  DOCLING_PERF_PAGE_BATCH_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .max(1_024),
});
const doclingServiceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "must start with an alphanumeric character and contain only letters, numbers, dots, underscores, colons, or hyphens",
  );
const additionalDoclingServiceSchema = z.object({
  baseUrl: httpUrlSchema,
  capacity: z.number().int().min(1).max(16),
  id: doclingServiceIdSchema.refine(
    (value) => value !== "default",
    'must not use the reserved service ID "default"',
  ),
}).strict();
const additionalDoclingServicesSchema = z
  .array(additionalDoclingServiceSchema)
  .max(15);
const applicationErrorRetentionEnvironmentSchema = z.object({
  CITELOOM_APPLICATION_ERROR_MAXIMUM_ROWS: z.coerce
    .number()
    .int()
    .min(1)
    .max(10_000_000)
    .default(100_000),
  CITELOOM_APPLICATION_ERROR_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(1)
    .max(3_650)
    .default(30),
});

export const runtimeSettingsSchema = z.object({
  answerMaximumOutputTokens: z.number().int().min(1),
  answerMinimumOutputTokens: z.number().int().min(1),
  answerProviderSafetyMarginTokens: z.number().int().min(0),
  aiMetricsEnabled: z.boolean(),
  answerTimeoutSeconds: z.number().int().min(1).max(3_600),
  backgroundProgressIntervalMs: z.number().int().min(100).max(3_600_000),
  claimVerifierBaseUrl: httpUrlSchema,
  claimVerifierRuntimeName: runtimeNameSchema,
  claimVerifierSupportThreshold: z.number().min(0).max(1),
  claimVerifierTimeoutSeconds: z.number().int().min(1).max(3_600),
  denseWeight: z.number().positive().max(100),
  doclingApiKey: z.string().trim().min(1).nullable(),
  doclingBaseUrl: httpUrlSchema,
  doclingMaxTimeoutSeconds: z.number().int().min(60).max(604_800),
  doclingMegabyteTimeoutSeconds: z.number().int().min(0).max(3_600),
  doclingOcrEnabled: z.boolean(),
  doclingPageTimeoutSeconds: z.number().int().min(0).max(3_600),
  doclingPdfBackend: z.enum([
    "docling_parse",
    "threaded_docling_parse",
    "pypdfium2",
  ]),
  doclingPerformanceMetricsEnabled: z.boolean(),
  doclingPerformanceMetricsRetentionDays: z.number().int().min(1).max(3_650),
  doclingSecondaryImageScale: z.number().min(0.1).max(8),
  doclingTableMode: z.enum(["accurate", "fast"]),
  doclingTableStructureEnabled: z.boolean(),
  doclingTocEnabled: z.boolean(),
  doclingDefaultServiceCapacity: z.number().int().min(1).max(16),
  doclingRequestTimeoutSeconds: z.number().int().min(10).max(3_600),
  doclingTimeoutSeconds: z.number().int().min(60).max(604_800),
  embeddingDimensions: z.union([z.literal(384), z.literal(768), z.literal(1024)]),
  embeddingInputFormatId: z.uuid(),
  embeddingSpaceId: z.string().trim().min(1).max(200).nullable(),
  embeddingTimeoutSeconds: z.number().int().min(1).max(86_400),
  expansionDecay: z.number().positive().max(1),
  expansionQueryWeight: z.number().positive().max(100),
  findSourcesPassagesPerDocument: z.number().int().min(1),
  findSourcesResults: z.number().int().min(1),
  lexicalWeight: z.number().positive().max(100),
  maxAttempts: z.number().int().min(1).max(20),
  maxDocumentMegabytes: z.number().int().min(1).max(100),
  originalQueryWeight: z.number().positive().max(100),
  queryExpansions: z.number().int().min(0).max(4),
  queryExpansionTemperature: z.number().min(0).max(2),
  answerTemperature: z.number().min(0).max(2),
  generationSeedMode: z.enum(["random", "stable"]),
  rerankDiscoveryMinimumScore: z.number().min(-1_000).max(1_000),
  rerankTimeoutSeconds: z.number().int().min(1).max(3_600),
  retrievalCandidates: z.number().int().min(1),
  retrievalChunkTargetTokens: z.number().int().positive(),
  retrievalVariantConcurrency: z.number().int().min(1).max(16),
  retrievalWindowPolicy: z.literal("structured-token-v3"),
  retryBaseMs: z.number().int().min(100).max(3_600_000),
  rrfK: z.number().int().min(1).max(1_000),
  queryExpansionTimeoutSeconds: z.number().int().min(1).max(3_600),
  summaryTimeoutSeconds: z.number().int().min(1).max(86_400),
  sttLanguage: z.string().trim().min(1).max(100).nullable(),
  sttMaxAudioMegabytes: z.number().int().min(1).max(25),
  sttPrompt: z.string().trim().max(2_000).nullable(),
  sttTimeoutSeconds: z.number().int().min(1).max(300),
  topK: z.number().int().min(1),
  ttsPreloadEnabled: z.boolean(),
  ttsSpeed: z.number().min(0.25).max(5),
  ttsTimeoutSeconds: z.number().int().min(1).max(300),
  workerConcurrency: z.number().int().min(1).max(16),
  workerFallbackPollMs: z.number().int().min(1_000).max(300_000),
}).strict().superRefine((settings, context) => {
  if (settings.answerMaximumOutputTokens < settings.answerMinimumOutputTokens) {
    context.addIssue({
      code: "custom",
      message: "must be greater than or equal to answerMinimumOutputTokens",
      path: ["answerMaximumOutputTokens"],
    });
  }
  if (settings.retrievalCandidates < settings.topK) {
    context.addIssue({
      code: "custom",
      message: "Document sections searched must be greater than or equal to Sections used in answers",
      path: ["retrievalCandidates"],
    });
  }
  if (settings.doclingTimeoutSeconds > settings.doclingMaxTimeoutSeconds) {
    context.addIssue({
      code: "custom",
      message: "must be greater than or equal to doclingTimeoutSeconds",
      path: ["doclingMaxTimeoutSeconds"],
    });
  }
});

export function readDatabaseEnvironment(
  environment: NodeJS.ProcessEnv,
): DatabaseConfig {
  const result = databaseEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const details = result.error.issues.map(formatConfigIssue).join("\n");
    throw new Error(`Invalid database configuration:\n${details}`);
  }
  return {
    poolMax: result.data.DATABASE_POOL_MAX,
    url: result.data.DATABASE_URL,
  };
}

export function readApplicationErrorRetentionConfig(
  environment: NodeJS.ProcessEnv,
): ApplicationErrorRetentionConfig {
  const result = applicationErrorRetentionEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const details = result.error.issues.map(formatConfigIssue).join("\n");
    throw new Error(`Invalid application error retention configuration:\n${details}`);
  }
  return {
    maximumRows: result.data.CITELOOM_APPLICATION_ERROR_MAXIMUM_ROWS,
    retentionDays: result.data.CITELOOM_APPLICATION_ERROR_RETENTION_DAYS,
  };
}

export function readDoclingProcessConfiguration(
  environment: NodeJS.ProcessEnv,
): DoclingProcessConfiguration {
  const result = doclingProcessEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const details = result.error.issues.map(formatConfigIssue).join("\n");
    throw new Error(`Invalid Docling process configuration:\n${details}`);
  }
  return {
    numThreads: result.data.DOCLING_NUM_THREADS,
    pageBatchSize: result.data.DOCLING_PERF_PAGE_BATCH_SIZE,
    profilePipelineTimings:
      result.data.DOCLING_DEBUG_PROFILE_PIPELINE_TIMINGS === "true",
  };
}

export function readDoclingServiceTopology(
  environment: NodeJS.ProcessEnv,
): DoclingServiceTopology {
  const additionalServices = parseAdditionalDoclingServices(
    environment.DOCLING_ADDITIONAL_SERVICE_INSTANCES,
  );
  validateDoclingServiceUniqueness(additionalServices);
  return {
    additionalServices,
    process: readDoclingProcessConfiguration(environment),
  };
}

export function parseRuntimeSettings(value: unknown): RuntimeSettings {
  const result = runtimeSettingsSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map(formatConfigIssue).join("\n");
    throw new Error(`Invalid application settings:\n${details}`);
  }
  return result.data;
}

function formatConfigIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length === 0 ? "environment" : issue.path.join(".");
  return `- ${path}: ${issue.message}`;
}

function parseAdditionalDoclingServices(
  value: string | undefined,
): DoclingServiceTopology["additionalServices"] {
  if (value === undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid Docling service configuration:\n- DOCLING_ADDITIONAL_SERVICE_INSTANCES must be valid JSON: ${message}`,
    );
  }
  const result = additionalDoclingServicesSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues.map(formatConfigIssue).join("\n");
    throw new Error(`Invalid Docling service configuration:\n${details}`);
  }
  return result.data;
}

function validateDoclingServiceUniqueness(
  services: DoclingServiceTopology["additionalServices"],
): void {
  const identifiers = new Set<string>();
  const baseUrls = new Set<string>();
  for (const service of services) {
    const baseUrl = removeTrailingSlash(service.baseUrl);
    if (identifiers.has(service.id)) {
      throw new Error(
        `Invalid Docling service configuration:\n- duplicate service ID ${service.id}.`,
      );
    }
    if (baseUrls.has(baseUrl)) {
      throw new Error(
        `Invalid Docling service configuration:\n- duplicate service base URL ${baseUrl}.`,
      );
    }
    service.baseUrl = baseUrl;
    identifiers.add(service.id);
    baseUrls.add(baseUrl);
  }
}

function removeTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isPostgresUrl(value: string): boolean {
  const protocol = new URL(value).protocol;
  return protocol === "postgres:" || protocol === "postgresql:";
}
