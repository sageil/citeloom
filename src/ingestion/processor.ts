import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename } from "node:path";

import type {
  ApplicationRuntime,
  RuntimeInferenceCoordinator,
} from "../app/runtime.js";
import { createRuntimeTaskScheduler } from "../app/runtime.js";
import {
  createInferenceModelRegistry,
  type InferenceModelRegistry,
} from "../inference/registry.js";
import {
  deletePermanentDocumentIngestionArtifacts,
  deleteTemporaryDocumentIngestionArtifacts,
  IngestionArtifactStore,
} from "./artifact-store.js";
import {
  DocumentCatalog,
  type DocumentStatistics,
  type IngestionJob,
  type IngestionControlState,
  type IngestionPhase,
  type PromotionResult,
  type RunningIngestionJob,
} from "../documents/catalog/index.js";
import type { TaskScheduler } from "../shared/concurrency.js";
import type { AppConfig } from "../config/index.js";
import type { CiteLoomDatabase } from "../database/client.js";
import {
  isPlainTextFormat,
  readDocumentSourceByteLength,
  type DocumentSource,
  type FileDocumentSource,
} from "../documents/format.js";
import { createPlainTextElements } from "../documents/plain-text.js";
import type { DoclingTaskControl } from "../docling/client/task.js";
import type { DoclingTaskControlFactory } from "../docling/client/task.js";
import {
  noOpDoclingConversionObserver,
  type DoclingConversionObserver,
} from "../docling/client/observer.js";
import {
  createDoclingAttemptConfigSnapshot,
  restoreDoclingConfig,
  type DoclingAttemptConfigSnapshot,
} from "../docling/protocol/run-metadata.js";
import {
  DoclingMetricsStore,
  type CompleteDoclingMetricsRunInput,
  type DoclingMetricsRecorder,
} from "../docling/observability/metrics-store.js";
import {
  partitionDocumentContents,
  isDoclingTaskDeadlineFailure,
  readDoclingErrorCategory,
  readDoclingFailureContext,
  type DoclingJsonRequester,
} from "../docling/index.js";
import type { SourceElement } from "../domain/source-elements.js";
import type {
  RetrievalDescriptionRecord,
} from "../domain/retrieval-descriptions.js";
import {
  createDisabledDocumentTocArtifact,
  generateDocumentTocArtifact,
} from "../retrieval/toc/generation.js";
import {
  readStagedDocumentTocArtifact,
  stageDocumentTocArtifact,
  type DocumentTocGenerationIdentity,
} from "../retrieval/toc/store.js";
import {
  DoclingCapacityUnavailableError,
  DoclingServiceStore,
  StaleDoclingServiceVerificationError,
  type DoclingServiceAssignment,
} from "../docling/service-store.js";
import {
  DoclingServiceVerifier,
  type DoclingVerificationDemand,
  type DoclingVerificationFailure,
  type DoclingVerificationResult,
} from "../docling/service-verifier.js";
import {
  InferenceCoordinator,
  InferenceLeaseLostError,
  StaleInferenceSettingsError,
} from "../inference/coordinator.js";
import { readInferenceErrorMessage } from "../inference/error.js";
import {
  embedDocumentInputs,
  embedDocumentTexts,
  type DocumentEmbeddingInput,
} from "../embedding/inference.js";
import {
  createRetrievalDescriptionContext,
  describeRetrievalElement,
  doesRetrievalDescriptionMatchElement,
  isDescribableElement,
  type RetrievalDescriptionContext,
} from "./retrieval-description.js";
import {
  beginEmbeddingGeneration,
  deleteDocumentRetrievalRows,
  ensureEmbeddingSpace,
  stageRetrievalRepresentationBatch,
} from "../retrieval/indexing/index.js";
import {
  createRetrievalWindows,
  countRetrievalEmbeddingInputTokens,
} from "../retrieval/windows.js";
import {
  addContextToImageRetrievalRepresentations,
  blendRetrievalEmbeddingsWithDocumentTitle,
  buildDocumentTitleEmbeddingContent,
  createRetrievalRepresentations,
  linkRetrievalRepresentationNeighbors,
  splitRetrievalRepresentationAtTokenLimit,
  splitRetrievalRepresentationsAtTokenLimit,
  type RetrievalRepresentation,
} from "../retrieval/representations.js";
import {
  SourceDocumentStore,
  deleteStoredDocumentEvidence,
  type DocumentElementSet,
} from "../documents/storage/source-document-store.js";
import { SourceContentStore } from "../documents/storage/source-content-store.js";
import { reconcileIngestionControlExecutions } from "./control.js";
import {
  ApplicationErrorReporter,
  type ApplicationErrorOrigin,
  type DoclingErrorDetailInput,
} from "../observability/application-errors.js";

export type ProcessJobResult =
  | { kind: "deferred" }
  | { error: string; kind: "failed"; retryAt: string | null }
  | { kind: "interrupted" }
  | { kind: "indexed"; promotion: PromotionResult }
  | { kind: "lease-lost" };

export type IngestionClaimResult =
  | {
    doclingProbeFailed: boolean;
    doclingServicesWaiting: boolean;
    job: IngestionJob;
    kind: "claimed";
    requiresDocling: boolean;
  }
  | {
    doclingProbeFailed: boolean;
    doclingServicesWaiting: true;
    failures: DoclingVerificationFailure[];
    kind: "docling-unavailable";
  }
  | { kind: "idle" };

export interface IngestionProcessorDependencies {
  doclingRequester?: DoclingJsonRequester;
}

const CONTROL_POLL_INTERVAL_MS = 2_000;
export const RETRIEVAL_DESCRIPTION_WORKSET_SIZE = 16;
export const EMBEDDING_ELEMENT_BATCH_SIZE = 16;

class IngestionControlInterruption extends Error {
  public constructor(
    public readonly controlState: "pause_requested" | "cancel_requested",
  ) {
    super(`Ingestion control requested: ${controlState}.`);
    this.name = "IngestionControlInterruption";
  }
}

class IngestionLeaseLostError extends Error {
  public constructor(sourceFile: string, cause?: unknown) {
    super(`Ingestion lease was lost for ${sourceFile}.`, { cause });
    this.name = "IngestionLeaseLostError";
  }
}

class DoclingIngestionAttemptError extends Error {
  public constructor(
    public readonly conversionRunId: string,
    cause: unknown,
  ) {
    super(readErrorMessage(cause), { cause });
    this.name = "DoclingIngestionAttemptError";
  }
}
const passiveAbortSignal = new AbortController().signal;

export class IngestionProcessor {
  public readonly artifactStore: IngestionArtifactStore;
  public readonly catalog: DocumentCatalog;
  public readonly documentStore: SourceDocumentStore;
  public readonly sourceContentStore: SourceContentStore;

