import type { FastifyInstance } from "fastify";

import type { AuthorizationPrincipal } from "../auth/model.js";
import type { SpeechToTextConfig } from "../config/index.js";
import {
  SpeechToTextProviderError,
  SpeechToTextTimeoutError,
  SpeechToTextUnavailableError,
  type TranscriptionAudio,
  type TranscriptionResult,
} from "../providers/speech-to-text.js";
import {
  TextToSpeechProviderError,
  TextToSpeechTimeoutError,
  TextToSpeechUnavailableError,
  type GeneratedSpeech,
  type SpeechRequest,
} from "../providers/text-to-speech.js";
import type { ManagedTask } from "../shared/concurrency.js";
import { requireRequestPrincipal } from "./authentication-routes.js";
import {
  decodeSpeechRequest,
  readTranscriptionRequest,
  WebRequestError,
} from "./request-boundary.js";

export interface SpeechRuntimeServices {
  readonly config: {
    speechToText: Pick<SpeechToTextConfig, "maxAudioBytes"> | null;
  };
  generateSpeech: (
    request: SpeechRequest,
    abortSignal: AbortSignal,
  ) => Promise<GeneratedSpeech>;
  transcribeAudio: (
    audio: TranscriptionAudio,
    abortSignal: AbortSignal,
  ) => Promise<TranscriptionResult>;
}

export interface SpeechRouteServices {
  runInWorkspace: <T>(
    principal: AuthorizationPrincipal,
    operation: (runtime: SpeechRuntimeServices) => Promise<T>,
  ) => Promise<T>;
  runManagedInWorkspace: <T>(
    principal: AuthorizationPrincipal,
    operation: (runtime: SpeechRuntimeServices) => Promise<ManagedTask<T>>,
  ) => Promise<T>;
}

export interface SpeechRouteOptions {
  requestPrincipals: WeakMap<object, AuthorizationPrincipal>;
  services: SpeechRouteServices;
}

export function registerSpeechRoutes(
  server: FastifyInstance,
  options: SpeechRouteOptions,
): void {
  const { requestPrincipals, services } = options;

  server.post("/api/speech", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const speechRequest = decodeSpeechRequest(request.body);
    const abortController = new AbortController();
    const abort = (): void => abortController.abort();
    const cleanup = (): void => {
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    let speech: GeneratedSpeech | null = null;
    let streaming = false;
    try {
      speech = await services.runManagedInWorkspace(
        principal,
        async (runtime) => {
          const generated = await runtime.generateSpeech(
            speechRequest,
            abortController.signal,
          );
          return {
            completion: generated.completion,
            value: generated,
          };
        },
      );
      speech.audio.once("close", cleanup);
      speech.audio.once("end", cleanup);
      reply.header("Cache-Control", "private, no-store");
      reply.header("Content-Disposition", "inline");
      reply.header("Content-Type", speech.contentType);
      reply.header("Cross-Origin-Resource-Policy", "same-origin");
      reply.header("X-Content-Type-Options", "nosniff");
      const response = reply.send(speech.audio);
      streaming = true;
      return response;
    } catch (error: unknown) {
      throw mapTextToSpeechError(error);
    } finally {
      if (!streaming) {
        abort();
        speech?.audio.destroy();
        cleanup();
      }
    }
  });

  server.post("/api/transcriptions", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    reply.header("Cache-Control", "private, no-store");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("X-Content-Type-Options", "nosniff");
    try {
      return await services.runInWorkspace(principal, async (runtime) => {
        const config = runtime.config.speechToText;
        if (config === null) {
          throw new WebRequestError(503, "Speech-to-text is disabled.");
        }
        const audio = await readTranscriptionRequest(
          request,
          config.maxAudioBytes,
        );
        return runtime.transcribeAudio(audio, request.signal);
      });
    } catch (error: unknown) {
      throw mapSpeechToTextError(error);
    }
  });
}

function mapTextToSpeechError(error: unknown): unknown {
  if (error instanceof TextToSpeechUnavailableError) {
    return new WebRequestError(503, error.message);
  }
  if (error instanceof TextToSpeechTimeoutError) {
    return new WebRequestError(504, error.message);
  }
  if (error instanceof TextToSpeechProviderError) {
    return new WebRequestError(502, error.message);
  }
  return error;
}

function mapSpeechToTextError(error: unknown): unknown {
  if (error instanceof SpeechToTextUnavailableError) {
    return new WebRequestError(503, error.message);
  }
  if (error instanceof SpeechToTextTimeoutError) {
    return new WebRequestError(504, error.message);
  }
  if (error instanceof SpeechToTextProviderError) {
    return new WebRequestError(502, error.message);
  }
  return error;
}
