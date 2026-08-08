import { parseRuntimeSettings } from "./schemas.js";
import {
  parseProviderSettings,
  readProviderProfile,
  requireProviderConnection,
  resolveEmbeddingProvider,
  resolveLanguageProvider,
  readTextToSpeechSpeedRange,
  resolveProviderCapability,
  resolveTextToSpeechProvider,
} from "../providers/profiles.js";
import type {
  AppConfig,
  DatabaseConfig,
  DoclingServiceInstanceConfig,
  DoclingServiceTopology,
  EmbeddingDimensions,
  EmbeddingInferenceConfig,
  InferenceConfig,
  LanguageInferenceConfig,
  ProviderConcurrencyConfig,
  RerankerConfig,
  RuntimeSettings,
  ScheduledProviderCapability,
  SchedulingConfig,
  SourceContentConfig,
  SpeechToTextConfig,
  TextToSpeechConfig,
} from "./types.js";
import type {
  ProviderSettings,
} from "../providers/profiles.js";
import {
  createRetrievalWindowPolicy,
  createRetrievalWindowPolicyContract,
  type RetrievalWindowPolicyContract,
} from "../retrieval/window-policy.js";
import { HHEM_DISPLAY_MODEL } from "../verification/hhem-client.js";
import {
  BUILT_IN_EMBEDDING_INPUT_FORMAT_IDS,
  readEmbeddingInputFormatContract,
  type EmbeddingInputFormatContract,
} from "../embedding/input-format-model.js";

export function buildAppConfig(
  database: DatabaseConfig,
  settingsValue: RuntimeSettings,
  settingsVersion: number,
  providerSettingsValue: ProviderSettings,
  doclingServiceValues: readonly DoclingServiceInstanceConfig[],
  sourceContent: SourceContentConfig,
  embeddingInputFormatValue: EmbeddingInputFormatContract,
): AppConfig {
  const settings = parseRuntimeSettings(settingsValue);
  const providerSettings = parseProviderSettings(providerSettingsValue);
  const embeddingInputFormat = readEmbeddingInputFormatContract(
    embeddingInputFormatValue,
  );
  if (!Number.isInteger(settingsVersion) || settingsVersion < 0) {
    throw new Error("Settings version must be a nonnegative integer.");
  }
  const inference = buildInferenceConfig(
    settings,
    providerSettings,
    embeddingInputFormat,
  );
  const retrievalWindow = createRetrievalWindowPolicyContract(
    createRetrievalWindowPolicy(
      settings.retrievalWindowPolicy,
      settings.retrievalChunkTargetTokens,
      inference.embedding.maximumInputTokens,
    ),
  );
  const embeddingSpaceBaseId = settings.embeddingSpaceId
    ?? createEmbeddingSpaceId(
      inference.embedding.model,
      embeddingInputFormat,
      settings.embeddingDimensions,
      retrievalWindow,
    );
  const embeddingSpaceId = addRetrievalRepresentationVersion(
    embeddingSpaceBaseId,
  );
  const reranker = buildRerankerConfig(settings, providerSettings);
  const doclingServices = normalizeDoclingServiceInstances(
    doclingServiceValues,
    settings,
  );
  const claimVerifier: AppConfig["claimVerifier"] = {
    baseUrl: removeTrailingSlash(settings.claimVerifierBaseUrl),
    model: HHEM_DISPLAY_MODEL,
    runtimeName: settings.claimVerifierRuntimeName,
    supportThreshold: settings.claimVerifierSupportThreshold,
    timeoutMs: secondsToMilliseconds(settings.claimVerifierTimeoutSeconds),
  };
  const docling = buildDoclingConfig(settings, providerSettings);
  const embeddingSpace: AppConfig["embeddingSpace"] = {
    dimensions: settings.embeddingDimensions,
    id: embeddingSpaceId,
    inputFormat: embeddingInputFormat,
    model: inference.embedding.model,
    retrievalWindow,
  };
  const retrieval: AppConfig["retrieval"] = {
    answerTemperature: settings.answerTemperature,
    candidateK: settings.retrievalCandidates,
    chatTemperature: settings.chatTemperature,
    fusion: {
      denseWeight: settings.denseWeight,
      expansionDecay: settings.expansionDecay,
      expansionQueryWeight: settings.expansionQueryWeight,
      lexicalWeight: settings.lexicalWeight,
      originalQueryWeight: settings.originalQueryWeight,
    },
    mode: settings.searchMethod,
    queryExpansions: settings.queryExpansions,
    queryExpansionTemperature: settings.queryExpansionTemperature,
    reranker,
    rrfK: settings.rrfK,
    topK: settings.topK,
  };
  const sourceDiscovery: AppConfig["sourceDiscovery"] = {
    passagesPerDocument: settings.findSourcesPassagesPerDocument,
    resultsPerGroup: settings.findSourcesResults,
  };
  const retry: AppConfig["retry"] = {
    baseDelayMs: settings.retryBaseMs,
    maxAttempts: settings.maxAttempts,
  };
  const worker: AppConfig["worker"] = {
    concurrency: settings.workerConcurrency,
    fallbackPollIntervalMs: settings.workerFallbackPollMs,
  };
  return {
    claimVerifier,
    inferenceMetrics: {
      enabled: settings.aiMetricsEnabled,
    },
    database,
    docling,
    doclingServices,
    embeddingSpace,
    inference,
    maxDocumentBytes: settings.maxDocumentMegabytes * 1_024 * 1_024,
    retry,
    retrieval,
    scheduling: buildSchedulingConfig(
      settings,
      providerSettings,
      settingsVersion,
    ),
    settingsVersion,
    sourceDiscovery,
    sourceContent,
    speechToText: buildSpeechToTextConfig(settings, providerSettings),
    textToSpeech: buildTextToSpeechConfig(settings, providerSettings),
    worker,
  };
}

