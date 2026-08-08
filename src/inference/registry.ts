import {
  createCohere,
  type CohereEmbeddingModelOptions,
} from "@ai-sdk/cohere";
import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";
import { createOllama } from "ai-sdk-ollama";
import type {
  EmbeddingModelV4,
  EmbeddingModelV4CallOptions,
  LanguageModelV4,
  LanguageModelV4CallOptions,
} from "@ai-sdk/provider";
import {
  createProviderRegistry,
  customProvider,
  defaultSettingsMiddleware,
  type EmbeddingModelMiddleware,
  wrapEmbeddingModel,
  wrapLanguageModel,
} from "ai";

import { InferenceMetricsReporter } from "./metrics.js";
import type {
  AppConfig,
  EmbeddingInferenceConfig,
  LanguageInferenceConfig,
  ProviderRuntimeConfig,
} from "../config/index.js";
import {
  formatDocumentEmbeddingText,
  formatQueryEmbeddingText,
} from "../embedding/input-format.js";
import { readEmbeddingVector } from "../embedding/dimensions.js";
import { HttpHhemClient, type HhemClient } from "../verification/hhem-client.js";
import { createHttpRerankingModel, type ResolvedReranker } from "../retrieval/ranking/reranker.js";
import {
  readLanguageModelCapabilities,
  type LanguageModelCapabilities,
} from "./model-capabilities.js";
import {
  createOllamaLanguageModelRuntime,
  createOllamaModelMetadataCache,
  type OllamaAdaptiveWorkload,
  type OllamaLanguageModelRuntime,
  type OllamaModelMetadataCache,
} from "./ollama-context.js";
import type { AnswerBudgetConfiguration } from "../answers/context-budget.js";
import type { CiteLoomDatabase } from "../database/client.js";
import { createOpenAICodexLanguageModel } from "../providers/openai-codex-language-model.js";

const INFERENCE_PROVIDER_OPTIONS_KEY = "citeloomInference";

export interface InferenceModelRegistry {
  answer: LanguageModelV4;
  answerBudget: AnswerBudgetConfiguration;
  chat?: LanguageModelV4;
  chatBudget?: AnswerBudgetConfiguration;
  readAnswerCapabilities: (abortSignal: AbortSignal) => Promise<LanguageModelCapabilities>;
  readChatCapabilities?: (abortSignal: AbortSignal) => Promise<LanguageModelCapabilities>;
  claimVerifier: HhemClient;
  documentEmbedding: EmbeddingModelV4;
  metrics: InferenceMetricsReporter;
  queryExpansion: LanguageModelV4 | null;
  queryEmbedding: EmbeddingModelV4;
  reranker: ResolvedReranker | null;
  indexing: LanguageModelV4;
  timeouts: {
    answerMs: number;
    chatMs?: number;
    embeddingMs: number;
    indexingMs: number;
    queryExpansionMs: number | null;
  };
}

interface QueryExpansionRuntime {
  model: LanguageModelV4;
  timeoutMs: number;
}

function createQueryExpansionRuntime(
  config: LanguageInferenceConfig | null,
  database: CiteLoomDatabase | undefined,
  ollamaModelMetadataCache: OllamaModelMetadataCache,
): QueryExpansionRuntime | null {
  if (config === null) {
    return null;
  }
  const runtime = createLanguageModel(
    config,
    INFERENCE_PROVIDER_OPTIONS_KEY,
    true,
    database,
    "query-expansion",
    0,
    ollamaModelMetadataCache,
  );
  const thinkingProviderOptions = buildLanguageThinkingProviderOptions(
    config,
    config.thinkingMode,
  );
  const reasoning = buildLanguageReasoning(config, config.thinkingMode);
  const model = wrapLanguageModel({
    middleware: defaultSettingsMiddleware({
      settings: buildLanguageModelSettings(
        0.1,
        thinkingProviderOptions,
        reasoning,
      ),
    }),
    model: runtime.model,
    modelId: `${config.model}:query-expansion`,
  });
  return { model, timeoutMs: config.timeoutMs };
}