  private readonly descriptionScheduler: TaskScheduler;
  private readonly embeddingScheduler: TaskScheduler;
  private readonly errors: ApplicationErrorReporter;
  private readonly inferenceCoordinator: RuntimeInferenceCoordinator;
  private readonly models: InferenceModelRegistry;
  private readonly metrics: DoclingMetricsStore;
  private readonly services: DoclingServiceStore;
  private readonly serviceVerifier: DoclingServiceVerifier;
  private readonly sharedRuntime: boolean;

  public constructor(
    private readonly config: AppConfig,
    private readonly database: CiteLoomDatabase,
    private readonly reportProgress: (message: string) => void,
    runtime?: ApplicationRuntime,
    dependencies: IngestionProcessorDependencies = {},
  ) {
    this.sharedRuntime = runtime !== undefined;
    this.artifactStore = new IngestionArtifactStore(database);
    this.catalog = new DocumentCatalog(database);
    this.documentStore = new SourceDocumentStore(database);
    this.errors = new ApplicationErrorReporter(database);
    this.sourceContentStore = new SourceContentStore(
      database,
      config.sourceContent,
      async (error, documentId) => {
        await this.errors.report(error, {
          category: "source-content-deletion",
          code: "source_content_deletion_failed",
          documentId,
          instance: hostname(),
          operation: "reconcile-source-content-deletion",
          origin: "background-task",
          retryable: true,
          service: "worker",
          severity: "warning",
        });
      },
    );
    this.metrics = new DoclingMetricsStore(database);
    this.services = new DoclingServiceStore(database);
    this.serviceVerifier = new DoclingServiceVerifier(
      config,
      this.services,
      dependencies.doclingRequester,
    );
    if (runtime === undefined) {
      this.inferenceCoordinator = new InferenceCoordinator(database);
      this.models = createInferenceModelRegistry(config, database);
      this.embeddingScheduler = createRuntimeTaskScheduler(
        config,
        this.inferenceCoordinator,
        "embedding",
        "ingestion",
      );
      this.descriptionScheduler = createRuntimeTaskScheduler(
        config,
        this.inferenceCoordinator,
        "indexing",
        "ingestion",
      );
      return;
    }
    this.inferenceCoordinator = runtime.inferenceCoordinator;
    this.models = runtime.models;
    this.embeddingScheduler = runtime.scheduler("embedding", "ingestion");
    this.descriptionScheduler = runtime.scheduler(
      "indexing",
      "ingestion",
    );
  }

  public async initialize(): Promise<void> {
    const topologyPromise = this.serviceVerifier.initialize();
    await this.sourceContentStore.initialize();
    const deletionReport =
      await this.sourceContentStore.reconcilePendingDeletions();
    if (deletionReport.failed > 0) {
      this.reportProgress(
        `${deletionReport.failed} source content deletion(s) remain pending.`,
      );
    }
    if (!this.sharedRuntime) {
      await Promise.all([
        ensureEmbeddingSpace(this.database, this.config.embeddingSpace),
        this.inferenceCoordinator.configure(this.config.scheduling),
        topologyPromise,
      ]);
    } else {
      await topologyPromise;
    }
  }

  public async claimNextJob(
    allowDoclingVerification: boolean = true,
  ): Promise<IngestionClaimResult> {
    await this.sourceContentStore.reconcilePendingDeletions();
    await reconcileIngestionControlExecutions(
      this.database,
      this.config,
    );
    await this.catalog.settleExpiredIngestionControls();
    const nonDoclingJob = await this.catalog.claimNextNonDoclingJob(
      this.config.embeddingSpace.id,
    );
    if (nonDoclingJob !== null) {
      return {
        doclingProbeFailed: false,
        doclingServicesWaiting: false,
        job: nonDoclingJob,
        kind: "claimed",
        requiresDocling: false,
      };
    }
    const demand = await this.catalog.readDueDoclingDemand(
      this.config.embeddingSpace.id,
    );
    if (
      demand.assignedServiceIds.length === 0
      && !demand.hasUnassignedJobs
    ) {
      return { kind: "idle" };
    }
    const verification = await this.verifyDoclingDemand(
      demand,
      allowDoclingVerification,
    );
    if (verification === null) {
      return {
        doclingProbeFailed: true,
        doclingServicesWaiting: true,
        failures: [],
        kind: "docling-unavailable",
      };
    }
    const doclingServicesWaiting = hasDoclingServicesWaiting(
      demand,
      verification,
    );
    for (const failure of verification.failures) {
      this.reportProgress(
        `Docling service ${failure.serviceId} is unavailable: ${failure.errorCategory}.`,
      );
    }
    if (verification.availableServiceIds.length === 0) {
      return {
        doclingProbeFailed: verification.probeFailed,
        doclingServicesWaiting: true,
        failures: verification.failures,
        kind: "docling-unavailable",
      };
    }
    const doclingJob = await this.catalog.claimNextDoclingJob(
      this.config.embeddingSpace.id,
      verification.availableServiceIds,
      demand.hasUnassignedJobs,
    );
    if (doclingJob === null) {
      if (doclingServicesWaiting) {
        return {
          doclingProbeFailed: verification.probeFailed,
          doclingServicesWaiting: true,
          failures: verification.failures,
          kind: "docling-unavailable",
        };
      }
      return { kind: "idle" };
    }
    return {
      doclingProbeFailed: verification.probeFailed,
      doclingServicesWaiting,
      job: doclingJob,
      kind: "claimed",
      requiresDocling: true,
    };
  }

  public async claimJob(
    sourceFile: string,
    phase: IngestionPhase,
  ): Promise<IngestionClaimResult> {
    if (phase !== "discovered") {
      const job = await this.catalog.claimJob(sourceFile, phase);
      return job === null
        ? { kind: "idle" }
        : {
          doclingProbeFailed: false,
          doclingServicesWaiting: false,
          job,
          kind: "claimed",
          requiresDocling: false,
        };
    }
    const pendingJob = await this.catalog.getJob(sourceFile);
    if (pendingJob === null || pendingJob.phase !== "discovered") {
      return { kind: "idle" };
    }
    if (isPlainTextFormat(pendingJob.format)) {
      const job = await this.catalog.claimJob(sourceFile, phase);
      return job === null
        ? { kind: "idle" }
        : {
          doclingProbeFailed: false,
          doclingServicesWaiting: false,
          job,
          kind: "claimed",
          requiresDocling: false,
        };
    }
    const demand = await this.catalog.readDoclingDemandForJob(sourceFile);
    if (demand === null) {
      return { kind: "idle" };
    }
    const verification = await this.verifyDoclingDemand(demand);
    if (verification === null) {
      return {
        doclingProbeFailed: true,
        doclingServicesWaiting: true,
        failures: [],
        kind: "docling-unavailable",
      };
    }
    if (verification.availableServiceIds.length === 0) {
      return {
        doclingProbeFailed: verification.probeFailed,
        doclingServicesWaiting: true,
        failures: verification.failures,
        kind: "docling-unavailable",
      };
    }
    const assignedServiceId = demand.assignedServiceIds[0];
    if (
      assignedServiceId !== undefined
      && !verification.availableServiceIds.includes(assignedServiceId)
    ) {
      return {
        doclingProbeFailed: verification.probeFailed,
        doclingServicesWaiting: true,
        failures: verification.failures,
        kind: "docling-unavailable",
      };
    }
    const job = await this.catalog.claimDoclingJob(
      sourceFile,
      verification.availableServiceIds,
      demand.hasUnassignedJobs,
    );
    return job === null
      ? { kind: "idle" }
      : {
        doclingProbeFailed: verification.probeFailed,
        doclingServicesWaiting: false,
        job,
        kind: "claimed",
        requiresDocling: true,
      };
  }

