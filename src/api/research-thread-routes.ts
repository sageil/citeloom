import type { FastifyInstance } from "fastify";

import type { AuthorizationPrincipal } from "../auth/model.js";
import type {
  ResearchExport,
  ResearchExportFormat,
} from "../research/store.js";
import type {
  ResearchThread,
  ResearchThreadSummary,
} from "../research/types.js";
import { requireRequestPrincipal } from "./authentication-routes.js";
import {
  decodeCreateResearchThreadRequest,
  decodeResearchExportFormat,
  decodeResearchThreadId,
  WebRequestError,
} from "./request-boundary.js";

export interface ResearchThreadRuntimeServices {
  createResearchThread: (
    principal: AuthorizationPrincipal,
    title: string,
  ) => Promise<ResearchThread>;
  deleteResearchThread: (
    principal: AuthorizationPrincipal,
    id: string,
  ) => Promise<void>;
  exportResearchThread: (
    principal: AuthorizationPrincipal,
    id: string,
    format: ResearchExportFormat,
  ) => Promise<ResearchExport | null>;
  listResearchThreads: (
    principal: AuthorizationPrincipal,
  ) => Promise<ResearchThreadSummary[]>;
  readResearchThread: (
    principal: AuthorizationPrincipal,
    id: string,
  ) => Promise<ResearchThread | null>;
}

export interface ResearchThreadRouteServices {
  run: <T>(
    operation: (runtime: ResearchThreadRuntimeServices) => Promise<T>,
  ) => Promise<T>;
}

export interface ResearchThreadRouteOptions {
  requestPrincipals: WeakMap<object, AuthorizationPrincipal>;
  services: ResearchThreadRouteServices;
}

export function registerResearchThreadRoutes(
  server: FastifyInstance,
  options: ResearchThreadRouteOptions,
): void {
  const { requestPrincipals, services } = options;

  server.get("/api/research/threads", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    return services.run(async (runtime) => {
      return runtime.listResearchThreads(principal);
    });
  });

  server.post("/api/research/threads", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const title = decodeCreateResearchThreadRequest(request.body);
    const thread = await services.run(async (runtime) => {
      return runtime.createResearchThread(principal, title);
    });
    return reply.status(201).send(thread);
  });

  server.get("/api/research/threads/:threadId", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const threadId = decodeResearchThreadId(request.params);
    const thread = await services.run(async (runtime) => {
      return runtime.readResearchThread(principal, threadId);
    });
    if (thread === null) {
      throw new WebRequestError(404, "The research thread was not found.");
    }
    return thread;
  });

  server.delete("/api/research/threads/:threadId", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const threadId = decodeResearchThreadId(request.params);
    await services.run(async (runtime) => {
      return runtime.deleteResearchThread(principal, threadId);
    });
    return reply.status(204).send();
  });

  server.get(
    "/api/research/threads/:threadId/export",
    async (request, reply) => {
      const principal = requireRequestPrincipal(requestPrincipals, request);
      const threadId = decodeResearchThreadId(request.params);
      const format = decodeResearchExportFormat(request.query);
      const exported = await services.run(async (runtime) => {
        return runtime.exportResearchThread(principal, threadId, format);
      });
      if (exported === null) {
        throw new WebRequestError(404, "The research thread was not found.");
      }
      reply.header("Cache-Control", "private, no-store");
      reply.header(
        "Content-Disposition",
        `attachment; filename="${exported.filename}"`,
      );
      reply.type(exported.mediaType);
      return exported.content;
    },
  );
}
