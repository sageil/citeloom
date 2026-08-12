import {
  runtimeSettingChangeExamples,
  runtimeSettingDefinitions,
  isWorkspaceRuntimeSetting,
  type EffectiveApplicationSettings,
  type RuntimeSettingPanel,
} from "../app/settings.js";
import {
  providerSupportsAdaptiveContext,
  PROVIDER_CAPABILITY_DEFINITIONS,
  readProviderConnectionConfiguration,
  type ProviderAuthenticationMethod,
  type ProviderCapability,
  type ProviderCapabilityProfile,
  type ProviderConnectionConfiguration,
  type ProviderFeatureOverrides,
  type ProviderId,
  type ProviderRouting,
} from "../providers/profiles.js";
import {
  readEmbeddingConfigurationWarnings,
  type AppConfig,
  type EmbeddingDimensions,
  type RuntimeSettingValue,
} from "../config/index.js";
import type { WebConfig } from "./config.js";
import {
  presentRuntimeSettingField,
  presentRuntimeSettingValue,
} from "./runtime-settings-boundary.js";
import type { EffectiveWorkspaceSettings } from "../workspaces/settings-store.js";
import type { WorkspaceSummary } from "../auth/model.js";

export interface RuntimeSettingFieldResponse {
  changeExample: string;
  configured: boolean;
  defaultConfigured: boolean;
  defaultValue: RuntimeSettingValue | null;
  description: string;
  feature: ProviderCapability | null;
  group: string;
  input: string;
  key: string;
  label: string;
  max: number | null;
  min: number | null;
  nullable: boolean;
  options: Array<{ label: string; value: string | number }>;
  panel: RuntimeSettingPanel | null;
  sensitive: boolean;
  source: "database" | "database-default";
  step: number | null;
  unit: string | null;
  value: RuntimeSettingValue | null;
}

export interface StartupSettingResponse {
  description: string;
  key: string;
  label: string;
  value: string;
}

export interface EmbeddingInputFormatResponse {
  canRetire: boolean;
  createdAt: string;
  defaultSelected: boolean;
  documentTemplate: string;
  embeddingSpaceCount: number;
  id: string;
  inputFormatHash: string;
  name: string;
  queryTemplate: string;
  retiredAt: string | null;
  retirementBlockers: string[];
  schemaVersion: number;
  selected: boolean;
}

export interface ApplicationSettingsResponse {
  embeddingSpace: EmbeddingSpaceStatusResponse | null;
  embeddingInputFormats: EmbeddingInputFormatResponse[];
  features: ProviderFeatureResponse[];
  fields: RuntimeSettingFieldResponse[];
  providers: ProviderSettingsResponse;
  scope: SettingsScopeResponse;
  startupSettings: StartupSettingResponse[];
  updatedAt: string | null;
  version: number;
  warnings: string[];
}

export interface ProviderFeatureResponse {
  capability: ProviderCapability;
  description: string;
  label: string;
  source: "database" | "database-default";
}

export interface SettingsScopeResponse {
  available: SettingsScopeOptionResponse[];
  editableProviderConnections: boolean;
  id: string;
  kind: "organization" | "workspace";
  label: string;
}

export type SettingsScopeOptionResponse =
  | { id: "organization"; kind: "organization"; label: string }
  | { id: string; kind: "workspace"; label: string };

export interface EmbeddingSpaceStatusResponse {
  activeDocumentCount: number;
  dimensions: EmbeddingDimensions;
  id: string;
  totalDocumentCount: number;
}

export interface ProviderConnectionResponse {
  apiTokenConfigured: boolean;
  capabilityApiTokensConfigured: {
    answer: boolean;
    chat: boolean;
    embedding: boolean;
    queryExpansion: boolean;
    reranking: boolean;
    speechToText: boolean;
    indexing: boolean;
    textToSpeech: boolean;
  };
  configuration: ProviderConnectionConfiguration;
  providerId: ProviderId;
}

export interface ProviderProfileResponse {
  adaptiveContextSupported: boolean;
  adapterConfiguration: "catalog" | "connection";
  authentication: ProviderAuthenticationMethod;
  capabilities: ProviderCapabilityProfile[];
  displayName: string;
  id: ProviderId;
}

export interface ProviderSettingsResponse {
  catalog: ProviderProfileResponse[];
  connections: ProviderConnectionResponse[];
  featureOverrides: ProviderFeatureOverrides;
  routing: ProviderRouting;
}