  public async cleanExpiredDoclingMetrics(): Promise<number> {
    const repaired = await this.metrics.repairCompletedPartitionRuns();
    if (repaired > 0) {
      this.reportProgress(
        `Repaired ${repaired} Docling metric run(s) after partition recovery.`,
      );
    }
    return this.metrics.deleteExpiredRuns(
      this.config.docling.performanceMetricsRetentionDays,
    );
  }

  private async verifyDoclingDemand(
    demand: DoclingVerificationDemand,
    verifyUnavailableServices: boolean = true,
  ): Promise<DoclingVerificationResult | null> {
    try {
      return await this.serviceVerifier.verifyDemand(
        demand,
        verifyUnavailableServices,
      );
    } catch (error: unknown) {
      if (!(error instanceof StaleDoclingServiceVerificationError)) {
        throw error;
      }
      this.reportProgress(
        `Docling service ${error.serviceId} verification was invalidated by a configuration change.`,
      );
      return null;
    }
  }

  public async processClaimedJob(
    job: IngestionJob,
    abortSignal: AbortSignal = passiveAbortSignal,
  ): Promise<ProcessJobResult> {
    if (job.state !== "running") {
      throw new Error(`Ingestion job is not claimed: ${job.sourceFile}`);
    }
    const controlController = new AbortController();
    const heartbeat = await startLeaseHeartbeat(
      this.catalog,
      job,
      this.reportProgress,
      (controlState) => {
        controlController.abort(new IngestionControlInterruption(controlState));
      },
    );
    const phaseSignal = AbortSignal.any([
      abortSignal,
      controlController.signal,
      heartbeat.signal,
    ]);
    let heartbeatStop: Promise<void> | null = null;
    const stopHeartbeatOnce = async (): Promise<void> => {
      heartbeatStop ??= heartbeat.stop();
      await heartbeatStop;
    };
    try {
      phaseSignal.throwIfAborted();
      const promotion = await this.executePhase(job, phaseSignal);
      return { kind: "indexed", promotion };
    } catch (error: unknown) {
      if (heartbeat.signal.aborted) {
        await stopHeartbeatOnce();
        return this.finishLeaseLoss(job);
      }
      if (controlController.signal.aborted) {
        await stopHeartbeatOnce();
        const interruption = controlController.signal.reason;
        if (!(interruption instanceof IngestionControlInterruption)) {
          throw error;
        }
        return this.finishControlRequest(job, interruption.controlState);
      }
      if (abortSignal.aborted) {
        await stopHeartbeatOnce();
        const released = await this.catalog.releaseJob(
          job.sourceFile,
          job.ownerId,
        );
        if (!released) {
          return this.finishLeaseLoss(job);
        }
        this.reportProgress(
          `${basename(job.sourceFile)}: interrupted and returned to the queue`,
        );
        return { kind: "interrupted" };
      }
      const latestJob = await this.catalog.getJob(job.sourceFile);
      if (
        latestJob?.state === "running"
        && latestJob.ownerId === job.ownerId
        && isRequestedControlState(latestJob.controlState)
      ) {
        await stopHeartbeatOnce();
        return this.finishControlRequest(job, latestJob.controlState);
      }
      if (error instanceof DoclingCapacityUnavailableError) {
        await stopHeartbeatOnce();
        const released = await this.catalog.releaseJob(
          job.sourceFile,
          job.ownerId,
          5_000,
        );
        if (!released) {
          return this.finishLeaseLoss(job);
        }
        this.reportProgress(
          `${basename(job.sourceFile)}: waiting for an available Docling service slot`,
        );
        return { kind: "deferred" };
      }
      if (error instanceof StaleInferenceSettingsError) {
        await stopHeartbeatOnce();
        const released = await this.catalog.releaseJob(
          job.sourceFile,
          job.ownerId,
        );
        if (!released) {
          return this.finishLeaseLoss(job);
        }
        this.reportProgress(
          `${basename(job.sourceFile)}: settings changed and the job returned to the queue`,
        );
        return { kind: "deferred" };
      }
      const message = readErrorMessage(error);
      const doclingFailure = readDoclingFailureContext(error);
      const applicationError = this.errors.prepare(error, {
        attemptNumber: job.attemptCount + 1,
        category: readErrorCategory(error),
        code: `ingestion_${job.phase}_failed`,
        diagnosticMessage: message,
        documentId: job.documentId,
        doclingErrors: mapDoclingErrorDetails(doclingFailure.errors),
        instance: hostname(),
        jobId: job.generationId,
        operation: `ingestion-${job.phase}`,
        origin: readIngestionErrorOrigin(job, error, doclingFailure.origin),
        requestId: doclingFailure.requestId,
        requestSequence: doclingFailure.requestSequence,
        retryable: doclingFailure.retryable
          ?? job.attemptCount + 1 < job.maxAttempts,
        runId: readDoclingConversionRunId(error),
        service: "worker",
        severity: "error",
        sourceFile: job.sourceFile,
        taskId: doclingFailure.taskId,
      });
      const failure = await this.catalog.markJobFailed(
        job.sourceFile,
        job.ownerId,
        message,
        applicationError,
        this.config.retry.baseDelayMs,
      );
      if (failure === null) {
        return this.finishLeaseLoss(job);
      }
      const retryAt = failure.retryAt;
      this.reportProgress(formatFailureProgress(job.sourceFile, message, retryAt));
      return { error: message, kind: "failed", retryAt };
    } finally {
      await stopHeartbeatOnce();
    }
  }

  public async cleanAbandonedJob(job: IngestionJob): Promise<void> {
    if (await this.catalog.countDocumentReferences(job.documentId) > 0) {
      return;
    }
    await this.cleanDocumentData(job.documentId);
  }

