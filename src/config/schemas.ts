import { z } from "zod";

import { providerIdSchema } from "../providers/profiles.js";
import { embeddingDimensionsSchema } from "../embedding/dimensions.js";
import { RETRIEVAL_MODES } from "../retrieval/mode.js";

import type {
  DatabaseConfig,
  RuntimeSettings,
} from "./types.js";

const httpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "must use http or https");
const runtimeNameSchema = z.string().trim().min(1).max(100);
const databaseEnvironmentSchema = z.object({
  DATABASE_URL: z.url().refine(isPostgresUrl, "must use postgres or postgresql"),
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
  .max(15)
  .superRefine((services, context) => {
    const identifiers = new Set<string>();
    const baseUrls = new Set<string>();
    for (let index = 0; index < services.length; index += 1) {
      const service = services[index];
      if (service === undefined) {
        continue;
      }
      const baseUrl = removeTrailingSlash(service.baseUrl);
      if (identifiers.has(service.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate service ID ${service.id}`,
          path: [index, "id"],
        });
      }
      if (baseUrls.has(baseUrl)) {
        context.addIssue({
          code: "custom",
          message: `duplicate service base URL ${baseUrl}`,
          path: [index, "baseUrl"],
        });
      }
      identifiers.add(service.id);
      baseUrls.add(baseUrl);
    }
  })
  .transform((services) => {
    return services.map((service) => ({
      ...service,
      baseUrl: removeTrailingSlash(service.baseUrl),
    }));
  });
export const BOOTSTRAP_DATABASE_POOL_MAX = 1;

export const runtimeSettingsObjectSchema = z.object({
  applicationErrorMaximumRows: z.number().int().min(1).max(10_000_000),
  applicationErrorRetentionDays: z.number().int().min(1).max(3_650),
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
  doclingAdditionalServiceInstances: additionalDoclingServicesSchema,
  doclingBaseUrl: httpUrlSchema,
  doclingMaxTimeoutSeconds: z.number().int().min(60).max(604_800),
  doclingMegabyteTimeoutSeconds: z.number().int().min(0).max(3_600),
  doclingNumThreads: z.number().int().min(1).max(1_024),
  doclingOcrEnabled: z.boolean(),
  doclingPageTimeoutSeconds: z.number().int().min(0).max(3_600),
  doclingPdfBackend: z.enum([
    "docling_parse",
    "threaded_docling_parse",
    "pypdfium2",
  ]),
  doclingPerformanceMetricsEnabled: z.boolean(),
  doclingPerformanceMetricsRetentionDays: z.number().int().min(1).max(3_650),
  doclingPipeline: z.enum(["standard", "vlm"]),
  doclingPageBatchSize: z.number().int().min(1).max(1_024),
  doclingProfilePipelineTimings: z.boolean(),
  doclingQueueMaxSize: z.number().int().min(1).max(10_000),
  doclingSecondaryImageScale: z.number().min(0.1).max(8),
  doclingServeEngineWorkers: z.number().int().min(1).max(64),
  doclingServeShareModels: z.boolean(),
  doclingTableMode: z.enum(["accurate", "fast"]),
  doclingTableStructureEnabled: z.boolean(),
  doclingTocEnabled: z.boolean(),
  doclingDefaultServiceCapacity: z.number().int().min(1).max(16),
  doclingRequestTimeoutSeconds: z.number().int().min(10).max(3_600),
  doclingTimeoutSeconds: z.number().int().min(60).max(604_800),
  doclingVlmMaxOutputTokens: z.number().int().min(1).max(262_144),
  doclingVlmModelOverride: z.string().trim().min(1).max(300).nullable(),
  doclingVlmPrompt: z.string().trim().min(1).max(2_000),
  doclingVlmProviderId: providerIdSchema,
  embeddingDimensions: embeddingDimensionsSchema,
  embeddingInputFormatId: z.uuid(),
  embeddingSpaceId: z.string().trim().min(1).max(200).nullable(),
  embeddingTimeoutSeconds: z.number().int().min(1).max(86_400),
  expansionDecay: z.number().positive().max(1),
  expansionQueryWeight: z.number().positive().max(100),
  findSourcesPassagesPerDocument: z.number().int().min(1),
  findSourcesResults: z.number().int().min(1),
  databasePoolMax: z.number().int().min(1).max(100),
  hhemMaxAttentionCells: z.number().int().min(1).max(100_000_000),
  hhemMaxPaddedTokens: z.number().int().min(1).max(1_000_000),
  hhemModelBatchSize: z.number().int().min(1).max(64),
  hhemTorchThreads: z.number().int().min(1).max(256),
  lexicalWeight: z.number().positive().max(100),
  maxAttempts: z.number().int().min(1).max(20),
  maxDocumentMegabytes: z.number().int().min(1).max(100),
  maxUploadRequestMegabytes: z.number().int().min(1).max(100),
  mcpTaskRetentionDays: z.number().int().min(1).max(3_650),
  originalQueryWeight: z.number().positive().max(100),
  queryExpansions: z.number().int().min(0).max(4),
  queryExpansionTemperature: z.number().min(0).max(2),
  answerTemperature: z.number().min(0).max(2),
  chatTemperature: z.number().min(0).max(2),
  rerankDiscoveryMinimumScore: z.number().min(-1_000).max(1_000),
  rerankTimeoutSeconds: z.number().int().min(1).max(3_600),
  retrievalCandidates: z.number().int().min(1),
  retrievalChunkTargetTokens: z.number().int().positive(),
  retrievalWindowPolicy: z.literal("structured-token-v3"),
  retryBaseMs: z.number().int().min(100).max(3_600_000),
  rrfK: z.number().int().min(1).max(1_000),
  publicOrigin: httpUrlSchema,
  searchMethod: z.enum(RETRIEVAL_MODES),
  secureSessionCookie: z.boolean(),
  queryExpansionTimeoutSeconds: z.number().int().min(1).max(3_600),
  indexingTimeoutSeconds: z.number().int().min(1).max(86_400),
  sttLanguage: z.string().trim().min(1).max(100).nullable(),
  sttMaxAudioMegabytes: z.number().int().min(1).max(25),
  sttPrompt: z.string().trim().max(2_000).nullable(),
  sttTimeoutSeconds: z.number().int().min(1).max(300),
  topK: z.number().int().min(1),
  ttsPreloadEnabled: z.boolean(),
  ttsSpeed: z.number().min(0.25).max(5),
  ttsTimeoutSeconds: z.number().int().min(1).max(300),
  trustProxy: z.boolean(),
  workerConcurrency: z.number().int().min(1).max(16),
  workerFallbackPollMs: z.number().int().min(1_000).max(300_000),
}).strict();

export const runtimeSettingsSchema = runtimeSettingsObjectSchema.superRefine(
  (settings, context) => {
    if (settings.retrievalCandidates < settings.topK) {
      context.addIssue({
        code: "custom",
        message: "Matching sections reviewed must be equal to or greater than Sections available for answers",
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
  },
);

export function readDatabaseEnvironment(
  environment: NodeJS.ProcessEnv,
): DatabaseConfig {
  const result = databaseEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const details = result.error.issues.map(formatConfigIssue).join("\n");
    throw new Error(`Invalid database configuration:\n${details}`);
  }
  return {
    poolMax: BOOTSTRAP_DATABASE_POOL_MAX,
    url: result.data.DATABASE_URL,
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

function removeTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function isPostgresUrl(value: string): boolean {
  const protocol = new URL(value).protocol;
  return protocol === "postgres:" || protocol === "postgresql:";
}
