import {
  readArray,
  readBoolean,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullableFiniteNumber,
  readNullableNonEmptyString,
  readNullablePositiveInteger,
  readPlainObject,
  readPositiveInteger,
  readString,
} from "./citeloom-boundaries.js";
import { dispatchNotice } from "./citeloom-notices.js";
import { requestConfirmation } from "./citeloom-confirmation.js";
import {
  initializeSettingsHistory,
  readSettingsHistoryOwner,
  readSettingsLocation,
  writeSettingsLocation,
} from "./citeloom-settings-history.js";
import { createSettingsResetActions } from "./citeloom-settings-resets.js";
import {
  createSourceContentStorageActions,
} from "./citeloom-source-content-storage.js";
import {
  createSourceLibraryAdministrationActions,
} from "./citeloom-source-libraries.js";
import {
  createWorkspaceAdministrationActions,
} from "./citeloom-workspaces.js";
import {
  createWorkspaceUserManagement,
} from "./citeloom-workspace-users.js";

const providerCapabilities = Object.freeze([
  "answer",
  "chat",
  "queryExpansion",
  "indexing",
  "embedding",
  "reranking",
  "speechToText",
  "textToSpeech",
]);
const optionalProviderCapabilities = Object.freeze([
  "reranking",
  "speechToText",
  "textToSpeech",
]);
const modelProviderCapabilities = Object.freeze([
  "answer",
  "chat",
  "embedding",
  "queryExpansion",
  "indexing",
]);
const languageProviderCapabilities = Object.freeze([
  "answer",
  "chat",
  "queryExpansion",
  "indexing",
]);
const thinkingModes = Object.freeze(["auto", "disabled", "enabled"]);
const providerAdapterConfigurations = Object.freeze(["catalog", "connection"]);
const runtimeInputs = Object.freeze([
  "boolean",
  "number",
  "password",
  "select",
  "text",
  "url",
]);
const runtimeSources = Object.freeze(["database", "database-default"]);
const embeddingSpaceIdentityFieldKeys = Object.freeze([
  "embeddingDimensions",
  "embeddingInputFormatId",
  "embeddingSpaceId",
  "retrievalChunkTargetTokens",
  "retrievalWindowPolicy",
]);
const embeddingSpacePrimaryFieldKeys = Object.freeze([
  "embeddingDimensions",
  "embeddingInputFormatId",
  "retrievalWindowPolicy",
]);
const sourceFilters = Object.freeze([
  "all",
  "database",
  "database-default",
  "modified",
]);
const providerEditorSections = Object.freeze(["connection", "capabilities"]);
const providerAuthenticationMethods = Object.freeze([
  "api-token",
  "openai-device",
]);
const startupGroupName = "Startup and deployment";
const objectStorageAreaName = "Object storage";
const sourceLibraryAreaName = "Source libraries";
const workspaceAdministrationAreaName = "Workspaces";
const workspaceUsersAreaName = "Users & access";
const doclingAdvancedFieldKeys = Object.freeze([
  "doclingPdfBackend",
  "doclingTocEnabled",
  "doclingVlmMaxOutputTokens",
  "doclingVlmPrompt",
]);
const doclingVlmFieldKeys = Object.freeze([
  "doclingVlmMaxOutputTokens",
  "doclingVlmModelOverride",
  "doclingVlmPrompt",
  "doclingVlmProviderId",
]);

function readApplicationSettings(value) {
  const response = readPlainObject(value, "application settings");
  const features = readProviderFeatures(response.features);
  const embeddingInputFormats = readEmbeddingInputFormats(
    response.embeddingInputFormats,
  );
  const fields = readRuntimeSettingFields(response.fields);
  const embeddingSpace = response.embeddingSpace === null
    ? null
    : readEmbeddingSpaceStatus(response.embeddingSpace, fields);
  const providers = readProviderSettings(response.providers);
  const scope = readSettingsScope(response.scope);
  const startupSettings = readStartupSettings(response.startupSettings);
  const warnings = readConfigurationWarnings(response.warnings);
  return {
    embeddingSpace,
    embeddingInputFormats,
    features,
    fields,
    providers,
    scope,
    startupSettings,
    updatedAt: readNullableNonEmptyString(
      response.updatedAt,
      "settings update time",
    ),
    version: readNonNegativeInteger(response.version, "settings version"),
    warnings,
  };
}

function readProviderFeatures(value) {
  const values = readArray(value, "application features");
  const features = [];
  const capabilities = new Set();
  for (const value of values) {
    const feature = readPlainObject(value, "application feature");
    const capability = readEnum(
      feature.capability,
      providerCapabilities,
      "application feature capability",
    );
    if (capabilities.has(capability)) {
      throw new Error(`The ${capability} application feature appears more than once.`);
    }
    capabilities.add(capability);
    features.push({
      capability,
      description: readNonEmptyString(
        feature.description,
        "application feature description",
      ),
      label: readNonEmptyString(feature.label, "application feature label"),
      source: readEnum(
        feature.source,
        runtimeSources,
        "application feature source",
      ),
    });
  }
  if (features.length === 0) {
    throw new Error("At least one application feature is required.");
  }
  return features;
}

function readSettingsScope(value) {
  const scope = readPlainObject(value, "settings scope");
  const available = [];
  const kinds = new Set();
  for (const value of readArray(scope.available, "available settings scopes")) {
    const option = readPlainObject(value, "available settings scope");
    const kind = readEnum(
      option.kind,
      ["organization", "workspace"],
      "settings scope kind",
    );
    if (kinds.has(kind)) {
      throw new Error(`The ${kind} settings scope appears more than once.`);
    }
    kinds.add(kind);
    available.push({
      kind,
      label: readNonEmptyString(option.label, "settings scope label"),
    });
  }
  const kind = readEnum(
    scope.kind,
    ["organization", "workspace"],
    "active settings scope",
  );
  if (!kinds.has(kind)) {
    throw new Error("The active settings scope is unavailable.");
  }
  return {
    available,
    editableProviderConnections: readBoolean(
      scope.editableProviderConnections,
      "provider connection edit permission",
    ),
    kind,
    label: readNonEmptyString(scope.label, "active settings scope label"),
  };
}

function readEmbeddingSpaceStatus(value, fields) {
  const status = readPlainObject(value, "embedding-space status");
  const activeDocumentCount = readNonNegativeInteger(
    status.activeDocumentCount,
    "active embedding-space document count",
  );
  const dimensions = readPositiveInteger(
    status.dimensions,
    "embedding-space dimensions",
  );
  const totalDocumentCount = readNonNegativeInteger(
    status.totalDocumentCount,
    "indexed document count",
  );
  const dimensionField = fields.find((field) => {
    return field.key === "embeddingDimensions";
  });
  if (
    dimensionField === undefined
    || dimensionField.input !== "select"
    || !dimensionField.options.some((option) => option.value === dimensions)
  ) {
    throw new Error("The embedding-space dimensions response is invalid.");
  }
  if (activeDocumentCount > totalDocumentCount) {
    throw new Error("The embedding-space document counts are invalid.");
  }
  return {
    activeDocumentCount,
    dimensions,
    id: readNonEmptyString(status.id, "embedding-space ID"),
    totalDocumentCount,
  };
}

function readEmbeddingInputFormats(value) {
  const values = readArray(value, "search text formats");
  const formats = [];
  const ids = new Set();
  for (const value of values) {
    const format = readPlainObject(value, "search text format");
    const id = readNonEmptyString(format.id, "search text format ID");
    if (ids.has(id)) {
      throw new Error(`The search text format ${id} appears more than once.`);
    }
    ids.add(id);
    const blockers = [];
    for (const blocker of readArray(
      format.retirementBlockers,
      "search text format retirement blockers",
    )) {
      blockers.push(readNonEmptyString(
        blocker,
        "search text format retirement blocker",
      ));
    }
    formats.push({
      canRetire: readBoolean(
        format.canRetire,
        "search text format retirement state",
      ),
      createdAt: readNonEmptyString(
        format.createdAt,
        "search text format creation time",
      ),
      defaultSelected: readBoolean(
        format.defaultSelected,
        "search text format default state",
      ),
      documentTemplate: readString(
        format.documentTemplate,
        "search text format document template",
      ),
      embeddingSpaceCount: readNonNegativeInteger(
        format.embeddingSpaceCount,
        "search text format index count",
      ),
      id,
      inputFormatHash: readNonEmptyString(
        format.inputFormatHash,
        "search text format identifier",
      ),
      name: readNonEmptyString(format.name, "search text format name"),
      queryTemplate: readString(
        format.queryTemplate,
        "search text format query template",
      ),
      retiredAt: readNullableNonEmptyString(
        format.retiredAt,
        "search text format retirement time",
      ),
      retirementBlockers: blockers,
      schemaVersion: readPositiveInteger(
        format.schemaVersion,
        "search text format version",
      ),
      selected: readBoolean(
        format.selected,
        "search text format selected state",
      ),
    });
  }
  return formats;
}

function readConfigurationWarnings(value) {
  const values = readArray(value, "configuration warnings");
  const warnings = [];
  for (const warning of values) {
    warnings.push(readNonEmptyString(warning, "configuration warning"));
  }
  return warnings;
}

function readRuntimeSettingFields(value) {
  const values = readArray(value, "application settings");
  const fields = [];
  const keys = new Set();
  for (const value of values) {
    const field = readRuntimeSettingField(value);
    if (keys.has(field.key)) {
      throw new Error(`The application setting ${field.key} appears more than once.`);
    }
    keys.add(field.key);
    fields.push(field);
  }
  return fields;
}

function readRuntimeSettingPanel(value) {
  if (value === null) {
    return null;
  }
  const panel = readPlainObject(value, "setting panel");
  return {
    description: readNonEmptyString(
      panel.description,
      "setting panel description",
    ),
    id: readNonEmptyString(panel.id, "setting panel identifier"),
    label: readNonEmptyString(panel.label, "setting panel label"),
  };
}

function readRuntimeSettingField(value) {
  const field = readPlainObject(value, "application setting");
  const feature = field.feature === undefined || field.feature === null
    ? null
    : readEnum(field.feature, providerCapabilities, "setting feature");
  const input = readEnum(field.input, runtimeInputs, "setting input");
  const options = readRuntimeSettingOptions(field.options);
  if (input === "select" && options.length === 0) {
    throw new Error("A select setting must include at least one option.");
  }
  return {
    changeExample: readNonEmptyString(field.changeExample, "setting example"),
    configured: readBoolean(field.configured, "setting configured state"),
    defaultConfigured: readBoolean(
      field.defaultConfigured,
      "setting default configured state",
    ),
    defaultValue: readRuntimeSettingValue(field.defaultValue, "setting default"),
    description: readNonEmptyString(field.description, "setting description"),
    feature,
    group: readNonEmptyString(field.group, "setting group"),
    input,
    key: readNonEmptyString(field.key, "setting key"),
    label: readNonEmptyString(field.label, "setting label"),
    max: readNullableFiniteNumber(field.max, "setting maximum"),
    min: readNullableFiniteNumber(field.min, "setting minimum"),
    nullable: readBoolean(field.nullable, "setting nullable state"),
    options,
    panel: readRuntimeSettingPanel(field.panel),
    sensitive: readBoolean(field.sensitive, "setting sensitive state"),
    source: readEnum(field.source, runtimeSources, "setting source"),
    step: readNullableFiniteNumber(field.step, "setting step"),
    unit: readNullableNonEmptyString(field.unit, "setting unit"),
    value: readRuntimeSettingValue(field.value, "setting value"),
  };
}