  private async finishControlRequest(
    job: RunningIngestionJob,
    controlState: "pause_requested" | "cancel_requested",
  ): Promise<ProcessJobResult> {
    const controlledJob = await this.catalog.settleOwnedIngestionControl(
      job.sourceFile,
      job.ownerId,
    );
    if (controlledJob === null) {
      return this.finishLeaseLoss(job);
    }
    const result = controlState === "pause_requested" ? "paused" : "cancellation requested";
    this.reportProgress(`${basename(job.sourceFile)}: ${result}`);
    return { kind: "interrupted" };
  }

  private finishLeaseLoss(job: RunningIngestionJob): ProcessJobResult {
    this.reportProgress(
      `${basename(job.sourceFile)}: lease ownership was lost and processing stopped`,
    );
    return { kind: "lease-lost" };
  }

  private async executePhase(
    job: IngestionJob,
    abortSignal: AbortSignal,
  ): Promise<PromotionResult> {
    abortSignal.throwIfAborted();
    if (job.state !== "running") {
      throw new Error(`Ingestion job is not claimed: ${job.sourceFile}.`);
    }
    let currentJob = job;
    if (currentJob.phase === "discovered") {
      await this.normalize(currentJob, abortSignal);
      currentJob = await this.readAdvancedRunningJob(
        currentJob,
        "normalized",
      );
    }
    if (currentJob.phase === "normalized") {
      await this.index(currentJob, abortSignal);
      currentJob = await this.readAdvancedRunningJob(currentJob, "indexed");
    }
    if (currentJob.phase !== "indexed") {
      throw new Error(
        `Ingestion job ${currentJob.sourceFile} cannot be published from ${currentJob.phase}.`,
      );
    }
    abortSignal.throwIfAborted();
    return this.promote(currentJob);
  }

  private async normalize(job: IngestionJob, abortSignal: AbortSignal): Promise<void> {
    if (job.state !== "running") {
      throw new Error(`Cannot normalize unclaimed ingestion job ${job.sourceFile}.`);
    }
    const storedDocument = await this.sourceContentStore.readDocumentReference(
      job.documentId,
    );
    const source: FileDocumentSource = {
      byteLength: storedDocument.byteLength,
      contentPath: storedDocument.contentPath,
      documentId: storedDocument.documentId,
      extension: job.format.extension,
      kind: "file",
      mediaType: job.format.mediaType,
      sourceFile: job.sourceFile,
    };
    if (isPlainTextFormat(source)) {
      await this.normalizePlainText(job, source, abortSignal);
      return;
    }

    const startedAtMs = Date.now();
    this.reportProgress(`${basename(job.sourceFile)}: converting with Docling`);
    const schedulerQueuedAt = new Date();
    let schedulerAdmittedAt: Date | null = null;
    schedulerAdmittedAt = new Date();
    await this.runAssignedDoclingPartition(
      job,
      source,
      startedAtMs,
      schedulerQueuedAt,
      schedulerAdmittedAt,
      abortSignal,
    );
  }

  private async normalizePlainText(
    job: IngestionJob & { state: "running" },
    source: DocumentSource,
    abortSignal: AbortSignal,
  ): Promise<void> {
    this.reportProgress(`${basename(job.sourceFile)}: reading plain text`);
    const elements = await createPlainTextElements(source, abortSignal);
    abortSignal.throwIfAborted();
    await this.documentStore.writeMany(elements);
    const elementSet = await this.documentStore.writeElementSet(
      job.documentId,
      elements,
    );
    const statistics = readDocumentStatistics(elements, null);
    await this.catalog.completeNormalization(
      job.sourceFile,
      job.ownerId,
      elementSet.id,
      statistics,
    );
  }

  private async runAssignedDoclingPartition(
    job: IngestionJob & { state: "running" },
    source: FileDocumentSource,
    startedAtMs: number,
    schedulerQueuedAt: Date,
    schedulerAdmittedAt: Date,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const assignment = await this.services.ensureAssignment(
      job.ownerId,
      job.sourceFile,
    );
    reportAssignedServiceState(assignment, job.sourceFile, this.reportProgress);
    const assignedDoclingConfig = {
      ...this.config.docling,
      baseUrl: assignment.baseUrl,
    };
    const proposedAttemptConfig = createDoclingAttemptConfigSnapshot(
      assignedDoclingConfig,
      this.config.settingsVersion,
    );
    const attemptConfig = await this.catalog.ensureDoclingAttemptConfig(
      job.sourceFile,
      job.ownerId,
      proposedAttemptConfig,
    );
    const vlmApiToken = readDoclingVlmApiToken(
      attemptConfig,
      this.config.docling,
    );
    const doclingConfig = restoreDoclingConfig(
      attemptConfig,
      this.config.docling.apiKey,
      vlmApiToken,
    );
    if (doclingConfig.baseUrl !== assignment.baseUrl) {
      throw new Error(
        `Stored Docling endpoint ${doclingConfig.baseUrl} does not match assigned service ${assignment.id} at ${assignment.baseUrl}.`,
      );
    }
    let metricsRecorder: DoclingMetricsRecorder | null = null;
    let conversionRunId: string = randomUUID();
    try {
      metricsRecorder = await this.metrics.startOrResumeRun({
        attemptConfig,
        byteLength: readDocumentSourceByteLength(source),
        documentId: source.documentId,
        fileExtension: source.extension,
        ingestionAttempt: job.attemptCount + 1,
        processConfig: assignment.process,
        serviceIdentity: assignment.serviceIdentity,
        sourceFile: job.sourceFile,
        startedAt: schedulerQueuedAt,
      }, this.reportProgress);
      conversionRunId = metricsRecorder?.runId ?? conversionRunId;
      metricsRecorder?.schedulerStarted(schedulerAdmittedAt);
    } catch (error: unknown) {
      this.reportProgress(
        `Docling metrics warning: ${readErrorCategory(error)}`,
      );
      await this.errors.report(error, {
        attemptNumber: job.attemptCount + 1,
        category: "database-operation",
        code: "docling_metrics_start_failed",
        documentId: job.documentId,
        instance: hostname(),
        jobId: job.generationId,
        operation: "start-docling-metrics-run",
        origin: "database-operation",
        retryable: true,
        runId: conversionRunId,
        service: "worker",
        severity: "warning",
        sourceFile: job.sourceFile,
      });
    }
    const conversionObserver: DoclingConversionObserver = metricsRecorder
      ?? noOpDoclingConversionObserver;
    const taskControls: DoclingTaskControlFactory = {
      open: async (requestKey): Promise<DoclingTaskControl> => {
        const current = await this.catalog.readDoclingTaskCheckpoint(
          job.sourceFile,
          job.ownerId,
          requestKey,
          assignment.id,
        );
        return {
          clear: async (taskId): Promise<void> => {
            const cleared = await this.catalog.clearDoclingTaskCheckpoint(
              job.sourceFile,
              job.ownerId,
              requestKey,
              taskId,
              assignment.id,
            );
            if (!cleared) {
              throw new Error(
                `Could not clear Docling task ${taskId} for ${job.sourceFile}.`,
              );
            }
          },
          current,
          kind: "durable",
          record: async (task): Promise<void> => {
            const recorded = await this.catalog.recordDoclingTaskCheckpoint(
              job.sourceFile,
              job.ownerId,
              requestKey,
              task,
              assignment.id,
            );
            if (!recorded) {
              throw new Error(
                `Could not record Docling task ${task.id} for ${job.sourceFile}.`,
              );
            }
          },
        };
      },
    };
    try {
      const partition = await partitionDocumentContents(
        source,
        doclingConfig,
        assignment.serviceIdentity,
        undefined,
        abortSignal,
        taskControls,
        conversionObserver,
      );
      abortSignal.throwIfAborted();
      await this.artifactStore.writeDoclingArtifact(partition.artifact);
      await this.documentStore.writeMany(partition.elements);
      const elementSet = await this.documentStore.writeElementSet(
        job.documentId,
        partition.elements,
      );
      const statistics = readDocumentStatistics(
        partition.elements,
        partition.pageCount,
      );
      await this.catalog.completeNormalization(
        job.sourceFile,
        job.ownerId,
        elementSet.id,
        statistics,
      );
      await completeDoclingMetricsSuccess(
        metricsRecorder,
        {
          elements: partition.elements,
          pageCount: partition.pageCount,
          totalWallMs: Date.now() - startedAtMs,
        },
        this.reportProgress,
      );
    } catch (error: unknown) {
      await completeDoclingMetricsFailure(
        metricsRecorder,
        abortSignal.aborted ? "abort" : readMetricsFailureOutcome(error),
        readErrorCategory(error),
        Date.now() - startedAtMs,
        this.reportProgress,
      );
      throw new DoclingIngestionAttemptError(conversionRunId, error);
    }
  }

