import { basename } from "node:path";
import { hostname } from "node:os";

import {
  ApplicationRuntimeManager,
  createApplicationRuntimeView,
  type ApplicationRuntime,
} from "../app/runtime.js";
import {
  PostgresApplicationStateRevisionSource,
  readApplicationStateRevisions,
  type ApplicationStateRevisionSnapshot,
  type ApplicationStateRevisionSource,
  type ApplicationStateRevisionSubscriber,
} from "../app/application-state-revisions.js";
import {
  ApplicationSettingsRepository,
  type EffectiveApplicationSettings,
} from "../app/settings.js";
import { DocumentCatalog } from "../documents/catalog/index.js";
import {
  readApplicationErrorRetentionConfig,
  readDoclingServiceTopologyFromConfig,
  type AppConfig,
  type SourceContentConfig,
} from "../config/index.js";
import { openDatabase } from "../database/client.js";
import {
  browseCatalogEntriesWithRuntime,
  readIndexedDocumentFileWithRuntime,
  updateIndexedDocumentTagsWithRuntime,
  type IndexedDocumentFile,
} from "../documents/catalog/service.js";
import { SourceContentStore } from "../documents/storage/source-content-store.js";
import { createSourceContentBackend } from "../documents/storage/source-content-backend.js";
import {
  type SourceContentMigrationRecord,
  SourceContentMigrationRepository,
  type SourceContentStorageOverview,
} from "../documents/storage/source-content-migration-store.js";
import {
  ingestStagedDocumentsWithRuntime,
  queueDocumentReindexWithRuntime,
  requestIngestionControlWithRuntime,
  resumeIngestionWithRuntime,
  retryFailedIngestionWithRuntime,
} from "../ingestion/service.js";
import {
  deleteAbandonedUploadStaging,
  deleteIndexedDocumentWithRuntime,
  reconcileIngestionCancellations,
} from "../ingestion/deletion.js";
import { reconcileIngestionControlExecutions } from "../ingestion/control.js";
import {
  runDoctorWithRuntime,
  type DoctorCheck,
  type DoctorLiveChecks,
} from "../observability/doctor.js";
import {
  ApplicationErrorReporter,
  reportApplicationErrorToContainerLog,
  type ApplicationErrorContext,
} from "../observability/application-errors.js";
import {
  purgeApplicationErrors,
  readApplicationErrorPage,
  type ApplicationErrorPage,
  type ApplicationErrorPageRequest,
  type ApplicationErrorPurgeResult,
} from "../observability/application-error-store.js";
import {
  enforceApplicationErrorRetention,
  startApplicationErrorRetentionController,
} from "../observability/application-error-retention.js";
import { renderHighlightedPdf } from "../research/evidence-document.js";
import { renderHighlightedTextDocument } from "../research/highlighted-text-document.js";
import {
  searchIndexedSourcesWithRuntime,
} from "../retrieval/discovery/pipeline.js";
import {
  streamIndexedDocumentAnswerWithRuntime,
} from "../retrieval/pipeline.js";
import type {
  StoredCitationRecord,
} from "../research/types.js";
import {
  ResearchInputConflictError,
  ResearchStore,
} from "../research/store.js";
import {
  transcribeAudio as transcribeSpeechAudio,
} from "../providers/speech-to-text.js";
import { generateTextToSpeech } from "../providers/text-to-speech.js";
import {
  startManagedTask,
  type ManagedTask,
} from "../shared/concurrency.js";
import { readTelemetryDashboardWithRuntime } from "../observability/store.js";
import type {
  UpdateApplicationSettingsRequest,
} from "./request-boundary.js";
import { readSystemStatusWithRuntime } from "../ingestion/worker.js";
import type {
  CreateWorkspaceInput,
  LoginInput,
  NormalizedUserIdentity,
  RenameWorkspaceInput,
  UpdateWorkspaceSecurityPolicyInput,
} from "../auth/boundary.js";
import type { PasswordInput } from "../auth/password.js";
import type {
  AuthenticatedPrincipal,
  AuthenticationSession,
  PendingUserSetup,
  WorkspaceMemberAddition,
  WorkspaceMember,
  WorkspaceMembershipAccess,
  WorkspaceRole,
  WorkspacePasswordPolicy,
  WorkspaceSecurityOverview,
  WorkspaceSummary,
} from "../auth/model.js";
import { AuthenticationStore } from "../auth/store.js";
import { WorkspaceSecurityPolicyStore } from "../auth/security-policy-store.js";
import {
  authorizeCatalogSourceForPrincipal,
  authorizeDocumentVersionForPrincipal,
  type CatalogSourceAuthorization,
  authorizeSourceLibraryForPrincipal,
  readDefaultSourceLibraryId,
  readPrivateSourceLibraryId,
  WorkspaceSourceLibraryUnavailableError,
} from "../workspaces/source-library-access.js";
import {
  SourceLibraryStore,
} from "../workspaces/source-library-store.js";
import {
  reconcileNextSharedSourceLibraryDeletion,
  requestSharedSourceLibraryDeletion,
} from "../workspaces/source-library-deletion.js";
import {
  WorkspaceSettingsRepository,
  type EffectiveWorkspaceSettings,
} from "../workspaces/settings-store.js";
import type {
  CreateSharedSourceLibraryInput,
  RenameSharedSourceLibraryInput,
  SourceLibraryAdministration,
  SourceLibraryAccess,
  SourceLibrarySummary,
} from "../workspaces/source-library-model.js";
import {
  OpenAICodexCredentialStore,
  type OpenAICodexConnectionState,
} from "../providers/openai-codex-credentials.js";
import type {
  SourceContentMigrationRequest,
} from "./source-content-storage-boundary.js";
import type {
  OpenAICodexOAuthCredentials,
} from "../providers/openai-codex-oauth.js";
import {
  readOpenAICodexModels,
  type OpenAICodexModel,
} from "../providers/openai-codex-models.js";
import {
  copyEmbeddingInputFormat,
  EmbeddingInputFormatStore,
  retireEmbeddingInputFormat,
  reviseEmbeddingInputFormat,
  type EmbeddingInputFormatRecord,
} from "../embedding/input-format-store.js";
import type {
  EmbeddingInputFormatDefinition,
} from "../embedding/input-format-model.js";
import { streamChatMessageWithRuntime } from "../chat/pipeline.js";
import {
  processNextChatVerificationWithRuntime,
} from "../chat/verification-dispatcher.js";
import {
  processNextResearchVerificationWithRuntime,
} from "../research/verification-dispatcher.js";
import { ChatStore } from "../chat/store.js";
import type { RuntimeWebServices } from "./runtime-web-services.js";

