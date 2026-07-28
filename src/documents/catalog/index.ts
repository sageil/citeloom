import { CatalogDocumentStore } from "./document-store.js";
import {
  CatalogIngestionLifecycle,
  type PrepareIngestionRequest,
} from "./ingestion-lifecycle.js";
import {
  CatalogJobStore,
  type DoclingJobDemand,
} from "./job-store.js";
import type {
  CatalogEntry,
  Clock,
  IngestionControlDoclingTask,
  DoclingTaskReference,
  DocumentStatistics,
  IndexedDocument,
  IngestionJob,
  IngestionPhase,
  JobFailureResult,
  PrepareIngestionResult,
  PromotionResult,
  PublishedDocument,
  RequestIngestionControlResult,
  ResumeIngestionResult,
  RunningIngestionJob,
  RetryFailedJobResult,
} from "./model.js";
import type { CiteLoomDatabase } from "../../database/client.js";
import type {
  PreparedApplicationErrorEvent,
} from "../../observability/application-errors.js";
import type { DoclingAttemptConfigSnapshot } from "../../docling/protocol/run-metadata.js";
import type {
  QueryScope,
  ResolvedQueryScopeTarget,
} from "../../domain/query-scope.js";

export { QueryScopeNotResolvedError } from "./model.js";
export type {
  CatalogEntry,
  Clock,
  DoclingTaskReference,
  ElementCounts,
  DocumentStatistics,
  IndexedDocument,
  IngestionJob,
  IngestionControlState,
  IngestionControlDoclingTask,
  IngestionPhase,
  IngestionState,
  JobFailureResult,
  PendingIngestionJob,
  PrepareIngestionResult,
  PromotionResult,
  PublishedDocument,
  RequestIngestionControlResult,
  ResumeIngestionResult,
  RunningIngestionJob,
  RetryFailedJobResult,
} from "./model.js";
export type { PrepareIngestionRequest } from "./ingestion-lifecycle.js";
export type { DoclingJobDemand } from "./job-store.js";

const systemClock: Clock = { now: () => new Date() };
const DEFAULT_LEASE_DURATION_MS = 120_000;

export interface DocumentCatalogOptions {
  clock?: Clock;
  leaseDurationMs?: number;
  newLeaseOwnerId?: () => string;
}

export class DocumentCatalog {
  private readonly clock: Clock;
  private readonly documents: CatalogDocumentStore;
  private readonly jobs: CatalogJobStore;
  private readonly lifecycle: CatalogIngestionLifecycle;

  public constructor(
    database: CiteLoomDatabase,
    options: DocumentCatalogOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.documents = new CatalogDocumentStore(database);
    this.jobs = new CatalogJobStore(
      database,
      this.clock,
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      options.newLeaseOwnerId,
    );
    this.lifecycle = new CatalogIngestionLifecycle(
      database,
      this.jobs,
      this.documents,
      this.clock,
    );
  }

  public async prepareIngestion(
    request: PrepareIngestionRequest,
  ): Promise<PrepareIngestionResult> {
    return this.lifecycle.prepareIngestion(request);
  }

  public async getJob(sourceFile: string): Promise<IngestionJob | null> {
    return this.jobs.getJob(sourceFile);
  }

  public async reconcileUploadedDuplicates(
    duplicateSourceRoot: string,
  ): Promise<string[]> {
    return this.lifecycle.reconcileUploadedDuplicates(duplicateSourceRoot);
  }

  public async claimJob(
    sourceFile: string,
    phase: IngestionPhase,
  ): Promise<RunningIngestionJob | null> {
    return this.jobs.claimJob(sourceFile, phase);
  }

  public async claimNextJob(
    embeddingSpaceId: string,
    newDoclingAssignmentsAvailable: boolean = true,
  ): Promise<IngestionJob | null> {
    return this.jobs.claimNextJob(
      embeddingSpaceId,
      newDoclingAssignmentsAvailable,
    );
  }

  public async claimNextNonDoclingJob(
    embeddingSpaceId: string,
  ): Promise<IngestionJob | null> {
    return this.jobs.claimNextNonDoclingJob(embeddingSpaceId);
  }

  public async claimDoclingJob(
    sourceFile: string,
    eligibleServiceIds: readonly string[],
    allowUnassignedJobs: boolean,
  ): Promise<IngestionJob | null> {
    return this.jobs.claimDoclingJob(
      sourceFile,
      eligibleServiceIds,
      allowUnassignedJobs,
    );
  }

  public async readDueDoclingDemand(
    embeddingSpaceId: string,
  ): Promise<DoclingJobDemand> {
    return this.jobs.readDueDoclingDemand(embeddingSpaceId);
  }

  public async readDoclingDemandForJob(
    sourceFile: string,
  ): Promise<DoclingJobDemand | null> {
    return this.jobs.readDoclingDemandForJob(sourceFile);
  }

  public async claimNextDoclingJob(
    embeddingSpaceId: string,
    eligibleServiceIds: readonly string[],
    allowUnassignedJobs: boolean,
  ): Promise<IngestionJob | null> {
    return this.jobs.claimNextDoclingJob(
      embeddingSpaceId,
      eligibleServiceIds,
      allowUnassignedJobs,
    );
  }

  public async renewJobLease(sourceFile: string, ownerId: string) {
    return this.jobs.renewJobLease(sourceFile, ownerId);
  }

  public async requestIngestionControl(
    sourceFile: string,
    action: "pause" | "cancel",
    actor: { isAdministrator: boolean; userId: string },
  ): Promise<RequestIngestionControlResult> {
    return this.jobs.requestControl(sourceFile, action, actor);
  }

