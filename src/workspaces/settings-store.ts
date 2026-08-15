import { and, eq } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";

import {
  ApplicationSettingsRepository,
  applyProviderSettingsChanges,
  isWorkspaceRuntimeSetting,
  readApplicationSettingsForRuntime,
  SettingsValidationError,
  SettingsVersionConflictError,
  validateOpenAICodexRouteChange,
  type EffectiveApplicationSettings,
  type NormalizedRuntimeSettingChange,
} from "../app/settings.js";
import {
  buildAppConfig,
  parseRuntimeSettings,
  type DatabaseConfig,
  type RuntimeSettingsOverrides,
} from "../config/index.js";
import type { CiteLoomDatabase } from "../database/client.js";
import { workspaceSettings } from "../database/schema.js";
import {
  isWorkspaceProviderCapability,
  readProviderFeatureConfiguration,
  type NormalizedProviderSettingsChange,
  type ProviderCapability,
  type ProviderFeatureConfiguration,
  type ProviderSettings,
} from "../providers/profiles.js";
import {
  parseStoredWorkspaceSettings,
  type StoredWorkspaceSettings,
} from "./settings-persistence.js";

export interface EffectiveWorkspaceSettings
  extends EffectiveApplicationSettings {
  providerOverrideCapabilities: ProviderCapability[];
}

interface StoredWorkspaceSettingsRow {
  settings: StoredWorkspaceSettings;
  updatedAt: Date;
  version: number;
}

const storedWorkspaceSettingsRowSchema = z.object({
  settings: z.unknown(),
  updatedAt: z.date(),
  version: z.number().int().positive(),
}).strict();

export class WorkspaceSettingsRepository {
  public constructor(private readonly database: CiteLoomDatabase) {}

  public async read(
    workspaceId: string,
    databaseConfig: DatabaseConfig,
  ): Promise<EffectiveWorkspaceSettings> {
    const [organizationSettings, row] = await Promise.all([
      new ApplicationSettingsRepository(this.database).read(
        databaseConfig,
      ),
      this.readStored(workspaceId),
    ]);
    return buildEffectiveWorkspaceSettings(organizationSettings, row);
  }

  public async readConfig(
    workspaceId: string,
    databaseConfig: DatabaseConfig,
  ): Promise<EffectiveWorkspaceSettings["config"]> {
    const [organizationSettings, row] = await Promise.all([
      new ApplicationSettingsRepository(this.database).readForRuntime(
        databaseConfig,
      ),
      this.readStored(workspaceId),
    ]);
    return buildEffectiveWorkspaceSettings(organizationSettings, row).config;
  }

  public async update(
    workspaceId: string,
    updatedByUserId: string,
    databaseConfig: DatabaseConfig,
    expectedVersion: number,
    runtimeChanges: NormalizedRuntimeSettingChange[],
    providerChanges: NormalizedProviderSettingsChange[],
  ): Promise<EffectiveWorkspaceSettings> {
    const updateResult = await this.database.transaction(async (transaction) => {
      const organizationSettings = await readApplicationSettingsForRuntime(
        transaction,
        databaseConfig,
        true,
      );
      const rows = await transaction
        .select({
          settings: workspaceSettings.settings,
          updatedAt: workspaceSettings.updatedAt,
          version: workspaceSettings.version,
        })
        .from(workspaceSettings)
        .where(eq(workspaceSettings.workspaceId, workspaceId))
        .limit(1)
        .for("update");
      const current = decodeStoredWorkspaceSettingsRow(rows[0]);
      if (current.version !== expectedVersion) {
        throw new SettingsVersionConflictError();
      }
      const nextSettings = await applyWorkspaceSettingsChanges(
        transaction,
        organizationSettings,
        current.settings,
        runtimeChanges,
        providerChanges,
      );
      if (isDeepStrictEqual(current.settings, nextSettings)) {
        return { organizationSettings, row: current };
      }
      const updatedAt = new Date();
      const nextVersion = current.version + 1;
      const updated = await transaction
        .update(workspaceSettings)
        .set({
          settings: nextSettings,
          updatedAt,
          updatedByUserId,
          version: nextVersion,
        })
        .where(and(
          eq(workspaceSettings.workspaceId, workspaceId),
          eq(workspaceSettings.version, expectedVersion),
        ))
        .returning({ workspaceId: workspaceSettings.workspaceId });
      if (updated.length !== 1) {
        throw new SettingsVersionConflictError();
      }
      return {
        organizationSettings,
        row: {
          settings: nextSettings,
          updatedAt,
          version: nextVersion,
        },
      };
    });
    return buildEffectiveWorkspaceSettings(
      updateResult.organizationSettings,
      updateResult.row,
    );
  }

  private async readStored(
    workspaceId: string,
  ): Promise<StoredWorkspaceSettingsRow> {
    const rows = await this.database
      .select({
        settings: workspaceSettings.settings,
        updatedAt: workspaceSettings.updatedAt,
        version: workspaceSettings.version,
      })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspaceId))
      .limit(1);
    return decodeStoredWorkspaceSettingsRow(rows[0]);
  }
}

type WorkspaceSettingsTransaction = Parameters<
  Parameters<CiteLoomDatabase["transaction"]>[0]
>[0];

