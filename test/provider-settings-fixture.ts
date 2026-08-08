import {
  parseProviderSettings,
  type ProviderCapabilityConnection,
  type ProviderConnection,
  type ProviderModelConnection,
  type ProviderProfile,
  type ProviderSettings,
  type ProviderTextToSpeechConnection,
} from "../src/config/index.js";

const TEST_PROVIDER_IDS = [
  "cohere",
  "custom",
  "deepseek",
  "groq",
  "jina",
  "lmstudio",
  "ollama",
  "omlx",
  "openai",
  "openai-codex",
  "openrouter",
] as const;

type TestProviderId = typeof TEST_PROVIDER_IDS[number];

export interface TestProviderSettings extends ProviderSettings {
  connections: Record<TestProviderId, ProviderConnection>;
}

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
  indexingModel?: string;
  textToSpeechApiToken?: string | null;
  textToSpeechBaseUrl?: string;
  textToSpeechEnabled?: boolean;
  textToSpeechModel?: string;
  textToSpeechVoice?: string;
}

function createTestProviderCatalog(): ProviderProfile[] {
  return [
    createTestProviderProfile("cohere", "Cohere", [
      { adapter: "cohere-language", capability: "answer" },
      { adapter: "cohere-language", capability: "chat" },
      { adapter: "cohere-embedding", capability: "embedding" },
      { adapter: "cohere-language", capability: "queryExpansion" },
      { adapter: "cohere-rerank", capability: "reranking" },
      { adapter: "cohere-language", capability: "indexing" },
    ]),
    createTestProviderProfile("custom", "Custom", [
      { adapter: "openai-compatible-language", capability: "answer" },
      { adapter: "openai-compatible-language", capability: "chat" },
      { adapter: "openai-compatible-embedding", capability: "embedding" },
      { adapter: "openai-compatible-language", capability: "queryExpansion" },
      { adapter: "top-n-rerank", capability: "reranking" },
      { adapter: "openai-transcription", capability: "speechToText" },
      { adapter: "openai-compatible-language", capability: "indexing" },
      { adapter: "openai-speech", capability: "textToSpeech" },
    ], { adapterConfiguration: "connection" }),
    createTestProviderProfile("deepseek", "DeepSeek", [
      { adapter: "deepseek-language", capability: "answer" },
      { adapter: "deepseek-language", capability: "chat" },
      { adapter: "deepseek-language", capability: "queryExpansion" },
      { adapter: "deepseek-language", capability: "indexing" },
    ]),
    createTestProviderProfile("groq", "Groq", [
      { adapter: "openai-compatible-language", capability: "answer" },
      { adapter: "openai-compatible-language", capability: "chat" },
      { adapter: "openai-compatible-language", capability: "queryExpansion" },
      { adapter: "openai-transcription", capability: "speechToText" },
      { adapter: "openai-compatible-language", capability: "indexing" },
      { adapter: "groq-speech", capability: "textToSpeech" },
    ]),
    createTestProviderProfile("jina", "Jina", [
      { adapter: "openai-compatible-embedding", capability: "embedding" },
      { adapter: "top-n-rerank", capability: "reranking" },
    ]),
    createTestProviderProfile("lmstudio", "LM Studio", [
      { adapter: "openai-compatible-language", capability: "answer" },
      { adapter: "openai-compatible-language", capability: "chat" },
      { adapter: "openai-compatible-embedding", capability: "embedding" },
      { adapter: "openai-compatible-language", capability: "queryExpansion" },
      { adapter: "openai-compatible-language", capability: "indexing" },
    ], { engineType: "api_lmstudio" }),
    createTestProviderProfile("ollama", "Ollama", [
      { adapter: "ollama-language", capability: "answer" },
      { adapter: "ollama-language", capability: "chat" },
      { adapter: "ollama-embedding", capability: "embedding" },
      { adapter: "ollama-language", capability: "queryExpansion" },
      { adapter: "ollama-language", capability: "indexing" },
    ], { endpointStyle: "ollama", engineType: "api_ollama" }),
    createTestProviderProfile("omlx", "oMLX", [
      { adapter: "openai-compatible-language", capability: "answer" },
      { adapter: "openai-compatible-language", capability: "chat" },
      { adapter: "openai-compatible-embedding", capability: "embedding" },
      { adapter: "openai-compatible-language", capability: "queryExpansion" },
      { adapter: "top-n-rerank", capability: "reranking" },
      { adapter: "omlx-transcription", capability: "speechToText" },
      { adapter: "openai-compatible-language", capability: "indexing" },
      { adapter: "omlx-speech", capability: "textToSpeech" },
    ]),
    createTestProviderProfile("openai", "OpenAI", [
      { adapter: "openai-compatible-language", capability: "answer" },
      { adapter: "openai-compatible-language", capability: "chat" },
      { adapter: "openai-compatible-embedding", capability: "embedding" },
      { adapter: "openai-compatible-language", capability: "queryExpansion" },
      { adapter: "openai-transcription", capability: "speechToText" },
      { adapter: "openai-compatible-language", capability: "indexing" },
      { adapter: "openai-speech", capability: "textToSpeech" },
    ], { engineType: "api_openai" }),
    createTestProviderProfile("openai-codex", "OpenAI Codex", [
      { adapter: "openai-codex-language", capability: "answer" },
      { adapter: "openai-codex-language", capability: "chat" },
      { adapter: "openai-codex-language", capability: "queryExpansion" },
      { adapter: "openai-codex-language", capability: "indexing" },
    ], { authentication: "openai-device", doclingVlm: null }),
    createTestProviderProfile("openrouter", "OpenRouter", [
      { adapter: "openrouter-language", capability: "answer" },
      { adapter: "openrouter-language", capability: "chat" },
      { adapter: "openai-compatible-embedding", capability: "embedding" },
      { adapter: "openrouter-language", capability: "queryExpansion" },
      { adapter: "top-n-rerank", capability: "reranking" },
      { adapter: "openrouter-transcription", capability: "speechToText" },
      { adapter: "openrouter-language", capability: "indexing" },
      { adapter: "openrouter-speech", capability: "textToSpeech" },
    ]),
  ];
}

