import {
  readArray,
  readBoolean,
  readEnum,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullableFiniteNumber,
  readNullableNonEmptyString,
  readNullablePositiveInteger,
  readPlainObject,
  readPositiveInteger,
  readString,
} from "./boundary-readers.js";

export const providerCapabilities = Object.freeze([
  "answer",
  "chat",
  "queryExpansion",
  "indexing",
  "embedding",
  "reranking",
  "speechToText",
  "textToSpeech",
]);
export const optionalProviderCapabilities = Object.freeze([
  "reranking",
  "speechToText",
  "textToSpeech",
]);
export const modelProviderCapabilities = Object.freeze([
  "answer",
  "chat",
  "embedding",
  "queryExpansion",
  "indexing",
]);
export const languageProviderCapabilities = Object.freeze([
  "answer",
  "chat",
  "queryExpansion",
  "indexing",
]);
export const thinkingModes = Object.freeze(["auto", "disabled", "enabled"]);
const providerAdapterConfigurations = Object.freeze(["catalog", "connection"]);
const runtimeInputs = Object.freeze([
  "boolean",
  "json",
  "number",
  "password",
  "select",
  "text",
  "url",
]);
const runtimeSources = Object.freeze(["database", "database-default"]);
export const embeddingSpaceIdentityFieldKeys = Object.freeze([
  "embeddingDimensions",
  "embeddingInputFormatId",
  "embeddingSpaceId",
  "retrievalChunkTargetTokens",
  "retrievalWindowPolicy",
]);
export const embeddingSpacePrimaryFieldKeys = Object.freeze([
  "embeddingDimensions",
  "embeddingInputFormatId",
  "retrievalWindowPolicy",
]);
export const sourceFilters = Object.freeze([
  "all",
  "database",
  "database-default",
  "modified",
]);
export const providerEditorSections = Object.freeze(["connection", "capabilities"]);
const providerAuthenticationMethods = Object.freeze([
  "api-token",
  "openai-device",
]);
export const startupGroupName = "Startup and deployment";
export const objectStorageAreaName = "Object storage";
export const sourceLibraryAreaName = "Source libraries";
export const workspacesAreaName = "Workspaces";
export const workspaceManagementAreaName = "Workspace";
export const doclingAdvancedFieldKeys = Object.freeze([
  "doclingPdfBackend",
  "doclingTocEnabled",
  "doclingVlmMaxOutputTokens",
  "doclingVlmPrompt",
]);
export const doclingVlmFieldKeys = Object.freeze([
  "doclingVlmMaxOutputTokens",
  "doclingVlmModelOverride",
  "doclingVlmPrompt",
  "doclingVlmProviderId",
]);

export function readApplicationSettings(value) {
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
  const targetIds = new Set();
  for (const value of readArray(scope.available, "available settings scopes")) {
    const option = readPlainObject(value, "available settings scope");
    const target = readSettingsScopeTarget(option, "available settings scope");
    if (targetIds.has(target.id)) {
      throw new Error(`The settings target ${target.id} appears more than once.`);
    }
    targetIds.add(target.id);
    available.push({
      ...target,
      label: readNonEmptyString(option.label, "settings scope label"),
    });
  }
  const active = readSettingsScopeTarget(scope, "active settings scope");
  if (!targetIds.has(active.id)) {
    throw new Error("The active settings scope is unavailable.");
  }
  return {
    available,
    editableProviderConnections: readBoolean(
      scope.editableProviderConnections,
      "provider connection edit permission",
    ),
    ...active,
    label: readNonEmptyString(scope.label, "active settings scope label"),
  };
}

function readSettingsScopeTarget(value, label) {
  const kind = readEnum(
    value.kind,
    ["organization", "workspace"],
    `${label} kind`,
  );
  const id = readNonEmptyString(value.id, `${label} ID`);
  if (kind === "organization") {
    if (id !== "organization") {
      throw new Error(`The ${label} organization ID is invalid.`);
    }
    return { id, kind };
  }
  if (id === "organization") {
    throw new Error(`The ${label} workspace ID is invalid.`);
  }
  return { id, kind };
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
  const key = readNonEmptyString(field.key, "setting key");
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
    defaultValue: readRuntimeSettingValue(
      field.defaultValue,
      "setting default",
      input,
      key,
    ),
    description: readNonEmptyString(field.description, "setting description"),
    feature,
    group: readNonEmptyString(field.group, "setting group"),
    input,
    key,
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
    value: readRuntimeSettingValue(field.value, "setting value", input, key),
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

function readRuntimeSettingValue(value, label, input, key) {
  if (input === "json") {
    if (key === "doclingAdditionalServiceInstances") {
      return readDoclingServiceDeclarations(value, label);
    }
    if (key === "publicOrigins") {
      return readStringList(value, label);
    }
    throw new Error(`The ${label} response uses an unknown JSON setting.`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error(`The ${label} response is invalid.`);
}

function readStringList(value, label) {
  const entries = readArray(value, label);
  return entries.map((entry) => readNonEmptyString(entry, label));
}

function readDoclingServiceDeclarations(value, label) {
  const declarations = readArray(value, label);
  return declarations.map((entry) => {
    const declaration = readPlainObject(entry, label);
    return {
      baseUrl: readNonEmptyString(declaration.baseUrl, `${label} base URL`),
      capacity: readPositiveInteger(declaration.capacity, `${label} capacity`),
      id: readNonEmptyString(declaration.id, `${label} identifier`),
    };
  });
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

export function buildProviderAdapterOptions(catalog) {
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

export function readProviderId(value, label) {
  return readSettingsIdentifier(value, label);
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