export function createInferenceModelRegistry(
  config: AppConfig,
  database?: CiteLoomDatabase,
): InferenceModelRegistry {
  const metrics = new InferenceMetricsReporter(config.inferenceMetrics);
  const ollamaModelMetadataCache = createOllamaModelMetadataCache();
  const chatConfig = config.inference.chat;
  const answerRuntime = createLanguageModel(
    config.inference.answer,
    INFERENCE_PROVIDER_OPTIONS_KEY,
    true,
    database,
    "answer",
    config.inference.answerBudget.providerSafetyMarginTokens,
    ollamaModelMetadataCache,
  );
  const chatRuntime = createLanguageModel(
    chatConfig,
    INFERENCE_PROVIDER_OPTIONS_KEY,
    true,
    database,
    "chat",
    config.inference.answerBudget.providerSafetyMarginTokens,
    ollamaModelMetadataCache,
  );
  const indexingRuntime = createLanguageModel(
    config.inference.indexing,
    INFERENCE_PROVIDER_OPTIONS_KEY,
    true,
    database,
    "indexing",
    0,
    ollamaModelMetadataCache,
  );
  const baseLanguageModel = answerRuntime.model;
  const baseChatModel = chatRuntime.model;
  const baseIndexingModel = indexingRuntime.model;
  const answerThinkingProviderOptions = buildLanguageThinkingProviderOptions(
    config.inference.answer,
    config.inference.answer.thinkingMode,
  );
  const chatThinkingProviderOptions = buildLanguageThinkingProviderOptions(
    chatConfig,
    chatConfig.thinkingMode,
  );
  const indexingThinkingProviderOptions = buildLanguageThinkingProviderOptions(
    config.inference.indexing,
    config.inference.indexing.thinkingMode,
  );
  const answerReasoning = buildLanguageReasoning(
    config.inference.answer,
    config.inference.answer.thinkingMode,
  );
  const chatReasoning = buildLanguageReasoning(
    chatConfig,
    chatConfig.thinkingMode,
  );
  const indexingReasoning = buildLanguageReasoning(
    config.inference.indexing,
    config.inference.indexing.thinkingMode,
  );
  const answerModel = wrapLanguageModel({
    middleware: defaultSettingsMiddleware({
      settings: buildLanguageModelSettings(
        0.1,
        answerThinkingProviderOptions,
        answerReasoning,
      ),
    }),
    model: baseLanguageModel,
    modelId: `${config.inference.answer.model}:answer`,
  });
  const chatModel = wrapLanguageModel({
    middleware: defaultSettingsMiddleware({
      settings: buildLanguageModelSettings(
        0.1,
        chatThinkingProviderOptions,
        chatReasoning,
      ),
    }),
    model: baseChatModel,
    modelId: `${chatConfig.model}:chat`,
  });
  const indexingModel = wrapLanguageModel({
    middleware: defaultSettingsMiddleware({
      settings: buildLanguageModelSettings(
        0.1,
        indexingThinkingProviderOptions,
        indexingReasoning,
      ),
    }),
    model: baseIndexingModel,
    modelId: `${config.inference.indexing.model}:indexing`,
  });
  const queryExpansionRuntime = createQueryExpansionRuntime(
    config.inference.queryExpansion,
    database,
    ollamaModelMetadataCache,
  );
  const claimVerifier = new HttpHhemClient(config.claimVerifier);
  const baseEmbeddingModel = createEmbeddingModel(
    config.inference.embedding,
    INFERENCE_PROVIDER_OPTIONS_KEY,
  );
  const documentEmbeddingModel = wrapEmbeddingModel({
    middleware: createEmbeddingInputMiddleware(
      config.inference.embedding,
      "document",
      config.embeddingSpace.dimensions,
    ),
    model: baseEmbeddingModel,
    modelId: `${config.inference.embedding.model}:document`,
  });
  const queryEmbeddingModel = wrapEmbeddingModel({
    middleware: createEmbeddingInputMiddleware(
      config.inference.embedding,
      "query",
      config.embeddingSpace.dimensions,
    ),
    model: baseEmbeddingModel,
    modelId: `${config.inference.embedding.model}:query`,
  });

  const languageModels: Record<string, LanguageModelV4> = {
    answer: answerModel,
    chat: chatModel,
    indexing: indexingModel,
  };
  if (queryExpansionRuntime !== null) {
    languageModels.queryExpansion = queryExpansionRuntime.model;
  }
  const inferenceProvider = customProvider({
    embeddingModels: {
      document: documentEmbeddingModel,
      query: queryEmbeddingModel,
    },
    languageModels,
  });
  let retrievalProvider = customProvider({});
  if (config.retrieval.reranker !== null) {
    retrievalProvider = customProvider({
      rerankingModels: {
        retrieval: createHttpRerankingModel(config.retrieval.reranker),
      },
    });
  }
  const registry = createProviderRegistry({
    inference: inferenceProvider,
    retrieval: retrievalProvider,
  });

  let reranker: ResolvedReranker | null = null;
  if (config.retrieval.reranker !== null) {
    reranker = {
      metrics,
      model: registry.rerankingModel("retrieval:retrieval"),
      timeoutMs: config.retrieval.reranker.timeoutMs,
    };
  }
  return {
    answer: registry.languageModel("inference:answer"),
    answerBudget: {
      minimumOutputTokens: config.inference.answerBudget.minimumOutputTokens,
      providerSafetyMarginTokens:
        config.inference.answerBudget.providerSafetyMarginTokens,
    },
    chat: registry.languageModel("inference:chat"),
    chatBudget: {
      minimumOutputTokens: config.inference.answerBudget.minimumOutputTokens,
      providerSafetyMarginTokens:
        config.inference.answerBudget.providerSafetyMarginTokens,
    },
    claimVerifier,
    documentEmbedding: registry.embeddingModel("inference:document"),
    metrics,
    queryEmbedding: registry.embeddingModel("inference:query"),
    queryExpansion: queryExpansionRuntime === null
      ? null
      : registry.languageModel("inference:queryExpansion"),
    readAnswerCapabilities: answerRuntime.readCapabilities,
    readChatCapabilities: chatRuntime.readCapabilities,
    reranker,
    indexing: registry.languageModel("inference:indexing"),
    timeouts: {
      answerMs: config.inference.answer.timeoutMs,
      chatMs: chatConfig.timeoutMs,
      embeddingMs: config.inference.embedding.timeoutMs,
      indexingMs: config.inference.indexing.timeoutMs,
      queryExpansionMs: queryExpansionRuntime?.timeoutMs ?? null,
    },
  };
}

