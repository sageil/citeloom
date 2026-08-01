import { describe, expect, it, vi } from "vitest";

import {
  readLanguageModelCapabilities,
} from "../src/inference/model-capabilities.js";
import type { LanguageInferenceConfig } from "../src/config/index.js";

const config: LanguageInferenceConfig = {
  adaptiveContextEnabled: false,
  adapter: "openai-compatible-language",
  apiToken: null,
  baseUrl: "http://localhost:1234/v1",
  providerId: "local-ai",
  contextCapacityTokens: 32_768,
  model: "answer-model",
  runtimeName: "LM Studio",
  thinkingMode: "disabled",
  timeoutMs: 1_000,
};

describe("language model capability boundary", () => {
  it("uses the provider context capacity without contacting the provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const capabilities = await readLanguageModelCapabilities(
      config,
      new AbortController().signal,
    );

    expect(capabilities.contextCapacityTokens).toBe(32_768);
    expect(capabilities.source).toBe("configured");
    expect(capabilities.tokenCounter.contract).toBe("utf8-byte-upper-bound");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the selected provider's configured capacity", async () => {
    const capabilities = await readLanguageModelCapabilities(
      {
        ...config,
        contextCapacityTokens: 8_192,
      },
      new AbortController().signal,
    );

    expect(capabilities.contextCapacityTokens).toBe(8_192);
  });
});
