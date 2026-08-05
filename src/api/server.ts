import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";

import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fastifyCookie from "@fastify/cookie";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";
import { pipeUIMessageStreamToResponse } from "ai";

import { APP_SECTION_ROUTES } from "./app-routes.js";
import {
  registerAuthenticationRoutes,
  requireAdministratorPrincipal,
  requireRequestPrincipal,
} from "./authentication-routes.js";
import {
  isExpectedRequestCancellation,
  normalizeHttpFailureStatus,
  readHttpErrorCategory,
  readHttpErrorCode,
  readSafeHttpFailureMessage,
} from "./http-failures.js";
import {
  buildDashboardResponse,
  buildDiagnosticResponseChecks,
  type DashboardResponse,
  type HealthResponse,
} from "./dashboard-response.js";
import { registerChatRoutes } from "./chat-routes.js";
import { applyInertDocumentHeaders } from "./inert-document-response.js";
import type {
  ApplicationStateRevisionSnapshot,
} from "../app/application-state-revisions.js";
import {
  ApplicationSettingsRepository,
  type EffectiveApplicationSettings,
} from "../app/settings.js";
import { openDatabase } from "../database/client.js";
import type {
  IngestionControlActor,
  IngestionPhase,
} from "../documents/catalog/index.js";
import type { BrowseDocumentCatalogResult } from "../documents/catalog/browser.js";
import {
  readStartupConfig,
  type AppConfig,
} from "../config/index.js";
import {
  sanitizeDiagnosticMessage,
} from "../observability/application-errors.js";
import {
  SourceDiscoveryScopeError,
  SourceDiscoveryUnavailableError,
} from "../retrieval/discovery/pipeline.js";
import type { SourceDiscoveryResponse } from "../retrieval/discovery/schema.js";
import {
  buildInlineContentDisposition,
  decodeApplicationErrorQuery,
  decodeCreateResearchThreadRequest,
  decodeDiagnosticRequest,
  decodeDocumentVersionComparison,
  decodeDocumentVersionList,
  decodeDocumentCatalogQuery,
  decodeDocumentFileRequest,
  decodeIngestionControlRequest,
  decodeQuestionRequest,
  decodeResearchExportFormat,
  decodeResearchFeedback,
  decodeResearchFeedbackSummary,
  decodeResearchThreadId,
  decodeReindexDocumentRequest,
  decodeResourceId,
  decodeRetryIngestionRequest,
  decodeSpeechRequest,
  decodeUpdateDocumentTagsRequest,
  readTranscriptionRequest,
  readErrorStatus,
  readServerErrorMessage,
  readSourceDiscoveryRequest,
  readUploadedDocuments,
  removeUploadedDocumentStaging,
  WebRequestError,
} from "./request-boundary.js";
import {
  TextToSpeechProviderError,
  TextToSpeechTimeoutError,
  TextToSpeechUnavailableError,
  type GeneratedSpeech,
} from "../providers/text-to-speech.js";
import {
  SpeechToTextProviderError,
  SpeechToTextTimeoutError,
  SpeechToTextUnavailableError,
} from "../providers/speech-to-text.js";
import {
  createDiagnosticRunner,
  startWebServices,
  type WebServices,
} from "./services.js";
import { readWebConfig, type WebConfig } from "./config.js";
import type { AuthenticatedPrincipal } from "../auth/model.js";
import { registerSettingsRoutes } from "./settings-routes.js";

export type {
  ApplicationStateRevisionSignal,
  ApplicationStateRevisionSnapshot,
} from "../app/application-state-revisions.js";
export type {
  DashboardResponse,
  HealthResponse,
} from "./dashboard-response.js";
export type {
  QuestionRequest,
  RetryIngestionRequest,
  UpdateApplicationSettingsRequest,
} from "./request-boundary.js";
export type {
  RuntimeWebServices,
  WebServices,
} from "./services.js";
export type {
  ApplicationSettingsResponse,
  EmbeddingInputFormatResponse,
  RuntimeSettingFieldResponse,
  StartupSettingResponse,
} from "./settings-response.js";

const defaultStaticDirectory = fileURLToPath(new URL("../../web", import.meta.url));
const maximumConfigurableDocumentBytes = 100 * 1_024 * 1_024;

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

export interface BuildWebServerOptions {
  authentication?: "disabled" | "required";
  logger?: FastifyBaseLogger | boolean;
  maximumUploadRequestBytes?: number;
  services?: WebServices;
  staticDirectory?: string | null;
  uploadDirectory?: string;
}

