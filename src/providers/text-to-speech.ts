import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { z } from "zod";

import {
  readTextToSpeechSpeedRange,
  type AppConfig,
  type TextToSpeechConfig,
} from "../config/index.js";
import {
  createUncitedAnswerDocument,
  renderPublishedAnswerSpeech,
  type PublishedAnswerDocument,
} from "../answers/published.js";
import {
  readBoundedJsonResponse,
  readBoundedResponseText,
} from "./http-response.js";

const MAX_PROVIDER_ERROR_BYTES = 16 * 1_024;
const MAX_PROVIDER_ERROR_CHARACTERS = 2_000;
const MAX_MISTRAL_SPEECH_RESPONSE_BYTES = 64 * 1_024 * 1_024;
const MINIMUM_WAV_HEADER_BYTES = 12;
const mistralSpeechResponseSchema = z.object({
  audio_data: z.string().trim().min(1),
}).strict();

interface OpenAiSpeechProviderRequest {
  input: string;
  model: string;
  response_format: "mp3" | "wav";
  speed: number;
  voice: string;
}

interface MistralSpeechProviderRequest {
  input: string;
  model: string;
  response_format: "wav";
  stream: false;
  voice_id: string;
}

type SpeechProviderRequest =
  | MistralSpeechProviderRequest
  | OpenAiSpeechProviderRequest;

export interface SpeechRequest {
  answerDocument: PublishedAnswerDocument;
}

export interface GeneratedSpeech {
  audio: Readable;
  completion: Promise<void>;
  contentType: string;
}

interface ProviderGeneratedSpeech {
  audio: Readable;
  audioFormat: "mp3" | "wav";
  contentType: string;
  timeoutSignal: AbortSignal;
}

export class TextToSpeechUnavailableError extends Error {
  public constructor() {
    super("Text-to-speech is disabled.");
    this.name = "TextToSpeechUnavailableError";
  }
}

export class TextToSpeechProviderError extends Error {
  public constructor(message = "The text-to-speech provider could not complete the request.") {
    super(message);
    this.name = "TextToSpeechProviderError";
  }
}

export class TextToSpeechTimeoutError extends Error {
  public constructor() {
    super("The text-to-speech provider timed out.");
    this.name = "TextToSpeechTimeoutError";
  }
}

export async function generateTextToSpeech(
  appConfig: AppConfig,
  request: SpeechRequest,
  abortSignal: AbortSignal,
): Promise<GeneratedSpeech> {
  const config = appConfig.textToSpeech;
  if (config === null) {
    throw new TextToSpeechUnavailableError();
  }
  const speech = await requestSpeech(config, request, abortSignal);
  return {
    audio: speech.audio,
    completion: waitForSpeechCompletion(speech, abortSignal),
    contentType: speech.contentType,
  };
}

export async function probeTextToSpeechProvider(
  config: TextToSpeechConfig,
  abortSignal: AbortSignal,
): Promise<void> {
  const result = await requestSpeech(
    config,
    { answerDocument: createUncitedAnswerDocument() },
    abortSignal,
  );
  try {
    const header = await readSpeechProbeHeader(result.audio);
    if (!isSpeechHeader(header, result.audioFormat)) {
      const format = result.audioFormat.toUpperCase();
      throw new TextToSpeechProviderError(
        `The text-to-speech provider returned invalid ${format} audio.`,
      );
    }
  } catch (error: unknown) {
    throwTextToSpeechFailure(
      error,
      abortSignal,
      result.timeoutSignal,
    );
  } finally {
    result.audio.destroy();
  }
}

async function requestSpeech(
  config: TextToSpeechConfig,
  request: SpeechRequest,
  abortSignal: AbortSignal,
): Promise<ProviderGeneratedSpeech> {
  const adapter = readSpeechAdapter(config);
  const speedRange = readTextToSpeechSpeedRange(config.adapter);
  if (config.speed < speedRange.minimum || config.speed > speedRange.maximum) {
    throw new Error(
      `${speedRange.displayName} speech speed must be from ${speedRange.minimum} to ${speedRange.maximum}.`,
    );
  }
  const input = renderPublishedAnswerSpeech(request.answerDocument);
  const requestBody = buildSpeechProviderRequest(config, input, adapter);
  const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
  const requestSignal = AbortSignal.any([abortSignal, timeoutSignal]);
  try {
    const response = await fetch(`${config.baseUrl}${adapter.path}`, {
      body: JSON.stringify(requestBody),
      headers: buildHeaders(config, adapter),
      method: "POST",
      signal: requestSignal,
    });
    if (!response.ok) {
      const detail = await readProviderErrorDetail(response);
      throw new TextToSpeechProviderError(
        `Text-to-speech provider returned HTTP ${response.status}: ${detail}`,
      );
    }

    return await readProviderGeneratedSpeech(
      response,
      adapter,
      requestSignal,
      timeoutSignal,
    );
  } catch (error: unknown) {
    throwTextToSpeechFailure(error, abortSignal, timeoutSignal);
  }
}

