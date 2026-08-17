import type { FastifyInstance } from "fastify";

import type { AuthorizationPrincipal } from "../auth/model.js";
import type {
  SourceDiscoveryRequest,
  SourceDiscoveryResponse,
} from "../retrieval/discovery/boundary.js";
import {
  SourceDiscoveryScopeError,
  SourceDiscoveryUnavailableError,
} from "../retrieval/discovery/pipeline.js";
import { requireRequestPrincipal } from "./authentication-routes.js";
import {
  readSourceDiscoveryRequest,
  WebRequestError,
} from "./request-boundary.js";

export interface SourceDiscoveryRuntimeServices {
  searchSources: (
    principal: AuthorizationPrincipal,
    request: SourceDiscoveryRequest,
    abortSignal: AbortSignal,
  ) => Promise<SourceDiscoveryResponse>;
}

export interface SourceDiscoveryRouteServices {
  runInWorkspace: <T>(
    principal: AuthorizationPrincipal,
    operation: (runtime: SourceDiscoveryRuntimeServices) => Promise<T>,
  ) => Promise<T>;
}

export interface SourceDiscoveryRouteOptions {
  requestPrincipals: WeakMap<object, AuthorizationPrincipal>;
  services: SourceDiscoveryRouteServices;
}

export function registerSourceDiscoveryRoutes(
  server: FastifyInstance,
  options: SourceDiscoveryRouteOptions,
): void {
  const { requestPrincipals, services } = options;

  server.post(
    "/api/search",
    async (request, reply): Promise<SourceDiscoveryResponse> => {
      const principal = requireRequestPrincipal(requestPrincipals, request);
      const searchRequest = readSourceDiscoveryRequest(request.body);
      const abortController = new AbortController();
      const abort = (): void => abortController.abort();
      request.raw.once("aborted", abort);
      reply.raw.once("close", abort);
      try {
        return await services.runInWorkspace(principal, async (runtime) => {
          return runtime.searchSources(
            principal,
            searchRequest,
            abortController.signal,
          );
        });
      } catch (error: unknown) {
        throw mapSourceDiscoveryError(error);
      } finally {
        request.raw.off("aborted", abort);
        reply.raw.off("close", abort);
      }
    },
  );
}

function mapSourceDiscoveryError(error: unknown): unknown {
  if (error instanceof SourceDiscoveryUnavailableError) {
    return new WebRequestError(503, error.message);
  }
  if (error instanceof SourceDiscoveryScopeError) {
    return new WebRequestError(409, error.message);
  }
  return error;
}
