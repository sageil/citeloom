import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

import { createUIMessageStream, type InferUIMessageChunk } from "ai";

import type { CiteLoomUIMessage } from "../src/answers/stream.js";
import type { EffectiveApplicationSettings } from "../src/app/settings.js";
import type { AuthenticatedPrincipal } from "../src/auth/model.js";
import type {
  RuntimeSettings,
  AppConfig,
} from "../src/config/index.js";
import type { PendingIngestionJob } from "../src/documents/catalog/index.js";
import type {
  BrowserDocument,
  BrowseDocumentCatalogResult,
} from "../src/documents/catalog/browser.js";
import type { DoctorCheck } from "../src/observability/doctor.js";
import type { SourceDiscoveryResponse } from "../src/retrieval/discovery/boundary.js";
import type {
  RuntimeWebServices,
  WebServices,
} from "../src/web-server.js";
import type {
  AuthenticationSecurityWebServices,
} from "../src/api/services.js";
import type {
  McpTaskOwner,
  McpTaskRecord,
  McpTaskServices,
} from "../src/mcp/tasks/model.js";
import { createTestProviderSettings } from "./provider-settings-fixture.js";
import {
  createTestRuntimeSettings,
  readEqualWeightTestConfig,
  TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
} from "./config-fixture.js";

export type TestWebServiceOverrides = Partial<RuntimeWebServices>
  & Partial<AuthenticationSecurityWebServices>
  & Partial<Pick<
    WebServices,
    | "addWorkspaceMember"
    | "archiveSharedSourceLibrary"
    | "archiveWorkspace"
    | "authenticate"
    | "authenticateMcpApiKey"
    | "cancelSourceContentMigration"
    | "changePassword"
    | "changeWorkspaceMemberAccess"
    | "changeWorkspaceMemberRole"
    | "completePasswordSetup"
    | "copyEmbeddingInputFormat"
    | "createSharedSourceLibrary"
    | "deleteSharedSourceLibrary"
    | "createEmbeddingInputFormat"
    | "createWorkspace"
    | "listWorkspaceMemberCandidates"
    | "listWorkspaces"
    | "listSourceLibraries"
    | "listWorkspaceMembers"
    | "mcpTasks"
    | "openAICodex"
    | "purgeApplicationErrors"
    | "readApplicationErrors"
    | "readAuthenticationBootstrap"
    | "readAuthenticationSettings"
    | "readOAuthIdentityContext"
    | "readSession"
    | "readSourceLibraryAdministration"
    | "readSettings"
    | "readWorkspaceSettings"
    | "readSourceContentStorage"
    | "reportApplicationError"
    | "resolveOAuthPrincipal"
    | "resolveOAuthPrincipals"
    | "resolveMcpApiKeyPrincipal"
    | "removeWorkspaceMember"
    | "renameSharedSourceLibrary"
    | "renameWorkspace"
    | "restoreSharedSourceLibrary"
    | "retireEmbeddingInputFormat"
    | "revokeSession"
    | "revokeSourceLibraryGrant"
    | "reviseEmbeddingInputFormat"
    | "queueSourceContentMigration"
    | "subscribeRevisions"
    | "switchWorkspace"
    | "setSourceLibraryGrant"
    | "testSourceContentStorage"
    | "updateSettings"
    | "updateWorkspaceSettings"
  >>;

export function buildReadyDiagnosticCheck(): DoctorCheck {
  return {
    category: "persistence",
    detail: "ready",
    groupId: "infrastructure",
    groupName: "Infrastructure",
    items: [],
    mode: "readiness",
    name: "Database",
    ok: true,
  };
}

