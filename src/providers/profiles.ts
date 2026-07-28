import { z } from "zod";

import type {
  EmbeddingModelAdapter,
  LanguageModelAdapter,
  RerankerAdapter,
  SpeechToTextAdapter,
  TextToSpeechAdapter,
} from "../config/types.js";

export const PROVIDER_IDS = [
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
] as const;

export const PROVIDER_CAPABILITIES = [
  "answer",
  "queryExpansion",
  "summarization",
  "embedding",
  "reranking",
  "speechToText",
  "textToSpeech",
] as const;

export type ProviderId = typeof PROVIDER_IDS[number];
export type ProviderCapability = typeof PROVIDER_CAPABILITIES[number];
export type CustomLanguageModelAdapter = Exclude<
  LanguageModelAdapter,
  "openai-codex-language"
>;

export type ProviderCapabilityProfile =
  | { adapter: LanguageModelAdapter; capability: "answer" }
  | { adapter: LanguageModelAdapter; capability: "queryExpansion" }
  | { adapter: LanguageModelAdapter; capability: "summarization" }
  | { adapter: EmbeddingModelAdapter; capability: "embedding" }
  | { adapter: RerankerAdapter; capability: "reranking" }
  | { adapter: SpeechToTextAdapter; capability: "speechToText" }
  | { adapter: TextToSpeechAdapter; capability: "textToSpeech" };

export interface ProviderProfile {
  capabilities: readonly ProviderCapabilityProfile[];
  displayName: string;
  id: ProviderId;
}

export interface ProviderCapabilityConnection {
  apiToken: string | null;
  baseUrl: string | null;
  model: string | null;
}

export interface ProviderModelConnection
  extends ProviderCapabilityConnection {
  contextCapacityTokens: number | null;
}

export interface ProviderTextToSpeechConnection
  extends ProviderCapabilityConnection {
  voice: string | null;
}

export interface CustomProviderAdapters {
  answer: CustomLanguageModelAdapter;
  embedding: EmbeddingModelAdapter;
  queryExpansion: CustomLanguageModelAdapter;
  reranking: RerankerAdapter;
  speechToText: SpeechToTextAdapter;
  summarization: CustomLanguageModelAdapter;
  textToSpeech: TextToSpeechAdapter;
}

export interface ProviderConnection {
  apiToken: string | null;
  baseUrl: string | null;
  customAdapters: CustomProviderAdapters;
  maximumParallelRequests: number;
  name: string | null;
  answer: ProviderModelConnection;
  embedding: ProviderModelConnection;
  queryExpansion: ProviderModelConnection;
  reranking: ProviderCapabilityConnection;
  speechToText: ProviderCapabilityConnection;
  summarization: ProviderModelConnection;
  textToSpeech: ProviderTextToSpeechConnection;
}

export interface ProviderRouting {
  answer: ProviderId | null;
  embedding: ProviderId | null;
  queryExpansion: ProviderId | null;
  reranking: ProviderId | null;
  speechToText: ProviderId | null;
  summarization: ProviderId | null;
  textToSpeech: ProviderId | null;
}

export interface ProviderCapabilityFeatureOverrides {
  modelOverride: string | null;
}

export interface ProviderModelFeatureOverrides
  extends ProviderCapabilityFeatureOverrides {
  contextCapacityTokensOverride: number | null;
}

export interface ProviderTextToSpeechFeatureOverrides
  extends ProviderCapabilityFeatureOverrides {
  voiceOverride: string | null;
}

export interface ProviderFeatureOverrides {
  answer: ProviderModelFeatureOverrides;
  embedding: ProviderModelFeatureOverrides;
  queryExpansion: ProviderModelFeatureOverrides;
  reranking: ProviderCapabilityFeatureOverrides;
  speechToText: ProviderCapabilityFeatureOverrides;
  summarization: ProviderModelFeatureOverrides;
  textToSpeech: ProviderTextToSpeechFeatureOverrides;
}

