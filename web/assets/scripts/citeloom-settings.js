import {
  readArray,
  readBoolean,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullableNonEmptyString,
  readPlainObject,
  readPositiveInteger,
  readString,
} from "./citeloom-boundaries.js";
import { dispatchNotice } from "./citeloom-notices.js";

const providerCapabilities = Object.freeze([
  "answer",
  "chat",
  "queryExpansion",
  "summarization",
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
  "summarization",
]);
const languageProviderCapabilities = Object.freeze([
  "answer",
  "chat",
  "queryExpansion",
  "summarization",
]);
const thinkingModes = Object.freeze(["auto", "disabled", "enabled"]);
const providerIds = Object.freeze([
  "omlx",
  "ollama",
  "lmstudio",
  "openai",
  "openai-codex",
  "deepseek",
  "groq",
  "cohere",
  "jina",
  "custom",
]);
const runtimeInputs = Object.freeze([
  "boolean",
  "number",
  "password",
  "select",
  "text",
  "url",
]);
const runtimeSources = Object.freeze(["database", "database-default"]);
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
const languageAdapters = Object.freeze([
  "cohere-language",
  "deepseek-language",
  "ollama-language",
  "openai-codex-language",
  "openai-compatible-language",
]);
const customLanguageAdapters = Object.freeze([
  "cohere-language",
  "deepseek-language",
  "ollama-language",
  "openai-compatible-language",
]);
const embeddingAdapters = Object.freeze([
  "cohere-embedding",
  "ollama-embedding",
  "openai-compatible-embedding",
]);
const rerankingAdapters = Object.freeze(["top-n-rerank"]);
const speechToTextAdapters = Object.freeze([
  "omlx-transcription",
  "openai-transcription",
]);
const textToSpeechAdapters = Object.freeze([
  "groq-speech",
  "omlx-speech",
  "openai-speech",
]);
const capabilityLabels = Object.freeze({
  answer: "Answers",
  chat: "Chat",
  embedding: "Search model",
  queryExpansion: "Additional searches",
  reranking: "Search ranking",
  speechToText: "Speech input",
  summarization: "Image and table descriptions",
  textToSpeech: "Spoken answers",
});
const startupGroupName = "Startup and deployment";

function readApplicationSettings(value) {
  const response = readPlainObject(value, "application settings");
  const embeddingInputFormats = readEmbeddingInputFormats(
    response.embeddingInputFormats,
  );
  const fields = readRuntimeSettingFields(response.fields);
  const providers = readProviderSettings(response.providers);
  const startupSettings = readStartupSettings(response.startupSettings);
  const warnings = readConfigurationWarnings(response.warnings);
  return {
    embeddingInputFormats,
    fields,
    providers,
    startupSettings,
    updatedAt: readNullableNonEmptyString(
      response.updatedAt,
      "settings update time",
    ),
    version: readNonNegativeInteger(response.version, "settings version"),
    warnings,
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
  const connections = readProviderConnections(providers.connections);
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
      adapter: readCapabilityAdapter(profile.adapter, capability),
      capability,
    });
  }
  return profiles;
}

function readCapabilityAdapter(value, capability) {
  if (
    capability === "answer"
    || capability === "chat"
    || capability === "queryExpansion"
    || capability === "summarization"
  ) {
    return readEnum(value, languageAdapters, "language adapter");
  }
  if (capability === "embedding") {
    return readEnum(value, embeddingAdapters, "search model connection type");
  }
  if (capability === "reranking") {
    return readEnum(value, rerankingAdapters, "search ranking connection type");
  }
  if (capability === "speechToText") {
    return readEnum(value, speechToTextAdapters, "speech-to-text adapter");
  }
  return readEnum(value, textToSpeechAdapters, "text-to-speech adapter");
}

