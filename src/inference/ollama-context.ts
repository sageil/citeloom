import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { z } from "zod";

import type { LanguageInferenceConfig } from "../config/index.js";
import {
  createUtf8ByteUpperBoundTokenCounter,
  readLanguageModelCapabilities,
  type LanguageModelCapabilities,
} from "./model-capabilities.js";

export const OLLAMA_ADAPTIVE_CONTEXT_FLOOR_TOKENS = 65_536;

export type OllamaAdaptiveWorkload =
  | "answer"
  | "chat"
  | "query-expansion"
  | "summary";

export interface OllamaLanguageModelRuntime {
  model: LanguageModelV4;
  readCapabilities: (
    abortSignal: AbortSignal,
  ) => Promise<LanguageModelCapabilities>;
}

interface OllamaAdaptiveContextOptions {
  createModel: (contextCapacityTokens: number) => LanguageModelV4;
  providerSafetyMarginTokens: number;
  workload: OllamaAdaptiveWorkload;
}

interface OllamaModelIdentity {
  contextCapacityTokens: number;
  digest: string;
  format: string;
}

interface OllamaLoadedModel {
  contextCapacityTokens: number;
  expiresAt: string;
  sizeVram: number;
}

interface OllamaRuntimeInspection {
  identity: OllamaModelIdentity;
  loaded: OllamaLoadedModel | null;
}

interface ContextTarget {
  contextCapacityTokens: number;
  reason:
    | "answer-required"
    | "model-maximum-reasoning"
    | "model-maximum-summary"
    | "model-maximum-tools"
    | "model-maximum-unbounded-answer"
    | "model-maximum-vision"
    | "query-expansion-floor";
}

interface OllamaAdaptiveContextEvent {
  configuredContextTokens: number;
  digest: string | null;
  error: string | null;
  expiresAt: string | null;
  hardMaximumContextTokens: number | null;
  loadedContextTokens: number | null;
  model: string;
  modelFormat: string | null;
  reason: ContextTarget["reason"] | "inspection-fallback";
  requiredContextTokens: number | null;
  requestedContextTokens: number;
  runnerAction: "cold-load" | "fallback" | "grow" | "reuse";
  sizeVram: number | null;
  timestamp: string;
  workload: OllamaAdaptiveWorkload;
}

const ollamaShowResponseSchema = z.object({
  details: z.object({
    format: z.string().trim().min(1),
  }).loose(),
  model_info: z.record(z.string(), z.unknown()),
}).loose();

const ollamaTagsResponseSchema = z.object({
  models: z.array(z.object({
    digest: z.string().trim().min(1),
    model: z.string().trim().min(1),
    name: z.string().trim().min(1),
  }).loose()),
}).loose();

const ollamaPsResponseSchema = z.object({
  models: z.array(z.object({
    context_length: z.number().int().positive(),
    digest: z.string().trim().min(1),
    expires_at: z.string().trim().min(1),
    model: z.string().trim().min(1),
    name: z.string().trim().min(1),
    size_vram: z.number().nonnegative(),
  }).loose()),
}).loose();

const adaptiveAnswerRequestSchema = z.object({
  contextCapacityTokens: z.number().int().positive(),
  modelDigest: z.string().trim().min(1),
  modelFormat: z.literal("gguf"),
  inputTokenUpperBound: z.number().int().nonnegative(),
}).strict();

export function createOllamaLanguageModelRuntime(
  config: LanguageInferenceConfig,
  options: OllamaAdaptiveContextOptions,
): OllamaLanguageModelRuntime {
  const fixedModel = options.createModel(config.contextCapacityTokens);
  if (!config.adaptiveContextEnabled) {
    return {
      model: fixedModel,
      readCapabilities: (abortSignal) => {
        return readLanguageModelCapabilities(config, abortSignal);
      },
    };
  }
  const controller = new OllamaAdaptiveContextController(config, options);
  return {
    model: new AdaptiveOllamaLanguageModel(fixedModel, controller),
    readCapabilities: (abortSignal) => {
      return controller.readCapabilities(abortSignal);
    },
  };
}

class AdaptiveOllamaLanguageModel implements LanguageModelV4 {
  public readonly modelId: string;
  public readonly provider: string;
  public readonly specificationVersion = "v4" as const;
  public readonly supportedUrls: LanguageModelV4["supportedUrls"];

  public constructor(
    fixedModel: LanguageModelV4,
    private readonly controller: OllamaAdaptiveContextController,
  ) {
    this.modelId = fixedModel.modelId;
    this.provider = fixedModel.provider;
    this.supportedUrls = fixedModel.supportedUrls;
  }