export interface ProviderSettings {
  connections: Record<ProviderId, ProviderConnection>;
  featureOverrides: ProviderFeatureOverrides;
  routing: ProviderRouting;
}

export interface ProviderCapabilityConfiguration {
  baseUrl: string | null;
  model: string | null;
}

export interface ProviderModelConfiguration
  extends ProviderCapabilityConfiguration {
  contextCapacityTokens: number | null;
}

export interface ProviderTextToSpeechConfiguration
  extends ProviderCapabilityConfiguration {
  voice: string | null;
}

export interface ProviderConnectionConfiguration {
  baseUrl: string | null;
  customAdapters: CustomProviderAdapters;
  maximumParallelRequests: number;
  name: string | null;
  answer: ProviderModelConfiguration;
  embedding: ProviderModelConfiguration;
  queryExpansion: ProviderModelConfiguration;
  reranking: ProviderCapabilityConfiguration;
  speechToText: ProviderCapabilityConfiguration;
  summarization: ProviderModelConfiguration;
  textToSpeech: ProviderTextToSpeechConfiguration;
}

export type ProviderCredentialTarget = "shared" | ProviderCapability;

export type ProviderFeatureConfiguration =
  | {
    capability: "answer" | "embedding" | "queryExpansion" | "summarization";
    contextCapacityTokensOverride: number | null;
    modelOverride: string | null;
    providerId: ProviderId | null;
  }
  | {
    capability: "reranking" | "speechToText";
    modelOverride: string | null;
    providerId: ProviderId | null;
  }
  | {
    capability: "textToSpeech";
    modelOverride: string | null;
    providerId: ProviderId | null;
    voiceOverride: string | null;
  };

export type NormalizedProviderSettingsChange =
  | { action: "configure"; configuration: ProviderConnectionConfiguration; providerId: ProviderId }
  | { action: "credential"; providerId: ProviderId; target: ProviderCredentialTarget; value: string | null }
  | { action: "feature"; configuration: ProviderFeatureConfiguration }
  | { action: "reset" }
  | { action: "route"; capability: ProviderCapability; providerId: ProviderId | null };

export interface ResolvedProviderCapability {
  adapter:
    | EmbeddingModelAdapter
    | LanguageModelAdapter
    | RerankerAdapter
    | SpeechToTextAdapter
    | TextToSpeechAdapter;
  apiToken: string | null;
  baseUrl: string;
  model: string;
  providerId: ProviderId;
  runtimeName: string;
}

export interface ResolvedLanguageProvider extends ResolvedProviderCapability {
  adapter: LanguageModelAdapter;
  contextCapacityTokens: number;
}

export interface ResolvedEmbeddingProvider extends ResolvedProviderCapability {
  adapter: EmbeddingModelAdapter;
  contextCapacityTokens: number;
}

export interface ResolvedRerankingProvider
  extends ResolvedProviderCapability {
  adapter: RerankerAdapter;
}

export interface ResolvedSpeechToTextProvider
  extends ResolvedProviderCapability {
  adapter: SpeechToTextAdapter;
}

export interface ResolvedTextToSpeechProvider
  extends ResolvedProviderCapability {
  adapter: TextToSpeechAdapter;
  voice: string;
}

export interface TextToSpeechSpeedRange {
  displayName: string;
  maximum: number;
  minimum: number;
}

export type ProviderAuthenticationMethod = "api-token" | "openai-device";

const httpUrlSchema = z.url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "must use http or https");
export const providerConfigurationTextSchema = z.string()
  .trim()
  .min(1)
  .nullable();
export const providerCredentialSchema = z.string()
  .trim()
  .min(1)
  .nullable();