  private async index(job: IngestionJob, abortSignal: AbortSignal): Promise<void> {
    this.reportProgress(
      `${basename(job.sourceFile)}: describing media and embedding retrieval representations`,
    );
    const elementSetId = requireElementSetId(job);
    const elementSet = await this.documentStore.readElementSet(elementSetId);
    assertElementSetMatchesJob(job, elementSet);
    const generation = {
      documentId: job.documentId,
      elementSetId,
      generationId: job.generationId,
      totalElements: elementSet.elementCount,
    };
    const manifest = await beginEmbeddingGeneration(
      this.database,
      this.config.embeddingSpace,
      generation,
    );
    let titleEmbedding: number[] | null = null;
    let position = manifest.nextElementPosition;
    while (position < elementSet.elementCount) {
      abortSignal.throwIfAborted();
      if (titleEmbedding === null) {
        const titleEmbeddings = await embedDocumentTexts(
          this.models,
          [buildDocumentTitleEmbeddingContent(job.sourceFile)],
          this.embeddingScheduler,
          abortSignal,
        );
        titleEmbedding = titleEmbeddings[0] ?? null;
        if (titleEmbedding === null) {
          throw new Error(`Missing document title embedding for ${job.sourceFile}.`);
        }
      }
      const batch = await this.readIndexingBatch(
        elementSetId,
        position,
        elementSet.elementCount,
        job.sourceFile,
      );
      if (batch.elements.length === 0) {
        throw new Error(`Missing source element at position ${position}.`);
      }
      await this.describeElementBatch(
        job,
        batch.elements,
        batch.contexts,
        position,
        elementSet.elementCount,
        abortSignal,
      );
      const descriptions = await this.readCompleteDescriptionBatch(
        job,
        batch.elements,
        batch.contexts,
        position,
      );
      const windows = createRetrievalWindows(batch.elements, {
        embeddingInputFormat: this.config.embeddingSpace.inputFormat,
        policy: this.config.embeddingSpace.retrievalWindow,
      });
      const baseRepresentations = createRetrievalRepresentations(
        batch.elements,
        descriptions,
        windows,
        this.config.embeddingSpace.retrievalWindow,
      );
      const representations = addContextToImageRetrievalRepresentations(
        baseRepresentations,
        batch.elements,
        batch.contexts,
      );
      const boundedRepresentations = splitRetrievalRepresentationsAtTokenLimit(
        representations,
        batch.elements,
        this.config.embeddingSpace.inputFormat,
        this.config.inference.embedding.maximumInputTokens,
      );
      const embeddingInputs = buildRetrievalEmbeddingInputs(
        boundedRepresentations,
        batch.elements,
        this.config.embeddingSpace.inputFormat,
      );
      const splitRejectedInput = createRejectedEmbeddingInputSplitter(
        batch.elements,
        this.config.embeddingSpace.inputFormat,
      );
      const embedded = await embedDocumentInputs(
        this.models,
        embeddingInputs,
        this.embeddingScheduler,
        abortSignal,
        splitRejectedInput,
      );
      const finalRepresentations = linkRetrievalRepresentationNeighbors(
        embedded.map((result) => result.source),
      );
      const embeddings = blendRetrievalEmbeddingsWithDocumentTitle(
        embedded.map((result) => result.embedding),
        titleEmbedding,
      );
      abortSignal.throwIfAborted();
      await stageRetrievalRepresentationBatch(
        this.database,
        this.config.embeddingSpace,
        generation,
        position,
        batch.nextPosition,
        finalRepresentations,
        embeddings,
      );
      position = batch.nextPosition;
    }
    await this.stageDocumentToc(job, elementSetId, abortSignal);
    if (job.state !== "running") {
      throw new Error(`Cannot complete indexing for ${job.sourceFile}.`);
    }
    await this.catalog.completeIndexing(job.sourceFile, job.ownerId);
  }

  private async stageDocumentToc(
    job: IngestionJob,
    elementSetId: string,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const identity: DocumentTocGenerationIdentity = {
      documentId: job.documentId,
      elementSetId,
      generationId: job.generationId,
      sourceFile: job.sourceFile,
    };
    const expectedMode = this.config.docling.tocEnabled
      ? "generated"
      : "disabled";
    const existing = await readStagedDocumentTocArtifact(
      this.database,
      identity,
    );
    if (existing?.mode === expectedMode) {
      this.reportProgress(
        `${basename(job.sourceFile)}: reusing the staged document TOC map`,
      );
      return;
    }
    let artifact = createDisabledDocumentTocArtifact();
    if (this.config.docling.tocEnabled) {
      const elements = await this.documentStore.readAllElements(
        elementSetId,
        job.sourceFile,
      );
      artifact = await generateDocumentTocArtifact(
        {
          documentId: job.documentId,
          elements,
          sourceFile: job.sourceFile,
          space: this.config.embeddingSpace,
        },
        this.models,
        this.descriptionScheduler,
        abortSignal,
        this.reportProgress,
      );
    }
    abortSignal.throwIfAborted();
    await stageDocumentTocArtifact(this.database, identity, artifact);
  }