export function buildServices(
  overrides: TestWebServiceOverrides = {},
): WebServices & AuthenticationSecurityWebServices {
  const runtimeServices: RuntimeWebServices = {
    addResearchFeedback: async () => ({ negativeCount: 0, positiveCount: 1, rating: 1 }),
    browseDocuments: async () => buildCatalogResult(),
    compareDocumentVersions: async () => null,
    config: buildConfig(),
    createChatConversation: async (_principal, title, scope) => ({
      createdAt: "2026-07-15T12:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000301",
      ownerUserId: "00000000-0000-4000-8000-000000000000",
      runs: [],
      scope,
      title,
      updatedAt: "2026-07-15T12:00:00.000Z",
      workspaceId: "00000000-0000-4000-8000-000000000000",
    }),
    createResearchThread: async (_principal, title) => ({
      createdAt: "2026-07-15T12:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000001",
      title,
      turns: [],
      updatedAt: "2026-07-15T12:00:00.000Z",
    }),
    deleteChatConversation: async () => undefined,
    deleteIndexedDocument: async () => ({ kind: "not-found" }),
    deleteResearchThread: async () => undefined,
    exportResearchThread: async () => null,
    generateSpeech: async () => ({
      audio: Readable.from([Buffer.from("audio")]),
      completion: Promise.resolve(),
      contentType: "audio/wav",
    }),
    ingest: async () => ({ documents: [], failures: [] }),
    listChatConversations: async () => [],
    listDocumentVersions: async () => [],
    listResearchThreads: async () => [],
    processNextChatVerification: async () => false,
    processNextResearchVerification: async () => false,
    readCitationEvidence: async () => null,
    readCitationHighlightedFile: async () => null,
    readCitationImage: async () => null,
    readChatCitationEvidence: async () => null,
    readChatCitationFile: async () => null,
    readChatCitationHighlightedFile: async () => null,
    readChatCitationImage: async () => null,
    readChatConversation: async () => null,
    readDocumentFile: async () => null,
    readHealth: async () => [buildReadyDiagnosticCheck()],
    readResearchThread: async () => null,
    readResearchFeedback: async () => ({ negativeCount: 0, positiveCount: 0, rating: 0 }),
    readRevisions: async () => ({ catalog: "0", jobs: "0", settings: "0" }),
    readStatus: async () => ({ inference: [], queue: [], workers: [] }),
    readTelemetry: async () => buildTelemetryDashboard(),
    readVersionedDocumentFile: async () => null,
    reconcileIngestionCancellations: async () => undefined,
    reconcileSourceLibraryDeletions: async () => false,
    reconcileUploadedDocuments: async () => 0,
    reindexDocument: async () => ({ kind: "not-found" }),
    retryFailedJob: async () => ({ kind: "not-found" }),
    requestIngestionControl: async () => ({ kind: "not-found" }),
    resumeIngestion: async () => ({ kind: "not-found" }),
    searchSources: async () => buildSourceDiscoveryResponse(),
    streamAnswer: () => createAnswerStream("Answer"),
    streamChatMessage: () => createAnswerStream("Answer"),
    transcribeAudio: async () => ({ text: "Transcript" }),
    updateDocumentTags: async () => null,
  };
  const effectiveRuntimeServices: RuntimeWebServices = {
    ...runtimeServices,
    ...overrides,
  };
  return {
    activateOAuthApplication: overrides.activateOAuthApplication
      ?? (async () => buildOAuthAuthenticationSettings()),
    configureHostAuthenticationRecovery:
      overrides.configureHostAuthenticationRecovery
      ?? (async (_principal, enabled) => ({
        ...buildOAuthAuthenticationSettings(),
        hostRecoveryEnabled: enabled,
      })),
    disableOAuthApplication: overrides.disableOAuthApplication
      ?? (async () => ({
        ...buildOAuthAuthenticationSettings(),
        activeOAuthConfiguration: null,
        mode: "local",
      })),
    archiveSharedSourceLibrary: overrides.archiveSharedSourceLibrary
      ?? (async () => undefined),
    archiveWorkspace: overrides.archiveWorkspace ?? (async () => undefined),
    authenticate: overrides.authenticate ?? (async () => {
      throw new Error("Authentication is not configured in boundary tests.");
    }),
    authenticateMcpApiKey: overrides.authenticateMcpApiKey ?? (async () => {
      throw new Error("MCP API key authentication is not configured in boundary tests.");
    }),
    changePassword: overrides.changePassword ?? (async () => {
      throw new Error("Authentication is not configured in boundary tests.");
    }),
    changeWorkspaceMemberAccess: overrides.changeWorkspaceMemberAccess ?? (async () => {
      throw new Error("Authentication is not configured in boundary tests.");
    }),
    changeWorkspaceMemberRole: overrides.changeWorkspaceMemberRole ?? (async () => {
      throw new Error("Authentication is not configured in boundary tests.");
    }),
    cancelSourceContentMigration: overrides.cancelSourceContentMigration
      ?? (async (id) => buildSourceContentMigrationRecord(id)),
    completePasswordSetup: overrides.completePasswordSetup ?? (async () => {
      throw new Error("Authentication is not configured in boundary tests.");
    }),
    copyEmbeddingInputFormat: overrides.copyEmbeddingInputFormat
      ?? (async () => buildEmbeddingInputFormatRecord()),
    createEmbeddingInputFormat: overrides.createEmbeddingInputFormat
      ?? (async () => buildEmbeddingInputFormatRecord()),
    createSharedSourceLibrary: overrides.createSharedSourceLibrary ?? (async () => {
      throw new Error("Source library management is not configured in boundary tests.");
    }),
    deleteSharedSourceLibrary: overrides.deleteSharedSourceLibrary
      ?? (async () => undefined),
    addWorkspaceMember: overrides.addWorkspaceMember ?? (async () => {
      throw new Error("Authentication is not configured in boundary tests.");
    }),
    createWorkspace: overrides.createWorkspace ?? (async () => {
      throw new Error("Authentication is not configured in boundary tests.");
    }),
    listWorkspaceMembers: overrides.listWorkspaceMembers ?? (async () => []),
    linkOAuthApplicationUserIdentity:
      overrides.linkOAuthApplicationUserIdentity ?? (async () => undefined),
    listWorkspaceMemberCandidates: overrides.listWorkspaceMemberCandidates
      ?? (async () => []),
    listWorkspaces: overrides.listWorkspaces ?? (async () => []),
    listSourceLibraries: overrides.listSourceLibraries ?? (async () => []),
    mcpTasks: overrides.mcpTasks ?? createInMemoryMcpTaskServices(),
    openAICodex: overrides.openAICodex ?? {
      disconnect: async () => undefined,
      readConnectionState: async () => ({
        expiresAt: null,
        state: "disconnected",
        updatedAt: null,
      }),
      readModels: async () => [],
      replaceCredentials: async () => undefined,
    },
    purgeApplicationErrors: overrides.purgeApplicationErrors
      ?? (async () => ({ deleted: 0 })),
    readApplicationErrors: overrides.readApplicationErrors
      ?? (async () => buildApplicationErrorPage()),
    readAuthenticationBootstrap: overrides.readAuthenticationBootstrap
      ?? (async () => ({ mode: "local", oauth: null })),
    readAuthenticationSettings: overrides.readAuthenticationSettings
      ?? (async () => ({
        activeOAuthConfiguration: null,
        activatedAt: null,
        hostRecoveryEnabled: false,
        mode: "local",
        stagedOAuthConfiguration: null,
        updatedAt: null,
        version: 1,
      })),
    readAuthenticationSecurityOverview:
      overrides.readAuthenticationSecurityOverview ?? (async () => ({
        managedIssuer: null,
        settings: {
          activeOAuthConfiguration: null,
          activatedAt: null,
          hostRecoveryEnabled: false,
          mode: "local",
          stagedOAuthConfiguration: null,
          updatedAt: null,
          version: 1,
        },
        userIdentityLinks: [],
      })),
    readOAuthIdentityContext: overrides.readOAuthIdentityContext
      ?? (async () => {
        throw new Error("OAuth authentication is not configured in boundary tests.");
      }),
    readRevisions: effectiveRuntimeServices.readRevisions,
    readSettings: overrides.readSettings ?? (async () => buildEffectiveSettings()),
    readWorkspaceSettings: overrides.readWorkspaceSettings ?? (async () => ({
      ...buildEffectiveSettings(),
      providerOverrideCapabilities: [],
    })),
    readSourceContentStorage: overrides.readSourceContentStorage
      ?? (async () => ({
        activeConfig: buildConfig().sourceContent,
        documentCount: 0,
        migration: null,
        settingsVersion: 2,
      })),
    reportApplicationError: overrides.reportApplicationError
      ?? (async () => ({ id: "00000000-0000-4000-8000-000000000099" })),
    resolveOAuthPrincipal: overrides.resolveOAuthPrincipal ?? (async () => {
      throw new Error("OAuth authentication is not configured in boundary tests.");
    }),
    resolveOAuthPrincipals: overrides.resolveOAuthPrincipals ?? (async () => {
      throw new Error("OAuth authentication is not configured in boundary tests.");
    }),
    resolveMcpApiKeyPrincipal:
      overrides.resolveMcpApiKeyPrincipal ?? (async () => {
        throw new Error("MCP API key authentication is not configured in boundary tests.");
      }),
    removeWorkspaceMember: overrides.removeWorkspaceMember ?? (async () => {
      throw new Error("Authentication is not configured in boundary tests.");
    }),
    retireEmbeddingInputFormat: overrides.retireEmbeddingInputFormat
      ?? (async () => buildEmbeddingInputFormatRecord()),
    readSession: overrides.readSession ?? (async () => null),
    readSourceLibraryAdministration:
      overrides.readSourceLibraryAdministration ?? (async () => ({
        libraries: [],
        workspaces: [],
      })),
    renameSharedSourceLibrary: overrides.renameSharedSourceLibrary
      ?? (async () => undefined),
    renameWorkspace: overrides.renameWorkspace
      ?? (async (_principal, workspaceId, input) => ({
        id: workspaceId,
        name: input.name,
        role: "admin",
      })),
    restoreSharedSourceLibrary: overrides.restoreSharedSourceLibrary
      ?? (async () => undefined),
    revokeSession: overrides.revokeSession ?? (async () => undefined),
    revokeSourceLibraryGrant: overrides.revokeSourceLibraryGrant
      ?? (async () => undefined),
    switchWorkspace: overrides.switchWorkspace ?? (async (principal) => principal),
    setSourceLibraryGrant: overrides.setSourceLibraryGrant
      ?? (async () => undefined),
    stageOAuthApplicationConfiguration:
      overrides.stageOAuthApplicationConfiguration
      ?? (async () => buildOAuthAuthenticationSettings()),
    run: async (operation) => operation(effectiveRuntimeServices),
    runInWorkspace: async (_principal, operation) => {
      return operation(effectiveRuntimeServices);
    },
    runManaged: async (operation) => {
      const task = await operation(effectiveRuntimeServices);
      return task.value;
    },
    runManagedInWorkspace: async (_principal, operation) => {
      const task = await operation(effectiveRuntimeServices);
      return task.value;
    },
    stream: (operation) => operation(effectiveRuntimeServices),
    streamInWorkspace: (_principal, operation) => {
      return operation(effectiveRuntimeServices);
    },
    subscribeRevisions: overrides.subscribeRevisions ?? (() => () => undefined),
    unlinkOAuthApplicationUserIdentity:
      overrides.unlinkOAuthApplicationUserIdentity ?? (async () => undefined),
    reviseEmbeddingInputFormat: overrides.reviseEmbeddingInputFormat
      ?? (async () => buildEmbeddingInputFormatRecord()),
    queueSourceContentMigration: overrides.queueSourceContentMigration
      ?? (async (_requestedByUserId, request) => {
        return buildSourceContentMigrationRecord(
          "00000000-0000-4000-8000-000000000401",
          request.targetConfig,
        );
      }),
    testSourceContentStorage: overrides.testSourceContentStorage
      ?? (async () => undefined),
    updateSettings: overrides.updateSettings ?? (async () => buildEffectiveSettings()),
    updateWorkspaceSettings: overrides.updateWorkspaceSettings ?? (async () => ({
      ...buildEffectiveSettings(),
      providerOverrideCapabilities: [],
    })),
  };
}