export type {
  RuntimeChatServices,
  RuntimeDocumentServices,
  RuntimeOperationalServices,
  RuntimeResearchServices,
  RuntimeWebServices,
} from "./runtime-web-services.js";

export interface WebServices {
  archiveWorkspace: (
    principal: AuthenticatedPrincipal,
    workspaceId: string,
  ) => Promise<void>;
  authenticate: (input: LoginInput) => Promise<AuthenticationSession>;
  completePasswordSetup: (
    setupToken: string,
    password: PasswordInput,
  ) => Promise<AuthenticationSession>;
  copyEmbeddingInputFormat: (
    sourceId: string,
    name: string,
  ) => Promise<EmbeddingInputFormatRecord>;
  createEmbeddingInputFormat: (
    definition: EmbeddingInputFormatDefinition,
  ) => Promise<EmbeddingInputFormatRecord>;
  createWorkspaceMember: (
    principal: AuthenticatedPrincipal,
    identity: NormalizedUserIdentity,
    role: WorkspaceRole,
  ) => Promise<WorkspaceMemberAddition>;
  createWorkspace: (
    principal: AuthenticatedPrincipal,
    input: CreateWorkspaceInput,
  ) => Promise<WorkspaceSummary>;
  createSharedSourceLibrary: (
    principal: AuthenticatedPrincipal,
    input: CreateSharedSourceLibraryInput,
  ) => Promise<SourceLibrarySummary>;
  archiveSharedSourceLibrary: (
    principal: AuthenticatedPrincipal,
    libraryId: string,
  ) => Promise<void>;
  deleteSharedSourceLibrary: (
    principal: AuthenticatedPrincipal,
    libraryId: string,
  ) => Promise<void>;
  createPasswordReset: (
    principal: AuthenticatedPrincipal,
    userId: string,
  ) => Promise<PendingUserSetup>;
  changeWorkspaceMemberRole: (
    principal: AuthenticatedPrincipal,
    userId: string,
    role: WorkspaceRole,
  ) => Promise<void>;
  changeWorkspaceMemberAccess: (
    principal: AuthenticatedPrincipal,
    userId: string,
    access: WorkspaceMembershipAccess,
  ) => Promise<void>;
  changePassword: (
    principal: AuthenticatedPrincipal,
    currentPassword: string,
    newPassword: PasswordInput,
  ) => Promise<void>;
  cancelSourceContentMigration: (
    id: string,
  ) => Promise<SourceContentMigrationRecord>;
  listWorkspaceMembers: (
    principal: AuthenticatedPrincipal,
  ) => Promise<WorkspaceMember[]>;
  listWorkspaces: (
    principal: AuthenticatedPrincipal,
  ) => Promise<WorkspaceSummary[]>;
  listSourceLibraries: (
    principal: AuthenticatedPrincipal,
  ) => Promise<SourceLibrarySummary[]>;
  readSourceLibraryAdministration: (
    principal: AuthenticatedPrincipal,
  ) => Promise<SourceLibraryAdministration>;
  renameWorkspace: (
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    input: RenameWorkspaceInput,
  ) => Promise<void>;
  renameSharedSourceLibrary: (
    principal: AuthenticatedPrincipal,
    libraryId: string,
    input: RenameSharedSourceLibraryInput,
  ) => Promise<void>;
  restoreSharedSourceLibrary: (
    principal: AuthenticatedPrincipal,
    libraryId: string,
  ) => Promise<void>;
  openAICodex: {
    disconnect(): Promise<void>;
    readConnectionState(): Promise<OpenAICodexConnectionState>;
    readModels(signal: AbortSignal): Promise<OpenAICodexModel[]>;
    replaceCredentials(credentials: OpenAICodexOAuthCredentials): Promise<void>;
  };
  purgeApplicationErrors: (
    principal: AuthenticatedPrincipal,
  ) => Promise<ApplicationErrorPurgeResult>;
  readApplicationErrors: (
    principal: AuthenticatedPrincipal,
    request: ApplicationErrorPageRequest,
  ) => Promise<ApplicationErrorPage>;
  readRevisions: () => Promise<ApplicationStateRevisionSnapshot>;
  readSession: (sessionToken: string) => Promise<AuthenticatedPrincipal | null>;
  readSettings: () => Promise<EffectiveApplicationSettings>;
  readWorkspaceSettings: (
    principal: AuthenticatedPrincipal,
  ) => Promise<EffectiveWorkspaceSettings>;
  readSourceContentStorage: () => Promise<SourceContentStorageOverview>;
  reportApplicationError: (
    error: unknown,
    context: ApplicationErrorContext,
  ) => Promise<{ id: string }>;
  run: <T>(
    operation: (runtime: RuntimeWebServices) => Promise<T>,
  ) => Promise<T>;
  runInWorkspace: <T>(
    principal: AuthenticatedPrincipal,
    operation: (runtime: RuntimeWebServices) => Promise<T>,
  ) => Promise<T>;
  runManaged: <T>(
    operation: (runtime: RuntimeWebServices) => Promise<ManagedTask<T>>,
  ) => Promise<T>;
  runManagedInWorkspace: <T>(
    principal: AuthenticatedPrincipal,
    operation: (runtime: RuntimeWebServices) => Promise<ManagedTask<T>>,
  ) => Promise<T>;
  stream: <T>(
    operation: (runtime: RuntimeWebServices) => ReadableStream<T>,
  ) => ReadableStream<T>;
  streamInWorkspace: <T>(
    principal: AuthenticatedPrincipal,
    operation: (runtime: RuntimeWebServices) => ReadableStream<T>,
  ) => ReadableStream<T>;
  subscribeRevisions: (
    subscriber: ApplicationStateRevisionSubscriber,
  ) => () => void;
  revokeSession: (sessionToken: string) => Promise<void>;
  switchWorkspace: (
    principal: AuthenticatedPrincipal,
    workspaceId: string,
  ) => Promise<AuthenticatedPrincipal>;
  revokeSourceLibraryGrant: (
    principal: AuthenticatedPrincipal,
    libraryId: string,
    workspaceId: string,
  ) => Promise<void>;
  setSourceLibraryGrant: (
    principal: AuthenticatedPrincipal,
    libraryId: string,
    workspaceId: string,
    access: SourceLibraryAccess,
  ) => Promise<void>;
  removeWorkspaceMember: (
    principal: AuthenticatedPrincipal,
    userId: string,
  ) => Promise<void>;
  retireEmbeddingInputFormat: (
    id: string,
  ) => Promise<EmbeddingInputFormatRecord>;
  reviseEmbeddingInputFormat: (
    sourceId: string,
    definition: EmbeddingInputFormatDefinition,
  ) => Promise<EmbeddingInputFormatRecord>;
  queueSourceContentMigration: (
    requestedByUserId: string,
    request: SourceContentMigrationRequest,
  ) => Promise<SourceContentMigrationRecord>;
  testSourceContentStorage: (
    targetConfig: SourceContentConfig,
  ) => Promise<void>;
  updateSettings: (
    request: UpdateApplicationSettingsRequest,
  ) => Promise<EffectiveApplicationSettings>;
  updateWorkspaceSettings: (
    principal: AuthenticatedPrincipal,
    request: UpdateApplicationSettingsRequest,
  ) => Promise<EffectiveWorkspaceSettings>;
}

