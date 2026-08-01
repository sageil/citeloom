import { createHash } from "node:crypto";

import { z } from "zod";

import type {
  DoclingConfig,
  DoclingPdfBackend,
  DoclingProcessConfiguration,
  DoclingTableMode,
} from "../../config/index.js";
import type { DoclingVersionIdentity } from "./index.js";
import {
  DOCLING_SERVE_VERSION,
  DOCLING_VERSION,
} from "./model.js";

export type DoclingTerminalOutcome =
  | "abort"
  | "error"
  | "success"
  | "timeout";

export type DoclingRequestOutcome =
  | "abort"
  | "service-error"
  | "success"
  | "timeout"
  | "transport-error";

export interface DoclingAttemptConfigSnapshot {
  baseTimeoutMs: number;
  baseUrl: string;
  maxTimeoutMs: number;
  megabyteTimeoutMs: number;
  ocrEnabled: boolean;
  pageTimeoutMs: number;
  pdfBackend: DoclingPdfBackend;
  performanceMetricsEnabled: boolean;
  performanceMetricsRetentionDays: number;
  requestTimeoutMs: number;
  secondaryImageScale: number;
  settingsVersion: number;
  tableMode: DoclingTableMode;
  tableStructureEnabled: boolean;
}

export type { DoclingProcessConfiguration } from "../../config/index.js";

export interface DoclingEffectiveRequestOptions {
  doOcr: boolean;
  doTableStructure: boolean;
  imageExportMode: "embedded" | "placeholder";
  imagesScale: number;
  includeImages: boolean;
  includePageImages: boolean;
  pdfBackend: DoclingPdfBackend | null;
  tableMode: DoclingTableMode | null;
}

export interface DoclingRequestConfiguration {
  doOcr: boolean;
  doTableStructure: boolean;
  imageExportMode: "embedded" | "placeholder";
  imagesScale: number;
  includeImages: boolean;
  includePageImages: boolean;
  pdfBackend: DoclingPdfBackend;
  tableMode: DoclingTableMode | null;
}

export interface DoclingProfilingSummary {
  count: number;
  maximumDurationMs: number;
  medianDurationMs: number;
  minimumDurationMs: number;
  p95DurationMs: number;
  scope: "document" | "page";
  stage: string;
  totalDurationMs: number;
}

export interface DoclingServiceIdentity extends DoclingVersionIdentity {}

const attemptConfigSchema = z.object({
  baseTimeoutMs: z.number().int().min(60_000).max(604_800_000),
  baseUrl: z.url().refine(isHttpUrl, "must use http or https"),
  maxTimeoutMs: z.number().int().min(60_000).max(604_800_000),
  megabyteTimeoutMs: z.number().int().min(0).max(3_600_000),
  ocrEnabled: z.boolean(),
  pageTimeoutMs: z.number().int().min(0).max(3_600_000),
  pdfBackend: z.enum([
    "docling_parse",
    "threaded_docling_parse",
    "pypdfium2",
  ]),
  performanceMetricsEnabled: z.boolean(),
  performanceMetricsRetentionDays: z.number().int().min(1).max(3_650),
  requestTimeoutMs: z.number().int().min(10_000).max(3_600_000),
  secondaryImageScale: z.number().min(0.1).max(8),
  settingsVersion: z.number().int().nonnegative(),
  tableMode: z.enum(["accurate", "fast"]),
  tableStructureEnabled: z.boolean(),
}).strict();

export const doclingProcessConfigurationSchema = z.object({
  numThreads: z.number().int().positive().max(1_024),
  pageBatchSize: z.number().int().positive().max(1_024),
  profilePipelineTimings: z.boolean(),
}).strict();
const effectiveRequestOptionsSchema = z.object({
  doOcr: z.boolean(),
  doTableStructure: z.boolean(),
  imageExportMode: z.enum(["embedded", "placeholder"]),
  imagesScale: z.number().min(0.1).max(8),
  includeImages: z.boolean(),
  includePageImages: z.boolean(),
  pdfBackend: z.enum([
    "docling_parse",
    "threaded_docling_parse",
    "pypdfium2",
  ]).nullable(),
  tableMode: z.enum(["accurate", "fast"]).nullable(),
}).strict();
export const doclingRequestConfigurationSchema = effectiveRequestOptionsSchema.extend({
  pdfBackend: z.enum([
    "docling_parse",
    "threaded_docling_parse",
    "pypdfium2",
  ]),
}).strict();
export const doclingServiceIdentitySchema = z.object({
  coreVersion: z.string().min(1),
  jobkitVersion: z.string().min(1),
  modelsVersion: z.string().min(1),
  parseVersion: z.string().min(1),
  serveVersion: z.literal(DOCLING_SERVE_VERSION),
  version: z.literal(DOCLING_VERSION),
}).strict();

