import { isAbsolute } from "node:path";

import { z } from "zod";

import { runtimeSettingsSchema } from "../config/schemas.js";
import type {
  RuntimeSettings,
  SourceContentConfig,
} from "../config/types.js";
import {
  parseProviderSettings,
  providerSettingsSchema,
  type ProviderSettings,
} from "./profiles.js";

export interface StoredApplicationSettings {
  providers: ProviderSettings;
  runtime: RuntimeSettings;
  schemaVersion: 1;
  sourceContent: SourceContentConfig;
}

const sourceContentConfigSchema = z.object({
  directory: z.string()
    .trim()
    .min(1)
    .refine(isAbsolute, "Source content directory must be absolute."),
}).strict();

const storedApplicationSettingsSchema = z.object({
  providers: providerSettingsSchema,
  runtime: runtimeSettingsSchema,
  schemaVersion: z.literal(1),
  sourceContent: sourceContentConfigSchema,
}).strict();

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
    sourceContent: result.data.sourceContent,
  };
}