export interface SecurityWebServices {
  readPasswordPolicy: (
    principal: AuthenticatedPrincipal,
  ) => Promise<WorkspacePasswordPolicy>;
  readWorkspaceSecurityOverview: (
    principal: AuthenticatedPrincipal,
  ) => Promise<WorkspaceSecurityOverview>;
  updateWorkspaceSecurityPolicy: (
    principal: AuthenticatedPrincipal,
    input: UpdateWorkspaceSecurityPolicyInput,
  ) => Promise<WorkspaceSecurityOverview>;
}

export type ApplicationWebServices = WebServices & SecurityWebServices;

export interface OwnedWebServices {
  close(): Promise<void>;
  services: ApplicationWebServices;
}

export interface SettingsReloadController {
  close(): Promise<void>;
}

export interface SettingsReloadControllerDependencies {
  fallbackIntervalMs?: number;
  readCurrentVersion(): number;
  readSettings(): Promise<EffectiveApplicationSettings>;
  reload(config: AppConfig): Promise<boolean>;
  reportError?(error: unknown): Promise<void>;
  revisions: ApplicationStateRevisionSource;
}

const SETTINGS_REFRESH_FALLBACK_MS = 15_000;

export function createDiagnosticRunner(
  readHealth: (
    runtime: RuntimeWebServices,
    liveChecks: DoctorLiveChecks,
  ) => Promise<DoctorCheck[]>,
): (
  runtime: RuntimeWebServices,
  liveChecks: DoctorLiveChecks,
) => Promise<DoctorCheck[]> {
  const runningByRequest = new Map<string, Promise<DoctorCheck[]>>();
  return async (runtime, liveChecks): Promise<DoctorCheck[]> => {
    const requestKey = buildDiagnosticRequestKey(
      runtime.config.settingsVersion,
      liveChecks,
    );
    const running = runningByRequest.get(requestKey);
    if (running !== undefined) {
      return running;
    }
    const current = readHealth(runtime, liveChecks);
    runningByRequest.set(requestKey, current);
    try {
      return await current;
    } finally {
      if (runningByRequest.get(requestKey) === current) {
        runningByRequest.delete(requestKey);
      }
    }
  };
}

function buildDiagnosticRequestKey(
  settingsVersion: number,
  liveChecks: DoctorLiveChecks,
): string {
  const selection = [
    liveChecks.modelResponse ? "1" : "0",
    liveChecks.searchRanking ? "1" : "0",
    liveChecks.speech ? "1" : "0",
  ].join("");
  return `${settingsVersion}:${selection}`;
}

export async function startWebServices(
  config: AppConfig,
): Promise<OwnedWebServices> {
  const retentionConfig = readApplicationErrorRetentionConfig(process.env);
  const doclingTopology = readDoclingServiceTopologyFromConfig(config);
  const initialSettings = await readInitialSettings(config);
  const manager = await ApplicationRuntimeManager.start(initialSettings.config);
  let revisions: ApplicationStateRevisionSource;
  try {
    await manager.withRuntime(async (runtime) => {
      const sourceContentStore = new SourceContentStore(
        runtime.database,
        runtime.config.sourceContent,
        async (error, documentId) => {
          const reporter = new ApplicationErrorReporter(runtime.database);
          await reporter.report(error, {
            category: "source-content-deletion",
            code: "source_content_deletion_failed",
            documentId,
            instance: hostname(),
            operation: "reconcile-source-content-deletion",
            origin: "background-task",
            retryable: true,
            service: "web",
            severity: "warning",
          });
        },
      );
      await sourceContentStore.initialize();
      await sourceContentStore.reconcilePendingDeletions();
    });
    revisions = await PostgresApplicationStateRevisionSource.open(
      config.database,
      (message) => {
        const error = new Error(message);
        const context = {
          category: "database-operation",
          code: "revision_listener_failed",
          instance: hostname(),
          operation: "listen-application-state-revisions",
          origin: "background-task" as const,
          retryable: true,
          service: "web",
          severity: "warning" as const,
        };
        void manager.withRuntime(async (runtime) => {
          const reporter = new ApplicationErrorReporter(runtime.database);
          await reporter.report(error, context);
        }).catch((persistenceError: unknown) => {
          reportApplicationErrorToContainerLog(
            error,
            context,
            persistenceError,
          );
        });
      },
    );
  } catch (error: unknown) {
    await manager.shutdown();
    throw error;
  }
  const settingsReload = createSettingsReloadController({
    readCurrentVersion: () => manager.settingsVersion,
    readSettings: async () => manager.withRuntime(async (runtime) => {
      const repository = new ApplicationSettingsRepository(runtime.database);
      return repository.read(
        config.database,
        doclingTopology,
      );
    }),
    reload: async (nextConfig) => manager.reload(nextConfig),
    reportError: async (error) => manager.withRuntime(async (runtime) => {
      const reporter = new ApplicationErrorReporter(runtime.database);
      await reporter.report(error, {
        category: "settings-reload",
        code: "settings_reload_failed",
        instance: hostname(),
        operation: "reload-settings",
        origin: "settings-reload",
        retryable: true,
        service: "web",
        severity: "error",
      });
    }),
    revisions,
  });
  const errorRetention = startApplicationErrorRetentionController({
    cleanup: async () => manager.withRuntime(async (runtime) => {
      return enforceApplicationErrorRetention(
        runtime.database,
        retentionConfig,
      );
    }),
    reportError: async (error) => manager.withRuntime(async (runtime) => {
      const reporter = new ApplicationErrorReporter(runtime.database);
      await reporter.report(error, {
        category: "error-retention",
        code: "application_error_retention_failed",
        instance: hostname(),
        operation: "enforce-application-error-retention",
        origin: "background-task",
        retryable: true,
        service: "web",
        severity: "warning",
      });
    }),
    reportProgress: reportWebProgress,
  });
  const services = createWebServices(config, manager, revisions);
  return {
    close: async (): Promise<void> => {
      await errorRetention.close();
      await settingsReload.close();
      await revisions.close();
      await manager.shutdown();
    },
    services,
  };
}

