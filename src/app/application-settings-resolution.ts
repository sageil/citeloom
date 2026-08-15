import { and, count, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import {
  buildAppConfig,
  type DatabaseConfig,
  type RuntimeSettings,
  type RuntimeSettingsOverrides,
} from "../config/index.js";
import type { CiteLoomDatabase } from "../database/client.js";
import {
  indexedDocuments,
  indexedDocumentSpaces,
} from "../database/schema.js";
import type { EmbeddingInputFormatRecordWithUsage } from "../embedding/input-format-store.js";
import {
  readEmbeddingInputFormatContract,
  type EmbeddingInputFormatContract,
} from "../embedding/input-format-model.js";
import {
  parseStoredApplicationSettings,
  type StoredApplicationSettings,
} from "../providers/settings-persistence.js";
import { runtimeSettingKeys } from "./runtime-settings.js";
import {
  SettingsValidationError,
  type EffectiveApplicationSettings,
} from "./settings-model.js";

const storedSettingsRowSchema = z.object({
  defaults: z.unknown(),
  settings: z.unknown(),
  updatedAt: z.date(),
  version: z.number().int().positive(),
});

type EffectiveApplicationSettingsWithoutAvailability = Omit<
  EffectiveApplicationSettings,
  "indexedDocumentCount" | "selectedEmbeddingSpaceDocumentCount"
>;

export function buildEffectiveSettings(
  databaseConfig: DatabaseConfig,
  stored: StoredSettings,
  inputFormats: EmbeddingInputFormatRecordWithUsage[],
): EffectiveApplicationSettingsWithoutAvailability {
  const defaults = stored.defaults.runtime;
  const runtimeSettings = stored.settings.runtime;
  const providerSettings = stored.settings.providers;
  const inputFormat = readSelectedInputFormat(
    inputFormats,
    runtimeSettings.embeddingInputFormatId,
  );
  return {
    config: buildAppConfig(
      databaseConfig,
      runtimeSettings,
      stored.version,
      providerSettings,
      stored.settings.sourceContent,
      inputFormat,
    ),
    defaults,
    embeddingInputFormats: inputFormats,
    overrides: calculateRuntimeOverrides(defaults, runtimeSettings),
    providerSettings,
    runtimeSettings,
    updatedAt: stored.updatedAt.toISOString(),
    version: stored.version,
  };
}

export interface EmbeddingSpaceAvailability {
  indexedDocumentCount: number;
  selectedEmbeddingSpaceDocumentCount: number;
}

type EmbeddingSpaceAvailabilityDatabase = Pick<CiteLoomDatabase, "select">;

export async function readEmbeddingSpaceAvailability(
  database: EmbeddingSpaceAvailabilityDatabase,
  embeddingSpaceId: string,
): Promise<EmbeddingSpaceAvailability> {
  const [indexedRows, selectedSpaceRows] = await Promise.all([
    database
      .select({ value: count() })
      .from(indexedDocuments),
    database
      .select({ value: count() })
      .from(indexedDocumentSpaces)
      .innerJoin(
        indexedDocuments,
        and(
          eq(indexedDocumentSpaces.documentId, indexedDocuments.documentId),
          eq(indexedDocumentSpaces.sourceFile, indexedDocuments.sourceFile),
        ),
      )
      .where(eq(indexedDocumentSpaces.embeddingSpaceId, embeddingSpaceId)),
  ]);
  return {
    indexedDocumentCount: readSettingsCount(
      indexedRows,
      "indexed document",
    ),
    selectedEmbeddingSpaceDocumentCount: readSettingsCount(
      selectedSpaceRows,
      "selected embedding-space document",
    ),
  };
}

function readSettingsCount(
  rows: Array<{ value: number }>,
  label: string,
): number {
  const row = rows[0];
  if (row === undefined || !Number.isInteger(row.value) || row.value < 0) {
    throw new Error(`Database returned an invalid ${label} count.`);
  }
  return row.value;
}

export function readSelectedInputFormat(
  inputFormats: readonly EmbeddingInputFormatRecordWithUsage[],
  id: string,
): EmbeddingInputFormatContract {
  const inputFormat = inputFormats.find((candidate) => candidate.id === id);
  if (inputFormat === undefined) {
    throw new SettingsValidationError(
      `The selected search text format does not exist: ${id}.`,
    );
  }
  if (inputFormat.retiredAt !== null) {
    throw new SettingsValidationError(
      `The selected search text format is retired: ${inputFormat.name}.`,
    );
  }
  return readEmbeddingInputFormatContract({
    documentTemplate: inputFormat.documentTemplate,
    id: inputFormat.id,
    inputFormatHash: inputFormat.inputFormatHash,
    name: inputFormat.name,
    queryTemplate: inputFormat.queryTemplate,
    schemaVersion: inputFormat.schemaVersion,
  });
}

export interface StoredSettings {
  defaults: StoredApplicationSettings;
  settings: StoredApplicationSettings;
  updatedAt: Date;
  version: number;
}

export function decodeStoredSettingsRow(
  value: unknown,
): StoredSettings {
  const result = storedSettingsRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid application settings row: ${result.error.message}`);
  }
  return {
    defaults: parseStoredApplicationSettings(result.data.defaults),
    settings: parseStoredApplicationSettings(result.data.settings),
    updatedAt: result.data.updatedAt,
    version: result.data.version,
  };
}

export function calculateRuntimeOverrides(
  defaults: RuntimeSettings,
  settings: RuntimeSettings,
): RuntimeSettingsOverrides {
  const overrides: RuntimeSettingsOverrides = {};
  for (const key of runtimeSettingKeys) {
    if (isDeepStrictEqual(defaults[key], settings[key])) {
      continue;
    }
    Object.assign(overrides, { [key]: settings[key] });
  }
  return overrides;
}
