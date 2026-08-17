import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { isDeepStrictEqual } from "node:util";

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  ne,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type {
  CiteLoomDatabase,
  CiteLoomTransaction,
} from "../../database/client.js";
import {
  doclingConversionRequests,
  doclingConversionRuns,
  doclingProfilingStages,
  ingestionJobs,
} from "../../database/schema.js";
import {
  createNoOpDoclingRequestObserver,
  type DoclingConversionObserver,
  type DoclingRequestEvent,
  type DoclingRequestIdentity,
  type DoclingRequestMetadata,
  type DoclingRequestObserver,
} from "../client/observer.js";
import {
  decodeDoclingAttemptConfigSnapshot,
  decodeDoclingProcessConfiguration,
  fingerprintDoclingConfiguration,
  type DoclingAttemptConfigSnapshot,
  type DoclingProcessConfiguration,
  type DoclingServiceIdentity,
  type DoclingTerminalOutcome,
} from "../protocol/run-metadata.js";
import type { SourceElement } from "../../domain/source-elements.js";
import { contentIdSchema } from "../../domain/validation.js";
import { ApplicationErrorReporter } from "../../observability/application-errors.js";

const conversionRunRowSchema = z.object({
  completedAt: z.date().nullable(),
  configFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  documentId: contentIdSchema,
  id: z.uuid(),
  outcome: z.enum(["abort", "error", "success", "timeout"]).nullable(),
});
const requestAggregateRowSchema = z.object({
  providerProcessingMs: z.number().int().nonnegative().nullable(),
  resultRetrievalMs: z.number().int().nonnegative().nullable(),
  taskWaitMs: z.number().int().nonnegative().nullable(),
  uploadMs: z.number().int().nonnegative().nullable(),
});
const existingRequestRowSchema = z.object({
  id: z.uuid(),
  sequence: z.number().int().nonnegative(),
});

export interface StartDoclingMetricsRunInput {
  attemptConfig: DoclingAttemptConfigSnapshot;
  byteLength: number;
  documentId: string;
  fileExtension: string;
  ingestionAttempt: number;
  processConfig: DoclingProcessConfiguration;
  serviceIdentity: DoclingServiceIdentity;
  sourceFile: string;
  startedAt: Date;
}

export interface CompleteDoclingMetricsRunInput {
  elements: SourceElement[];
  pageCount: number | null;
  totalWallMs: number;
}

interface RepairCompletedPartitionRunInput {
  images: number;
  pageCount: number | null;
  runId: string;
  sourceFile: string;
  tables: number;
  textChunks: number;
  totalElements: number;
}

export class DoclingMetricsStore {
  public constructor(private readonly database: CiteLoomDatabase) {}

  public async startOrResumeRun(
    input: StartDoclingMetricsRunInput,
    reportFailure: (message: string) => void,
  ): Promise<DoclingMetricsRecorder | null> {
    const attemptConfig = decodeDoclingAttemptConfigSnapshot(input.attemptConfig);
    if (!attemptConfig.performanceMetricsEnabled) {
      return null;
    }
    const documentId = readDocumentId(input.documentId);
    const processConfig = decodeDoclingProcessConfiguration(input.processConfig);
    const configFingerprint = fingerprintDoclingConfiguration(
      attemptConfig,
      processConfig,
    );
    const runId = await this.database.transaction(async (transaction) => {
      const jobs = await transaction
        .select({
          attemptConfig: ingestionJobs.doclingAttemptConfig,
          runId: ingestionJobs.doclingRunId,
        })
        .from(ingestionJobs)
        .where(eq(ingestionJobs.sourceFile, input.sourceFile))
        .limit(1)
        .for("update");
      const job = jobs[0];
      if (job === undefined) {
        throw new Error("Cannot start Docling metrics for an unavailable job.");
      }
      const storedAttemptConfig = job.attemptConfig === null
        ? null
        : decodeDoclingAttemptConfigSnapshot(job.attemptConfig);
      if (
        storedAttemptConfig !== null
        && !isDeepStrictEqual(storedAttemptConfig, attemptConfig)
      ) {
        throw new Error(
          "Stored Docling attempt configuration does not match the metrics run.",
        );
      }
      if (job.runId !== null) {
        const existingRows = await transaction
          .select({
            completedAt: doclingConversionRuns.completedAt,
            configFingerprint: doclingConversionRuns.configFingerprint,
            documentId: doclingConversionRuns.documentId,
            id: doclingConversionRuns.id,
            outcome: doclingConversionRuns.outcome,
          })
          .from(doclingConversionRuns)
          .where(eq(doclingConversionRuns.id, job.runId))
          .limit(1);
        const existing = decodeConversionRun(existingRows[0]);
        if (existing.completedAt === null) {
          if (
            existing.documentId !== documentId
            || existing.configFingerprint !== configFingerprint
          ) {
            throw new Error(
              "Stored Docling metrics run does not match its active conversion.",
            );
          }
          return existing.id;
        }
        await transaction
          .update(ingestionJobs)
          .set({ doclingRunId: null })
          .where(eq(ingestionJobs.sourceFile, input.sourceFile));
      }
      const id = randomUUID();
      await transaction.insert(doclingConversionRuns).values({
        attemptConfig,
        byteLength: input.byteLength,
        configFingerprint,
        documentId,
        fileExtension: readFileExtension(input.fileExtension),
        id,
        ingestionAttempt: readPositiveInteger(
          input.ingestionAttempt,
          "ingestion attempt",
        ),
        processConfig,
        serviceIdentity: input.serviceIdentity,
        settingsVersion: attemptConfig.settingsVersion,
        startedAt: input.startedAt,
      });
      await transaction
        .update(ingestionJobs)
        .set({
          doclingAttemptConfig: attemptConfig,
          doclingRunId: id,
        })
        .where(eq(ingestionJobs.sourceFile, input.sourceFile));
      return id;
    });
    return new DoclingMetricsRecorder(
      this.database,
      runId,
      input.sourceFile,
      reportFailure,
    );
  }