export const providerIdSchema = z.enum(PROVIDER_IDS);
export const providerCapabilitySchema = z.enum(PROVIDER_CAPABILITIES);
export const languageModelAdapterSchema = z.enum([
  "cohere-language",
  "deepseek-language",
  "ollama-language",
  "openai-codex-language",
  "openai-compatible-language",
]);
const customLanguageModelAdapterSchema = z.enum([
  "cohere-language",
  "deepseek-language",
  "ollama-language",
  "openai-compatible-language",
]);
export const embeddingModelAdapterSchema = z.enum([
  "cohere-embedding",
  "ollama-embedding",
  "openai-compatible-embedding",
]);
export const rerankerAdapterSchema = z.enum(["top-n-rerank"]);
export const speechToTextAdapterSchema = z.enum([
  "omlx-transcription",
  "openai-transcription",
]);
export const textToSpeechAdapterSchema = z.enum([
  "groq-speech",
  "omlx-speech",
  "openai-speech",
]);
const providerCapabilityConnectionSchema = z.object({
  apiToken: providerCredentialSchema,
  baseUrl: httpUrlSchema.nullable(),
  model: providerConfigurationTextSchema,
}).strict();
const providerModelConnectionSchema = providerCapabilityConnectionSchema.extend({
  contextCapacityTokens: z.number().int().positive().nullable(),
}).strict();
const providerConnectionSchema = z.object({
  apiToken: providerCredentialSchema,
  baseUrl: httpUrlSchema.nullable(),
  customAdapters: z.object({
    answer: customLanguageModelAdapterSchema,
    embedding: embeddingModelAdapterSchema,
    queryExpansion: customLanguageModelAdapterSchema,
    reranking: rerankerAdapterSchema,
    speechToText: speechToTextAdapterSchema,
    summarization: customLanguageModelAdapterSchema,
    textToSpeech: textToSpeechAdapterSchema,
  }).strict(),
  maximumParallelRequests: z.number().int().min(1).max(16),
  name: z.string().trim().min(1).max(100).nullable(),
  answer: providerModelConnectionSchema,
  embedding: providerModelConnectionSchema,
  queryExpansion: providerModelConnectionSchema,
  reranking: providerCapabilityConnectionSchema,
  speechToText: providerCapabilityConnectionSchema,
  summarization: providerModelConnectionSchema,
  textToSpeech: providerCapabilityConnectionSchema.extend({
    voice: providerConfigurationTextSchema,
  }).strict(),
}).strict();

const providerCapabilityFeatureOverridesSchema = z.object({
  modelOverride: providerConfigurationTextSchema,
}).strict();
const providerModelFeatureOverridesSchema =
  providerCapabilityFeatureOverridesSchema.extend({
    contextCapacityTokensOverride: z.number().int().positive().nullable(),
  }).strict();
export const providerFeatureOverridesSchema = z.object({
  answer: providerModelFeatureOverridesSchema,
  embedding: providerModelFeatureOverridesSchema,
  queryExpansion: providerModelFeatureOverridesSchema,
  reranking: providerCapabilityFeatureOverridesSchema,
  speechToText: providerCapabilityFeatureOverridesSchema,
  summarization: providerModelFeatureOverridesSchema,
  textToSpeech: providerCapabilityFeatureOverridesSchema.extend({
    voiceOverride: providerConfigurationTextSchema,
  }).strict(),
}).strict();

