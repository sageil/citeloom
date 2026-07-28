import { createOpenAI } from "@ai-sdk/openai";
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4ResponseMetadata,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4Headers,
  SharedV4ProviderMetadata,
  SharedV4Warning,
} from "@ai-sdk/provider";

import type { LanguageInferenceConfig } from "../config/index.js";
import type { CiteLoomDatabase } from "../database/client.js";
import { createOpenAICodexFetch } from "./openai-codex-fetch.js";
import { OPENAI_CODEX_BACKEND_BASE_URL } from "./openai-codex-oauth.js";

interface StreamingTextBlock {
  id: string;
  providerMetadata?: SharedV4ProviderMetadata;
  text: string;
  type: "reasoning" | "text";
}

type GeneratedContentSlot =
  | { block: StreamingTextBlock; type: "streaming" }
  | { content: LanguageModelV4Content; type: "complete" };

interface CollectedStream {
  content: LanguageModelV4Content[];
  finishReason: LanguageModelV4FinishReason;
  providerMetadata?: SharedV4ProviderMetadata;
  responseMetadata: LanguageModelV4ResponseMetadata;
  usage: LanguageModelV4Usage;
  warnings: SharedV4Warning[];
}

type CompleteStreamContent = Extract<
  LanguageModelV4StreamPart,
  {
    type:
      | "custom"
      | "file"
      | "reasoning-file"
      | "source"
      | "tool-approval-request"
      | "tool-call"
      | "tool-result";
  }
>;

export function createOpenAICodexLanguageModel(
  config: LanguageInferenceConfig,
  database: CiteLoomDatabase,
): LanguageModelV4 {
  if (config.baseUrl !== OPENAI_CODEX_BACKEND_BASE_URL) {
    throw new Error(
      "OpenAI Codex device credentials can only use the fixed ChatGPT Codex endpoint.",
    );
  }
  const provider = createOpenAI({
    apiKey: "device-authorization",
    baseURL: config.baseUrl,
    fetch: createOpenAICodexFetch(database),
    name: "openai-codex",
  });
  const streamingModel = provider.responses(config.model);
  return {
    specificationVersion: "v4",
    provider: streamingModel.provider,
    modelId: streamingModel.modelId,
    supportedUrls: streamingModel.supportedUrls,
    doGenerate: async (options) => generateFromStream(streamingModel, options),
    doStream: async (options) => streamingModel.doStream(options),
  };
}

async function generateFromStream(
  model: LanguageModelV4,
  options: LanguageModelV4CallOptions,
): Promise<LanguageModelV4GenerateResult> {
  const streamed = await model.doStream(options);
  const collected = await collectStream(streamed.stream);
  const result: LanguageModelV4GenerateResult = {
    content: collected.content,
    finishReason: collected.finishReason,
    usage: collected.usage,
    warnings: collected.warnings,
  };
  if (collected.providerMetadata !== undefined) {
    result.providerMetadata = collected.providerMetadata;
  }
  if (streamed.request !== undefined) {
    result.request = streamed.request;
  }
  result.response = buildGenerateResponse(
    collected.responseMetadata,
    streamed.response?.headers,
  );
  return result;
}

async function collectStream(
  stream: ReadableStream<LanguageModelV4StreamPart>,
): Promise<CollectedStream> {
  const slots: GeneratedContentSlot[] = [];
  const blocks = new Map<string, StreamingTextBlock>();
  let finishReason: LanguageModelV4FinishReason | null = null;
  let providerMetadata: SharedV4ProviderMetadata | undefined;
  let responseMetadata: LanguageModelV4ResponseMetadata = {};
  let usage: LanguageModelV4Usage | null = null;
  let warnings: SharedV4Warning[] = [];

  for await (const part of stream) {
    if (part.type === "stream-start") {
      warnings = part.warnings;
      continue;
    }
    if (part.type === "response-metadata") {
      responseMetadata = readResponseMetadata(part);
      continue;
    }
    if (part.type === "text-start" || part.type === "reasoning-start") {
      const block = createStreamingBlock(part);
      blocks.set(part.id, block);
      slots.push({ block, type: "streaming" });
      continue;
    }
    if (part.type === "text-delta" || part.type === "reasoning-delta") {
      appendStreamingDelta(blocks, part);
      continue;
    }
    if (part.type === "text-end" || part.type === "reasoning-end") {
      finishStreamingBlock(blocks, part);
      continue;
    }
    if (isCompleteContent(part)) {
      slots.push({ content: part, type: "complete" });
      continue;
    }
    if (part.type === "finish") {
      finishReason = part.finishReason;
      providerMetadata = part.providerMetadata;
      usage = part.usage;
      continue;
    }
    if (part.type === "error") {
      throw readStreamError(part.error);
    }
  }

  if (finishReason === null || usage === null) {
    throw new Error("OpenAI Codex ended its response before completion metadata.");
  }
  const collected: CollectedStream = {
    content: buildGeneratedContent(slots),
    finishReason,
    responseMetadata,
    usage,
    warnings,
  };
  if (providerMetadata !== undefined) {
    collected.providerMetadata = providerMetadata;
  }
  return collected;
}