  public async deleteExpiredRuns(
    retentionDays: number,
    batchSize: number = 500,
  ): Promise<number> {
    const normalizedRetentionDays = readPositiveInteger(
      retentionDays,
      "metrics retention days",
    );
    const normalizedBatchSize = readPositiveInteger(batchSize, "retention batch size");
    const cutoff = new Date(
      Date.now() - (normalizedRetentionDays * 24 * 60 * 60 * 1_000),
    );
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ id: doclingConversionRuns.id })
        .from(doclingConversionRuns)
        .where(lt(doclingConversionRuns.completedAt, cutoff))
        .orderBy(asc(doclingConversionRuns.completedAt))
        .limit(normalizedBatchSize)
        .for("update", { skipLocked: true });
      if (rows.length === 0) {
        return 0;
      }
      const ids = rows.map((row) => row.id);
      const deleted = await transaction
        .delete(doclingConversionRuns)
        .where(inArray(doclingConversionRuns.id, ids))
        .returning({ id: doclingConversionRuns.id });
      return deleted.length;
    });
  }

  public async repairCompletedPartitionRuns(
    batchSize: number = 100,
  ): Promise<number> {
    const normalizedBatchSize = readPositiveInteger(batchSize, "repair batch size");
    const jobs = await this.database
      .select({
        doclingRunId: ingestionJobs.doclingRunId,
        images: ingestionJobs.images,
        pageCount: ingestionJobs.pageCount,
        sourceFile: ingestionJobs.sourceFile,
        tables: ingestionJobs.tables,
        textChunks: ingestionJobs.textChunks,
        totalElements: ingestionJobs.totalElements,
      })
      .from(ingestionJobs)
      .where(and(
        isNotNull(ingestionJobs.doclingRunId),
        ne(ingestionJobs.phase, "discovered"),
      ))
      .limit(normalizedBatchSize);
    let repaired = 0;
    for (const job of jobs) {
      if (job.doclingRunId === null) {
        continue;
      }
      const changed = await this.repairCompletedPartitionRun({
        images: job.images,
        pageCount: job.pageCount,
        runId: job.doclingRunId,
        sourceFile: job.sourceFile,
        tables: job.tables,
        textChunks: job.textChunks,
        totalElements: job.totalElements,
      });
      if (changed) {
        repaired += 1;
      }
    }
    return repaired;
  }

  private async repairCompletedPartitionRun(
    input: RepairCompletedPartitionRunInput,
  ): Promise<boolean> {
    const repaired = await this.database.transaction(async (transaction) => {
      await lockIngestionJobForMetrics(transaction, input.sourceFile);
      const run = await readConversionRunForRepair(transaction, input.runId);
      if (run.completedAt === null) {
        await completeRepairedConversionRun(transaction, input);
      } else if (run.outcome !== "success") {
        throw new Error(
          `Completed partition is linked to a ${run.outcome} Docling metrics run.`,
        );
      }
      return detachRepairedConversionRun(transaction, input);
    });
    return repaired;
  }
}

