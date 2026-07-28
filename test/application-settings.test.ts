import { describe, expect, it } from "vitest";

import {
  applyProviderSettingsChanges,
  decodeRuntimeSettingValue,
  runtimeSettingDefinitions,
} from "../src/app/settings.js";
import {
  readProviderConnectionConfiguration,
  runtimeSettingsSchema,
} from "../src/config/index.js";
import { createTestProviderSettings } from "./provider-settings-fixture.js";

describe("runtime setting contract", () => {
  it("exposes one editable definition for every runtime setting", () => {
    const definitionKeys = runtimeSettingDefinitions
      .map((definition) => definition.key)
      .sort();
    const schemaKeys = runtimeSettingsSchema.keyof().options.sort();

    expect(definitionKeys).toEqual(schemaKeys);
    expect(new Set(definitionKeys).size).toBe(definitionKeys.length);
  });

  it("validates a setting value with its named schema", () => {
    expect(decodeRuntimeSettingValue("doclingTimeoutSeconds", 600)).toBe(600);
    expect(() => decodeRuntimeSettingValue("doclingTimeoutSeconds", 1)).toThrow(
      "Invalid value for Base processing timeout",
    );
    expect(() => decodeRuntimeSettingValue("topK", "10")).toThrow(
      "Invalid value for Answer context count",
    );
  });
});

describe("provider settings changes", () => {
  it("preserves credentials when public connection fields change", () => {
    const defaults = createTestProviderSettings();
    const current = structuredClone(defaults);
    current.connections.groq.apiToken = "stored-secret";
    const configuration = readProviderConnectionConfiguration(
      current.connections.groq,
    );
    configuration.answer.contextCapacityTokens = 16_384;
    configuration.maximumParallelRequests = 3;
    configuration.speechToText.model = "configured-stt";

    const updated = applyProviderSettingsChanges(
      current,
      defaults,
      [{ action: "configure", configuration, providerId: "groq" }],
    );

    expect(updated.connections.groq.apiToken).toBe("stored-secret");
    expect(updated.connections.groq.answer.contextCapacityTokens).toBe(16_384);
    expect(updated.connections.groq.maximumParallelRequests).toBe(3);
    expect(updated.connections.groq.speechToText.model).toBe("configured-stt");
  });

  it("resets provider settings to the database-owned defaults", () => {
    const defaults = createTestProviderSettings();
    defaults.connections.custom.baseUrl = "http://localhost:9000/v1";
    const current = structuredClone(defaults);
    current.connections.openai.apiToken = "stored-secret";

    const updated = applyProviderSettingsChanges(
      current,
      defaults,
      [{ action: "reset" }],
    );

    expect(updated).toEqual(defaults);
    expect(updated).not.toBe(defaults);
  });

  it("replaces capability credentials with one shared provider credential", () => {
    const defaults = createTestProviderSettings();
    const current = structuredClone(defaults);
    current.connections.custom.reranking.apiToken = "capability-rerank";
    current.connections.custom.speechToText.apiToken = "capability-stt";
    current.connections.custom.textToSpeech.apiToken = "capability-tts";

    const updated = applyProviderSettingsChanges(
      current,
      defaults,
      [{
        action: "credential",
        providerId: "custom",
        target: "shared",
        value: "one-provider-secret",
      }],
    );

    expect(updated.connections.custom).toMatchObject({
      apiToken: "one-provider-secret",
      reranking: { apiToken: null },
      speechToText: { apiToken: null },
      textToSpeech: { apiToken: null },
    });
  });

  it("preserves unrelated capability credentials", () => {
    const defaults = createTestProviderSettings();
    const current = structuredClone(defaults);
    current.connections.custom.textToSpeech.apiToken = "database-secret";
    const configuration = readProviderConnectionConfiguration(
      current.connections.groq,
    );
    configuration.speechToText.model = "configured-stt";

    const updated = applyProviderSettingsChanges(
      current,
      defaults,
      [{ action: "configure", configuration, providerId: "groq" }],
    );

    expect(updated.connections.custom.textToSpeech.apiToken).toBe(
      "database-secret",
    );
  });

  it("updates feature model and context overrides", () => {
    const defaults = createTestProviderSettings();
    const current = structuredClone(defaults);

    const updated = applyProviderSettingsChanges(
      current,
      defaults,
      [{
        action: "feature",
        configuration: {
          capability: "answer",
          contextCapacityTokensOverride: 16_384,
          modelOverride: "feature-answer-model",
          providerId: "lmstudio",
        },
      }],
    );

    expect(updated.featureOverrides.answer).toEqual({
      contextCapacityTokensOverride: 16_384,
      modelOverride: "feature-answer-model",
    });
    expect(updated.routing.answer).toBe("lmstudio");
  });

  it("updates query expansion independently from summarization", () => {
    const defaults = createTestProviderSettings();
    const current = structuredClone(defaults);

    const updated = applyProviderSettingsChanges(
      current,
      defaults,
      [{
        action: "feature",
        configuration: {
          capability: "queryExpansion",
          contextCapacityTokensOverride: 65_536,
          modelOverride: "query-expansion-model",
          providerId: "deepseek",
        },
      }],
    );

    expect(updated.featureOverrides.queryExpansion).toEqual({
      contextCapacityTokensOverride: 65_536,
      modelOverride: "query-expansion-model",
    });
    expect(updated.routing.queryExpansion).toBe("deepseek");
    expect(updated.routing.summarization).toBe("lmstudio");
  });

  it("rejects API tokens and endpoint overrides for OpenAI Codex", () => {
    const defaults = createTestProviderSettings();
    const current = structuredClone(defaults);
    const configuration = readProviderConnectionConfiguration(
      current.connections["openai-codex"],
    );
    configuration.answer.baseUrl = "https://example.com/v1";

    expect(() => applyProviderSettingsChanges(
      current,
      defaults,
      [{
        action: "credential",
        providerId: "openai-codex",
        target: "shared",
        value: "not-allowed",
      }],
    )).toThrow("uses device sign-in");
    expect(() => applyProviderSettingsChanges(
      current,
      defaults,
      [{
        action: "configure",
        configuration,
        providerId: "openai-codex",
      }],
    )).toThrow("fixed ChatGPT Codex endpoint");
  });
});
