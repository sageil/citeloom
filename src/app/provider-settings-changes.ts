import {
  parseProviderSettings,
  readProviderAuthenticationMethod,
  readProviderProfile,
  requireProviderConnection,
} from "../config/index.js";
import type {
  NormalizedProviderSettingsChange,
  ProviderCapability,
  ProviderCapabilityConnection,
  ProviderCapabilityFeatureOverrides,
  ProviderConnection,
  ProviderConnectionConfiguration,
  ProviderCredentialTarget,
  ProviderLanguageFeatureOverrides,
  ProviderModelConnection,
  ProviderModelFeatureOverrides,
  ProviderSettings,
} from "../providers/profiles.js";
import { SettingsValidationError } from "./settings-model.js";

export function applyProviderSettingsChanges(
  current: ProviderSettings,
  defaults: ProviderSettings,
  changes: NormalizedProviderSettingsChange[],
): ProviderSettings {
  if (changes.length === 0) {
    return current;
  }
  const reset = changes.find((change) => change.action === "reset");
  if (reset !== undefined) {
    if (changes.length !== 1) {
      throw new Error("Resetting provider settings cannot be combined with other provider changes.");
    }
    return structuredClone(defaults);
  }
  const next = structuredClone(current);
  materializeChatSettings(next);
  const normalizedDefaults = structuredClone(defaults);
  materializeChatSettings(normalizedDefaults);
  for (const change of changes) {
    if (change.action === "configure") {
      next.connections[change.providerId] = configureProviderConnection(
        requireProviderConnection(next, change.providerId),
        change.configuration,
        readProviderAuthenticationMethod(next, change.providerId),
      );
      continue;
    }
    if (change.action === "credential") {
      if (
        readProviderProfile(next, change.providerId)?.authentication
          === "openai-device"
      ) {
        throw new SettingsValidationError(
          "OpenAI Codex uses device sign-in instead of API tokens.",
        );
      }
      setProviderCredential(
        requireProviderConnection(next, change.providerId),
        change.target,
        change.value,
      );
      continue;
    }
    if (change.action === "feature") {
      configureApplicationFeature(next, change.configuration);
      continue;
    }
    if (change.action === "reset-feature") {
      const defaultProviderId = normalizedDefaults.routing[change.capability];
      if (defaultProviderId === undefined) {
        throw new SettingsValidationError(
          `No default provider route exists for ${change.capability}.`,
        );
      }
      next.routing[change.capability] = defaultProviderId;
      const defaultOverrides = readMutableFeatureOverrides(
        normalizedDefaults,
        change.capability,
      );
      Object.assign(
        readMutableFeatureOverrides(next, change.capability),
        structuredClone(defaultOverrides),
      );
      continue;
    }
    if (change.action === "reset-provider") {
      const defaultConnection = normalizedDefaults.connections[change.providerId];
      if (defaultConnection === undefined) {
        delete next.connections[change.providerId];
      } else {
        next.connections[change.providerId] = structuredClone(defaultConnection);
      }
      continue;
    }
    if (change.action === "route") {
      next.routing[change.capability] = change.providerId;
      readMutableFeatureOverrides(
        next,
        change.capability,
      ).modelOverride = null;
      if (
        change.capability === "answer"
        || change.capability === "chat"
        || change.capability === "embedding"
        || change.capability === "queryExpansion"
        || change.capability === "indexing"
      ) {
        readMutableModelFeatureOverrides(
          next,
          change.capability,
        ).contextCapacityTokensOverride = null;
      }
      if (
        change.capability === "answer"
        || change.capability === "chat"
        || change.capability === "queryExpansion"
        || change.capability === "indexing"
      ) {
        readMutableLanguageFeatureOverrides(
          next,
          change.capability,
        ).thinkingModeOverride = null;
      }
      if (change.capability === "textToSpeech") {
        next.featureOverrides.textToSpeech.voiceOverride = null;
      }
    }
  }
  return parseProviderSettings(next);
}

function configureApplicationFeature(
  settings: ProviderSettings,
  configuration: Extract<
    NormalizedProviderSettingsChange,
    { action: "feature" }
  >["configuration"],
): void {
  const capability = configuration.capability;
  settings.routing[capability] = configuration.providerId;
  readMutableFeatureOverrides(settings, capability).modelOverride =
    configuration.modelOverride;
  if (
    configuration.capability === "answer"
    || configuration.capability === "chat"
    || configuration.capability === "embedding"
    || configuration.capability === "queryExpansion"
    || configuration.capability === "indexing"
  ) {
    readMutableModelFeatureOverrides(
      settings,
      configuration.capability,
    ).contextCapacityTokensOverride =
      configuration.contextCapacityTokensOverride;
  }
  if (
    configuration.capability === "answer"
    || configuration.capability === "chat"
    || configuration.capability === "queryExpansion"
    || configuration.capability === "indexing"
  ) {
    readMutableLanguageFeatureOverrides(
      settings,
      configuration.capability,
    ).thinkingModeOverride = configuration.thinkingModeOverride;
  }
  if (configuration.capability === "textToSpeech") {
    settings.featureOverrides.textToSpeech.voiceOverride =
      configuration.voiceOverride;
  }
}