  private async describeElementBatch(
    job: IngestionJob,
    elements: SourceElement[],
    contexts: RetrievalDescriptionContext[],
    startPosition: number,
    totalElements: number,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const checkpoints =
      await this.artifactStore.readRetrievalDescriptionCheckpoints(
      job.generationId,
      startPosition,
      elements.length,
    );
    const checkpointsByPosition = new Map(
      checkpoints.map((checkpoint) => [checkpoint.position, checkpoint]),
    );
    for (
      let worksetStart = 0;
      worksetStart < elements.length;
      worksetStart += RETRIEVAL_DESCRIPTION_WORKSET_SIZE
    ) {
      const pending: Array<Promise<void>> = [];
      const worksetEnd = Math.min(
        elements.length,
        worksetStart + RETRIEVAL_DESCRIPTION_WORKSET_SIZE,
      );
      for (let offset = worksetStart; offset < worksetEnd; offset += 1) {
        const element = elements[offset];
        if (element === undefined) {
          throw new Error(`Missing source element at batch offset ${offset}.`);
        }
        if (!isDescribableElement(element)) {
          continue;
        }
        const context = contexts[offset];
        if (context === undefined) {
          throw new Error(
            `Missing retrieval description context at batch offset ${offset}.`,
          );
        }
        const position = startPosition + offset;
        pending.push(this.describeElementAtPosition(
          job,
          element,
          context,
          position,
          totalElements,
          checkpointsByPosition.get(position),
          abortSignal,
        ));
      }
      const results = await Promise.allSettled(pending);
      const failure = results.find((result) => result.status === "rejected");
      if (failure !== undefined && failure.status === "rejected") {
        throw failure.reason;
      }
    }
  }

  private async describeElementAtPosition(
    job: IngestionJob,
    element: Exclude<SourceElement, { kind: "text" }>,
    context: RetrievalDescriptionContext,
    position: number,
    totalElements: number,
    checkpoint: {
      description: RetrievalDescriptionRecord;
      position: number;
    } | undefined,
    abortSignal: AbortSignal,
  ): Promise<void> {
    if (isCompatibleDescriptionCheckpoint(
      checkpoint,
      element,
      context,
      position,
    )) {
      this.reportProgress(
        `${basename(job.sourceFile)}: reusing ${element.kind} description ${position + 1}/${totalElements}`,
      );
      return;
    }
    const reusableCheckpoints =
      await this.artifactStore.readReusableRetrievalDescriptions(
        job.documentId,
        job.generationId,
        element.id,
      );
    const reusable = reusableCheckpoints.find((candidate) => (
      isCompatibleDescriptionCheckpoint(
        candidate,
        element,
        context,
        position,
      )
    ));
    if (reusable !== undefined) {
      await this.artifactStore.writeRetrievalDescription(
        job.generationId,
        job.documentId,
        position,
        reusable.description,
      );
      this.reportProgress(
        `${basename(job.sourceFile)}: reusing ${element.kind} description ${position + 1}/${totalElements}`,
      );
      return;
    }
    this.reportProgress(
      `${basename(job.sourceFile)}: describing ${element.kind} ${position + 1}/${totalElements}`,
    );
    const description = await describeRetrievalElement(
      this.models,
      element,
      context,
      this.descriptionScheduler,
      abortSignal,
    );
    abortSignal.throwIfAborted();
    await this.artifactStore.writeRetrievalDescription(
      job.generationId,
      job.documentId,
      position,
      description,
    );
  }

  private async readCompleteDescriptionBatch(
    job: IngestionJob,
    elements: SourceElement[],
    contexts: RetrievalDescriptionContext[],
    startPosition: number,
  ): Promise<RetrievalDescriptionRecord[]> {
    const checkpoints =
      await this.artifactStore.readRetrievalDescriptionCheckpoints(
      job.generationId,
      startPosition,
      elements.length,
    );
    const checkpointsByPosition = new Map(
      checkpoints.map((checkpoint) => [checkpoint.position, checkpoint]),
    );
    const descriptions: RetrievalDescriptionRecord[] = [];
    for (let offset = 0; offset < elements.length; offset += 1) {
      const element = elements[offset];
      if (element === undefined) {
        throw new Error(`Missing source element at batch offset ${offset}.`);
      }
      if (!isDescribableElement(element)) {
        continue;
      }
      const context = contexts[offset];
      if (context === undefined) {
        throw new Error(
          `Missing retrieval description context at batch offset ${offset}.`,
        );
      }
      const position = startPosition + offset;
      const checkpoint = checkpointsByPosition.get(position);
      if (checkpoint === undefined) {
        throw new Error(
          `Missing retrieval description checkpoint at position ${position}.`,
        );
      }
      if (!isCompatibleDescriptionCheckpoint(
        checkpoint,
        element,
        context,
        position,
      )) {
        throw new Error(
          `Retrieval description checkpoint differs at position ${position}.`,
        );
      }
      descriptions.push(checkpoint.description);
    }
    return descriptions;
  }

  private async readIndexingBatch(
    elementSetId: string,
    position: number,
    totalElements: number,
    sourceFile: string,
  ): Promise<{
    contexts: RetrievalDescriptionContext[];
    elements: SourceElement[];
    nextPosition: number;
  }> {
    const contextStart = Math.max(0, position - 1);
    const leadingContextCount = position - contextStart;
    const remaining = totalElements - position;
    const elementCount = Math.min(EMBEDDING_ELEMENT_BATCH_SIZE, remaining);
    const trailingContextCount =
      position + elementCount < totalElements ? 1 : 0;
    const contextBatch = await this.documentStore.readElementBatch(
      elementSetId,
      contextStart,
      leadingContextCount + elementCount + trailingContextCount,
      sourceFile,
    );
    const elements = contextBatch.elements.slice(
      leadingContextCount,
      leadingContextCount + elementCount,
    );
    if (elements.length !== elementCount) {
      throw new Error(
        `Indexing batch at ${position} contains ${elements.length} of ${elementCount} expected elements.`,
      );
    }
    const contexts: RetrievalDescriptionContext[] = [];
    for (let offset = 0; offset < elements.length; offset += 1) {
      contexts.push(createRetrievalDescriptionContext(
        contextBatch.elements,
        leadingContextCount + offset,
      ));
    }
    return {
      contexts,
      elements,
      nextPosition: position + elements.length,
    };
  }

  private async readAdvancedRunningJob(
    previous: IngestionJob & { state: "running" },
    expectedPhase: "normalized" | "indexed",
  ): Promise<IngestionJob & { state: "running" }> {
    const current = await this.catalog.getJob(previous.sourceFile);
    if (
      current === null
      || current.state !== "running"
      || current.ownerId !== previous.ownerId
      || current.phase !== expectedPhase
    ) {
      throw new Error(
        `Ingestion job ${previous.sourceFile} did not advance to ${expectedPhase} under its active lease.`,
      );
    }
    if (isRequestedControlState(current.controlState)) {
      throw new IngestionControlInterruption(current.controlState);
    }
    return current;
  }