export function createSettingsReloadController(
  dependencies: SettingsReloadControllerDependencies,
): SettingsReloadController {
  let closed = false;
  let refreshRequested = false;
  let running: Promise<void> | null = null;

  const refreshSettings = async (): Promise<void> => {
    const settings = await dependencies.readSettings();
    if (settings.version <= dependencies.readCurrentVersion()) {
      return;
    }
    await dependencies.reload(settings.config);
  };

  const requestRefresh = (): void => {
    if (closed) {
      return;
    }
    refreshRequested = true;
    if (running !== null) {
      return;
    }
    const refresh = async (): Promise<void> => {
      try {
        while (refreshRequested && !closed) {
          refreshRequested = false;
          await refreshSettings();
        }
      } catch (error: unknown) {
        if (dependencies.reportError === undefined) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`Application settings reload failed: ${message}`);
        } else {
          await dependencies.reportError(error);
        }
      } finally {
        running = null;
        if (refreshRequested && !closed) {
          requestRefresh();
        }
      }
    };
    running = refresh();
  };

  const unsubscribe = dependencies.revisions.subscribe((signal) => {
    if (signal.channel === "settings") {
      requestRefresh();
    }
  });
  const fallback = setInterval(
    requestRefresh,
    dependencies.fallbackIntervalMs ?? SETTINGS_REFRESH_FALLBACK_MS,
  );
  fallback.unref();
  return {
    close: async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(fallback);
      unsubscribe();
      await running;
    },
  };
}

