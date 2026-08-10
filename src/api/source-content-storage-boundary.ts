import { z } from "zod";

import type { SourceContentConfig } from "../config/index.js";
import { parseSourceContentConfig } from "../providers/settings-persistence.js";
import { WebRequestError } from "./request-boundary.js";

const sourceContentStorageProbeSchema = z.object({
  target: z.unknown(),
}).strict();

const sourceContentMigrationRequestSchema = z.object({
  expectedSettingsVersion: z.number().int().positive(),
  target: z.unknown(),
}).strict();

const sourceContentMigrationIdSchema = z.object({
  id: z.uuid(),
}).strict();

export interface SourceContentMigrationRequest {
  expectedSettingsVersion: number;
  targetConfig: SourceContentConfig;
}

export function decodeSourceContentStorageProbe(
  value: unknown,
): SourceContentConfig {
  const decoded = sourceContentStorageProbeSchema.safeParse(value);
  if (!decoded.success) {
    throw new WebRequestError(400, "The storage connection test is invalid.");
  }
  return decodeTargetConfig(decoded.data.target);
}

export function decodeSourceContentMigrationRequest(
  value: unknown,
): SourceContentMigrationRequest {
  const decoded = sourceContentMigrationRequestSchema.safeParse(value);
  if (!decoded.success) {
    throw new WebRequestError(400, "The storage migration request is invalid.");
  }
  return {
    expectedSettingsVersion: decoded.data.expectedSettingsVersion,
    targetConfig: decodeTargetConfig(decoded.data.target),
  };
}

export function decodeSourceContentMigrationId(value: unknown): string {
  const decoded = sourceContentMigrationIdSchema.safeParse(value);
  if (!decoded.success) {
    throw new WebRequestError(400, "A valid storage migration ID is required.");
  }
  return decoded.data.id;
}

function decodeTargetConfig(value: unknown): SourceContentConfig {
  try {
    return parseSourceContentConfig(value);
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : "The storage configuration is invalid.";
    throw new WebRequestError(400, message);
  }
}