  private async promote(job: IngestionJob): Promise<PromotionResult> {
    this.reportProgress(`${basename(job.sourceFile)}: publishing the index`);
    if (job.state !== "running") {
      throw new Error(`Cannot promote unclaimed ingestion ${job.sourceFile}.`);
    }
    return this.catalog.promoteJob(job.sourceFile, job.ownerId);
  }

  private async cleanDocumentData(documentId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await deleteDocumentRetrievalRows(transaction, documentId);
      await deleteTemporaryDocumentIngestionArtifacts(
        transaction,
        documentId,
      );
      await deletePermanentDocumentIngestionArtifacts(
        transaction,
        documentId,
      );
      await deleteStoredDocumentEvidence(transaction, documentId);
    });
    await this.sourceContentStore.reconcileDocumentDeletion(documentId);
  }

}

function readDoclingVlmApiToken(
  snapshot: DoclingAttemptConfigSnapshot,
  current: AppConfig["docling"],
): string | null {
  if (snapshot.vlm === null) {
    return null;
  }
  if (current.vlm?.providerId !== snapshot.vlm.providerId) {
    return null;
  }
  return current.vlm.apiToken;
}

function isCompatibleDescriptionCheckpoint(
  checkpoint: {
    description: RetrievalDescriptionRecord;
    position: number;
  } | undefined,
  element: Exclude<SourceElement, { kind: "text" }>,
  context: RetrievalDescriptionContext,
  position: number,
): checkpoint is {
  description: RetrievalDescriptionRecord;
  position: number;
} {
  if (checkpoint?.position !== position) {
    return false;
  }
  return doesRetrievalDescriptionMatchElement(
    checkpoint.description,
    element,
    context,
  );
}

function requireElementSetId(job: IngestionJob): string {
  if (job.elementSetId === null) {
    throw new Error(`Ingestion job has no element set: ${job.sourceFile}.`);
  }
  return job.elementSetId;
}

function assertElementSetMatchesJob(
  job: IngestionJob,
  elementSet: DocumentElementSet,
): void {
  if (
    elementSet.documentId !== job.documentId
    || elementSet.elementCount !== job.totalElements
  ) {
    throw new Error(
      `Element set ${elementSet.id} does not match ingestion job ${job.sourceFile}.`,
    );
  }
}

function hasDoclingServicesWaiting(
  demand: DoclingVerificationDemand,
  verification: DoclingVerificationResult,
): boolean {
  const failedServiceIds = new Set<string>();
  for (const failure of verification.failures) {
    failedServiceIds.add(failure.serviceId);
  }
  for (const serviceId of demand.assignedServiceIds) {
    if (failedServiceIds.has(serviceId)) {
      return true;
    }
  }
  return demand.hasUnassignedJobs
    && verification.availableServiceIds.length === 0;
}

function reportAssignedServiceState(
  assignment: DoclingServiceAssignment,
  sourceFile: string,
  reportProgress: (message: string) => void,
): void {
  if (assignment.state === "active") {
    return;
  }
  reportProgress(
    `${basename(sourceFile)}: resuming on ${assignment.state} Docling service ${assignment.id}`,
  );
}

function readDocumentStatistics(
  elements: SourceElement[],
  pageCount: number | null,
): DocumentStatistics {
  let images = 0;
  let tables = 0;
  let textChunks = 0;
  for (const element of elements) {
    if (element.kind === "image") {
      images += 1;
    } else if (element.kind === "table") {
      tables += 1;
    } else {
      textChunks += 1;
    }
  }
  return {
    images,
    pageCount,
    tables,
    textChunks,
    totalElements: elements.length,
  };
}

function readErrorMessage(error: unknown): string {
  return readInferenceErrorMessage(error);
}

function readErrorCategory(error: unknown): string {
  if (isDoclingTaskDeadlineFailure(error)) {
    return "DoclingTaskDeadlineError";
  }
  return readDoclingErrorCategory(error);
}

function readIngestionErrorOrigin(
  job: IngestionJob,
  error: unknown,
  doclingOrigin: ApplicationErrorOrigin,
): ApplicationErrorOrigin {
  const pending: unknown[] = [error];
  const visited = new Set<Error>();
  while (pending.length > 0 && visited.size < 16) {
    const current = pending.pop();
    if (!(current instanceof Error) || visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (current instanceof InferenceLeaseLostError) {
      return "scheduler";
    }
    if (/Inference|Embedding|Provider|Model/u.test(current.name)) {
      return "inference-provider";
    }
    if (current.cause !== undefined) {
      pending.push(current.cause);
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
  }
  if (job.phase === "discovered" && !isPlainTextFormat(job.format)) {
    return doclingOrigin;
  }
  return "ingestion";
}

function readDoclingConversionRunId(error: unknown): string | null {
  let current = error;
  const visited = new Set<Error>();
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(current instanceof Error) || visited.has(current)) {
      return null;
    }
    visited.add(current);
    if (current instanceof DoclingIngestionAttemptError) {
      return current.conversionRunId;
    }
    current = current.cause;
  }
  return null;
}

function mapDoclingErrorDetails(
  errors: ReturnType<typeof readDoclingFailureContext>["errors"],
): DoclingErrorDetailInput[] {
  const details: DoclingErrorDetailInput[] = [];
  for (const error of errors) {
    details.push({
      category: error.category,
      componentType: error.componentType,
      doclingLabel: error.doclingLabel,
      elementKind: error.elementKind,
      message: error.message,
      moduleName: error.moduleName,
      pageNumber: error.pageNumber,
      pageRangeEnd: error.pageRangeEnd,
      pageRangeStart: error.pageRangeStart,
      sourceRef: error.sourceRef,
    });
  }
  return details;
}

function readMetricsFailureOutcome(error: unknown): "error" | "timeout" {
  if (isDoclingTaskDeadlineFailure(error)) {
    return "timeout";
  }
  return "error";
}

async function completeDoclingMetricsSuccess(
  recorder: DoclingMetricsRecorder | null,
  input: CompleteDoclingMetricsRunInput,
  reportProgress: (message: string) => void,
): Promise<void> {
  if (recorder === null) {
    return;
  }
  try {
    await recorder.completeSuccess(input);
  } catch (error: unknown) {
    reportProgress(
      `Docling metrics completion warning: ${readErrorCategory(error)}`,
    );
  }
}

async function completeDoclingMetricsFailure(
  recorder: DoclingMetricsRecorder | null,
  outcome: "abort" | "error" | "timeout",
  errorCategory: string,
  totalWallMs: number,
  reportProgress: (message: string) => void,
): Promise<void> {
  if (recorder === null) {
    return;
  }
  try {
    await recorder.completeFailure(outcome, errorCategory, totalWallMs);
  } catch (error: unknown) {
    reportProgress(
      `Docling metrics failure-recording warning: ${readErrorCategory(error)}`,
    );
  }
}

