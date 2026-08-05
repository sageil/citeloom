import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LanguageInferenceConfig } from "../src/config/index.js";
import {
  createOllamaLanguageModelRuntime,
  createOllamaModelMetadataCache,
  type OllamaLanguageModelRuntime,
  type OllamaModelMetadataCache,
} from "../src/inference/ollama-context.js";

const MODEL_DIGEST = "a".repeat(64);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Ollama model metadata", () => {
  it("discovers shared MLX metadata once and skips loaded-runner inspection", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", buildOllamaFetch("safetensors", paths));
    const cache = createOllamaModelMetadataCache();
    const first = buildRuntime(buildConfig("qwen3.5:9b-mlx"), cache);
    const second = buildRuntime(buildConfig("qwen3.5:9b-mlx"), cache);

    const [firstCapabilities, secondCapabilities] = await Promise.all([
      first.runtime.readCapabilities(new AbortController().signal),
      second.runtime.readCapabilities(new AbortController().signal),
    ]);
    await Promise.all([
      generateText({ maxRetries: 0, model: first.runtime.model, prompt: "First" }),
      generateText({ maxRetries: 0, model: second.runtime.model, prompt: "Second" }),
    ]);

    expect(firstCapabilities.source).toBe("configured");
    expect(secondCapabilities.source).toBe("configured");
    expect(paths.filter((path) => path === "/api/show")).toHaveLength(1);
    expect(paths.filter((path) => path === "/api/tags")).toHaveLength(1);
    expect(paths).not.toContain("/api/ps");
    expect(first.dynamicModelSelections).toBe(1);
    expect(second.dynamicModelSelections).toBe(1);
    expect(first.fixedContextSelections).toEqual([131_072]);
    expect(second.fixedContextSelections).toEqual([131_072]);
  });

  it("reuses GGUF metadata while inspecting mutable runner state per request", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const paths: string[] = [];
    vi.stubGlobal("fetch", buildOllamaFetch("gguf", paths));
    const cache = createOllamaModelMetadataCache();
    const first = buildRuntime(buildConfig("gemma4:12b"), cache);
    const second = buildRuntime(buildConfig("gemma4:12b"), cache);

    await Promise.all([
      generateText({ maxRetries: 0, model: first.runtime.model, prompt: "First" }),
      generateText({ maxRetries: 0, model: second.runtime.model, prompt: "Second" }),
    ]);

    expect(paths.filter((path) => path === "/api/show")).toHaveLength(1);
    expect(paths.filter((path) => path === "/api/tags")).toHaveLength(1);
    expect(paths.filter((path) => path === "/api/ps")).toHaveLength(2);
    expect(first.dynamicModelSelections).toBe(0);
    expect(second.dynamicModelSelections).toBe(0);
    expect(first.fixedContextSelections).toEqual([131_072, 131_072]);
    expect(second.fixedContextSelections).toEqual([131_072, 131_072]);
  });

  it("uses fixed GGUF context without loaded-runner inspection when adaptive sizing is off", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", buildOllamaFetch("gguf", paths));
    const config = buildConfig("gemma4:12b");
    config.adaptiveContextEnabled = false;
    const runtime = buildRuntime(config, createOllamaModelMetadataCache());

    await generateText({
      maxRetries: 0,
      model: runtime.runtime.model,
      prompt: "Fixed",
    });

    expect(paths.filter((path) => path === "/api/show")).toHaveLength(1);
    expect(paths.filter((path) => path === "/api/tags")).toHaveLength(1);
    expect(paths).not.toContain("/api/ps");
    expect(runtime.dynamicModelSelections).toBe(0);
    expect(runtime.fixedContextSelections).toEqual([131_072]);
  });

  it("keeps MLX context dynamic when adaptive GGUF sizing is off", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", buildOllamaFetch("safetensors", paths));
    const config = buildConfig("qwen3.5:9b-mlx");
    config.adaptiveContextEnabled = false;
    const runtime = buildRuntime(config, createOllamaModelMetadataCache());

    await generateText({
      maxRetries: 0,
      model: runtime.runtime.model,
      prompt: "Dynamic",
    });

    expect(paths.filter((path) => path === "/api/show")).toHaveLength(1);
    expect(paths.filter((path) => path === "/api/tags")).toHaveLength(1);
    expect(paths).not.toContain("/api/ps");
    expect(runtime.dynamicModelSelections).toBe(1);
    expect(runtime.fixedContextSelections).toEqual([131_072]);
  });
});

function buildConfig(model: string): LanguageInferenceConfig {
  return {
    adapter: "ollama-language",
    adaptiveContextEnabled: true,
    apiToken: null,
    baseUrl: "http://host.docker.internal:11434",
    contextCapacityTokens: 131_072,
    model,
    providerId: "ollama",
    runtimeName: "Ollama",
    thinkingMode: "disabled",
    timeoutMs: 10_000,
  };
}

function buildRuntime(
  config: LanguageInferenceConfig,
  metadataCache: OllamaModelMetadataCache,
): {
  dynamicModelSelections: number;
  fixedContextSelections: number[];
  runtime: OllamaLanguageModelRuntime;
} {
  const state = {
    dynamicModelSelections: 0,
    fixedContextSelections: [] as number[],
  };
  const runtime = createOllamaLanguageModelRuntime(config, {
    createDynamicModel: () => {
      state.dynamicModelSelections += 1;
      return buildLanguageModel();
    },
    createModel: (contextCapacityTokens) => {
      state.fixedContextSelections.push(contextCapacityTokens);
      return buildLanguageModel();
    },
    metadataCache,
    providerSafetyMarginTokens: 2_048,
    workload: "answer",
  });
  return {
    get dynamicModelSelections() {
      return state.dynamicModelSelections;
    },
    fixedContextSelections: state.fixedContextSelections,
    runtime,
  };
}

function buildLanguageModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: buildTextGeneration("ok"),
    modelId: "ollama-test-model",
  });
}

function buildTextGeneration(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ text, type: "text" }],
    finishReason: { raw: "stop", unified: "stop" },
    usage: {
      inputTokens: { cacheRead: 0, cacheWrite: 0, noCache: 1, total: 1 },
      outputTokens: { reasoning: 0, text: 1, total: 1 },
    },
    warnings: [],
  };
}

function buildOllamaFetch(
  format: "gguf" | "safetensors",
  paths: string[],
): typeof fetch {
  return vi.fn((input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    paths.push(path);
    if (path === "/api/show") {
      return Promise.resolve(Response.json({
        details: { format },
        model_info: { "test.context_length": 131_072 },
      }));
    }
    if (path === "/api/tags") {
      return Promise.resolve(Response.json({
        models: [{
          digest: MODEL_DIGEST,
          model: "gemma4:12b",
          name: "gemma4:12b",
        }, {
          digest: MODEL_DIGEST,
          model: "qwen3.5:9b-mlx",
          name: "qwen3.5:9b-mlx",
        }],
      }));
    }
    if (path === "/api/ps") {
      return Promise.resolve(Response.json({ models: [] }));
    }
    throw new Error(`Unexpected Ollama request: ${path}`);
  });
}
