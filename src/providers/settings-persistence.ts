import { isAbsolute } from "node:path";

import { z } from "zod";

import { runtimeSettingsSchema } from "../config/schemas.js";
import type {
  RuntimeSettings,
  SourceContentConfig,
} from "../config/types.js";
import {
  parseProviderSettings,
  type ProviderSettings,
} from "./profiles.js";

export interface StoredApplicationSettings {
  providers: ProviderSettings;
  runtime: RuntimeSettings;
  schemaVersion: 1;
  sourceContent: SourceContentConfig;
}

const filesystemSourceContentConfigSchema = z.object({
  directory: z.string()
    .trim()
    .min(1)
    .refine(isAbsolute, "Source content directory must be absolute."),
  kind: z.literal("filesystem"),
}).strict();

const legacyFilesystemSourceContentConfigSchema = z.object({
  directory: z.string()
    .trim()
    .min(1)
    .refine(isAbsolute, "Source content directory must be absolute."),
}).strict().transform((value) => {
  return {
    directory: value.directory,
    kind: "filesystem" as const,
  };
});

const s3SourceContentCredentialsSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("environment") }).strict(),
  z.object({
    accessKeyId: z.string().trim().min(1).max(256),
    kind: z.literal("static"),
    secretAccessKey: z.string().min(1).max(4_096),
  }).strict(),
]);

const s3SourceContentConfigSchema = z.object({
  bucket: z.string().trim().min(1).max(63),
  credentials: s3SourceContentCredentialsSchema.default({
    kind: "environment",
  }),
  endpointUrl: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  }, "S3 endpoint must use http or https."),
  forcePathStyle: z.boolean(),
  kind: z.literal("s3"),
  prefix: z.string().trim().transform((value) => {
    return value.replace(/^\/+|\/+$/gu, "");
  }).pipe(z.string().min(1).max(512)),
  region: z.string().trim().min(1).max(100),
}).strict();

const sourceContentConfigSchema = z.union([
  filesystemSourceContentConfigSchema,
  legacyFilesystemSourceContentConfigSchema,
  s3SourceContentConfigSchema,
]);

const storedApplicationSettingsSchema = z.object({
  providers: z.unknown(),
  runtime: runtimeSettingsSchema,
  schemaVersion: z.literal(1),
  sourceContent: z.unknown(),
}).strict();

export function parseSourceContentConfig(value: unknown): SourceContentConfig {
  const result = sourceContentConfigSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid source-content configuration: ${result.error.message}`);
  }
  return result.data;
}

export function parseStoredApplicationSettings(
  value: unknown,
): StoredApplicationSettings {
  const result = storedApplicationSettingsSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid stored application settings: ${result.error.message}`);
  }
  return {
    providers: parseProviderSettings(result.data.providers),
    runtime: result.data.runtime,
    schemaVersion: 1,
    sourceContent: parseSourceContentConfig(result.data.sourceContent),
  };
}