function formatFailureProgress(
  sourceFile: string,
  message: string,
  retryAt: string | null,
): string {
  if (retryAt === null) {
    return `${basename(sourceFile)} failed permanently: ${message}`;
  }
  return `${basename(sourceFile)} failed and will retry at ${retryAt}: ${message}`;
}

interface IngestionLeaseHeartbeat {
  signal: AbortSignal;
  stop: () => Promise<void>;
}

async function startLeaseHeartbeat(
  catalog: DocumentCatalog,
  job: RunningIngestionJob,
  reportProgress: (message: string) => void,
  requestControl: (state: "pause_requested" | "cancel_requested") => void,
): Promise<IngestionLeaseHeartbeat> {
  const leaseController = new AbortController();
  let stopped = false;
  let renewal: Promise<void> | null = null;
  let renewalTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let confirmedDeadline = 0;
  let controlCheck: Promise<void> | null = null;

  const clearLeaseTimers = (): void => {
    if (renewalTimer !== null) {
      clearTimeout(renewalTimer);
      renewalTimer = null;
    }
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
  };
  const loseLease = (cause?: unknown): void => {
    if (leaseController.signal.aborted) {
      return;
    }
    clearLeaseTimers();
    leaseController.abort(new IngestionLeaseLostError(job.sourceFile, cause));
  };
  const scheduleRenewal = (delayMs: number): void => {
    if (stopped || leaseController.signal.aborted) {
      return;
    }
    renewalTimer = setTimeout(() => {
      renewalTimer = null;
      renewal = renew(false).finally(() => {
        renewal = null;
      });
    }, Math.max(1, Math.floor(delayMs)));
    renewalTimer.unref();
  };
  const scheduleConfirmedLease = (
    databaseNow: string,
    leaseExpiresAt: string,
  ): void => {
    if (stopped) {
      return;
    }
    const remainingMs =
      new Date(leaseExpiresAt).getTime() - new Date(databaseNow).getTime();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      loseLease();
      return;
    }
    confirmedDeadline = performance.now() + remainingMs;
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
    }
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null;
      loseLease();
    }, remainingMs);
    deadlineTimer.unref();
    scheduleRenewal(remainingMs / 3);
  };
  const renew = async (initial: boolean): Promise<void> => {
    try {
      const result = await catalog.renewJobLease(job.sourceFile, job.ownerId);
      if (result === null) {
        loseLease();
        return;
      }
      scheduleConfirmedLease(result.databaseNow, result.leaseExpiresAt);
      if (isRequestedControlState(result.controlState)) {
        requestControl(result.controlState);
      }
    } catch (error: unknown) {
      if (initial) {
        reportProgress(
          `Could not establish the ingestion lease for ${basename(job.sourceFile)}: ${readErrorMessage(error)}`,
        );
        loseLease(error);
        return;
      }
      reportProgress(
        `Warning: could not renew the ingestion lease for ${basename(job.sourceFile)}: ${readErrorMessage(error)}`,
      );
      const remainingMs = confirmedDeadline - performance.now();
      if (remainingMs <= 0) {
        loseLease(error);
        return;
      }
      scheduleRenewal(Math.min(1_000, remainingMs / 6));
    }
  };

  await renew(true);

  const controlTimer = setInterval(() => {
    if (
      stopped
      || leaseController.signal.aborted
      || controlCheck !== null
    ) {
      return;
    }
    controlCheck = catalog
      .getJob(job.sourceFile)
      .then((currentJob) => {
        if (
          currentJob === null
          || currentJob.state !== "running"
          || currentJob.ownerId !== job.ownerId
        ) {
          loseLease();
          return;
        }
        if (isRequestedControlState(currentJob.controlState)) {
          requestControl(currentJob.controlState);
        }
      })
      .catch((error: unknown) => {
        reportProgress(
          `Warning: could not check ingestion controls for ${basename(job.sourceFile)}: ${readErrorMessage(error)}`,
        );
      })
      .finally(() => {
        controlCheck = null;
      });
  }, CONTROL_POLL_INTERVAL_MS);
  controlTimer.unref();

  return {
    signal: leaseController.signal,
    stop: async (): Promise<void> => {
      stopped = true;
      clearLeaseTimers();
      clearInterval(controlTimer);
      if (renewal !== null) {
        await renewal;
      }
      if (controlCheck !== null) {
        await controlCheck;
      }
    },
  };
}

function isRequestedControlState(
  state: IngestionControlState,
): state is "pause_requested" | "cancel_requested" {
  return state === "pause_requested" || state === "cancel_requested";
}

function buildRetrievalEmbeddingInputs(
  representations: readonly RetrievalRepresentation[],
  elements: readonly SourceElement[],
  inputFormat: AppConfig["embeddingSpace"]["inputFormat"],
): Array<DocumentEmbeddingInput<RetrievalRepresentation>> {
  const elementsById = indexSourceElements(elements);
  const inputs: Array<DocumentEmbeddingInput<RetrievalRepresentation>> = [];
  for (const representation of representations) {
    const element = elementsById.get(representation.parentId);
    if (element === undefined) {
      throw new Error(
        `Missing parent element for retrieval representation ${representation.id}.`,
      );
    }
    inputs.push({
      inputTokens: countRetrievalEmbeddingInputTokens(
        representation.embeddingContent,
        element,
        inputFormat,
      ),
      source: representation,
      value: representation.embeddingText,
    });
  }
  return inputs;
}

function createRejectedEmbeddingInputSplitter(
  elements: readonly SourceElement[],
  inputFormat: AppConfig["embeddingSpace"]["inputFormat"],
): (
  input: DocumentEmbeddingInput<RetrievalRepresentation>,
  maximumInputTokens: number,
) => Array<DocumentEmbeddingInput<RetrievalRepresentation>> {
  const elementsById = indexSourceElements(elements);
  return (input, maximumInputTokens) => {
    const element = elementsById.get(input.source.parentId);
    if (element === undefined) {
      throw new Error(
        `Missing parent element for rejected retrieval representation ${input.source.id}.`,
      );
    }
    const split = splitRetrievalRepresentationAtTokenLimit(
      input.source,
      element,
      inputFormat,
      maximumInputTokens,
    );
    return buildRetrievalEmbeddingInputs(split, [element], inputFormat);
  };
}

function indexSourceElements(
  elements: readonly SourceElement[],
): Map<string, SourceElement> {
  const elementsById = new Map<string, SourceElement>();
  for (const element of elements) {
    if (elementsById.has(element.id)) {
      throw new Error(`Duplicate source element ${element.id}.`);
    }
    elementsById.set(element.id, element);
  }
  return elementsById;
}
