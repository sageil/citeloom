import {
  parseProviderSettings,
  type ProviderCapabilityConnection,
  type ProviderConnection,
  type ProviderModelConnection,
  type ProviderSettings,
  type ProviderTextToSpeechConnection,
} from "../src/config/index.js";

export interface TestProviderSettingsOptions {
  answerModel?: string;
  embeddingModel?: string;
  inferenceApiToken?: string | null;
  inferenceBaseUrl?: string;
  queryExpansionModel?: string;
  rerankApiToken?: string | null;
  rerankBaseUrl?: string;
  rerankEnabled?: boolean;
  rerankModel?: string;
  speechToTextApiToken?: string | null;
  speechToTextBaseUrl?: string;
  speechToTextEnabled?: boolean;
  speechToTextModel?: string;
  summaryModel?: string;
  textToSpeechApiToken?: string | null;
  textToSpeechBaseUrl?: string;
  textToSpeechEnabled?: boolean;
  textToSpeechModel?: string;
  textToSpeechVoice?: string;
}

export function createTestProviderSettings(
  options: TestProviderSettingsOptions = {},
): ProviderSettings {
  const inferenceBaseUrl =
    options.inferenceBaseUrl ?? "http://localhost:1234/v1";
  const omlxBaseUrl = "http://host.docker.internal:9000/v1";
  const connections: ProviderSettings["connections"] = {
    cohere: createProviderConnection("https://api.cohere.com/v2"),
    custom: createProviderConnection(null),
    deepseek: createProviderConnection("https://api.deepseek.com"),
    groq: createProviderConnection("https://api.groq.com/openai/v1"),
    jina: createProviderConnection("https://api.jina.ai/v1"),
    lmstudio: createProviderConnection(inferenceBaseUrl),
    ollama: createProviderConnection("http://host.docker.internal:11434"),
    omlx: createProviderConnection(omlxBaseUrl),
    openai: createProviderConnection("https://api.openai.com/v1"),
    openrouter: createProviderConnection("https://openrouter.ai/api/v1"),
    "openai-codex": createProviderConnection(
      "https://chatgpt.com/backend-api/codex",
    ),
  };

  connections.deepseek.answer = createModelConnection(
    "deepseek-v4-flash",
    1_000_000,
  );
  connections.deepseek.summarization = createModelConnection(
    "deepseek-v4-flash",
    1_000_000,
  );
  connections.deepseek.queryExpansion = createModelConnection(
    "deepseek-v4-flash",
    1_000_000,
  );
  connections.ollama.answer = createModelConnection("gemma4:e4b", 131_072);
  connections.ollama.customAdapters.embedding = "ollama-embedding";
  connections.ollama.embedding = createModelConnection(
    "embeddinggemma",
    2_048,
  );
  connections.ollama.summarization = createModelConnection(
    "gemma4:e4b",
    131_072,
  );
  connections.ollama.queryExpansion = createModelConnection(
    "gemma4:e4b",
    131_072,
  );
  connections.lmstudio.answer = createModelConnection(
    options.answerModel ?? "vision-model",
    32_768,
    inferenceBaseUrl,
    options.inferenceApiToken ?? null,
  );
  connections.lmstudio.embedding = createModelConnection(
    options.embeddingModel ?? "embedding-model",
    2_048,
    inferenceBaseUrl,
    options.inferenceApiToken ?? null,
  );
  connections.lmstudio.summarization = createModelConnection(
    options.summaryModel ?? "summary-model",
    32_768,
    inferenceBaseUrl,
    options.inferenceApiToken ?? null,
  );
  connections.lmstudio.queryExpansion = createModelConnection(
    options.queryExpansionModel
      ?? options.summaryModel
      ?? "summary-model",
    32_768,
    inferenceBaseUrl,
    options.inferenceApiToken ?? null,
  );
  connections["openai-codex"].answer = createModelConnection(
    "gpt-5.6-terra",
    272_000,
  );
  connections["openai-codex"].queryExpansion = createModelConnection(
    "gpt-5.6-terra",
    272_000,
  );
  connections["openai-codex"].summarization = createModelConnection(
    "gpt-5.6-terra",
    272_000,
  );
  connections.openrouter.answer = createModelConnection(
    "openrouter/free",
    200_000,
  );
  connections.openrouter.embedding = createModelConnection(
    "nvidia/nemotron-3-embed-1b:free",
    32_768,
  );
  connections.openrouter.queryExpansion = createModelConnection(
    "openrouter/free",
    200_000,
  );
  connections.openrouter.reranking = createCapabilityConnection(
    "nvidia/llama-nemotron-rerank-vl-1b-v2:free",
  );
  connections.openrouter.speechToText = createCapabilityConnection(
    "openai/gpt-4o-mini-transcribe",
  );
  connections.openrouter.summarization = createModelConnection(
    "openrouter/free",
    200_000,
  );
  connections.openrouter.textToSpeech = createTextToSpeechConnection(
    "fish-audio/s2.1-pro-free:free",
    "alloy",
  );
  connections.omlx.reranking = createCapabilityConnection(
    options.rerankModel ?? "reranker-model",
    options.rerankBaseUrl ?? omlxBaseUrl,
    options.rerankApiToken ?? null,
  );
  connections.omlx.speechToText = createCapabilityConnection(
    options.speechToTextModel ?? "speech-to-text-model",
    options.speechToTextBaseUrl ?? omlxBaseUrl,
    options.speechToTextApiToken ?? null,
  );
  connections.omlx.textToSpeech = createTextToSpeechConnection(
    options.textToSpeechModel ?? "text-to-speech-model",
    options.textToSpeechVoice ?? "test-voice",
    options.textToSpeechBaseUrl ?? omlxBaseUrl,
    options.textToSpeechApiToken ?? null,
  );

  return parseProviderSettings({
    connections,
    featureOverrides: {
      answer: {
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
      textToSpeech: {
        modelOverride: null,
        voiceOverride: null,
      },
    },
    routing: {
      answer: "lmstudio",
      embedding: "lmstudio",
      queryExpansion: "lmstudio",
      reranking: options.rerankEnabled === true ? "omlx" : null,
      speechToText: options.speechToTextEnabled === true ? "omlx" : null,
      summarization: "lmstudio",
      textToSpeech: options.textToSpeechEnabled === true ? "omlx" : null,
    },
  });
}

function createProviderConnection(baseUrl: string | null): ProviderConnection {
  return {
    adaptiveContextEnabled: false,
    answer: createModelConnection(null, null),
    apiToken: null,
    baseUrl,
    customAdapters: {
      answer: "openai-compatible-language",
      embedding: "openai-compatible-embedding",
      queryExpansion: "openai-compatible-language",
      reranking: "top-n-rerank",
      speechToText: "openai-transcription",
      summarization: "openai-compatible-language",
      textToSpeech: "openai-speech",
    },
    embedding: createModelConnection(null, null),
    maximumParallelRequests: 1,
    name: null,
    thinkingMode: "disabled",
    reranking: createCapabilityConnection(),
    speechToText: createCapabilityConnection(),
    queryExpansion: createModelConnection(null, null),
    summarization: createModelConnection(null, null),
    textToSpeech: createTextToSpeechConnection(),
  };
}

function createCapabilityConnection(
  model: string | null = null,
  baseUrl: string | null = null,
  apiToken: string | null = null,
): ProviderCapabilityConnection {
  return {
    apiToken,
    baseUrl,
    model,
  };
}

function createModelConnection(
  model: string | null,
  contextCapacityTokens: number | null,
  baseUrl: string | null = null,
  apiToken: string | null = null,
): ProviderModelConnection {
  return {
    ...createCapabilityConnection(model, baseUrl, apiToken),
    contextCapacityTokens,
  };
}

function createTextToSpeechConnection(
  model: string | null = null,
  voice: string | null = null,
  baseUrl: string | null = null,
  apiToken: string | null = null,
): ProviderTextToSpeechConnection {
  return {
    ...createCapabilityConnection(
      model,
      baseUrl,
      apiToken,
    ),
    voice,
  };
}