async function applyWorkspaceSettingsChanges(
  transaction: WorkspaceSettingsTransaction,
  organization: EffectiveApplicationSettings,
  current: StoredWorkspaceSettings,
  runtimeChanges: NormalizedRuntimeSettingChange[],
  providerChanges: NormalizedProviderSettingsChange[],
): Promise<StoredWorkspaceSettings> {
  try {
    const runtime = applyWorkspaceRuntimeChanges(current.runtime, runtimeChanges);
    const providerFeatures = await applyWorkspaceProviderChanges(
      transaction,
      organization.providerSettings,
      current.providerFeatures,
      providerChanges,
    );
    const settings = parseStoredWorkspaceSettings({
      providerFeatures,
      runtime,
      schemaVersion: 1,
    });
    buildEffectiveWorkspaceSettings(organization, {
      settings,
      updatedAt: new Date(),
      version: 1,
    });
    return settings;
  } catch (error: unknown) {
    if (error instanceof SettingsValidationError) {
      throw error;
    }
    const message = error instanceof Error
      ? error.message
      : "Workspace settings are invalid.";
    throw new SettingsValidationError(message);
  }
}

function applyWorkspaceRuntimeChanges(
  current: RuntimeSettingsOverrides,
  changes: NormalizedRuntimeSettingChange[],
): RuntimeSettingsOverrides {
  const next = structuredClone(current);
  for (const change of changes) {
    if (!isWorkspaceRuntimeSetting(change.key)) {
      throw new SettingsValidationError(
        `${change.key} is managed in organization settings.`,
      );
    }
    if ("reset" in change) {
      delete next[change.key];
      continue;
    }
    Object.assign(next, { [change.key]: change.value });
  }
  return next;
}

async function applyWorkspaceProviderChanges(
  transaction: WorkspaceSettingsTransaction,
  organization: ProviderSettings,
  current: ProviderFeatureConfiguration[],
  changes: NormalizedProviderSettingsChange[],
): Promise<ProviderFeatureConfiguration[]> {
  if (changes.length === 0) {
    return structuredClone(current);
  }
  const reset = changes.find((change) => change.action === "reset");
  if (reset !== undefined) {
    if (changes.length !== 1) {
      throw new SettingsValidationError(
        "Provider reset cannot be combined with other provider changes.",
      );
    }
    return [];
  }
  for (const change of changes) {
    if (
      change.action === "configure"
      || change.action === "credential"
      || change.action === "reset-provider"
    ) {
      throw new SettingsValidationError(
        "Provider connections are managed in organization settings.",
      );
    }
    const capability = readWorkspaceProviderChangeCapability(change);
    if (!isWorkspaceProviderCapability(capability)) {
      throw new SettingsValidationError(
        `${capability} is managed in organization settings.`,
      );
    }
  }

  const currentEffective = resolveWorkspaceProviderSettings(
    organization,
    current,
  );
  const nextEffective = applyProviderSettingsChanges(
    currentEffective,
    organization,
    changes,
  );
  await validateOpenAICodexRouteChange(
    transaction,
    changes,
    nextEffective,
  );

  const nextByCapability = new Map<
    ProviderCapability,
    ProviderFeatureConfiguration
  >();
  for (const configuration of current) {
    nextByCapability.set(configuration.capability, configuration);
  }
  for (const change of changes) {
    const capability = readWorkspaceProviderChangeCapability(change);
    if (change.action === "reset-feature") {
      nextByCapability.delete(capability);
      continue;
    }
    nextByCapability.set(
      capability,
      readProviderFeatureConfiguration(nextEffective, capability),
    );
  }
  return [...nextByCapability.values()];
}

function readWorkspaceProviderChangeCapability(
  change: NormalizedProviderSettingsChange,
): ProviderCapability {
  if (change.action === "feature") {
    return change.configuration.capability;
  }
  if (change.action === "route" || change.action === "reset-feature") {
    return change.capability;
  }
  throw new SettingsValidationError(
    "Provider connections are managed in organization settings.",
  );
}

function buildEffectiveWorkspaceSettings(
  organization: EffectiveApplicationSettings,
  row: StoredWorkspaceSettingsRow,
): EffectiveWorkspaceSettings {
  try {
    const runtimeSettings = parseRuntimeSettings({
      ...organization.runtimeSettings,
      ...row.settings.runtime,
    });
    const providerSettings = resolveWorkspaceProviderSettings(
      organization.providerSettings,
      row.settings.providerFeatures,
    );
    const config = buildAppConfig(
      organization.config.database,
      runtimeSettings,
      organization.config.settingsVersion,
      providerSettings,
      organization.config.sourceContent,
      organization.config.embeddingSpace.inputFormat,
    );
    return {
      config,
      defaults: organization.runtimeSettings,
      embeddingInputFormats: organization.embeddingInputFormats,
      indexedDocumentCount: organization.indexedDocumentCount,
      overrides: structuredClone(row.settings.runtime),
      providerOverrideCapabilities: row.settings.providerFeatures.map(
        (configuration) => configuration.capability,
      ),
      providerSettings,
      runtimeSettings,
      selectedEmbeddingSpaceDocumentCount:
        organization.selectedEmbeddingSpaceDocumentCount,
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
    };
  } catch (error: unknown) {
    if (error instanceof SettingsValidationError) {
      throw error;
    }
    const message = error instanceof Error
      ? error.message
      : "Workspace settings are invalid.";
    throw new SettingsValidationError(message);
  }
}

function resolveWorkspaceProviderSettings(
  organization: ProviderSettings,
  overrides: ProviderFeatureConfiguration[],
): ProviderSettings {
  const changes: NormalizedProviderSettingsChange[] = overrides.map(
    (configuration) => ({ action: "feature", configuration }),
  );
  return applyProviderSettingsChanges(
    organization,
    organization,
    changes,
  );
}

function decodeStoredWorkspaceSettingsRow(
  value: unknown,
): StoredWorkspaceSettingsRow {
  const result = storedWorkspaceSettingsRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid workspace settings row: ${result.error.message}`,
    );
  }
  return {
    settings: parseStoredWorkspaceSettings(result.data.settings),
    updatedAt: result.data.updatedAt,
    version: result.data.version,
  };
}