export async function buildWebServer(
  config: AppConfig,
  options: BuildWebServerOptions = {},
): Promise<FastifyInstance> {
  const logger = options.logger ?? true;
  const webConfig = readWebConfig();
  const server = Fastify({ logger, trustProxy: webConfig.trustProxy });
  const authentication = options.authentication ?? "required";
  const maximumUploadRequestBytes = options.maximumUploadRequestBytes
    ?? webConfig.maximumUploadRequestBytes;
  const requestPrincipals = new WeakMap<object, AuthenticatedPrincipal>();
  let services = options.services;
  let closeOwnedServices: (() => Promise<void>) | null = null;
  if (services === undefined) {
    const ownedServices = await startWebServices(config);
    services = ownedServices.services;
    closeOwnedServices = ownedServices.close;
  }
  const runDiagnostics = createDiagnosticRunner(async (runtime, liveChecks) => {
    return runtime.readHealth(liveChecks);
  });
  const uploadDirectory = options.uploadDirectory ?? webConfig.uploadDirectory;
  await services.run(async (runtime) => {
    await runtime.reconcileUploadedDocuments?.(uploadDirectory);
    await runtime.reconcileIngestionCancellations?.();
  });
  let cancellationReconciliation: Promise<void> | null = null;
  const cancellationTimer = setInterval(() => {
    if (cancellationReconciliation !== null) {
      return;
    }
    cancellationReconciliation = services.run(async (runtime) => {
      await runtime.reconcileIngestionCancellations?.();
    }).catch(async (error: unknown) => {
      const result = await services.reportApplicationError(error, {
        category: "background-task",
        code: "ingestion_cancellation_reconciliation_failed",
        instance: hostname(),
        operation: "reconcile-ingestion-cancellations",
        origin: "background-task",
        retryable: true,
        service: "web",
        severity: "error",
      });
      server.log.error(
        { errorId: result.id },
        "Could not reconcile ingestion cancellations.",
      );
    }).finally(() => {
      cancellationReconciliation = null;
    });
  }, 2_000);
  cancellationTimer.unref();
  server.addHook("onClose", async () => {
    clearInterval(cancellationTimer);
    if (cancellationReconciliation !== null) {
      await cancellationReconciliation;
    }
  });
  const chatVerificationController = new AbortController();
  let chatVerificationDispatch: Promise<void> | null = null;
  const dispatchChatVerifications = (): void => {
    if (
      chatVerificationController.signal.aborted
      || chatVerificationDispatch !== null
    ) {
      return;
    }
    chatVerificationDispatch = services.run(async (runtime) => {
      if (runtime.processNextChatVerification === undefined) {
        return;
      }
      let processed = true;
      while (processed && !chatVerificationController.signal.aborted) {
        processed = await runtime.processNextChatVerification(
          chatVerificationController.signal,
        );
      }
    }).catch(async (error: unknown) => {
      if (chatVerificationController.signal.aborted) {
        return;
      }
      const result = await services.reportApplicationError(error, {
        category: "background-task",
        code: "chat_verification_dispatch_failed",
        instance: hostname(),
        operation: "dispatch-chat-verification",
        origin: "background-task",
        retryable: true,
        service: "web",
        severity: "error",
      });
      server.log.error(
        { errorId: result.id },
        "Could not dispatch Chat verification.",
      );
    }).finally(() => {
      chatVerificationDispatch = null;
    });
  };
  const chatVerificationTimer = setInterval(
    dispatchChatVerifications,
    500,
  );
  chatVerificationTimer.unref();
  dispatchChatVerifications();
  server.addHook("onClose", async () => {
    clearInterval(chatVerificationTimer);
    chatVerificationController.abort();
    if (chatVerificationDispatch !== null) {
      await chatVerificationDispatch;
    }
  });
  if (closeOwnedServices !== null) {
    server.addHook("onClose", closeOwnedServices);
  }
  const staticDirectory = options.staticDirectory === undefined
    ? defaultStaticDirectory
    : options.staticDirectory;

  try {
    await server.register(fastifyCookie);
    await server.register(multipart, {
      limits: {
        fieldNameSize: 100,
        fields: 2,
        fieldSize: 2_000,
        fileSize: maximumConfigurableDocumentBytes,
        files: 25,
        parts: 27,
      },
      throwFileSizeLimit: true,
    });
  } catch (error: unknown) {
    await server.close();
    throw error;
  }

  registerAuthenticationRoutes(server, {
    authentication,
    requestPrincipals,
    services,
    webConfig,
  });

  server.get("/api/dashboard", async (): Promise<DashboardResponse> => {
    return services.run(async (runtime) => {
      return buildDashboardResponse(runtime, maximumUploadRequestBytes);
    });
  });

  server.get("/api/errors", async (request) => {
    const principal = requireAdministratorPrincipal(requestPrincipals, request);
    const errorRequest = decodeApplicationErrorQuery(request.query);
    return services.readApplicationErrors(principal, errorRequest);
  });

  server.delete("/api/errors", async (request) => {
    const principal = requireAdministratorPrincipal(requestPrincipals, request);
    return services.purgeApplicationErrors(principal);
  });

  server.get("/api/events", (_request, reply) => {
    reply.hijack();
    openApplicationStateRevisionEventStream(reply.raw, services);
    return reply;
  });

  registerSettingsRoutes(server, {
    config,
    requestPrincipals,
    services,
    webConfig,
  });

  server.get("/api/documents", async (request): Promise<BrowseDocumentCatalogResult> => {
    const catalogRequest = decodeDocumentCatalogQuery(request.query);
    return services.run(async (runtime) => {
      return runtime.browseDocuments(catalogRequest);
    });
  });

  server.get("/api/documents/:documentId/file", async (request, reply) => {
    const documentRequest = decodeDocumentFileRequest(request.params, request.query);
    const document = await services.run(async (runtime) => {
      return runtime.readDocumentFile(documentRequest);
    });
    if (document === null) {
      throw new WebRequestError(404, "The requested document is no longer indexed.");
    }
    applyInertDocumentHeaders(reply);
    reply.header("Content-Disposition", buildInlineContentDisposition(document.filename));
    return reply.type(document.mediaType).send(document.content);
  });

  server.put("/api/documents/:documentId/tags", async (request) => {
    const updateRequest = decodeUpdateDocumentTagsRequest(
      request.params,
      request.body,
    );
    const result = await services.run(async (runtime) => {
      if (runtime.updateDocumentTags === undefined) {
        throw new Error("Document tag updates are not configured.");
      }
      return runtime.updateDocumentTags(updateRequest);
    });
    if (result === null) {
      throw new WebRequestError(404, "The selected document is no longer indexed.");
    }
    return result;
  });

  registerChatRoutes(server, { requestPrincipals, services });

  server.get("/api/research/threads", async () => {
    return services.run(async (runtime) => runtime.listResearchThreads());
  });

  server.post("/api/research/threads", async (request, reply) => {
    const title = decodeCreateResearchThreadRequest(request.body);
    const thread = await services.run(async (runtime) => {
      return runtime.createResearchThread(title);
    });
    return reply.status(201).send(thread);
  });

  server.get("/api/research/threads/:threadId", async (request) => {
    const threadId = decodeResearchThreadId(request.params);
    const thread = await services.run(async (runtime) => {
      return runtime.readResearchThread(threadId);
    });
    if (thread === null) {
      throw new WebRequestError(404, "The research thread was not found.");
    }
    return thread;
  });

  server.delete("/api/research/threads/:threadId", async (request, reply) => {
    const threadId = decodeResearchThreadId(request.params);
    await services.run(async (runtime) => runtime.deleteResearchThread(threadId));
    return reply.status(204).send();
  });

  server.get("/api/research/threads/:threadId/export", async (request, reply) => {
    const threadId = decodeResearchThreadId(request.params);
    const format = decodeResearchExportFormat(request.query);
    const exported = await services.run(async (runtime) => {
      return runtime.exportResearchThread(threadId, format);
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
  });

  server.get("/api/citations/:id", async (request) => {
    const id = decodeResourceId(request.params);
    const citation = await services.run(async (runtime) => {
      return runtime.readCitationEvidence(id);
    });
    if (citation === null) {
      throw new WebRequestError(404, "The citation was not found.");
    }
    return citation;
  });

  server.get("/api/citations/:id/image", async (request, reply) => {
    const id = decodeResourceId(request.params);
    const image = await services.run(async (runtime) => {
      return runtime.readCitationImage(id);
    });
    if (image === null) {
      throw new WebRequestError(404, "The citation was not found.");
    }
    applyInertDocumentHeaders(reply);
    reply.header("Content-Disposition", "inline");
    return reply.type(image.mediaType).send(image.content);
  });

  server.get("/api/citations/:id/highlighted-file", async (request, reply) => {
    const id = decodeResourceId(request.params);
    const document = await services.run(async (runtime) => {
      return runtime.readCitationHighlightedPdf(id);
    });
    if (document === null) {
      throw new WebRequestError(404, "The citation or document version was not found.");
    }
    applyInertDocumentHeaders(reply);
    reply.header("Content-Disposition", buildInlineContentDisposition(document.filename));
    return reply.type(document.mediaType).send(document.content);
  });

  server.get("/api/document-versions", async (request) => {
    const sourceFile = decodeDocumentVersionList(request.query);
    return services.run(async (runtime) => runtime.listDocumentVersions(sourceFile));
  });

  server.get("/api/document-versions/compare", async (request) => {
    const comparison = decodeDocumentVersionComparison(request.query);
    const result = await services.run(async (runtime) => {
      return runtime.compareDocumentVersions(comparison.previous, comparison.current);
    });
    if (result === null) {
      throw new WebRequestError(404, "One or both document versions were not found.");
    }
    return result;
  });

  server.get("/api/document-versions/:id/file", async (request, reply) => {
    const id = decodeResourceId(request.params);
    const document = await services.run(async (runtime) => {
      return runtime.readVersionedDocumentFile(id);
    });
    if (document === null) {
      throw new WebRequestError(404, "The document version was not found.");
    }
    applyInertDocumentHeaders(reply);
    reply.header("Content-Disposition", buildInlineContentDisposition(document.filename));
    return reply.type(document.mediaType).send(document.content);
  });

  server.post("/api/research/feedback", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const feedback = decodeResearchFeedback(request.body);
    const summary = await services.run(async (runtime) => {
      return runtime.addResearchFeedback(feedback, principal.userId);
    });
    return reply.status(200).send(summary);
  });

  server.post("/api/research/feedback-summary", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const feedback = decodeResearchFeedbackSummary(request.body);
    return services.run(async (runtime) => {
      return runtime.readResearchFeedback(
        feedback.turnId,
        feedback.dimension,
        feedback.citationId,
        principal.userId,
      );
    });
  });

  server.post("/api/diagnostics", async (request): Promise<HealthResponse> => {
    requireAdministratorPrincipal(requestPrincipals, request);
    const diagnostics = decodeDiagnosticRequest(request.body);
    const checks = await services.run((runtime) => {
      return runDiagnostics(runtime, diagnostics.liveChecks);
    });
    return {
      checks: buildDiagnosticResponseChecks(checks),
      generatedAt: new Date().toISOString(),
    };
  });

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
          upload.documents,
          upload.options,
          uploadDirectory,
          principal.userId,
        );
      } finally {
        await removeUploadedDocumentStaging(upload);
      }
    });
  });

  server.post("/api/ingestion-jobs/retry", async (request, reply) => {
    const retryRequest = decodeRetryIngestionRequest(request.body);
    const result = await services.run(async (runtime) => {
      return runtime.retryFailedJob(retryRequest.sourceFile);
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
        controlRequest.sourceFile,
        "pause",
        buildIngestionControlActor(principal),
      );
    });
    if (result.kind === "not-found") {
      throw new WebRequestError(404, "The ingestion job was not found.");
    }
    if (result.kind === "forbidden") {
      throw new WebRequestError(403, "Only the uploader or an administrator can pause this ingestion.");
    }
    if (result.kind === "invalid") {
      throw new WebRequestError(409, `This ingestion cannot be paused from ${result.controlState}.`);
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
      throw new WebRequestError(403, "Only the uploader or an administrator can resume this ingestion.");
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
        controlRequest.sourceFile,
        "cancel",
        buildIngestionControlActor(principal),
      );
    });
    if (result.kind === "not-found") {
      throw new WebRequestError(404, "The ingestion job was not found.");
    }
    if (result.kind === "forbidden") {
      throw new WebRequestError(403, "Only the uploader or an administrator can cancel this ingestion.");
    }
    if (result.kind === "invalid") {
      throw new WebRequestError(409, `This ingestion cannot be canceled from ${result.controlState}.`);
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

  server.delete("/api/documents/:documentId", async (request, reply) => {
    requireAdministratorPrincipal(requestPrincipals, request);
    const deletionRequest = decodeReindexDocumentRequest(request.params, request.body);
    const result = await services.run(async (runtime) => {
      if (runtime.deleteIndexedDocument === undefined) {
        throw new Error("Indexed document deletion is not configured.");
      }
      return runtime.deleteIndexedDocument(deletionRequest);
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

  server.post("/api/documents/:documentId/reindex", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const reindexRequest = decodeReindexDocumentRequest(
      request.params,
      request.body,
    );
    const result = await services.run(async (runtime) => {
      return runtime.reindexDocument(
        reindexRequest,
        buildIngestionControlActor(principal),
      );
    });
    if (result.kind === "not-found") {
      throw new WebRequestError(404, "The selected document is no longer indexed.");
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

  server.post("/api/search", async (request, reply): Promise<SourceDiscoveryResponse> => {
    const searchRequest = readSourceDiscoveryRequest(request.body);
    const abortController = new AbortController();
    const abort = (): void => abortController.abort();
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    try {
      return await services.run(async (runtime) => {
        return runtime.searchSources(searchRequest, abortController.signal);
      });
    } catch (error: unknown) {
      if (error instanceof SourceDiscoveryUnavailableError) {
        throw new WebRequestError(503, error.message);
      }
      if (error instanceof SourceDiscoveryScopeError) {
        throw new WebRequestError(409, error.message);
      }
      throw error;
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
    }
  });

  server.post("/api/questions", async (request, reply) => {
    const question = decodeQuestionRequest(request.body);
    const abortController = new AbortController();
    const abort = (): void => abortController.abort();
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    const stream = services.stream((runtime) => {
      return runtime.streamAnswer(question, abortController.signal);
    });
    reply.hijack();
    pipeUIMessageStreamToResponse({ response: reply.raw, stream });
    return reply;
  });

  server.post("/api/speech", async (request, reply) => {
    const speechRequest = decodeSpeechRequest(request.body);
    const abortController = new AbortController();
    const abort = (): void => abortController.abort();
    const cleanup = (): void => {
      request.raw.off("aborted", abort);
      reply.raw.off("close", abort);
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", abort);
    let speech: GeneratedSpeech | null = null;
    let streaming = false;
    try {
      speech = await services.runManaged(async (runtime) => {
        const generated = await runtime.generateSpeech(
          speechRequest,
          abortController.signal,
        );
        return {
          completion: generated.completion,
          value: generated,
        };
      });
      speech.audio.once("close", cleanup);
      speech.audio.once("end", cleanup);
      reply.header("Cache-Control", "private, no-store");
      reply.header("Content-Disposition", "inline");
      reply.header("Content-Type", speech.contentType);
      reply.header("Cross-Origin-Resource-Policy", "same-origin");
      reply.header("X-Content-Type-Options", "nosniff");
      const response = reply.send(speech.audio);
      streaming = true;
      return response;
    } catch (error: unknown) {
      if (error instanceof TextToSpeechUnavailableError) {
        throw new WebRequestError(503, error.message);
      }
      if (error instanceof TextToSpeechTimeoutError) {
        throw new WebRequestError(504, error.message);
      }
      if (error instanceof TextToSpeechProviderError) {
        throw new WebRequestError(502, error.message);
      }
      throw error;
    } finally {
      if (!streaming) {
        abort();
        speech?.audio.destroy();
        cleanup();
      }
    }
  });

  server.post("/api/transcriptions", async (request, reply) => {
    reply.header("Cache-Control", "private, no-store");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("X-Content-Type-Options", "nosniff");
    try {
      return await services.run(async (runtime) => {
        const config = runtime.config.speechToText;
        if (config === null) {
          throw new WebRequestError(503, "Speech-to-text is disabled.");
        }
        const audio = await readTranscriptionRequest(
          request,
          config.maxAudioBytes,
        );
        return runtime.transcribeAudio(audio, request.signal);
      });
    } catch (error: unknown) {
      if (error instanceof SpeechToTextUnavailableError) {
        throw new WebRequestError(503, error.message);
      }
      if (error instanceof SpeechToTextTimeoutError) {
        throw new WebRequestError(504, error.message);
      }
      if (error instanceof SpeechToTextProviderError) {
        throw new WebRequestError(502, error.message);
      }
      throw error;
    }
  });

  server.setErrorHandler(async (error, request, reply) => {
    const statusCode = normalizeHttpFailureStatus(readErrorStatus(error));
    const errorMessage = readServerErrorMessage(error);
    const requestDisconnected = request.raw.destroyed && !request.raw.complete;
    if (isExpectedRequestCancellation(error, requestDisconnected)) {
      return reply.status(499).send({
        error: {
          code: "request_cancelled",
          message: "The request was cancelled.",
        },
      });
    }
    if (statusCode < 500) {
      return reply.status(statusCode).send({
        error: {
          code: "invalid_request",
          message: errorMessage,
        },
      });
    }
    let errorId: string = randomUUID();
    try {
      const principal = requestPrincipals.get(request);
      const result = await services.reportApplicationError(error, {
        category: readHttpErrorCategory(statusCode),
        code: readHttpErrorCode(statusCode),
        instance: hostname(),
        operation: `${request.method} ${request.routeOptions.url}`,
        origin: "http-request",
        requestId: String(request.id),
        retryable: statusCode === 502 || statusCode === 503 || statusCode === 504,
        service: "web",
        severity: "error",
        workspaceId: principal?.workspaceId ?? null,
      });
      errorId = result.id;
    } catch (persistenceError: unknown) {
      server.log.error({
        error: {
          category: "database-operation",
          code: "application_error_persistence_failed",
          eventId: errorId,
          message: sanitizeDiagnosticMessage(
            readServerErrorMessage(persistenceError),
          ),
        },
      });
    }
    reply.status(statusCode).send({
      error: {
        code: readHttpErrorCode(statusCode),
        id: errorId,
        message: readSafeHttpFailureMessage(statusCode),
      },
    });
  });

  if (staticDirectory !== null) {
    try {
      await server.register(fastifyStatic, {
        index: false,
        root: staticDirectory,
      });
    } catch (error: unknown) {
      await server.close();
      throw error;
    }
    server.get("/", async (_request, reply) => {
      return reply.sendFile("index.html");
    });
    for (const route of APP_SECTION_ROUTES) {
      server.get(route, async (_request, reply) => {
        return reply.sendFile("index.html");
      });
    }
  }

  return server;
}

function buildIngestionControlActor(
  principal: AuthenticatedPrincipal,
): IngestionControlActor {
  return {
    isAdministrator: principal.role === "admin",
    userId: principal.userId,
  };
}

export function formatApplicationStateRevisionEvent(
  revisions: ApplicationStateRevisionSnapshot,
): string {
  const id = `${revisions.catalog}.${revisions.jobs}.${revisions.settings}`;
  return `id: ${id}\nevent: revision\ndata: ${JSON.stringify(revisions)}\n\n`;
}

export function openApplicationStateRevisionEventStream(
  response: ServerResponse,
  services: WebServices,
): () => void {
  response.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
  });
  response.write("retry: 1000\n\n");
  let closed = false;
  let reading = false;
  let refreshQueued = false;
  const publish = (): void => {
    refreshQueued = true;
    if (reading || closed) {
      return;
    }
    reading = true;
    void publishQueuedRevisions();
  };
  const publishQueuedRevisions = async (): Promise<void> => {
    try {
      while (refreshQueued && !closed) {
        refreshQueued = false;
        const revisions = await services.readRevisions();
        if (!closed) {
          response.write(formatApplicationStateRevisionEvent(revisions));
        }
      }
    } catch {
      close();
    } finally {
      reading = false;
      if (refreshQueued && !closed) {
        publish();
      }
    }
  };
  const unsubscribe = services.subscribeRevisions(publish);
  const heartbeat = setInterval(() => {
    if (!closed) {
      response.write(": keep-alive\n\n");
    }
  }, 15_000);
  heartbeat.unref();
  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    response.end();
  };
  response.once("close", close);
  publish();
  return close;
}

export async function startWebServer(
  startup = readStartupConfig(),
  webConfig: WebConfig = readWebConfig(),
): Promise<FastifyInstance> {
  const session = await openDatabase(startup.database);
  let effectiveSettings: EffectiveApplicationSettings;
  try {
    const repository = new ApplicationSettingsRepository(session.database);
    effectiveSettings = await repository.read(
      startup.database,
      startup.doclingTopology,
    );
  } finally {
    await session.close();
  }
  const apiOnly = process.argv.includes("--api-only");
  const server = await buildWebServer(effectiveSettings.config, {
    maximumUploadRequestBytes: webConfig.maximumUploadRequestBytes,
    staticDirectory: apiOnly ? null : defaultStaticDirectory,
    uploadDirectory: webConfig.uploadDirectory,
  });
  try {
    await server.listen({ host: webConfig.host, port: webConfig.port });
    return server;
  } catch (error: unknown) {
    await server.close();
    throw error;
  }
}
