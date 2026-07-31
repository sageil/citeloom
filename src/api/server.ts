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
  type FastifyReply,
} from "fastify";
import { pipeUIMessageStreamToResponse } from "ai";

import { APP_SECTION_ROUTES } from "./app-routes.js";
import type {
  ApplicationStateRevisionSnapshot,
} from "../app/application-state-revisions.js";
import {
  ApplicationSettingsRepository,
  type EffectiveApplicationSettings,
  SettingsValidationError,
  SettingsVersionConflictError,
} from "../app/settings.js";
import { openDatabase } from "../database/client.js";
import type {
  IngestionControlActor,
  IngestionPhase,
} from "../documents/catalog/index.js";
import {
  DEFAULT_DOCUMENT_CATALOG_REQUEST,
  type BrowseDocumentCatalogResult,
  type DocumentCatalogFacets,
} from "../documents/catalog/browser.js";
import {
  readStartupConfig,
  type AppConfig,
} from "../config/index.js";
import { SUPPORTED_DOCUMENT_EXTENSIONS } from "../documents/format.js";
import type { DoctorCheck } from "../observability/doctor.js";
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
  decodeApplicationSettingsUpdate,
  decodeCopyEmbeddingInputFormatRequest,
  decodeChatConversationId,
  decodeCreateChatConversationRequest,
  decodeCreateChatMessageRequest,
  decodeCreateResearchThreadRequest,
  decodeDocumentVersionComparison,
  decodeDocumentVersionList,
  decodeDocumentCatalogQuery,
  decodeDocumentFileRequest,
  decodeEmbeddingInputFormatDefinition,
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
  type RuntimeWebServices,
  type WebServices,
} from "./services.js";
import {
  buildApplicationSettingsResponse,
  type ApplicationSettingsResponse,
} from "./settings-response.js";
import { readWebConfig, type WebConfig } from "./config.js";
import type { TelemetryDashboardSummary } from "../observability/store.js";
import type { SystemStatus } from "../ingestion/worker.js";
import {
  decodeLoginInput,
  decodeChangePasswordInput,
  decodePasswordSetupInput,
  decodeCreateWorkspaceMemberInput,
  decodeWorkspaceMemberId,
  decodeWorkspaceMemberRoleInput,
} from "../auth/boundary.js";
import type { AuthenticatedPrincipal } from "../auth/model.js";
import {
  AuthenticationRejectedError,
  FinalWorkspaceAdministratorError,
  SetupTokenRejectedError,
  UsernameUnavailableError,
  WorkspaceAuthorizationError,
  WorkspaceMemberNotFoundError,
} from "../auth/store.js";
import {
  LoginRateLimiter,
  LoginRateLimitExceededError,
} from "../auth/rate-limit.js";
import {
  OpenAICodexAuthenticationRequiredError,
  OpenAICodexProviderInUseError,
} from "../providers/openai-codex-credentials.js";
import {
  OpenAICodexDeviceAuthController,
} from "../providers/openai-codex-device-auth.js";
import { OpenAICodexOAuthError } from "../providers/openai-codex-oauth.js";
import {
  EmbeddingInputFormatInUseError,
  EmbeddingInputFormatNotFoundError,
} from "../embedding/input-format-store.js";

export type {
  ApplicationStateRevisionSignal,
  ApplicationStateRevisionSnapshot,
} from "../app/application-state-revisions.js";
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
const inertDocumentContentSecurityPolicy = [
  "sandbox",
  "default-src 'none'",
  "script-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "img-src data:",
  "style-src 'unsafe-inline'",
].join("; ");
const PUBLIC_LOGIN_WEB_PATHS = new Set([
  "/assets/fonts/citeloom-space-grotesk-latin-ext.woff2",
  "/assets/fonts/citeloom-space-grotesk-latin.woff2",
  "/assets/fonts/citeloom-space-grotesk-vietnamese.woff2",
  "/assets/images/citeloom-icons.svg",
  "/assets/images/citeloom-mark.png",
  "/assets/images/citeloom-particle-flow.svg",
  "/assets/scripts/citeloom-app.js",
  "/assets/scripts/citeloom-bootstrap.js",
  "/assets/scripts/citeloom-boundaries.js",
  "/assets/scripts/citeloom-dashboard-extensions.js",
  "/assets/scripts/citeloom-document-notifications.js",
  "/assets/scripts/citeloom-login.js",
  "/assets/scripts/citeloom-notices.js",
  "/assets/styles/citeloom-base.css",
  "/assets/styles/citeloom-login.css",
  "/assets/styles/citeloom-navigation.css",
  "/assets/styles/citeloom-shell.css",
  "/fragments/login.html",
  "/login",
]);
const ADMINISTRATOR_WEB_PATHS = new Set([
  "/errors",
  "/fragments/errors.html",
]);