function buildDoclingConfig(
  settings: RuntimeSettings,
  providerSettings: ProviderSettings,
): AppConfig["docling"] {
  return {
    apiKey: settings.doclingApiKey,
    baseTimeoutMs: secondsToMilliseconds(settings.doclingTimeoutSeconds),
    baseUrl: removeTrailingSlash(settings.doclingBaseUrl),
    maxTimeoutMs: secondsToMilliseconds(settings.doclingMaxTimeoutSeconds),
    megabyteTimeoutMs: secondsToMilliseconds(settings.doclingMegabyteTimeoutSeconds),
    ocrEnabled: settings.doclingOcrEnabled,
    pageTimeoutMs: secondsToMilliseconds(settings.doclingPageTimeoutSeconds),
    pdfBackend: settings.doclingPdfBackend,
    performanceMetricsEnabled: settings.doclingPerformanceMetricsEnabled,
    performanceMetricsRetentionDays:
      settings.doclingPerformanceMetricsRetentionDays,
    pipeline: settings.doclingPipeline,
    requestTimeoutMs: secondsToMilliseconds(settings.doclingRequestTimeoutSeconds),
    secondaryImageScale: settings.doclingSecondaryImageScale,
    tableMode: settings.doclingTableMode,
    tableStructureEnabled: settings.doclingTableStructureEnabled,
    tocEnabled: settings.doclingTocEnabled,
    vlm: resolveDoclingVlmConfig(settings, providerSettings),
  };
}

function resolveDoclingVlmConfig(
  settings: RuntimeSettings,
  providerSettings: ProviderSettings,
): AppConfig["docling"]["vlm"] {
  if (settings.doclingPipeline === "standard") {
    return null;
  }
  const providerId = settings.doclingVlmProviderId;
  const connection = requireProviderConnection(providerSettings, providerId);
  const baseUrl = connection.answer.baseUrl ?? connection.baseUrl;
  const model = settings.doclingVlmModelOverride ?? connection.answer.model;
  const profile = readProviderProfile(providerSettings, providerId);
  if (profile?.doclingVlm === null || profile === undefined) {
    throw new Error(
      `Provider ${providerId} does not support Docling VLM processing.`,
    );
  }
  if (baseUrl === null) {
    throw new Error(
      `${profile?.displayName ?? providerId} has no URL configured for Docling VLM processing.`,
    );
  }
  if (model === null) {
    throw new Error(
      `${profile?.displayName ?? providerId} has no model configured for Docling VLM processing.`,
    );
  }
  return {
    apiToken: connection.answer.apiToken ?? connection.apiToken,
    endpointUrl: buildDoclingVlmEndpoint(
      profile.doclingVlm.endpointStyle,
      baseUrl,
    ),
    engineType: profile.doclingVlm.engineType,
    maxOutputTokens: settings.doclingVlmMaxOutputTokens,
    model,
    prompt: settings.doclingVlmPrompt,
    providerId,
    runtimeName: connection.name ?? profile?.displayName ?? providerId,
  };
}