function readRuntimeSettingOptions(value) {
  const values = readArray(value, "setting options");
  const options = [];
  const optionValues = new Set();
  for (const value of values) {
    const option = readPlainObject(value, "setting option");
    const optionValue = readStringOrFiniteNumber(
      option.value,
      "setting option value",
    );
    const optionKey = String(optionValue);
    if (optionValues.has(optionKey)) {
      throw new Error(`The setting option ${optionKey} appears more than once.`);
    }
    optionValues.add(optionKey);
    options.push({
      label: readNonEmptyString(option.label, "setting option label"),
      value: optionValue,
    });
  }
  return options;
}

function readRuntimeSettingValue(value, label) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`The ${label} response is invalid.`);
}

function readProviderSettings(value) {
  const providers = readPlainObject(value, "provider settings");
  const catalog = readProviderCatalog(providers.catalog);
  const adapterOptions = buildProviderAdapterOptions(catalog);
  const connections = readProviderConnections(
    providers.connections,
    adapterOptions,
  );
  const featureOverrides = providers.featureOverrides === undefined
    ? buildEmptyFeatureOverrides()
    : readFeatureOverrides(providers.featureOverrides);
  const routing = readProviderRouting(providers.routing);
  validateProviderRelationships(catalog, connections, routing);
  return {
    catalog,
    connections,
    featureOverrides,
    routing,
  };
}

function readProviderCatalog(value) {
  const values = readArray(value, "provider catalog");
  const catalog = [];
  const ids = new Set();
  for (const value of values) {
    const profile = readPlainObject(value, "provider profile");
    const id = readProviderId(profile.id, "provider profile ID");
    if (ids.has(id)) {
      throw new Error(`The provider profile ${id} appears more than once.`);
    }
    ids.add(id);
    catalog.push({
      adaptiveContextSupported: readBoolean(
        profile.adaptiveContextSupported,
        "provider automatic context support",
      ),
      adapterConfiguration: readEnum(
        profile.adapterConfiguration,
        providerAdapterConfigurations,
        "provider adapter configuration",
      ),
      authentication: readEnum(
        profile.authentication,
        providerAuthenticationMethods,
        "provider authentication method",
      ),
      capabilities: readProviderCapabilityProfiles(profile.capabilities),
      displayName: readNonEmptyString(
        profile.displayName,
        "provider display name",
      ),
      id,
    });
  }
  return catalog;
}

function readProviderCapabilityProfiles(value) {
  const values = readArray(value, "provider capabilities");
  const profiles = [];
  const capabilities = new Set();
  for (const value of values) {
    const profile = readPlainObject(value, "provider capability");
    const capability = readEnum(
      profile.capability,
      providerCapabilities,
      "provider capability",
    );
    if (capabilities.has(capability)) {
      throw new Error(`The provider capability ${capability} appears more than once.`);
    }
    capabilities.add(capability);
    profiles.push({
      adapter: readAdapterId(profile.adapter, "provider adapter ID"),
      capability,
    });
  }
  return profiles;
}

function buildProviderAdapterOptions(catalog) {
  const optionsByCapability = {};
  const adapterIdsByCapability = {};
  for (const capability of providerCapabilities) {
    optionsByCapability[capability] = [];
    adapterIdsByCapability[capability] = new Set();
  }
  for (const profile of catalog) {
    if (profile.authentication !== "api-token") {
      continue;
    }
    for (const entry of profile.capabilities) {
      const adapterIds = adapterIdsByCapability[entry.capability];
      if (adapterIds.has(entry.adapter)) {
        continue;
      }
      adapterIds.add(entry.adapter);
      optionsByCapability[entry.capability].push({
        label: entry.adapter,
        value: entry.adapter,
      });
    }
  }
  return optionsByCapability;
}

function readConfiguredAdapter(value, capability, adapterOptions) {
  const adapter = readAdapterId(value, `${capability} adapter ID`);
  const available = adapterOptions[capability].some((option) => {
    return option.value === adapter;
  });
  if (!available) {
    throw new Error(
      `The ${capability} adapter ${adapter} is not present in the provider catalog.`,
    );
  }
  return adapter;
}

function readProviderConnections(value, adapterOptions) {
  const values = readArray(value, "provider connections");
  const connections = [];
  const ids = new Set();
  for (const value of values) {
    const connection = readPlainObject(value, "provider connection");
    const providerId = readProviderId(
      connection.providerId,
      "provider connection ID",
    );
    if (ids.has(providerId)) {
      throw new Error(`The provider connection ${providerId} appears more than once.`);
    }
    ids.add(providerId);
    connections.push({
      apiTokenConfigured: readBoolean(
        connection.apiTokenConfigured,
        "provider credential state",
      ),
      capabilityApiTokensConfigured: readCapabilityCredentialStates(
        connection.capabilityApiTokensConfigured,
      ),
      configuration: readProviderConfiguration(
        connection.configuration,
        adapterOptions,
      ),
      providerId,
    });
  }
  return connections;
}

function readCapabilityCredentialStates(value) {
  const states = readPlainObject(value, "provider capability credential states");
  const normalized = {};
  for (const capability of providerCapabilities) {
    normalized[capability] = readBoolean(
      states[capability],
      `${capability} credential state`,
    );
  }
  return normalized;
}

function readProviderConfiguration(value, adapterOptions) {
  const configuration = readPlainObject(value, "provider configuration");
  return {
    adaptiveContextEnabled: readBoolean(
      configuration.adaptiveContextEnabled,
      "automatic context size state",
    ),
    answer: readProviderModelConfiguration(
      configuration.answer,
      "answer configuration",
    ),
    chat: readProviderModelConfiguration(
      configuration.chat,
      "chat configuration",
    ),
    baseUrl: readNullableNonEmptyString(
      configuration.baseUrl,
      "provider base URL",
    ),
    customAdapters: readCustomAdapters(
      configuration.customAdapters,
      adapterOptions,
    ),
    embedding: readProviderModelConfiguration(
      configuration.embedding,
      "embedding model settings",
    ),
    queryExpansion: readProviderModelConfiguration(
      configuration.queryExpansion,
      "query-expansion configuration",
    ),
    maximumParallelRequests: readBoundedProviderConcurrency(
      configuration.maximumParallelRequests,
    ),
    name: readNullableNonEmptyString(configuration.name, "provider name"),
    sendReasoningOptions: readBoolean(
      configuration.sendReasoningOptions,
      "provider reasoning control state",
    ),
    thinkingMode: readEnum(
      configuration.thinkingMode,
      thinkingModes,
      "provider thinking mode",
    ),
    reranking: readProviderCapabilityConfiguration(
      configuration.reranking,
      "search ranking settings",
    ),
    speechToText: readProviderCapabilityConfiguration(
      configuration.speechToText,
      "speech-to-text configuration",
    ),
    indexing: readProviderModelConfiguration(
      configuration.indexing,
      "indexing model configuration",
    ),
    textToSpeech: readTextToSpeechConfiguration(configuration.textToSpeech),
  };
}

function readProviderCapabilityConfiguration(value, label) {
  const configuration = readPlainObject(value, label);
  return {
    baseUrl: readNullableNonEmptyString(
      configuration.baseUrl,
      `${label} base URL`,
    ),
    model: readNullableNonEmptyString(configuration.model, `${label} model`),
  };
}

function readProviderModelConfiguration(value, label) {
  const configuration = readProviderCapabilityConfiguration(value, label);
  const source = readPlainObject(value, label);
  return {
    ...configuration,
    contextCapacityTokens: readNullablePositiveInteger(
      source.contextCapacityTokens,
      `${label} maximum input tokens`,
    ),
  };
}

function readBoundedProviderConcurrency(value) {
  const maximumParallelRequests = readPositiveInteger(
    value,
    "provider request limit",
  );
  if (maximumParallelRequests > 16) {
    throw new Error("Provider request limits cannot exceed 16.");
  }
  return maximumParallelRequests;
}

function readTextToSpeechConfiguration(value) {
  const configuration = readProviderCapabilityConfiguration(
    value,
    "text-to-speech configuration",
  );
  const source = readPlainObject(value, "text-to-speech configuration");
  return {
    baseUrl: configuration.baseUrl,
    model: configuration.model,
    voice: readNullableNonEmptyString(source.voice, "text-to-speech voice"),
  };
}

function readCustomAdapters(value, adapterOptions) {
  const adapters = readPlainObject(value, "custom provider adapters");
  const normalized = {};
  for (const capability of providerCapabilities) {
    normalized[capability] = readConfiguredAdapter(
      adapters[capability],
      capability,
      adapterOptions,
    );
  }
  return normalized;
}

function readFeatureOverrides(value) {
  const overrides = readPlainObject(value, "provider feature settings");
  const normalized = {};
  for (const capability of providerCapabilities) {
    const capabilityOverrides = readPlainObject(
      overrides[capability],
      `${capability} feature settings`,
    );
    normalized[capability] = {
      modelOverride: readNullableNonEmptyString(
        capabilityOverrides.modelOverride,
        `${capability} selected model`,
      ),
    };
    if (modelProviderCapabilities.includes(capability)) {
      normalized[capability].contextCapacityTokensOverride =
        readNullablePositiveInteger(
          capabilityOverrides.contextCapacityTokensOverride,
          `${capability} maximum input tokens`,
        );
    }
    if (languageProviderCapabilities.includes(capability)) {
      const thinkingModeOverride = capabilityOverrides.thinkingModeOverride;
      normalized[capability].thinkingModeOverride = thinkingModeOverride === null
        ? null
        : readEnum(
          thinkingModeOverride,
          thinkingModes,
          `${capability} thinking mode`,
        );
    }
  }
  const textToSpeech = readPlainObject(
    overrides.textToSpeech,
    "spoken answer settings",
  );
  normalized.textToSpeech.voiceOverride = readNullableNonEmptyString(
    textToSpeech.voiceOverride,
    "spoken answer voice",
  );
  return normalized;
}

function readProviderRouting(value) {
  const routing = readPlainObject(value, "feature provider selections");
  const normalized = {};
  for (const capability of providerCapabilities) {
    normalized[capability] = routing[capability] === null
      ? null
      : readProviderId(routing[capability], `${capability} provider selection`);
  }
  return normalized;
}

function validateProviderRelationships(
  catalog,
  connections,
  routing,
) {
  const profiles = new Map();
  for (const profile of catalog) {
    profiles.set(profile.id, profile);
  }
  const connectionIds = new Set();
  for (const connection of connections) {
    if (!profiles.has(connection.providerId)) {
      throw new Error(`Provider connection ${connection.providerId} has no profile.`);
    }
    connectionIds.add(connection.providerId);
  }
  for (const capability of providerCapabilities) {
    const providerId = routing[capability];
    if (providerId === null) {
      continue;
    }
    if (!connectionIds.has(providerId)) {
      throw new Error(`Routed provider ${providerId} has no connection.`);
    }
    const profile = profiles.get(providerId);
    const supported = profile.capabilities.some((entry) => {
      return entry.capability === capability;
    });
    if (!supported) {
      throw new Error(`Provider ${providerId} does not support ${capability}.`);
    }
  }
}

