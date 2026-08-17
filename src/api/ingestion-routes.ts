import type { FastifyInstance } from "fastify";

import { canAdministerWorkspace } from "../auth/authorization.js";
import type { AuthorizationPrincipal } from "../auth/model.js";
import type {
  IngestionControlActor,
  IngestionPhase,
  RequestIngestionControlResult,
  ResumeIngestionResult,
} from "../documents/catalog/index.js";
import type {
  BulkIngestResult,
  IngestOptions,
  ReindexDocumentRequest,
  ReindexDocumentResult,
  RetryFailedIngestionResult,
  StagedIngestionDocument,
} from "../ingestion/service.js";
import { WorkspaceSourceLibraryUnavailableError } from "../workspaces/source-library-access.js";
import { requireRequestPrincipal } from "./authentication-routes.js";
import {
  decodeIngestionControlRequest,
  decodeReindexDocumentRequest,
  decodeRetryIngestionRequest,
  readUploadedDocuments,
  removeUploadedDocumentStaging,
  WebRequestError,
} from "./request-boundary.js";

export interface RetryIngestionResponse {
  phase: IngestionPhase;
  sourceFile: string;
  state: "pending";
  updatedAt: string;
}

export interface ReindexDocumentResponse {
  documentId: string;
  sourceFile: string;
  status: "queued";
}

export interface IngestionRuntimeServices {
  config: {
    maxDocumentBytes: number;
  };
  ingest: (
    principal: AuthorizationPrincipal,
    documents: readonly StagedIngestionDocument[],
    options: IngestOptions,
    duplicateSourceRoot: string,
    requestedSourceLibraryId: string | null,
  ) => Promise<BulkIngestResult>;
  reindexDocument: (
    principal: AuthorizationPrincipal,
    request: ReindexDocumentRequest,
    actor: IngestionControlActor,
  ) => Promise<ReindexDocumentResult>;
  requestIngestionControl: (
    principal: AuthorizationPrincipal,
    sourceFile: string,
    action: "pause" | "cancel",
    actor: IngestionControlActor,
  ) => Promise<RequestIngestionControlResult>;
  resumeIngestion: (
    principal: AuthorizationPrincipal,
    sourceFile: string,
    actor: IngestionControlActor,
  ) => Promise<ResumeIngestionResult>;
  retryFailedJob: (
    principal: AuthorizationPrincipal,
    sourceFile: string,
  ) => Promise<RetryFailedIngestionResult>;
}

export interface IngestionRouteServices {
  run: <T>(
    operation: (runtime: IngestionRuntimeServices) => Promise<T>,
  ) => Promise<T>;
}

export interface IngestionRouteOptions {
  maximumUploadRequestBytes: number;
  requestPrincipals: WeakMap<object, AuthorizationPrincipal>;
  services: IngestionRouteServices;
  uploadDirectory: string;
}