function buildDoclingVlmEndpoint(
  endpointStyle: "ollama" | "openai",
  baseUrl: string,
): string {
  const normalized = removeTrailingSlash(baseUrl);
  if (normalized.endsWith("/chat/completions")) {
    return normalized;
  }
  if (endpointStyle === "ollama" && !normalized.endsWith("/v1")) {
    return `${normalized}/v1/chat/completions`;
  }
  return `${normalized}/chat/completions`;
}

export function readEmbeddingConfigurationWarnings(
  settings: {
    embeddingContextCapacityTokens: number;
    retrievalChunkTargetTokens: number;
  },
): string[] {
  if (
    settings.retrievalChunkTargetTokens
    <= settings.embeddingContextCapacityTokens
  ) {
    return [];
  }
  return [
    `Document section size ${settings.retrievalChunkTargetTokens} exceeds `
    + `the embedding model's maximum input of ${settings.embeddingContextCapacityTokens} tokens. `
    + `CiteLoom will use ${settings.embeddingContextCapacityTokens} tokens instead.`,
  ];
}

export function readDoclingServiceTopologyFromConfig(
  config: AppConfig,
): DoclingServiceTopology {
  const defaultService = config.doclingServices.find((service) => {
    return service.id === "default";
  });
  if (defaultService === undefined) {
    throw new Error('Docling service configuration must include service ID "default".');
  }
  const additionalServices: DoclingServiceTopology["additionalServices"] = [];
  for (const service of config.doclingServices) {
    if (service.id === "default") {
      continue;
    }
    additionalServices.push({
      baseUrl: service.baseUrl,
      capacity: service.capacity,
      id: service.id,
    });
  }
  return {
    additionalServices,
    process: { ...defaultService.process },
  };
}

function normalizeDoclingServiceInstances(
  values: readonly DoclingServiceInstanceConfig[],
  settings: RuntimeSettings,
): DoclingServiceInstanceConfig[] {
  const singleService = values[0];
  if (
    values.length === 1
    && singleService !== undefined
    && singleService.id === "default"
  ) {
    return [{
      baseUrl: removeTrailingSlash(settings.doclingBaseUrl),
      capacity: settings.doclingDefaultServiceCapacity,
      id: singleService.id,
      process: { ...singleService.process },
    }];
  }
  const services: DoclingServiceInstanceConfig[] = [];
  const identifiers = new Set<string>();
  const baseUrls = new Set<string>();
  let foundDefault = false;
  for (const value of values) {
    const baseUrl = value.id === "default"
      ? removeTrailingSlash(settings.doclingBaseUrl)
      : removeTrailingSlash(value.baseUrl);
    if (identifiers.has(value.id)) {
      throw new Error(`Duplicate Docling service ID ${value.id}.`);
    }
    if (baseUrls.has(baseUrl)) {
      throw new Error(`Duplicate Docling service base URL ${baseUrl}.`);
    }
    if (!Number.isInteger(value.capacity) || value.capacity < 1) {
      throw new Error(`Docling service ${value.id} must have positive integer capacity.`);
    }
    if (!Number.isInteger(value.process.numThreads) || value.process.numThreads < 1) {
      throw new Error(`Docling service ${value.id} must have positive integer thread count.`);
    }
    if (!Number.isInteger(value.process.pageBatchSize) || value.process.pageBatchSize < 1) {
      throw new Error(`Docling service ${value.id} must have positive integer page batch size.`);
    }
    foundDefault = foundDefault || value.id === "default";
    identifiers.add(value.id);
    baseUrls.add(baseUrl);
    services.push({
      baseUrl,
      capacity: value.id === "default"
        ? settings.doclingDefaultServiceCapacity
        : value.capacity,
      id: value.id,
      process: { ...value.process },
    });
  }
  if (!foundDefault) {
    throw new Error('Docling service configuration must include service ID "default".');
  }
  return services;
}