export function createInMemoryMcpTaskServices(): McpTaskServices {
  const tasks = new Map<string, McpTaskRecord>();
  const readOwned = (
    owner: McpTaskOwner,
    taskId: string,
  ): McpTaskRecord | null => {
    const task = tasks.get(taskId);
    if (
      task === undefined
      || task.issuer !== owner.issuer
      || task.subject !== owner.subject
      || task.clientId !== owner.clientId
      || task.userId !== owner.userId
    ) {
      return null;
    }
    return task;
  };
  return {
    cancelClaimed: async (taskId, leaseOwner) => {
      const task = tasks.get(taskId);
      if (task?.status !== "working" || task.leaseOwner !== leaseOwner) {
        return false;
      }
      tasks.set(taskId, {
        ...task,
        cancellationRequestedAt: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        status: "cancelled",
        statusMessage: "The task was cancelled.",
        updatedAt: new Date(),
      });
      return true;
    },
    claim: async (taskId, leaseOwner, leaseExpiresAt) => {
      const task = tasks.get(taskId);
      if (
        task?.status !== "working"
        || task.leaseOwner !== null
        || task.cancellationRequestedAt !== null
      ) {
        return null;
      }
      const claimed = { ...task, leaseExpiresAt, leaseOwner };
      tasks.set(taskId, claimed);
      return claimed;
    },
    complete: async (taskId, leaseOwner, result) => {
      const task = tasks.get(taskId);
      if (task?.status !== "working" || task.leaseOwner !== leaseOwner) {
        return false;
      }
      tasks.set(taskId, {
        ...task,
        cancellationRequestedAt: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        result,
        status: "completed",
        statusMessage: null,
        updatedAt: new Date(),
      });
      return true;
    },
    deleteExpiredTerminalBatch: async (now) => {
      let deleted = 0;
      for (const [taskId, task] of tasks) {
        if (
          task.status !== "working"
          && task.expiresAt.getTime() <= now.getTime()
        ) {
          tasks.delete(taskId);
          deleted += 1;
        }
      }
      return deleted;
    },
    create: async (owner, request) => {
      const now = new Date();
      const task: McpTaskRecord = {
        cancellationRequestedAt: null,
        clientId: owner.clientId,
        createdAt: now,
        error: null,
        expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000),
        id: randomUUID(),
        issuer: owner.issuer,
        leaseExpiresAt: null,
        leaseOwner: null,
        request,
        result: null,
        status: "working",
        statusMessage: null,
        subject: owner.subject,
        updatedAt: now,
        userId: owner.userId,
      };
      tasks.set(task.id, task);
      return task;
    },
    fail: async (taskId, leaseOwner, error, statusMessage) => {
      const task = tasks.get(taskId);
      if (task?.status !== "working" || task.leaseOwner !== leaseOwner) {
        return false;
      }
      tasks.set(taskId, {
        ...task,
        cancellationRequestedAt: null,
        error,
        leaseExpiresAt: null,
        leaseOwner: null,
        status: "failed",
        statusMessage,
        updatedAt: new Date(),
      });
      return true;
    },
    failExpiredLeases: async (now) => {
      let failed = 0;
      for (const [taskId, task] of tasks) {
        if (
          task.status !== "working"
          || task.leaseOwner === null
          || task.leaseExpiresAt === null
          || task.leaseExpiresAt > now
        ) {
          continue;
        }
        tasks.set(taskId, {
          ...task,
          error: { code: -32_603, message: "Task execution was interrupted." },
          leaseExpiresAt: null,
          leaseOwner: null,
          status: "failed",
          statusMessage: "Task execution was interrupted.",
          updatedAt: now,
        });
        failed += 1;
      }
      return failed;
    },
    listUnclaimedTaskIds: async () => {
      const ids: string[] = [];
      for (const task of tasks.values()) {
        if (task.status === "working" && task.leaseOwner === null) {
          ids.push(task.id);
        }
      }
      return ids;
    },
    readForOwner: async (owner, taskId) => readOwned(owner, taskId),
    renewLease: async (taskId, leaseOwner, leaseExpiresAt) => {
      const task = tasks.get(taskId);
      if (task?.status !== "working" || task.leaseOwner !== leaseOwner) {
        return "lost";
      }
      tasks.set(taskId, { ...task, leaseExpiresAt });
      return task.cancellationRequestedAt === null ? "active" : "cancel";
    },
    requestCancellation: async (owner, taskId) => {
      const task = readOwned(owner, taskId);
      if (task === null) {
        return false;
      }
      if (task.status !== "working") {
        return true;
      }
      if (task.leaseOwner === null) {
        tasks.set(taskId, {
          ...task,
          status: "cancelled",
          statusMessage: "The task was cancelled.",
          updatedAt: new Date(),
        });
      } else {
        tasks.set(taskId, {
          ...task,
          cancellationRequestedAt: new Date(),
        });
      }
      return true;
    },
  };
}

