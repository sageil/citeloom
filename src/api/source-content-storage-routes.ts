import type { FastifyInstance } from "fastify";

import type { AuthenticatedPrincipal } from "../auth/model.js";
import {
  sanitizeDiagnosticMessage,
} from "../observability/application-errors.js";
import {
  SourceContentMigrationConflictError,
  SourceContentMigrationNotFoundError,
} from "../documents/storage/source-content-migration-store.js";
import { requireGlobalAdministratorPrincipal } from "./authentication-routes.js";
import {
  decodeSourceContentMigrationId,
  decodeSourceContentMigrationRequest,
  decodeSourceContentStorageProbe,
} from "./source-content-storage-boundary.js";
import {
  buildSourceContentStorageResponse,
  presentSourceContentMigration,
} from "./source-content-storage-response.js";
import type { WebServices } from "./services.js";
import { WebRequestError } from "./request-boundary.js";

export interface SourceContentStorageRouteOptions {
  requestPrincipals: WeakMap<object, AuthenticatedPrincipal>;
  services: WebServices;
}

export function registerSourceContentStorageRoutes(
  server: FastifyInstance,
  options: SourceContentStorageRouteOptions,
): void {
  const { requestPrincipals, services } = options;

  server.get("/api/source-content-storage", async (request) => {
    requireGlobalAdministratorPrincipal(requestPrincipals, request);
    const overview = await services.readSourceContentStorage();
    return buildSourceContentStorageResponse(overview);
  });

  server.post("/api/source-content-storage/probes", async (request) => {
    requireGlobalAdministratorPrincipal(requestPrincipals, request);
    const target = decodeSourceContentStorageProbe(request.body);
    try {
      await services.testSourceContentStorage(target);
    } catch (error: unknown) {
      throw new WebRequestError(
        400,
        sanitizeDiagnosticMessage(readErrorMessage(error)),
      );
    }
    return { ok: true };
  });

  server.post(
    "/api/source-content-storage/migrations",
    async (request, reply) => {
      const principal = requireGlobalAdministratorPrincipal(
        requestPrincipals,
        request,
      );
      const migrationRequest = decodeSourceContentMigrationRequest(
        request.body,
      );
      try {
        const migration = await services.queueSourceContentMigration(
          principal.userId,
          migrationRequest,
        );
        return reply.status(202).send(presentSourceContentMigration(migration));
      } catch (error: unknown) {
        throw mapSourceContentMigrationError(error);
      }
    },
  );

  server.post(
    "/api/source-content-storage/migrations/:id/cancellation",
    async (request) => {
      requireGlobalAdministratorPrincipal(requestPrincipals, request);
      const id = decodeSourceContentMigrationId(request.params);
      try {
        const migration = await services.cancelSourceContentMigration(id);
        return presentSourceContentMigration(migration);
      } catch (error: unknown) {
        throw mapSourceContentMigrationError(error);
      }
    },
  );
}

function mapSourceContentMigrationError(error: unknown): unknown {
  if (error instanceof SourceContentMigrationNotFoundError) {
    return new WebRequestError(404, error.message);
  }
  if (error instanceof SourceContentMigrationConflictError) {
    return new WebRequestError(409, error.message);
  }
  return error;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