  public async resumePausedIngestion(
    sourceFile: string,
    actor: { isAdministrator: boolean; userId: string },
  ): Promise<ResumeIngestionResult> {
    return this.jobs.resumePausedJob(sourceFile, actor);
  }

  public async settleOwnedIngestionControl(
    sourceFile: string,
    ownerId: string,
  ): Promise<IngestionJob | null> {
    return this.jobs.settleOwnedControl(sourceFile, ownerId);
  }

  public async settleExpiredIngestionControls(): Promise<IngestionJob[]> {
    return this.jobs.settleExpiredControls();
  }

  public async ensureDoclingAttemptConfig(
    sourceFile: string,
    ownerId: string,
    proposed: DoclingAttemptConfigSnapshot,
  ): Promise<DoclingAttemptConfigSnapshot> {
    return this.jobs.ensureDoclingAttemptConfig(sourceFile, ownerId, proposed);
  }

  public async readDoclingTaskCheckpoint(
    sourceFile: string,
    ownerId: string,
    requestKey: string,
    serviceInstanceId: string,
  ): Promise<DoclingTaskReference | null> {
    return this.jobs.readDoclingTaskCheckpoint(
      sourceFile,
      ownerId,
      requestKey,
      serviceInstanceId,
    );
  }

  public async recordDoclingTaskCheckpoint(
    sourceFile: string,
    ownerId: string,
    requestKey: string,
    task: DoclingTaskReference,
    serviceInstanceId: string,
  ): Promise<boolean> {
    return this.jobs.recordDoclingTaskCheckpoint(
      sourceFile,
      ownerId,
      requestKey,
      task,
      serviceInstanceId,
    );
  }

  public async clearDoclingTaskCheckpoint(
    sourceFile: string,
    ownerId: string,
    requestKey: string,
    taskId: string,
    serviceInstanceId: string,
  ): Promise<boolean> {
    return this.jobs.clearDoclingTaskCheckpoint(
      sourceFile,
      ownerId,
      requestKey,
      taskId,
      serviceInstanceId,
    );
  }

  public async readRequestedControlDoclingTasks(
    sourceFile?: string,
  ): Promise<IngestionControlDoclingTask[]> {
    return this.jobs.readRequestedControlDoclingTasks(sourceFile);
  }

  public async acknowledgeDoclingTaskControl(
    sourceFile: string,
    serviceInstanceId: string,
    taskId: string,
    outcome: "paused" | "terminated",
  ): Promise<boolean> {
    return this.jobs.acknowledgeDoclingTaskControl(
      sourceFile,
      serviceInstanceId,
      taskId,
      outcome,
    );
  }

  public async recordIngestionControlError(
    sourceFile: string,
    error: string,
  ): Promise<boolean> {
    return this.jobs.recordIngestionControlError(sourceFile, error);
  }

  public async completeNormalization(
    sourceFile: string,
    ownerId: string,
    elementSetId: string,
    statistics: DocumentStatistics,
  ): Promise<void> {
    await this.jobs.completeNormalization(
      sourceFile,
      ownerId,
      elementSetId,
      statistics,
    );
  }

  public async completeIndexing(
    sourceFile: string,
    ownerId: string,
  ): Promise<void> {
    await this.jobs.completeIndexing(sourceFile, ownerId);
  }

  public async markJobFailed(
    sourceFile: string,
    ownerId: string,
    errorMessage: string,
    applicationError: PreparedApplicationErrorEvent,
    retryBaseMs: number = 5_000,
  ): Promise<JobFailureResult | null> {
    return this.jobs.markJobFailed(
      sourceFile,
      ownerId,
      errorMessage,
      applicationError,
      retryBaseMs,
    );
  }

  public async releaseJob(
    sourceFile: string,
    ownerId: string,
    delayMs: number = 0,
  ): Promise<boolean> {
    return this.jobs.releaseJob(sourceFile, ownerId, delayMs);
  }

  public async retryFailedJob(
    sourceFile: string,
  ): Promise<RetryFailedJobResult> {
    return this.jobs.retryFailedJob(sourceFile);
  }

  public async promoteJob(
    sourceFile: string,
    ownerId: string,
  ): Promise<PromotionResult> {
    return this.lifecycle.promoteJob(sourceFile, ownerId);
  }

  public async countDocumentReferences(documentId: string): Promise<number> {
    return this.documents.countDocumentReferences(documentId);
  }

  public async listJobs(): Promise<IngestionJob[]> {
    return this.jobs.listJobs();
  }

  public async cancelAvailableJob(
    sourceFile: string,
  ): Promise<IngestionJob | null> {
    return this.jobs.cancelAvailableJob(sourceFile);
  }

  public async cancelAvailableJobs(
    sourceFiles: string[],
  ): Promise<IngestionJob[]> {
    return this.jobs.cancelAvailableJobs(sourceFiles);
  }

  public async listEntries(): Promise<CatalogEntry[]> {
    return this.documents.listEntries();
  }

  public async listAvailableDocuments(
    embeddingSpaceId: string,
  ): Promise<IndexedDocument[]> {
    return this.documents.listAvailableDocuments(embeddingSpaceId);
  }

  public async findIndexedDocument(
    documentId: string,
    sourceFile: string,
  ): Promise<PublishedDocument | null> {
    return this.documents.findIndexedDocument(documentId, sourceFile);
  }

  public async resolveQueryScope(
    scope: QueryScope,
    embeddingSpaceId: string,
  ): Promise<ResolvedQueryScopeTarget[]> {
    return this.documents.resolveQueryScope(scope, embeddingSpaceId);
  }
}