async function lockIngestionJobForMetrics(
  transaction: CiteLoomTransaction,
  sourceFile: string,
): Promise<void> {
  await transaction
    .select({ sourceFile: ingestionJobs.sourceFile })
    .from(ingestionJobs)
    .where(eq(ingestionJobs.sourceFile, sourceFile))
    .limit(1)
    .for("update");
}

async function readConversionRunForRepair(
  database: CiteLoomDatabase,
  runId: string,
) {
  const runs = await database
    .select({
      completedAt: doclingConversionRuns.completedAt,
      configFingerprint: doclingConversionRuns.configFingerprint,
      documentId: doclingConversionRuns.documentId,
      id: doclingConversionRuns.id,
      outcome: doclingConversionRuns.outcome,
    })
    .from(doclingConversionRuns)
    .where(eq(doclingConversionRuns.id, runId))
    .limit(1)
    .for("update");
  return decodeConversionRun(runs[0]);
}

async function completeRepairedConversionRun(
  database: CiteLoomDatabase,
  input: RepairCompletedPartitionRunInput,
): Promise<void> {
  const requests = await database
    .select({
      providerProcessingMs: doclingConversionRequests.providerProcessingMs,
      resultRetrievalMs: doclingConversionRequests.resultRetrievalMs,
      taskWaitMs: doclingConversionRequests.taskWaitMs,
      uploadMs: doclingConversionRequests.uploadMs,
    })
    .from(doclingConversionRequests)
    .where(eq(doclingConversionRequests.runId, input.runId));
  const aggregate = aggregateRequestMetrics(requests);
  await database
    .update(doclingConversionRuns)
    .set({
      completedAt: new Date(),
      imageCount: input.images,
      outcome: "success",
      pageCount: input.pageCount,
      providerProcessingMs: aggregate.providerProcessingMs,
      resultRetrievalMs: aggregate.resultRetrievalMs,
      tableCount: input.tables,
      taskWaitMs: aggregate.taskWaitMs,
      textCount: input.textChunks,
      totalElementCount: input.totalElements,
      uploadMs: aggregate.uploadMs,
    })
    .where(eq(doclingConversionRuns.id, input.runId));
}

async function detachRepairedConversionRun(
  database: CiteLoomDatabase,
  input: RepairCompletedPartitionRunInput,
): Promise<boolean> {
  const detached = await database
    .update(ingestionJobs)
    .set({ doclingAttemptConfig: null, doclingRunId: null })
    .where(and(
      eq(ingestionJobs.sourceFile, input.sourceFile),
      eq(ingestionJobs.doclingRunId, input.runId),
      ne(ingestionJobs.phase, "discovered"),
    ))
    .returning({ sourceFile: ingestionJobs.sourceFile });
  return detached.length === 1;
}

async function readOpenRequestIdentity(
  database: CiteLoomDatabase,
  runId: string,
  requestKey: string,
): Promise<DoclingRequestIdentity | null> {
  const rows = await database
    .select({
      id: doclingConversionRequests.id,
      sequence: doclingConversionRequests.sequence,
    })
    .from(doclingConversionRequests)
    .where(and(
      eq(doclingConversionRequests.runId, runId),
      eq(doclingConversionRequests.requestKey, requestKey),
      isNull(doclingConversionRequests.outcome),
    ))
    .limit(1)
    .for("update");
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const request = decodeExistingRequest(row);
  return { id: request.id, sequence: request.sequence };
}

async function readNextRequestSequence(
  database: CiteLoomDatabase,
  runId: string,
): Promise<number> {
  const rows = await database
    .select({
      maximum: sql<number>`coalesce(max(${doclingConversionRequests.sequence}), -1)`,
    })
    .from(doclingConversionRequests)
    .where(eq(doclingConversionRequests.runId, runId));
  const maximum = Number(rows[0]?.maximum ?? -1);
  if (!Number.isInteger(maximum) || maximum < -1) {
    throw new Error("Invalid Docling request sequence state.");
  }
  return maximum + 1;
}