export function createWebServices(
  config: AppConfig,
  manager: ApplicationRuntimeManager,
  revisions: ApplicationStateRevisionSource,
): ApplicationWebServices {
  const doclingTopology = readDoclingServiceTopologyFromConfig(config);
  const createWorkspaceRuntimeServices = async (
    runtime: ApplicationRuntime,
    principal: AuthenticatedPrincipal,
  ): Promise<RuntimeWebServices> => {
    const repository = new WorkspaceSettingsRepository(runtime.database);
    const workspaceConfig = await repository.readConfig(
      principal.workspaceId,
      config.database,
      doclingTopology,
    );
    const view = createApplicationRuntimeView(runtime, workspaceConfig);
    return createRuntimeWebServices(view);
  };
  const services: ApplicationWebServices = {
    archiveSharedSourceLibrary: async (principal, libraryId) => {
      return manager.withRuntime(async (runtime) => {
        const libraries = new SourceLibraryStore(runtime.database);
        await libraries.archiveShared(principal, libraryId);
      });
    },
    archiveWorkspace: async (principal, workspaceId) => {
      return manager.withRuntime(async (runtime) => {
        const authentication = new AuthenticationStore(runtime.database);
        await authentication.archiveWorkspace(principal, workspaceId);
      });
    },
    authenticate: async (input) => manager.withRuntime(async (runtime) => {
      const authentication = new AuthenticationStore(runtime.database);
      return authentication.authenticate(input);
    }),
    completePasswordSetup: async (setupToken, password) => {
      return manager.withRuntime(async (runtime) => {
        const authentication = new AuthenticationStore(runtime.database);
        return authentication.completePasswordSetup(setupToken, password);
      });
    },
    copyEmbeddingInputFormat: async (sourceId, name) => {
      return manager.withRuntime(async (runtime) => {
        return copyEmbeddingInputFormat(runtime.database, sourceId, name);
      });
    },
    createEmbeddingInputFormat: async (definition) => {
      return manager.withRuntime(async (runtime) => {
        const store = new EmbeddingInputFormatStore(runtime.database);
        return store.create(definition);
      });
    },
    changeWorkspaceMemberRole: async (principal, userId, role) => {
      return manager.withRuntime(async (runtime) => {
        const authentication = new AuthenticationStore(runtime.database);
        await authentication.changeWorkspaceMemberRole(principal, userId, role);
      });
    },
    changeWorkspaceMemberAccess: async (principal, userId, access) => {
      return manager.withRuntime(async (runtime) => {
        const authentication = new AuthenticationStore(runtime.database);
        await authentication.changeWorkspaceMemberAccess(
          principal,
          userId,
          access,
        );
      });
    },
    changePassword: async (principal, currentPassword, newPassword) => {
      return manager.withRuntime(async (runtime) => {
        const authentication = new AuthenticationStore(runtime.database);
        await authentication.changePassword(principal, currentPassword, newPassword);
      });
    },
    cancelSourceContentMigration: async (id) => {
      return manager.withRuntime(async (runtime) => {
        const repository = new SourceContentMigrationRepository(
          runtime.database,
        );
        return repository.requestCancellation(id);
      });
    },
    createWorkspaceMember: async (principal, identity, role) => {
      return manager.withRuntime(async (runtime) => {
        const authentication = new AuthenticationStore(runtime.database);
        return authentication.createWorkspaceMember(principal, identity, role);
      });
    },
    createWorkspace: async (principal, input) => {
      return manager.withRuntime(async (runtime) => {
        const authentication = new AuthenticationStore(runtime.database);
        return authentication.createWorkspace(principal, input);
      });
    },
    createSharedSourceLibrary: async (principal, input) => {
      return manager.withRuntime(async (runtime) => {
        const libraries = new SourceLibraryStore(runtime.database);
        return libraries.createShared(principal, input);
      });
    },
    deleteSharedSourceLibrary: async (principal, libraryId) => {
      return manager.withRuntime(async (runtime) => {
        await requestSharedSourceLibraryDeletion(
          runtime.database,
          principal,
          libraryId,
        );
      });
    },
    createPasswordReset: async (principal, userId) => {
      return manager.withRuntime(async (runtime) => {
        const authentication = new AuthenticationStore(runtime.database);
        return authentication.createPasswordReset(principal, userId);
      });
    },
    listWorkspaceMembers: async (principal) => {
      return manager.withRuntime(async (runtime) => {
        const authentication = new AuthenticationStore(runtime.database);
        return authentication.listWorkspaceMembers(principal);
      });
    },
    listWorkspaces: async (principal) => {
      return manager.withRuntime(async (runtime) => {
        const authentication = new AuthenticationStore(runtime.database);
        return authentication.listWorkspaces(principal);
      });
    },
    listSourceLibraries: async (principal) => {
      return manager.withRuntime(async (runtime) => {
        const libraries = new SourceLibraryStore(runtime.database);
        return libraries.listAccessible(principal);
      });
    },
    renameWorkspace: async (principal, workspaceId, input) => {
      return manager.withRuntime(async (runtime) => {
        const authentication = new AuthenticationStore(runtime.database);
        await authentication.renameWorkspace(principal, workspaceId, input);
      });
    },
    readSourceLibraryAdministration: async (principal) => {
      return manager.withRuntime(async (runtime) => {
        const libraries = new SourceLibraryStore(runtime.database);
        return libraries.readAdministration(principal);
      });
    },
    renameSharedSourceLibrary: async (principal, libraryId, input) => {
      return manager.withRuntime(async (runtime) => {
        const libraries = new SourceLibraryStore(runtime.database);
        await libraries.renameShared(principal, libraryId, input);
      });
    },
    restoreSharedSourceLibrary: async (principal, libraryId) => {
      return manager.withRuntime(async (runtime) => {
        const libraries = new SourceLibraryStore(runtime.database);
        await libraries.restoreShared(principal, libraryId);
      });
    },
    openAICodex: {
      disconnect: async () => manager.withRuntime(async (runtime) => {
        const credentials = new OpenAICodexCredentialStore(runtime.database);
        await credentials.disconnect();
      }),
      readConnectionState: async () => {
        return manager.withRuntime(async (runtime) => {
          const credentials = new OpenAICodexCredentialStore(runtime.database);
          return credentials.readConnectionState();
        });
      },
      readModels: async (signal) => {
        return manager.withRuntime(async (runtime) => {
          return readOpenAICodexModels(runtime.database, { signal });
        });
      },
      replaceCredentials: async (credentials) => {
        return manager.withRuntime(async (runtime) => {
          const store = new OpenAICodexCredentialStore(runtime.database);
          await store.replace(credentials);
        });
      },
    },
    purgeApplicationErrors: async (principal) => {
      return manager.withRuntime(async (runtime) => {
        return purgeApplicationErrors(
          runtime.database,
          principal.workspaceId,
        );
      });
    },
    readApplicationErrors: async (principal, request) => {
      return manager.withRuntime(async (runtime) => {
        return readApplicationErrorPage(
          runtime.database,
          principal.workspaceId,
          request,
        );
      });
    },
    readPasswordPolicy: async (principal) => {
      return manager.withRuntime(async (runtime) => {
        const securityPolicy = new WorkspaceSecurityPolicyStore(runtime.database);
        return securityPolicy.readPasswordPolicy(principal);
      });
    },
    readRevisions: async () => manager.withRuntime(async (runtime) => {
      return readApplicationStateRevisions(runtime.database);
    }),
    readSettings: async () => manager.withRuntime(async (runtime) => {
      const repository = new ApplicationSettingsRepository(runtime.database);
      return repository.read(
        config.database,
        doclingTopology,
      );
    }),
    readWorkspaceSettings: async (principal) => {
      return manager.withRuntime(async (runtime) => {
        const repository = new WorkspaceSettingsRepository(runtime.database);
        return repository.read(
          principal.workspaceId,
          config.database,
          doclingTopology,
        );
      });
    },
    readSourceContentStorage: async () => {
      return manager.withRuntime(async (runtime) => {
        const repository = new SourceContentMigrationRepository(
          runtime.database,
        );
        return repository.readOverview();
      });
    },
    readWorkspaceSecurityOverview: async (principal) => {
      return manager.withRuntime(async (runtime) => {
        const securityPolicy = new WorkspaceSecurityPolicyStore(runtime.database);
        return securityPolicy.readOverview(principal);
      });
    },
    reportApplicationError: async (error, context) => {
      return manager.withRuntime(async (runtime) => {
        const reporter = new ApplicationErrorReporter(runtime.database);
        const result = await reporter.report(error, context);
        return { id: result.event.id };
      });
    },
    readSession: async (sessionToken) => manager.withRuntime(async (runtime) => {
      const authentication = new AuthenticationStore(runtime.database);
      return authentication.readSession(sessionToken);
    }),
    run: async (operation) => manager.withRuntime(async (runtime) => {
      return operation(createRuntimeWebServices(runtime));
    }),
    runInWorkspace: async (principal, operation) => {
      return manager.withRuntime(async (runtime) => {
        const workspaceServices = await createWorkspaceRuntimeServices(
          runtime,
          principal,
        );
        return operation(workspaceServices);
      });
    },
    runManaged: async (operation) => manager.withManagedRuntime(async (runtime) => {
      return operation(createRuntimeWebServices(runtime));
    }),
    runManagedInWorkspace: async (principal, operation) => {
      return manager.withManagedRuntime(async (runtime) => {
        const workspaceServices = await createWorkspaceRuntimeServices(
          runtime,
          principal,
        );
        return operation(workspaceServices);
      });
    },
    stream: (operation) => manager.streamWithRuntime((runtime) => {
      return operation(createRuntimeWebServices(runtime));
    }),
    streamInWorkspace: (principal, operation) => {
      return manager.streamWithRuntimeAsync(async (runtime) => {
        const workspaceServices = await createWorkspaceRuntimeServices(
          runtime,
          principal,
        );
        return operation(workspaceServices);
      });
    },
    subscribeRevisions: (subscriber) => revisions.subscribe(subscriber),
    revokeSession: async (sessionToken) => manager.withRuntime(async (runtime) => {
      const authentication = new AuthenticationStore(runtime.database);
      await authentication.revokeSession(sessionToken);
    }),
    switchWorkspace: async (principal, workspaceId) => {
      return manager.withRuntime(async (runtime) => {
        const authentication = new AuthenticationStore(runtime.database);
        return authentication.switchWorkspace(principal, workspaceId);
      });
    },
    revokeSourceLibraryGrant: async (principal, libraryId, workspaceId) => {
      return manager.withRuntime(async (runtime) => {
        const libraries = new SourceLibraryStore(runtime.database);
        await libraries.revokeGrant(principal, libraryId, workspaceId);
      });
    },
    setSourceLibraryGrant: async (
      principal,
      libraryId,
      workspaceId,
      access,
    ) => {
      return manager.withRuntime(async (runtime) => {
        const libraries = new SourceLibraryStore(runtime.database);
        await libraries.setGrant(principal, libraryId, workspaceId, access);
      });
    },
    removeWorkspaceMember: async (principal, userId) => {
      return manager.withRuntime(async (runtime) => {
        const authentication = new AuthenticationStore(runtime.database);
        await authentication.removeWorkspaceMember(principal, userId);
      });
    },
    retireEmbeddingInputFormat: async (id) => {
      return manager.withRuntime(async (runtime) => {
        return retireEmbeddingInputFormat(runtime.database, id);
      });
    },
    reviseEmbeddingInputFormat: async (sourceId, definition) => {
      return manager.withRuntime(async (runtime) => {
        return reviseEmbeddingInputFormat(
          runtime.database,
          sourceId,
          definition,
        );
      });
    },
    queueSourceContentMigration: async (requestedByUserId, request) => {
      return manager.withRuntime(async (runtime) => {
        const repository = new SourceContentMigrationRepository(
          runtime.database,
        );
        return repository.queue({
          expectedSettingsVersion: request.expectedSettingsVersion,
          requestedByUserId,
          targetConfig: request.targetConfig,
        });
      });
    },
    testSourceContentStorage: async (targetConfig) => {
      await manager.withRuntime(async () => {
        const backend = createSourceContentBackend(targetConfig);
        await backend.initialize();
      });
    },
    updateSettings: async (request) => {
      const settings = await manager.withRuntime(async (runtime) => {
        const repository = new ApplicationSettingsRepository(runtime.database);
        return repository.update(
          config.database,
          doclingTopology,
          request.expectedVersion,
          request.changes,
          request.providerChanges,
        );
      });
      if (settings.version > manager.settingsVersion) {
        await manager.reload(settings.config);
      }
      return settings;
    },
    updateWorkspaceSettings: async (principal, request) => {
      return manager.withRuntime(async (runtime) => {
        const repository = new WorkspaceSettingsRepository(runtime.database);
        return repository.update(
          principal.workspaceId,
          principal.userId,
          config.database,
          doclingTopology,
          request.expectedVersion,
          request.changes,
          request.providerChanges,
        );
      });
    },
    updateWorkspaceSecurityPolicy: async (principal, input) => {
      return manager.withRuntime(async (runtime) => {
        const securityPolicy = new WorkspaceSecurityPolicyStore(runtime.database);
        return securityPolicy.update(principal, input);
      });
    },
  };
  return services;
}