function configureProviderConnection(
  current: ProviderConnection,
  configuration: ProviderConnectionConfiguration,
  authentication: "api-token" | "openai-device",
): ProviderConnection {
  validateOpenAICodexConnectionConfiguration(authentication, configuration);
  return {
    adaptiveContextEnabled: configuration.adaptiveContextEnabled,
    apiToken: current.apiToken,
    answer: configureModelConnection(
      current.answer,
      configuration.answer,
    ),
    chat: configureModelConnection(
      current.chat ?? current.answer,
      configuration.chat ?? configuration.answer,
    ),
    baseUrl: configuration.baseUrl,
    customAdapters: { ...configuration.customAdapters },
    embedding: configureModelConnection(
      current.embedding,
      configuration.embedding,
    ),
    queryExpansion: configureModelConnection(
      current.queryExpansion,
      configuration.queryExpansion,
    ),
    maximumParallelRequests: configuration.maximumParallelRequests,
    name: configuration.name,
    sendReasoningOptions: configuration.sendReasoningOptions,
    thinkingMode: configuration.thinkingMode,
    reranking: configureCapabilityConnection(
      current.reranking,
      configuration.reranking,
    ),
    speechToText: configureCapabilityConnection(
      current.speechToText,
      configuration.speechToText,
    ),
    indexing: configureModelConnection(
      current.indexing,
      configuration.indexing,
    ),
    textToSpeech: {
      ...configureCapabilityConnection(
        current.textToSpeech,
        configuration.textToSpeech,
      ),
      voice: configuration.textToSpeech.voice,
    },
  };
}

function validateOpenAICodexConnectionConfiguration(
  authentication: "api-token" | "openai-device",
  configuration: ProviderConnectionConfiguration,
): void {
  if (authentication !== "openai-device") {
    return;
  }
  if (
    configuration.baseUrl !== "https://chatgpt.com/backend-api/codex"
    || configuration.answer.baseUrl !== null
    || (configuration.chat?.baseUrl ?? null) !== null
    || configuration.queryExpansion.baseUrl !== null
    || configuration.indexing.baseUrl !== null
  ) {
    throw new SettingsValidationError(
      "The OpenAI Codex device credential can only use the fixed ChatGPT Codex endpoint.",
    );
  }
}

function materializeChatSettings(settings: ProviderSettings): void {
  settings.routing.chat = settings.routing.chat ?? settings.routing.answer;
  settings.featureOverrides.chat = {
    ...(settings.featureOverrides.chat ?? settings.featureOverrides.answer),
  };
  for (const connection of Object.values(settings.connections)) {
    connection.chat = {
      ...(connection.chat ?? connection.answer),
    };
    connection.customAdapters.chat = connection.customAdapters.chat
      ?? connection.customAdapters.answer;
  }
}

function configureCapabilityConnection(
  current: ProviderCapabilityConnection,
  configuration: ProviderConnectionConfiguration["reranking"],
): ProviderCapabilityConnection {
  return {
    apiToken: current.apiToken,
    baseUrl: configuration.baseUrl,
    model: configuration.model,
  };
}

function configureModelConnection(
  current: ProviderModelConnection,
  configuration: ProviderConnectionConfiguration["answer"],
): ProviderModelConnection {
  return {
    ...configureCapabilityConnection(current, configuration),
    contextCapacityTokens: configuration.contextCapacityTokens,
  };
}

function setProviderCredential(
  connection: ProviderConnection,
  target: ProviderCredentialTarget,
  value: string | null,
): void {
  if (target === "shared") {
    connection.apiToken = value;
    connection.answer.apiToken = null;
    readMutableChatConnection(connection).apiToken = null;
    connection.embedding.apiToken = null;
    connection.queryExpansion.apiToken = null;
    connection.reranking.apiToken = null;
    connection.speechToText.apiToken = null;
    connection.indexing.apiToken = null;
    connection.textToSpeech.apiToken = null;
    return;
  }
  if (target === "chat") {
    readMutableChatConnection(connection).apiToken = value;
    return;
  }
  connection[target].apiToken = value;
}

function readMutableFeatureOverrides(
  settings: ProviderSettings,
  capability: ProviderCapability,
): ProviderCapabilityFeatureOverrides {
  if (capability === "chat") {
    settings.featureOverrides.chat ??= {
      ...settings.featureOverrides.answer,
    };
    return settings.featureOverrides.chat;
  }
  return settings.featureOverrides[capability];
}

function readMutableModelFeatureOverrides(
  settings: ProviderSettings,
  capability:
    | "answer"
    | "chat"
    | "embedding"
    | "queryExpansion"
    | "indexing",
): ProviderModelFeatureOverrides {
  if (capability === "chat") {
    settings.featureOverrides.chat ??= {
      ...settings.featureOverrides.answer,
    };
    return settings.featureOverrides.chat;
  }
  return settings.featureOverrides[capability];
}

function readMutableLanguageFeatureOverrides(
  settings: ProviderSettings,
  capability: "answer" | "chat" | "queryExpansion" | "indexing",
): ProviderLanguageFeatureOverrides {
  if (capability === "chat") {
    settings.featureOverrides.chat ??= {
      ...settings.featureOverrides.answer,
    };
    return settings.featureOverrides.chat;
  }
  return settings.featureOverrides[capability];
}

function readMutableChatConnection(
  connection: ProviderConnection,
): ProviderModelConnection {
  connection.chat ??= { ...connection.answer };
  return connection.chat;
}