export const providerConnectionConfigurationSchema = z.object({
  baseUrl: httpUrlSchema.nullable(),
  customAdapters: z.object({
    answer: customLanguageModelAdapterSchema,
    embedding: embeddingModelAdapterSchema,
    queryExpansion: customLanguageModelAdapterSchema,
    reranking: rerankerAdapterSchema,
    speechToText: speechToTextAdapterSchema,
    summarization: customLanguageModelAdapterSchema,
    textToSpeech: textToSpeechAdapterSchema,
  }).strict(),
  maximumParallelRequests: z.number().int().min(1).max(16),
  name: z.string().trim().min(1).max(100).nullable(),
  answer: z.object({
    baseUrl: httpUrlSchema.nullable(),
    contextCapacityTokens: z.number().int().positive().nullable(),
    model: providerConfigurationTextSchema,
  }).strict(),
  embedding: z.object({
    baseUrl: httpUrlSchema.nullable(),
    contextCapacityTokens: z.number().int().positive().nullable(),
    model: providerConfigurationTextSchema,
  }).strict(),
  queryExpansion: z.object({
    baseUrl: httpUrlSchema.nullable(),
    contextCapacityTokens: z.number().int().positive().nullable(),
    model: providerConfigurationTextSchema,
  }).strict(),
  reranking: z.object({
    baseUrl: httpUrlSchema.nullable(),
    model: providerConfigurationTextSchema,
  }).strict(),
  speechToText: z.object({
    baseUrl: httpUrlSchema.nullable(),
    model: providerConfigurationTextSchema,
  }).strict(),
  summarization: z.object({
    baseUrl: httpUrlSchema.nullable(),
    contextCapacityTokens: z.number().int().positive().nullable(),
    model: providerConfigurationTextSchema,
  }).strict(),
  textToSpeech: z.object({
    baseUrl: httpUrlSchema.nullable(),
    model: providerConfigurationTextSchema,
    voice: providerConfigurationTextSchema,
  }).strict(),
}).strict();

export const providerSettingsSchema = z.object({
  connections: z.record(providerIdSchema, providerConnectionSchema),
  featureOverrides: providerFeatureOverridesSchema,
  routing: z.object({
    answer: providerIdSchema.nullable(),
    embedding: providerIdSchema.nullable(),
    queryExpansion: providerIdSchema.nullable(),
    reranking: providerIdSchema.nullable(),
    speechToText: providerIdSchema.nullable(),
    summarization: providerIdSchema.nullable(),
    textToSpeech: providerIdSchema.nullable(),
  }).strict(),
}).strict().superRefine((settings, context) => {
  validateSelectedProvider(settings, "answer", context);
  validateSelectedProvider(settings, "queryExpansion", context);
  validateSelectedProvider(settings, "summarization", context);
  validateSelectedProvider(settings, "embedding", context);
  validateSelectedProvider(settings, "reranking", context);
  validateSelectedProvider(settings, "speechToText", context);
  validateSelectedProvider(settings, "textToSpeech", context);
});