export function buildSourceContentMigrationRecord(
  id: string,
  targetConfig = buildConfig().sourceContent,
) {
  const now = new Date("2026-08-10T16:00:00.000Z");
  return {
    activeSlot: 1,
    attemptCount: 0,
    completedAt: null,
    copiedDocuments: 0,
    createdAt: now,
    errorMessage: null,
    id,
    lastDocumentId: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    requestedByUserId: "00000000-0000-4000-8000-000000000301",
    sourceConfig: buildConfig().sourceContent,
    startedAt: null,
    state: "queued" as const,
    targetConfig,
    totalDocuments: 0,
    updatedAt: now,
    verifiedDocuments: 0,
  };
}

export function buildSourceDiscoveryRequest() {
  return {
    includeRelated: true,
    keywordPage: 1,
    query: "loan",
    scope: { kind: "all" as const },
  };
}

export function buildAuthenticatedPrincipal(
  role: "admin" | "member",
  globalRole: "global_admin" | "standard" = role === "admin"
    ? "global_admin"
    : "standard",
): AuthenticatedPrincipal {
  return {
    dataScope: "workspace",
    displayName: "Test User",
    globalRole,
    role,
    sessionTokenDigest: "a".repeat(64),
    userId: "00000000-0000-4000-8000-000000000301",
    username: "test-user",
    workspaceId: "00000000-0000-4000-8000-000000000302",
    workspaceName: "Test Workspace",
  };
}