export interface DashboardResponse {
  catalog: BrowseDocumentCatalogResult;
  documentSummary: DocumentCatalogFacets;
  embeddingSpace: {
    dimensions: number;
    id: string;
    inputFormatHash: string;
    inputFormatName: string;
    model: string;
    retrievalWindowPolicyFingerprint: string;
    retrievalWindowPolicyId: string;
  };
  features: {
    speechToText: boolean;
    textToSpeech: boolean;
    textToSpeechPreload: boolean;
  };
  generatedAt: string;
  revisions: ApplicationStateRevisionSnapshot;
  inferenceRuntime: {
    answerModel: string;
    claimVerifier: {
      model: string;
      name: string;
    };
    name: string;
    queryExpansionModel: string;
    reranker: {
      model: string;
      name: string;
    } | null;
    summaryModel: string;
  };
  maximumUploadRequestBytes: number;
  maximumDocumentBytes: number;
  supportedExtensions: readonly string[];
  system: SystemStatus;
  telemetry: TelemetryDashboardSummary;
}

export interface HealthResponse {
  checks: DiagnosticResponseCheck[];
  generatedAt: string;
}

interface DiagnosticResponseCheck extends DoctorCheck {
  id: string;
}

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
  const loginRateLimiter = new LoginRateLimiter();
  let services = options.services;
  let closeOwnedServices: (() => Promise<void>) | null = null;
  if (services === undefined) {
    const ownedServices = await startWebServices(config);
    services = ownedServices.services;
    closeOwnedServices = ownedServices.close;
  }
  const openAICodexDeviceAuth = new OpenAICodexDeviceAuthController({
    persistCredentials: async (credentials) => {
      await services.openAICodex.replaceCredentials(credentials);
    },
  });
  server.addHook("onClose", async () => openAICodexDeviceAuth.close());
  const runDiagnostics = createDiagnosticRunner(async (runtime) => {
    return runtime.readHealth();
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

  server.addHook("onRequest", async (request, reply) => {
    if (authentication === "disabled") {
      requestPrincipals.set(request, disabledAuthenticationPrincipal);
      return;
    }
    const pathname = readRequestPathname(request.url);
    if (!pathname.startsWith("/api/")) {
      if (PUBLIC_LOGIN_WEB_PATHS.has(pathname)) {
        return;
      }
      const principal = await readRequestSession(request.cookies, reply, services, webConfig);
      if (principal === null) {
        return reply.redirect("/login");
      }
      if (
        ADMINISTRATOR_WEB_PATHS.has(pathname)
        && principal.role !== "admin"
      ) {
        throw new WebRequestError(
          403,
          "Workspace administrator access is required.",
        );
      }
      requestPrincipals.set(request, principal);
      return;
    }
    if (isPublicAuthenticationPath(pathname)) {
      requireSameOriginForMutation(request.method, request.headers.origin, webConfig);
      return;
    }
    const principal = await readRequestSession(request.cookies, reply, services, webConfig);
    if (principal === null) {
      return reply.status(401).send({
        error: { message: "Authentication is required." },
      });
    }
    requireSameOriginForMutation(request.method, request.headers.origin, webConfig);
    requestPrincipals.set(request, principal);
  });

  server.post("/api/auth/login", async (request, reply) => {
    const login = decodeLoginInput(request.body);
    try {
      loginRateLimiter.check(request.ip, login.usernameNormalized);
      const session = await services.authenticate(login);
      loginRateLimiter.recordSuccess(login.usernameNormalized);
      setSessionCookie(reply, session.token, session.expiresAt, webConfig);
      return buildSessionResponse(session.principal, session.expiresAt);
    } catch (error: unknown) {
      if (error instanceof AuthenticationRejectedError) {
        loginRateLimiter.recordFailure(request.ip, login.usernameNormalized);
        throw new WebRequestError(401, error.message);
      }
      if (error instanceof LoginRateLimitExceededError) {
        throw new WebRequestError(429, error.message);
      }
      throw error;
    }
  });

  server.post("/api/auth/setup", async (request, reply) => {
    const setup = decodePasswordSetupInput(request.body);
    try {
      const session = await services.completePasswordSetup(
        setup.setupToken,
        setup.password,
      );
      setSessionCookie(reply, session.token, session.expiresAt, webConfig);
      return buildSessionResponse(session.principal, session.expiresAt);
    } catch (error: unknown) {
      if (error instanceof SetupTokenRejectedError) {
        throw new WebRequestError(400, error.message);
      }
      throw error;
    }
  });

  server.get("/api/auth/session", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    return buildSessionResponse(principal, null);
  });

  server.post("/api/auth/logout", async (request, reply) => {
    const sessionToken = request.cookies[readSessionCookieName(webConfig)];
    if (sessionToken !== undefined) {
      await services.revokeSession(sessionToken);
    }
    clearSessionCookie(reply, webConfig);
    return reply.status(204).send();
  });

  server.put("/api/auth/password", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const passwords = decodeChangePasswordInput(request.body);
    try {
      await services.changePassword(
        principal,
        passwords.currentPassword,
        passwords.newPassword,
      );
      return reply.status(204).send();
    } catch (error: unknown) {
      if (error instanceof AuthenticationRejectedError) {
        throw new WebRequestError(401, "The current password is incorrect.");
      }
      throw error;
    }
  });

  server.post("/api/workspace/members", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const member = decodeCreateWorkspaceMemberInput(request.body);
    try {
      const setup = await services.createWorkspaceMember(
        principal,
        member.identity,
        member.role,
      );
      return reply.status(201).send(setup);
    } catch (error: unknown) {
      if (error instanceof WorkspaceAuthorizationError) {
        throw new WebRequestError(403, error.message);
      }
      if (error instanceof UsernameUnavailableError) {
        throw new WebRequestError(409, error.message);
      }
      throw error;
    }
  });

  server.get("/api/workspace/members", async (request) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    try {
      return await services.listWorkspaceMembers(principal);
    } catch (error: unknown) {
      throw mapWorkspaceMembershipError(error);
    }
  });

  server.put("/api/workspace/members/:userId/role", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const userId = decodeWorkspaceMemberId(request.params);
    const role = decodeWorkspaceMemberRoleInput(request.body);
    try {
      await services.changeWorkspaceMemberRole(principal, userId, role);
      return reply.status(204).send();
    } catch (error: unknown) {
      throw mapWorkspaceMembershipError(error);
    }
  });

  server.post("/api/workspace/members/:userId/password-reset", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const userId = decodeWorkspaceMemberId(request.params);
    try {
      const reset = await services.createPasswordReset(principal, userId);
      return reply.status(201).send(reset);
    } catch (error: unknown) {
      throw mapWorkspaceMembershipError(error);
    }
  });

  server.delete("/api/workspace/members/:userId", async (request, reply) => {
    const principal = requireRequestPrincipal(requestPrincipals, request);
    const userId = decodeWorkspaceMemberId(request.params);
    try {
      await services.removeWorkspaceMember(principal, userId);
      return reply.status(204).send();
    } catch (error: unknown) {
      throw mapWorkspaceMembershipError(error);
    }
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

  server.get("/api/events", (_request, reply) => {
    reply.hijack();
    openApplicationStateRevisionEventStream(reply.raw, services);
    return reply;
  });

  server.get("/api/settings", async (request): Promise<ApplicationSettingsResponse> => {
    requireAdministratorPrincipal(requestPrincipals, request);
    const settings = await services.readSettings();
    return buildApplicationSettingsResponse(settings, config, webConfig);
  });

  server.post("/api/embedding-input-formats", async (request, reply) => {
    requireAdministratorPrincipal(requestPrincipals, request);
    const definition = decodeEmbeddingInputFormatDefinition(request.body);
    const format = await services.createEmbeddingInputFormat(definition);
    return reply.status(201).send({ id: format.id });
  });

  server.post(
    "/api/embedding-input-formats/:id/copies",
    async (request, reply) => {
      requireAdministratorPrincipal(requestPrincipals, request);
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
      requireAdministratorPrincipal(requestPrincipals, request);
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
    requireAdministratorPrincipal(requestPrincipals, request);
    const id = decodeResourceId(request.params);
    try {
      const format = await services.retireEmbeddingInputFormat(id);
      return { id: format.id };
    } catch (error: unknown) {
      throw mapEmbeddingInputFormatError(error);
    }
  });

  server.put("/api/settings", async (request): Promise<ApplicationSettingsResponse> => {
    requireAdministratorPrincipal(requestPrincipals, request);
    const settingsRequest = decodeApplicationSettingsUpdate(request.body);
    let settings: EffectiveApplicationSettings;
    try {
      settings = await services.updateSettings(settingsRequest);
    } catch (error: unknown) {
      if (error instanceof SettingsVersionConflictError) {
        throw new WebRequestError(409, error.message);
      }
      if (error instanceof SettingsValidationError) {
        throw new WebRequestError(400, error.message);
      }
      throw error;
    }
    return buildApplicationSettingsResponse(settings, config, webConfig);
  });

  server.get("/api/providers/openai-codex/auth", async (request, reply) => {
    requireAdministratorPrincipal(requestPrincipals, request);
    reply.header("Cache-Control", "private, no-store");
    const connection = await services.openAICodex.readConnectionState();
    return {
      connection,
      flow: openAICodexDeviceAuth.readStatus(),
    };
  });

  server.post(
    "/api/providers/openai-codex/device-authorization",
    async (request, reply) => {
      requireAdministratorPrincipal(requestPrincipals, request);
      reply.header("Cache-Control", "private, no-store");
      try {
        const flow = await openAICodexDeviceAuth.start();
        return reply.status(201).send(flow);
      } catch (error: unknown) {
        throw mapOpenAICodexError(error);
      }
    },
  );

  server.delete(
    "/api/providers/openai-codex/device-authorization",
    async (request, reply) => {
      requireAdministratorPrincipal(requestPrincipals, request);
      reply.header("Cache-Control", "private, no-store");
      const flow = await openAICodexDeviceAuth.cancel();
      return { flow };
    },
  );

  server.delete(
    "/api/providers/openai-codex/auth",
    async (request, reply) => {
      requireAdministratorPrincipal(requestPrincipals, request);
      reply.header("Cache-Control", "private, no-store");
      await openAICodexDeviceAuth.cancel();
      try {
        await services.openAICodex.disconnect();
      } catch (error: unknown) {
        throw mapOpenAICodexError(error);
      }
      return reply.status(204).send();
    },
  );

  server.get(
    "/api/providers/openai-codex/models",
    async (request, reply) => {
      requireAdministratorPrincipal(requestPrincipals, request);
      reply.header("Cache-Control", "private, no-store");
      try {
        const models = await services.openAICodex.readModels(
          AbortSignal.timeout(30_000),
        );
        return { models };
      } catch (error: unknown) {
        throw mapOpenAICodexError(error);
      }
    },
  );

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

  server.get("/api/chat/conversations/:conversationId", async (request, reply) => {
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
  });

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
      try {
        const response = await services.run(async (runtime) => {
          if (runtime.answerChatMessage === undefined) {
            throw new Error("Chat generation is not configured.");
          }
          return runtime.answerChatMessage(
            principal,
            {
              content: input.content,
              conversationId,
              requestId: input.requestId,
            },
            abortController.signal,
          );
        });
        reply.header("Cache-Control", "private, no-store");
        return reply.status(201).send(response);
      } finally {
        request.raw.off("aborted", abort);
        reply.raw.off("close", abort);
      }
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
        if (runtime.readChatCitationHighlightedPdf === undefined) {
          throw new Error("Chat highlighted citations are not configured.");
        }
        return runtime.readChatCitationHighlightedPdf(principal, id);
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
    },
  );

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
    const checks = await services.run(runDiagnostics);
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
    if (isExpectedRequestCancellation(error, request.raw.aborted)) {
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

function isExpectedRequestCancellation(
  error: unknown,
  requestAborted: boolean,
): boolean {
  if (requestAborted) {
    return true;
  }
  const pending: unknown[] = [error];
  const visited = new Set<Error>();
  while (pending.length > 0 && visited.size < 16) {
    const current = pending.pop();
    if (!(current instanceof Error) || visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (
      current.name === "AbortError"
      || current.name === "RequestAbortedError"
      || current.name === "ClientClosedRequestError"
    ) {
      return true;
    }
    if (current.cause !== undefined) {
      pending.push(current.cause);
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
  }
  return false;
}

function readHttpErrorCategory(statusCode: number): string {
  if (statusCode === 502) {
    return "dependency-bad-gateway";
  }
  if (statusCode === 503) {
    return "dependency-unavailable";
  }
  if (statusCode === 504) {
    return "dependency-timeout";
  }
  return "unexpected-internal";
}

function normalizeHttpFailureStatus(statusCode: number): number {
  if (statusCode < 500) {
    return statusCode;
  }
  if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return statusCode;
  }
  return 500;
}

function readHttpErrorCode(statusCode: number): string {
  if (statusCode === 502) {
    return "dependency_bad_gateway";
  }
  if (statusCode === 503) {
    return "dependency_unavailable";
  }
  if (statusCode === 504) {
    return "dependency_timeout";
  }
  return "internal_error";
}

function readSafeHttpFailureMessage(statusCode: number): string {
  if (statusCode === 502) {
    return "A required dependency returned an invalid response.";
  }
  if (statusCode === 503) {
    return "A required service is unavailable.";
  }
  if (statusCode === 504) {
    return "A required service did not respond in time.";
  }
  return "The request could not be completed.";
}

function isPublicAuthenticationPath(pathname: string): boolean {
  return pathname === "/api/auth/login" || pathname === "/api/auth/setup";
}

function readRequestPathname(url: string): string {
  return url.split("?", 1)[0] ?? url;
}

async function readRequestSession(
  cookies: Record<string, string | undefined>,
  reply: FastifyReply,
  services: Pick<WebServices, "readSession">,
  webConfig: WebConfig,
): Promise<AuthenticatedPrincipal | null> {
  const sessionToken = cookies[readSessionCookieName(webConfig)];
  if (sessionToken === undefined) {
    return null;
  }
  const principal = await services.readSession(sessionToken);
  if (principal === null) {
    clearSessionCookie(reply, webConfig);
  }
  return principal;
}

const disabledAuthenticationPrincipal: AuthenticatedPrincipal = {
  displayName: "Disabled authentication",
  role: "admin",
  sessionTokenDigest: "0".repeat(64),
  userId: "00000000-0000-4000-8000-000000000000",
  username: "disabled-authentication",
  workspaceId: "00000000-0000-4000-8000-000000000000",
  workspaceName: "Disabled authentication",
};

function requireSameOriginForMutation(
  method: string,
  origin: string | undefined,
  webConfig: WebConfig,
): void {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return;
  }
  if (origin !== webConfig.publicOrigin) {
    throw new WebRequestError(403, "The request origin is not allowed.");
  }
}

function readSessionCookieName(webConfig: WebConfig): string {
  return webConfig.secureSessionCookie
    ? "__Host-citeloom_session"
    : "citeloom_session";
}

function setSessionCookie(
  reply: FastifyReply,
  sessionToken: string,
  expiresAt: string,
  webConfig: WebConfig,
): void {
  reply.setCookie(readSessionCookieName(webConfig), sessionToken, {
    expires: new Date(expiresAt),
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure: webConfig.secureSessionCookie,
  });
  reply.header("Cache-Control", "no-store");
}

function clearSessionCookie(reply: FastifyReply, webConfig: WebConfig): void {
  reply.clearCookie(readSessionCookieName(webConfig), {
    httpOnly: true,
    path: "/",
    sameSite: "strict",
    secure: webConfig.secureSessionCookie,
  });
  reply.header("Cache-Control", "no-store");
}

function applyInertDocumentHeaders(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Content-Security-Policy", inertDocumentContentSecurityPolicy);
  reply.header("Cross-Origin-Resource-Policy", "same-origin");
  reply.header("X-Content-Type-Options", "nosniff");
}

function requireRequestPrincipal<T extends object>(
  principals: WeakMap<object, AuthenticatedPrincipal>,
  request: T,
): AuthenticatedPrincipal {
  const principal = principals.get(request);
  if (principal === undefined) {
    throw new WebRequestError(401, "Authentication is required.");
  }
  return principal;
}

function requireAdministratorPrincipal<T extends object>(
  principals: WeakMap<object, AuthenticatedPrincipal>,
  request: T,
): AuthenticatedPrincipal {
  const principal = requireRequestPrincipal(principals, request);
  if (principal.role !== "admin") {
    throw new WebRequestError(403, "Workspace administrator access is required.");
  }
  return principal;
}

function buildIngestionControlActor(
  principal: AuthenticatedPrincipal,
): IngestionControlActor {
  return {
    isAdministrator: principal.role === "admin",
    userId: principal.userId,
  };
}

function buildSessionResponse(
  principal: AuthenticatedPrincipal,
  expiresAt: string | null,
): {
  expiresAt: string | null;
  user: { displayName: string; id: string; username: string };
  workspace: { id: string; name: string; role: "admin" | "member" };
} {
  return {
    expiresAt,
    user: {
      displayName: principal.displayName,
      id: principal.userId,
      username: principal.username,
    },
    workspace: {
      id: principal.workspaceId,
      name: principal.workspaceName,
      role: principal.role,
    },
  };
}

function mapWorkspaceMembershipError(error: unknown): unknown {
  if (error instanceof WorkspaceAuthorizationError) {
    return new WebRequestError(403, error.message);
  }
  if (error instanceof WorkspaceMemberNotFoundError) {
    return new WebRequestError(404, error.message);
  }
  if (error instanceof FinalWorkspaceAdministratorError) {
    return new WebRequestError(409, error.message);
  }
  return error;
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

function mapOpenAICodexError(error: unknown): unknown {
  if (
    error instanceof OpenAICodexAuthenticationRequiredError
    || error instanceof OpenAICodexProviderInUseError
  ) {
    return new WebRequestError(409, error.message);
  }
  if (error instanceof OpenAICodexOAuthError) {
    return new WebRequestError(502, error.message);
  }
  return error;
}

function buildDiagnosticResponseChecks(
  checks: readonly DoctorCheck[],
): DiagnosticResponseCheck[] {
  const responseChecks: DiagnosticResponseCheck[] = [];
  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index];
    if (check === undefined) {
      continue;
    }
    responseChecks.push({
      ...check,
      id: `diagnostic-${index + 1}`,
    });
  }
  return responseChecks;
}