export const providerCatalog: readonly ProviderProfile[] = [
  {
    capabilities: [
      { adapter: "openai-compatible-language", capability: "answer" },
      { adapter: "openai-compatible-language", capability: "queryExpansion" },
      { adapter: "openai-compatible-language", capability: "summarization" },
      { adapter: "openai-compatible-embedding", capability: "embedding" },
      { adapter: "top-n-rerank", capability: "reranking" },
      { adapter: "omlx-transcription", capability: "speechToText" },
      { adapter: "omlx-speech", capability: "textToSpeech" },
    ],
    displayName: "oMLX",
    id: "omlx",
  },
  {
    capabilities: [
      { adapter: "ollama-language", capability: "answer" },
      { adapter: "ollama-language", capability: "queryExpansion" },
      { adapter: "ollama-embedding", capability: "embedding" },
      { adapter: "ollama-language", capability: "summarization" },
    ],
    displayName: "Ollama",
    id: "ollama",
  },
  {
    capabilities: [
      { adapter: "openai-compatible-language", capability: "answer" },
      { adapter: "openai-compatible-language", capability: "queryExpansion" },
      { adapter: "openai-compatible-language", capability: "summarization" },
      { adapter: "openai-compatible-embedding", capability: "embedding" },
    ],
    displayName: "LM Studio",
    id: "lmstudio",
  },
  {
    capabilities: [
      { adapter: "openai-compatible-language", capability: "answer" },
      { adapter: "openai-compatible-language", capability: "queryExpansion" },
      { adapter: "openai-compatible-language", capability: "summarization" },
      { adapter: "openai-compatible-embedding", capability: "embedding" },
      { adapter: "openai-transcription", capability: "speechToText" },
      { adapter: "openai-speech", capability: "textToSpeech" },
    ],
    displayName: "OpenAI",
    id: "openai",
  },
  {
    capabilities: [
      { adapter: "openai-codex-language", capability: "answer" },
      { adapter: "openai-codex-language", capability: "queryExpansion" },
      { adapter: "openai-codex-language", capability: "summarization" },
    ],
    displayName: "OpenAI Codex",
    id: "openai-codex",
  },
  {
    capabilities: [
      { adapter: "deepseek-language", capability: "answer" },
      { adapter: "deepseek-language", capability: "queryExpansion" },
      { adapter: "deepseek-language", capability: "summarization" },
    ],
    displayName: "DeepSeek",
    id: "deepseek",
  },
  {
    capabilities: [
      { adapter: "openai-compatible-language", capability: "answer" },
      { adapter: "openai-compatible-language", capability: "queryExpansion" },
      { adapter: "openai-compatible-language", capability: "summarization" },
      { adapter: "openai-transcription", capability: "speechToText" },
      { adapter: "groq-speech", capability: "textToSpeech" },
    ],
    displayName: "Groq",
    id: "groq",
  },
  {
    capabilities: [
      { adapter: "cohere-language", capability: "answer" },
      { adapter: "cohere-language", capability: "queryExpansion" },
      { adapter: "cohere-language", capability: "summarization" },
      { adapter: "cohere-embedding", capability: "embedding" },
      { adapter: "top-n-rerank", capability: "reranking" },
    ],
    displayName: "Cohere",
    id: "cohere",
  },
  {
    capabilities: [
      { adapter: "openai-compatible-embedding", capability: "embedding" },
      { adapter: "top-n-rerank", capability: "reranking" },
    ],
    displayName: "Jina",
    id: "jina",
  },
  {
    capabilities: [
      { adapter: "openai-compatible-language", capability: "answer" },
      { adapter: "openai-compatible-language", capability: "queryExpansion" },
      { adapter: "openai-compatible-language", capability: "summarization" },
      { adapter: "openai-compatible-embedding", capability: "embedding" },
      { adapter: "top-n-rerank", capability: "reranking" },
      { adapter: "openai-transcription", capability: "speechToText" },
      { adapter: "openai-speech", capability: "textToSpeech" },
    ],
    displayName: "Custom",
    id: "custom",
  },
];

const profileById = new Map<ProviderId, ProviderProfile>();
for (const profile of providerCatalog) {
  profileById.set(profile.id, profile);
}

export function parseProviderSettings(value: unknown): ProviderSettings {
  const result = providerSettingsSchema.safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map((issue) => {
      const path = issue.path.length === 0
        ? "providers"
        : `providers.${issue.path.join(".")}`;
      return `- ${path}: ${issue.message}`;
    }).join("\n");
    throw new Error(`Invalid provider configuration:\n${details}`);
  }
  return result.data;
}

export function readProviderConnectionConfiguration(
  connection: ProviderConnection,
): ProviderConnectionConfiguration {
  return {
    answer: readModelConfiguration(connection.answer),
    baseUrl: connection.baseUrl,
    customAdapters: { ...connection.customAdapters },
    embedding: readModelConfiguration(connection.embedding),
    queryExpansion: readModelConfiguration(connection.queryExpansion),
    maximumParallelRequests: connection.maximumParallelRequests,
    name: connection.name,
    reranking: readCapabilityConfiguration(connection.reranking),
    speechToText: readCapabilityConfiguration(connection.speechToText),
    summarization: readModelConfiguration(connection.summarization),
    textToSpeech: {
      ...readCapabilityConfiguration(connection.textToSpeech),
      voice: connection.textToSpeech.voice,
    },
  };
}

export function providerSupportsCapability(
  providerId: ProviderId,
  capability: ProviderCapability,
): boolean {
  const profile = requireProviderProfile(providerId);
  return profile.capabilities.some((candidate) => {
    return candidate.capability === capability;
  });
}

export function readProviderAuthenticationMethod(
  providerId: ProviderId,
): ProviderAuthenticationMethod {
  return providerId === "openai-codex" ? "openai-device" : "api-token";
}