export function selectChatInferenceModels(
  models: InferenceModelRegistry,
): InferenceModelRegistry {
  const chat = models.chat ?? models.answer;
  const chatBudget = models.chatBudget ?? models.answerBudget;
  const readChatCapabilities = models.readChatCapabilities
    ?? models.readAnswerCapabilities;
  return {
    ...models,
    answer: chat,
    answerBudget: chatBudget,
    readAnswerCapabilities: readChatCapabilities,
    timeouts: {
      ...models.timeouts,
      answerMs: models.timeouts.chatMs ?? models.timeouts.answerMs,
    },
  };
}

export function formatDocumentEmbeddingInput(
  config: EmbeddingInferenceConfig,
  content: string,
): string {
  return formatDocumentEmbeddingText(config.inputFormat, content);
}

export function formatQueryEmbeddingInput(
  config: EmbeddingInferenceConfig,
  query: string,
): string {
  return formatQueryEmbeddingText(config.inputFormat, query);
}

export function formatEmbeddingInputs(
  config: EmbeddingInferenceConfig,
  purpose: "document" | "query",
  values: readonly string[],
): string[] {
  const formatted: string[] = [];
  for (const value of values) {
    const normalized = purpose === "document"
      ? formatDocumentEmbeddingInput(config, value)
      : formatQueryEmbeddingInput(config, value);
    formatted.push(normalized);
  }
  return formatted;
}

export function buildThinkingProviderOptions(
  thinkingMode: LanguageInferenceConfig["thinkingMode"],
): LanguageModelV4CallOptions["providerOptions"] {
  if (thinkingMode === "auto") {
    return undefined;
  }
  return buildProviderReasoningOptions(
    INFERENCE_PROVIDER_OPTIONS_KEY,
    thinkingMode === "enabled" ? "high" : "none",
  );
}

function buildLanguageThinkingProviderOptions(
  config: LanguageInferenceConfig,
  thinkingMode: LanguageInferenceConfig["thinkingMode"],
): LanguageModelV4CallOptions["providerOptions"] {
  if (config.adapter === "openai-codex-language") {
    return buildOpenAICodexProviderOptions(thinkingMode);
  }
  if (!isOpenAICompatibleLanguageAdapter(config.adapter)) {
    return undefined;
  }
  return buildThinkingProviderOptions(thinkingMode);
}

