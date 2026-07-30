import {
  runtimeSettingChangeExamples,
  runtimeSettingDefinitions,
  type EffectiveApplicationSettings,
} from "../app/settings.js";
import {
  providerCatalog,
  readProviderAuthenticationMethod,
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
  type RuntimeSettingValue,
} from "../config/index.js";
import type { WebConfig } from "./config.js";
import {
  presentRuntimeSettingField,
  presentRuntimeSettingValue,
} from "./runtime-settings-boundary.js";

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
  embeddingInputFormats: EmbeddingInputFormatResponse[];
  fields: RuntimeSettingFieldResponse[];
  providers: ProviderSettingsResponse;
  startupSettings: StartupSettingResponse[];
  updatedAt: string | null;
  version: number;
  warnings: string[];
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
    summarization: boolean;
    textToSpeech: boolean;
  };
  configuration: ProviderConnectionConfiguration;
  providerId: ProviderId;
}

export interface ProviderProfileResponse {
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
): ApplicationSettingsResponse {
  const fields: RuntimeSettingFieldResponse[] = [];
  for (const definition of runtimeSettingDefinitions) {
    if (definition.providerManagedSetting === true) {
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
    const options = definition.key === "embeddingInputFormatId"
      ? settings.embeddingInputFormats
        .filter((inputFormat) => inputFormat.retiredAt === null)
        .map((inputFormat) => ({
          label: inputFormat.name,
          value: inputFormat.id,
        }))
      : definition.options ?? [];
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
      sensitive,
      source,
      step: presentation.step,
      unit: presentation.unit,
      value: sensitive ? null : effectiveValue,
    });
  }
  return {
    embeddingInputFormats: buildEmbeddingInputFormatResponses(settings),
    fields,
    providers: buildProviderSettingsResponse(settings),
    startupSettings: buildStartupSettings(startupConfig, webConfig),
    updatedAt: settings.updatedAt,
    version: settings.version,
    warnings: buildApplicationSettingsWarnings(settings),
  };
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
  if (settings.selectedEmbeddingSpaceDocumentCount > 0) {
    return warnings;
  }
  if (settings.indexedDocumentCount > 0) {
    warnings.push(
      "The selected embedding configuration has no indexed documents. Reindex documents before asking questions.",
    );
    return warnings;
  }
  warnings.push(
    "The selected embedding configuration has no indexed documents. Index a document before asking questions.",
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
        `${format.embeddingSpaceCount} embedding ${format.embeddingSpaceCount === 1 ? "space" : "spaces"}`,
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
  for (const profile of providerCatalog) {
    const connection = settings.providerSettings.connections[profile.id];
    connections.push({
      apiTokenConfigured: connection.apiToken !== null,
      capabilityApiTokensConfigured: {
        answer: connection.answer.apiToken !== null,
        chat: (connection.chat ?? connection.answer).apiToken !== null,
        embedding: connection.embedding.apiToken !== null,
        queryExpansion: connection.queryExpansion.apiToken !== null,
        reranking: connection.reranking.apiToken !== null,
        speechToText: connection.speechToText.apiToken !== null,
        summarization: connection.summarization.apiToken !== null,
        textToSpeech: connection.textToSpeech.apiToken !== null,
      },
      configuration: readProviderConnectionConfiguration(connection),
      providerId: profile.id,
    });
  }
  const catalog: ProviderProfileResponse[] = providerCatalog.map((profile) => {
    return {
      authentication: readProviderAuthenticationMethod(profile.id),
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
      label: "Database pool maximum",
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
