import { and, eq, isNotNull, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import {
  buildAppConfig,
  parseRuntimeSettings,
  readProviderProfile,
  type AppConfig,
  type DatabaseConfig,
  type RuntimeSettings,
  type RuntimeSettingsOverrides,
} from "../config/index.js";
import type { CiteLoomDatabase } from "../database/client.js";
import {
  applicationSettings,
  ingestionJobs,
  providerOAuthCredentials,
} from "../database/schema.js";
import {
  EmbeddingInputFormatStore,
  type EmbeddingInputFormatRecordWithUsage,
} from "../embedding/input-format-store.js";
import type { EmbeddingInputFormatContract } from "../embedding/input-format-model.js";
import type {
  NormalizedProviderSettingsChange,
  ProviderSettings,
} from "../providers/profiles.js";
import {
  parseStoredApplicationSettings,
  type StoredApplicationSettings,
} from "../providers/settings-persistence.js";
import {
  buildEffectiveSettings,
  calculateRuntimeOverrides,
  decodeStoredSettingsRow,
  readEmbeddingSpaceAvailability,
  readSelectedInputFormat,
  type EmbeddingSpaceAvailability,
  type StoredSettings,
} from "./application-settings-resolution.js";
import { applyProviderSettingsChanges } from "./provider-settings-changes.js";
import {
  SettingsValidationError,
  SettingsVersionConflictError,
  type EffectiveApplicationSettings,
  type NormalizedRuntimeSettingChange,
} from "./settings-model.js";

const SETTINGS_ID = "runtime";
const workspaceProviderReferenceRowsSchema = z.array(z.object({
  providerId: z.string().trim().min(1),
  workspaceName: z.string().trim().min(1),
}).strict());

export class ApplicationSettingsRepository {
  public constructor(private readonly database: CiteLoomDatabase) {}

  public async read(
    databaseConfig: DatabaseConfig,
  ): Promise<EffectiveApplicationSettings> {
    const rows = await this.database
      .select()
      .from(applicationSettings)
      .where(eq(applicationSettings.id, SETTINGS_ID))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new SettingsValidationError(
        "The database does not contain application settings.",
      );
    }
    const stored = decodeStoredSettingsRow(row);
    const inputFormats = await new EmbeddingInputFormatStore(
      this.database,
    ).listWithEmbeddingSpaceCounts();
    const settings = buildEffectiveSettings(
      databaseConfig,
      stored,
      inputFormats,
    );
    const availability = await readEmbeddingSpaceAvailability(
      this.database,
      settings.config.embeddingSpace.id,
    );
    return { ...settings, ...availability };
  }

  public async update(
    databaseConfig: DatabaseConfig,
    expectedVersion: number,
    changes: NormalizedRuntimeSettingChange[],
    providerChanges: NormalizedProviderSettingsChange[] = [],
  ): Promise<EffectiveApplicationSettings> {
    const settings = await this.database.transaction(async (transaction) => {
      const stored = await readStoredSettingsForUpdate(transaction);
      if (stored === null) {
        throw new SettingsValidationError(
          "The database does not contain application settings.",
        );
      }
      const currentVersion = stored.version;
      if (currentVersion !== expectedVersion) {
        throw new SettingsVersionConflictError();
      }
      const runtimeSettings = applyApplicationSettingsChanges(
        stored,
        changes,
      );
      const inputFormats = await new EmbeddingInputFormatStore(
        transaction,
      ).listWithEmbeddingSpaceCounts();
      const resolved = resolveApplicationSettingsUpdate({
        databaseConfig,
        inputFormats,
        expectedVersion,
        providerChanges,
        runtimeSettings,
        stored,
      });
      await validateDefaultDoclingUrlChange(transaction, resolved);
      await validateOpenAICodexRouteChange(
        transaction,
        providerChanges,
        resolved.providerSettings,
      );
      await validateWorkspaceProviderReferences(
        transaction,
        resolved.providerSettings,
      );
      const availability = await readEmbeddingSpaceAvailability(
        transaction,
        resolved.effectiveConfig.embeddingSpace.id,
      );
      if (!resolved.requiresPersistence) {
        return buildApplicationSettingsUpdateResult(
          stored.defaults.runtime,
          resolved,
          stored.updatedAt,
          stored.version,
          availability,
        );
      }

      const updatedAt = new Date();
      const nextVersion = expectedVersion + 1;
      await persistApplicationSettingsUpdate(
        transaction,
        resolved,
        expectedVersion,
        nextVersion,
        updatedAt,
      );
      return buildApplicationSettingsUpdateResult(
        stored.defaults.runtime,
        resolved,
        updatedAt,
        nextVersion,
        availability,
      );
    });
    return settings;
  }

  public async readForRuntime(
    databaseConfig: DatabaseConfig,
  ): Promise<EffectiveApplicationSettings> {
    return readApplicationSettingsForRuntime(
      this.database,
      databaseConfig,
    );
  }
}