export function resolveProviderCapability(
  settings: ProviderSettings,
  capability: "reranking",
): ResolvedRerankingProvider | null;
export function resolveProviderCapability(
  settings: ProviderSettings,
  capability: "speechToText",
): ResolvedSpeechToTextProvider | null;
export function resolveProviderCapability(
  settings: ProviderSettings,
  capability: "reranking" | "speechToText",
): ResolvedProviderCapability | null {
  const provider = resolveConfiguredProvider(settings, capability);
  if (provider === null) {
    return null;
  }
  if (capability === "reranking" && !isRerankerAdapter(provider.adapter)) {
    throw new Error("The selected reranking provider has an invalid adapter.");
  }
  if (
    capability === "speechToText"
    && !isSpeechToTextAdapter(provider.adapter)
  ) {
    throw new Error("The selected speech-to-text provider has an invalid adapter.");
  }
  return provider;
}

export function resolveLanguageProvider(
  settings: ProviderSettings,
  capability: "answer" | "queryExpansion" | "summarization",
): ResolvedLanguageProvider {
  const provider = resolveConfiguredProvider(settings, capability);
  if (provider === null) {
    throw new Error(`${formatCapability(capability)} requires a provider.`);
  }
  if (!isLanguageModelAdapter(provider.adapter)) {
    throw new Error(
      `The selected ${formatCapability(capability)} provider has an invalid adapter.`,
    );
  }
  return {
    ...provider,
    adapter: provider.adapter,
    contextCapacityTokens: readEffectiveModelContextCapacity(
      settings,
      provider.providerId,
      capability,
    ),
  };
}

export function resolveEmbeddingProvider(
  settings: ProviderSettings,
): ResolvedEmbeddingProvider {
  const provider = resolveConfiguredProvider(settings, "embedding");
  if (provider === null) {
    throw new Error("embedding requires a provider.");
  }
  if (!isEmbeddingModelAdapter(provider.adapter)) {
    throw new Error("The selected embedding provider has an invalid adapter.");
  }
  return {
    ...provider,
    adapter: provider.adapter,
    contextCapacityTokens: readEffectiveModelContextCapacity(
      settings,
      provider.providerId,
      "embedding",
    ),
  };
}

function resolveConfiguredProvider(
  settings: ProviderSettings,
  capability: ProviderCapability,
): ResolvedProviderCapability | null {
  const providerId = settings.routing[capability];
  if (providerId === null) {
    return null;
  }
  const profile = requireProviderProfile(providerId);
  const connection = settings.connections[providerId];
  const capabilityConnection = connection[capability];
  const adapter = readAdapter(profile, connection, capability);
  const baseUrl = capabilityConnection.baseUrl
    ?? connection.baseUrl;
  const model = settings.featureOverrides[capability].modelOverride
    ?? capabilityConnection.model;
  if (baseUrl === null || model === null) {
    throw new Error(
      `${profile.displayName} ${formatCapability(capability)} configuration is incomplete.`,
    );
  }
  return {
    adapter,
    apiToken: capabilityConnection.apiToken ?? connection.apiToken,
    baseUrl: removeTrailingSlash(baseUrl),
    model,
    providerId,
    runtimeName: connection.name ?? profile.displayName,
  };
}

export function resolveTextToSpeechProvider(
  settings: ProviderSettings,
): ResolvedTextToSpeechProvider | null {
  const providerId = settings.routing.textToSpeech;
  if (providerId === null) {
    return null;
  }
  const profile = requireProviderProfile(providerId);
  const connection = settings.connections[providerId];
  const capabilityConnection = connection.textToSpeech;
  const adapter = readTextToSpeechAdapter(profile, connection);
  const baseUrl = capabilityConnection.baseUrl
    ?? connection.baseUrl;
  const featureOverrides = settings.featureOverrides.textToSpeech;
  const model = featureOverrides.modelOverride ?? capabilityConnection.model;
  const voice = featureOverrides.voiceOverride ?? capabilityConnection.voice;
  if (
    baseUrl === null
    || model === null
    || voice === null
  ) {
    throw new Error(
      `${profile.displayName} text-to-speech configuration is incomplete.`,
    );
  }
  return {
    adapter,
    apiToken: capabilityConnection.apiToken ?? connection.apiToken,
    baseUrl: removeTrailingSlash(baseUrl),
    model,
    providerId,
    runtimeName: connection.name ?? profile.displayName,
    voice,
  };
}