function createTestProviderProfile(
  id: TestProviderId,
  displayName: string,
  capabilities: ProviderProfile["capabilities"],
  options: {
    adapterConfiguration?: ProviderProfile["adapterConfiguration"];
    authentication?: ProviderProfile["authentication"];
    doclingVlm?: ProviderProfile["doclingVlm"];
    endpointStyle?: "ollama" | "openai";
    engineType?: NonNullable<ProviderProfile["doclingVlm"]>["engineType"];
  } = {},
): ProviderProfile {
  const doclingVlm = options.doclingVlm === null
    ? null
    : {
      endpointStyle: options.endpointStyle ?? "openai",
      engineType: options.engineType ?? "api",
    };
  return {
    adapterConfiguration: options.adapterConfiguration ?? "catalog",
    authentication: options.authentication ?? "api-token",
    capabilities,
    displayName,
    doclingVlm,
    id,
  };
}

export function createTestProviderSettings(
  options: TestProviderSettingsOptions = {},
): TestProviderSettings {
  const inferenceBaseUrl =
    options.inferenceBaseUrl ?? "http://localhost:1234/v1";
  const omlxBaseUrl = "http://host.docker.internal:9000/v1";
  const connections: Record<TestProviderId, ProviderConnection> = {
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
  connections.deepseek.indexing = createModelConnection(
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
  connections.ollama.indexing = createModelConnection(
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
  connections.lmstudio.indexing = createModelConnection(
    options.indexingModel ?? "indexing-model",
    32_768,
    inferenceBaseUrl,
    options.inferenceApiToken ?? null,
  );
  connections.lmstudio.queryExpansion = createModelConnection(
    options.queryExpansionModel
      ?? options.indexingModel
      ?? "indexing-model",
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
  connections["openai-codex"].indexing = createModelConnection(
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
  connections.openrouter.indexing = createModelConnection(
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
    catalog: createTestProviderCatalog(),
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
      indexing: {
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
      indexing: "lmstudio",
      textToSpeech: options.textToSpeechEnabled === true ? "omlx" : null,
    },
  }) as TestProviderSettings;
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
      indexing: "openai-compatible-language",
      textToSpeech: "openai-speech",
    },
    embedding: createModelConnection(null, null),
    maximumParallelRequests: 1,
    name: null,
    sendReasoningOptions: true,
    thinkingMode: "disabled",
    reranking: createCapabilityConnection(),
    speechToText: createCapabilityConnection(),
    queryExpansion: createModelConnection(null, null),
    indexing: createModelConnection(null, null),
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