function readProviderConnections(value) {
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
      configuration: readProviderConfiguration(connection.configuration),
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

function readProviderConfiguration(value) {
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
    customAdapters: readCustomAdapters(configuration.customAdapters),
    embedding: readProviderModelConfiguration(
      configuration.embedding,
      "search model settings",
    ),
    queryExpansion: readProviderModelConfiguration(
      configuration.queryExpansion,
      "query-expansion configuration",
    ),
    maximumParallelRequests: readBoundedProviderConcurrency(
      configuration.maximumParallelRequests,
    ),
    name: readNullableNonEmptyString(configuration.name, "provider name"),
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
    summarization: readProviderModelConfiguration(
      configuration.summarization,
      "summarization configuration",
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

function readCustomAdapters(value) {
  const adapters = readPlainObject(value, "custom provider adapters");
  return {
    answer: readEnum(
      adapters.answer,
      customLanguageAdapters,
      "answer adapter",
    ),
    chat: readEnum(
      adapters.chat,
      customLanguageAdapters,
      "chat adapter",
    ),
    embedding: readEnum(
      adapters.embedding,
      embeddingAdapters,
      "search model connection type",
    ),
    queryExpansion: readEnum(
      adapters.queryExpansion,
      customLanguageAdapters,
      "query-expansion adapter",
    ),
    reranking: readEnum(
      adapters.reranking,
      rerankingAdapters,
      "search ranking connection type",
    ),
    speechToText: readEnum(
      adapters.speechToText,
      speechToTextAdapters,
      "speech-to-text adapter",
    ),
    summarization: readEnum(
      adapters.summarization,
      customLanguageAdapters,
      "summarization adapter",
    ),
    textToSpeech: readEnum(
      adapters.textToSpeech,
      textToSpeechAdapters,
      "text-to-speech adapter",
    ),
  };
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
  for (const profile of catalog) {
    if (!connectionIds.has(profile.id)) {
      throw new Error(`Provider profile ${profile.id} has no connection.`);
    }
  }
  for (const capability of providerCapabilities) {
    const providerId = routing[capability];
    if (providerId === null) {
      continue;
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

function readNullableFiniteNumber(value, label) {
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`The ${label} response is invalid.`);
  }
  return value;
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
  return readEnum(value, providerIds, label);
}

function readNullablePositiveInteger(value, label) {
  if (value === null) {
    return null;
  }
  return readPositiveInteger(value, label);
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
    summarization: {
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
  alpine.data("citeloomSettingsPage", () => ({
    abortController: null,
    credentialClears: [],
    credentialDrafts: {},
    drafts: {},
    errorMessage: "",
    featureCapabilities: [...providerCapabilities],
    featureAdvancedOpen: false,
    featureFieldsByCapability: {},
    groups: [],
    inputFormatBusy: false,
    inputFormatDraft: null,
    inputFormatEditorMode: null,
    loading: true,
    openAICodexAuth: null,
    openAICodexBusy: false,
    openAICodexModels: [],
    openAICodexPollTimer: null,
    pending: {},
    compatibleProvidersByCapability: {},
    providerConnectionsById: {},
    providerDrafts: null,
    providerEditorSection: "capabilities",
    providerProfilesById: {},
    query: "",
    reloadAfterSave: false,
    saved: false,
    saving: false,
    selectedArea: null,
    selectedFeatureCapability: "answer",
    selectedProviderCapability: "answer",
    selectedProviderId: null,
    selectedRuntimeFieldKey: null,
    selectedStartupKey: null,
    settings: null,
    settingsRevision: null,
    settingsRevisionListener: null,
    sourceFilter: "all",

    get areaCount() {
      return this.groups.length + 3;
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
      await this.loadOpenAICodexAuth();
    },

    destroy() {
      this.abortController?.abort();
      if (this.openAICodexPollTimer !== null) {
        clearTimeout(this.openAICodexPollTimer);
      }
      if (this.settingsRevisionListener !== null) {
        window.removeEventListener(
          "citeloom:settings-revision",
          this.settingsRevisionListener,
        );
      }
    },

    async loadSettings() {
      this.abortController?.abort();
      const controller = new AbortController();
      this.abortController = controller;
      this.loading = true;
      this.errorMessage = "";
      try {
        const response = await fetch("/api/settings", {
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
      for (const capability of providerCapabilities) {
        featureFieldsByCapability[capability] = [];
      }
      for (const field of settings.fields) {
        if (field.feature !== null) {
          featureFieldsByCapability[field.feature].push(field);
        }
      }
      this.featureFieldsByCapability = featureFieldsByCapability;
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
    },

    selectArea(area) {
      this.selectedArea = area;
      if (area === startupGroupName) {
        this.selectedStartupKey = this.settings?.startupSettings[0]?.key ?? null;
        return;
      }
      for (const group of this.groups) {
        if (group.name === area) {
          this.selectedRuntimeFieldKey = group.fields[0]?.key ?? null;
          return;
        }
      }
    },

    clearSearch() {
      this.query = "";
      this.selectedArea = null;
      this.sourceFilter = "all";
    },

    changeSearchQuery() {
      this.selectedArea = null;
    },

    changeSourceFilter(value) {
      this.sourceFilter = readEnum(value, sourceFilters, "source filter");
      if (this.selectedArea === startupGroupName) {
        this.selectedArea = null;
      }
    },

    settingMatchesSearch(field, normalizedQuery) {
      if (normalizedQuery === "") {
        return true;
      }
      return field.label.toLocaleLowerCase().includes(normalizedQuery)
        || field.description.toLocaleLowerCase().includes(normalizedQuery)
        || field.changeExample.toLocaleLowerCase().includes(normalizedQuery)
        || field.group.toLocaleLowerCase().includes(normalizedQuery);
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

    selectRuntimeField(key) {
      const field = this.settings?.fields.find((candidate) => {
        return candidate.key === key && candidate.feature === null;
      });
      if (field === undefined) {
        return;
      }
      this.selectedRuntimeFieldKey = field.key;
    },

    activeRuntimeField() {
      for (const field of this.filteredFields) {
        if (field.key === this.selectedRuntimeFieldKey) {
          return field;
        }
      }
      return this.filteredFields[0] ?? null;
    },

    selectedEmbeddingInputFormat() {
      if (this.settings === null) {
        return null;
      }
      return this.settings.embeddingInputFormats.find((format) => {
        return format.id === this.drafts.embeddingInputFormatId;
      }) ?? null;
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
      const confirmed = window.confirm(
        `Retire ${format.name}? Retired formats remain in history and cannot be selected.`,
      );
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
        "Answers and citation checks": "Choose answer limits and how CiteLoom reports citation support.",
        "Document processing": "Choose upload limits, processing time, and how many documents CiteLoom handles at once.",
        "Search and answers": "Choose how widely CiteLoom searches and how much source material it can use in an answer.",
        "Search model": "Choose how CiteLoom prepares documents for search.",
        "Search ranking": "Choose how CiteLoom orders and filters semantic search results.",
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

    resetField(field) {
      this.saved = false;
      this.drafts[field.key] = createDraftValue(field, field.defaultValue);
      this.pending[field.key] = "reset";
    },

    fieldSourceClass(field) {
      if (this.pending[field.key] === "reset") {
        return "pending";
      }
      return field.source;
    },

    fieldSourceLabel(field) {
      if (this.pending[field.key] === "reset") {
        return "Default after save";
      }
      return field.source === "database" ? "Saved value" : "Default value";
    },

    fieldResetDisabled(field) {
      return field.source === "database-default"
        && !Object.hasOwn(this.pending, field.key);
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

    async resetAll() {
      if (this.settings === null || this.saving) {
        return;
      }
      const changes = [];
      for (const field of this.settings.fields) {
        changes.push({ action: "reset", key: field.key });
      }
      await this.submitSettingsUpdate(changes, [{ action: "reset" }]);
    },

    async submitSettingsUpdate(changes, providerChanges) {
      if (this.settings === null) {
        return;
      }
      this.saving = true;
      this.saved = false;
      this.errorMessage = "";
      try {
        const response = await fetch("/api/settings", {
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
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error ? error.message : "The settings update failed.",
        );
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
      return capabilityLabels[capability];
    },

    selectFeature(capability) {
      this.selectedFeatureCapability = readEnum(
        capability,
        providerCapabilities,
        "selected feature",
      );
      this.featureAdvancedOpen = false;
    },

    selectedFeatureDescription() {
      const descriptions = {
        answer: "Choose how CiteLoom writes answers.",
        chat: "Choose how CiteLoom responds in document chats.",
        embedding: "Choose the model CiteLoom uses to make documents searchable.",
        queryExpansion: "Choose how CiteLoom creates additional searches when that setting is enabled.",
        reranking: "Choose how CiteLoom orders semantic search results.",
        speechToText: "Choose how CiteLoom turns recorded questions into text.",
        summarization: "Choose how CiteLoom describes images and tables while processing documents.",
        textToSpeech: "Choose how CiteLoom creates spoken answers.",
      };
      return descriptions[this.selectedFeatureCapability];
    },

    featureWithoutCredentialCount() {
      let count = 0;
      for (const capability of providerCapabilities) {
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
      return optionalProviderCapabilities.includes(capability);
    },

    compatibleProviders(capability) {
      return this.compatibleProvidersByCapability[capability] ?? [];
    },

    featureFieldsFor(capability) {
      return this.featureFieldsByCapability[capability] ?? [];
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
        ? "Search model"
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
          ? "Enter a model ID to use a different search model, or leave blank to use the provider default."
          : "This search model is used instead of the provider default.";
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
      if (connection?.providerId === "openai-codex") {
        return this.openAICodexAuth?.connection.state === "connected";
      }
      return connection !== null
        && (
          connection.apiTokenConfigured
          || connection.capabilityApiTokensConfigured[capability]
        );
    },

    featureStateLabel(capability) {
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
    },

    selectProviderEditorSection(section) {
      this.providerEditorSection = readEnum(
        section,
        providerEditorSections,
        "provider editor section",
      );
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
    },

    selectedProviderCapabilitiesLabel() {
      const profile = this.selectedProviderProfile;
      if (profile === null) {
        return "";
      }
      const labels = [];
      for (const entry of profile.capabilities) {
        labels.push(capabilityLabels[entry.capability]);
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
      return this.selectedProviderId === "ollama"
        && (
          this.selectedProviderConnection
            ?.configuration.adaptiveContextEnabled
          ?? false
        );
    },

    writeProviderAdaptiveContextEnabled(value) {
      if (this.selectedProviderId !== "ollama") {
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
      if (connection.providerId === "openai-codex") {
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

    clearProviderCapabilityBaseUrl(capability) {
      this.updateSelectedProviderConfiguration((configuration) => {
        configuration[capability].baseUrl = null;
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
      if (
        capability === "answer"
        || capability === "chat"
        || capability === "queryExpansion"
        || capability === "summarization"
      ) {
        return [
          { label: "OpenAI-compatible language model", value: "openai-compatible-language" },
          { label: "Ollama language model", value: "ollama-language" },
          { label: "Cohere language model", value: "cohere-language" },
        ];
      }
      if (capability === "embedding") {
        return [
          { label: "OpenAI-compatible search model", value: "openai-compatible-embedding" },
          { label: "Ollama search model", value: "ollama-embedding" },
          { label: "Cohere search model", value: "cohere-embedding" },
        ];
      }
      if (capability === "reranking") {
        return [{ label: "Top-N search ranking", value: "top-n-rerank" }];
      }
      if (capability === "speechToText") {
        return [
          { label: "OpenAI transcription", value: "openai-transcription" },
          { label: "oMLX transcription", value: "omlx-transcription" },
        ];
      }
      return [
        { label: "OpenAI speech", value: "openai-speech" },
        { label: "Groq speech", value: "groq-speech" },
        { label: "oMLX speech", value: "omlx-speech" },
      ];
    },

    writeProviderAdapter(capability, value) {
      const adapter = readCapabilityAdapter(value, capability);
      this.updateSelectedProviderConfiguration((configuration) => {
        configuration.customAdapters[capability] = adapter;
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
        for (const entry of profile.capabilities) {
          compatibleProvidersByCapability[entry.capability].push(profile);
        }
      }
      this.providerConnectionsById = connectionsById;
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