export function readTextToSpeechSpeedRange(
  adapter: TextToSpeechAdapter,
): TextToSpeechSpeedRange {
  if (adapter === "groq-speech") {
    return { displayName: "Groq", maximum: 5, minimum: 0.5 };
  }
  return {
    displayName: adapter === "omlx-speech" ? "oMLX" : "OpenAI-compatible",
    maximum: 4,
    minimum: 0.25,
  };
}

function readCapabilityConfiguration(
  connection: ProviderCapabilityConnection,
): ProviderCapabilityConfiguration {
  return {
    baseUrl: connection.baseUrl,
    model: connection.model,
  };
}

function readModelConfiguration(
  connection: ProviderModelConnection,
): ProviderModelConfiguration {
  return {
    ...readCapabilityConfiguration(connection),
    contextCapacityTokens: connection.contextCapacityTokens,
  };
}

function validateSelectedProvider(
  settings: ProviderSettings,
  capability: ProviderCapability,
  context: z.RefinementCtx,
): void {
  const providerId = settings.routing[capability];
  if (providerId === null) {
    return;
  }
  const profile = requireProviderProfile(providerId);
  if (!providerSupportsCapability(providerId, capability)) {
    context.addIssue({
      code: "custom",
      message: `${profile.displayName} does not support ${formatCapability(capability)}.`,
      path: ["routing", capability],
    });
    return;
  }
  const connection = settings.connections[providerId];
  const capabilityConnection = connection[capability];
  const baseUrl = capabilityConnection.baseUrl
    ?? connection.baseUrl;
  if (baseUrl === null) {
    context.addIssue({
      code: "custom",
      message: `${profile.displayName} requires a base URL for ${formatCapability(capability)}.`,
      path: ["connections", providerId, capability, "baseUrl"],
    });
  }
  const model = settings.featureOverrides[capability].modelOverride
    ?? capabilityConnection.model;
  if (model === null) {
    context.addIssue({
      code: "custom",
      message: `${profile.displayName} requires a model for ${formatCapability(capability)}.`,
      path: ["connections", providerId, capability, "model"],
    });
  }
  if (
    isModelCapability(capability)
    && (
      settings.featureOverrides[capability].contextCapacityTokensOverride
      ?? connection[capability].contextCapacityTokens
    ) === null
  ) {
    context.addIssue({
      code: "custom",
      message: `${profile.displayName} requires a context capacity for ${formatCapability(capability)}.`,
      path: ["connections", providerId, capability, "contextCapacityTokens"],
    });
  }
  if (
    capability === "textToSpeech"
    && (
      settings.featureOverrides.textToSpeech.voiceOverride
      ?? connection.textToSpeech.voice
    ) === null
  ) {
    context.addIssue({
      code: "custom",
      message: `${profile.displayName} requires a voice for text-to-speech.`,
      path: ["connections", providerId, "textToSpeech", "voice"],
    });
  }
}

function requireProviderProfile(providerId: ProviderId): ProviderProfile {
  const profile = profileById.get(providerId);
  if (profile === undefined) {
    throw new Error(`Unknown provider profile: ${providerId}.`);
  }
  return profile;
}