function createRuntimeWebServices(
  runtime: ApplicationRuntime,
): RuntimeWebServices {
  const researchFor = (principal: AuthenticatedPrincipal): ResearchStore => {
    return new ResearchStore(
      runtime.database,
      runtime.config,
      readWorkspaceScope(principal),
    );
  };
  const chat = new ChatStore(runtime.database, runtime.config);
  const services: RuntimeWebServices = {
    addResearchFeedback: async (principal, input) => {
      return researchFor(principal).addFeedback(input, principal.userId);
    },
    browseDocuments: async (principal, request) => {
      if (request.sourceLibraryId !== null) {
        const authorization = await authorizeSourceLibraryForPrincipal(
          runtime.database,
          principal,
          request.sourceLibraryId,
          "use",
        );
        if (authorization.kind === "unavailable") {
          throw new WorkspaceSourceLibraryUnavailableError();
        }
        const workspaceId = authorization.kind === "workspace"
          ? authorization.workspaceId
          : null;
        return browseCatalogEntriesWithRuntime(runtime, request, workspaceId);
      }
      return browseCatalogEntriesWithRuntime(
        runtime,
        request,
        readWorkspaceScope(principal),
      );
    },
    compareDocumentVersions: async (principal, previousVersionId, currentVersionId) => {
      const [previousAuthorization, currentAuthorization] = await Promise.all([
        authorizeDocumentVersionForPrincipal(
          runtime.database,
          principal,
          previousVersionId,
        ),
        authorizeDocumentVersionForPrincipal(
          runtime.database,
          principal,
          currentVersionId,
        ),
      ]);
      const workspaceId = readMatchingCatalogAuthorizationWorkspaceId(
        previousAuthorization,
        currentAuthorization,
      );
      if (workspaceId === undefined) {
        return null;
      }
      const research = new ResearchStore(
        runtime.database,
        runtime.config,
        workspaceId,
      );
      return research.compareDocumentVersions(
        previousVersionId,
        currentVersionId,
      );
    },
    streamChatMessage: (principal, request, abortSignal) => {
      return streamChatMessageWithRuntime(
        runtime,
        principal,
        request,
        abortSignal,
        reportWebProgress,
      );
    },
    config: runtime.config,
    createChatConversation: async (principal, title, scope) => {
      return chat.createConversation(principal, title, scope);
    },
    createResearchThread: async (principal, title) => {
      return researchFor(principal).createThread(title);
    },
    deleteChatConversation: async (principal, id) => {
      return chat.deleteConversation(principal, id);
    },
    deleteResearchThread: async (principal, id) => {
      return researchFor(principal).deleteThread(id);
    },
    deleteIndexedDocument: async (principal, request) => {
      if (!await principalCanManageCatalogSource(runtime, principal, request.sourceFile)) {
        return { kind: "not-found" };
      }
      return deleteIndexedDocumentWithRuntime(runtime, request);
    },
    exportResearchThread: async (principal, id, format) => {
      return researchFor(principal).exportThread(id, format);
    },
    generateSpeech: async (request, abortSignal) => {
      const scheduler = runtime.scheduler(
        "textToSpeech",
        "interactive-answer",
      );
      const managedSpeech = await startManagedTask(
        scheduler,
        async (requestSignal) => {
          const speech = await generateTextToSpeech(
            runtime.config,
            request,
            requestSignal,
          );
          return {
            completion: speech.completion,
            value: speech,
          };
        },
        abortSignal,
      );
      return {
        audio: managedSpeech.value.audio,
        completion: managedSpeech.completion,
        contentType: managedSpeech.value.contentType,
      };
    },
    processNextChatVerification: async (abortSignal) => {
      return processNextChatVerificationWithRuntime(runtime, abortSignal);
    },
    processNextResearchVerification: async (abortSignal) => {
      return processNextResearchVerificationWithRuntime(runtime, abortSignal);
    },
    ingest: async (
      principal,
      documents,
      options,
      duplicateSourceRoot,
      requestedSourceLibraryId,
    ) => {
      let sourceLibraryId = requestedSourceLibraryId;
      if (sourceLibraryId !== null) {
        const authorization = await authorizeSourceLibraryForPrincipal(
          runtime.database,
          principal,
          sourceLibraryId,
          "manage",
        );
        if (authorization.kind === "unavailable") {
          throw new WorkspaceSourceLibraryUnavailableError();
        }
      } else if (principal.dataScope === "all") {
        sourceLibraryId = await readDefaultSourceLibraryId(runtime.database);
      } else if (
        principal.dataScope === "workspace"
        && sourceLibraryId === null
      ) {
        sourceLibraryId = await readPrivateSourceLibraryId(
          runtime.database,
          principal.workspaceId,
        );
      }
      return ingestStagedDocumentsWithRuntime(
        runtime,
        documents,
        options,
        reportWebProgress,
        duplicateSourceRoot,
        principal.userId,
        sourceLibraryId,
      );
    },
    listDocumentVersions: async (principal, sourceFile) => {
      const authorization = await authorizeCatalogSourceForPrincipal(
        runtime.database,
        principal,
        sourceFile,
        "use",
      );
      if (authorization.kind === "unavailable") {
        return [];
      }
      const workspaceId = authorization.kind === "workspace"
        ? authorization.workspaceId
        : null;
      const research = new ResearchStore(
        runtime.database,
        runtime.config,
        workspaceId,
      );
      return research.listDocumentVersions(sourceFile);
    },
    listChatConversations: async (principal) => {
      return chat.listConversations(principal);
    },
    listResearchThreads: async (principal) => researchFor(principal).listThreads(),
    readCitationEvidence: async (principal, id) => {
      const record = await researchFor(principal).readCitation(id);
      return record?.citation ?? null;
    },
    readCitationHighlightedFile: async (principal, id) => {
      const principalResearch = researchFor(principal);
      const record = await principalResearch.readCitation(id);
      if (record === null) {
        return null;
      }
      const document = await principalResearch.readDocumentVersionFile(
        record.citation.documentVersionId,
      );
      if (document === null) {
        return null;
      }
      return buildHighlightedCitationFile(
        record.citation,
        document,
        `/api/document-versions/${encodeURIComponent(record.citation.documentVersionId)}/file`,
      );
    },
    readCitationImage: async (principal, id) => {
      const record = await researchFor(principal).readCitation(id);
      if (record === null) {
        return null;
      }
      if (record.element.kind !== "image") {
        throw new ResearchInputConflictError(
          "The selected citation is not image evidence.",
        );
      }
      return {
        content: Buffer.from(record.element.content, "base64"),
        mediaType: record.element.mimeType,
      };
    },
    readChatCitationEvidence: async (principal, id) => {
      const record = await chat.readCitation(principal, id);
      return record?.citation ?? null;
    },
    readChatCitationFile: async (principal, id) => {
      const [record, document] = await Promise.all([
        chat.readCitation(principal, id),
        chat.readCitationFile(principal, id),
      ]);
      if (record === null || document === null) {
        return null;
      }
      return {
        content: document.content,
        documentId: record.citation.documentId,
        filename: basename(record.citation.sourceFile),
        mediaType: document.mediaType,
        sourceFile: record.citation.sourceFile,
      };
    },
    readChatCitationHighlightedFile: async (principal, id) => {
      const [record, document] = await Promise.all([
        chat.readCitation(principal, id),
        chat.readCitationFile(principal, id),
      ]);
      if (record === null || document === null) {
        return null;
      }
      return buildHighlightedCitationFile(
        record.citation,
        document,
        `/api/chat/citations/${encodeURIComponent(record.citation.id)}/file`,
      );
    },
    readChatCitationImage: async (principal, id) => {
      const record = await chat.readCitation(principal, id);
      if (record === null) {
        return null;
      }
      if (
        record.citation.evidence.kind !== "image"
        || record.imageContent === null
      ) {
        throw new ResearchInputConflictError(
          "The selected citation is not image evidence.",
        );
      }
      return {
        content: record.imageContent,
        mediaType: record.citation.evidence.mimeType,
      };
    },
    readChatConversation: async (principal, id) => {
      return chat.readConversation(principal, id);
    },
    readDocumentFile: async (principal, request) => {
      const authorization = await authorizeCatalogSourceForPrincipal(
        runtime.database,
        principal,
        request.sourceFile,
        "use",
      );
      if (authorization.kind === "unavailable") {
        return null;
      }
      const workspaceId = authorization.kind === "workspace"
        ? authorization.workspaceId
        : null;
      return readIndexedDocumentFileWithRuntime(
        runtime,
        request,
        workspaceId,
      );
    },
    readHealth: async (liveChecks) => runDoctorWithRuntime(runtime, liveChecks),
    readResearchThread: async (principal, id) => researchFor(principal).readThread(id),
    readResearchFeedback: async (principal, turnId, dimension, citationId) => {
      return researchFor(principal).readFeedbackSummary(
        turnId,
        dimension,
        citationId,
        principal.userId,
      );
    },
    readRevisions: async () => readApplicationStateRevisions(runtime.database),
    readStatus: async (principal) => {
      return readSystemStatusWithRuntime(runtime, readWorkspaceScope(principal));
    },
    readTelemetry: async () => readTelemetryDashboardWithRuntime(runtime),
    readVersionedDocumentFile: async (principal, id) => {
      const authorization = await authorizeDocumentVersionForPrincipal(
        runtime.database,
        principal,
        id,
        "use",
      );
      if (authorization.kind === "unavailable") {
        return null;
      }
      const workspaceId = authorization.kind === "workspace"
        ? authorization.workspaceId
        : null;
      const principalResearch = new ResearchStore(
        runtime.database,
        runtime.config,
        workspaceId,
      );
      const [document, version] = await Promise.all([
        principalResearch.readDocumentVersionFile(id),
        principalResearch.readDocumentVersion(id),
      ]);
      if (document === null || version === null) {
        return null;
      }
      return {
        content: document.content,
        documentId: version.documentId,
        filename: basename(version.sourceFile),
        mediaType: document.mediaType,
        sourceFile: version.sourceFile,
      };
    },
    reconcileUploadedDocuments: async (uploadDirectory) => {
      const catalog = new DocumentCatalog(runtime.database);
      const obsoleteSourceFiles = await catalog.reconcileUploadedDuplicates(
        uploadDirectory,
      );
      const abandoned = await deleteAbandonedUploadStaging(uploadDirectory);
      return obsoleteSourceFiles.length + abandoned;
    },
    reconcileIngestionCancellations: async () => {
      await reconcileIngestionControlExecutions(
        runtime.database,
        runtime.config,
      );
      await reconcileIngestionCancellations(
        runtime.database,
        runtime.config.sourceContent,
      );
    },
    reconcileSourceLibraryDeletions: async () => {
      return reconcileNextSharedSourceLibraryDeletion(runtime);
    },
    reindexDocument: async (principal, request, actor) => {
      if (!await principalCanManageCatalogSource(runtime, principal, request.sourceFile)) {
        return { kind: "not-found" };
      }
      return queueDocumentReindexWithRuntime(
        runtime,
        request,
        actor.userId,
        reportWebProgress,
      );
    },
    retryFailedJob: async (principal, sourceFile) => {
      if (!await principalCanManageCatalogSource(runtime, principal, sourceFile)) {
        return { kind: "not-found" };
      }
      return retryFailedIngestionWithRuntime(runtime, sourceFile);
    },
    requestIngestionControl: async (principal, sourceFile, action, actor) => {
      if (!await principalCanManageCatalogSource(runtime, principal, sourceFile)) {
        return { kind: "not-found" };
      }
      return requestIngestionControlWithRuntime(
        runtime,
        sourceFile,
        action,
        actor,
      );
    },
    resumeIngestion: async (principal, sourceFile, actor) => {
      if (!await principalCanManageCatalogSource(runtime, principal, sourceFile)) {
        return { kind: "not-found" };
      }
      return resumeIngestionWithRuntime(runtime, sourceFile, actor);
    },
    searchSources: async (principal, request, abortSignal) => {
      return searchIndexedSourcesWithRuntime(
        runtime,
        request,
        reportWebProgress,
        abortSignal,
        readWorkspaceScope(principal),
      );
    },
    streamAnswer: (principal, request, abortSignal) => {
      return streamIndexedDocumentAnswerWithRuntime(
        runtime,
        request.question,
        reportWebProgress,
        request.scope,
        request.threadId,
        abortSignal,
        readWorkspaceScope(principal),
      );
    },
    transcribeAudio: async (audio, abortSignal) => {
      const scheduler = runtime.scheduler(
        "speechToText",
        "interactive-answer",
      );
      return scheduler.run(
        (requestSignal) => transcribeSpeechAudio(
          runtime.config,
          audio,
          requestSignal,
        ),
        abortSignal,
      );
    },
    updateDocumentTags: async (principal, request) => {
      const authorization = await authorizeCatalogSourceForPrincipal(
        runtime.database,
        principal,
        request.sourceFile,
        "manage",
      );
      if (authorization.kind === "unavailable") {
        return null;
      }
      const workspaceId = authorization.kind === "workspace"
        ? authorization.workspaceId
        : null;
      return updateIndexedDocumentTagsWithRuntime(
        runtime,
        request,
        workspaceId,
      );
    },
  };
  return services;
}

