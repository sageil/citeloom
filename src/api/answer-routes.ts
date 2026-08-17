import type { FastifyInstance } from "fastify";
import { pipeUIMessageStreamToResponse, type InferUIMessageChunk } from "ai";

import type { CiteLoomUIMessage } from "../answers/stream.js";
import type { AuthorizationPrincipal } from "../auth/model.js";
import { requireRequestPrincipal } from "./authentication-routes.js";
import {
  decodeQuestionRequest,
  type QuestionRequest,
} from "./request-boundary.js";

export interface AnswerRuntimeServices {
  streamAnswer: (
    principal: AuthorizationPrincipal,
    request: QuestionRequest,
    abortSignal: AbortSignal,
  ) => ReadableStream<InferUIMessageChunk<CiteLoomUIMessage>>;
}

export interface AnswerRouteServices {
  streamInWorkspace: <T>(
    principal: AuthorizationPrincipal,
    operation: (runtime: AnswerRuntimeServices) => ReadableStream<T>,
  ) => ReadableStream<T>;
}

export interface AnswerRouteOptions {
  requestPrincipals: WeakMap<object, AuthorizationPrincipal>;
  services: AnswerRouteServices;
}

export function registerAnswerRoutes(
  server: FastifyInstance,
  options: AnswerRouteOptions,
): void {
  const { requestPrincipals, services } = options;

  server.post("/api/questions", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const question = decodeQuestionRequest(request.body);
    const abortController = new AbortController();
    const abort = (): void => abortController.abort();
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    const stream = services.streamInWorkspace(principal, (runtime) => {
      return runtime.streamAnswer(principal, question, abortController.signal);
    });
    reply.hijack();
    pipeUIMessageStreamToResponse({ response: reply.raw, stream });
    return reply;
  });
}
