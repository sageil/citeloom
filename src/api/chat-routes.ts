import type { FastifyInstance } from "fastify";
import { pipeUIMessageStreamToResponse } from "ai";

import type { AuthenticatedPrincipal } from "../auth/model.js";
import { requireRequestPrincipal } from "./authentication-routes.js";
import {
  applyHighlightedDocumentHeaders,
  applyInertDocumentHeaders,
} from "./inert-document-response.js";
import {
  buildInlineContentDisposition,
  decodeChatConversationId,
  decodeCreateChatConversationRequest,
  decodeCreateChatMessageRequest,
  decodeResourceId,
  WebRequestError,
} from "./request-boundary.js";
import type { WebServices } from "./services.js";

export interface ChatRouteOptions {
  requestPrincipals: WeakMap<object, AuthenticatedPrincipal>;
  services: WebServices;
}

export function registerChatRoutes(
  server: FastifyInstance,
  options: ChatRouteOptions,
): void {
  const { requestPrincipals, services } = options;

  server.get("/api/chat/conversations", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const conversations = await services.run(async (runtime) => {
      if (runtime.listChatConversations === undefined) {
        throw new Error("Chat conversations are not configured.");
      }
      return runtime.listChatConversations(principal);
    });
    reply.header("Cache-Control", "private, no-store");
    return conversations;
  });

  server.post("/api/chat/conversations", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const input = decodeCreateChatConversationRequest(request.body);
    const conversation = await services.run(async (runtime) => {
      if (runtime.createChatConversation === undefined) {
        throw new Error("Chat conversations are not configured.");
      }
      return runtime.createChatConversation(
        principal,
        input.title,
        input.scope,
      );
    });
    reply.header("Cache-Control", "private, no-store");
    return reply.status(201).send(conversation);
  });

  server.get(
    "/api/chat/conversations/:conversationId",
    async (request, reply) => {
      const principal = requireRequestPrincipal(requestPrincipals, request);
      const conversationId = decodeChatConversationId(request.params);
      const conversation = await services.run(async (runtime) => {
        if (runtime.readChatConversation === undefined) {
          throw new Error("Chat conversations are not configured.");
        }
        return runtime.readChatConversation(principal, conversationId);
      });
      if (conversation === null) {
        throw new WebRequestError(404, "The chat was not found.");
      }
      reply.header("Cache-Control", "private, no-store");
      return conversation;
    },
  );

  server.delete(
    "/api/chat/conversations/:conversationId",
    async (request, reply) => {
      const principal = requireRequestPrincipal(requestPrincipals, request);
      const conversationId = decodeChatConversationId(request.params);
      await services.run(async (runtime) => {
        if (runtime.deleteChatConversation === undefined) {
          throw new Error("Chat conversations are not configured.");
        }
        await runtime.deleteChatConversation(principal, conversationId);
      });
      return reply.status(204).send();
    },
  );

  server.post(
    "/api/chat/conversations/:conversationId/messages",
    async (request, reply) => {
      const principal = requireRequestPrincipal(requestPrincipals, request);
      const conversationId = decodeChatConversationId(request.params);
      const input = decodeCreateChatMessageRequest(request.body);
      const abortController = new AbortController();
      const abort = (): void => abortController.abort();
      request.raw.once("aborted", abort);
      reply.raw.once("close", abort);
      const stream = services.stream((runtime) => {
        if (runtime.streamChatMessage === undefined) {
          throw new Error("Chat generation is not configured.");
        }
        return runtime.streamChatMessage(
          principal,
          {
            content: input.content,
            conversationId,
            requestId: input.requestId,
          },
          abortController.signal,
        );
      });
      reply.hijack();
      pipeUIMessageStreamToResponse({ response: reply.raw, stream });
      return reply;
    },
  );

  server.get("/api/chat/citations/:id", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const id = decodeResourceId(request.params);
    const citation = await services.run(async (runtime) => {
      if (runtime.readChatCitationEvidence === undefined) {
        throw new Error("Chat citations are not configured.");
      }
      return runtime.readChatCitationEvidence(principal, id);
    });
    if (citation === null) {
      throw new WebRequestError(404, "The chat citation was not found.");
    }
    reply.header("Cache-Control", "private, no-store");
    return citation;
  });

  server.get("/api/chat/citations/:id/image", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const id = decodeResourceId(request.params);
    const image = await services.run(async (runtime) => {
      if (runtime.readChatCitationImage === undefined) {
        throw new Error("Chat citation images are not configured.");
      }
      return runtime.readChatCitationImage(principal, id);
    });
    if (image === null) {
      throw new WebRequestError(404, "The chat citation was not found.");
    }
    applyInertDocumentHeaders(reply);
    reply.header("Content-Disposition", "inline");
    return reply.type(image.mediaType).send(image.content);
  });

  server.get("/api/chat/citations/:id/file", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const id = decodeResourceId(request.params);
    const document = await services.run(async (runtime) => {
      if (runtime.readChatCitationFile === undefined) {
        throw new Error("Chat citation files are not configured.");
      }
      return runtime.readChatCitationFile(principal, id);
    });
    if (document === null) {
      throw new WebRequestError(404, "The chat citation was not found.");
    }
    applyInertDocumentHeaders(reply);
    reply.header(
      "Content-Disposition",
      buildInlineContentDisposition(document.filename),
    );
    return reply.type(document.mediaType).send(document.content);
  });

  server.get(
    "/api/chat/citations/:id/highlighted-file",
    async (request, reply) => {
      const principal = requireRequestPrincipal(requestPrincipals, request);
      const id = decodeResourceId(request.params);
      const document = await services.run(async (runtime) => {
        const readHighlightedFile = runtime.readChatCitationHighlightedFile
          ?? runtime.readChatCitationHighlightedPdf;
        if (readHighlightedFile === undefined) {
          throw new Error("Chat highlighted citations are not configured.");
        }
        return readHighlightedFile(principal, id);
      });
      if (document === null) {
        throw new WebRequestError(404, "The chat citation was not found.");
      }
      applyHighlightedDocumentHeaders(reply, document.mediaType);
      reply.header(
        "Content-Disposition",
        buildInlineContentDisposition(document.filename),
      );
      return reply.type(document.mediaType).send(document.content);
    },
  );
}
