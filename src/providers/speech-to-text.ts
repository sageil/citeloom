import { z } from "zod";

import type { AppConfig, SpeechToTextConfig } from "../config/index.js";

const MAX_PROVIDER_ERROR_BYTES = 16 * 1_024;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1_024;
const UNCLEAR_RECORDING_MESSAGE =
  "The recording did not contain enough clear speech. Try recording again.";
const transcriptionResponseSchema = z.object({
  text: z.string().trim().min(1).max(8_000),
}).loose();
const transcriptionProbeResponseSchema = z.object({
  text: z.string().max(8_000),
}).loose();

export type TranscriptionMediaType =
  | "audio/mp4"
  | "audio/ogg"
  | "audio/wav"
  | "audio/webm";

export interface TranscriptionAudio {
  content: Buffer;
  filename: string;
  mediaType: TranscriptionMediaType;
}

export interface TranscriptionResult {
  text: string;
}

export class SpeechToTextUnavailableError extends Error {
  public constructor() {
    super("Speech-to-text is disabled.");
    this.name = "SpeechToTextUnavailableError";
  }
}

export class SpeechToTextProviderError extends Error {
  public constructor(message = "The transcription provider could not complete the request.") {
    super(message);
    this.name = "SpeechToTextProviderError";
  }
}

export class SpeechToTextTimeoutError extends Error {
  public constructor() {
    super("The transcription provider timed out.");
    this.name = "SpeechToTextTimeoutError";
  }
}

export async function transcribeAudio(
  appConfig: AppConfig,
  audio: TranscriptionAudio,
  abortSignal: AbortSignal,
): Promise<TranscriptionResult> {
  const config = appConfig.speechToText;
  if (config === null) {
    throw new SpeechToTextUnavailableError();
  }
  return requestTranscription(config, audio, abortSignal);
}

async function requestTranscription(
  config: SpeechToTextConfig,
  audio: TranscriptionAudio,
  abortSignal: AbortSignal,
): Promise<TranscriptionResult> {
  const adapter = readTranscriptionAdapter(config);
  const providerResponse = await requestProviderTranscription(
    config,
    audio,
    abortSignal,
    adapter,
  );

  try {
    return await decodeProviderResponse(
      providerResponse.response,
      adapter.rejectPromptEcho ? config.prompt : null,
    );
  } catch (error: unknown) {
    if (error instanceof SpeechToTextProviderError) {
      throw error;
    }
    throwRequestFailure(error, abortSignal, providerResponse.timeoutSignal);
  }
}

export async function probeSpeechToTextProvider(
  config: SpeechToTextConfig,
  abortSignal: AbortSignal,
): Promise<void> {
  const adapter = readTranscriptionAdapter(config);
  const providerResponse = await requestProviderTranscription(
    config,
    buildSilentProbeAudio(),
    abortSignal,
    adapter,
  );
  try {
    const value = await readProviderResponseValue(providerResponse.response);
    const result = transcriptionProbeResponseSchema.safeParse(value);
    if (!result.success) {
      throw new SpeechToTextProviderError();
    }
  } catch (error: unknown) {
    throwRequestFailure(error, abortSignal, providerResponse.timeoutSignal);
  }
}

interface ProviderTranscriptionResponse {
  response: Response;
  timeoutSignal: AbortSignal;
}

interface ProviderTranscriptionRequest {
  body: FormData | string;
  headers: Headers;
}

interface OpenRouterTranscriptionRequest {
  input_audio: {
    data: string;
    format: "m4a" | "ogg" | "wav" | "webm";
  };
  language?: string;
  model: string;
}