function buildSchedulingConfig(
  settings: RuntimeSettings,
  providerSettings: ProviderSettings,
  settingsVersion: number,
): SchedulingConfig {
  const targets: SchedulingConfig["targets"] = {};
  const scheduledCapabilities: ScheduledProviderCapability[] = [
    "answer",
    "chat",
    "embedding",
    "queryExpansion",
    "reranking",
    "speechToText",
    "indexing",
    "textToSpeech",
  ];
  for (const capability of scheduledCapabilities) {
    if (capability === "queryExpansion" && settings.queryExpansions === 0) {
      continue;
    }
    const providerId = capability === "chat"
      ? providerSettings.routing.chat ?? providerSettings.routing.answer
      : providerSettings.routing[capability];
    if (providerId === null) {
      continue;
    }
    targets[capability] = { providerId };
  }
  const providers: ProviderConcurrencyConfig[] = [];
  for (const [providerId, connection] of Object.entries(
    providerSettings.connections,
  )) {
    const profile = readProviderProfile(providerSettings, providerId);
    providers.push({
      maximumParallelRequests: connection.maximumParallelRequests,
      name: connection.name ?? profile?.displayName ?? providerId,
      providerId,
    });
  }
  providers.sort((left, right) => {
    return left.providerId.localeCompare(right.providerId);
  });
  return {
    backgroundProgressIntervalMs: settings.backgroundProgressIntervalMs,
    providers,
    settingsVersion,
    targets,
    telemetryEnabled: settings.aiMetricsEnabled,
  };
}

function buildRerankerConfig(
  settings: RuntimeSettings,
  providerSettings: ProviderSettings,
): RerankerConfig | null {
  const provider = resolveProviderCapability(providerSettings, "reranking");
  if (provider === null) {
    return null;
  }
  return {
    adapter: provider.adapter,
    apiToken: provider.apiToken,
    baseUrl: provider.baseUrl,
    discoveryMinimumScore: settings.rerankDiscoveryMinimumScore,
    model: provider.model,
    providerId: provider.providerId,
    runtimeName: provider.runtimeName,
    timeoutMs: secondsToMilliseconds(settings.rerankTimeoutSeconds),
  };
}

function buildInferenceConfig(
  settings: RuntimeSettings,
  providerSettings: ProviderSettings,
  embeddingInputFormat: EmbeddingInputFormatContract,
): InferenceConfig {
  const answer = resolveLanguageProvider(providerSettings, "answer");
  const chat = resolveLanguageProvider(providerSettings, "chat");
  const embedding = resolveEmbeddingProvider(providerSettings);
  let queryExpansion: LanguageInferenceConfig | null = null;
  if (settings.queryExpansions > 0) {
    const provider = resolveLanguageProvider(
      providerSettings,
      "queryExpansion",
    );
    queryExpansion = buildLanguageInferenceConfig(
      provider,
      secondsToMilliseconds(settings.queryExpansionTimeoutSeconds),
    );
  }
  const indexing = resolveLanguageProvider(providerSettings, "indexing");
  return {
    answer: buildLanguageInferenceConfig(
      answer,
      secondsToMilliseconds(settings.answerTimeoutSeconds),
    ),
    answerBudget: {
      minimumOutputTokens: settings.answerMinimumOutputTokens,
      providerSafetyMarginTokens: settings.answerProviderSafetyMarginTokens,
    },
    chat: buildLanguageInferenceConfig(
      chat,
      secondsToMilliseconds(settings.answerTimeoutSeconds),
    ),
    embedding: buildEmbeddingInferenceConfig(
      embedding,
      embeddingInputFormat,
      secondsToMilliseconds(settings.embeddingTimeoutSeconds),
    ),
    queryExpansion,
    indexing: buildLanguageInferenceConfig(
      indexing,
      secondsToMilliseconds(settings.indexingTimeoutSeconds),
    ),
  };
}