function buildLanguageReasoning(
  config: LanguageInferenceConfig,
  thinkingMode: LanguageInferenceConfig["thinkingMode"],
): LanguageModelV4CallOptions["reasoning"] | undefined {
  if (
    isOpenAICompatibleLanguageAdapter(config.adapter)
    || thinkingMode === "auto"
  ) {
    return undefined;
  }
  return thinkingMode === "enabled" ? "high" : "none";
}

function buildProviderReasoningOptions(
  providerName: string,
  reasoningEffort: "high" | "none",
): LanguageModelV4CallOptions["providerOptions"] {
  return {
    [providerName]: {
      reasoningEffort,
    },
  };
}

function buildOpenAICodexProviderOptions(
  thinkingMode: LanguageInferenceConfig["thinkingMode"],
): LanguageModelV4CallOptions["providerOptions"] {
  const openaiOptions: {
    forceReasoning: true;
    reasoningEffort?: "high" | "low";
    store: false;
  } = {
    forceReasoning: true,
    store: false,
  };
  if (thinkingMode !== "auto") {
    openaiOptions.reasoningEffort =
      thinkingMode === "enabled" ? "high" : "low";
  }
  return { openai: openaiOptions };
}

function isOpenAICompatibleLanguageAdapter(
  adapter: LanguageInferenceConfig["adapter"],
): boolean {
  return adapter === "deepseek-language"
    || adapter === "openai-compatible-language"
    || adapter === "openai-codex-language"
    || adapter === "openrouter-language";
}

function buildProviderSettings(
  config: ProviderRuntimeConfig,
  providerName: string,
  supportsStructuredOutputs: boolean,
): OpenAICompatibleProviderSettings {
  const settings: OpenAICompatibleProviderSettings = {
    baseURL: config.baseUrl,
    name: providerName,
    supportsStructuredOutputs,
  };
  if (config.apiToken !== null) {
    settings.apiKey = config.apiToken;
  }
  return settings;
}

function buildLanguageProviderSettings(
  config: LanguageInferenceConfig,
  providerName: string,
  supportsStructuredOutputs: boolean,
  workload: OllamaAdaptiveWorkload,
): OpenAICompatibleProviderSettings {
  const usesDeepSeekContract = config.adapter === "deepseek-language";
  const usesOpenRouterContract = config.adapter === "openrouter-language";
  const settings = buildProviderSettings(
    config,
    providerName,
    supportsStructuredOutputs,
  );
  if (usesDeepSeekContract) {
    settings.transformRequestBody = transformDeepSeekRequestBody;
  }
  if (usesOpenRouterContract) {
    settings.transformRequestBody = (requestBody) => {
      return transformOpenRouterRequestBody(requestBody, workload);
    };
  }
  return settings;
}

type OpenAICompatibleRequestBody = Parameters<
  NonNullable<OpenAICompatibleProviderSettings["transformRequestBody"]>
>[0];

function transformDeepSeekRequestBody(
  requestBody: OpenAICompatibleRequestBody,
): OpenAICompatibleRequestBody {
  const transformedBody = { ...requestBody };
  translateDeepSeekStructuredOutput(transformedBody);
  delete transformedBody.seed;
  if (transformedBody.reasoning_effort === "none") {
    delete transformedBody.reasoning_effort;
    transformedBody.thinking = { type: "disabled" };
  } else if (transformedBody.reasoning_effort === "high") {
    transformedBody.thinking = { type: "enabled" };
  }
  return transformedBody;
}

interface DeepSeekJsonSchema {
  [key: string]: unknown;
}

function translateDeepSeekStructuredOutput(
  requestBody: OpenAICompatibleRequestBody,
): void {
  const jsonSchema = readDeepSeekJsonSchema(requestBody.response_format);
  if (jsonSchema === null) {
    return;
  }
  if (!Array.isArray(requestBody.messages)) {
    throw new Error(
      "DeepSeek structured output requires an OpenAI-compatible messages array.",
    );
  }
  requestBody.response_format = { type: "json_object" };
  requestBody.messages = [
    {
      content: `Return only valid JSON that matches this JSON Schema:\n${
        JSON.stringify(jsonSchema)
      }`,
      role: "system",
    },
    ...requestBody.messages,
  ];
}

function readDeepSeekJsonSchema(value: unknown): DeepSeekJsonSchema | null {
  const responseFormat = readDeepSeekObject(value);
  if (responseFormat === null || responseFormat.type !== "json_schema") {
    return null;
  }
  const jsonSchema = readDeepSeekObject(responseFormat.json_schema);
  if (jsonSchema === null) {
    return null;
  }
  return readDeepSeekObject(jsonSchema.schema);
}