export function buildOAuthPrincipal() {
  const {
    sessionTokenDigest: _sessionTokenDigest,
    ...principal
  } = buildAuthenticatedPrincipal("admin", "global_admin");
  return {
    ...principal,
    issuer: "https://identity.example.com/oidc",
    scopes: ["citeloom.app"],
    subject: "test-oauth-subject",
  };
}

export function buildOAuthAuthenticationSettings(): Awaited<
  ReturnType<WebServices["readAuthenticationSettings"]>
> {
  return {
    activeOAuthConfiguration: {
      apiResource: "https://localhost:3443/api",
      apiScopes: ["citeloom.app"],
      browserCallbackUri: "https://localhost:3443/oauth/callback",
      browserClientId: "citeloom-browser",
      browserPostLogoutRedirectUri: "https://localhost:3443/login",
      browserScopes: ["citeloom.app", "openid"],
      issuer: "https://identity.example.com/oidc",
      mcpResource: "https://localhost:3443/mcp",
      mcpScopes: ["citeloom.answer", "citeloom.search"],
    },
    activatedAt: "2026-08-13T12:00:00.000Z",
    hostRecoveryEnabled: true,
    mode: "oauth",
    stagedOAuthConfiguration: null,
    updatedAt: "2026-08-13T12:00:00.000Z",
    version: 3,
  };
}

