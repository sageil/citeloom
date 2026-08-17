import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import multipart from "@fastify/multipart";
import fastifyCookie from "@fastify/cookie";
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
} from "fastify";

import { registerAnswerRoutes } from "./answer-routes.js";
import { registerAuthenticationRoutes } from "./authentication-routes.js";
import {
  DEFAULT_BROWSER_STATIC_DIRECTORY,
  registerBrowserApplicationRoutes,
} from "./browser-application-routes.js";
import { BROWSER_CONTENT_SECURITY_POLICY } from "./browser-security.js";
import {
  isExpectedRequestCancellation,
  normalizeHttpFailureStatus,
  readHttpErrorCategory,
  readHttpErrorCode,
  readSafeHttpFailureMessage,
} from "./http-failures.js";
import { registerChatRoutes } from "./chat-routes.js";
import { registerCitationRoutes } from "./citation-routes.js";
import { registerDocumentCatalogRoutes } from "./document-catalog-routes.js";
import { registerDocumentVersionRoutes } from "./document-version-routes.js";
import {
  registerEmbeddingInputFormatRoutes,
} from "./embedding-input-format-routes.js";
import { registerIngestionRoutes } from "./ingestion-routes.js";
import { registerObservabilityRoutes } from "./observability-routes.js";
import { registerOpenAICodexRoutes } from "./openai-codex-routes.js";
import { registerResearchFeedbackRoutes } from "./research-feedback-routes.js";
import { registerResearchThreadRoutes } from "./research-thread-routes.js";
import { registerSourceDiscoveryRoutes } from "./source-discovery-routes.js";
import { registerSpeechRoutes } from "./speech-routes.js";
import {
  ApplicationSettingsRepository,
  type EffectiveApplicationSettings,
} from "../app/settings.js";
import { openDatabase } from "../database/client.js";
import {
  readStartupConfig,
  type AppConfig,
} from "../config/index.js";
import {
  sanitizeDiagnosticMessage,
} from "../observability/application-errors.js";
import {
  readErrorStatus,
  readServerErrorMessage,
} from "./request-boundary.js";
import {
  createDiagnosticRunner,
  startWebServices,
  type AuthenticationSecurityWebServices,
  type SecurityWebServices,
  type WebServices,
} from "./services.js";
import {
  buildWebConfig,
  readWebStartupConfig,
  type WebConfig,
  type WebStartupConfig,
} from "./config.js";
import type { AuthorizationPrincipal } from "../auth/model.js";
import { registerSettingsRoutes } from "./settings-routes.js";
import { registerSourceContentStorageRoutes } from "./source-content-storage-routes.js";
import { registerSecurityRoutes } from "./security-routes.js";
import { registerAuthenticationSecurityRoutes } from "./authentication-security-routes.js";
import { registerOAuthProtectedResourceMetadata } from "./oauth-authentication.js";
import {
  createApplicationOAuthRequestAuthenticator,
  type ApplicationOAuthRequestAuthenticator,
} from "./application-authentication.js";
import { registerMcpRoutes } from "../mcp/server.js";

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
  AuthenticationSecurityWebServices,
  RuntimeWebServices,
  SecurityWebServices,
  WebServices,
} from "./services.js";
export type {
  ApplicationSettingsResponse,
  EmbeddingInputFormatResponse,
  RuntimeSettingFieldResponse,
  StartupSettingResponse,
} from "./settings-response.js";
export type {
  ReindexDocumentResponse,
  RetryIngestionResponse,
} from "./ingestion-routes.js";
export {
  formatApplicationStateRevisionEvent,
  openApplicationStateRevisionEventStream,
} from "./observability-routes.js";

const maximumConfigurableDocumentBytes = 100 * 1_024 * 1_024;

export interface BuildWebServerOptions {
  authentication?: "disabled" | "required";
  authenticationSecurityServices?: AuthenticationSecurityWebServices;
  logger?: FastifyBaseLogger | boolean;
  maximumUploadRequestBytes?: number;
  oauthAuthenticator?: ApplicationOAuthRequestAuthenticator;
  securityServices?: SecurityWebServices;
  services?: WebServices;
  staticDirectory?: string | null;
  uploadDirectory?: string;
  webConfig?: WebConfig;
}

