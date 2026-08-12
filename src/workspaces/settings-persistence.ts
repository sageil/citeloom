import { z } from "zod";

import {
  decodeRuntimeSettingKey,
  isWorkspaceRuntimeSetting,
} from "../app/settings.js";
import {
  runtimeSettingsObjectSchema,
  type RuntimeSettingsOverrides,
} from "../config/index.js";
import {
  isWorkspaceProviderCapability,
  providerFeatureConfigurationSchema,
  WORKSPACE_PROVIDER_CAPABILITIES,
  type ProviderFeatureConfiguration,
} from "../providers/profiles.js";

export interface StoredWorkspaceSettings {
  providerFeatures: ProviderFeatureConfiguration[];
  runtime: RuntimeSettingsOverrides;
  schemaVersion: 1;
}

export const EMPTY_WORKSPACE_SETTINGS: StoredWorkspaceSettings = {
  providerFeatures: [],
  runtime: {},
  schemaVersion: 1,
};

const storedWorkspaceSettingsSchema = z.object({
  providerFeatures: z.array(providerFeatureConfigurationSchema)
    .max(WORKSPACE_PROVIDER_CAPABILITIES.length),
  runtime: runtimeSettingsObjectSchema.partial(),
  schemaVersion: z.literal(1),
}).strict();

export function parseStoredWorkspaceSettings(
  value: unknown,
): StoredWorkspaceSettings {
  const result = storedWorkspaceSettingsSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid workspace settings: ${result.error.message}`);
  }
  const runtime: RuntimeSettingsOverrides = {};
  for (const [candidateKey, candidateValue] of Object.entries(
    result.data.runtime,
  )) {
    const key = decodeRuntimeSettingKey(candidateKey);
    if (!isWorkspaceRuntimeSetting(key)) {
      throw new Error(`Workspace settings cannot override ${key}.`);
    }
    if (candidateValue === undefined) {
      throw new Error(`Workspace setting ${key} cannot be undefined.`);
    }
    Object.assign(runtime, { [key]: candidateValue });
  }

  const providerFeatures: ProviderFeatureConfiguration[] = [];
  const capabilities = new Set<string>();
  for (const configuration of result.data.providerFeatures) {
    if (!isWorkspaceProviderCapability(configuration.capability)) {
      throw new Error(
        `Workspace settings cannot override ${configuration.capability}.`,
      );
    }
    if (capabilities.has(configuration.capability)) {
      throw new Error(
        `Workspace settings contain ${configuration.capability} more than once.`,
      );
    }
    capabilities.add(configuration.capability);
    providerFeatures.push(structuredClone(configuration));
  }
  return {
    providerFeatures,
    runtime,
    schemaVersion: 1,
  };
}