async function insertConversionRequest(
  database: CiteLoomDatabase,
  runId: string,
  sequence: number,
  metadata: DoclingRequestMetadata,
): Promise<DoclingRequestIdentity> {
  const id = randomUUID();
  await database.insert(doclingConversionRequests).values({
    id,
    kind: metadata.kind,
    requestConfig: metadata.options,
    requestKey: metadata.requestKey,
    runId,
    sequence,
    startedAt: new Date(),
  });
  return { id, sequence };
}

export class DoclingMetricsRecorder implements DoclingConversionObserver {
  private readonly errors: ApplicationErrorReporter;
  private schedulerStartedAtMs: number | null = null;

  public constructor(
    private readonly database: CiteLoomDatabase,
    public readonly runId: string,
    private readonly sourceFile: string,
    private readonly reportWarning: (message: string) => void,
  ) {
    this.errors = new ApplicationErrorReporter(database);
  }

  public async openRequest(
    metadata: DoclingRequestMetadata,
  ): Promise<DoclingRequestObserver> {
    try {
      const requestIdentity = await this.ensureRequest(metadata);
      return new PersistedDoclingRequestObserver(
        this.database,
        this.runId,
        requestIdentity,
        this.reportMetricsFailure.bind(this),
      );
    } catch (error: unknown) {
      await this.reportMetricsFailure(error, "open-docling-metrics-request");
      return createNoOpDoclingRequestObserver();
    }
  }

  public schedulerStarted(at: Date = new Date()): void {
    if (this.schedulerStartedAtMs !== null) {
      return;
    }
    this.schedulerStartedAtMs = at.getTime();
    void this.database
      .update(doclingConversionRuns)
      .set({ schedulerAdmittedAt: at })
      .where(eq(doclingConversionRuns.id, this.runId))
      .catch(async (error: unknown) => {
        await this.reportMetricsFailure(
          error,
          "record-docling-scheduler-admission",
        );
      });
  }

  public async completeSuccess(
    input: CompleteDoclingMetricsRunInput,
  ): Promise<void> {
    await this.complete("success", null, input);
  }

  public async completeFailure(
    outcome: Exclude<DoclingTerminalOutcome, "success">,
    errorCategory: string,
    totalWallMs: number,
  ): Promise<void> {
    await this.complete(outcome, readErrorCategory(errorCategory), {
      elements: [],
      pageCount: null,
      totalWallMs,
    });
  }

  private async ensureRequest(
    metadata: DoclingRequestMetadata,
  ): Promise<DoclingRequestIdentity> {
    const requestIdentity = await this.database.transaction(async (transaction) => {
      const existingRequestIdentity = await readOpenRequestIdentity(
        transaction,
        this.runId,
        metadata.requestKey,
      );
      if (existingRequestIdentity !== null) {
        return existingRequestIdentity;
      }
      const sequence = await readNextRequestSequence(transaction, this.runId);
      return insertConversionRequest(
        transaction,
        this.runId,
        sequence,
        metadata,
      );
    });
    return requestIdentity;
  }