function buildLanguageInferenceConfig(
  provider: ReturnType<typeof resolveLanguageProvider>,
  timeoutMs: number,
): LanguageInferenceConfig {
  return {
    adaptiveContextEnabled: provider.adaptiveContextEnabled,
    adapter: provider.adapter,
    apiToken: provider.apiToken,
    baseUrl: provider.baseUrl,
    contextCapacityTokens: provider.contextCapacityTokens,
    model: provider.model,
    providerId: provider.providerId,
    runtimeName: provider.runtimeName,
    sendReasoningOptions: provider.sendReasoningOptions,
    thinkingMode: provider.thinkingMode,
    timeoutMs,
  };
}

function buildEmbeddingInferenceConfig(
  provider: ReturnType<typeof resolveEmbeddingProvider>,
  inputFormat: EmbeddingInputFormatContract,
  timeoutMs: number,
): EmbeddingInferenceConfig {
  return {
    adapter: provider.adapter,
    apiToken: provider.apiToken,
    baseUrl: provider.baseUrl,
    inputFormat,
    maximumInputTokens: provider.contextCapacityTokens,
    model: provider.model,
    providerId: provider.providerId,
    runtimeName: provider.runtimeName,
    timeoutMs,
  };
}

function buildTextToSpeechConfig(
  settings: RuntimeSettings,
  providerSettings: ProviderSettings,
): TextToSpeechConfig | null {
  const provider = resolveTextToSpeechProvider(providerSettings);
  if (provider === null) {
    return null;
  }
  const speedRange = readTextToSpeechSpeedRange(provider.adapter);
  if (
    settings.ttsSpeed < speedRange.minimum
    || settings.ttsSpeed > speedRange.maximum
  ) {
    throw new Error(
      `${speedRange.displayName} speech speed must be from ${speedRange.minimum} to ${speedRange.maximum}.`,
    );
  }
  return {
    adapter: provider.adapter,
    apiToken: provider.apiToken,
    baseUrl: provider.baseUrl,
    model: provider.model,
    preload: settings.ttsPreloadEnabled,
    providerId: provider.providerId,
    runtimeName: provider.runtimeName,
    speed: settings.ttsSpeed,
    timeoutMs: secondsToMilliseconds(settings.ttsTimeoutSeconds),
    voice: provider.voice,
  };
}

function buildSpeechToTextConfig(
  settings: RuntimeSettings,
  providerSettings: ProviderSettings,
): SpeechToTextConfig | null {
  const provider = resolveProviderCapability(providerSettings, "speechToText");
  if (provider === null) {
    return null;
  }
  return {
    adapter: provider.adapter,
    apiToken: provider.apiToken,
    baseUrl: provider.baseUrl,
    language: settings.sttLanguage,
    maxAudioBytes: settings.sttMaxAudioMegabytes * 1_024 * 1_024,
    model: provider.model,
    prompt: settings.sttPrompt,
    providerId: provider.providerId,
    runtimeName: provider.runtimeName,
    timeoutMs: secondsToMilliseconds(settings.sttTimeoutSeconds),
  };
}

function removeTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function secondsToMilliseconds(value: number): number {
  return value * 1_000;
}

function createEmbeddingSpaceId(
  model: string,
  inputFormat: EmbeddingInputFormatContract,
  dimensions: EmbeddingDimensions,
  retrievalWindow: RetrievalWindowPolicyContract,
): string {
  const formatIdentity = readEmbeddingSpaceInputFormatIdentity(inputFormat);
  const baseId = `${model}:${formatIdentity}:${dimensions}`;
  return `${baseId}:window-${retrievalWindow.fingerprint.slice(0, 16)}`;
}

function addRetrievalRepresentationVersion(baseId: string): string {
  const suffix = ":representations-v2";
  return baseId.endsWith(suffix) ? baseId : `${baseId}${suffix}`;
}

function readEmbeddingSpaceInputFormatIdentity(
  inputFormat: EmbeddingInputFormatContract,
): string {
  if (inputFormat.id === BUILT_IN_EMBEDDING_INPUT_FORMAT_IDS.plain) {
    return "plain";
  }
  if (inputFormat.id === BUILT_IN_EMBEDDING_INPUT_FORMAT_IDS.embeddingGemma) {
    return "embeddinggemma";
  }
  return `format-${inputFormat.id}-${inputFormat.inputFormatHash.slice(0, 16)}`;
}