function readStartupSettings(value) {
  const values = readArray(value, "startup settings");
  const settings = [];
  const keys = new Set();
  for (const value of values) {
    const setting = readPlainObject(value, "startup setting");
    const key = readNonEmptyString(setting.key, "startup setting key");
    if (keys.has(key)) {
      throw new Error(`The startup setting ${key} appears more than once.`);
    }
    keys.add(key);
    settings.push({
      description: readNonEmptyString(
        setting.description,
        "startup setting description",
      ),
      key,
      label: readNonEmptyString(setting.label, "startup setting label"),
      value: readString(setting.value, "startup setting value"),
    });
  }
  return settings;
}

function readStringOrFiniteNumber(value, label) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`The ${label} response is invalid.`);
}

function readProviderId(value, label) {
  return readSettingsIdentifier(value, label);
}

function readAdapterId(value, label) {
  return readSettingsIdentifier(value, label);
}

function readSettingsIdentifier(value, label) {
  const identifier = readNonEmptyString(value, label);
  if (
    identifier.length > 64
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(identifier)
  ) {
    throw new Error(`The ${label} is invalid.`);
  }
  return identifier;
}

function buildEmptyFeatureOverrides() {
  return {
    answer: {
      contextCapacityTokensOverride: null,
      modelOverride: null,
      thinkingModeOverride: null,
    },
    chat: {
      contextCapacityTokensOverride: null,
      modelOverride: null,
      thinkingModeOverride: null,
    },
    embedding: {
      contextCapacityTokensOverride: null,
      modelOverride: null,
    },
    queryExpansion: {
      contextCapacityTokensOverride: null,
      modelOverride: null,
      thinkingModeOverride: null,
    },
    reranking: { modelOverride: null },
    speechToText: { modelOverride: null },
    indexing: {
      contextCapacityTokensOverride: null,
      modelOverride: null,
      thinkingModeOverride: null,
    },
    textToSpeech: { modelOverride: null, voiceOverride: null },
  };
}

function createDrafts(fields) {
  const drafts = {};
  for (const field of fields) {
    drafts[field.key] = createDraftValue(field, field.value);
  }
  return drafts;
}

function createDraftValue(field, value) {
  if (field.input === "boolean") {
    return value === true;
  }
  if (field.sensitive || value === null) {
    return "";
  }
  return String(value);
}

function groupRuntimeFields(fields) {
  const groupsByName = new Map();
  for (const field of fields) {
    if (field.feature !== null) {
      continue;
    }
    let group = groupsByName.get(field.group);
    if (group === undefined) {
      group = { fields: [], name: field.group };
      groupsByName.set(field.group, group);
    }
    group.fields.push(field);
  }
  return [...groupsByName.values()];
}

function buildRuntimeSettingPanels(fields) {
  const panels = [];
  const panelsById = new Map();
  for (const field of fields) {
    const id = field.panel?.id ?? field.key;
    let panel = panelsById.get(id);
    if (panel === undefined) {
      panel = {
        description: field.panel?.description ?? field.description,
        fields: [],
        id,
        label: field.panel?.label ?? field.label,
      };
      panelsById.set(id, panel);
      panels.push(panel);
    }
    panel.fields.push(field);
  }
  return panels;
}

function buildRuntimeSettingChanges(settings, drafts, pending) {
  const fieldsByKey = new Map();
  for (const field of settings.fields) {
    fieldsByKey.set(field.key, field);
  }
  const changes = [];
  for (const key of Object.keys(pending)) {
    const action = pending[key];
    if (action === "reset") {
      changes.push({ action: "reset", key });
      continue;
    }
    const field = fieldsByKey.get(key);
    if (field === undefined) {
      throw new Error(`Setting field is missing: ${key}.`);
    }
    if (!Object.hasOwn(drafts, key)) {
      throw new Error(`Setting value is missing: ${key}.`);
    }
    changes.push({
      action: "set",
      key,
      value: parseDraftValue(field, drafts[key]),
    });
  }
  return changes;
}

function parseDraftValue(field, draft) {
  if (field.input === "boolean") {
    return draft === true;
  }
  const text = String(draft).trim();
  if (field.input === "number") {
    const value = Number(text);
    if (!Number.isFinite(value)) {
      throw new Error(`${field.label} must be a number.`);
    }
    return value;
  }
  if (field.input === "select") {
    for (const option of field.options) {
      if (String(option.value) === text) {
        return option.value;
      }
    }
    throw new Error(`${field.label} has an invalid selection.`);
  }
  if (text === "" && field.nullable) {
    return null;
  }
  return text;
}

function buildProviderChanges(current, draft, credentialDrafts, credentialClears) {
  const changes = [];
  for (const draftConnection of draft.connections) {
    let currentConnection = null;
    for (const candidate of current.connections) {
      if (candidate.providerId === draftConnection.providerId) {
        currentConnection = candidate;
        break;
      }
    }
    if (currentConnection === null) {
      throw new Error(`Provider connection is missing: ${draftConnection.providerId}.`);
    }
    if (
      JSON.stringify(currentConnection.configuration)
      !== JSON.stringify(draftConnection.configuration)
    ) {
      changes.push({
        action: "configure",
        configuration: draftConnection.configuration,
        providerId: draftConnection.providerId,
      });
    }
  }
  for (const capability of providerCapabilities) {
    const currentConfiguration = buildFeatureConfiguration(current, capability);
    const draftConfiguration = buildFeatureConfiguration(draft, capability);
    if (JSON.stringify(currentConfiguration) !== JSON.stringify(draftConfiguration)) {
      changes.push({ action: "feature", configuration: draftConfiguration });
    }
  }
  for (const profile of draft.catalog) {
    if (credentialClears.includes(profile.id)) {
      changes.push({
        action: "credential",
        providerId: profile.id,
        target: "shared",
        value: null,
      });
      continue;
    }
    const value = credentialDrafts[profile.id];
    const credential = typeof value === "string" ? value.trim() : "";
    if (credential !== "") {
      changes.push({
        action: "credential",
        providerId: profile.id,
        target: "shared",
        value: credential,
      });
    }
  }
  return changes;
}

function buildFeatureConfiguration(providers, capability) {
  const modelOverride = providers.featureOverrides[capability].modelOverride;
  const providerId = providers.routing[capability];
  if (capability === "textToSpeech") {
    return {
      capability,
      modelOverride,
      providerId,
      voiceOverride: providers.featureOverrides.textToSpeech.voiceOverride,
    };
  }
  if (languageProviderCapabilities.includes(capability)) {
    return {
      capability,
      contextCapacityTokensOverride:
        providers.featureOverrides[capability].contextCapacityTokensOverride,
      modelOverride,
      providerId,
      thinkingModeOverride:
        providers.featureOverrides[capability].thinkingModeOverride,
    };
  }
  if (capability === "embedding") {
    return {
      capability,
      contextCapacityTokensOverride:
        providers.featureOverrides.embedding.contextCapacityTokensOverride,
      modelOverride,
      providerId,
    };
  }
  return { capability, modelOverride, providerId };
}

function readEffectiveFeatureModel(providers, capability) {
  const override = providers.featureOverrides[capability].modelOverride;
  if (override !== null) {
    return override;
  }
  const providerId = providers.routing[capability];
  if (providerId === null) {
    return null;
  }
  const connection = providers.connections.find((candidate) => {
    return candidate.providerId === providerId;
  });
  return connection?.configuration[capability].model ?? null;
}

function readEffectiveEmbeddingContextCapacity(providers) {
  const override = providers.featureOverrides.embedding
    .contextCapacityTokensOverride;
  if (override !== null) {
    return override;
  }
  const providerId = providers.routing.embedding;
  if (providerId === null) {
    return null;
  }
  const connection = providers.connections.find((candidate) => {
    return candidate.providerId === providerId;
  });
  return connection?.configuration.embedding.contextCapacityTokens ?? null;
}

function cloneProviderDrafts(providerDrafts, alpine) {
  const rawProviderDrafts = alpine.raw(providerDrafts);
  return structuredClone(rawProviderDrafts);
}

function readSettingsResponse(response, label) {
  return readJsonResponse(response, label, readApplicationSettings);
}

function readEmbeddingInputFormatMutationResponse(value) {
  const response = readPlainObject(value, "search text format update");
  return {
    id: readNonEmptyString(response.id, "search text format ID"),
  };
}

function readOpenAICodexAuthResponse(value) {
  const response = readPlainObject(value, "OpenAI Codex authentication");
  const connection = readPlainObject(
    response.connection,
    "OpenAI Codex connection",
  );
  return {
    connection: {
      expiresAt: readNullableNonEmptyString(
        connection.expiresAt,
        "OpenAI Codex expiry time",
      ),
      state: readEnum(
        connection.state,
        ["connected", "disconnected", "reauth-required"],
        "OpenAI Codex connection state",
      ),
      updatedAt: readNullableNonEmptyString(
        connection.updatedAt,
        "OpenAI Codex credential update time",
      ),
    },
    flow: response.flow === null
      ? null
      : readOpenAICodexFlow(response.flow),
  };
}

function readOpenAICodexFlow(value) {
  const flow = readPlainObject(value, "OpenAI Codex device flow");
  return {
    error: readNullableNonEmptyString(flow.error, "OpenAI Codex flow error"),
    expiresAt: readNonEmptyString(
      flow.expiresAt,
      "OpenAI Codex flow expiry",
    ),
    flowId: readNonEmptyString(flow.flowId, "OpenAI Codex flow ID"),
    state: readEnum(
      flow.state,
      ["cancelled", "connected", "exchanging", "expired", "failed", "pending"],
      "OpenAI Codex flow state",
    ),
    userCode: flow.userCode === undefined
      ? null
      : readNonEmptyString(flow.userCode, "OpenAI Codex user code"),
    verificationUrl: flow.verificationUrl === undefined
      ? null
      : readNonEmptyString(
        flow.verificationUrl,
        "OpenAI Codex verification URL",
      ),
  };
}

function readOpenAICodexModelsResponse(value) {
  const response = readPlainObject(value, "OpenAI Codex models");
  const values = readArray(response.models, "OpenAI Codex models");
  const models = [];
  for (const value of values) {
    const model = readPlainObject(value, "OpenAI Codex model");
    models.push({
      id: readNonEmptyString(model.id, "OpenAI Codex model ID"),
      name: readNonEmptyString(model.name, "OpenAI Codex model name"),
    });
  }
  return models;
}