export function buildPrincipalWorkspace(principal: AuthenticatedPrincipal) {
  return {
    id: principal.workspaceId,
    name: principal.workspaceName,
    role: "admin" as const,
  };
}

export function buildApplicationErrorPage() {
  return {
    counts: {
      all: 0,
      application: 0,
      general: 0,
      ingestion: 0,
    },
    errors: [],
    generatedAt: "2026-07-27T12:00:00.000Z",
    page: 1,
    pageCount: 0,
    pageSize: 50 as const,
    total: 0,
  };
}

export class TestRevisionResponse extends EventEmitter {
  public readonly headers: Record<string, string> = {};
  public statusCode = 0;
  public text = "";

  public end(): void {
    this.emit("close");
  }

  public write(value: string): boolean {
    this.text += value;
    return true;
  }

  public writeHead(statusCode: number, headers: Record<string, string>): void {
    this.statusCode = statusCode;
    Object.assign(this.headers, headers);
  }
}

export function buildTelemetryDashboard() {
  return {
    corrections: [],
    enabled: false,
    generatedAt: "2026-07-15T12:00:00.000Z",
    requests: [],
    scheduling: [],
    stages: [],
    windowHours: 24,
  };
}

export function buildSourceDiscoveryResponse(): SourceDiscoveryResponse {
  return {
    query: "loan",
    results: {
      exact: {
        documents: [],
        page: 1,
        pageSize: 10,
        totalDocuments: 0,
      },
      kind: "exact-and-related",
      related: {
        documents: [],
        limit: 10,
        matchedPassageCount: 0,
        reviewedPassageCount: 0,
      },
    },
  };
}

