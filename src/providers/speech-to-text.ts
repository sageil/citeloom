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

async function requestProviderTranscription(
  config: SpeechToTextConfig,
  audio: TranscriptionAudio,
  abortSignal: AbortSignal,
  adapter: TranscriptionAdapterContract,
): Promise<ProviderTranscriptionResponse> {
  const form = buildProviderForm(config, audio);
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  const requestSignal = AbortSignal.any([abortSignal, timeoutSignal]);
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${adapter.path}`, {
      body: form,
      headers: buildProviderHeaders(config),
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
  path: "/audio/transcriptions";
  rejectPromptEcho: boolean;
}

function readTranscriptionAdapter(
  config: SpeechToTextConfig,
): TranscriptionAdapterContract {
  switch (config.adapter) {
    case "omlx-transcription":
      return {
        path: "/audio/transcriptions",
        rejectPromptEcho: true,
      };
    case "openai-transcription":
      return {
        path: "/audio/transcriptions",
        rejectPromptEcho: false,
      };
  }
}

function buildProviderForm(
  config: SpeechToTextConfig,
  audio: TranscriptionAudio,
): FormData {
  const form = new FormData();
  const content = new Uint8Array(audio.content);
  form.append("file", new Blob([content], { type: audio.mediaType }), audio.filename);
  form.append("model", config.model);
  if (config.language !== null) {
    form.append("language", config.language);
  }
  if (config.prompt !== null) {
    form.append("prompt", config.prompt);
  }
  return form;
}

function buildProviderHeaders(config: SpeechToTextConfig): Headers {
  const headers = new Headers({ accept: "application/json" });
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