  private async complete(
    outcome: DoclingTerminalOutcome,
    errorCategory: string | null,
    input: CompleteDoclingMetricsRunInput,
  ): Promise<void> {
    try {
      const requests = await this.database
        .select({
          providerProcessingMs: doclingConversionRequests.providerProcessingMs,
          resultRetrievalMs: doclingConversionRequests.resultRetrievalMs,
          taskWaitMs: doclingConversionRequests.taskWaitMs,
          uploadMs: doclingConversionRequests.uploadMs,
        })
        .from(doclingConversionRequests)
        .where(eq(doclingConversionRequests.runId, this.runId));
      const aggregate = aggregateRequestMetrics(requests);
      const counts = countElements(input.elements);
      const completedAt = new Date();
      const startedRows = await this.database
        .select({ startedAt: doclingConversionRuns.startedAt })
        .from(doclingConversionRuns)
        .where(eq(doclingConversionRuns.id, this.runId))
        .limit(1);
      const startedAt = startedRows[0]?.startedAt;
      const schedulerWaitMs = this.schedulerStartedAtMs === null || startedAt === undefined
        ? null
        : Math.max(0, this.schedulerStartedAtMs - startedAt.getTime());
      await this.database.transaction(async (transaction) => {
        await lockIngestionJobForMetrics(transaction, this.sourceFile);
        const existingRows = await transaction
          .select({
            completedAt: doclingConversionRuns.completedAt,
            configFingerprint: doclingConversionRuns.configFingerprint,
            documentId: doclingConversionRuns.documentId,
            id: doclingConversionRuns.id,
            outcome: doclingConversionRuns.outcome,
          })
          .from(doclingConversionRuns)
          .where(eq(doclingConversionRuns.id, this.runId))
          .limit(1)
          .for("update");
        const existing = decodeConversionRun(existingRows[0]);
        if (existing.completedAt !== null) {
          if (existing.outcome !== outcome) {
            throw new Error(
              `Docling metrics run ${this.runId} already completed with ${existing.outcome}.`,
            );
          }
          return;
        }
        await transaction
          .update(doclingConversionRuns)
          .set({
            completedAt,
            errorCategory,
            imageCount: outcome === "success" ? counts.images : null,
            outcome,
            pageCount: outcome === "success" ? input.pageCount : null,
            providerProcessingMs: aggregate.providerProcessingMs,
            resultRetrievalMs: aggregate.resultRetrievalMs,
            schedulerWaitMs,
            tableCount: outcome === "success" ? counts.tables : null,
            taskWaitMs: aggregate.taskWaitMs,
            textCount: outcome === "success" ? counts.text : null,
            totalElementCount: outcome === "success" ? input.elements.length : null,
            totalWallMs: Math.max(0, Math.round(input.totalWallMs)),
            uploadMs: aggregate.uploadMs,
          })
          .where(eq(doclingConversionRuns.id, this.runId));
        if (outcome === "success") {
          await transaction
            .update(ingestionJobs)
            .set({ doclingAttemptConfig: null, doclingRunId: null })
            .where(and(
              eq(ingestionJobs.sourceFile, this.sourceFile),
              eq(ingestionJobs.doclingRunId, this.runId),
            ));
        } else {
          await transaction
            .update(ingestionJobs)
            .set({ doclingRunId: null })
            .where(and(
              eq(ingestionJobs.sourceFile, this.sourceFile),
              eq(ingestionJobs.doclingRunId, this.runId),
            ));
        }
      });
    } catch (error: unknown) {
      await this.reportMetricsFailure(error, "complete-docling-metrics-run");
    }
  }

  private async reportMetricsFailure(
    error: unknown,
    operation: string,
  ): Promise<void> {
    this.reportWarning(formatMetricsFailure(this.runId, error));
    await this.errors.report(error, {
      category: "database-operation",
      code: "docling_metrics_persistence_failed",
      instance: hostname(),
      operation,
      origin: "database-operation",
      retryable: true,
      runId: this.runId,
      service: "worker",
      severity: "warning",
      sourceFile: this.sourceFile,
    });
  }
}

