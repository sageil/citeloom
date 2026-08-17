import type { FastifyInstance } from "fastify";

import type { AuthorizationPrincipal } from "../auth/model.js";
import type {
  BrowseDocumentCatalogRequest,
  BrowseDocumentCatalogResult,
} from "../documents/catalog/browser.js";
import type {
  IndexedDocumentFile,
  ReadDocumentFileRequest,
  UpdateIndexedDocumentTagsRequest,
  UpdateIndexedDocumentTagsResult,
} from "../documents/catalog/service.js";
import type { DeleteIndexedDocumentResult } from "../ingestion/deletion.js";
import type { ReindexDocumentRequest } from "../ingestion/service.js";
import { requireRequestPrincipal } from "./authentication-routes.js";
import { applyInertDocumentHeaders } from "./inert-document-response.js";
import {
  buildInlineContentDisposition,
  decodeDocumentCatalogQuery,
  decodeDocumentFileRequest,
  decodeReindexDocumentRequest,
  decodeUpdateDocumentTagsRequest,
  WebRequestError,
} from "./request-boundary.js";

export interface DocumentCatalogRuntimeServices {
  browseDocuments: (
    principal: AuthorizationPrincipal,
    request: BrowseDocumentCatalogRequest,
  ) => Promise<BrowseDocumentCatalogResult>;
  deleteIndexedDocument: (
    principal: AuthorizationPrincipal,
    request: ReindexDocumentRequest,
  ) => Promise<DeleteIndexedDocumentResult>;
  readDocumentFile: (
    principal: AuthorizationPrincipal,
    request: ReadDocumentFileRequest,
  ) => Promise<IndexedDocumentFile | null>;
  updateDocumentTags: (
    principal: AuthorizationPrincipal,
    request: UpdateIndexedDocumentTagsRequest,
  ) => Promise<UpdateIndexedDocumentTagsResult | null>;
}

export interface DocumentCatalogRouteServices {
  run: <T>(
    operation: (runtime: DocumentCatalogRuntimeServices) => Promise<T>,
  ) => Promise<T>;
}

export interface DocumentCatalogRouteOptions {
  requestPrincipals: WeakMap<object, AuthorizationPrincipal>;
  services: DocumentCatalogRouteServices;
}

export function registerDocumentCatalogRoutes(
  server: FastifyInstance,
  options: DocumentCatalogRouteOptions,
): void {
  const { requestPrincipals, services } = options;

  server.get("/api/documents", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const catalogRequest = decodeDocumentCatalogQuery(request.query);
    return services.run(async (runtime) => {
      return runtime.browseDocuments(principal, catalogRequest);
    });
  });

  server.get("/api/documents/:documentId/file", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const documentRequest = decodeDocumentFileRequest(
      request.params,
      request.query,
    );
    const document = await services.run(async (runtime) => {
      return runtime.readDocumentFile(principal, documentRequest);
    });
    if (document === null) {
      throw new WebRequestError(
        404,
        "The requested document is no longer indexed.",
      );
    }
    applyInertDocumentHeaders(reply);
    reply.header(
      "Content-Disposition",
      buildInlineContentDisposition(document.filename),
    );
    return reply.type(document.mediaType).send(document.content);
  });

  server.put("/api/documents/:documentId/tags", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const updateRequest = decodeUpdateDocumentTagsRequest(
      request.params,
      request.body,
    );
    const result = await services.run(async (runtime) => {
      return runtime.updateDocumentTags(principal, updateRequest);
    });
    if (result === null) {
      throw new WebRequestError(
        404,
        "The selected document is no longer indexed.",
      );
    }
    return result;
  });

  server.delete("/api/documents/:documentId", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const deletionRequest = decodeReindexDocumentRequest(
      request.params,
      request.body,
    );
    const result = await services.run(async (runtime) => {
      return runtime.deleteIndexedDocument(principal, deletionRequest);
    });
    if (result.kind === "not-found") {
      throw new WebRequestError(404, "The indexed document was not found.");
    }
    if (result.kind === "active") {
      throw new WebRequestError(
        409,
        "The document cannot be deleted while ingestion or reindexing is active.",
      );
    }
    return reply.status(200).send(result);
  });
}
