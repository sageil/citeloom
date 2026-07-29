import { basename } from "node:path";
import { hostname } from "node:os";

import type { InferUIMessageChunk } from "ai";

import type { CiteLoomUIMessage } from "../answers/stream.js";
import {
  ApplicationRuntimeManager,
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
import type {
  BrowseDocumentCatalogRequest,
  BrowseDocumentCatalogResult,
} from "../documents/catalog/browser.js";
import {
  DocumentCatalog,
  type IngestionControlActor,
} from "../documents/catalog/index.js";
import {
  readApplicationErrorRetentionConfig,
  readDoclingServiceTopologyFromConfig,
  type AppConfig,
} from "../config/index.js";
import { openDatabase } from "../database/client.js";
import {
  browseCatalogEntriesWithRuntime,
  readIndexedDocumentFileWithRuntime,
  updateIndexedDocumentTagsWithRuntime,
  type IndexedDocumentFile,
  type ReadDocumentFileRequest,
  type UpdateIndexedDocumentTagsRequest,
  type UpdateIndexedDocumentTagsResult,
} from "../documents/catalog/service.js";
import { SourceContentStore } from "../documents/storage/source-content-store.js";
import {
  ingestStagedDocumentsWithRuntime,
  queueDocumentReindexWithRuntime,
  requestIngestionControlWithRuntime,
  resumeIngestionWithRuntime,
  retryFailedIngestionWithRuntime,
  type BulkIngestResult,
  type IngestOptions,
  type ReindexDocumentRequest,
  type ReindexDocumentResult,
  type RetryFailedIngestionResult,
  type StagedIngestionDocument,
} from "../ingestion/service.js";
import {
  deleteAbandonedUploadStaging,
  deleteIndexedDocumentWithRuntime,
  reconcileIngestionCancellations,
  type DeleteIndexedDocumentResult,
} from "../ingestion/deletion.js";
import { reconcileIngestionControlExecutions } from "../ingestion/control.js";
import { runDoctorWithRuntime, type DoctorCheck } from "../observability/doctor.js";
import {
  ApplicationErrorReporter,
  reportApplicationErrorToContainerLog,
  type ApplicationErrorContext,
} from "../observability/application-errors.js";
import {
  readApplicationErrorPage,
  type ApplicationErrorPage,
  type ApplicationErrorPageRequest,
} from "../observability/application-error-store.js";
import {
  enforceApplicationErrorRetention,
  startApplicationErrorRetentionController,
} from "../observability/application-error-retention.js";
import { renderHighlightedPdf } from "../research/evidence-document.js";
import {
  searchIndexedSourcesWithRuntime,
} from "../retrieval/discovery/pipeline.js";
import {
  streamIndexedDocumentAnswerWithRuntime,
} from "../retrieval/pipeline.js";
import type {
  DocumentVersionDifference,
  DocumentVersionRecord,
  FeedbackDimension,
  ResearchFeedbackSummary,
  ResearchThread,
  ResearchThreadSummary,
  StoredCitationRecord,
} from "../research/types.js";
import {
  ResearchInputConflictError,
  ResearchStore,
  type ResearchExport,
  type ResearchExportFormat,
} from "../research/store.js";
import type {
  SourceDiscoveryRequest,
  SourceDiscoveryResponse,
} from "../retrieval/discovery/schema.js";
import {
  transcribeAudio as transcribeSpeechAudio,
  type TranscriptionAudio,
  type TranscriptionResult,
} from "../providers/speech-to-text.js";
import {
  generateTextToSpeech,
  type GeneratedSpeech,
  type SpeechRequest,
} from "../providers/text-to-speech.js";
import {
  startManagedTask,
  type ManagedTask,
} from "../shared/concurrency.js";
import {
  readTelemetryDashboardWithRuntime,
  type TelemetryDashboardSummary,
} from "../observability/store.js";
import type {
  QuestionRequest,
  UpdateApplicationSettingsRequest,
} from "./request-boundary.js";
import {
  readSystemStatusWithRuntime,
  type SystemStatus,
} from "../ingestion/worker.js";
import type {
  LoginInput,
  NormalizedUserIdentity,
} from "../auth/boundary.js";
import type {
  AuthenticatedPrincipal,
  AuthenticationSession,
  PendingUserSetup,
  WorkspaceMemberAddition,
  WorkspaceMember,
  WorkspaceRole,
} from "../auth/model.js";
import { AuthenticationStore } from "../auth/store.js";
import {
  OpenAICodexCredentialStore,
  type OpenAICodexConnectionState,
} from "../providers/openai-codex-credentials.js";
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

export interface RuntimeWebServices {
  readonly config: AppConfig;
  browseDocuments: (
    request: BrowseDocumentCatalogRequest,
  ) => Promise<BrowseDocumentCatalogResult>;
  addResearchFeedback: (input: {
    citationId: string | null;
    comment: string | null;
    dimension: FeedbackDimension;
    rating: -1 | 1;
    turnId: string;
  }, userId: string) => Promise<ResearchFeedbackSummary>;
  readResearchFeedback: (
    turnId: string,
    dimension: FeedbackDimension,
    citationId: string | null,
    userId: string,
  ) => Promise<ResearchFeedbackSummary>;
  compareDocumentVersions: (
    previousVersionId: string,
    currentVersionId: string,
  ) => Promise<DocumentVersionDifference | null>;
  createResearchThread: (title: string) => Promise<ResearchThread>;
  deleteResearchThread: (id: string) => Promise<void>;
  deleteIndexedDocument?: (
    request: ReindexDocumentRequest,
  ) => Promise<DeleteIndexedDocumentResult>;
  exportResearchThread: (
    id: string,
    format: ResearchExportFormat,
  ) => Promise<ResearchExport | null>;
  generateSpeech: (
    request: SpeechRequest,
    abortSignal: AbortSignal,
  ) => Promise<GeneratedSpeech>;
  ingest: (
    documents: readonly StagedIngestionDocument[],
    options: IngestOptions,
    duplicateSourceRoot: string,
    uploadedByUserId: string,
  ) => Promise<BulkIngestResult>;
  listDocumentVersions: (sourceFile: string) => Promise<DocumentVersionRecord[]>;
  listResearchThreads: () => Promise<ResearchThreadSummary[]>;
  readCitationEvidence: (id: string) => Promise<StoredCitationRecord | null>;
  readCitationHighlightedPdf: (id: string) => Promise<IndexedDocumentFile | null>;
  readCitationImage: (id: string) => Promise<{
    content: Buffer;
    mediaType: string;
  } | null>;
  readDocumentFile: (
    request: ReadDocumentFileRequest,
  ) => Promise<IndexedDocumentFile | null>;
  readHealth: () => Promise<DoctorCheck[]>;
  readResearchThread: (id: string) => Promise<ResearchThread | null>;
  readRevisions: () => Promise<ApplicationStateRevisionSnapshot>;
  readStatus: () => Promise<SystemStatus>;
  readTelemetry: () => Promise<TelemetryDashboardSummary>;
  readVersionedDocumentFile: (id: string) => Promise<IndexedDocumentFile | null>;
  reconcileUploadedDocuments?: (uploadDirectory: string) => Promise<number>;
  reconcileIngestionCancellations?: () => Promise<void>;
  reindexDocument: (
    request: ReindexDocumentRequest,
    actor: IngestionControlActor,
  ) => Promise<ReindexDocumentResult>;
  retryFailedJob: (
    sourceFile: string,
  ) => Promise<RetryFailedIngestionResult>;
  requestIngestionControl: (
    sourceFile: string,
    action: "pause" | "cancel",
    actor: IngestionControlActor,
  ) => ReturnType<typeof requestIngestionControlWithRuntime>;
  resumeIngestion: (
    sourceFile: string,
    actor: IngestionControlActor,
  ) => ReturnType<typeof resumeIngestionWithRuntime>;
  searchSources: (
    request: SourceDiscoveryRequest,
    abortSignal: AbortSignal,
  ) => Promise<SourceDiscoveryResponse>;
  streamAnswer: (
    request: QuestionRequest,
    abortSignal: AbortSignal,
  ) => ReadableStream<InferUIMessageChunk<CiteLoomUIMessage>>;
  transcribeAudio: (
    audio: TranscriptionAudio,
    abortSignal: AbortSignal,
  ) => Promise<TranscriptionResult>;
  updateDocumentTags?: (
    request: UpdateIndexedDocumentTagsRequest,
  ) => Promise<UpdateIndexedDocumentTagsResult | null>;
}

export interface WebServices {
  authenticate: (input: LoginInput) => Promise<AuthenticationSession>;
  completePasswordSetup: (
    setupToken: string,
    password: string,
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
  createPasswordReset: (
    principal: AuthenticatedPrincipal,
    userId: string,
  ) => Promise<PendingUserSetup>;
  changeWorkspaceMemberRole: (
    principal: AuthenticatedPrincipal,
    userId: string,
    role: WorkspaceRole,
  ) => Promise<void>;
  changePassword: (
    principal: AuthenticatedPrincipal,
    currentPassword: string,
    newPassword: string,
  ) => Promise<void>;
  listWorkspaceMembers: (
    principal: AuthenticatedPrincipal,
  ) => Promise<WorkspaceMember[]>;
  openAICodex: {
    disconnect(): Promise<void>;
    readConnectionState(): Promise<OpenAICodexConnectionState>;
    readModels(signal: AbortSignal): Promise<OpenAICodexModel[]>;
    replaceCredentials(credentials: OpenAICodexOAuthCredentials): Promise<void>;
  };
  readApplicationErrors: (
    principal: AuthenticatedPrincipal,
    request: ApplicationErrorPageRequest,
  ) => Promise<ApplicationErrorPage>;
  readRevisions: () => Promise<ApplicationStateRevisionSnapshot>;
  readSession: (sessionToken: string) => Promise<AuthenticatedPrincipal | null>;
  readSettings: () => Promise<EffectiveApplicationSettings>;
  reportApplicationError: (
    error: unknown,
    context: ApplicationErrorContext,
  ) => Promise<{ id: string }>;
  run: <T>(
    operation: (runtime: RuntimeWebServices) => Promise<T>,
  ) => Promise<T>;
  runManaged: <T>(
    operation: (runtime: RuntimeWebServices) => Promise<ManagedTask<T>>,
  ) => Promise<T>;
  stream: <T>(
    operation: (runtime: RuntimeWebServices) => ReadableStream<T>,
  ) => ReadableStream<T>;
  subscribeRevisions: (
    subscriber: ApplicationStateRevisionSubscriber,
  ) => () => void;
  revokeSession: (sessionToken: string) => Promise<void>;
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
  updateSettings: (
    request: UpdateApplicationSettingsRequest,
  ) => Promise<EffectiveApplicationSettings>;
}

export interface OwnedWebServices {
  close(): Promise<void>;
  services: WebServices;
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
  readHealth: (runtime: RuntimeWebServices) => Promise<DoctorCheck[]>,
): (runtime: RuntimeWebServices) => Promise<DoctorCheck[]> {
  const runningBySettingsVersion = new Map<number, Promise<DoctorCheck[]>>();
  return async (runtime): Promise<DoctorCheck[]> => {
    const settingsVersion = runtime.config.settingsVersion;
    const running = runningBySettingsVersion.get(settingsVersion);
    if (running !== undefined) {
      return running;
    }
    const current = readHealth(runtime);
    runningBySettingsVersion.set(settingsVersion, current);
    try {
      return await current;
    } finally {
      if (runningBySettingsVersion.get(settingsVersion) === current) {
        runningBySettingsVersion.delete(settingsVersion);
      }
    }
  };
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
): WebServices {
  const doclingTopology = readDoclingServiceTopologyFromConfig(config);
  const services: WebServices = {
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
    changePassword: async (principal, currentPassword, newPassword) => {
      return manager.withRuntime(async (runtime) => {
        const authentication = new AuthenticationStore(runtime.database);
        await authentication.changePassword(principal, currentPassword, newPassword);
      });
    },
    createWorkspaceMember: async (principal, identity, role) => {
      return manager.withRuntime(async (runtime) => {
        const authentication = new AuthenticationStore(runtime.database);
        return authentication.createWorkspaceMember(principal, identity, role);
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
    readApplicationErrors: async (principal, request) => {
      return manager.withRuntime(async (runtime) => {
        return readApplicationErrorPage(
          runtime.database,
          principal.workspaceId,
          request,
        );
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
    runManaged: async (operation) => manager.withManagedRuntime(async (runtime) => {
      return operation(createRuntimeWebServices(runtime));
    }),
    stream: (operation) => manager.streamWithRuntime((runtime) => {
      return operation(createRuntimeWebServices(runtime));
    }),
    subscribeRevisions: (subscriber) => revisions.subscribe(subscriber),
    revokeSession: async (sessionToken) => manager.withRuntime(async (runtime) => {
      const authentication = new AuthenticationStore(runtime.database);
      await authentication.revokeSession(sessionToken);
    }),
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
  };
  return services;
}

function createRuntimeWebServices(
  runtime: ApplicationRuntime,
): RuntimeWebServices {
  const research = new ResearchStore(runtime.database, runtime.config);
  const services: RuntimeWebServices = {
    addResearchFeedback: async (input, userId) => research.addFeedback(input, userId),
    browseDocuments: async (request) => {
      return browseCatalogEntriesWithRuntime(runtime, request);
    },
    compareDocumentVersions: async (previousVersionId, currentVersionId) => {
      return research.compareDocumentVersions(previousVersionId, currentVersionId);
    },
    config: runtime.config,
    createResearchThread: async (title) => research.createThread(title),
    deleteResearchThread: async (id) => research.deleteThread(id),
    deleteIndexedDocument: async (request) => {
      return deleteIndexedDocumentWithRuntime(runtime, request);
    },
    exportResearchThread: async (id, format) => research.exportThread(id, format),
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
    ingest: async (documents, options, duplicateSourceRoot, uploadedByUserId) => {
      return ingestStagedDocumentsWithRuntime(
        runtime,
        documents,
        options,
        reportWebProgress,
        duplicateSourceRoot,
        uploadedByUserId,
      );
    },
    listDocumentVersions: async (sourceFile) => {
      return research.listDocumentVersions(sourceFile);
    },
    listResearchThreads: async () => research.listThreads(),
    readCitationEvidence: async (id) => {
      const record = await research.readCitation(id);
      return record?.citation ?? null;
    },
    readCitationHighlightedPdf: async (id) => {
      const record = await research.readCitation(id);
      if (record === null) {
        return null;
      }
      const document = await research.readDocumentVersionFile(
        record.citation.documentVersionId,
      );
      if (document === null) {
        return null;
      }
      if (document.mediaType !== "application/pdf") {
        throw new ResearchInputConflictError(
          "Highlighted evidence files are available only for PDF sources.",
        );
      }
      if (record.citation.regions.length === 0) {
        throw new ResearchInputConflictError(
          "The selected citation has no stored PDF regions to highlight.",
        );
      }
      const content = await renderHighlightedPdf(
        document.content,
        record.citation.regions,
      );
      return {
        content,
        documentId: record.citation.documentId,
        filename: basename(record.citation.sourceFile),
        mediaType: document.mediaType,
        sourceFile: record.citation.sourceFile,
      };
    },
    readCitationImage: async (id) => {
      const record = await research.readCitation(id);
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
    readDocumentFile: async (request) => {
      return readIndexedDocumentFileWithRuntime(runtime, request);
    },
    readHealth: async () => runDoctorWithRuntime(runtime),
    readResearchThread: async (id) => research.readThread(id),
    readResearchFeedback: async (turnId, dimension, citationId, userId) => {
      return research.readFeedbackSummary(turnId, dimension, citationId, userId);
    },
    readRevisions: async () => readApplicationStateRevisions(runtime.database),
    readStatus: async () => readSystemStatusWithRuntime(runtime),
    readTelemetry: async () => readTelemetryDashboardWithRuntime(runtime),
    readVersionedDocumentFile: async (id) => {
      const [document, version] = await Promise.all([
        research.readDocumentVersionFile(id),
        research.readDocumentVersion(id),
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
    reindexDocument: async (request, actor) => {
      return queueDocumentReindexWithRuntime(
        runtime,
        request,
        actor.userId,
        reportWebProgress,
      );
    },
    retryFailedJob: async (sourceFile) => {
      return retryFailedIngestionWithRuntime(runtime, sourceFile);
    },
    requestIngestionControl: async (sourceFile, action, actor) => {
      return requestIngestionControlWithRuntime(
        runtime,
        sourceFile,
        action,
        actor,
      );
    },
    resumeIngestion: async (sourceFile, actor) => {
      return resumeIngestionWithRuntime(runtime, sourceFile, actor);
    },
    searchSources: async (request, abortSignal) => {
      return searchIndexedSourcesWithRuntime(
        runtime,
        request,
        reportWebProgress,
        abortSignal,
      );
    },
    streamAnswer: (request, abortSignal) => {
      return streamIndexedDocumentAnswerWithRuntime(
        runtime,
        request.question,
        reportWebProgress,
        request.scope,
        request.threadId,
        abortSignal,
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
    updateDocumentTags: async (request) => {
      return updateIndexedDocumentTagsWithRuntime(runtime, request);
    },
  };
  return services;
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