async function waitForSpeechCompletion(
  speech: ProviderGeneratedSpeech,
  abortSignal: AbortSignal,
): Promise<void> {
  try {
    await finished(speech.audio, { cleanup: true });
  } catch (error: unknown) {
    throwTextToSpeechFailure(error, abortSignal, speech.timeoutSignal);
  }
}

interface SpeechAdapterContract {
  acceptsAudioFamily: boolean;
  acceptedContentTypes: readonly string[];
  path: "/audio/speech";
  requestFormat: "mistral" | "openai";
  responseBody: "binary" | "mistral-json";
  responseFormat: "mp3" | "wav";
}

function readSpeechAdapter(config: TextToSpeechConfig): SpeechAdapterContract {
  switch (config.adapter) {
    case "groq-speech":
      return {
        acceptsAudioFamily: false,
        acceptedContentTypes: ["audio/wav", "audio/x-wav"],
        path: "/audio/speech",
        requestFormat: "openai",
        responseBody: "binary",
        responseFormat: "wav",
      };
    case "mistral-speech":
      return {
        acceptsAudioFamily: false,
        acceptedContentTypes: ["application/json"],
        path: "/audio/speech",
        requestFormat: "mistral",
        responseBody: "mistral-json",
        responseFormat: "wav",
      };
    case "omlx-speech":
      return {
        acceptsAudioFamily: false,
        acceptedContentTypes: ["audio/wav", "audio/x-wav"],
        path: "/audio/speech",
        requestFormat: "openai",
        responseBody: "binary",
        responseFormat: "wav",
      };
    case "openrouter-speech":
      return {
        acceptsAudioFamily: false,
        acceptedContentTypes: ["audio/mpeg"],
        path: "/audio/speech",
        requestFormat: "openai",
        responseBody: "binary",
        responseFormat: "mp3",
      };
    case "openai-speech":
      return {
        acceptsAudioFamily: false,
        acceptedContentTypes: [
          "application/octet-stream",
          "audio/wav",
          "audio/x-wav",
        ],
        path: "/audio/speech",
        requestFormat: "openai",
        responseBody: "binary",
        responseFormat: "wav",
      };
  }
}

function buildSpeechProviderRequest(
  config: TextToSpeechConfig,
  input: string,
  adapter: SpeechAdapterContract,
): SpeechProviderRequest {
  if (adapter.requestFormat === "mistral") {
    return {
      input,
      model: config.model,
      response_format: "wav",
      stream: false,
      voice_id: config.voice,
    };
  }
  return {
    input,
    model: config.model,
    response_format: adapter.responseFormat,
    speed: config.speed,
    voice: config.voice,
  };
}

async function readProviderGeneratedSpeech(
  response: Response,
  adapter: SpeechAdapterContract,
  requestSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): Promise<ProviderGeneratedSpeech> {
  if (adapter.responseBody === "mistral-json") {
    return readMistralGeneratedSpeech(response, adapter, timeoutSignal);
  }
  const contentType = readAudioContentType(response, adapter);
  if (response.body === null) {
    throw new TextToSpeechProviderError(
      "Text-to-speech provider returned an empty audio response.",
    );
  }
  return {
    audio: Readable.fromWeb(response.body, { signal: requestSignal }),
    audioFormat: adapter.responseFormat,
    contentType,
    timeoutSignal,
  };
}