function readWorkspaceScope(principal: AuthenticatedPrincipal): string | null {
  return principal.dataScope === "all"
    ? null
    : principal.workspaceId;
}

function readMatchingCatalogAuthorizationWorkspaceId(
  first: CatalogSourceAuthorization,
  second: CatalogSourceAuthorization,
): string | null | undefined {
  if (first.kind === "unavailable" || second.kind === "unavailable") {
    return undefined;
  }
  if (first.kind === "global" && second.kind === "global") {
    return null;
  }
  if (
    first.kind === "workspace"
    && second.kind === "workspace"
    && first.workspaceId === second.workspaceId
  ) {
    return first.workspaceId;
  }
  return undefined;
}

async function principalCanManageCatalogSource(
  runtime: ApplicationRuntime,
  principal: AuthenticatedPrincipal,
  sourceFile: string,
): Promise<boolean> {
  const authorization = await authorizeCatalogSourceForPrincipal(
    runtime.database,
    principal,
    sourceFile,
    "manage",
  );
  return authorization.kind !== "unavailable";
}

async function buildHighlightedCitationFile(
  citation: Pick<
    StoredCitationRecord,
    "documentId" | "evidence" | "regions" | "sourceFile"
  >,
  document: Pick<IndexedDocumentFile, "content" | "mediaType">,
  originalFileUrl: string,
): Promise<IndexedDocumentFile> {
  if (document.mediaType === "application/pdf" && citation.regions.length > 0) {
    const content = await renderHighlightedPdf(document.content, citation.regions);
    return {
      content,
      documentId: citation.documentId,
      filename: basename(citation.sourceFile),
      mediaType: document.mediaType,
      sourceFile: citation.sourceFile,
    };
  }
  if (document.mediaType === "text/html" || document.mediaType === "text/plain") {
    const result = renderHighlightedTextDocument({
      content: document.content,
      evidence: citation.evidence,
      filename: basename(citation.sourceFile),
      mediaType: document.mediaType,
      originalFileUrl,
    });
    return {
      content: result.content,
      documentId: citation.documentId,
      filename: `${basename(citation.sourceFile)}.evidence.html`,
      mediaType: "text/html",
      sourceFile: citation.sourceFile,
    };
  }
  return {
    content: document.content,
    documentId: citation.documentId,
    filename: basename(citation.sourceFile),
    mediaType: document.mediaType,
    sourceFile: citation.sourceFile,
  };
}

async function readInitialSettings(
  config: AppConfig,
): Promise<EffectiveApplicationSettings> {
  const doclingTopology = readDoclingServiceTopologyFromConfig(config);
  const session = await openDatabase(config.database);
  try {
    const repository = new ApplicationSettingsRepository(session.database);
    return await repository.read(
      config.database,
      doclingTopology,
    );
  } finally {
    await session.close();
  }
}

function reportWebProgress(message: string): void {
  console.info(`[web] ${message}`);
}