type ApplicationSettingsReaderDatabase = Pick<
  CiteLoomDatabase,
  "insert" | "select"
>;

export async function readApplicationSettingsForRuntime(
  database: ApplicationSettingsReaderDatabase,
  databaseConfig: DatabaseConfig,
  lock = false,
): Promise<EffectiveApplicationSettings> {
  const query = database
    .select()
    .from(applicationSettings)
    .where(eq(applicationSettings.id, SETTINGS_ID))
    .limit(1);
  const rows = lock ? await query.for("share") : await query;
  const row = rows[0];
  if (row === undefined) {
    throw new SettingsValidationError(
      "The database does not contain application settings.",
    );
  }
  const stored = decodeStoredSettingsRow(row);
  const inputFormat = await new EmbeddingInputFormatStore(
    database,
  ).read(stored.settings.runtime.embeddingInputFormatId);
  if (inputFormat === null) {
    throw new SettingsValidationError(
      "The selected search text format does not exist.",
    );
  }
  const inputFormats: EmbeddingInputFormatRecordWithUsage[] = [{
    ...inputFormat,
    embeddingSpaceCount: 0,
  }];
  const settings = buildEffectiveSettings(
    databaseConfig,
    stored,
    inputFormats,
  );
  return {
    ...settings,
    indexedDocumentCount: 0,
    selectedEmbeddingSpaceDocumentCount: 0,
  };
}

type ApplicationSettingsTransaction = Parameters<
  Parameters<CiteLoomDatabase["transaction"]>[0]
>[0];

interface ApplicationSettingsUpdateRequest {
  databaseConfig: DatabaseConfig;
  inputFormats: EmbeddingInputFormatRecordWithUsage[];
  expectedVersion: number;
  providerChanges: NormalizedProviderSettingsChange[];
  runtimeSettings: RuntimeSettings;
  stored: StoredSettings;
}

interface ResolvedApplicationSettingsUpdate {
  currentDefaultDoclingUrl: string;
  effectiveConfig: AppConfig;
  inputFormats: EmbeddingInputFormatRecordWithUsage[];
  overrides: RuntimeSettingsOverrides;
  providerSettings: ProviderSettings;
  requiresPersistence: boolean;
  runtimeSettings: RuntimeSettings;
  storedSettings: StoredApplicationSettings;
}

async function readStoredSettingsForUpdate(
  transaction: ApplicationSettingsTransaction,
): Promise<StoredSettings | null> {
  const rows = await transaction
    .select()
    .from(applicationSettings)
    .where(eq(applicationSettings.id, SETTINGS_ID))
    .limit(1)
    .for("update");
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return decodeStoredSettingsRow(row);
}

function applyApplicationSettingsChanges(
  stored: StoredSettings,
  changes: NormalizedRuntimeSettingChange[],
): RuntimeSettings {
  const next = structuredClone(stored.settings.runtime);
  for (const change of changes) {
    if ("reset" in change) {
      Object.assign(next, {
        [change.key]: stored.defaults.runtime[change.key],
      });
      continue;
    }
    Object.assign(next, { [change.key]: change.value });
  }
  return parseRuntimeSettings(next);
}

