import type { FastifyInstance } from "fastify";

import type { AuthorizationPrincipal } from "../auth/model.js";
import type { IndexedDocumentFile } from "../documents/catalog/service.js";
import type { StoredCitationRecord } from "../research/types.js";
import { requireRequestPrincipal } from "./authentication-routes.js";
import {
  applyHighlightedDocumentHeaders,
  applyInertDocumentHeaders,
} from "./inert-document-response.js";
import {
  buildInlineContentDisposition,
  decodeResourceId,
  WebRequestError,
} from "./request-boundary.js";

export interface CitationImage {
  content: Buffer;
  mediaType: string;
}

export interface CitationRuntimeServices {
  readCitationEvidence: (
    principal: AuthorizationPrincipal,
    id: string,
  ) => Promise<StoredCitationRecord | null>;
  readCitationHighlightedFile: (
    principal: AuthorizationPrincipal,
    id: string,
  ) => Promise<IndexedDocumentFile | null>;
  readCitationImage: (
    principal: AuthorizationPrincipal,
    id: string,
  ) => Promise<CitationImage | null>;
}

export interface CitationRouteServices {
  run: <T>(
    operation: (runtime: CitationRuntimeServices) => Promise<T>,
  ) => Promise<T>;
}

export interface CitationRouteOptions {
  requestPrincipals: WeakMap<object, AuthorizationPrincipal>;
  services: CitationRouteServices;
}

export function registerCitationRoutes(
  server: FastifyInstance,
  options: CitationRouteOptions,
): void {
  const { requestPrincipals, services } = options;

  server.get("/api/citations/:id", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const id = decodeResourceId(request.params);
    const citation = await services.run(async (runtime) => {
      return runtime.readCitationEvidence(principal, id);
    });
    if (citation === null) {
      throw new WebRequestError(404, "The citation was not found.");
    }
    return citation;
  });

  server.get("/api/citations/:id/image", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const id = decodeResourceId(request.params);
    const image = await services.run(async (runtime) => {
      return runtime.readCitationImage(principal, id);
    });
    if (image === null) {
      throw new WebRequestError(404, "The citation was not found.");
    }
    applyInertDocumentHeaders(reply);
    reply.header("Content-Disposition", "inline");
    return reply.type(image.mediaType).send(image.content);
  });

  server.get("/api/citations/:id/highlighted-file", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const id = decodeResourceId(request.params);
    const document = await services.run(async (runtime) => {
      return runtime.readCitationHighlightedFile(principal, id);
    });
    if (document === null) {
      throw new WebRequestError(
        404,
        "The citation or document version was not found.",
      );
    }
    applyHighlightedDocumentHeaders(reply, document.mediaType);
    reply.header(
      "Content-Disposition",
      buildInlineContentDisposition(document.filename),
    );
    return reply.type(document.mediaType).send(document.content);
  });
}
