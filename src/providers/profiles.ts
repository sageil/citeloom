import { z } from "zod";

import type {
  EmbeddingModelAdapter,
  LanguageModelAdapter,
  LanguageThinkingMode,
  RerankerAdapter,
  SpeechToTextAdapter,
  TextToSpeechAdapter,
} from "../config/types.js";

export const PROVIDER_CAPABILITIES = [
  "answer",
  "chat",
  "queryExpansion",
  "indexing",
  "embedding",
  "reranking",
  "speechToText",
  "textToSpeech",
] as const;

export type ProviderId = string;
export type ProviderCapability = typeof PROVIDER_CAPABILITIES[number];
export type CustomLanguageModelAdapter = Exclude<
  LanguageModelAdapter,
  "openai-codex-language"
>;

export type ProviderCapabilityProfile =
  | { adapter: LanguageModelAdapter; capability: "answer" }
  | { adapter: LanguageModelAdapter; capability: "chat" }
  | { adapter: LanguageModelAdapter; capability: "queryExpansion" }
  | { adapter: LanguageModelAdapter; capability: "indexing" }
  | { adapter: EmbeddingModelAdapter; capability: "embedding" }
  | { adapter: RerankerAdapter; capability: "reranking" }
  | { adapter: SpeechToTextAdapter; capability: "speechToText" }
  | { adapter: TextToSpeechAdapter; capability: "textToSpeech" };

export interface ProviderProfile {
  adapterConfiguration: "catalog" | "connection";
  authentication: ProviderAuthenticationMethod;
  capabilities: readonly ProviderCapabilityProfile[];
  displayName: string;
  doclingVlm: {
    endpointStyle: "ollama" | "openai";
    engineType: "api" | "api_lmstudio" | "api_ollama" | "api_openai";
  } | null;
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
  chat?: CustomLanguageModelAdapter | undefined;
  embedding: EmbeddingModelAdapter;
  queryExpansion: CustomLanguageModelAdapter;
  reranking: RerankerAdapter;
  speechToText: SpeechToTextAdapter;
  indexing: CustomLanguageModelAdapter;
  textToSpeech: TextToSpeechAdapter;
}

export interface ProviderConnection {
  adaptiveContextEnabled: boolean;
  apiToken: string | null;
  baseUrl: string | null;
  customAdapters: CustomProviderAdapters;
  maximumParallelRequests: number;
  name: string | null;
  thinkingMode: LanguageThinkingMode;
  answer: ProviderModelConnection;
  chat?: ProviderModelConnection | undefined;
  embedding: ProviderModelConnection;
  queryExpansion: ProviderModelConnection;
  reranking: ProviderCapabilityConnection;
  speechToText: ProviderCapabilityConnection;
  indexing: ProviderModelConnection;
  textToSpeech: ProviderTextToSpeechConnection;
}

export interface ProviderRouting {
  answer: ProviderId | null;
  chat?: ProviderId | null | undefined;
  embedding: ProviderId | null;
  queryExpansion: ProviderId | null;
  reranking: ProviderId | null;
  speechToText: ProviderId | null;
  indexing: ProviderId | null;
  textToSpeech: ProviderId | null;
}

export interface ProviderCapabilityFeatureOverrides {
  modelOverride: string | null;
}

export interface ProviderModelFeatureOverrides
  extends ProviderCapabilityFeatureOverrides {
  contextCapacityTokensOverride: number | null;
}

export interface ProviderLanguageFeatureOverrides
  extends ProviderModelFeatureOverrides {
  thinkingModeOverride: LanguageThinkingMode | null;
}

export interface ProviderTextToSpeechFeatureOverrides
  extends ProviderCapabilityFeatureOverrides {
  voiceOverride: string | null;
}

export interface ProviderFeatureOverrides {
  answer: ProviderLanguageFeatureOverrides;
  chat?: ProviderLanguageFeatureOverrides | undefined;
  embedding: ProviderModelFeatureOverrides;
  queryExpansion: ProviderLanguageFeatureOverrides;
  reranking: ProviderCapabilityFeatureOverrides;
  speechToText: ProviderCapabilityFeatureOverrides;
  indexing: ProviderLanguageFeatureOverrides;
  textToSpeech: ProviderTextToSpeechFeatureOverrides;
}