function readDeepSeekObject(value: unknown): DeepSeekJsonSchema | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as DeepSeekJsonSchema;
}

interface OpenRouterRequestObject {
  [key: string]: unknown;
}

function transformOpenRouterRequestBody(
  requestBody: OpenAICompatibleRequestBody,
  workload: OllamaAdaptiveWorkload,
): OpenAICompatibleRequestBody {
  const transformedBody = { ...requestBody };
  translateOpenRouterReasoning(transformedBody);
  if (transformedBody.response_format === undefined) {
    return transformedBody;
  }
  if (workload === "answer" || workload === "chat") {
    translateOpenRouterAnswerOutput(transformedBody);
    return transformedBody;
  }
  requireOpenRouterRequestParameters(transformedBody);
  return transformedBody;
}

function translateOpenRouterReasoning(
  requestBody: OpenAICompatibleRequestBody,
): void {
  const reasoningEffort = requestBody.reasoning_effort;
  if (reasoningEffort === undefined) {
    return;
  }
  if (typeof reasoningEffort !== "string" || reasoningEffort.trim() === "") {
    throw new Error(
      "OpenRouter reasoning_effort must be a non-empty string when provided.",
    );
  }
  const reasoning = readOpenRouterRequestObject(
    requestBody.reasoning,
    "reasoning",
  );
  reasoning.effort = reasoningEffort;
  requestBody.reasoning = reasoning;
  delete requestBody.reasoning_effort;
}

function translateOpenRouterAnswerOutput(
  requestBody: OpenAICompatibleRequestBody,
): void {
  const jsonSchema = readOpenRouterJsonSchema(requestBody.response_format);
  if (jsonSchema === null) {
    throw new Error(
      "OpenRouter Answer and Chat output requires a JSON Schema response format.",
    );
  }
  if (!Array.isArray(requestBody.messages)) {
    throw new Error(
      "OpenRouter Answer and Chat output requires an OpenAI-compatible messages array.",
    );
  }
  requestBody.messages = [
    {
      content: `Return only one valid JSON object that matches this JSON Schema. Do not use Markdown fences or add text outside the JSON object.\n${
        JSON.stringify(jsonSchema)
      }`,
      role: "system",
    },
    ...requestBody.messages,
  ];
  delete requestBody.response_format;
}

function requireOpenRouterRequestParameters(
  requestBody: OpenAICompatibleRequestBody,
): void {
  const provider = readOpenRouterRequestObject(
    requestBody.provider,
    "provider",
  );
  provider.require_parameters = true;
  requestBody.provider = provider;
}

function readOpenRouterJsonSchema(value: unknown): OpenRouterRequestObject | null {
  const responseFormat = readOpenRouterRequestObjectOrNull(value);
  if (responseFormat === null || responseFormat.type !== "json_schema") {
    return null;
  }
  const jsonSchema = readOpenRouterRequestObjectOrNull(
    responseFormat.json_schema,
  );
  if (jsonSchema === null) {
    return null;
  }
  return readOpenRouterRequestObjectOrNull(jsonSchema.schema);
}

function readOpenRouterRequestObject(
  value: unknown,
  field: string,
): OpenRouterRequestObject {
  if (value === undefined) {
    return {};
  }
  const object = readOpenRouterRequestObjectOrNull(value);
  if (object === null) {
    throw new Error(`OpenRouter request field ${field} must be an object.`);
  }
  return { ...object };
}

function readOpenRouterRequestObjectOrNull(
  value: unknown,
): OpenRouterRequestObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as OpenRouterRequestObject;
}