export function buildEffectiveSettings(): EffectiveApplicationSettings {
  const config = buildConfig();
  const runtimeSettings = buildRuntimeSettings();
  return {
    config,
    defaults: runtimeSettings,
    embeddingInputFormats: [{
      ...buildEmbeddingInputFormatRecord(),
      embeddingSpaceCount: 0,
    }],
    indexedDocumentCount: 0,
    overrides: {},
    providerSettings: createTestProviderSettings(),
    runtimeSettings,
    selectedEmbeddingSpaceDocumentCount: 0,
    updatedAt: null,
    version: 0,
  };
}

export function buildRuntimeSettings(): RuntimeSettings {
  return createTestRuntimeSettings({
    claimVerifierRuntimeName: "test verifier runtime",
    embeddingInputFormatId: TEST_PLAIN_EMBEDDING_INPUT_FORMAT.id,
    maxDocumentMegabytes: 1,
    workerFallbackPollMs: 1_000,
  });
}

export function buildEmbeddingInputFormatRecord() {
  return {
    ...TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
    createdAt: new Date("2026-07-15T12:00:00.000Z"),
    retiredAt: null,
  };
}

export function buildBrowserDocument(
  overrides: Partial<BrowserDocument> = {},
): BrowserDocument {
  return {
    activeDocumentId: "a".repeat(64),
    activeVersionId: "00000000-0000-4000-8000-000000000001",
    attemptCount: null,
    byteLength: 4_096,
    controlError: null,
    controlState: "active",
    displayStatus: "ready",
    documentId: "a".repeat(64),
    embeddingSpaceIds: [
      "embedding-model:plain:768:window-2e666b3b90c9157e",
    ],
    embeddingProgress: {
      completedElements: 5,
      state: "complete",
      totalElements: 5,
    },
    errorMessage: null,
    images: 0,
    indexingActivity: null,
    maxAttempts: null,
    mediaDescriptionProgress: {
      completedImages: 0,
      completedTables: 1,
    },
    nextAttemptAt: null,
    pageCount: null,
    phase: null,
    queryStatus: "ready",
    sourceFile: "/documents/handbook.docx",
    sourceLibraryId: "00000000-0000-4000-8000-000000000405",
    status: "ready",
    tables: 1,
    tags: ["handbook"],
    textChunks: 4,
    totalElements: 5,
    updatedAt: "2026-07-13T16:00:00.000Z",
    uploadedByUserId: null,
    ...overrides,
  };
}

export function buildCatalogResult(
  documents: BrowserDocument[] = [buildBrowserDocument()],
): BrowseDocumentCatalogResult {
  return {
    attention: { documents: [], total: 0 },
    documents,
    facets: {
      failed: 0,
      pending: 0,
      processing: 0,
      queryable: 1,
      queryableTags: [{ count: 1, tag: "handbook" }],
      ready: 1,
      reindexRequired: 0,
      running: 0,
      tags: [{ count: 1, tag: "handbook" }],
      total: documents.length,
      untagged: 0,
      uploads: 0,
    },
    page: 1,
    pageSize: 25,
    total: documents.length,
  };
}

