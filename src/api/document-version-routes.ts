import type { FastifyInstance } from "fastify";

import type { AuthorizationPrincipal } from "../auth/model.js";
import type { IndexedDocumentFile } from "../documents/catalog/service.js";
import type {
  DocumentVersionDifference,
  DocumentVersionRecord,
} from "../research/types.js";
import { requireRequestPrincipal } from "./authentication-routes.js";
import { applyInertDocumentHeaders } from "./inert-document-response.js";
import {
  buildInlineContentDisposition,
  decodeDocumentVersionComparison,
  decodeDocumentVersionList,
  decodeResourceId,
  WebRequestError,
} from "./request-boundary.js";

export interface DocumentVersionRuntimeServices {
  compareDocumentVersions: (
    principal: AuthorizationPrincipal,
    previousVersionId: string,
    currentVersionId: string,
  ) => Promise<DocumentVersionDifference | null>;
  listDocumentVersions: (
    principal: AuthorizationPrincipal,
    sourceFile: string,
  ) => Promise<DocumentVersionRecord[]>;
  readVersionedDocumentFile: (
    principal: AuthorizationPrincipal,
    id: string,
  ) => Promise<IndexedDocumentFile | null>;
}

export interface DocumentVersionRouteServices {
  run: <T>(
    operation: (runtime: DocumentVersionRuntimeServices) => Promise<T>,
  ) => Promise<T>;
}

export interface DocumentVersionRouteOptions {
  requestPrincipals: WeakMap<object, AuthorizationPrincipal>;
  services: DocumentVersionRouteServices;
}

export function registerDocumentVersionRoutes(
  server: FastifyInstance,
  options: DocumentVersionRouteOptions,
): void {
  const { requestPrincipals, services } = options;

  server.get("/api/document-versions", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const sourceFile = decodeDocumentVersionList(request.query);
    return services.run(async (runtime) => {
      return runtime.listDocumentVersions(principal, sourceFile);
    });
  });

  server.get("/api/document-versions/compare", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const comparison = decodeDocumentVersionComparison(request.query);
    const result = await services.run(async (runtime) => {
      return runtime.compareDocumentVersions(
        principal,
        comparison.previous,
        comparison.current,
      );
    });
    if (result === null) {
      throw new WebRequestError(
        404,
        "One or both document versions were not found.",
      );
    }
    return result;
  });

  server.get("/api/document-versions/:id/file", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const id = decodeResourceId(request.params);
    const document = await services.run(async (runtime) => {
      return runtime.readVersionedDocumentFile(principal, id);
    });
    if (document === null) {
      throw new WebRequestError(404, "The document version was not found.");
    }
    applyInertDocumentHeaders(reply);
    reply.header(
      "Content-Disposition",
      buildInlineContentDisposition(document.filename),
    );
    return reply.type(document.mediaType).send(document.content);
  });
}