function resolveApplicationSettingsUpdate(
  request: ApplicationSettingsUpdateRequest,
): ResolvedApplicationSettingsUpdate {
  try {
    const currentRuntimeSettings = request.stored.settings.runtime;
    const currentProviderSettings = request.stored.settings.providers;
    const currentInputFormat = readSelectedInputFormat(
      request.inputFormats,
      currentRuntimeSettings.embeddingInputFormatId,
    );
    const selectedInputFormat = readSelectedInputFormat(
      request.inputFormats,
      request.runtimeSettings.embeddingInputFormatId,
    );
    const providerSettings = applyProviderSettingsChanges(
      currentProviderSettings,
      request.stored.defaults.providers,
      request.providerChanges,
    );
    const currentConfig = buildAppConfig(
      request.databaseConfig,
      currentRuntimeSettings,
      request.stored.version,
      currentProviderSettings,
      request.stored.settings.sourceContent,
      currentInputFormat,
    );
    const runtimeSettings = normalizeEmbeddingSpaceIdAfterIdentityChange(
      request,
      currentConfig,
      providerSettings,
      selectedInputFormat,
    );
    const requiresPersistence = hasApplicationSettingsToPersist(
      request.stored,
      runtimeSettings,
      providerSettings,
    );
    const resultVersion = requiresPersistence
      ? request.expectedVersion + 1
      : request.stored.version;
    const effectiveConfig = buildAppConfig(
      request.databaseConfig,
      runtimeSettings,
      resultVersion,
      providerSettings,
      request.stored.settings.sourceContent,
      selectedInputFormat,
    );
    const storedSettings = parseStoredApplicationSettings({
      providers: providerSettings,
      runtime: runtimeSettings,
      schemaVersion: 1,
      sourceContent: request.stored.settings.sourceContent,
    });
    return {
      currentDefaultDoclingUrl: readDefaultDoclingServiceUrl(currentConfig),
      effectiveConfig,
      inputFormats: request.inputFormats,
      overrides: calculateRuntimeOverrides(
        request.stored.defaults.runtime,
        runtimeSettings,
      ),
      providerSettings,
      requiresPersistence,
      runtimeSettings,
      storedSettings,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Settings are invalid.";
    throw new SettingsValidationError(message);
  }
}

function normalizeEmbeddingSpaceIdAfterIdentityChange(
  request: ApplicationSettingsUpdateRequest,
  currentConfig: AppConfig,
  providerSettings: ProviderSettings,
  inputFormat: EmbeddingInputFormatContract,
): RuntimeSettings {
  const currentSpaceIdOverride =
    request.stored.settings.runtime.embeddingSpaceId;
  if (
    currentSpaceIdOverride === null
    || request.runtimeSettings.embeddingSpaceId !== currentSpaceIdOverride
  ) {
    return request.runtimeSettings;
  }
  const automaticSettings: RuntimeSettings = {
    ...request.runtimeSettings,
    embeddingSpaceId: null,
  };
  const automaticConfig = buildAppConfig(
    request.databaseConfig,
    automaticSettings,
    request.expectedVersion + 1,
    providerSettings,
    request.stored.settings.sourceContent,
    inputFormat,
  );
  if (embeddingSpaceIdentitiesMatch(
    currentConfig.embeddingSpace,
    automaticConfig.embeddingSpace,
  )) {
    return request.runtimeSettings;
  }
  return automaticSettings;
}

function embeddingSpaceIdentitiesMatch(
  left: AppConfig["embeddingSpace"],
  right: AppConfig["embeddingSpace"],
): boolean {
  return left.dimensions === right.dimensions
    && left.inputFormat.id === right.inputFormat.id
    && left.inputFormat.inputFormatHash === right.inputFormat.inputFormatHash
    && left.model === right.model
    && left.retrievalWindow.fingerprint === right.retrievalWindow.fingerprint;
}

function hasApplicationSettingsToPersist(
  stored: StoredSettings,
  runtimeSettings: RuntimeSettings,
  providerSettings: ProviderSettings,
): boolean {
  return !isDeepStrictEqual(stored.settings.runtime, runtimeSettings)
    || !isDeepStrictEqual(stored.settings.providers, providerSettings);
}

async function validateDefaultDoclingUrlChange(
  transaction: ApplicationSettingsTransaction,
  update: ResolvedApplicationSettingsUpdate,
): Promise<void> {
  const effectiveDefaultUrl = readDefaultDoclingServiceUrl(update.effectiveConfig);
  if (update.currentDefaultDoclingUrl === effectiveDefaultUrl) {
    return;
  }
  const assignedJobs = await transaction
    .select({ sourceFile: ingestionJobs.sourceFile })
    .from(ingestionJobs)
    .where(and(
      eq(ingestionJobs.doclingServiceInstanceId, "default"),
      isNotNull(ingestionJobs.doclingServiceSlot),
    ))
    .limit(1);
  if (assignedJobs.length > 0) {
    throw new SettingsValidationError(
      "The default Docling URL cannot change while jobs remain assigned to that service.",
    );
  }
}

export async function validateOpenAICodexRouteChange(
  transaction: ApplicationSettingsTransaction,
  changes: NormalizedProviderSettingsChange[],
  providerSettings: ProviderSettings,
): Promise<void> {
  let selectedProviderId: string | null = null;
  for (const change of changes) {
    let providerId: string | null = null;
    if (change.action === "route") {
      providerId = change.providerId;
    }
    if (change.action === "feature") {
      providerId = change.configuration.providerId;
    }
    if (providerId === null) {
      continue;
    }
    const profile = readProviderProfile(providerSettings, providerId);
    if (profile?.authentication === "openai-device") {
      selectedProviderId = providerId;
      break;
    }
  }
  if (selectedProviderId === null) {
    return;
  }
  const rows = await transaction
    .select({ status: providerOAuthCredentials.status })
    .from(providerOAuthCredentials)
    .where(eq(providerOAuthCredentials.providerId, selectedProviderId))
    .limit(1);
  if (rows[0]?.status !== "connected") {
    throw new SettingsValidationError(
      "Sign in to OpenAI Codex before assigning a feature to it.",
    );
  }
}

async function validateWorkspaceProviderReferences(
  transaction: ApplicationSettingsTransaction,
  providerSettings: ProviderSettings,
): Promise<void> {
  const result = await transaction.execute(sql<{
    providerId: string;
    workspaceName: string;
  }>`
    SELECT
      feature->>'providerId' AS "providerId",
      workspace."name" AS "workspaceName"
    FROM "workspace_settings" AS workspace_setting
    INNER JOIN "workspaces" AS workspace
      ON workspace."id" = workspace_setting."workspace_id"
    CROSS JOIN LATERAL jsonb_array_elements(
      workspace_setting."settings"->'providerFeatures'
    ) AS feature
    WHERE workspace."state" = 'active'
      AND feature->>'providerId' IS NOT NULL
  `);
  const references = workspaceProviderReferenceRowsSchema.parse(result.rows);
  for (const reference of references) {
    if (providerSettings.connections[reference.providerId] !== undefined) {
      continue;
    }
    throw new SettingsValidationError(
      `${reference.providerId} is still used by ${reference.workspaceName} workspace settings. Reset that workspace feature before removing the provider.`,
    );
  }
}

async function persistApplicationSettingsUpdate(
  transaction: ApplicationSettingsTransaction,
  update: ResolvedApplicationSettingsUpdate,
  expectedVersion: number,
  nextVersion: number,
  updatedAt: Date,
): Promise<void> {
  const updated = await transaction
    .update(applicationSettings)
    .set({
      settings: update.storedSettings,
      updatedAt,
      version: nextVersion,
    })
    .where(and(
      eq(applicationSettings.id, SETTINGS_ID),
      eq(applicationSettings.version, expectedVersion),
    ))
    .returning({ id: applicationSettings.id });
  if (updated.length !== 1) {
    throw new SettingsVersionConflictError();
  }
}

function buildApplicationSettingsUpdateResult(
  defaults: RuntimeSettings,
  update: ResolvedApplicationSettingsUpdate,
  updatedAt: Date | null,
  version: number,
  availability: EmbeddingSpaceAvailability,
): EffectiveApplicationSettings {
  return {
    ...availability,
    config: update.effectiveConfig,
    defaults,
    embeddingInputFormats: update.inputFormats,
    overrides: update.overrides,
    providerSettings: update.providerSettings,
    runtimeSettings: update.runtimeSettings,
    updatedAt: updatedAt?.toISOString() ?? null,
    version,
  };
}

function readDefaultDoclingServiceUrl(config: AppConfig): string {
  const service = config.doclingServices.find((candidate) => {
    return candidate.id === "default";
  });
  if (service === undefined) {
    throw new Error('Docling service configuration has no "default" service.');
  }
  return service.baseUrl;
}
