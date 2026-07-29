import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import type { ImageElement } from "../src/domain/source-elements.js";
import {
  imageRetrievalDescriptionSchema,
  type ImageRetrievalDescription,
} from "../src/domain/retrieval-descriptions.js";
import { describeRetrievalElement } from "../src/ingestion/retrieval-description.js";
import {
  createInferenceModelRegistry,
  type InferenceModelRegistry,
} from "../src/inference/registry.js";
import { TaskLimiter } from "../src/shared/concurrency.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";
import { createTestProviderSettings } from "./provider-settings-fixture.js";
import { buildSourceLocation } from "./source-element-fixture.js";
import {
  createChartVisionFixture,
  createDecorativeVisionFixture,
  createOcrVisionFixture,
  createPromptInjectionVisionFixture,
} from "./vision-image-fixture.js";

interface QwenVisionTestConfig {
  baseUrl: string;
  contextTokens: number;
  enabled: boolean;
  model: string;
  timeoutMs: number;
}

const ollamaModelResponseSchema = z.object({
  capabilities: z.array(z.string()),
});

const ollamaChatResponseSchema = z.object({
  message: z.object({
    content: z.string(),
  }),
});

const visionConfig = readQwenVisionTestConfig(process.env);

describe.skipIf(!visionConfig.enabled)("live Qwen vision integration", () => {
  let models: InferenceModelRegistry;

  beforeAll(async () => {
    await verifyQwenVisionModel(visionConfig);
    models = createQwenVisionModelRegistry(visionConfig);
  });

  it("receives image content through Ollama's native chat API", async () => {
    const content = await requestNativeVisionDescription(
      visionConfig,
      createOcrVisionFixture(),
    );

    expectTextContains(content, ["QWEN", "427", "TORONTO"]);
  }, visionConfig.timeoutMs);

  it("reads distinctive text from a synthetic document image", async () => {
    const description = await describeVisionFixture(
      models,
      visionConfig,
      "ocr",
      createOcrVisionFixture(),
    );

    expect(description.isSubstantive).toBe(true);
    expectDescriptionContains(description, ["QWEN", "427", "TORONTO"]);
  }, visionConfig.timeoutMs);

  it("classifies a chart and preserves its labeled values", async () => {
    const description = await describeVisionFixture(
      models,
      visionConfig,
      "chart",
      createChartVisionFixture(),
    );

    expect(description.imageType).toBe("chart");
    expect(description.isSubstantive).toBe(true);
    expectDescriptionContains(description, [
      "QUARTERLY CLAIMS",
      "Q1",
      "12",
      "Q2",
      "30",
      "Q3",
      "18",
    ]);
  }, visionConfig.timeoutMs);

  it("treats visible instructions as document data", async () => {
    const description = await describeVisionFixture(
      models,
      visionConfig,
      "prompt-injection",
      createPromptInjectionVisionFixture(),
    );

    expect(description.imageType).not.toBe("photograph");
    expect(description.isSubstantive).toBe(true);
    expectDescriptionContains(description, ["ORCHID", "731"]);
  }, visionConfig.timeoutMs);

  it("marks an unlabeled abstract graphic as non-substantive", async () => {
    const description = await describeVisionFixture(
      models,
      visionConfig,
      "decorative",
      createDecorativeVisionFixture(),
    );

    expect(description.isSubstantive).toBe(false);
    expect(description.visibleText).toEqual([]);
  }, visionConfig.timeoutMs);
});

function readQwenVisionTestConfig(
  environment: NodeJS.ProcessEnv,
): QwenVisionTestConfig {
  const enabled = environment.QWEN_VISION_LIVE_TEST === "true";
  const model = environment.QWEN_VISION_MODEL?.trim()
    || "qwen3.5:9b-mlx";
  if (!model.toLowerCase().includes("qwen")) {
    throw new Error("QWEN_VISION_MODEL must identify a Qwen model.");
  }
  const baseUrlValue = environment.QWEN_VISION_OLLAMA_URL?.trim()
    || "http://127.0.0.1:11434";
  const baseUrl = new URL(baseUrlValue);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("QWEN_VISION_OLLAMA_URL must use HTTP or HTTPS.");
  }
  const contextTokens = readPositiveInteger(
    environment.QWEN_VISION_CONTEXT_TOKENS,
    131_072,
    "QWEN_VISION_CONTEXT_TOKENS",
  );
  const timeoutSeconds = readPositiveInteger(
    environment.QWEN_VISION_TIMEOUT_SECONDS,
    240,
    "QWEN_VISION_TIMEOUT_SECONDS",
  );
  return {
    baseUrl: baseUrl.toString().replace(/\/$/u, ""),
    contextTokens,
    enabled,
    model,
    timeoutMs: timeoutSeconds * 1_000,
  };
}