async function readMistralGeneratedSpeech(
  response: Response,
  adapter: SpeechAdapterContract,
  timeoutSignal: AbortSignal,
): Promise<ProviderGeneratedSpeech> {
  readAudioContentType(response, adapter);
  const value = await readBoundedJsonResponse(
    response,
    MAX_MISTRAL_SPEECH_RESPONSE_BYTES,
  );
  const result = mistralSpeechResponseSchema.safeParse(value);
  if (!result.success) {
    throw new TextToSpeechProviderError(
      "Mistral returned an invalid speech response.",
    );
  }
  const audio = decodeMistralAudio(result.data.audio_data);
  return {
    audio: Readable.from([audio]),
    audioFormat: adapter.responseFormat,
    contentType: "audio/wav",
    timeoutSignal,
  };
}

function decodeMistralAudio(value: string): Buffer {
  if (
    value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new TextToSpeechProviderError(
      "Mistral returned invalid base64 speech audio.",
    );
  }
  const audio = Buffer.from(value, "base64");
  if (audio.length === 0) {
    throw new TextToSpeechProviderError(
      "Mistral returned empty speech audio.",
    );
  }
  return audio;
}

function buildHeaders(
  config: TextToSpeechConfig,
  adapter: SpeechAdapterContract,
): Headers {
  const headers = new Headers({
    accept: adapter.responseFormat === "mp3" ? "audio/mpeg" : "audio/wav",
    "content-type": "application/json",
  });
  if (config.apiToken !== null) {
    headers.set("authorization", `Bearer ${config.apiToken}`);
  }
  return headers;
}

function readAudioContentType(
  response: Response,
  adapter: SpeechAdapterContract,
): string {
  const header = response.headers.get("content-type");
  const contentType = header?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    contentType === undefined
    || (
      !adapter.acceptsAudioFamily
      && !adapter.acceptedContentTypes.includes(contentType)
    )
    || (adapter.acceptsAudioFamily && !contentType.startsWith("audio/"))
  ) {
    throw new TextToSpeechProviderError(
      `Text-to-speech provider returned unsupported content type: ${header ?? "missing"}.`,
    );
  }
  return contentType === "application/octet-stream" ? "audio/wav" : contentType;
}

async function readProviderErrorDetail(response: Response): Promise<string> {
  const detail = (await readBoundedResponseText(
    response,
    MAX_PROVIDER_ERROR_BYTES,
  )).trim();
  if (detail === "") {
    return "no response detail";
  }
  return detail.slice(0, MAX_PROVIDER_ERROR_CHARACTERS);
}

async function readSpeechProbeHeader(audio: Readable): Promise<Uint8Array> {
  const header = new Uint8Array(MINIMUM_WAV_HEADER_BYTES);
  let offset = 0;
  for await (const chunk of audio) {
    if (!(chunk instanceof Uint8Array)) {
      throw new TextToSpeechProviderError(
        "The text-to-speech provider returned invalid audio data.",
      );
    }
    const remaining = MINIMUM_WAV_HEADER_BYTES - offset;
    const copiedBytes = Math.min(remaining, chunk.byteLength);
    header.set(chunk.subarray(0, copiedBytes), offset);
    offset += copiedBytes;
    if (offset === MINIMUM_WAV_HEADER_BYTES) {
      return header;
    }
  }
  throw new TextToSpeechProviderError(
    "The text-to-speech provider returned incomplete WAV audio.",
  );
}

function isWavHeader(header: Uint8Array): boolean {
  const decoder = new TextDecoder("ascii");
  return decoder.decode(header.subarray(0, 4)) === "RIFF"
    && decoder.decode(header.subarray(8, 12)) === "WAVE";
}

function isSpeechHeader(
  header: Uint8Array,
  format: "mp3" | "wav",
): boolean {
  if (format === "wav") {
    return isWavHeader(header);
  }
  return isMp3Header(header);
}

function isMp3Header(header: Uint8Array): boolean {
  const decoder = new TextDecoder("ascii");
  if (decoder.decode(header.subarray(0, 3)) === "ID3") {
    return true;
  }
  const first = header[0];
  const second = header[1];
  return first === 0xff && second !== undefined && (second & 0xe0) === 0xe0;
}

function throwTextToSpeechFailure(
  error: unknown,
  abortSignal: AbortSignal,
  timeoutSignal: AbortSignal,
): never {
  if (abortSignal.aborted) {
    throw abortSignal.reason;
  }
  if (timeoutSignal.aborted) {
    throw new TextToSpeechTimeoutError();
  }
  if (error instanceof TextToSpeechProviderError) {
    throw error;
  }
  throw new TextToSpeechProviderError();
}