  public async doGenerate(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4GenerateResult> {
    const model = await this.controller.selectModel(options);
    return await model.doGenerate(options);
  }

  public async doStream(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4StreamResult> {
    const model = await this.controller.selectModel(options);
    return await model.doStream(options);
  }
}

class OllamaAdaptiveContextController {
  public constructor(
    private readonly config: LanguageInferenceConfig,
    private readonly options: OllamaAdaptiveContextOptions,
  ) {}

  public async readCapabilities(
    abortSignal: AbortSignal,
  ): Promise<LanguageModelCapabilities> {
    try {
      const identity = await this.inspectModelIdentity(abortSignal);
      if (identity.format !== "gguf") {
        throw new Error(
          `Ollama reported model format ${identity.format} instead of GGUF.`,
        );
      }
      return {
        contextCapacityTokens: identity.contextCapacityTokens,
        modelDigest: identity.digest,
        modelFormat: "gguf",
        modelId: this.config.model,
        source: "ollama-model",
        tokenCounter: createUtf8ByteUpperBoundTokenCounter(),
      };
    } catch (error: unknown) {
      abortSignal.throwIfAborted();
      this.reportFallback(error);
      return readLanguageModelCapabilities(this.config, abortSignal);
    }
  }

  public async selectModel(
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4> {
    const request = readAdaptiveAnswerRequest(options);
    try {
      const inspection = request === null
        ? await this.inspectRuntime(options.abortSignal)
        : await this.inspectAnswerRuntime(request, options.abortSignal);
      if (inspection.identity.format !== "gguf") {
        throw new Error(
          `Ollama reported model format ${inspection.identity.format} instead of GGUF.`,
        );
      }
      const target = readContextTarget(
        options,
        this.options.workload,
        inspection.identity.contextCapacityTokens,
        this.options.providerSafetyMarginTokens,
      );
      const loaded = inspection.loaded;
      let requestedContextTokens = target.contextCapacityTokens;
      let runnerAction: OllamaAdaptiveContextEvent["runnerAction"] =
        loaded === null ? "cold-load" : "grow";
      if (
        loaded !== null
        && loaded.contextCapacityTokens >= target.contextCapacityTokens
      ) {
        requestedContextTokens = loaded.contextCapacityTokens;
        runnerAction = "reuse";
      }
      this.reportDecision(
        inspection,
        target,
        requestedContextTokens,
        runnerAction,
      );
      return this.options.createModel(requestedContextTokens);
    } catch (error: unknown) {
      options.abortSignal?.throwIfAborted();
      const fallbackContextTokens = request?.contextCapacityTokens
        ?? this.config.contextCapacityTokens;
      this.reportFallback(error, fallbackContextTokens);
      return this.options.createModel(fallbackContextTokens);
    }
  }

  private async inspectModelIdentity(
    abortSignal: AbortSignal | undefined,
  ): Promise<OllamaModelIdentity> {
    const signal = createInspectionSignal(this.config.timeoutMs, abortSignal);
    const showRequest = requestOllamaJson(
      this.config,
      "/api/show",
      {
        body: JSON.stringify({ model: this.config.model }),
        method: "POST",
      },
      signal,
    );
    const tagsRequest = requestOllamaJson(
      this.config,
      "/api/tags",
      { method: "GET" },
      signal,
    );
    const [showValue, tagsValue] = await Promise.all([
      showRequest,
      tagsRequest,
    ]);
    const show = decodeOllamaShowResponse(showValue);
    const digest = decodeConfiguredModelDigest(tagsValue, this.config.model);
    return {
      contextCapacityTokens: show.contextCapacityTokens,
      digest,
      format: show.format,
    };
  }

  private async inspectRuntime(
    abortSignal: AbortSignal | undefined,
  ): Promise<OllamaRuntimeInspection> {
    const signal = createInspectionSignal(this.config.timeoutMs, abortSignal);
    const identityRequest = this.inspectModelIdentity(signal);
    const loadedRequest = requestOllamaJson(
      this.config,
      "/api/ps",
      { method: "GET" },
      signal,
    );
    const [identity, loadedValue] = await Promise.all([
      identityRequest,
      loadedRequest,
    ]);
    return {
      identity,
      loaded: decodeLoadedModel(
        loadedValue,
        this.config.model,
        identity.digest,
      ),
    };
  }

  private async inspectAnswerRuntime(
    request: z.infer<typeof adaptiveAnswerRequestSchema>,
    abortSignal: AbortSignal | undefined,
  ): Promise<OllamaRuntimeInspection> {
    const signal = createInspectionSignal(this.config.timeoutMs, abortSignal);
    const loadedValue = await requestOllamaJson(
      this.config,
      "/api/ps",
      { method: "GET" },
      signal,
    );
    return {
      identity: {
        contextCapacityTokens: request.contextCapacityTokens,
        digest: request.modelDigest,
        format: request.modelFormat,
      },
      loaded: decodeLoadedModel(
        loadedValue,
        this.config.model,
        request.modelDigest,
      ),
    };
  }

  private reportDecision(
    inspection: OllamaRuntimeInspection,
    target: ContextTarget,
    requestedContextTokens: number,
    runnerAction: OllamaAdaptiveContextEvent["runnerAction"],
  ): void {
    const loaded = inspection.loaded;
    const event: OllamaAdaptiveContextEvent = {
      configuredContextTokens: this.config.contextCapacityTokens,
      digest: inspection.identity.digest,
      error: null,
      expiresAt: loaded?.expiresAt ?? null,
      hardMaximumContextTokens:
        inspection.identity.contextCapacityTokens,
      loadedContextTokens: loaded?.contextCapacityTokens ?? null,
      model: this.config.model,
      modelFormat: inspection.identity.format,
      reason: target.reason,
      requiredContextTokens: target.contextCapacityTokens,
      requestedContextTokens,
      runnerAction,
      sizeVram: loaded?.sizeVram ?? null,
      timestamp: new Date().toISOString(),
      workload: this.options.workload,
    };
    reportAdaptiveContextEvent(event);
  }

  private reportFallback(
    error: unknown,
    requestedContextTokens = this.config.contextCapacityTokens,
  ): void {
    const event: OllamaAdaptiveContextEvent = {
      configuredContextTokens: this.config.contextCapacityTokens,
      digest: null,
      error: readErrorMessage(error),
      expiresAt: null,
      hardMaximumContextTokens: null,
      loadedContextTokens: null,
      model: this.config.model,
      modelFormat: null,
      reason: "inspection-fallback",
      requiredContextTokens: null,
      requestedContextTokens,
      runnerAction: "fallback",
      sizeVram: null,
      timestamp: new Date().toISOString(),
      workload: this.options.workload,
    };
    reportAdaptiveContextEvent(event);
  }
}

function readContextTarget(
  options: LanguageModelV4CallOptions,
  workload: OllamaAdaptiveWorkload,
  hardMaximumContextTokens: number,
  providerSafetyMarginTokens: number,
): ContextTarget {
  if (workload === "summary") {
    return {
      contextCapacityTokens: hardMaximumContextTokens,
      reason: "model-maximum-summary",
    };
  }
  if (containsFileContent(options)) {
    return {
      contextCapacityTokens: hardMaximumContextTokens,
      reason: "model-maximum-vision",
    };
  }
  if (options.tools !== undefined && options.tools.length > 0) {
    return {
      contextCapacityTokens: hardMaximumContextTokens,
      reason: "model-maximum-tools",
    };
  }
  if (options.reasoning !== "none") {
    return {
      contextCapacityTokens: hardMaximumContextTokens,
      reason: "model-maximum-reasoning",
    };
  }
  const floor = Math.min(
    OLLAMA_ADAPTIVE_CONTEXT_FLOOR_TOKENS,
    hardMaximumContextTokens,
  );
  if (workload === "query-expansion") {
    return {
      contextCapacityTokens: floor,
      reason: "query-expansion-floor",
    };
  }
  if (options.maxOutputTokens === undefined) {
    return {
      contextCapacityTokens: hardMaximumContextTokens,
      reason: "model-maximum-unbounded-answer",
    };
  }
  const request = readAdaptiveAnswerRequest(options);
  let inputTokenUpperBound = countInputTokenUpperBound(options);
  if (
    request !== null
    && request.inputTokenUpperBound > inputTokenUpperBound
  ) {
    inputTokenUpperBound = request.inputTokenUpperBound;
  }
  const requiredContextTokens = inputTokenUpperBound
    + options.maxOutputTokens
    + providerSafetyMarginTokens;
  return {
    contextCapacityTokens: Math.min(
      hardMaximumContextTokens,
      Math.max(floor, requiredContextTokens),
    ),
    reason: "answer-required",
  };
}

function readAdaptiveAnswerRequest(
  options: LanguageModelV4CallOptions,
): z.infer<typeof adaptiveAnswerRequestSchema> | null {
  const value = options.providerOptions?.citeloomAdaptiveContext;
  const result = adaptiveAnswerRequestSchema.safeParse(value);
  return result.success ? result.data : null;
}

function countInputTokenUpperBound(
  options: LanguageModelV4CallOptions,
): number {
  const input = {
    prompt: options.prompt,
    responseFormat: options.responseFormat ?? null,
    toolChoice: options.toolChoice ?? null,
  };
  const serialized = JSON.stringify(input);
  return new TextEncoder().encode(serialized).byteLength;
}

function containsFileContent(options: LanguageModelV4CallOptions): boolean {
  for (const message of options.prompt) {
    if (message.role === "system") {
      continue;
    }
    for (const part of message.content) {
      if (part.type === "file" || part.type === "reasoning-file") {
        return true;
      }
      if (part.type !== "tool-result" || part.output.type !== "content") {
        continue;
      }
      for (const content of part.output.value) {
        if (content.type === "file") {
          return true;
        }
      }
    }
  }
  return false;
}

function decodeOllamaShowResponse(value: unknown): {
  contextCapacityTokens: number;
  format: string;
} {
  const response = ollamaShowResponseSchema.parse(value);
  let contextCapacityTokens: number | null = null;
  for (const [key, candidate] of Object.entries(response.model_info)) {
    if (
      !key.endsWith(".context_length")
      || typeof candidate !== "number"
      || !Number.isInteger(candidate)
      || candidate < 1
    ) {
      continue;
    }
    if (
      contextCapacityTokens === null
      || candidate > contextCapacityTokens
    ) {
      contextCapacityTokens = candidate;
    }
  }
  if (contextCapacityTokens === null) {
    throw new Error("Ollama did not report a positive model context length.");
  }
  return {
    contextCapacityTokens,
    format: response.details.format.toLowerCase(),
  };
}

function decodeConfiguredModelDigest(
  value: unknown,
  configuredModel: string,
): string {
  const response = ollamaTagsResponseSchema.parse(value);
  const digests = new Set<string>();
  for (const model of response.models) {
    if (model.name === configuredModel || model.model === configuredModel) {
      digests.add(model.digest);
    }
  }
  if (digests.size !== 1) {
    throw new Error(
      `Ollama reported ${digests.size} digests for configured model ${configuredModel}.`,
    );
  }
  const digest = digests.values().next().value;
  if (digest === undefined) {
    throw new Error(
      `Ollama did not report a digest for configured model ${configuredModel}.`,
    );
  }
  return digest;
}

function decodeLoadedModel(
  value: unknown,
  configuredModel: string,
  configuredDigest: string,
): OllamaLoadedModel | null {
  const response = ollamaPsResponseSchema.parse(value);
  let loaded: OllamaLoadedModel | null = null;
  for (const model of response.models) {
    const nameMatches = model.name === configuredModel
      || model.model === configuredModel;
    if (!nameMatches || model.digest !== configuredDigest) {
      continue;
    }
    if (
      loaded !== null
      && loaded.contextCapacityTokens >= model.context_length
    ) {
      continue;
    }
    loaded = {
      contextCapacityTokens: model.context_length,
      expiresAt: model.expires_at,
      sizeVram: model.size_vram,
    };
  }
  return loaded;
}

async function requestOllamaJson(
  config: LanguageInferenceConfig,
  path: "/api/ps" | "/api/show" | "/api/tags",
  request: {
    body?: string;
    method: "GET" | "POST";
  },
  signal: AbortSignal,
): Promise<unknown> {
  const headers = buildOllamaHeaders(config.apiToken, request.body !== undefined);
  const init: RequestInit = {
    headers,
    method: request.method,
    signal,
  };
  if (request.body !== undefined) {
    init.body = request.body;
  }
  const response = await fetch(`${config.baseUrl}${path}`, init);
  if (!response.ok) {
    throw new Error(
      `Ollama ${path} returned HTTP ${response.status}.`,
    );
  }
  const value: unknown = await response.json();
  return value;
}

function buildOllamaHeaders(
  apiToken: string | null,
  hasBody: boolean,
): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (hasBody) {
    headers.set("content-type", "application/json");
  }
  if (apiToken !== null) {
    headers.set("authorization", `Bearer ${apiToken}`);
  }
  return headers;
}

function createInspectionSignal(
  timeoutMs: number,
  abortSignal: AbortSignal | undefined,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (abortSignal === undefined) {
    return timeoutSignal;
  }
  return AbortSignal.any([abortSignal, timeoutSignal]);
}

function reportAdaptiveContextEvent(
  event: OllamaAdaptiveContextEvent,
): void {
  console.log(JSON.stringify({ level: "info", ollamaAdaptiveContext: event }));
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