function createStreamingBlock(
  part: Extract<
    LanguageModelV4StreamPart,
    { type: "reasoning-start" | "text-start" }
  >,
): StreamingTextBlock {
  const block: StreamingTextBlock = {
    id: part.id,
    text: "",
    type: part.type === "text-start" ? "text" : "reasoning",
  };
  if (part.providerMetadata !== undefined) {
    block.providerMetadata = part.providerMetadata;
  }
  return block;
}

function appendStreamingDelta(
  blocks: Map<string, StreamingTextBlock>,
  part: Extract<
    LanguageModelV4StreamPart,
    { type: "reasoning-delta" | "text-delta" }
  >,
): void {
  const block = blocks.get(part.id);
  if (block === undefined) {
    throw new Error(`OpenAI Codex sent a delta for unknown block ${part.id}.`);
  }
  block.text += part.delta;
  if (part.providerMetadata !== undefined) {
    block.providerMetadata = part.providerMetadata;
  }
}

function finishStreamingBlock(
  blocks: Map<string, StreamingTextBlock>,
  part: Extract<
    LanguageModelV4StreamPart,
    { type: "reasoning-end" | "text-end" }
  >,
): void {
  const block = blocks.get(part.id);
  if (block === undefined) {
    throw new Error(`OpenAI Codex ended unknown block ${part.id}.`);
  }
  if (part.providerMetadata !== undefined) {
    block.providerMetadata = part.providerMetadata;
  }
}

function isCompleteContent(
  part: LanguageModelV4StreamPart,
): part is CompleteStreamContent {
  return part.type === "custom"
    || part.type === "file"
    || part.type === "reasoning-file"
    || part.type === "source"
    || part.type === "tool-approval-request"
    || part.type === "tool-call"
    || part.type === "tool-result";
}

function buildGeneratedContent(
  slots: readonly GeneratedContentSlot[],
): LanguageModelV4Content[] {
  const content: LanguageModelV4Content[] = [];
  for (const slot of slots) {
    if (slot.type === "complete") {
      content.push(slot.content);
      continue;
    }
    const generated: LanguageModelV4Content = slot.block.type === "text"
      ? { text: slot.block.text, type: "text" }
      : { text: slot.block.text, type: "reasoning" };
    if (slot.block.providerMetadata !== undefined) {
      generated.providerMetadata = slot.block.providerMetadata;
    }
    content.push(generated);
  }
  return content;
}

function readResponseMetadata(
  part: Extract<LanguageModelV4StreamPart, { type: "response-metadata" }>,
): LanguageModelV4ResponseMetadata {
  const metadata: LanguageModelV4ResponseMetadata = {};
  if (part.id !== undefined) {
    metadata.id = part.id;
  }
  if (part.modelId !== undefined) {
    metadata.modelId = part.modelId;
  }
  if (part.timestamp !== undefined) {
    metadata.timestamp = part.timestamp;
  }
  return metadata;
}

function buildGenerateResponse(
  metadata: LanguageModelV4ResponseMetadata,
  headers: SharedV4Headers | undefined,
): LanguageModelV4ResponseMetadata & { headers?: SharedV4Headers } {
  const response: LanguageModelV4ResponseMetadata & {
    headers?: SharedV4Headers;
  } = { ...metadata };
  if (headers !== undefined) {
    response.headers = headers;
  }
  return response;
}

function readStreamError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error("OpenAI Codex returned an invalid streaming response.");
}