const BACKGROUND_DELETION_RECONCILIATION_INTERVAL_MS = 2_000;

export async function buildWebServer(
  config: AppConfig,
  options: BuildWebServerOptions = {},
): Promise<FastifyInstance> {
  const logger = options.logger ?? true;
  const webConfig = options.webConfig ?? buildWebConfig(config.web);
  const server = Fastify({ logger, trustProxy: webConfig.trustProxy });
  server.addHook("onRequest", async (_request, reply) => {
    reply.header("Content-Security-Policy", BROWSER_CONTENT_SECURITY_POLICY);
  });
  const authentication = options.authentication ?? "required";
  const maximumUploadRequestBytes = options.maximumUploadRequestBytes
    ?? webConfig.maximumUploadRequestBytes;
  const requestPrincipals = new WeakMap<object, AuthorizationPrincipal>();
  let services = options.services;
  let authenticationSecurityServices =
    options.authenticationSecurityServices ?? null;
  let securityServices = options.securityServices ?? null;
  let closeOwnedServices: (() => Promise<void>) | null = null;
  if (services === undefined) {
    const ownedServices = await startWebServices(config);
    services = ownedServices.services;
    authenticationSecurityServices ??= ownedServices.services;
    securityServices ??= ownedServices.services;
    closeOwnedServices = ownedServices.close;
  }
  const runDiagnostics = createDiagnosticRunner(async (runtime, liveChecks) => {
    return runtime.readHealth(liveChecks);
  });
  const uploadDirectory = options.uploadDirectory ?? webConfig.uploadDirectory;
  await services.run(async (runtime) => {
    await runtime.reconcileUploadedDocuments(uploadDirectory);
    await runtime.reconcileIngestionCancellations();
  });
  let deletionReconciliation: Promise<void> | null = null;
  const deletionTimer = setInterval(() => {
    if (deletionReconciliation !== null) {
      return;
    }
    deletionReconciliation = services.run(async (runtime) => {
      await runtime.reconcileIngestionCancellations();
      await runtime.reconcileSourceLibraryDeletions();
    }).catch(async (error: unknown) => {
      const result = await services.reportApplicationError(error, {
        category: "background-task",
        code: "background_deletion_reconciliation_failed",
        instance: hostname(),
        operation: "reconcile-background-deletions",
        origin: "background-task",
        retryable: true,
        service: "web",
        severity: "error",
      });
      server.log.error(
        { errorId: result.id },
        "Could not reconcile background deletions.",
      );
    }).finally(() => {
      deletionReconciliation = null;
    });
  }, BACKGROUND_DELETION_RECONCILIATION_INTERVAL_MS);
  deletionTimer.unref();
  server.addHook("onClose", async () => {
    clearInterval(deletionTimer);
    if (deletionReconciliation !== null) {
      await deletionReconciliation;
    }
  });
  const verificationController = new AbortController();
  let verificationDispatch: Promise<void> | null = null;
  const dispatchVerifications = (): void => {
    if (
      verificationController.signal.aborted
      || verificationDispatch !== null
    ) {
      return;
    }
    verificationDispatch = services.run(async (runtime) => {
      let processed = true;
      while (processed && !verificationController.signal.aborted) {
        const researchProcessed = await runtime.processNextResearchVerification(
          verificationController.signal,
        );
        const chatProcessed = await runtime.processNextChatVerification(
          verificationController.signal,
        );
        processed = researchProcessed || chatProcessed;
      }
    }).catch(async (error: unknown) => {
      if (verificationController.signal.aborted) {
        return;
      }
      const result = await services.reportApplicationError(error, {
        category: "background-task",
        code: "claim_verification_dispatch_failed",
        instance: hostname(),
        operation: "dispatch-claim-verification",
        origin: "background-task",
        retryable: true,
        service: "web",
        severity: "error",
      });
      server.log.error(
        { errorId: result.id },
        "Could not dispatch claim verification.",
      );
    }).finally(() => {
      verificationDispatch = null;
    });
  };
  const verificationTimer = setInterval(
    dispatchVerifications,
    500,
  );
  verificationTimer.unref();
  dispatchVerifications();
  server.addHook("onClose", async () => {
    clearInterval(verificationTimer);
    verificationController.abort();
    if (verificationDispatch !== null) {
      await verificationDispatch;
    }
  });
  if (closeOwnedServices !== null) {
    server.addHook("onClose", closeOwnedServices);
  }
  const staticDirectory = options.staticDirectory === undefined
    ? DEFAULT_BROWSER_STATIC_DIRECTORY
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

  const oauthAuthenticator = options.oauthAuthenticator
    ?? createApplicationOAuthRequestAuthenticator(services);
  registerAuthenticationRoutes(server, {
    authentication,
    oauthAuthenticator,
    requestPrincipals,
    services,
    webConfig,
  });

  registerOAuthProtectedResourceMetadata(server, {
    publicOrigin: webConfig.publicOrigin,
    services,
  });
  await registerMcpRoutes(server, {
    oauthAuthenticator,
    services,
    webConfig,
  });
  registerObservabilityRoutes(server, {
    maximumUploadRequestBytes,
    requestPrincipals,
    runDiagnostics: async (liveChecks) => {
      return services.run((runtime) => {
        return runDiagnostics(runtime, liveChecks);
      });
    },
    services,
  });

  registerSettingsRoutes(server, {
    config,
    requestPrincipals,
    services,
    webConfig,
  });
  registerEmbeddingInputFormatRoutes(server, {
    requestPrincipals,
    services,
  });
  registerOpenAICodexRoutes(server, {
    requestPrincipals,
    services: services.openAICodex,
  });
  registerSourceContentStorageRoutes(server, {
    requestPrincipals,
    services,
  });

  if (securityServices !== null) {
    registerSecurityRoutes(server, {
      requestPrincipals,
      services: securityServices,
    });
  }

  if (authenticationSecurityServices !== null) {
    registerAuthenticationSecurityRoutes(server, {
      publicOrigin: webConfig.publicOrigin,
      requestPrincipals,
      services: authenticationSecurityServices,
    });
  }

  registerDocumentCatalogRoutes(server, { requestPrincipals, services });
  registerChatRoutes(server, { requestPrincipals, services });
  registerResearchThreadRoutes(server, { requestPrincipals, services });
  registerCitationRoutes(server, { requestPrincipals, services });
  registerDocumentVersionRoutes(server, { requestPrincipals, services });
  registerResearchFeedbackRoutes(server, { requestPrincipals, services });

  registerIngestionRoutes(server, {
    maximumUploadRequestBytes,
    requestPrincipals,
    services,
    uploadDirectory,
  });

  registerSourceDiscoveryRoutes(server, { requestPrincipals, services });
  registerAnswerRoutes(server, { requestPrincipals, services });
  registerSpeechRoutes(server, { requestPrincipals, services });

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
      await registerBrowserApplicationRoutes(server, staticDirectory);
    } catch (error: unknown) {
      await server.close();
      throw error;
    }
  }

  return server;
}

export async function startWebServer(
  startup = readStartupConfig(),
  webStartup: WebStartupConfig = readWebStartupConfig(),
): Promise<FastifyInstance> {
  const session = await openDatabase(startup.database);
  let effectiveSettings: EffectiveApplicationSettings;
  try {
    const repository = new ApplicationSettingsRepository(session.database);
    effectiveSettings = await repository.read(startup.database);
  } finally {
    await session.close();
  }
  const apiOnly = process.argv.includes("--api-only");
  const webConfig = buildWebConfig(effectiveSettings.config.web, webStartup);
  const server = await buildWebServer(effectiveSettings.config, {
    maximumUploadRequestBytes: webConfig.maximumUploadRequestBytes,
    staticDirectory: apiOnly ? null : DEFAULT_BROWSER_STATIC_DIRECTORY,
    uploadDirectory: webConfig.uploadDirectory,
    webConfig,
  });
  try {
    await server.listen({ host: webConfig.host, port: webConfig.port });
    return server;
  } catch (error: unknown) {
    await server.close();
    throw error;
  }
}