async function requestProviderTranscription(
  config: SpeechToTextConfig,
  audio: TranscriptionAudio,
  abortSignal: AbortSignal,
  adapter: TranscriptionAdapterContract,
): Promise<ProviderTranscriptionResponse> {
  const request = buildProviderTranscriptionRequest(config, audio, adapter);
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  const requestSignal = AbortSignal.any([abortSignal, timeoutSignal]);
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${adapter.path}`, {
      body: request.body,
      headers: request.headers,
      method: "POST",
      signal: requestSignal,
    });
  } catch (error: unknown) {
    throwRequestFailure(error, abortSignal, timeoutSignal);
  }

  if (!response.ok) {
    try {
      await consumeBoundedProviderError(response);
    } catch (error: unknown) {
      throwRequestFailure(error, abortSignal, timeoutSignal);
    }
    throw new SpeechToTextProviderError();
  }
  return { response, timeoutSignal };
}

interface TranscriptionAdapterContract {
  languageFormat: "configured" | "iso-639";
  path: "/audio/transcriptions";
  promptFormat: "context-bias" | "prompt";
  rejectPromptEcho: boolean;
  requestFormat: "multipart" | "openrouter-json";
}

function readTranscriptionAdapter(
  config: SpeechToTextConfig,
): TranscriptionAdapterContract {
  switch (config.adapter) {
    case "mistral-transcription":
      return {
        languageFormat: "iso-639",
        path: "/audio/transcriptions",
        promptFormat: "context-bias",
        rejectPromptEcho: false,
        requestFormat: "multipart",
      };
    case "omlx-transcription":
      return {
        languageFormat: "configured",
        path: "/audio/transcriptions",
        promptFormat: "prompt",
        rejectPromptEcho: true,
        requestFormat: "multipart",
      };
    case "openrouter-transcription":
      return {
        languageFormat: "iso-639",
        path: "/audio/transcriptions",
        promptFormat: "prompt",
        rejectPromptEcho: false,
        requestFormat: "openrouter-json",
      };
    case "openai-transcription":
      return {
        languageFormat: "configured",
        path: "/audio/transcriptions",
        promptFormat: "prompt",
        rejectPromptEcho: false,
        requestFormat: "multipart",
      };
  }
}

function buildProviderTranscriptionRequest(
  config: SpeechToTextConfig,
  audio: TranscriptionAudio,
  adapter: TranscriptionAdapterContract,
): ProviderTranscriptionRequest {
  if (adapter.requestFormat === "openrouter-json") {
    return {
      body: JSON.stringify(buildOpenRouterTranscriptionRequest(config, audio)),
      headers: buildProviderHeaders(config, "application/json"),
    };
  }
  return {
    body: buildProviderForm(config, audio, adapter),
    headers: buildProviderHeaders(config, null),
  };
}

function buildOpenRouterTranscriptionRequest(
  config: SpeechToTextConfig,
  audio: TranscriptionAudio,
): OpenRouterTranscriptionRequest {
  const request: OpenRouterTranscriptionRequest = {
    input_audio: {
      data: audio.content.toString("base64"),
      format: readOpenRouterAudioFormat(audio.mediaType),
    },
    model: config.model,
  };
  const language = normalizeIso639Language(config.language);
  if (language !== null) {
    request.language = language;
  }
  return request;
}

function normalizeIso639Language(language: string | null): string | null {
  if (language === null) {
    return null;
  }
  const normalizedLanguage = language.trim().toLowerCase();
  if (/^[a-z]{2}$/.test(normalizedLanguage)) {
    return normalizedLanguage;
  }
  if (normalizedLanguage === "english") {
    return "en";
  }
  return null;
}

function readOpenRouterAudioFormat(
  mediaType: TranscriptionMediaType,
): OpenRouterTranscriptionRequest["input_audio"]["format"] {
  if (mediaType === "audio/mp4") {
    return "m4a";
  }
  if (mediaType === "audio/ogg") {
    return "ogg";
  }
  if (mediaType === "audio/wav") {
    return "wav";
  }
  return "webm";
}

function buildProviderForm(
  config: SpeechToTextConfig,
  audio: TranscriptionAudio,
  adapter: TranscriptionAdapterContract,
): FormData {
  const form = new FormData();
  const content = new Uint8Array(audio.content);
  form.append("file", new Blob([content], { type: audio.mediaType }), audio.filename);
  form.append("model", config.model);
  appendProviderLanguage(form, config.language, adapter);
  appendProviderPrompt(form, config.prompt, adapter);
  return form;
}

function appendProviderLanguage(
  form: FormData,
  language: string | null,
  adapter: TranscriptionAdapterContract,
): void {
  if (language === null) {
    return;
  }
  if (adapter.languageFormat === "iso-639") {
    const normalizedLanguage = normalizeIso639Language(language);
    if (normalizedLanguage !== null) {
      form.append("language", normalizedLanguage);
    }
    return;
  }
  form.append("language", language);
}

function appendProviderPrompt(
  form: FormData,
  prompt: string | null,
  adapter: TranscriptionAdapterContract,
): void {
  if (prompt === null) {
    return;
  }
  if (adapter.promptFormat === "prompt") {
    form.append("prompt", prompt);
    return;
  }
  for (const contextBias of readMistralContextBias(prompt)) {
    form.append("context_bias", contextBias);
  }
}

function readMistralContextBias(prompt: string): string[] {
  const contextBias: string[] = [];
  const entries = prompt.split(/[\n,;]+/u);
  for (const entry of entries) {
    const normalizedEntry = entry.trim().replace(/\s+/gu, "_");
    if (normalizedEntry === "") {
      continue;
    }
    contextBias.push(normalizedEntry);
    if (contextBias.length === 100) {
      break;
    }
  }
  return contextBias;
}

function buildProviderHeaders(
  config: SpeechToTextConfig,
  contentType: "application/json" | null,
): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (contentType !== null) {
    headers.set("content-type", contentType);
  }
  if (config.apiToken !== null) {
    headers.set("authorization", `Bearer ${config.apiToken}`);
  }
  return headers;
}

async function decodeProviderResponse(
  response: Response,
  configuredPrompt: string | null,
): Promise<TranscriptionResult> {
  const value = await readProviderResponseValue(response);
  const result = transcriptionResponseSchema.safeParse(value);
  if (!result.success) {
    throw new SpeechToTextProviderError();
  }
  if (configuredPrompt !== null && result.data.text === configuredPrompt) {
    throw new SpeechToTextProviderError(UNCLEAR_RECORDING_MESSAGE);
  }
  return { text: result.data.text };
}

async function readProviderResponseValue(response: Response): Promise<unknown> {
  const mediaType = readResponseMediaType(response);
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new SpeechToTextProviderError();
  }
  const bytes = await readBoundedResponseBytes(
    response,
    MAX_PROVIDER_RESPONSE_BYTES,
  );
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SpeechToTextProviderError();
  }
}

function buildSilentProbeAudio(): TranscriptionAudio {
  const sampleRate = 16_000;
  const sampleCount = sampleRate;
  const bytesPerSample = 2;
  const dataBytes = sampleCount * bytesPerSample;
  const content = Buffer.alloc(44 + dataBytes);
  content.write("RIFF", 0, "ascii");
  content.writeUInt32LE(36 + dataBytes, 4);
  content.write("WAVE", 8, "ascii");
  content.write("fmt ", 12, "ascii");
  content.writeUInt32LE(16, 16);
  content.writeUInt16LE(1, 20);
  content.writeUInt16LE(1, 22);
  content.writeUInt32LE(sampleRate, 24);
  content.writeUInt32LE(sampleRate * bytesPerSample, 28);
  content.writeUInt16LE(bytesPerSample, 32);
  content.writeUInt16LE(16, 34);
  content.write("data", 36, "ascii");
  content.writeUInt32LE(dataBytes, 40);
  return {
    content,
    filename: "citeloom-connection-test.wav",
    mediaType: "audio/wav",
  };
}

async function consumeBoundedProviderError(response: Response): Promise<void> {
  const body = response.body;
  if (body === null) {
    return;
  }
  const reader = body.getReader();
  let consumed = 0;
  try {
    while (consumed < MAX_PROVIDER_ERROR_BYTES) {
      const result = await reader.read();
      if (result.done) {
        return;
      }
      consumed += result.value.byteLength;
    }
    await reader.cancel();
  } finally {
    reader.releaseLock();
  }
}

async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const body = response.body;
  if (body === null) {
    throw new SpeechToTextProviderError();
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        break;
      }
      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel();
        throw new SpeechToTextProviderError();
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (totalBytes === 0) {
    throw new SpeechToTextProviderError();
  }
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function readResponseMediaType(response: Response): string {
  const header = response.headers.get("content-type") ?? "";
  return header.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function throwRequestFailure(
  error: unknown,
  abortSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): never {
  if (abortSignal.aborted) {
    throw abortSignal.reason;
  }
  if (timeoutSignal.aborted) {
    throw new SpeechToTextTimeoutError();
  }
  if (error instanceof SpeechToTextProviderError) {
    throw error;
  }
  throw new SpeechToTextProviderError();
}
