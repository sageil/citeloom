import type {
  AppConfig,
  RuntimeSettingKey,
  RuntimeSettings,
  RuntimeSettingsOverrides,
  RuntimeSettingValue,
} from "../config/index.js";
import type { EmbeddingInputFormatRecordWithUsage } from "../embedding/input-format-store.js";
import type { ProviderSettings } from "../providers/profiles.js";

export type NormalizedRuntimeSettingChange =
  | { key: RuntimeSettingKey; reset: true }
  | { key: RuntimeSettingKey; value: RuntimeSettingValue };

export interface EffectiveApplicationSettings {
  config: AppConfig;
  defaults: RuntimeSettings;
  embeddingInputFormats: EmbeddingInputFormatRecordWithUsage[];
  indexedDocumentCount: number;
  overrides: RuntimeSettingsOverrides;
  providerSettings: ProviderSettings;
  runtimeSettings: RuntimeSettings;
  selectedEmbeddingSpaceDocumentCount: number;
  updatedAt: string | null;
  version: number;
}

export class SettingsVersionConflictError extends Error {
  public constructor() {
    super("Settings changed after this page was loaded. Reload and try again.");
    this.name = "SettingsVersionConflictError";
  }
}

export class SettingsValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}
