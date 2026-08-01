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
      "Cohere does not support text-to-speech",
    );
  });

  it("rejects a selected model without a context capacity", () => {
    const providers = createTestProviderSettings();
    providers.connections.lmstudio.answer.contextCapacityTokens = null;

    expect(() => parseProviderSettings(providers)).toThrow(
      "requires a context capacity for answer generation",
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
      startup.doclingServices,
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
    providers.connections.deepseek.summarization.model = "deepseek-v4-flash";
    providers.routing.answer = "deepseek";
    providers.routing.queryExpansion = "deepseek";
    providers.routing.summarization = "deepseek";
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });

    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.doclingServices,
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
    expect(config.inference.summary).toMatchObject({
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
      startup.doclingServices,
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
    providers.featureOverrides.summarization.thinkingModeOverride = "disabled";
    const startup = readEqualWeightTestConfig({ runtime: runtimeSettings });

    const config = buildAppConfig(
      startup.database,
      runtimeSettings,
      1,
      providers,
      startup.doclingServices,
      startup.sourceContent,
      TEST_EMBEDDING_INPUT_FORMAT,
    );

    expect(config.inference.answer.thinkingMode).toBe("enabled");
    expect(config.inference.chat.thinkingMode).toBe("enabled");
    expect(config.inference.queryExpansion.thinkingMode).toBe("enabled");
    expect(config.inference.summary.thinkingMode).toBe("disabled");
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
      startup.doclingServices,
      startup.sourceContent,
      TEST_EMBEDDING_INPUT_FORMAT,
    );

    providers.routing.textToSpeech = "groq";
    const cloudConfig = buildAppConfig(
      startup.database,
      runtimeSettings,
      2,
      providers,
      startup.doclingServices,
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
    startup.doclingServices,
    startup.sourceContent,
    TEST_EMBEDDING_INPUT_FORMAT,
  );
}