export function registerPage(alpine) {
  let rememberedSettingsScope = null;

  alpine.data("citeloomSettingsPage", () => ({
    abortController: null,
    credentialClears: [],
    credentialDrafts: {},
    drafts: {},
    doclingAdvancedExpanded: false,
    errorMessage: "",
    featureCapabilities: [],
    featureAdvancedOpen: false,
    featureFieldsByCapability: {},
    featureDefinitionsByCapability: {},
    groups: [],
    inputFormatBusy: false,
    inputFormatDraft: null,
    inputFormatEditorMode: null,
    loading: true,
    locationStateRestored: false,
    openAICodexAuth: null,
    openAICodexBusy: false,
    openAICodexModels: [],
    openAICodexPollTimer: null,
    pending: {},
    compatibleProvidersByCapability: {},
    providerConnectionsById: {},
    providerAdapterOptionsByCapability: {},
    providerDrafts: null,
    providerEditorSection: "capabilities",
    providerProfilesById: {},
    query: "",
    reloadAfterSave: false,
    restoringHistory: false,
    saved: false,
    saving: false,
    selectedArea: null,
    selectedFeatureCapability: null,
    selectedProviderCapability: null,
    selectedProviderId: null,
    selectedRuntimeFieldKey: null,
    selectedStartupKey: null,
    settings: null,
    settingsScopeRequest: rememberedSettingsScope,
    settingsRevision: null,
    settingsRevisionListener: null,
    settingsHistoryListener: null,
    sourceFilter: "all",
    ...createSettingsResetActions(alpine),
    ...createSourceContentStorageActions(),
    ...createSourceLibraryAdministrationActions(),
    ...createWorkspaceAdministrationActions(),
    ...createWorkspaceUserManagement({
      title: "Users & access",
    }),

    get areaCount() {
      return this.groups.length
        + 2
        + (this.settings?.scope.editableProviderConnections === true ? 4 : 0);
    },

    get organizationSettingsVisible() {
      return this.settings?.scope.editableProviderConnections === true;
    },

    get browsingAreas() {
      return this.query.trim() === ""
        && this.selectedArea === null
        && this.sourceFilter === "all";
    },

    get filteredFields() {
      const fields = [];
      const query = this.query.trim().toLocaleLowerCase();
      for (const group of this.groups) {
        for (const field of group.fields) {
          if (this.selectedArea !== null && field.group !== this.selectedArea) {
            continue;
          }
          if (this.sourceFilter === "database" && field.source !== "database") {
            continue;
          }
          if (
            this.sourceFilter === "database-default"
            && field.source !== "database-default"
          ) {
            continue;
          }
          if (this.sourceFilter === "modified" && !Object.hasOwn(this.pending, field.key)) {
            continue;
          }
          if (this.settingMatchesSearch(field, query)) {
            fields.push(field);
          }
        }
      }
      return fields;
    },

    get filteredRuntimePanels() {
      return buildRuntimeSettingPanels(this.filteredFields);
    },

    get providerChanges() {
      if (this.settings === null || this.providerDrafts === null) {
        return [];
      }
      return buildProviderChanges(
        this.settings.providers,
        this.providerDrafts,
        this.credentialDrafts,
        this.credentialClears,
      );
    },

    get changeCount() {
      return Object.keys(this.pending).length + this.providerChanges.length;
    },

    get canSave() {
      return !this.saving && this.settings !== null && this.changeCount > 0;
    },

    get selectedProviderProfile() {
      if (this.selectedProviderId === null) {
        return null;
      }
      return this.providerProfilesById[this.selectedProviderId] ?? null;
    },

    get selectedProviderConnection() {
      if (this.selectedProviderId === null) {
        return null;
      }
      return this.providerConnectionsById[this.selectedProviderId] ?? null;
    },

    async initialize() {
      initializeSettingsHistory();
      this.settingsHistoryListener = (event) => {
        if (readSettingsHistoryOwner(event.state) !== "settings") {
          return;
        }
        this.restoreLocationState();
      };
      window.addEventListener("popstate", this.settingsHistoryListener);
      this.settingsRevisionListener = (event) => {
        if (typeof event.detail !== "string") {
          return;
        }
        if (this.settingsRevision === null) {
          this.settingsRevision = event.detail;
          if (this.settings !== null) {
            if (this.saving || this.inputFormatBusy) {
              this.reloadAfterSave = true;
            } else {
              void this.loadSettings();
            }
          }
          return;
        }
        if (this.settingsRevision === event.detail) {
          return;
        }
        this.settingsRevision = event.detail;
        if (this.saving || this.inputFormatBusy) {
          this.reloadAfterSave = true;
        } else {
          void this.loadSettings();
        }
      };
      window.addEventListener(
        "citeloom:settings-revision",
        this.settingsRevisionListener,
      );
      await this.loadSettings();
      if (this.organizationSettingsVisible) {
        await Promise.all([
          this.loadOpenAICodexAuth(),
          this.loadSourceContentStorage(),
          this.loadSourceLibraryAdministration(),
          this.loadWorkspaceAdministration(),
        ]);
      } else {
        await this.loadUsers();
      }
    },

    destroy() {
      this.abortController?.abort();
      this.destroySourceContentStorage();
      this.destroySourceLibraryAdministration();
      this.destroyWorkspaceAdministration();
      this.destroyUserManagement();
      if (this.openAICodexPollTimer !== null) {
        clearTimeout(this.openAICodexPollTimer);
      }
      if (this.settingsRevisionListener !== null) {
        window.removeEventListener(
          "citeloom:settings-revision",
          this.settingsRevisionListener,
        );
      }
      if (this.settingsHistoryListener !== null) {
        window.removeEventListener("popstate", this.settingsHistoryListener);
      }
    },

    async loadSettings() {
      this.abortController?.abort();
      const controller = new AbortController();
      this.abortController = controller;
      this.loading = true;
      this.errorMessage = "";
      try {
        const response = await fetch(this.settingsRequestUrl(), {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        const settings = await readSettingsResponse(response, "Settings request");
        this.applySettings(settings);
      } catch (error) {
        if (!controller.signal.aborted) {
          this.errorMessage = error instanceof Error
            ? error.message
            : "The settings request failed.";
        }
      } finally {
        if (!controller.signal.aborted) {
          this.loading = false;
        }
      }
    },

    settingsRequestUrl() {
      const scope = this.settingsScopeRequest ?? this.settings?.scope.kind;
      if (scope === null || scope === undefined) {
        return "/api/settings";
      }
      return `/api/settings?scope=${encodeURIComponent(scope)}`;
    },

    async changeSettingsScope(scope) {
      const normalized = readEnum(
        scope,
        ["organization", "workspace"],
        "selected settings scope",
      );
      const activeScope = this.settings?.scope.kind;
      if (activeScope === undefined) {
        return;
      }
      if (normalized === activeScope || this.loading) {
        this.settingsScopeRequest = activeScope;
        return;
      }
      if (this.changeCount > 0) {
        const confirmed = await requestConfirmation({
          cancelLabel: "Keep editing",
          confirmLabel: "Discard changes",
          description: "Unsaved settings changes will be discarded when you switch scope.",
          title: "Switch settings scope?",
          tone: "danger",
        });
        if (!confirmed) {
          this.settingsScopeRequest = activeScope;
          return;
        }
      }
      this.settingsScopeRequest = normalized;
      this.selectedArea = null;
      this.locationStateRestored = false;
      await this.loadSettings();
      this.settingsScopeRequest = this.settings.scope.kind;
      if (this.organizationSettingsVisible) {
        this.destroyUserManagement();
        await Promise.all([
          this.loadOpenAICodexAuth(),
          this.loadSourceContentStorage(),
          this.loadSourceLibraryAdministration(),
          this.loadWorkspaceAdministration(),
        ]);
      } else {
        this.destroySourceContentStorage();
        this.destroySourceLibraryAdministration();
        this.destroyWorkspaceAdministration();
        if (this.openAICodexPollTimer !== null) {
          clearTimeout(this.openAICodexPollTimer);
          this.openAICodexPollTimer = null;
        }
        this.openAICodexAuth = null;
        this.sourceContentStorage = null;
        await this.loadUsers();
      }
    },

    async loadOpenAICodexAuth() {
      try {
        const response = await fetch("/api/providers/openai-codex/auth", {
          headers: { accept: "application/json" },
        });
        const auth = await readJsonResponse(
          response,
          "OpenAI Codex authentication request",
          readOpenAICodexAuthResponse,
        );
        const currentFlow = this.openAICodexAuth?.flow ?? null;
        if (
          auth.flow !== null
          && currentFlow !== null
          && auth.flow.flowId === currentFlow.flowId
        ) {
          auth.flow.userCode = currentFlow.userCode;
          auth.flow.verificationUrl = currentFlow.verificationUrl;
        }
        this.openAICodexAuth = auth;
        if (
          auth.flow?.state === "pending"
          || auth.flow?.state === "exchanging"
        ) {
          this.scheduleOpenAICodexAuthRefresh();
        }
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error
            ? error.message
            : "The OpenAI Codex authentication status could not be loaded.",
        );
      }
    },

    scheduleOpenAICodexAuthRefresh() {
      if (this.openAICodexPollTimer !== null) {
        clearTimeout(this.openAICodexPollTimer);
      }
      this.openAICodexPollTimer = setTimeout(() => {
        this.openAICodexPollTimer = null;
        void this.loadOpenAICodexAuth();
      }, 2_000);
    },

    async startOpenAICodexSignIn() {
      this.openAICodexBusy = true;
      try {
        const response = await fetch(
          "/api/providers/openai-codex/device-authorization",
          {
            headers: { accept: "application/json" },
            method: "POST",
          },
        );
        const flow = await readJsonResponse(
          response,
          "OpenAI Codex sign-in request",
          readOpenAICodexFlow,
        );
        this.openAICodexAuth = {
          connection: this.openAICodexAuth?.connection ?? {
            expiresAt: null,
            state: "disconnected",
            updatedAt: null,
          },
          flow,
        };
        if (flow.verificationUrl !== null) {
          window.open(flow.verificationUrl, "_blank", "noopener,noreferrer");
        }
        this.scheduleOpenAICodexAuthRefresh();
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error
            ? error.message
            : "OpenAI Codex sign-in could not be started.",
        );
      } finally {
        this.openAICodexBusy = false;
      }
    },

    async cancelOpenAICodexSignIn() {
      this.openAICodexBusy = true;
      try {
        const response = await fetch(
          "/api/providers/openai-codex/device-authorization",
          {
            headers: { accept: "application/json" },
            method: "DELETE",
          },
        );
        await readJsonResponse(
          response,
          "OpenAI Codex sign-in cancellation",
          (value) => readPlainObject(value, "OpenAI Codex cancellation"),
        );
        await this.loadOpenAICodexAuth();
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error
            ? error.message
            : "OpenAI Codex sign-in could not be cancelled.",
        );
      } finally {
        this.openAICodexBusy = false;
      }
    },

    async disconnectOpenAICodex() {
      this.openAICodexBusy = true;
      try {
        const response = await fetch("/api/providers/openai-codex/auth", {
          headers: { accept: "application/json" },
          method: "DELETE",
        });
        if (!response.ok) {
          await readJsonResponse(
            response,
            "OpenAI Codex disconnect",
            (value) => value,
          );
        }
        this.openAICodexModels = [];
        await this.loadOpenAICodexAuth();
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error
            ? error.message
            : "OpenAI Codex could not be disconnected.",
        );
      } finally {
        this.openAICodexBusy = false;
      }
    },

    async loadOpenAICodexModels() {
      this.openAICodexBusy = true;
      try {
        const response = await fetch("/api/providers/openai-codex/models", {
          headers: { accept: "application/json" },
        });
        this.openAICodexModels = await readJsonResponse(
          response,
          "OpenAI Codex model request",
          readOpenAICodexModelsResponse,
        );
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error
            ? error.message
            : "The OpenAI Codex model catalog could not be loaded.",
        );
      } finally {
        this.openAICodexBusy = false;
      }
    },

    openAICodexConnectionLabel() {
      const state = this.openAICodexAuth?.connection.state ?? "disconnected";
      if (state === "connected") {
        return "Connected";
      }
      if (state === "reauth-required") {
        return "Sign-in renewal required";
      }
      return "Not connected";
    },

    providerUsesDeviceAuth() {
      return this.selectedProviderProfile?.authentication === "openai-device";
    },

    applySettings(settings) {
      this.replaceProviderDrafts(structuredClone(settings.providers));
      this.credentialDrafts = {};
      this.credentialClears = [];
      this.pending = {};
      this.drafts = createDrafts(settings.fields);
      this.groups = groupRuntimeFields(settings.fields);
      const featureFieldsByCapability = {};
      const featureDefinitionsByCapability = {};
      this.featureCapabilities = settings.features.map((feature) => {
        featureDefinitionsByCapability[feature.capability] = feature;
        return feature.capability;
      });
      for (const capability of this.featureCapabilities) {
        featureFieldsByCapability[capability] = [];
      }
      for (const field of settings.fields) {
        if (field.feature !== null) {
          featureFieldsByCapability[field.feature].push(field);
        }
      }
      this.featureFieldsByCapability = featureFieldsByCapability;
      this.featureDefinitionsByCapability = featureDefinitionsByCapability;
      if (!this.featureCapabilities.includes(this.selectedFeatureCapability)) {
        this.selectedFeatureCapability = this.featureCapabilities[0];
      }
      const currentProviderStillExists = settings.providers.catalog.some((profile) => {
        return profile.id === this.selectedProviderId;
      });
      if (!currentProviderStillExists) {
        this.selectedProviderId = settings.providers.catalog[0]?.id ?? null;
      }
      const selectedCapabilityStillExists = this.selectedProviderProfile
        ?.capabilities.some((entry) => {
          return entry.capability === this.selectedProviderCapability;
        }) ?? false;
      if (!selectedCapabilityStillExists) {
        this.selectedProviderCapability =
          this.selectedProviderProfile?.capabilities[0]?.capability ?? null;
      }
      this.settings = settings;
      this.settingsScopeRequest = settings.scope.kind;
      rememberedSettingsScope = settings.scope.kind;
      if (!this.locationStateRestored) {
        this.locationStateRestored = true;
        this.restoreLocationState();
      }
    },

    areaExists(area) {
      if (area === "Application Features") {
        return true;
      }
      if (
        this.organizationSettingsVisible
        && (
          area === "Providers"
          || area === objectStorageAreaName
          || area === sourceLibraryAreaName
          || area === startupGroupName
          || area === workspaceAdministrationAreaName
        )
      ) {
        return true;
      }
      if (!this.organizationSettingsVisible && area === workspaceUsersAreaName) {
        return true;
      }
      return this.groups.some((group) => group.name === area);
    },

    currentLocationState() {
      const location = {
        area: this.selectedArea,
        capability: null,
        item: null,
        section: null,
      };
      if (this.selectedArea === "Application Features") {
        location.item = this.selectedFeatureCapability;
        return location;
      }
      if (this.selectedArea === "Providers") {
        location.item = this.selectedProviderId;
        location.section = this.providerEditorSection;
        if (this.providerEditorSection === "capabilities") {
          location.capability = this.selectedProviderCapability;
        }
        return location;
      }
      if (this.selectedArea === startupGroupName) {
        location.item = this.selectedStartupKey;
        return location;
      }
      if (
        this.selectedArea === objectStorageAreaName
        || this.selectedArea === sourceLibraryAreaName
        || this.selectedArea === workspaceAdministrationAreaName
        || this.selectedArea === workspaceUsersAreaName
      ) {
        return location;
      }
      if (this.selectedArea !== null) {
        location.item = this.activeRuntimePanel()?.id ?? null;
      }
      return location;
    },

    recordLocationState() {
      if (this.restoringHistory || this.settings === null) {
        return;
      }
      writeSettingsLocation(this.currentLocationState());
    },

    restoreLocationState() {
      if (this.settings === null) {
        return;
      }
      const location = readSettingsLocation();
      if (location === null) {
        return;
      }
      this.restoringHistory = true;
      try {
        this.query = "";
        this.sourceFilter = "all";
        if (location.area === null || !this.areaExists(location.area)) {
          this.selectedArea = null;
          return;
        }
        this.selectArea(location.area);
        if (location.area === "Application Features") {
          const capability = this.featureCapabilities.includes(location.item)
            ? location.item
            : this.featureCapabilities[0];
          this.selectFeature(capability);
          return;
        }
        if (location.area === "Providers") {
          this.restoreProviderLocation(location);
          return;
        }
        if (location.area === startupGroupName) {
          if (location.item !== null) {
            this.selectStartupSetting(location.item);
          }
          return;
        }
        if (
          location.area === objectStorageAreaName
          || location.area === sourceLibraryAreaName
          || location.area === workspaceAdministrationAreaName
          || location.area === workspaceUsersAreaName
        ) {
          return;
        }
        if (location.item !== null) {
          this.selectRuntimePanel(location.item);
        }
      } finally {
        this.restoringHistory = false;
      }
    },

    restoreProviderLocation(location) {
      const fallbackProviderId = this.settings?.providers.catalog[0]?.id ?? null;
      const providerId = location.item !== null
        && Object.hasOwn(this.providerProfilesById, location.item)
        ? location.item
        : fallbackProviderId;
      if (providerId === null) {
        return;
      }
      this.selectProvider(providerId);
      if (location.section === "connection") {
        this.selectProviderEditorSection("connection");
        return;
      }
      if (location.capability === null) {
        return;
      }
      const capabilityIsAvailable = this.selectedProviderProfile
        ?.capabilities.some((entry) => {
          return entry.capability === location.capability;
        }) ?? false;
      if (capabilityIsAvailable) {
        this.selectProviderCapability(location.capability);
      }
    },

    selectArea(area) {
      this.selectedArea = area;
      if (area === startupGroupName) {
        this.selectedStartupKey = this.settings?.startupSettings[0]?.key ?? null;
      } else {
        for (const group of this.groups) {
          if (group.name === area) {
            this.selectedRuntimeFieldKey = group.fields[0]?.key ?? null;
            break;
          }
        }
      }
      this.recordLocationState();
    },

    clearSearch() {
      this.query = "";
      this.selectedArea = null;
      this.sourceFilter = "all";
      this.recordLocationState();
    },

    changeSearchQuery() {
      const changedArea = this.selectedArea !== null;
      this.selectedArea = null;
      if (changedArea) {
        this.recordLocationState();
      }
    },

    changeSourceFilter(value) {
      this.sourceFilter = readEnum(value, sourceFilters, "source filter");
      if (this.selectedArea === startupGroupName) {
        this.selectedArea = null;
        this.recordLocationState();
      }
    },

    fieldMatchesSearch(field, normalizedQuery) {
      const searchableValues = [
        field.label,
        field.description,
        field.changeExample,
        field.group,
      ];
      if (field.panel !== null) {
        searchableValues.push(field.panel.label, field.panel.description);
      }
      for (const value of searchableValues) {
        if (value.toLocaleLowerCase().includes(normalizedQuery)) {
          return true;
        }
      }
      return false;
    },

    settingMatchesSearch(field, normalizedQuery) {
      if (normalizedQuery === "" || this.fieldMatchesSearch(field, normalizedQuery)) {
        return true;
      }
      if (field.panel === null || this.settings === null) {
        return false;
      }
      for (const candidate of this.settings.fields) {
        if (
          candidate.panel?.id === field.panel.id
          && this.fieldMatchesSearch(candidate, normalizedQuery)
        ) {
          return true;
        }
      }
      return false;
    },

    resultLabel() {
      if (this.selectedArea !== null) {
        return this.selectedArea;
      }
      const query = this.query.trim();
      return query === "" ? "Filtered settings" : `Results for “${query}”`;
    },

    formatSettingCount(count) {
      return `${count} ${count === 1 ? "setting" : "settings"}`;
    },

    runtimePanelBadgeClass(panel) {
      const field = panel.fields[0];
      if (panel.fields.length !== 1 || field === undefined) {
        return "";
      }
      return this.fieldSourceClass(field);
    },

    runtimePanelBadgeLabel(panel) {
      if (this.isDoclingPanel(panel)) {
        if (panel.id === "docling-connection") {
          return "Configured";
        }
        if (panel.id === "docling-pdf-processing") {
          return String(this.drafts.doclingPipeline ?? "standard").toUpperCase();
        }
        if (panel.id === "docling-performance") {
          return `${this.drafts.doclingMaxTimeoutSeconds ?? "-"}s max`;
        }
        if (panel.id === "docling-diagnostics") {
          return this.drafts.doclingPerformanceMetricsEnabled === true
            ? "Enabled"
            : "Disabled";
        }
      }
      const field = panel.fields[0];
      if (panel.fields.length !== 1 || field === undefined) {
        return this.formatSettingCount(panel.fields.length);
      }
      return this.fieldSourceLabel(field);
    },

    runtimePanelIcon(panel) {
      if (panel.id === "docling-connection") {
        return "./assets/images/citeloom-icons.svg#citeloom-link";
      }
      if (panel.id === "docling-pdf-processing") {
        return "./assets/images/citeloom-icons.svg#citeloom-documents";
      }
      if (panel.id === "docling-performance") {
        return "./assets/images/citeloom-icons.svg#citeloom-clock";
      }
      if (panel.id === "docling-diagnostics") {
        return "./assets/images/citeloom-icons.svg#citeloom-health";
      }
      return "./assets/images/citeloom-icons.svg#citeloom-stack";
    },

    isDoclingPanel(panel) {
      return panel.fields[0]?.group === "Docling";
    },

    isDoclingPdfPanel(panel) {
      return panel.id === "docling-pdf-processing";
    },

    runtimeVisiblePanelFields(panel) {
      const fields = [];
      for (const field of panel.fields) {
        if (this.runtimeFieldVisible(field)) {
          fields.push(field);
        }
      }
      return fields;
    },

    runtimeFieldVisible(field) {
      if (
        doclingVlmFieldKeys.includes(field.key)
        && this.drafts.doclingPipeline !== "vlm"
      ) {
        return false;
      }
      if (
        doclingAdvancedFieldKeys.includes(field.key)
        && !this.doclingAdvancedExpanded
        && this.query.trim() === ""
      ) {
        return false;
      }
      return true;
    },

    runtimeFieldIsWide(field) {
      return field.key === "doclingPipeline"
        || field.key === "doclingOcrEnabled"
        || field.key === "doclingVlmPrompt"
        || field.key === "doclingSecondaryImageScale";
    },

    runtimeFieldStartsSection(field) {
      return field.key === "doclingOcrEnabled";
    },

    toggleDoclingAdvanced() {
      this.doclingAdvancedExpanded = !this.doclingAdvancedExpanded;
    },

    doclingPipelineGuidance() {
      if (this.drafts.doclingPipeline === "vlm") {
        return "VLM processing reads every PDF page visually with the selected provider and model. It is best suited to scanned documents and complex layouts, and usually takes longer than Standard processing.";
      }
      return "Standard processing uses Docling's layout, OCR, and table models. It is usually faster and remains the default for new PDF conversions.";
    },

    selectRuntimePanel(id) {
      const panel = this.filteredRuntimePanels.find((candidate) => {
        return candidate.id === id;
      });
      const firstField = panel?.fields[0];
      if (firstField === undefined) {
        return;
      }
      this.selectedRuntimeFieldKey = firstField.key;
      this.recordLocationState();
    },

    activeRuntimePanel() {
      for (const panel of this.filteredRuntimePanels) {
        for (const field of panel.fields) {
          if (field.key === this.selectedRuntimeFieldKey) {
            return panel;
          }
        }
      }
      return this.filteredRuntimePanels[0] ?? null;
    },

    activeRuntimePanelSelection() {
      const panel = this.activeRuntimePanel();
      return panel === null ? [] : [panel];
    },

    selectedEmbeddingInputFormat() {
      if (this.settings === null) {
        return null;
      }
      return this.settings.embeddingInputFormats.find((format) => {
        return format.id === this.drafts.embeddingInputFormatId;
      }) ?? null;
    },

    activeEmbeddingInputFormat() {
      if (this.settings === null) {
        return null;
      }
      return this.settings.embeddingInputFormats.find((format) => {
        return format.selected;
      }) ?? null;
    },

    embeddingSpaceChangePending() {
      if (this.settings === null || this.providerDrafts === null) {
        return false;
      }
      for (const key of embeddingSpaceIdentityFieldKeys) {
        if (Object.hasOwn(this.pending, key)) {
          return true;
        }
      }
      const currentModel = readEffectiveFeatureModel(
        this.settings.providers,
        "embedding",
      );
      const draftModel = readEffectiveFeatureModel(
        this.providerDrafts,
        "embedding",
      );
      if (currentModel !== draftModel) {
        return true;
      }
      const currentCapacity = readEffectiveEmbeddingContextCapacity(
        this.settings.providers,
      );
      const draftCapacity = readEffectiveEmbeddingContextCapacity(
        this.providerDrafts,
      );
      return currentCapacity !== draftCapacity;
    },

    embeddingSpaceImpactMessage() {
      const total = this.settings?.embeddingSpace.totalDocumentCount ?? 0;
      if (total === 0) {
        return "Saving changes the active embedding space. New documents will use the new settings.";
      }
      const noun = total === 1 ? "document" : "documents";
      return `Saving changes the active embedding space. Up to ${total} indexed ${noun} may require reindexing before they are searchable in the new space.`;
    },

    embeddingSpaceCoverageLabel() {
      const status = this.settings?.embeddingSpace;
      if (status === undefined) {
        return "Unavailable";
      }
      return `${status.activeDocumentCount} of ${status.totalDocumentCount}`;
    },

    embeddingSpaceNeedsReindex() {
      const status = this.settings?.embeddingSpace;
      if (status === undefined) {
        return false;
      }
      return status.activeDocumentCount < status.totalDocumentCount;
    },

    embeddingSpaceReindexMessage() {
      const status = this.settings?.embeddingSpace;
      if (status === undefined) {
        return "";
      }
      const count = status.totalDocumentCount - status.activeDocumentCount;
      const noun = count === 1 ? "document needs" : "documents need";
      return `${count} indexed ${noun} reindexing for the active embedding space.`;
    },

    selectEmbeddingInputFormatById(id) {
      const field = this.featureFieldsFor("embedding").find((candidate) => {
        return candidate.key === "embeddingInputFormatId";
      });
      const format = this.settings?.embeddingInputFormats.find((candidate) => {
        return candidate.id === id && candidate.retiredAt === null;
      });
      if (field === undefined || format === undefined) {
        return false;
      }
      this.writeFieldDraft(field, format.id);
      return true;
    },

    beginEmbeddingInputFormatCreate() {
      this.inputFormatEditorMode = "create";
      this.inputFormatDraft = {
        documentTemplate: "{{text}}",
        name: "",
        queryTemplate: "{{text}}",
        schemaVersion: 1,
        sourceId: null,
      };
    },

    beginEmbeddingInputFormatCopy(format) {
      this.inputFormatEditorMode = "copy";
      this.inputFormatDraft = {
        documentTemplate: format.documentTemplate,
        name: `${format.name} copy`,
        queryTemplate: format.queryTemplate,
        schemaVersion: format.schemaVersion,
        sourceId: format.id,
      };
    },

    beginEmbeddingInputFormatRevision(format) {
      this.inputFormatEditorMode = "revision";
      this.inputFormatDraft = {
        documentTemplate: format.documentTemplate,
        name: `${format.name} revision`,
        queryTemplate: format.queryTemplate,
        schemaVersion: format.schemaVersion,
        sourceId: format.id,
      };
    },

    cancelEmbeddingInputFormatEditor() {
      if (this.inputFormatBusy) {
        return;
      }
      this.inputFormatDraft = null;
      this.inputFormatEditorMode = null;
    },

    embeddingInputFormatEditorTitle() {
      if (this.inputFormatEditorMode === "copy") {
        return "Copy search text format";
      }
      if (this.inputFormatEditorMode === "revision") {
        return "Create revised format";
      }
      return "Create search text format";
    },

    async submitEmbeddingInputFormat() {
      if (
        this.inputFormatBusy
        || this.inputFormatDraft === null
        || this.inputFormatEditorMode === null
      ) {
        return;
      }
      const draft = this.inputFormatDraft;
      const name = String(draft.name).trim();
      if (name === "") {
        dispatchNotice("error", "Enter a name for the search text format.");
        return;
      }
      const schemaVersion = Number(draft.schemaVersion);
      if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
        dispatchNotice("error", "Format version must be a positive integer.");
        return;
      }
      let endpoint = "/api/embedding-input-formats";
      let body = {
        documentTemplate: String(draft.documentTemplate),
        name,
        queryTemplate: String(draft.queryTemplate),
        schemaVersion,
      };
      if (this.inputFormatEditorMode === "copy") {
        endpoint =
          `/api/embedding-input-formats/${encodeURIComponent(draft.sourceId)}/copies`;
        body = { name };
      } else if (this.inputFormatEditorMode === "revision") {
        endpoint =
          `/api/embedding-input-formats/${encodeURIComponent(draft.sourceId)}/revisions`;
      }
      this.inputFormatBusy = true;
      let createdId = null;
      try {
        const response = await fetch(endpoint, {
          body: JSON.stringify(body),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          method: "POST",
        });
        const created = await readJsonResponse(
          response,
          "Search text format update",
          readEmbeddingInputFormatMutationResponse,
        );
        createdId = created.id;
        this.inputFormatDraft = null;
        this.inputFormatEditorMode = null;
        this.reloadAfterSave = false;
        await this.loadSettings();
        this.selectEmbeddingInputFormatById(created.id);
        this.reloadAfterSave = false;
        dispatchNotice(
          "success",
          "The input format was created and selected. Save changes to apply it.",
        );
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error
            ? error.message
            : "The search text format could not be created.",
        );
      } finally {
        this.inputFormatBusy = false;
        if (this.reloadAfterSave) {
          this.reloadAfterSave = false;
          await this.loadSettings();
          if (createdId !== null) {
            this.selectEmbeddingInputFormatById(createdId);
          }
        }
      }
    },

    async retireEmbeddingInputFormat(format) {
      if (this.inputFormatBusy || !format.canRetire) {
        return;
      }
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep format",
        confirmLabel: "Retire format",
        description: "Retired formats remain in history and cannot be selected again.",
        title: `Retire “${format.name}”?`,
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      this.inputFormatBusy = true;
      try {
        const response = await fetch(
          `/api/embedding-input-formats/${encodeURIComponent(format.id)}`,
          {
            headers: { accept: "application/json" },
            method: "DELETE",
          },
        );
        await readJsonResponse(
          response,
          "Search text format retirement",
          readEmbeddingInputFormatMutationResponse,
        );
        this.reloadAfterSave = false;
        await this.loadSettings();
        dispatchNotice("success", `${format.name} was retired.`);
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error
            ? error.message
            : "The search text format could not be retired.",
        );
      } finally {
        this.inputFormatBusy = false;
        if (this.reloadAfterSave) {
          this.reloadAfterSave = false;
          void this.loadSettings();
        }
      }
    },

    filteredFieldSourceCount(source) {
      let count = 0;
      for (const field of this.filteredFields) {
        if (field.source === source) {
          count += 1;
        }
      }
      return count;
    },

    filteredPendingCount() {
      let count = 0;
      for (const field of this.filteredFields) {
        if (this.pending[field.key] !== undefined) {
          count += 1;
        }
      }
      return count;
    },

    selectStartupSetting(key) {
      const field = this.settings?.startupSettings.find((candidate) => {
        return candidate.key === key;
      });
      if (field !== undefined) {
        this.selectedStartupKey = field.key;
        this.recordLocationState();
      }
    },

    activeStartupSetting() {
      if (this.settings === null) {
        return null;
      }
      for (const field of this.settings.startupSettings) {
        if (field.key === this.selectedStartupKey) {
          return field;
        }
      }
      return this.settings.startupSettings[0] ?? null;
    },

    areaDescription() {
      if (this.selectedArea === null) {
        return this.query.trim() === ""
          ? "Review settings that match the selected source."
          : "Review settings that match your search.";
      }
      const descriptions = {
        Docling: "Choose how Docling reads and converts uploaded documents.",
        "Hughes Hallucination Evaluation Model": "Choose answer limits and how CiteLoom reports citation support.",
        "Document processing": "Choose upload limits, processing time, and how many documents CiteLoom handles at once.",
        "Search and answers": "Choose how widely CiteLoom searches and how much source material it can use in an answer.",
        "Embedding model": "Choose how CiteLoom converts document content and questions into representations used for semantic search.",
        "Search ranking": "Choose how CiteLoom orders and filters semantic search results.",
        "Object storage": "Choose where CiteLoom keeps original source-document content and migrate it safely.",
        "Source libraries": "Share common sources with selected workspaces while keeping each workspace's private sources isolated.",
        "Users & access": "Manage who can use the current workspace and what role each person has.",
        Workspaces: "Create and rename workspaces without moving their settings or sources.",
        "Speech input": "Choose how CiteLoom turns recorded questions into text.",
        "Spoken answers": "Choose how CiteLoom creates and plays answer audio.",
        "Usage diagnostics": "Choose whether CiteLoom records AI request times and usage.",
      };
      return descriptions[this.selectedArea]
        ?? `Configure ${this.selectedArea.toLocaleLowerCase()} behavior.`;
    },

    writeFieldDraft(field, value) {
      this.saved = false;
      this.drafts[field.key] = value;
      this.pending[field.key] = "set";
    },

    fieldSourceClass(field) {
      if (this.pending[field.key] === "reset") {
        return "pending";
      }
      return field.source;
    },

    fieldSourceLabel(field) {
      if (this.pending[field.key] === "reset") {
        return this.settings?.scope.kind === "workspace"
          ? "Organization default after save"
          : "Default after save";
      }
      if (this.settings?.scope.kind === "workspace") {
        return field.source === "database"
          ? "Workspace override"
          : "Organization default";
      }
      return field.source === "database" ? "Saved value" : "Default value";
    },

    fieldCredentialMessageVisible(field) {
      return field.sensitive
        && field.configured
        && !Object.hasOwn(this.pending, field.key);
    },

    async saveChanges() {
      if (!this.canSave || this.settings === null) {
        return;
      }
      let changes;
      let providerChanges;
      try {
        changes = buildRuntimeSettingChanges(this.settings, this.drafts, this.pending);
        providerChanges = this.providerChanges;
      } catch (error) {
        this.errorMessage = error instanceof Error
          ? error.message
          : "The settings changes are invalid.";
        return;
      }
      await this.submitSettingsUpdate(changes, providerChanges);
    },

    async submitSettingsUpdate(changes, providerChanges) {
      if (this.settings === null) {
        return false;
      }
      this.saving = true;
      this.saved = false;
      this.errorMessage = "";
      try {
        const response = await fetch(this.settingsRequestUrl(), {
          body: JSON.stringify({
            changes,
            expectedVersion: this.settings.version,
            providerChanges,
          }),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          method: "PUT",
        });
        const settings = await readSettingsResponse(response, "Settings update");
        this.applySettings(settings);
        this.saved = true;
        this.$dispatch("citeloom:settings-saved");
        return true;
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error ? error.message : "The settings update failed.",
        );
        return false;
      } finally {
        this.saving = false;
        if (this.reloadAfterSave) {
          this.reloadAfterSave = false;
          void this.loadSettings();
        }
      }
    },

    saveLabel() {
      return this.saving
        ? "Saving"
        : this.changeCount === 0
          ? "Save changes"
          : `Save changes (${this.changeCount})`;
    },

    changeSummaryLabel() {
      if (this.changeCount === 0) {
        return "No unsaved changes";
      }
      return this.changeCount === 1
        ? "1 unsaved change"
        : `${this.changeCount} unsaved changes`;
    },

    capabilityLabel(capability) {
      return this.featureDefinitionsByCapability[capability]?.label
        ?? capability;
    },

    selectFeature(capability) {
      this.selectedFeatureCapability = readEnum(
        capability,
        this.featureCapabilities,
        "selected feature",
      );
      this.featureAdvancedOpen = false;
      this.recordLocationState();
    },

    selectedFeatureDescription() {
      return this.featureDefinitionsByCapability[
        this.selectedFeatureCapability
      ]?.description ?? "";
    },

    featureSourceClass(capability) {
      return this.featureDefinitionsByCapability[capability]?.source ?? "";
    },

    featureSourceLabel(capability) {
      const source = this.featureDefinitionsByCapability[capability]?.source;
      if (this.settings?.scope.kind !== "workspace") {
        return "Organization setting";
      }
      return source === "database"
        ? "Workspace override"
        : "Organization default";
    },

    featureWithoutCredentialCount() {
      let count = 0;
      for (const capability of this.featureCapabilities) {
        if (
          this.featureProviderId(capability) !== null
          && !this.featureCredentialConfigured(capability)
        ) {
          count += 1;
        }
      }
      return count;
    },

    featureProviderLabel(capability) {
      const providerId = this.featureProviderId(capability);
      if (providerId === null) {
        return "Disabled";
      }
      return this.providerProfilesById[providerId]?.displayName ?? "Not configured";
    },

    featureModelSourceLabel(capability) {
      return this.featureModelOverride(capability) === null
        ? "Using provider default"
        : "Using this feature's model";
    },

    capabilityIsOptional(capability) {
      if (capability === "queryExpansion") {
        return !this.queryExpansionEnabled();
      }
      return optionalProviderCapabilities.includes(capability);
    },

    queryExpansionEnabled() {
      return Number(this.drafts.queryExpansions) > 0;
    },

    compatibleProviders(capability) {
      return this.compatibleProvidersByCapability[capability] ?? [];
    },

    featureFieldsFor(capability) {
      return this.featureFieldsByCapability[capability] ?? [];
    },

    featurePrimaryFields(capability) {
      const fields = this.featureFieldsFor(capability);
      if (capability !== "embedding") {
        return fields.slice(0, 1);
      }
      const primaryFields = [];
      for (const key of embeddingSpacePrimaryFieldKeys) {
        const field = fields.find((candidate) => candidate.key === key);
        if (field !== undefined) {
          primaryFields.push(field);
        }
      }
      return primaryFields;
    },

    featureAdvancedFields(capability) {
      const fields = this.featureFieldsFor(capability);
      if (capability !== "embedding") {
        return fields.slice(1);
      }
      const advancedFields = [];
      for (const field of fields) {
        if (!embeddingSpacePrimaryFieldKeys.includes(field.key)) {
          advancedFields.push(field);
        }
      }
      return advancedFields;
    },

    featureProviderId(capability) {
      return this.providerDrafts?.routing[capability] ?? null;
    },

    featureConnection(capability) {
      const providerId = this.featureProviderId(capability);
      if (providerId === null) {
        return null;
      }
      return this.providerConnectionsById[providerId] ?? null;
    },

    featureBaseUrl(capability) {
      const connection = this.featureConnection(capability);
      if (connection === null) {
        return null;
      }
      return connection.configuration[capability].baseUrl
        ?? connection.configuration.baseUrl;
    },

    featureDefaultModel(capability) {
      return this.featureConnection(capability)?.configuration[capability].model ?? null;
    },

    featureModelFieldLabel(capability) {
      return capability === "embedding"
        ? "Embedding model"
        : "Model for this feature";
    },

    featureModelInputPlaceholder(capability) {
      const defaultModel = this.featureDefaultModel(capability);
      return defaultModel === null
        ? "Enter a model ID"
        : `Provider default: ${defaultModel}`;
    },

    featureModelFieldHelp(capability) {
      const override = this.featureModelOverride(capability);
      if (capability === "embedding") {
        return override === null
          ? "Enter a model ID to use a different embedding model, or leave blank to use the provider default."
          : "This embedding model is used instead of the provider default.";
      }
      return override === null
        ? "The provider default is used."
        : "This model is used instead of the provider default for this feature.";
    },

    featureModelOverride(capability) {
      return this.providerDrafts?.featureOverrides[capability].modelOverride ?? null;
    },

    featureEffectiveModel(capability) {
      return this.featureModelOverride(capability)
        ?? this.featureDefaultModel(capability);
    },

    capabilityHasModelContext(capability) {
      return modelProviderCapabilities.includes(capability);
    },

    capabilitySupportsThinking(capability) {
      return languageProviderCapabilities.includes(capability);
    },

    featureThinkingModeOverride(capability) {
      if (!this.capabilitySupportsThinking(capability)) {
        return null;
      }
      return this.providerDrafts
        ?.featureOverrides[capability].thinkingModeOverride ?? null;
    },

    featureEffectiveThinkingMode(capability) {
      const override = this.featureThinkingModeOverride(capability);
      if (override !== null) {
        return override;
      }
      return this.featureConnection(capability)?.configuration.thinkingMode
        ?? "disabled";
    },

    featureSendReasoningOptions(capability) {
      if (!this.capabilitySupportsThinking(capability)) {
        return false;
      }
      return this.featureConnection(capability)
        ?.configuration.sendReasoningOptions
        ?? true;
    },

    featureDefaultContextCapacityTokens(capability) {
      if (!this.capabilityHasModelContext(capability)) {
        return null;
      }
      return this.featureConnection(capability)
        ?.configuration[capability].contextCapacityTokens ?? null;
    },

    featureContextCapacityTokensOverride(capability) {
      if (!this.capabilityHasModelContext(capability)) {
        return null;
      }
      return this.providerDrafts
        ?.featureOverrides[capability].contextCapacityTokensOverride ?? null;
    },

    featureEffectiveContextCapacityTokens(capability) {
      return this.featureContextCapacityTokensOverride(capability)
        ?? this.featureDefaultContextCapacityTokens(capability);
    },

    featureCredentialConfigured(capability) {
      const connection = this.featureConnection(capability);
      if (this.providerUsesDeviceAuthentication(connection?.providerId ?? null)) {
        return this.openAICodexAuth?.connection.state === "connected";
      }
      return connection !== null
        && (
          connection.apiTokenConfigured
          || connection.capabilityApiTokensConfigured[capability]
        );
    },

    featureStateLabel(capability) {
      if (capability === "queryExpansion" && !this.queryExpansionEnabled()) {
        return "Disabled";
      }
      if (!this.capabilityIsOptional(capability)) {
        return "Required";
      }
      return this.featureProviderId(capability) === null ? "Disabled" : "Enabled";
    },

    writeFeatureProvider(capability, value) {
      if (this.providerDrafts === null) {
        return;
      }
      const providerId = value === "" ? null : readProviderId(value, "selected provider");
      const draft = cloneProviderDrafts(this.providerDrafts, alpine);
      draft.routing[capability] = providerId;
      draft.featureOverrides[capability].modelOverride = null;
      if (modelProviderCapabilities.includes(capability)) {
        draft.featureOverrides[
          capability
        ].contextCapacityTokensOverride = null;
      }
      if (languageProviderCapabilities.includes(capability)) {
        draft.featureOverrides[capability].thinkingModeOverride = null;
      }
      if (capability === "textToSpeech") {
        draft.featureOverrides.textToSpeech.voiceOverride = null;
      }
      this.replaceProviderDrafts(draft);
      this.saved = false;
    },

    writeFeatureModelOverride(capability, value) {
      if (this.providerDrafts === null) {
        return;
      }
      const draft = cloneProviderDrafts(this.providerDrafts, alpine);
      draft.featureOverrides[capability].modelOverride = this.normalizeOptionalText(value);
      this.replaceProviderDrafts(draft);
      this.saved = false;
    },

    writeFeatureContextCapacityTokensOverride(capability, value) {
      if (
        this.providerDrafts === null
        || !modelProviderCapabilities.includes(capability)
      ) {
        return;
      }
      const normalized = String(value).trim();
      const contextCapacityTokensOverride = normalized === ""
        ? null
        : readPositiveInteger(
          Number(normalized),
          "maximum input tokens for this feature",
        );
      const draft = cloneProviderDrafts(this.providerDrafts, alpine);
      draft.featureOverrides[
        capability
      ].contextCapacityTokensOverride = contextCapacityTokensOverride;
      this.replaceProviderDrafts(draft);
      this.saved = false;
    },

    writeFeatureThinkingModeOverride(capability, value) {
      if (
        this.providerDrafts === null
        || !languageProviderCapabilities.includes(capability)
      ) {
        return;
      }
      const thinkingModeOverride = value === ""
        ? null
        : readEnum(value, thinkingModes, "thinking mode for this feature");
      const draft = cloneProviderDrafts(this.providerDrafts, alpine);
      draft.featureOverrides[capability].thinkingModeOverride =
        thinkingModeOverride;
      this.replaceProviderDrafts(draft);
      this.saved = false;
    },

    featureDefaultVoice() {
      return this.featureConnection("textToSpeech")?.configuration.textToSpeech.voice
        ?? null;
    },

    featureVoiceOverride() {
      return this.providerDrafts?.featureOverrides.textToSpeech.voiceOverride ?? null;
    },

    featureEffectiveVoice() {
      return this.featureVoiceOverride() ?? this.featureDefaultVoice();
    },

    writeFeatureVoiceOverride(value) {
      if (this.providerDrafts === null) {
        return;
      }
      const draft = cloneProviderDrafts(this.providerDrafts, alpine);
      draft.featureOverrides.textToSpeech.voiceOverride = this.normalizeOptionalText(value);
      this.replaceProviderDrafts(draft);
      this.saved = false;
    },

    selectProvider(providerId) {
      const selectedProviderId = readProviderId(providerId, "selected provider");
      this.selectedProviderId = selectedProviderId;
      this.selectedProviderCapability =
        this.providerProfilesById[selectedProviderId]?.capabilities[0]?.capability
        ?? null;
      this.providerEditorSection = "capabilities";
      this.recordLocationState();
    },

    selectProviderEditorSection(section) {
      this.providerEditorSection = readEnum(
        section,
        providerEditorSections,
        "provider editor section",
      );
      this.recordLocationState();
    },

    selectProviderCapability(capability) {
      const selectedCapability = readEnum(
        capability,
        providerCapabilities,
        "selected provider capability",
      );
      const supported = this.selectedProviderProfile?.capabilities.some((entry) => {
        return entry.capability === selectedCapability;
      }) ?? false;
      if (!supported) {
        this.errorMessage = "The selected feature is unavailable for this provider.";
        return;
      }
      this.selectedProviderCapability = selectedCapability;
      this.providerEditorSection = "capabilities";
      this.recordLocationState();
    },

    selectedProviderCapabilitiesLabel() {
      const profile = this.selectedProviderProfile;
      if (profile === null) {
        return "";
      }
      const labels = [];
      for (const entry of profile.capabilities) {
        labels.push(this.capabilityLabel(entry.capability));
      }
      return labels.join(", ");
    },

    selectedProviderCredentialPlaceholder() {
      const connection = this.selectedProviderConnection;
      if (connection === null || this.selectedProviderId === null) {
        return "";
      }
      if (this.credentialClears.includes(this.selectedProviderId)) {
        return "Credential will be cleared on save";
      }
      return connection.apiTokenConfigured
        ? "Configured - enter a replacement"
        : "Optional for local providers";
    },

    writeProviderBaseUrl(value) {
      this.updateSelectedProviderConfiguration((configuration) => {
        configuration.baseUrl = this.normalizeOptionalText(value);
      });
    },

    providerMaximumParallelRequests() {
      return this.selectedProviderConnection
        ?.configuration.maximumParallelRequests
        ?? null;
    },

    providerSupportsThinking() {
      return this.selectedProviderProfile?.capabilities.some((entry) => {
        return languageProviderCapabilities.includes(entry.capability);
      }) ?? false;
    },

    providerThinkingMode() {
      return this.selectedProviderConnection?.configuration.thinkingMode
        ?? "disabled";
    },

    providerSendReasoningOptions() {
      return this.selectedProviderConnection
        ?.configuration.sendReasoningOptions
        ?? true;
    },

    writeProviderSendReasoningOptions(value) {
      this.updateSelectedProviderConfiguration((configuration) => {
        configuration.sendReasoningOptions = value === true;
      });
    },

    writeProviderThinkingMode(value) {
      const thinkingMode = readEnum(
        value,
        thinkingModes,
        "provider thinking mode",
      );
      this.updateSelectedProviderConfiguration((configuration) => {
        configuration.thinkingMode = thinkingMode;
      });
    },

    providerAdaptiveContextEnabled() {
      return this.selectedProviderSupportsAdaptiveContext()
        && (
          this.selectedProviderConnection
            ?.configuration.adaptiveContextEnabled
          ?? false
        );
    },

    writeProviderAdaptiveContextEnabled(value) {
      if (!this.selectedProviderSupportsAdaptiveContext()) {
        return;
      }
      this.updateSelectedProviderConfiguration((configuration) => {
        configuration.adaptiveContextEnabled = value;
        if (value) {
          configuration.maximumParallelRequests = 1;
        }
      });
    },

    writeProviderMaximumParallelRequests(value) {
      const maximumParallelRequests = readPositiveInteger(
        Number(value),
        "provider request limit",
      );
      if (maximumParallelRequests > 16) {
        this.errorMessage =
          "Maximum parallel requests must be a whole number from 1 to 16.";
        return;
      }
      if (
        this.providerAdaptiveContextEnabled()
        && maximumParallelRequests !== 1
      ) {
        this.errorMessage =
          "Automatic context size requires Maximum parallel requests to remain 1.";
        return;
      }
      this.updateSelectedProviderConfiguration((configuration) => {
        configuration.maximumParallelRequests = maximumParallelRequests;
      });
    },

    writeProviderCredential(value) {
      if (this.selectedProviderId === null) {
        return;
      }
      this.credentialDrafts[this.selectedProviderId] = value;
      this.credentialClears = this.credentialClears.filter((providerId) => {
        return providerId !== this.selectedProviderId;
      });
      this.saved = false;
    },

    clearProviderCredential() {
      const connection = this.selectedProviderConnection;
      if (connection === null || this.selectedProviderId === null) {
        return;
      }
      this.credentialDrafts[this.selectedProviderId] = "";
      if (!this.credentialClears.includes(this.selectedProviderId)) {
        this.credentialClears = [...this.credentialClears, this.selectedProviderId];
      }
      this.saved = false;
    },

    providerCredentialClearDisabled() {
      const connection = this.selectedProviderConnection;
      if (connection === null || this.selectedProviderId === null) {
        return true;
      }
      return !connection.apiTokenConfigured
        && !this.credentialClears.includes(this.selectedProviderId);
    },

    providerEffectiveUrl(capability) {
      const connection = this.selectedProviderConnection;
      if (connection === null) {
        return null;
      }
      return connection.configuration[capability].baseUrl
        ?? connection.configuration.baseUrl;
    },

    providerCredentialStatus(capability) {
      const connection = this.selectedProviderConnection;
      if (connection === null) {
        return "Not configured";
      }
      if (this.providerUsesDeviceAuthentication(connection.providerId)) {
        return this.openAICodexConnectionLabel();
      }
      if (connection.capabilityApiTokensConfigured[capability]) {
        return "Configured for this feature";
      }
      if (connection.apiTokenConfigured) {
        return "Configured at provider level";
      }
      return "Not configured";
    },

    providerUsesDeviceAuthentication(providerId) {
      if (providerId === null) {
        return false;
      }
      return this.providerProfilesById[providerId]?.authentication
        === "openai-device";
    },

    selectedProviderSupportsAdaptiveContext() {
      return this.selectedProviderProfile?.adaptiveContextSupported === true;
    },

    providerCapabilityModel(capability) {
      return this.selectedProviderConnection?.configuration[capability].model ?? null;
    },

    writeProviderCapabilityModel(capability, value) {
      this.updateSelectedProviderConfiguration((configuration) => {
        configuration[capability].model = this.normalizeOptionalText(value);
      });
    },

    providerCapabilityBaseUrl(capability) {
      return this.selectedProviderConnection?.configuration[capability].baseUrl ?? null;
    },

    providerCapabilityOverrideLabel(capability) {
      const baseUrl = this.providerCapabilityBaseUrl(capability);
      if (baseUrl === null) {
        return "Inherited";
      }
      try {
        const parsed = new URL(baseUrl);
        const suffix = `${parsed.pathname}${parsed.search}`;
        return suffix === "/"
          ? "Custom"
          : `Custom · …${suffix}`;
      } catch {
        return "Custom";
      }
    },

    writeProviderCapabilityBaseUrl(capability, value) {
      this.updateSelectedProviderConfiguration((configuration) => {
        configuration[capability].baseUrl = this.normalizeOptionalText(value);
      });
    },

    providerCapabilityContextCapacityTokens(capability) {
      if (!modelProviderCapabilities.includes(capability)) {
        return null;
      }
      return this.selectedProviderConnection
        ?.configuration[capability].contextCapacityTokens ?? null;
    },

    writeProviderCapabilityContextCapacityTokens(capability, value) {
      if (!modelProviderCapabilities.includes(capability)) {
        return;
      }
      const normalized = String(value).trim();
      const contextCapacityTokens = normalized === ""
        ? null
        : readPositiveInteger(
          Number(normalized),
          "provider maximum input tokens",
        );
      this.updateSelectedProviderConfiguration((configuration) => {
        configuration[capability].contextCapacityTokens =
          contextCapacityTokens;
      });
    },

    providerDefaultVoice() {
      return this.selectedProviderConnection?.configuration.textToSpeech.voice ?? null;
    },

    writeProviderDefaultVoice(value) {
      this.updateSelectedProviderConfiguration((configuration) => {
        configuration.textToSpeech.voice = this.normalizeOptionalText(value);
      });
    },

    providerAdapter(capability) {
      return this.selectedProviderConnection?.configuration.customAdapters[capability] ?? "";
    },

    adapterOptions(capability) {
      const selectedCapability = readEnum(
        capability,
        providerCapabilities,
        "provider adapter capability",
      );
      return this.providerAdapterOptionsByCapability[selectedCapability] ?? [];
    },

    writeProviderAdapter(capability, value) {
      const selectedCapability = readEnum(
        capability,
        providerCapabilities,
        "provider adapter capability",
      );
      const adapter = readConfiguredAdapter(
        value,
        selectedCapability,
        this.providerAdapterOptionsByCapability,
      );
      this.updateSelectedProviderConfiguration((configuration) => {
        configuration.customAdapters[selectedCapability] = adapter;
      });
    },

    updateSelectedProviderConfiguration(update) {
      if (this.providerDrafts === null || this.selectedProviderId === null) {
        return;
      }
      const draft = cloneProviderDrafts(this.providerDrafts, alpine);
      let connection = null;
      for (const candidate of draft.connections) {
        if (candidate.providerId === this.selectedProviderId) {
          connection = candidate;
          break;
        }
      }
      if (connection === null) {
        this.errorMessage = "The selected provider configuration is unavailable.";
        return;
      }
      update(connection.configuration);
      this.replaceProviderDrafts(draft);
      this.saved = false;
    },

    updateProviderCapabilityConfiguration(
      providerId,
      capability,
      update,
    ) {
      if (this.providerDrafts === null || providerId === null) {
        return;
      }
      const draft = cloneProviderDrafts(this.providerDrafts, alpine);
      const connection = draft.connections.find((candidate) => {
        return candidate.providerId === providerId;
      });
      if (connection === undefined) {
        this.errorMessage = "The selected provider configuration is unavailable.";
        return;
      }
      update(connection.configuration[capability]);
      this.replaceProviderDrafts(draft);
      this.saved = false;
    },

    replaceProviderDrafts(drafts) {
      const connectionsById = {};
      for (const connection of drafts.connections) {
        connectionsById[connection.providerId] = connection;
      }
      const profilesById = {};
      const compatibleProvidersByCapability = {};
      for (const capability of providerCapabilities) {
        compatibleProvidersByCapability[capability] = [];
      }
      for (const profile of drafts.catalog) {
        profilesById[profile.id] = profile;
        if (connectionsById[profile.id] === undefined) {
          continue;
        }
        for (const entry of profile.capabilities) {
          compatibleProvidersByCapability[entry.capability].push(profile);
        }
      }
      this.providerConnectionsById = connectionsById;
      this.providerAdapterOptionsByCapability =
        buildProviderAdapterOptions(drafts.catalog);
      this.providerProfilesById = profilesById;
      this.compatibleProvidersByCapability = compatibleProvidersByCapability;
      this.providerDrafts = drafts;
    },

    normalizeOptionalText(value) {
      const normalized = value.trim();
      return normalized === "" ? null : normalized;
    },

    valueOrFallback(value, fallback = "No default configured") {
      return value ?? fallback;
    },
  }));
}