class PersistedDoclingRequestObserver implements DoclingRequestObserver {
  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly runId: string,
    public readonly identity: DoclingRequestIdentity,
    private readonly reportFailure: (
      error: unknown,
      operation: string,
    ) => Promise<void>,
  ) {}

  public async observe(event: DoclingRequestEvent): Promise<void> {
    try {
      if (event.kind === "submitted") {
        await this.database.transaction(async (transaction) => {
          await transaction
            .update(doclingConversionRuns)
            .set({ firstSubmittedAt: new Date(event.task.submittedAt) })
            .where(and(
              eq(doclingConversionRuns.id, this.runId),
              isNull(doclingConversionRuns.firstSubmittedAt),
            ));
          await transaction
            .update(doclingConversionRequests)
            .set({
              submittedAt: new Date(event.task.submittedAt),
              taskId: event.task.id,
              uploadMs: event.uploadMs,
            })
            .where(eq(doclingConversionRequests.id, this.identity.id));
        });
        return;
      }
      if (event.kind === "resumed") {
        await this.database
          .update(doclingConversionRequests)
          .set({
            resumed: true,
            submittedAt: new Date(event.task.submittedAt),
            taskId: event.task.id,
          })
          .where(eq(doclingConversionRequests.id, this.identity.id));
        return;
      }
      if (event.kind === "first-started") {
        await this.database.transaction(async (transaction) => {
          await transaction
            .update(doclingConversionRuns)
            .set({ firstObservedStartedAt: event.at })
            .where(and(
              eq(doclingConversionRuns.id, this.runId),
              isNull(doclingConversionRuns.firstObservedStartedAt),
            ));
          await transaction
            .update(doclingConversionRequests)
            .set({ firstObservedStartedAt: event.at })
            .where(and(
              eq(doclingConversionRequests.id, this.identity.id),
              isNull(doclingConversionRequests.firstObservedStartedAt),
            ));
        });
        return;
      }
      if (event.kind === "reconnected") {
        await this.database
          .update(doclingConversionRequests)
          .set({
            retryCount: sql`${doclingConversionRequests.retryCount} + 1`,
          })
          .where(eq(doclingConversionRequests.id, this.identity.id));
        return;
      }
      if (event.kind === "transport-succeeded") {
        await this.database
          .update(doclingConversionRequests)
          .set({
            completedAt: event.at,
            outcome: "success",
            resultRetrievalMs: event.resultRetrievalMs,
            taskWaitMs: event.taskWaitMs,
            totalMs: event.totalMs,
          })
          .where(eq(doclingConversionRequests.id, this.identity.id));
        return;
      }
      if (event.kind === "transport-failed") {
        await this.database
          .update(doclingConversionRequests)
          .set({
            completedAt: event.at,
            errorCategory: event.outcome,
            outcome: event.outcome,
            totalMs: event.totalMs,
          })
          .where(eq(doclingConversionRequests.id, this.identity.id));
        return;
      }
      await this.database.transaction(async (transaction) => {
        await transaction
          .update(doclingConversionRequests)
          .set({ providerProcessingMs: event.processingMs })
          .where(eq(doclingConversionRequests.id, this.identity.id));
        await transaction
          .delete(doclingProfilingStages)
          .where(eq(doclingProfilingStages.requestId, this.identity.id));
        if (event.profiling.length === 0) {
          return;
        }
        const rows: Array<typeof doclingProfilingStages.$inferInsert> = [];
        for (const stage of event.profiling) {
          rows.push({
            count: stage.count,
            id: randomUUID(),
            maximumDurationMs: stage.maximumDurationMs,
            medianDurationMs: stage.medianDurationMs,
            minimumDurationMs: stage.minimumDurationMs,
            p95DurationMs: stage.p95DurationMs,
            requestId: this.identity.id,
            scope: stage.scope,
            stage: stage.stage,
            totalDurationMs: stage.totalDurationMs,
          });
        }
        await transaction.insert(doclingProfilingStages).values(rows);
      });
    } catch (error: unknown) {
      await this.reportFailure(error, "record-docling-request-metrics");
    }
  }
}

function decodeConversionRun(value: unknown) {
  const result = conversionRunRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid Docling conversion run row: ${result.error.message}`);
  }
  return result.data;
}

function decodeExistingRequest(value: unknown) {
  const result = existingRequestRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid Docling request row: ${result.error.message}`);
  }
  return result.data;
}

function aggregateRequestMetrics(values: unknown[]) {
  let providerProcessingMs = 0;
  let resultRetrievalMs = 0;
  let taskWaitMs = 0;
  let uploadMs = 0;
  for (const value of values) {
    const result = requestAggregateRowSchema.safeParse(value);
    if (!result.success) {
      throw new Error(`Invalid Docling request metrics row: ${result.error.message}`);
    }
    providerProcessingMs += result.data.providerProcessingMs ?? 0;
    resultRetrievalMs += result.data.resultRetrievalMs ?? 0;
    taskWaitMs += result.data.taskWaitMs ?? 0;
    uploadMs += result.data.uploadMs ?? 0;
  }
  return {
    providerProcessingMs,
    resultRetrievalMs,
    taskWaitMs,
    uploadMs,
  };
}

function countElements(elements: SourceElement[]) {
  let images = 0;
  let tables = 0;
  let text = 0;
  for (const element of elements) {
    if (element.kind === "image") {
      images += 1;
    } else if (element.kind === "table") {
      tables += 1;
    } else {
      text += 1;
    }
  }
  return { images, tables, text };
}

function readDocumentId(value: string): string {
  const result = contentIdSchema.safeParse(value);
  if (!result.success) {
    throw new Error("Invalid Docling metrics document id.");
  }
  return result.data;
}

function readFileExtension(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^\.[a-z0-9]{1,7}$/.test(normalized)) {
    throw new Error("Invalid Docling metrics file extension.");
  }
  return normalized;
}

function readPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}.`);
  }
  return value;
}

function readErrorCategory(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  if (normalized.length === 0) {
    return "unknown";
  }
  return normalized.slice(0, 64);
}

function formatMetricsFailure(runId: string, error: unknown): string {
  const category = error instanceof Error ? error.name : "UnknownError";
  return `Docling metrics warning for run ${runId}: ${category}`;
}