export function buildApplicationSettingsResponse(
  settings: EffectiveApplicationSettings,
  startupConfig: AppConfig,
  webConfig: WebConfig,
  scope: SettingsScopeResponse = buildOrganizationSettingsScope(),
): ApplicationSettingsResponse {
  const workspaceSettings = isEffectiveWorkspaceSettings(settings)
    ? settings
    : null;
  const fields: RuntimeSettingFieldResponse[] = [];
  for (const definition of runtimeSettingDefinitions) {
    if (definition.providerManagedSetting === true) {
      continue;
    }
    if (scope.kind === "workspace" && !isWorkspaceRuntimeSetting(definition.key)) {
      continue;
    }
    const effectiveValue = presentRuntimeSettingValue(
      settings.runtimeSettings,
      definition.key,
    );
    const defaultValue = presentRuntimeSettingValue(
      settings.defaults,
      definition.key,
    );
    const presentation = presentRuntimeSettingField(definition);
    const sensitive = definition.sensitive === true;
    const source = Object.hasOwn(settings.overrides, definition.key)
      ? "database"
      : "database-default";
    let options = definition.options ?? [];
    if (definition.key === "embeddingInputFormatId") {
      options = settings.embeddingInputFormats
        .filter((inputFormat) => inputFormat.retiredAt === null)
        .map((inputFormat) => ({
          label: inputFormat.name,
          value: inputFormat.id,
        }));
    }
    if (definition.key === "doclingVlmProviderId") {
      options = settings.providerSettings.catalog
        .filter((profile) => {
          return profile.doclingVlm !== null
            && settings.providerSettings.connections[profile.id] !== undefined;
        })
        .map((profile) => ({
          label: profile.displayName,
          value: profile.id,
        }));
    }
    fields.push({
      changeExample: runtimeSettingChangeExamples[definition.key],
      configured: sensitive ? effectiveValue !== null : true,
      defaultConfigured: sensitive ? defaultValue !== null : true,
      defaultValue: sensitive ? null : defaultValue,
      description: definition.description,
      feature: definition.feature ?? null,
      group: definition.group,
      input: definition.input,
      key: presentation.key,
      label: definition.label,
      max: presentation.max,
      min: presentation.min,
      nullable: definition.nullable === true,
      options,
      panel: definition.panel ?? null,
      sensitive,
      source,
      step: presentation.step,
      unit: presentation.unit,
      value: sensitive ? null : effectiveValue,
    });
  }
  return {
    embeddingSpace: scope.kind === "organization"
      ? {
        activeDocumentCount: settings.selectedEmbeddingSpaceDocumentCount,
        dimensions: settings.config.embeddingSpace.dimensions,
        id: settings.config.embeddingSpace.id,
        totalDocumentCount: settings.indexedDocumentCount,
      }
      : null,
    embeddingInputFormats: scope.kind === "organization"
      ? buildEmbeddingInputFormatResponses(settings)
      : [],
    features: buildProviderFeatureResponses(scope, workspaceSettings),
    fields,
    providers: buildProviderSettingsResponse(settings),
    scope,
    startupSettings: scope.kind === "organization"
      ? buildStartupSettings(startupConfig, webConfig)
      : [],
    updatedAt: settings.updatedAt,
    version: settings.version,
    warnings: scope.kind === "organization"
      ? buildApplicationSettingsWarnings(settings)
      : [],
  };
}

export function buildOrganizationSettingsScope(
  workspaces: WorkspaceSummary[] = [],
): SettingsScopeResponse {
  return {
    available: buildAvailableSettingsScopes(workspaces, true),
    editableProviderConnections: true,
    id: "organization",
    kind: "organization",
    label: "Organization",
  };
}

export function buildWorkspaceSettingsScope(
  workspace: WorkspaceSummary,
  workspaces: WorkspaceSummary[],
  includeOrganization: boolean,
): SettingsScopeResponse {
  return {
    available: buildAvailableSettingsScopes(workspaces, includeOrganization),
    editableProviderConnections: false,
    id: workspace.id,
    kind: "workspace",
    label: workspace.name,
  };
}

function buildAvailableSettingsScopes(
  workspaces: WorkspaceSummary[],
  includeOrganization: boolean,
): SettingsScopeOptionResponse[] {
  const available: SettingsScopeOptionResponse[] = [];
  if (includeOrganization) {
    available.push({
      id: "organization",
      kind: "organization",
      label: "Organization",
    });
  }
  for (const workspace of workspaces) {
    if (workspace.role !== "admin") {
      continue;
    }
    available.push({
      id: workspace.id,
      kind: "workspace",
      label: workspace.name,
    });
  }
  return available;
}

function buildProviderFeatureResponses(
  scope: SettingsScopeResponse,
  workspaceSettings: EffectiveWorkspaceSettings | null,
): ProviderFeatureResponse[] {
  const overridden = new Set(
    workspaceSettings?.providerOverrideCapabilities ?? [],
  );
  const features: ProviderFeatureResponse[] = [];
  for (const definition of PROVIDER_CAPABILITY_DEFINITIONS) {
    if (scope.kind === "workspace" && !definition.workspaceConfigurable) {
      continue;
    }
    features.push({
      capability: definition.capability,
      description: definition.description,
      label: definition.label,
      source: scope.kind === "workspace"
        && !overridden.has(definition.capability)
        ? "database-default"
        : "database",
    });
  }
  return features;
}

function isEffectiveWorkspaceSettings(
  settings: EffectiveApplicationSettings,
): settings is EffectiveWorkspaceSettings {
  return "providerOverrideCapabilities" in settings;
}