export interface ProviderSettings {
  catalog: readonly ProviderProfile[];
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
  adaptiveContextEnabled: boolean;
  baseUrl: string | null;
  customAdapters: CustomProviderAdapters;
  maximumParallelRequests: number;
  name: string | null;
  thinkingMode: LanguageThinkingMode;
  answer: ProviderModelConfiguration;
  chat?: ProviderModelConfiguration | undefined;
  embedding: ProviderModelConfiguration;
  queryExpansion: ProviderModelConfiguration;
  reranking: ProviderCapabilityConfiguration;
  speechToText: ProviderCapabilityConfiguration;
  indexing: ProviderModelConfiguration;
  textToSpeech: ProviderTextToSpeechConfiguration;
}

export type ProviderCredentialTarget = "shared" | ProviderCapability;

export type ProviderFeatureConfiguration =
  | {
    capability:
      | "answer"
      | "chat"
      | "queryExpansion"
      | "indexing";
    contextCapacityTokensOverride: number | null;
    modelOverride: string | null;
    providerId: ProviderId | null;
    thinkingModeOverride: LanguageThinkingMode | null;
  }
  | {
    capability: "embedding";
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
  | { action: "reset-feature"; capability: ProviderCapability }
  | { action: "reset-provider"; providerId: ProviderId }
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
  adaptiveContextEnabled: boolean;
  adapter: LanguageModelAdapter;
  contextCapacityTokens: number;
  thinkingMode: LanguageThinkingMode;
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
export const providerIdSchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u,
    "must start with an alphanumeric character and contain only letters, numbers, dots, underscores, colons, or hyphens",
  );