export function createDoclingAttemptConfigSnapshot(
  config: DoclingConfig,
  settingsVersion: number,
): DoclingAttemptConfigSnapshot {
  return decodeDoclingAttemptConfigSnapshot({
    baseTimeoutMs: config.baseTimeoutMs,
    baseUrl: config.baseUrl,
    maxTimeoutMs: config.maxTimeoutMs,
    megabyteTimeoutMs: config.megabyteTimeoutMs,
    ocrEnabled: config.ocrEnabled,
    pageTimeoutMs: config.pageTimeoutMs,
    pdfBackend: config.pdfBackend,
    performanceMetricsEnabled: config.performanceMetricsEnabled,
    performanceMetricsRetentionDays: config.performanceMetricsRetentionDays,
    requestTimeoutMs: config.requestTimeoutMs,
    secondaryImageScale: config.secondaryImageScale,
    settingsVersion,
    tableMode: config.tableMode,
    tableStructureEnabled: config.tableStructureEnabled,
  });
}

export function decodeDoclingAttemptConfigSnapshot(
  value: unknown,
): DoclingAttemptConfigSnapshot {
  const result = attemptConfigSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid Docling attempt configuration: ${result.error.message}`);
  }
  if (result.data.baseTimeoutMs > result.data.maxTimeoutMs) {
    throw new Error(
      "Invalid Docling attempt configuration: base timeout exceeds hard deadline.",
    );
  }
  return result.data;
}

export function restoreDoclingConfig(
  snapshot: DoclingAttemptConfigSnapshot,
  apiKey: string | null,
): DoclingConfig {
  const normalized = decodeDoclingAttemptConfigSnapshot(snapshot);
  return {
    apiKey,
    baseTimeoutMs: normalized.baseTimeoutMs,
    baseUrl: normalized.baseUrl,
    maxTimeoutMs: normalized.maxTimeoutMs,
    megabyteTimeoutMs: normalized.megabyteTimeoutMs,
    ocrEnabled: normalized.ocrEnabled,
    pageTimeoutMs: normalized.pageTimeoutMs,
    pdfBackend: normalized.pdfBackend,
    performanceMetricsEnabled: normalized.performanceMetricsEnabled,
    performanceMetricsRetentionDays:
      normalized.performanceMetricsRetentionDays,
    requestTimeoutMs: normalized.requestTimeoutMs,
    secondaryImageScale: normalized.secondaryImageScale,
    tableMode: normalized.tableMode,
    tableStructureEnabled: normalized.tableStructureEnabled,
    tocEnabled: false,
  };
}

export function fingerprintDoclingConfiguration(
  snapshot: DoclingAttemptConfigSnapshot,
  process: DoclingProcessConfiguration,
): string {
  const normalizedSnapshot = decodeDoclingAttemptConfigSnapshot(snapshot);
  const normalizedProcess = decodeDoclingProcessConfiguration(process);
  const serialized = JSON.stringify({
    attempt: normalizedSnapshot,
    process: normalizedProcess,
  });
  return createHash("sha256").update(serialized).digest("hex");
}

export function decodeDoclingProcessConfiguration(
  value: unknown,
): DoclingProcessConfiguration {
  const result = doclingProcessConfigurationSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid Docling process configuration: ${result.error.message}`);
  }
  return result.data;
}

export function decodeDoclingServiceIdentity(
  value: unknown,
): DoclingServiceIdentity {
  const result = doclingServiceIdentitySchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid Docling service identity: ${result.error.message}`);
  }
  return result.data;
}

export function decodeDoclingEffectiveRequestOptions(
  value: unknown,
): DoclingEffectiveRequestOptions {
  const result = effectiveRequestOptionsSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid effective Docling request options: ${result.error.message}`);
  }
  return result.data;
}

export function decodeDoclingRequestConfiguration(
  value: unknown,
): DoclingRequestConfiguration {
  const result = doclingRequestConfigurationSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid Docling request configuration: ${result.error.message}`);
  }
  return result.data;
}

function isHttpUrl(value: string): boolean {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}