function buildApplicationSettingsWarnings(
  settings: EffectiveApplicationSettings,
): string[] {
  const warnings = readEmbeddingConfigurationWarnings({
    embeddingContextCapacityTokens:
      settings.config.inference.embedding.maximumInputTokens,
    retrievalChunkTargetTokens:
      settings.runtimeSettings.retrievalChunkTargetTokens,
  });
  if (
    settings.selectedEmbeddingSpaceDocumentCount
      === settings.indexedDocumentCount
    && settings.indexedDocumentCount > 0
  ) {
    return warnings;
  }
  if (settings.indexedDocumentCount > 0) {
    const missingDocumentCount = settings.indexedDocumentCount
      - settings.selectedEmbeddingSpaceDocumentCount;
    const noun = missingDocumentCount === 1 ? "document does" : "documents do";
    warnings.push(
      `${missingDocumentCount} indexed ${noun} not use the selected search setup. Reindex before asking questions about them.`,
    );
    return warnings;
  }
  warnings.push(
    "No indexed documents use the selected search setup. Index a document before asking questions.",
  );
  return warnings;
}

function buildEmbeddingInputFormatResponses(
  settings: EffectiveApplicationSettings,
): EmbeddingInputFormatResponse[] {
  const responses: EmbeddingInputFormatResponse[] = [];
  for (const format of settings.embeddingInputFormats) {
    const defaultSelected =
      settings.defaults.embeddingInputFormatId === format.id;
    const selected =
      settings.runtimeSettings.embeddingInputFormatId === format.id;
    const retirementBlockers: string[] = [];
    if (format.embeddingSpaceCount > 0) {
      retirementBlockers.push(
        `${format.embeddingSpaceCount} search ${format.embeddingSpaceCount === 1 ? "index" : "indexes"}`,
      );
    }
    if (defaultSelected) {
      retirementBlockers.push("the application default");
    }
    if (selected) {
      retirementBlockers.push("the selected application setting");
    }
    responses.push({
      canRetire:
        format.retiredAt === null && retirementBlockers.length === 0,
      createdAt: format.createdAt.toISOString(),
      defaultSelected,
      documentTemplate: format.documentTemplate,
      embeddingSpaceCount: format.embeddingSpaceCount,
      id: format.id,
      inputFormatHash: format.inputFormatHash,
      name: format.name,
      queryTemplate: format.queryTemplate,
      retiredAt: format.retiredAt?.toISOString() ?? null,
      retirementBlockers,
      schemaVersion: format.schemaVersion,
      selected,
    });
  }
  return responses;
}

function buildProviderSettingsResponse(
  settings: EffectiveApplicationSettings,
): ProviderSettingsResponse {
  const connections: ProviderConnectionResponse[] = [];
  for (const profile of settings.providerSettings.catalog) {
    const connection = settings.providerSettings.connections[profile.id];
    if (connection === undefined) {
      continue;
    }
    connections.push({
      apiTokenConfigured: connection.apiToken !== null,
      capabilityApiTokensConfigured: {
        answer: connection.answer.apiToken !== null,
        chat: (connection.chat ?? connection.answer).apiToken !== null,
        embedding: connection.embedding.apiToken !== null,
        queryExpansion: connection.queryExpansion.apiToken !== null,
        reranking: connection.reranking.apiToken !== null,
        speechToText: connection.speechToText.apiToken !== null,
        indexing: connection.indexing.apiToken !== null,
        textToSpeech: connection.textToSpeech.apiToken !== null,
      },
      configuration: readProviderConnectionConfiguration(connection),
      providerId: profile.id,
    });
  }
  const catalog: ProviderProfileResponse[] = settings.providerSettings.catalog.map((profile) => {
    return {
      adaptiveContextSupported: providerSupportsAdaptiveContext(profile),
      adapterConfiguration: profile.adapterConfiguration,
      authentication: profile.authentication,
      capabilities: profile.capabilities.map((capability) => ({ ...capability })),
      displayName: profile.displayName,
      id: profile.id,
    };
  });
  return {
    catalog,
    connections,
    featureOverrides: structuredClone(
      settings.providerSettings.featureOverrides,
    ),
    routing: { ...settings.providerSettings.routing },
  };
}

function buildStartupSettings(
  config: AppConfig,
  webConfig: WebConfig,
): StartupSettingResponse[] {
  return [
    {
      description: "The database CiteLoom uses for saved settings and application data.",
      key: "databaseUrl",
      label: "Database URL",
      value: redactDatabaseUrl(config.database.url),
    },
    {
      description: "How many database connections each CiteLoom process can keep open.",
      key: "databasePoolMax",
      label: "Maximum database connections",
      value: String(config.database.poolMax),
    },
    {
      description: "The network address where the web app listens.",
      key: "webHost",
      label: "Web host",
      value: webConfig.host,
    },
    {
      description: "The network port where the web app listens.",
      key: "webPort",
      label: "Web port",
      value: String(webConfig.port),
    },
    {
      description: "Where browser uploads are kept so they survive container restarts.",
      key: "uploadDirectory",
      label: "Upload directory",
      value: webConfig.uploadDirectory,
    },
  ];
}

function redactDatabaseUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}
