import { z } from "zod";

import {
  doclingRequestConfigurationSchema,
  doclingServiceIdentitySchema,
  type DoclingRequestConfiguration,
  type DoclingServiceIdentity,
} from "../../src/docling/protocol/run-metadata.js";
import { DOCLING_OCR_PRESET } from "../../src/docling/protocol/model.js";

export interface DoclingQualityComparison {
  differences: DoclingQualityDifference[];
  passed: boolean;
}

export interface DoclingQualityDifference {
  actual: string;
  expected: string;
  path: string;
}

export const doclingBenchmarkProcessConfigurationSchema = z.object({
  batchPollingIntervalSeconds: z.number().positive().max(60),
  layoutBatchSize: z.number().int().positive().max(1_024),
  loadModelsAtBoot: z.boolean(),
  localModelsShared: z.boolean(),
  localWorkerCount: z.number().int().positive().max(64),
  numThreads: z.number().int().positive().max(1_024),
  ocrBatchSize: z.number().int().positive().max(1_024),
  optionsCacheSize: z.number().int().positive().max(64),
  profilePipelineTimings: z.boolean(),
  queueMaxSize: z.number().int().positive().max(10_000),
  resultRemovalDelaySeconds: z.number().int().nonnegative().max(86_400),
  singleUseResults: z.boolean(),
  tableBatchSize: z.number().int().positive().max(1_024),
}).strict();

export type DoclingBenchmarkProcessConfiguration = z.infer<
  typeof doclingBenchmarkProcessConfigurationSchema
>;

export interface DoclingBenchmarkEnvironment {
  baseUrl: string;
  baseline: DoclingBenchmarkBaselineConfiguration;
  capabilitiesFingerprint: string;
  composeProject: string;
  corpusFingerprint: string;
  cpuCount: number;
  imageReference: string;
  ocrPreset: typeof DOCLING_OCR_PRESET;
  process: DoclingBenchmarkProcessConfiguration;
  service: DoclingServiceIdentity;
}

export interface DoclingBenchmarkBaselineConfiguration {
  baseTimeoutMs: number;
  maxTimeoutMs: number;
  megabyteTimeoutMs: number;
  pageTimeoutMs: number;
  requestTimeoutMs: number;
  settingsVersion: number;
}

export interface DoclingBenchmarkCandidate {
  id: string;
  phase: "backend-screen" | "finalist" | "quality-tradeoff" | "thread-matrix";
  process: DoclingBenchmarkProcessConfiguration;
  request: DoclingRequestConfiguration;
  secondaryImageScale: number;
}

export interface DoclingPromotionAssessment {
  baselineCandidateId: string;
  baselineMedianWallMs: number | null;
  baselineP95WallMs: number | null;
  candidateMedianWallMs: number | null;
  candidateP95WallMs: number | null;
  eligible: boolean;
  evaluatedDocumentCount: number;
  expectedDocumentCount: number;
  latencyP95Regression: number | null;
  memoryRegression: number | null;
  performanceImprovement: number | null;
  promotionCandidateId: string;
  reasons: string[];
}

const benchmarkCandidateSchema = z.object({
  id: z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9:._-]*$/),
  phase: z.enum([
    "backend-screen",
    "finalist",
    "quality-tradeoff",
    "thread-matrix",
  ]),
  process: doclingBenchmarkProcessConfigurationSchema,
  request: doclingRequestConfigurationSchema,
  secondaryImageScale: z.number().min(0.1).max(8),
}).strict();
const benchmarkEnvironmentSchema = z.object({
  baseUrl: z.url().refine(isHttpUrl, "must use http or https"),
  baseline: z.object({
    baseTimeoutMs: z.number().int().min(60_000).max(604_800_000),
    maxTimeoutMs: z.number().int().min(60_000).max(604_800_000),
    megabyteTimeoutMs: z.number().int().min(0).max(3_600_000),
    pageTimeoutMs: z.number().int().min(0).max(3_600_000),
    requestTimeoutMs: z.number().int().min(10_000).max(3_600_000),
    settingsVersion: z.number().int().nonnegative(),
  }).strict(),
  capabilitiesFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  composeProject: z.string().min(1).max(100),
  corpusFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  cpuCount: z.number().int().positive().max(1_024),
  imageReference: z.string().min(1).max(500),
  ocrPreset: z.literal(DOCLING_OCR_PRESET),
  process: doclingBenchmarkProcessConfigurationSchema,
  service: doclingServiceIdentitySchema,
}).strict();

export function decodeDoclingBenchmarkCandidate(
  value: unknown,
): DoclingBenchmarkCandidate {
  const result = benchmarkCandidateSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid Docling benchmark candidate: ${result.error.message}`);
  }
  return result.data;
}

export function decodeDoclingBenchmarkEnvironment(
  value: unknown,
): DoclingBenchmarkEnvironment {
  const result = benchmarkEnvironmentSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid Docling benchmark environment: ${result.error.message}`);
  }
  if (result.data.baseline.baseTimeoutMs > result.data.baseline.maxTimeoutMs) {
    throw new Error(
      "Invalid Docling benchmark environment: baseline timeout exceeds its hard deadline.",
    );
  }
  return result.data;
}

export function decodeDoclingBenchmarkProcessConfiguration(
  value: unknown,
): DoclingBenchmarkProcessConfiguration {
  const result = doclingBenchmarkProcessConfigurationSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid Docling benchmark process configuration: ${result.error.message}`,
    );
  }
  return result.data;
}

function isHttpUrl(value: string): boolean {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}
