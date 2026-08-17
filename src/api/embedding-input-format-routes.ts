import type { FastifyInstance } from "fastify";

import type { AuthorizationPrincipal } from "../auth/model.js";
import {
  EmbeddingInputFormatInUseError,
  EmbeddingInputFormatNotFoundError,
  type EmbeddingInputFormatRecord,
} from "../embedding/input-format-store.js";
import type {
  EmbeddingInputFormatDefinition,
} from "../embedding/input-format-model.js";
import { requireGlobalAdministratorPrincipal } from "./authentication-routes.js";
import {
  decodeCopyEmbeddingInputFormatRequest,
  decodeEmbeddingInputFormatDefinition,
  decodeResourceId,
  WebRequestError,
} from "./request-boundary.js";

export interface EmbeddingInputFormatRouteServices {
  copyEmbeddingInputFormat: (
    sourceId: string,
    name: string,
  ) => Promise<EmbeddingInputFormatRecord>;
  createEmbeddingInputFormat: (
    definition: EmbeddingInputFormatDefinition,
  ) => Promise<EmbeddingInputFormatRecord>;
  retireEmbeddingInputFormat: (
    id: string,
  ) => Promise<EmbeddingInputFormatRecord>;
  reviseEmbeddingInputFormat: (
    sourceId: string,
    definition: EmbeddingInputFormatDefinition,
  ) => Promise<EmbeddingInputFormatRecord>;
}

export interface EmbeddingInputFormatRouteOptions {
  requestPrincipals: WeakMap<object, AuthorizationPrincipal>;
  services: EmbeddingInputFormatRouteServices;
}

export function registerEmbeddingInputFormatRoutes(
  server: FastifyInstance,
  options: EmbeddingInputFormatRouteOptions,
): void {
  const { requestPrincipals, services } = options;

  server.post("/api/embedding-input-formats", async (request, reply) => {
    requireGlobalAdministratorPrincipal(requestPrincipals, request);
    const definition = decodeEmbeddingInputFormatDefinition(request.body);
    const format = await services.createEmbeddingInputFormat(definition);
    return reply.status(201).send({ id: format.id });
  });

  server.post(
    "/api/embedding-input-formats/:id/copies",
    async (request, reply) => {
      requireGlobalAdministratorPrincipal(requestPrincipals, request);
      const id = decodeResourceId(request.params);
      const copy = decodeCopyEmbeddingInputFormatRequest(request.body);
      try {
        const format = await services.copyEmbeddingInputFormat(id, copy.name);
        return reply.status(201).send({ id: format.id });
      } catch (error: unknown) {
        throw mapEmbeddingInputFormatError(error);
      }
    },
  );

  server.post(
    "/api/embedding-input-formats/:id/revisions",
    async (request, reply) => {
      requireGlobalAdministratorPrincipal(requestPrincipals, request);
      const id = decodeResourceId(request.params);
      const definition = decodeEmbeddingInputFormatDefinition(request.body);
      try {
        const format = await services.reviseEmbeddingInputFormat(
          id,
          definition,
        );
        return reply.status(201).send({ id: format.id });
      } catch (error: unknown) {
        throw mapEmbeddingInputFormatError(error);
      }
    },
  );

  server.delete("/api/embedding-input-formats/:id", async (request) => {
    requireGlobalAdministratorPrincipal(requestPrincipals, request);
    const id = decodeResourceId(request.params);
    try {
      const format = await services.retireEmbeddingInputFormat(id);
      return { id: format.id };
    } catch (error: unknown) {
      throw mapEmbeddingInputFormatError(error);
    }
  });
}

function mapEmbeddingInputFormatError(error: unknown): unknown {
  if (error instanceof EmbeddingInputFormatNotFoundError) {
    return new WebRequestError(404, error.message);
  }
  if (error instanceof EmbeddingInputFormatInUseError) {
    return new WebRequestError(409, error.message);
  }
  return error;
}