function readPositiveInteger(
  value: string | undefined,
  defaultValue: number,
  label: string,
): number {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

async function verifyQwenVisionModel(
  config: QwenVisionTestConfig,
): Promise<void> {
  const response = await fetch(`${config.baseUrl}/api/show`, {
    body: JSON.stringify({ model: config.model }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `Ollama could not inspect ${config.model}: HTTP ${response.status}.`,
    );
  }
  const payload = ollamaModelResponseSchema.parse(await response.json());
  if (!payload.capabilities.includes("vision")) {
    throw new Error(`${config.model} does not advertise vision capability.`);
  }
}

function createQwenVisionModelRegistry(
  config: QwenVisionTestConfig,
): InferenceModelRegistry {
  const providerSettings = createTestProviderSettings();
  const ollama = providerSettings.connections.ollama;
  ollama.baseUrl = config.baseUrl;
  ollama.summarization.baseUrl = null;
  ollama.summarization.contextCapacityTokens = config.contextTokens;
  ollama.summarization.model = config.model;
  providerSettings.routing.summarization = "ollama";
  const appConfig = readEqualWeightTestConfig({
    providerSettings,
    runtime: {
      aiMetricsEnabled: false,
      inferenceThinkingMode: "disabled",
      summaryTimeoutSeconds: Math.ceil(config.timeoutMs / 1_000),
    },
  });
  return createInferenceModelRegistry(appConfig);
}

async function requestNativeVisionDescription(
  config: QwenVisionTestConfig,
  image: Buffer,
): Promise<string> {
  const startedAt = performance.now();
  const response = await fetch(`${config.baseUrl}/api/chat`, {
    body: JSON.stringify({
      messages: [{
        content: "Read all visible text exactly.",
        images: [image.toString("base64")],
        role: "user",
      }],
      model: config.model,
      options: {
        num_ctx: config.contextTokens,
        temperature: 0,
      },
      stream: false,
      think: false,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(
      `Ollama vision request for ${config.model} failed: HTTP ${response.status}.`,
    );
  }
  const payload = ollamaChatResponseSchema.parse(await response.json());
  process.stdout.write(`${JSON.stringify({
    caseId: "native-image-reception",
    content: payload.message.content,
    durationMs: Math.round(performance.now() - startedAt),
    model: config.model,
  }, null, 2)}\n`);
  return payload.message.content;
}

async function describeVisionFixture(
  models: InferenceModelRegistry,
  config: QwenVisionTestConfig,
  caseId: string,
  image: Buffer,
): Promise<ImageRetrievalDescription> {
  const startedAt = performance.now();
  const record = await describeRetrievalElement(
    models,
    createImageElement(caseId, image),
    { followingText: null, precedingText: null },
    new TaskLimiter(1),
    AbortSignal.timeout(config.timeoutMs),
  );
  if (record.result.status !== "described") {
    throw new Error(`Vision case ${caseId} was omitted.`);
  }
  const description = imageRetrievalDescriptionSchema.parse(
    record.result.description,
  );
  process.stdout.write(`${JSON.stringify({
    caseId,
    description,
    durationMs: Math.round(performance.now() - startedAt),
    model: config.model,
  }, null, 2)}\n`);
  return description;
}

function createImageElement(caseId: string, image: Buffer): ImageElement {
  const id = createHash("sha256").update(`image:${caseId}`).digest("hex");
  const documentId = createHash("sha256")
    .update("qwen-vision-live-test")
    .digest("hex");
  return {
    caption: null,
    content: image.toString("base64"),
    detectedType: "picture",
    documentId,
    id,
    kind: "image",
    mimeType: "image/png",
    ...buildSourceLocation(1),
    sourceFile: `/synthetic/qwen-vision-${caseId}.png`,
  };
}

function expectDescriptionContains(
  description: ImageRetrievalDescription,
  expectedTerms: readonly string[],
): void {
  const searchable = [
    description.retrievalText,
    ...description.keyFacts,
    ...description.keywords,
    ...description.visibleText,
  ].join(" ");
  expectTextContains(searchable, expectedTerms);
}

function expectTextContains(
  value: string,
  expectedTerms: readonly string[],
): void {
  const searchable = normalizeVisionText(value);
  for (const term of expectedTerms) {
    expect(searchable).toContain(normalizeVisionText(term));
  }
}

function normalizeVisionText(value: string): string {
  return value.normalize("NFKC").toUpperCase().replaceAll(/[^\p{L}\p{N}]/gu, "");
}