function readAdapter(
  profile: ProviderProfile,
  connection: ProviderConnection,
  capability: ProviderCapability,
):
  | EmbeddingModelAdapter
  | LanguageModelAdapter
  | RerankerAdapter
  | SpeechToTextAdapter
  | TextToSpeechAdapter {
  if (profile.id === "custom") {
    return connection.customAdapters[capability];
  }
  const capabilityProfile = profile.capabilities.find((candidate) => {
    return candidate.capability === capability;
  });
  if (capabilityProfile === undefined) {
    throw new Error(
      `${profile.displayName} does not support ${formatCapability(capability)}.`,
    );
  }
  return capabilityProfile.adapter;
}

function readTextToSpeechAdapter(
  profile: ProviderProfile,
  connection: ProviderConnection,
): TextToSpeechAdapter {
  if (profile.id === "custom") {
    return connection.customAdapters.textToSpeech;
  }
  const capabilityProfile = profile.capabilities.find((candidate) => {
    return candidate.capability === "textToSpeech";
  });
  if (
    capabilityProfile === undefined
    || !isTextToSpeechAdapter(capabilityProfile.adapter)
  ) {
    throw new Error(`${profile.displayName} does not support text-to-speech.`);
  }
  return capabilityProfile.adapter;
}

function isTextToSpeechAdapter(
  value:
    | EmbeddingModelAdapter
    | LanguageModelAdapter
    | RerankerAdapter
    | SpeechToTextAdapter
    | TextToSpeechAdapter,
): value is TextToSpeechAdapter {
  return value === "groq-speech"
    || value === "omlx-speech"
    || value === "openai-speech";
}

function isLanguageModelAdapter(
  value:
    | EmbeddingModelAdapter
    | LanguageModelAdapter
    | RerankerAdapter
    | SpeechToTextAdapter
    | TextToSpeechAdapter,
): value is LanguageModelAdapter {
  return value === "cohere-language"
    || value === "deepseek-language"
    || value === "ollama-language"
    || value === "openai-codex-language"
    || value === "openai-compatible-language";
}

function isEmbeddingModelAdapter(
  value:
    | EmbeddingModelAdapter
    | LanguageModelAdapter
    | RerankerAdapter
    | SpeechToTextAdapter
    | TextToSpeechAdapter,
): value is EmbeddingModelAdapter {
  return value === "cohere-embedding"
    || value === "ollama-embedding"
    || value === "openai-compatible-embedding";
}

function isRerankerAdapter(
  value:
    | EmbeddingModelAdapter
    | LanguageModelAdapter
    | RerankerAdapter
    | SpeechToTextAdapter
    | TextToSpeechAdapter,
): value is RerankerAdapter {
  return value === "top-n-rerank";
}

function isSpeechToTextAdapter(
  value:
    | EmbeddingModelAdapter
    | LanguageModelAdapter
    | RerankerAdapter
    | SpeechToTextAdapter
    | TextToSpeechAdapter,
): value is SpeechToTextAdapter {
  return value === "omlx-transcription"
    || value === "openai-transcription";
}

function formatCapability(capability: ProviderCapability): string {
  if (capability === "answer") {
    return "answer generation";
  }
  if (capability === "summarization") {
    return "summarization";
  }
  if (capability === "queryExpansion") {
    return "query expansion";
  }
  if (capability === "speechToText") {
    return "speech-to-text";
  }
  if (capability === "textToSpeech") {
    return "text-to-speech";
  }
  return capability;
}

function isModelCapability(
  capability: ProviderCapability,
): capability is "answer" | "embedding" | "queryExpansion" | "summarization" {
  return capability === "answer"
    || capability === "embedding"
    || capability === "queryExpansion"
    || capability === "summarization";
}

function readEffectiveModelContextCapacity(
  settings: ProviderSettings,
  providerId: ProviderId,
  capability: "answer" | "embedding" | "queryExpansion" | "summarization",
): number {
  const contextCapacityTokens =
    settings.featureOverrides[capability].contextCapacityTokensOverride
    ?? settings.connections[providerId][capability].contextCapacityTokens;
  if (contextCapacityTokens === null) {
    throw new Error(
      `${formatCapability(capability)} requires a context capacity.`,
    );
  }
  return contextCapacityTokens;
}

function removeTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