export function registerIngestionRoutes(
  server: FastifyInstance,
  options: IngestionRouteOptions,
): void {
  const {
    maximumUploadRequestBytes,
    requestPrincipals,
    services,
    uploadDirectory,
  } = options;

  server.post("/api/ingestions", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    return services.run(async (runtime) => {
      const upload = await readUploadedDocuments(
        request,
        uploadDirectory,
        runtime.config.maxDocumentBytes,
        maximumUploadRequestBytes,
      );
      try {
        return await runtime.ingest(
          principal,
          upload.documents,
          upload.options,
          uploadDirectory,
          upload.sourceLibraryId,
        );
      } catch (error: unknown) {
        throw mapIngestionUploadError(error);
      } finally {
        await removeUploadedDocumentStaging(upload);
      }
    });
  });

  server.post("/api/ingestion-jobs/retry", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const retryRequest = decodeRetryIngestionRequest(request.body);
    const result = await services.run(async (runtime) => {
      return runtime.retryFailedJob(principal, retryRequest.sourceFile);
    });
    if (result.kind === "not-found") {
      throw new WebRequestError(
        404,
        `No ingestion job is registered for ${retryRequest.sourceFile}.`,
      );
    }
    if (result.kind === "not-failed") {
      throw new WebRequestError(
        409,
        `Ingestion job is ${result.state}, not failed: ${retryRequest.sourceFile}.`,
      );
    }
    if (result.kind === "restart-rejected") {
      throw new WebRequestError(409, result.error);
    }
    const response: RetryIngestionResponse = {
      phase: result.job.phase,
      sourceFile: result.job.sourceFile,
      state: result.job.state,
      updatedAt: result.job.updatedAt,
    };
    return reply.status(202).send(response);
  });

  server.post("/api/ingestion-jobs/pause", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const controlRequest = decodeIngestionControlRequest(request.body);
    const result = await services.run(async (runtime) => {
      return runtime.requestIngestionControl(
        principal,
        controlRequest.sourceFile,
        "pause",
        buildIngestionControlActor(principal),
      );
    });
    if (result.kind === "not-found") {
      throw new WebRequestError(404, "The ingestion job was not found.");
    }
    if (result.kind === "forbidden") {
      throw new WebRequestError(
        403,
        "Only the uploader or an administrator can pause this ingestion.",
      );
    }
    if (result.kind === "invalid") {
      throw new WebRequestError(
        409,
        `This ingestion cannot be paused from ${result.controlState}.`,
      );
    }
    if (result.kind === "cleanup-failed" || result.kind === "canceled") {
      throw new Error("Pause returned an impossible cancellation result.");
    }
    return reply.status(202).send({
      action: "pause",
      sourceFile: result.job.sourceFile,
      state: result.job.state,
    });
  });

  server.post("/api/ingestion-jobs/resume", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const controlRequest = decodeIngestionControlRequest(request.body);
    const result = await services.run(async (runtime) => {
      return runtime.resumeIngestion(
        principal,
        controlRequest.sourceFile,
        buildIngestionControlActor(principal),
      );
    });
    if (result.kind === "not-found") {
      throw new WebRequestError(404, "The ingestion job was not found.");
    }
    if (result.kind === "not-paused") {
      throw new WebRequestError(409, "The ingestion job is not paused.");
    }
    if (result.kind === "forbidden") {
      throw new WebRequestError(
        403,
        "Only the uploader or an administrator can resume this ingestion.",
      );
    }
    return reply.status(202).send({
      action: "resume",
      sourceFile: result.job.sourceFile,
      state: result.job.state,
    });
  });

  server.post("/api/ingestion-jobs/cancel", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const controlRequest = decodeIngestionControlRequest(request.body);
    const result = await services.run(async (runtime) => {
      return runtime.requestIngestionControl(
        principal,
        controlRequest.sourceFile,
        "cancel",
        buildIngestionControlActor(principal),
      );
    });
    if (result.kind === "not-found") {
      throw new WebRequestError(404, "The ingestion job was not found.");
    }
    if (result.kind === "forbidden") {
      throw new WebRequestError(
        403,
        "Only the uploader or an administrator can cancel this ingestion.",
      );
    }
    if (result.kind === "invalid") {
      throw new WebRequestError(
        409,
        `This ingestion cannot be canceled from ${result.controlState}.`,
      );
    }
    if (result.kind === "cleanup-failed") {
      throw new WebRequestError(500, result.error);
    }
    if (result.kind === "canceled") {
      return reply.status(200).send({
        action: "cancel",
        sourceFile: result.sourceFile,
        state: "canceled",
      });
    }
    return reply.status(202).send({
      action: "cancel",
      sourceFile: result.job.sourceFile,
      state: result.job.controlState,
    });
  });

  server.post("/api/documents/:documentId/reindex", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const reindexRequest = decodeReindexDocumentRequest(
      request.params,
      request.body,
    );
    const result = await services.run(async (runtime) => {
      return runtime.reindexDocument(
        principal,
        reindexRequest,
        buildIngestionControlActor(principal),
      );
    });
    if (result.kind === "not-found") {
      throw new WebRequestError(
        404,
        "The selected document is no longer indexed.",
      );
    }
    if (result.kind === "rejected") {
      throw new WebRequestError(409, result.error);
    }
    const response: ReindexDocumentResponse = {
      documentId: result.documentId,
      sourceFile: result.sourceFile,
      status: "queued",
    };
    return reply.status(202).send(response);
  });
}

function mapIngestionUploadError(error: unknown): unknown {
  if (error instanceof WorkspaceSourceLibraryUnavailableError) {
    return new WebRequestError(404, error.message);
  }
  return error;
}

function buildIngestionControlActor(
  principal: AuthorizationPrincipal,
): IngestionControlActor {
  return {
    isAdministrator: canAdministerWorkspace(principal, principal.workspaceId),
    userId: principal.userId,
  };
}