async function buildDashboardResponse(
  runtime: RuntimeWebServices,
  maximumUploadRequestBytes: number,
): Promise<DashboardResponse> {
  const effectiveConfig = runtime.config;
  const [catalog, revisions, system, telemetry] = await Promise.all([
    runtime.browseDocuments(DEFAULT_DOCUMENT_CATALOG_REQUEST),
    runtime.readRevisions(),
    runtime.readStatus(),
    runtime.readTelemetry(),
  ]);
  let reranker: DashboardResponse["inferenceRuntime"]["reranker"] = null;
  if (effectiveConfig.retrieval.reranker !== null) {
    reranker = {
      model: effectiveConfig.retrieval.reranker.model,
      name: effectiveConfig.retrieval.reranker.runtimeName,
    };
  }
  return {
    catalog,
    documentSummary: catalog.facets,
    embeddingSpace: {
      dimensions: effectiveConfig.embeddingSpace.dimensions,
      id: effectiveConfig.embeddingSpace.id,
      inputFormatHash:
        effectiveConfig.embeddingSpace.inputFormat.inputFormatHash,
      inputFormatName: effectiveConfig.embeddingSpace.inputFormat.name,
      model: effectiveConfig.embeddingSpace.model,
      retrievalWindowPolicyFingerprint:
        effectiveConfig.embeddingSpace.retrievalWindow.fingerprint,
      retrievalWindowPolicyId:
        effectiveConfig.embeddingSpace.retrievalWindow.policy.id,
    },
    features: {
      speechToText: effectiveConfig.speechToText !== null,
      textToSpeech: effectiveConfig.textToSpeech !== null,
      textToSpeechPreload: effectiveConfig.textToSpeech?.preload ?? false,
    },
    generatedAt: new Date().toISOString(),
    revisions,
    inferenceRuntime: {
      answerModel: effectiveConfig.inference.answer.model,
      claimVerifier: {
        model: effectiveConfig.claimVerifier.model,
        name: effectiveConfig.claimVerifier.runtimeName,
      },
      name: effectiveConfig.inference.answer.runtimeName,
      queryExpansionModel: effectiveConfig.inference.queryExpansion.model,
      reranker,
      summaryModel: effectiveConfig.inference.summary.model,
    },
    maximumDocumentBytes: effectiveConfig.maxDocumentBytes,
    maximumUploadRequestBytes,
    supportedExtensions: SUPPORTED_DOCUMENT_EXTENSIONS,
    system,
    telemetry,
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