export const providerCapabilitySchema = z.enum(PROVIDER_CAPABILITIES);
export const languageThinkingModeSchema = z.enum([
  "auto",
  "disabled",
  "enabled",
]);
export const languageModelAdapterSchema = z.enum([
  "cohere-language",
  "deepseek-language",
  "ollama-language",
  "openai-codex-language",
  "openai-compatible-language",
  "openrouter-language",
]);
const customLanguageModelAdapterSchema = z.enum([
  "cohere-language",
  "deepseek-language",
  "ollama-language",
  "openai-compatible-language",
  "openrouter-language",
]);
export const embeddingModelAdapterSchema = z.enum([
  "cohere-embedding",
  "ollama-embedding",
  "openai-compatible-embedding",
]);
export const rerankerAdapterSchema = z.enum([
  "cohere-rerank",
  "top-n-rerank",
]);
export const speechToTextAdapterSchema = z.enum([
  "mistral-transcription",
  "omlx-transcription",
  "openrouter-transcription",
  "openai-transcription",
]);
export const textToSpeechAdapterSchema = z.enum([
  "groq-speech",
  "mistral-speech",
  "omlx-speech",
  "openrouter-speech",
  "openai-speech",
]);
const providerCapabilityProfileSchema = z.discriminatedUnion("capability", [
  z.object({
    adapter: languageModelAdapterSchema,
    capability: z.literal("answer"),
  }).strict(),
  z.object({
    adapter: languageModelAdapterSchema,
    capability: z.literal("chat"),
  }).strict(),
  z.object({
    adapter: embeddingModelAdapterSchema,
    capability: z.literal("embedding"),
  }).strict(),
  z.object({
    adapter: languageModelAdapterSchema,
    capability: z.literal("queryExpansion"),
  }).strict(),
  z.object({
    adapter: rerankerAdapterSchema,
    capability: z.literal("reranking"),
  }).strict(),
  z.object({
    adapter: speechToTextAdapterSchema,
    capability: z.literal("speechToText"),
  }).strict(),
  z.object({
    adapter: languageModelAdapterSchema,
    capability: z.literal("indexing"),
  }).strict(),
  z.object({
    adapter: textToSpeechAdapterSchema,
    capability: z.literal("textToSpeech"),
  }).strict(),
]);
const providerProfileSchema = z.object({
  adapterConfiguration: z.enum(["catalog", "connection"]),
  authentication: z.enum(["api-token", "openai-device"]),
  capabilities: z.array(providerCapabilityProfileSchema).min(1),
  displayName: z.string().trim().min(1).max(100),
  doclingVlm: z.object({
    endpointStyle: z.enum(["ollama", "openai"]),
    engineType: z.enum([
      "api",
      "api_lmstudio",
      "api_ollama",
      "api_openai",
    ]),
  }).strict().nullable(),
  id: providerIdSchema,
}).strict();
const providerCapabilityConnectionSchema = z.object({
  apiToken: providerCredentialSchema,
  baseUrl: httpUrlSchema.nullable(),
  model: providerConfigurationTextSchema,
}).strict();
const providerModelConnectionSchema = providerCapabilityConnectionSchema.extend({
  contextCapacityTokens: z.number().int().positive().nullable(),
}).strict();
const providerConnectionSchema = z.object({
  adaptiveContextEnabled: z.boolean().default(false),
  apiToken: providerCredentialSchema,
  baseUrl: httpUrlSchema.nullable(),
  customAdapters: z.object({
    answer: customLanguageModelAdapterSchema,
    chat: customLanguageModelAdapterSchema.optional(),
    embedding: embeddingModelAdapterSchema,
    queryExpansion: customLanguageModelAdapterSchema,
    reranking: rerankerAdapterSchema,
    speechToText: speechToTextAdapterSchema,
    indexing: customLanguageModelAdapterSchema,
    textToSpeech: textToSpeechAdapterSchema,
  }).strict(),
  maximumParallelRequests: z.number().int().min(1).max(16),
  name: z.string().trim().min(1).max(100).nullable(),
  thinkingMode: languageThinkingModeSchema,
  answer: providerModelConnectionSchema,
  chat: providerModelConnectionSchema.optional(),
  embedding: providerModelConnectionSchema,
  queryExpansion: providerModelConnectionSchema,
  reranking: providerCapabilityConnectionSchema,
  speechToText: providerCapabilityConnectionSchema,
  indexing: providerModelConnectionSchema,
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
const providerLanguageFeatureOverridesSchema =
  providerModelFeatureOverridesSchema.extend({
    thinkingModeOverride: languageThinkingModeSchema.nullable(),
  }).strict();
export const providerFeatureOverridesSchema = z.object({
  answer: providerLanguageFeatureOverridesSchema,
  chat: providerLanguageFeatureOverridesSchema.optional(),
  embedding: providerModelFeatureOverridesSchema,
  queryExpansion: providerLanguageFeatureOverridesSchema,
  reranking: providerCapabilityFeatureOverridesSchema,
  speechToText: providerCapabilityFeatureOverridesSchema,
  indexing: providerLanguageFeatureOverridesSchema,
  textToSpeech: providerCapabilityFeatureOverridesSchema.extend({
    voiceOverride: providerConfigurationTextSchema,
  }).strict(),
}).strict();

const providerConnectionConfigurationInputSchema = z.object({
  adaptiveContextEnabled: z.boolean().default(false),
  baseUrl: httpUrlSchema.nullable(),
  customAdapters: z.object({
    answer: customLanguageModelAdapterSchema,
    chat: customLanguageModelAdapterSchema.optional(),
    embedding: embeddingModelAdapterSchema,
    queryExpansion: customLanguageModelAdapterSchema,
    reranking: rerankerAdapterSchema,
    speechToText: speechToTextAdapterSchema,
    indexing: customLanguageModelAdapterSchema,
    textToSpeech: textToSpeechAdapterSchema,
  }).strict(),
  maximumParallelRequests: z.number().int().min(1).max(16),
  name: z.string().trim().min(1).max(100).nullable(),
  thinkingMode: languageThinkingModeSchema,
  answer: z.object({
    baseUrl: httpUrlSchema.nullable(),
    contextCapacityTokens: z.number().int().positive().nullable(),
    model: providerConfigurationTextSchema,
  }).strict(),
  chat: z.object({
    baseUrl: httpUrlSchema.nullable(),
    contextCapacityTokens: z.number().int().positive().nullable(),
    model: providerConfigurationTextSchema,
  }).strict().optional(),
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
  indexing: z.object({
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

export const providerConnectionConfigurationSchema =
  providerConnectionConfigurationInputSchema.transform(
    materializeProviderConnectionConfiguration,
  );

const providerSettingsInputSchema = z.object({
  catalog: z.array(providerProfileSchema).min(1),
  connections: z.record(providerIdSchema, providerConnectionSchema),
  featureOverrides: providerFeatureOverridesSchema,
  routing: z.object({
    answer: providerIdSchema.nullable(),
    chat: providerIdSchema.nullable().optional(),
    embedding: providerIdSchema.nullable(),
    queryExpansion: providerIdSchema.nullable(),
    reranking: providerIdSchema.nullable(),
    speechToText: providerIdSchema.nullable(),
    indexing: providerIdSchema.nullable(),
    textToSpeech: providerIdSchema.nullable(),
  }).strict(),
}).strict();

function createProviderSettingsSchema() {
  return providerSettingsInputSchema
    .transform((settings) => {
      return materializeProviderSettings(settings);
    })
    .superRefine((settings, context) => {
      validateProviderCatalog(settings, context);
      validateProviderConnections(settings, context);
      validateAdaptiveContextConfiguration(settings, context);
      validateSelectedProvider(settings, "answer", context);
      validateSelectedProvider(settings, "chat", context);
      validateSelectedProvider(settings, "queryExpansion", context);
      validateSelectedProvider(settings, "indexing", context);
      validateSelectedProvider(settings, "embedding", context);
      validateSelectedProvider(settings, "reranking", context);
      validateSelectedProvider(settings, "speechToText", context);
      validateSelectedProvider(settings, "textToSpeech", context);
    });
}

export const providerSettingsSchema = createProviderSettingsSchema();

export function parseProviderSettings(value: unknown): ProviderSettings {
  const result = createProviderSettingsSchema().safeParse(value);
  if (!result.success) {
    const details = result.error.issues.map((issue) => {
      const path = issue.path.length === 0
        ? "providers"
        : `providers.${issue.path.join(".")}`;
      return `- ${path}: ${issue.message}`;
    }).join("\n");
    throw new Error(`Invalid provider settings:\n${details}`);
  }
  return result.data;
}

export function readProviderConnectionConfiguration(
  connection: ProviderConnection,
): ProviderConnectionConfiguration {
  const chat = readChatConnection(connection);
  return {
    adaptiveContextEnabled: connection.adaptiveContextEnabled,
    answer: readModelConfiguration(connection.answer),
    baseUrl: connection.baseUrl,
    chat: readModelConfiguration(chat),
    customAdapters: {
      ...connection.customAdapters,
      chat: readChatAdapter(connection),
    },
    embedding: readModelConfiguration(connection.embedding),
    queryExpansion: readModelConfiguration(connection.queryExpansion),
    maximumParallelRequests: connection.maximumParallelRequests,
    name: connection.name,
    thinkingMode: connection.thinkingMode,
    reranking: readCapabilityConfiguration(connection.reranking),
    speechToText: readCapabilityConfiguration(connection.speechToText),
    indexing: readModelConfiguration(connection.indexing),
    textToSpeech: {
      ...readCapabilityConfiguration(connection.textToSpeech),
      voice: connection.textToSpeech.voice,
    },
  };
}

export function providerSupportsCapability(
  settings: ProviderSettings,
  providerId: ProviderId,
  capability: ProviderCapability,
): boolean {
  const profile = requireProviderProfile(settings, providerId);
  return profile.capabilities.some((candidate) => {
    return candidate.capability === capability;
  });
}

export function readProviderAuthenticationMethod(
  settings: ProviderSettings,
  providerId: ProviderId,
): ProviderAuthenticationMethod {
  return requireProviderProfile(settings, providerId).authentication;
}

export function readProviderProfile(
  settings: ProviderSettings,
  providerId: ProviderId,
): ProviderProfile | undefined {
  return settings.catalog.find((profile) => profile.id === providerId);
}

export function requireProviderConnection(
  settings: ProviderSettings,
  providerId: ProviderId,
): ProviderConnection {
  const connection = settings.connections[providerId];
  if (connection === undefined) {
    throw new Error(`Provider ${providerId} has no configured connection.`);
  }
  return connection;
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
    throw new Error("The selected provider is not compatible with Search ranking.");
  }
  if (
    capability === "speechToText"
    && !isSpeechToTextAdapter(provider.adapter)
  ) {
    throw new Error("The selected provider is not compatible with Speech input.");
  }
  return provider;
}

export function resolveLanguageProvider(
  settings: ProviderSettings,
  capability: "answer" | "chat" | "queryExpansion" | "indexing",
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
    adaptiveContextEnabled:
      requireProviderConnection(settings, provider.providerId)
        .adaptiveContextEnabled,
    adapter: provider.adapter,
    contextCapacityTokens: readEffectiveModelContextCapacity(
      settings,
      provider.providerId,
      capability,
    ),
    thinkingMode: readEffectiveThinkingMode(
      settings,
      provider.providerId,
      capability,
    ),
  };
}

function validateProviderCatalog(
  settings: ProviderSettings,
  context: z.RefinementCtx,
): void {
  const providerIds = new Set<string>();
  for (let profileIndex = 0; profileIndex < settings.catalog.length; profileIndex += 1) {
    const profile = settings.catalog[profileIndex];
    if (profile === undefined) {
      continue;
    }
    if (providerIds.has(profile.id)) {
      context.addIssue({
        code: "custom",
        message: `Provider ${profile.id} appears more than once in the catalog.`,
        path: ["catalog", profileIndex, "id"],
      });
    }
    providerIds.add(profile.id);
    const capabilities = new Set<ProviderCapability>();
    for (
      let capabilityIndex = 0;
      capabilityIndex < profile.capabilities.length;
      capabilityIndex += 1
    ) {
      const entry = profile.capabilities[capabilityIndex];
      if (entry === undefined) {
        continue;
      }
      if (capabilities.has(entry.capability)) {
        context.addIssue({
          code: "custom",
          message: `${profile.displayName} declares ${formatCapability(entry.capability)} more than once.`,
          path: ["catalog", profileIndex, "capabilities", capabilityIndex],
        });
      }
      capabilities.add(entry.capability);
    }
  }
}

function validateProviderConnections(
  settings: ProviderSettings,
  context: z.RefinementCtx,
): void {
  for (const providerId of Object.keys(settings.connections)) {
    if (readProviderProfile(settings, providerId) !== undefined) {
      continue;
    }
    context.addIssue({
      code: "custom",
      message: `Provider connection ${providerId} has no catalog profile.`,
      path: ["connections", providerId],
    });
  }
}

function validateAdaptiveContextConfiguration(
  settings: ProviderSettings,
  context: z.RefinementCtx,
): void {
  for (const [providerId, connection] of Object.entries(settings.connections)) {
    if (!connection.adaptiveContextEnabled) {
      continue;
    }
    const profile = readProviderProfile(settings, providerId);
    const supportsAdaptiveContext = profile !== undefined
      && providerSupportsAdaptiveContext(profile);
    if (!supportsAdaptiveContext) {
      context.addIssue({
        code: "custom",
        message: "Automatic context size is available only for the Ollama provider.",
        path: ["connections", providerId, "adaptiveContextEnabled"],
      });
    }
    if (connection.maximumParallelRequests !== 1) {
      context.addIssue({
        code: "custom",
        message: "Automatic context size requires maximum parallel requests to be 1.",
        path: ["connections", providerId, "maximumParallelRequests"],
      });
    }
  }
}

export function providerSupportsAdaptiveContext(
  profile: ProviderProfile,
): boolean {
  return profile.capabilities.some((candidate) => {
    return candidate.adapter === "ollama-language";
  });
}

export function resolveEmbeddingProvider(
  settings: ProviderSettings,
): ResolvedEmbeddingProvider {
  const provider = resolveConfiguredProvider(settings, "embedding");
  if (provider === null) {
    throw new Error("Embedding model requires a provider.");
  }
  if (!isEmbeddingModelAdapter(provider.adapter)) {
    throw new Error("The selected provider is not compatible with Embedding model.");
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
  const providerId = readProviderRoute(settings, capability);
  if (providerId === null) {
    return null;
  }
  const profile = requireProviderProfile(settings, providerId);
  const connection = requireProviderConnection(settings, providerId);
  const capabilityConnection = readCapabilityConnection(
    connection,
    capability,
  );
  const adapter = readAdapter(profile, connection, capability);
  const baseUrl = capabilityConnection.baseUrl
    ?? connection.baseUrl;
  const model = readFeatureOverrides(settings, capability).modelOverride
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
  const profile = requireProviderProfile(settings, providerId);
  const connection = requireProviderConnection(settings, providerId);
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
  if (adapter === "mistral-speech") {
    return { displayName: "Mistral", maximum: 1, minimum: 1 };
  }
  if (adapter === "openrouter-speech") {
    return { displayName: "OpenRouter", maximum: 4, minimum: 0.25 };
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
  const providerId = readProviderRoute(settings, capability);
  if (providerId === null) {
    return;
  }
  const profile = readProviderProfile(settings, providerId);
  if (profile === undefined) {
    context.addIssue({
      code: "custom",
      message: `The selected provider ${providerId} is not in the configured catalog.`,
      path: ["routing", capability],
    });
    return;
  }
  if (!providerSupportsCapability(settings, providerId, capability)) {
    context.addIssue({
      code: "custom",
      message: `${profile.displayName} does not support ${formatCapability(capability)}.`,
      path: ["routing", capability],
    });
    return;
  }
  const connection = settings.connections[providerId];
  if (connection === undefined) {
    context.addIssue({
      code: "custom",
      message: `${profile.displayName} has no configured connection.`,
      path: ["connections", providerId],
    });
    return;
  }
  const capabilityConnection = readCapabilityConnection(
    connection,
    capability,
  );
  const baseUrl = capabilityConnection.baseUrl
    ?? connection.baseUrl;
  if (baseUrl === null) {
    context.addIssue({
      code: "custom",
      message: `${profile.displayName} requires a base URL for ${formatCapability(capability)}.`,
      path: ["connections", providerId, capability, "baseUrl"],
    });
  }
  const model = readFeatureOverrides(settings, capability).modelOverride
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
      readModelFeatureOverrides(settings, capability)
        .contextCapacityTokensOverride
      ?? readModelConnection(connection, capability).contextCapacityTokens
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

function requireProviderProfile(
  settings: ProviderSettings,
  providerId: ProviderId,
): ProviderProfile {
  const profile = readProviderProfile(settings, providerId);
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
  if (profile.adapterConfiguration === "connection") {
    if (capability === "chat") {
      return readChatAdapter(connection);
    }
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
  if (profile.adapterConfiguration === "connection") {
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
    || value === "mistral-speech"
    || value === "omlx-speech"
    || value === "openrouter-speech"
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
    || value === "openai-compatible-language"
    || value === "openrouter-language";
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
  return value === "cohere-rerank"
    || value === "top-n-rerank";
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
    || value === "mistral-transcription"
    || value === "openrouter-transcription"
    || value === "openai-transcription";
}

function formatCapability(capability: ProviderCapability): string {
  if (capability === "answer") {
    return "Ask";
  }
  if (capability === "indexing") {
    return "Indexing model";
  }
  if (capability === "chat") {
    return "chat";
  }
  if (capability === "queryExpansion") {
    return "Query Expansion";
  }
  if (capability === "speechToText") {
    return "Speech input";
  }
  if (capability === "textToSpeech") {
    return "Spoken answers";
  }
  if (capability === "embedding") {
    return "Embedding model";
  }
  if (capability === "reranking") {
    return "Search ranking";
  }
  return capability;
}

function isModelCapability(
  capability: ProviderCapability,
): capability is
  | "answer"
  | "chat"
  | "embedding"
  | "queryExpansion"
  | "indexing" {
  return capability === "answer"
    || capability === "chat"
    || capability === "embedding"
    || capability === "queryExpansion"
    || capability === "indexing";
}

function readEffectiveModelContextCapacity(
  settings: ProviderSettings,
  providerId: ProviderId,
  capability:
    | "answer"
    | "chat"
    | "embedding"
    | "queryExpansion"
    | "indexing",
): number {
  const contextCapacityTokens =
    readModelFeatureOverrides(settings, capability)
      .contextCapacityTokensOverride
    ?? readModelConnection(
      requireProviderConnection(settings, providerId),
      capability,
    )
      .contextCapacityTokens;
  if (contextCapacityTokens === null) {
    throw new Error(
      `${formatCapability(capability)} requires a context capacity.`,
    );
  }
  return contextCapacityTokens;
}

function materializeProviderSettings(
  settings: z.output<typeof providerSettingsInputSchema>,
): ProviderSettings {
  const entries: Array<[ProviderId, ProviderConnection]> = [];
  for (const [providerId, connection] of Object.entries(settings.connections)) {
    entries.push([
      providerId,
      {
        ...connection,
        chat: {
          ...(connection.chat ?? connection.answer),
        },
        customAdapters: {
          ...connection.customAdapters,
          chat: connection.customAdapters.chat
            ?? connection.customAdapters.answer,
        },
        thinkingMode: connection.thinkingMode,
      },
    ]);
  }
  const connections = Object.fromEntries(entries) as Record<
    ProviderId,
    ProviderConnection
  >;
  return {
    catalog: settings.catalog,
    connections,
    featureOverrides: {
      ...settings.featureOverrides,
      chat: {
        ...(settings.featureOverrides.chat
          ?? settings.featureOverrides.answer),
      },
    },
    routing: {
      ...settings.routing,
      chat: settings.routing.chat ?? settings.routing.answer,
    },
  };
}

function materializeProviderConnectionConfiguration(
  configuration: z.output<typeof providerConnectionConfigurationInputSchema>,
): ProviderConnectionConfiguration {
  return {
    ...configuration,
    chat: {
      ...(configuration.chat ?? configuration.answer),
    },
    customAdapters: {
      ...configuration.customAdapters,
      chat: configuration.customAdapters.chat
        ?? configuration.customAdapters.answer,
    },
  };
}

function readEffectiveThinkingMode(
  settings: ProviderSettings,
  providerId: ProviderId,
  capability: "answer" | "chat" | "queryExpansion" | "indexing",
): LanguageThinkingMode {
  const override = readLanguageFeatureOverrides(settings, capability)
    .thinkingModeOverride;
  return override
    ?? requireProviderConnection(settings, providerId).thinkingMode;
}

function readProviderRoute(
  settings: ProviderSettings,
  capability: ProviderCapability,
): ProviderId | null {
  if (capability === "chat") {
    return settings.routing.chat ?? settings.routing.answer;
  }
  return settings.routing[capability];
}

function readChatConnection(
  connection: ProviderConnection,
): ProviderModelConnection {
  return connection.chat ?? connection.answer;
}

function readChatAdapter(
  connection: ProviderConnection,
): CustomLanguageModelAdapter {
  return connection.customAdapters.chat ?? connection.customAdapters.answer;
}

function readCapabilityConnection(
  connection: ProviderConnection,
  capability: ProviderCapability,
): ProviderCapabilityConnection {
  if (capability === "chat") {
    return readChatConnection(connection);
  }
  return connection[capability];
}

function readModelConnection(
  connection: ProviderConnection,
  capability:
    | "answer"
    | "chat"
    | "embedding"
    | "queryExpansion"
    | "indexing",
): ProviderModelConnection {
  if (capability === "chat") {
    return readChatConnection(connection);
  }
  return connection[capability];
}

function readFeatureOverrides(
  settings: ProviderSettings,
  capability: ProviderCapability,
): ProviderCapabilityFeatureOverrides {
  if (capability === "chat") {
    return settings.featureOverrides.chat
      ?? settings.featureOverrides.answer;
  }
  return settings.featureOverrides[capability];
}

function readModelFeatureOverrides(
  settings: ProviderSettings,
  capability:
    | "answer"
    | "chat"
    | "embedding"
    | "queryExpansion"
    | "indexing",
): ProviderModelFeatureOverrides {
  if (capability === "chat") {
    return settings.featureOverrides.chat
      ?? settings.featureOverrides.answer;
  }
  return settings.featureOverrides[capability];
}

function readLanguageFeatureOverrides(
  settings: ProviderSettings,
  capability: "answer" | "chat" | "queryExpansion" | "indexing",
): ProviderLanguageFeatureOverrides {
  if (capability === "chat") {
    return settings.featureOverrides.chat
      ?? settings.featureOverrides.answer;
  }
  return settings.featureOverrides[capability];
}

function removeTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