export function buildPendingJob(sourceFile: string): PendingIngestionJob {
  return {
    attemptCount: 0,
    documentId: "b".repeat(64),
    doclingAttemptConfig: null,
    doclingRunId: null,
    elementSetId: "c".repeat(64),
    embeddingSpaceId: "embedding-model:plain:768:window-2e666b3b90c9157e",
    controlError: null,
    controlState: "active",
    errorMessage: null,
    format: {
      extension: ".pdf",
      mediaType: "application/pdf",
    },
    generationId: "00000000-0000-4000-8000-000000000001",
    images: 0,
    indexingActivity: "preparing",
    leaseExpiresAt: null,
    maxAttempts: 3,
    nextAttemptAt: "2026-07-14T04:00:00.000Z",
    ownerId: null,
    pageCount: null,
    phase: "normalized",
    sourceFile,
    sourceLibraryId: null,
    state: "pending",
    tables: 1,
    tags: ["legal"],
    textChunks: 4,
    totalElements: 5,
    updatedAt: "2026-07-14T04:00:00.000Z",
    uploadedByUserId: null,
  };
}

export function buildConfig(): AppConfig {
  return readEqualWeightTestConfig({
    embeddingInputFormat: TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
    providerOptions: {
      inferenceBaseUrl: "http://127.0.0.1:1234/v1",
    },
    runtime: buildRuntimeSettings(),
  });
}

export function buildSpeechToTextConfig(): NonNullable<AppConfig["speechToText"]> {
  return {
    adapter: "omlx-transcription",
    apiToken: "transcription-token",
    baseUrl: "http://localhost:9000/v1",
    providerId: "local-ai",
    language: "English",
    maxAudioBytes: 10 * 1_024 * 1_024,
    model: "Qwen3-ASR-1.7B-8bit",
    prompt: "CiteLoom is the product name. Preserve the exact spelling CiteLoom.",
    runtimeName: "oMLX",
    timeoutMs: 60_000,
  };
}

export function buildAudioFile(content: string, type: string): File {
  return new File([content], "browser-name.webm", { type });
}

export function buildTranscriptionForm(
  files: File[],
  field?: [string, string],
): FormData {
  const form = new FormData();
  if (field !== undefined) {
    form.append(field[0], field[1]);
  }
  for (const file of files) {
    form.append("file", file, file.name);
  }
  return form;
}

export function createAnswerStream(
  answer: string,
): ReadableStream<InferUIMessageChunk<CiteLoomUIMessage>> {
  return createUIMessageStream<CiteLoomUIMessage>({
    execute: ({ writer }) => {
      writer.write({ type: "start" });
      writer.write({
        data: {
          answerDocument: {
            citations: [{
              citationNumber: 1,
              documentId: "a".repeat(64),
              documentVersionId: "00000000-0000-4000-8000-000000000002",
              elementId: "b".repeat(64),
              evidence: { excerpt: "Supporting evidence.", kind: "text" },
              id: "00000000-0000-4000-8000-000000000003",
              kind: "text",
              pageNumbers: [1],
              regions: [],
              sectionPath: [],
              sourceFile: "/tmp/report.pdf",
            }],
            content: answer,
            schemaVersion: 2,
            statements: [{
              citationIds: ["00000000-0000-4000-8000-000000000003"],
              content: answer,
              presentation: "paragraph",
              section: "answer",
            }],
          },
          claims: [],
          matchedDocuments: [],
          runDetails: null,
          turn: {
            runId: "00000000-0000-4000-8000-000000000004",
            sequence: 1,
            threadId: "00000000-0000-4000-8000-000000000001",
            turnId: "00000000-0000-4000-8000-000000000005",
          },
          verificationState: "not-applicable",
        },
        id: "answer",
        type: "data-answer",
      });
      writer.write({ finishReason: "stop", type: "finish" });
    },
  });
}
