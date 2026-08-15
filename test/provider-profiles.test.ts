import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAppConfig,
  parseProviderSettings,
} from "../src/config/index.js";
import {
  createTestRuntimeSettings,
  readEqualWeightTestConfig,
  TEST_EMBEDDING_INPUT_FORMAT,
} from "./config-fixture.js";
import { createTestProviderSettings } from "./provider-settings-fixture.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider profiles", () => {
  it("requires provider model contexts to come from stored settings", () => {
    const providers = createTestProviderSettings();
    const {
      contextCapacityTokens: _answerContext,
      ...answerWithoutContext
    } = providers.connections.ollama.answer;

    expect(() => parseProviderSettings({
      ...providers,
      connections: {
        ...providers.connections,
        ollama: {
          ...providers.connections.ollama,
          answer: answerWithoutContext,
        },
      },
    })).toThrow("connections.ollama.answer.contextCapacityTokens");
  });

  it("rejects an unsupported provider-capability route", () => {
    const providers = createTestProviderSettings();
    providers.routing.textToSpeech = "cohere";

    expect(() => parseProviderSettings(providers)).toThrow(
      "Cohere does not support Spoken answers",
    );
  });

  it("accepts a provider supplied by the stored catalog", () => {
    const providers = createTestProviderSettings();
    const sourceProfile = providers.catalog.find((profile) => {
      return profile.id === "lmstudio";
    });
    if (sourceProfile === undefined) {
      throw new Error("Missing LM Studio test profile.");
    }
    providers.catalog = [
      ...providers.catalog,
      {
        ...structuredClone(sourceProfile),
        displayName: "Database Provider",
        id: "database-provider",
      },
    ];
    providers.routing.answer = "database-provider";
    providers.routing.chat = "database-provider";

    const parsed = parseProviderSettings({
      ...providers,
      connections: {
        ...providers.connections,
        "database-provider": structuredClone(providers.connections.lmstudio),
      },
    });

    expect(parsed.routing.answer).toBe("database-provider");
  });

  it("defaults provider reasoning controls to enabled at the settings boundary", () => {
    const providers = createTestProviderSettings();
    const {
      sendReasoningOptions: _sendReasoningOptions,
      ...connectionWithoutReasoningControl
    } = providers.connections.lmstudio;

    const parsed = parseProviderSettings({
      ...providers,
      connections: {
        ...providers.connections,
        lmstudio: connectionWithoutReasoningControl,
      },
    });

    expect(parsed.connections.lmstudio?.sendReasoningOptions).toBe(true);
  });

  it("allows an unused catalog provider to have no connection", () => {
    const providers = createTestProviderSettings();
    const { openrouter: _unused, ...connections } = providers.connections;

    const parsed = parseProviderSettings({ ...providers, connections });

    expect(parsed.connections.openrouter).toBeUndefined();
  });

  it("rejects a routed catalog provider without a connection", () => {
    const providers = createTestProviderSettings();
    const { openrouter: _unused, ...connections } = providers.connections;
    providers.routing.answer = "openrouter";

    expect(() => parseProviderSettings({
      ...providers,
      connections,
    })).toThrow("OpenRouter has no configured connection");
  });

  it("rejects a connection without a catalog profile", () => {
    const providers = createTestProviderSettings();
    expect(() => parseProviderSettings({
      ...providers,
      connections: {
        ...providers.connections,
        "orphan-provider": structuredClone(providers.connections.lmstudio),
      },
    })).toThrow(
      "Provider connection orphan-provider has no catalog profile",
    );
  });

  it("rejects a selected model without a context capacity", () => {
    const providers = createTestProviderSettings();
    providers.connections.lmstudio.answer.contextCapacityTokens = null;

    expect(() => parseProviderSettings(providers)).toThrow(
      "requires a context capacity for Ask",
    );
  });

  it("rejects provider concurrency above the supported limit", () => {
    const providers = createTestProviderSettings();
    providers.connections.lmstudio.maximumParallelRequests = 17;

    expect(() => parseProviderSettings(providers)).toThrow(
      "providers.connections.lmstudio.maximumParallelRequests",
    );
  });

  it("resolves configured profiles without contacting a provider", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const runtimeSettings = createTestRuntimeSettings();
    const providers = createTestProviderSettings();
    providers.connections.groq.apiToken = "groq-token";
    providers.connections.groq.speechToText.model = "configured-stt";
    providers.connections.groq.textToSpeech.model = "configured-tts";
    providers.connections.groq.textToSpeech.voice = "configured-voice";
    providers.routing.speechToText = "groq";
    providers.routing.textToSpeech = "groq";
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });

    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.sourceContent,
      TEST_EMBEDDING_INPUT_FORMAT,
    );

    expect(config.speechToText).toMatchObject({
      adapter: "openai-transcription",
      apiToken: "groq-token",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "configured-stt",
    });
    expect(config.textToSpeech).toMatchObject({
      adapter: "groq-speech",
      apiToken: "groq-token",
      baseUrl: "https://api.groq.com/openai/v1",
      model: "configured-tts",
      voice: "configured-voice",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves DeepSeek through its OpenAI-compatible language adapter", () => {
    const runtimeSettings = createTestRuntimeSettings();
    const providers = createTestProviderSettings();
    providers.connections.deepseek.apiToken = "deepseek-token";
    providers.connections.deepseek.answer.model = "deepseek-v4-flash";
    providers.connections.deepseek.queryExpansion.model = "deepseek-v4-flash";
    providers.connections.deepseek.indexing.model = "deepseek-v4-flash";
    providers.routing.answer = "deepseek";
    providers.routing.queryExpansion = "deepseek";
    providers.routing.indexing = "deepseek";
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });

    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.sourceContent,
      TEST_EMBEDDING_INPUT_FORMAT,
    );

    expect(config.inference.answer).toMatchObject({
      adapter: "deepseek-language",
      apiToken: "deepseek-token",
      baseUrl: "https://api.deepseek.com",
      contextCapacityTokens: 1_000_000,
      model: "deepseek-v4-flash",
      runtimeName: "DeepSeek",
    });
    expect(config.inference.indexing).toMatchObject({
      adapter: "deepseek-language",
      apiToken: "deepseek-token",
      baseUrl: "https://api.deepseek.com",
      contextCapacityTokens: 1_000_000,
      model: "deepseek-v4-flash",
      runtimeName: "DeepSeek",
    });
    expect(config.inference.queryExpansion).toMatchObject({
      adapter: "deepseek-language",
      apiToken: "deepseek-token",
      baseUrl: "https://api.deepseek.com",
      contextCapacityTokens: 1_000_000,
      model: "deepseek-v4-flash",
      runtimeName: "DeepSeek",
    });
  });

  it("resolves OpenRouter language, embedding, reranking, and speech capabilities", () => {
    const runtimeSettings = createTestRuntimeSettings();
    const providers = createTestProviderSettings();
    providers.connections.openrouter.apiToken = "openrouter-token";
    providers.routing.answer = "openrouter";
    providers.routing.chat = "openrouter";
    providers.routing.embedding = "openrouter";
    providers.routing.queryExpansion = "openrouter";
    providers.routing.reranking = "openrouter";
    providers.routing.speechToText = "openrouter";
    providers.routing.indexing = "openrouter";
    providers.routing.textToSpeech = "openrouter";
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });

    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.sourceContent,
      TEST_EMBEDDING_INPUT_FORMAT,
    );

    expect(config.inference.answer).toMatchObject({
      adapter: "openrouter-language",
      apiToken: "openrouter-token",
      baseUrl: "https://openrouter.ai/api/v1",
      contextCapacityTokens: 200_000,
      model: "openrouter/free",
      runtimeName: "OpenRouter",
    });
    expect(config.inference.embedding).toMatchObject({
      adapter: "openai-compatible-embedding",
      apiToken: "openrouter-token",
      baseUrl: "https://openrouter.ai/api/v1",
      maximumInputTokens: 32_768,
      model: "nvidia/nemotron-3-embed-1b:free",
      runtimeName: "OpenRouter",
    });
    expect(config.retrieval.reranker).toMatchObject({
      adapter: "top-n-rerank",
      apiToken: "openrouter-token",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "nvidia/llama-nemotron-rerank-vl-1b-v2:free",
      runtimeName: "OpenRouter",
    });
    expect(config.speechToText).toMatchObject({
      adapter: "openrouter-transcription",
      apiToken: "openrouter-token",
      model: "openai/gpt-4o-mini-transcribe",
    });
    expect(config.textToSpeech).toMatchObject({
      adapter: "openrouter-speech",
      apiToken: "openrouter-token",
      model: "fish-audio/s2.1-pro-free:free",
      voice: "alloy",
    });
  });

  it("resolves Cohere reranking from the stored catalog adapter", () => {
    const runtimeSettings = createTestRuntimeSettings();
    const providers = createTestProviderSettings();
    providers.connections.cohere.apiToken = "cohere-token";
    providers.connections.cohere.reranking.model = "rerank-v4.0-pro";
    providers.routing.reranking = "cohere";
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });

    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.sourceContent,
      TEST_EMBEDDING_INPUT_FORMAT,
    );

    expect(config.retrieval.reranker).toMatchObject({
      adapter: "cohere-rerank",
      apiToken: "cohere-token",
      baseUrl: "https://api.cohere.com/v2",
      model: "rerank-v4.0-pro",
      runtimeName: "Cohere",
    });
  });

  it("uses feature model and context overrides without changing provider defaults", () => {
    const runtimeSettings = createTestRuntimeSettings();
    const providers = createTestProviderSettings();
    providers.featureOverrides.answer = {
      contextCapacityTokensOverride: 65_536,
      modelOverride: "answer-override",
      thinkingModeOverride: null,
    };
    providers.featureOverrides.embedding = {
      contextCapacityTokensOverride: 4_096,
      modelOverride: "embedding-override",
    };
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });

    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.sourceContent,
      TEST_EMBEDDING_INPUT_FORMAT,
    );

    expect(config.inference.answer).toMatchObject({
      contextCapacityTokens: 65_536,
      model: "answer-override",
    });
    expect(config.inference.embedding).toMatchObject({
      maximumInputTokens: 4_096,
      model: "embedding-override",
    });
    expect(providers.connections.lmstudio.answer).toMatchObject({
      contextCapacityTokens: 32_768,
      model: "vision-model",
    });
  });

  it("inherits provider thinking mode unless a language feature overrides it", () => {
    const runtimeSettings = createTestRuntimeSettings();
    const providers = createTestProviderSettings();
    providers.connections.lmstudio.thinkingMode = "enabled";
    providers.featureOverrides.indexing.thinkingModeOverride = "disabled";
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });

    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.sourceContent,
      TEST_EMBEDDING_INPUT_FORMAT,
    );
    const queryExpansion = config.inference.queryExpansion;
    if (queryExpansion === null) {
      throw new Error("Expected query expansion to be configured.");
    }

    expect(config.inference.answer.thinkingMode).toBe("enabled");
    expect(config.inference.chat.thinkingMode).toBe("enabled");
    expect(queryExpansion.thinkingMode).toBe("enabled");
    expect(config.inference.indexing.thinkingMode).toBe("disabled");
  });

  it("applies the provider reasoning-control policy to every language feature", () => {
    const runtimeSettings = createTestRuntimeSettings();
    const providers = createTestProviderSettings();
    providers.connections.lmstudio.sendReasoningOptions = false;
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });

    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.sourceContent,
      TEST_EMBEDDING_INPUT_FORMAT,
    );
    const queryExpansion = config.inference.queryExpansion;
    if (queryExpansion === null) {
      throw new Error("Expected query expansion to be configured.");
    }

    expect(config.inference.answer.sendReasoningOptions).toBe(false);
    expect(config.inference.chat.sendReasoningOptions).toBe(false);
    expect(queryExpansion.sendReasoningOptions).toBe(false);
    expect(config.inference.indexing.sendReasoningOptions).toBe(false);
  });

  it("switches text-to-speech by route while retaining both connections", () => {
    const runtimeSettings = createTestRuntimeSettings();
    const providers = createTestProviderSettings();
    providers.connections.omlx.textToSpeech.baseUrl =
      "http://localhost:9000/v1";
    providers.connections.omlx.textToSpeech.model = "local-tts";
    providers.connections.omlx.textToSpeech.voice = "local-voice";
    providers.connections.groq.apiToken = "groq-token";
    providers.connections.groq.textToSpeech.model = "cloud-tts";
    providers.connections.groq.textToSpeech.voice = "cloud-voice";
    providers.routing.textToSpeech = "omlx";
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });
    const localConfig = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.sourceContent,
      TEST_EMBEDDING_INPUT_FORMAT,
    );

    providers.routing.textToSpeech = "groq";
    const cloudConfig = buildAppConfig(
      startup.database,
      runtimeSettings,
      2,
      providers,
      startup.sourceContent,
      TEST_EMBEDDING_INPUT_FORMAT,
    );

    expect(localConfig.textToSpeech).toMatchObject({
      baseUrl: "http://localhost:9000/v1",
      model: "local-tts",
      voice: "local-voice",
    });
    expect(cloudConfig.textToSpeech).toMatchObject({
      apiToken: "groq-token",
      model: "cloud-tts",
      voice: "cloud-voice",
    });
  });

  it("enforces adapter-specific text-to-speech speed ranges", () => {
    expect(() => buildTextToSpeechConfig("groq", 0.25)).toThrow(
      "Groq speech speed must be from 0.5 to 5",
    );
    expect(buildTextToSpeechConfig("groq", 5).textToSpeech?.speed).toBe(5);
    expect(() => buildTextToSpeechConfig("openai", 5)).toThrow(
      "OpenAI-compatible speech speed must be from 0.25 to 4",
    );
  });
});

function buildTextToSpeechConfig(
  providerId: "groq" | "openai",
  speed: number,
) {
  const runtimeSettings = createTestRuntimeSettings({ ttsSpeed: speed });
  const providers = createTestProviderSettings();
  const connection = providers.connections[providerId];
  connection.textToSpeech.model = "configured-tts";
  connection.textToSpeech.voice = "configured-voice";
  providers.routing.textToSpeech = providerId;
  const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });

  return buildAppConfig(
    startup.database,
    runtimeSettings,
    1,
    providers,
    startup.sourceContent,
    TEST_EMBEDDING_INPUT_FORMAT,
  );
}