function createLanguageModel(
  config: LanguageInferenceConfig,
  providerName: string,
  supportsStructuredOutputs: boolean,
  database: CiteLoomDatabase | undefined,
  workload: OllamaAdaptiveWorkload,
  providerSafetyMarginTokens: number,
  ollamaModelMetadataCache: OllamaModelMetadataCache,
): OllamaLanguageModelRuntime {
  if (config.adapter === "openai-codex-language") {
    if (database === undefined) {
      throw new Error(
        "OpenAI Codex requires an application database for device credentials.",
      );
    }
    const model = createOpenAICodexLanguageModel(config, database);
    return createFixedLanguageModelRuntime(config, model);
  }
  if (config.adapter === "cohere-language") {
    const provider = createCohereProvider(config);
    return createFixedLanguageModelRuntime(config, provider(config.model));
  }
  if (config.adapter === "ollama-language") {
    const provider = createOllamaProvider(config);
    const createDynamicModel = (): LanguageModelV4 => {
      return provider(config.model, {
        reliableObjectGeneration: false,
        structuredOutputs: supportsStructuredOutputs,
      });
    };
    const createModel = (contextCapacityTokens: number): LanguageModelV4 => {
      return provider(config.model, {
        options: {
          num_ctx: contextCapacityTokens,
        },
        reliableObjectGeneration: false,
        structuredOutputs: supportsStructuredOutputs,
      });
    };
    return createOllamaLanguageModelRuntime(config, {
      createDynamicModel,
      createModel,
      metadataCache: ollamaModelMetadataCache,
      providerSafetyMarginTokens,
      workload,
    });
  }
  const provider = createOpenAICompatible(
    buildLanguageProviderSettings(
      config,
      providerName,
      supportsStructuredOutputs,
      workload,
    ),
  );
  return createFixedLanguageModelRuntime(config, provider(config.model));
}

function createFixedLanguageModelRuntime(
  config: LanguageInferenceConfig,
  model: LanguageModelV4,
): OllamaLanguageModelRuntime {
  return {
    model,
    readCapabilities: (abortSignal) => {
      return readLanguageModelCapabilities(config, abortSignal);
    },
  };
}

function createEmbeddingModel(
  config: EmbeddingInferenceConfig,
  providerName: string,
): EmbeddingModelV4 {
  if (config.adapter === "cohere-embedding") {
    const provider = createCohereProvider(config);
    return provider.embedding(config.model);
  }
  if (config.adapter === "ollama-embedding") {
    const provider = createOllamaProvider(config);
    return provider.embedding(config.model, {
      options: {
        num_ctx: config.maximumInputTokens,
      },
    });
  }
  const provider = createOpenAICompatible(
    buildProviderSettings(config, providerName, false),
  );
  return provider.embeddingModel(config.model);
}

function createCohereProvider(config: ProviderRuntimeConfig) {
  if (config.apiToken === null) {
    return createCohere({ baseURL: config.baseUrl });
  }
  return createCohere({
    apiKey: config.apiToken,
    baseURL: config.baseUrl,
  });
}

function createOllamaProvider(config: ProviderRuntimeConfig) {
  if (config.apiToken === null) {
    return createOllama({ baseURL: config.baseUrl });
  }
  return createOllama({
    apiKey: config.apiToken,
    baseURL: config.baseUrl,
  });
}

function buildLanguageModelSettings(
  temperature: number,
  providerOptions: LanguageModelV4CallOptions["providerOptions"],
  reasoning: LanguageModelV4CallOptions["reasoning"] | undefined,
): Partial<LanguageModelV4CallOptions> {
  const settings: Partial<LanguageModelV4CallOptions> = { temperature };
  if (providerOptions !== undefined) {
    settings.providerOptions = providerOptions;
  }
  if (reasoning !== undefined) {
    settings.reasoning = reasoning;
  }
  return settings;
}

function createEmbeddingInputMiddleware(
  config: EmbeddingInferenceConfig,
  purpose: "document" | "query",
  outputDimensions: AppConfig["embeddingSpace"]["dimensions"],
): EmbeddingModelMiddleware {
  return {
    specificationVersion: "v4",
    transformParams: async ({ params }): Promise<EmbeddingModelV4CallOptions> => {
      const values = formatEmbeddingInputs(config, purpose, params.values);
      if (config.adapter === "cohere-embedding") {
        const inputType = purpose === "document"
          ? "search_document"
          : "search_query";
        const cohereOptions: CohereEmbeddingModelOptions = { inputType };
        return {
          ...params,
          providerOptions: {
            ...params.providerOptions,
            cohere: cohereOptions,
          },
          values,
        };
      }
      return { ...params, values };
    },
    wrapEmbed: async ({ doEmbed }) => {
      const result = await doEmbed();
      const embeddings: number[][] = [];
      for (let index = 0; index < result.embeddings.length; index += 1) {
        embeddings.push(readEmbeddingVector(
          result.embeddings[index],
          outputDimensions,
          `${config.runtimeName} embedding response ${index + 1}`,
        ));
      }
      return { ...result, embeddings };
    },
  };
}
