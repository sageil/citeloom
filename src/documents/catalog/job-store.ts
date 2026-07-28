import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import {
  decodeIngestionJob,
  decodePendingIngestionJob,
} from "./records.js";
import { ingestionControlStateSchema } from "./model.js";
import type {
  Clock,
  DoclingTaskReference,
  DocumentStatistics,
  IngestionControlDoclingTask,
  IngestionJob,
  IngestionControlState,
  IngestionPhase,
  JobFailureResult,
  PendingIngestionJob,
  RunningIngestionJob,
  RetryFailedJobResult,
  RequestIngestionControlResult,
  ResumeIngestionResult,
} from "./model.js";
import {
  decodeDoclingAttemptConfigSnapshot,
  type DoclingAttemptConfigSnapshot,
} from "../../docling/protocol/run-metadata.js";
import type { CiteLoomDatabase } from "../../database/client.js";
import {
  doclingConversionRuns,
  doclingTaskCheckpoints,
  ingestionJobs,
} from "../../database/schema.js";
import {
  persistApplicationErrorEvent,
  type PreparedApplicationErrorEvent,
  withApplicationErrorAttempt,
} from "../../observability/application-errors.js";

const MAX_RETRY_DELAY_MS = 3_600_000;
const doclingTaskCheckpointRowSchema = z.object({
  deadlineAt: z.date(),
  serviceInstanceId: z.string().trim().min(1).max(100),
  submittedAt: z.date(),
  taskId: z.string().trim().min(1),
});
const ingestionLeaseRenewalRowSchema = z.object({
  controlState: ingestionControlStateSchema,
  databaseNow: z.coerce.date(),
  leaseExpiresAt: z.coerce.date(),
});
const ingestionControlDoclingTaskRowSchema = z.object({
  controlState: z.enum(["pause_requested", "cancel_requested"]),
  serviceInstanceId: z.string().trim().min(1).max(100),
  sourceFile: z.string().min(1),
  taskId: z.string().uuid(),
});

export interface DoclingJobDemand {
  assignedServiceIds: string[];
  hasUnassignedJobs: boolean;
}

export class CatalogJobStore {
  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly clock: Clock,
    private readonly leaseDurationMs: number,
    private readonly newLeaseOwnerId: () => string = randomUUID,
  ) {}

  public async getJob(sourceFile: string): Promise<IngestionJob | null> {
    const rows = await this.database
      .select()
      .from(ingestionJobs)
      .where(eq(ingestionJobs.sourceFile, sourceFile))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : decodeIngestionJob(row);
  }

  public async claimJob(
    sourceFile: string,
    phase: IngestionPhase,
  ): Promise<RunningIngestionJob | null> {
    return this.claimSpecificJob(sourceFile, phase);
  }

  public async claimDoclingJob(
    sourceFile: string,
    eligibleServiceIds: readonly string[],
    allowUnassignedJobs: boolean,
  ): Promise<RunningIngestionJob | null> {
    const serviceCondition = buildDoclingServiceCondition(
      eligibleServiceIds,
      allowUnassignedJobs,
    );
    if (serviceCondition === null) {
      return null;
    }
    const activeServiceCondition = and(
      eq(ingestionJobs.controlState, "active"),
      serviceCondition,
    );
    if (activeServiceCondition === undefined) {
      throw new Error("Could not build the active Docling service condition.");
    }
    return this.claimSpecificJob(
      sourceFile,
      "discovered",
      activeServiceCondition,
    );
  }

  private async claimSpecificJob(
    sourceFile: string,
    phase: IngestionPhase,
    additionalCondition?: SQL,
  ): Promise<RunningIngestionJob | null> {
    const currentTime = this.clock.now();
    const ownerId = this.newLeaseOwnerId();
    const rows = await this.database
      .update(ingestionJobs)
      .set({
        errorMessage: null,
        leaseExpiresAt: this.readLeaseExpiration(),
        ownerId,
        state: "running",
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(ingestionJobs.sourceFile, sourceFile),
          eq(ingestionJobs.phase, phase),
          eq(ingestionJobs.state, "pending"),
          lte(ingestionJobs.nextAttemptAt, currentTime),
          additionalCondition,
        ),
      )
      .returning();
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return requireRunningIngestionJob(row);
  }

  public async claimNextJob(
    embeddingSpaceId: string,
    newDoclingAssignmentsAvailable: boolean = true,
  ): Promise<IngestionJob | null> {
    const currentTime = this.clock.now();
    const dueJobCondition = buildDueJobCondition(currentTime);
    let doclingAvailabilityCondition: SQL | undefined;
    if (!newDoclingAssignmentsAvailable) {
      doclingAvailabilityCondition = or(
        ne(ingestionJobs.phase, "discovered"),
        isNotNull(ingestionJobs.doclingServiceInstanceId),
        eq(ingestionJobs.mediaType, "text/plain"),
      );
    }
    const availableJobCondition = and(
      eq(ingestionJobs.embeddingSpaceId, embeddingSpaceId),
      dueJobCondition,
      eq(ingestionJobs.controlState, "active"),
      doclingAvailabilityCondition,
    );
    if (availableJobCondition === undefined) {
      throw new Error("Could not build the available ingestion job condition.");
    }
    return this.claimNextMatchingJob(availableJobCondition, currentTime);
  }

  public async claimNextNonDoclingJob(
    embeddingSpaceId: string,
  ): Promise<IngestionJob | null> {
    const currentTime = this.clock.now();
    const condition = and(
      eq(ingestionJobs.embeddingSpaceId, embeddingSpaceId),
      buildDueJobCondition(currentTime),
      eq(ingestionJobs.controlState, "active"),
      or(
        ne(ingestionJobs.phase, "discovered"),
        eq(ingestionJobs.mediaType, "text/plain"),
      ),
    );
    if (condition === undefined) {
      throw new Error("Could not build the non-Docling ingestion condition.");
    }
    return this.claimNextMatchingJob(condition, currentTime);
  }

  public async readDueDoclingDemand(
    embeddingSpaceId: string,
  ): Promise<DoclingJobDemand> {
    const currentTime = this.clock.now();
    const rows = await this.database
      .selectDistinct({
        serviceId: effectiveDoclingServiceIdSql(),
      })
      .from(ingestionJobs)
      .leftJoin(
        doclingTaskCheckpoints,
        eq(
          ingestionJobs.sourceFile,
          doclingTaskCheckpoints.sourceFile,
        ),
      )
      .where(and(
        eq(ingestionJobs.embeddingSpaceId, embeddingSpaceId),
        buildDueJobCondition(currentTime),
        eq(ingestionJobs.controlState, "active"),
        eq(ingestionJobs.phase, "discovered"),
        ne(ingestionJobs.mediaType, "text/plain"),
      ));
    let hasUnassignedJobs = false;
    const assigned = new Set<string>();
    for (const row of rows) {
      if (row.serviceId === null) {
        hasUnassignedJobs = true;
        continue;
      }
      assigned.add(row.serviceId);
    }
    const assignedServiceIds = [...assigned];
    assignedServiceIds.sort((left, right) => left.localeCompare(right));
    return { assignedServiceIds, hasUnassignedJobs };
  }

  public async readDoclingDemandForJob(
    sourceFile: string,
  ): Promise<DoclingJobDemand | null> {
    const currentTime = this.clock.now();
    const rows = await this.database
      .select({
        serviceId: effectiveDoclingServiceIdSql(),
      })
      .from(ingestionJobs)
      .leftJoin(
        doclingTaskCheckpoints,
        eq(
          ingestionJobs.sourceFile,
          doclingTaskCheckpoints.sourceFile,
        ),
      )
      .where(and(
        eq(ingestionJobs.sourceFile, sourceFile),
        buildDueJobCondition(currentTime),
        eq(ingestionJobs.controlState, "active"),
        eq(ingestionJobs.phase, "discovered"),
        ne(ingestionJobs.mediaType, "text/plain"),
      ))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    if (row.serviceId === null) {
      return { assignedServiceIds: [], hasUnassignedJobs: true };
    }
    return {
      assignedServiceIds: [row.serviceId],
      hasUnassignedJobs: false,
    };
  }

  public async claimNextDoclingJob(
    embeddingSpaceId: string,
    eligibleServiceIds: readonly string[],
    allowUnassignedJobs: boolean,
  ): Promise<IngestionJob | null> {
    const serviceCondition = buildDoclingServiceCondition(
      eligibleServiceIds,
      allowUnassignedJobs,
    );
    if (serviceCondition === null) {
      return null;
    }
    const currentTime = this.clock.now();
    const condition = and(
      eq(ingestionJobs.embeddingSpaceId, embeddingSpaceId),
      buildDueJobCondition(currentTime),
      eq(ingestionJobs.controlState, "active"),
      eq(ingestionJobs.phase, "discovered"),
      ne(ingestionJobs.mediaType, "text/plain"),
      serviceCondition,
    );
    if (condition === undefined) {
      throw new Error("Could not build the Docling ingestion condition.");
    }
    return this.claimNextMatchingJob(condition, currentTime);
  }

  private async claimNextMatchingJob(
    availableJobCondition: SQL,
    currentTime: Date,
  ): Promise<IngestionJob | null> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(ingestionJobs)
        .where(availableJobCondition)
        .orderBy(
          desc(ingestionJobs.phase),
          asc(ingestionJobs.nextAttemptAt),
          asc(ingestionJobs.updatedAt),
        )
        .limit(1)
        .for("update", { skipLocked: true });
      const row = rows[0];
      if (row === undefined) {
        return null;
      }

      const ownerId = this.newLeaseOwnerId();
      const claimedRows = await transaction
        .update(ingestionJobs)
        .set({
          errorMessage: null,
          controlState: "active",
          leaseExpiresAt: this.readLeaseExpiration(),
          ownerId,
          state: "running",
          updatedAt: currentTime,
        })
        .where(eq(ingestionJobs.sourceFile, row.sourceFile))
        .returning();
      const claimedRow = claimedRows[0];
      if (claimedRow === undefined) {
        throw new Error(`Could not claim ingestion job: ${row.sourceFile}`);
      }
      return requireRunningIngestionJob(claimedRow);
    });
  }

  public async renewJobLease(
    sourceFile: string,
    ownerId: string,
  ): Promise<{
    controlState: IngestionControlState;
    databaseNow: string;
    leaseExpiresAt: string;
  } | null> {
    const rows = await this.database
      .update(ingestionJobs)
      .set({
        leaseExpiresAt: this.readLeaseExpiration(),
      })
      .where(buildOwnedRunningJobCondition(ownerId, sourceFile))
      .returning({
        controlState: ingestionJobs.controlState,
        databaseNow: databaseClock(),
        leaseExpiresAt: ingestionJobs.leaseExpiresAt,
      });
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const renewal = ingestionLeaseRenewalRowSchema.parse(row);
    return {
      controlState: renewal.controlState,
      databaseNow: renewal.databaseNow.toISOString(),
      leaseExpiresAt: renewal.leaseExpiresAt.toISOString(),
    };
  }

  public async ensureDoclingAttemptConfig(
    sourceFile: string,
    ownerId: string,
    proposed: DoclingAttemptConfigSnapshot,
  ): Promise<DoclingAttemptConfigSnapshot> {
    const normalized = decodeDoclingAttemptConfigSnapshot(proposed);
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ config: ingestionJobs.doclingAttemptConfig })
        .from(ingestionJobs)
        .where(buildOwnedRunningJobCondition(ownerId, sourceFile))
        .limit(1)
        .for("update");
      const row = rows[0];
      if (row === undefined) {
        throw new Error(`Cannot snapshot Docling settings for ${sourceFile}.`);
      }
      if (row.config !== null) {
        return decodeDoclingAttemptConfigSnapshot(row.config);
      }
      const updated = await transaction
        .update(ingestionJobs)
        .set({ doclingAttemptConfig: normalized })
        .where(buildOwnedRunningJobCondition(ownerId, sourceFile))
        .returning({ sourceFile: ingestionJobs.sourceFile });
      if (updated.length !== 1) {
        throw new Error(`Cannot persist Docling settings for ${sourceFile}.`);
      }
      return normalized;
    });
  }

  public async readDoclingTaskCheckpoint(
    sourceFile: string,
    ownerId: string,
    requestKey: string,
    serviceInstanceId: string,
  ): Promise<DoclingTaskReference | null> {
    const normalizedRequestKey = readDoclingRequestKey(requestKey);
    const normalizedServiceId = readDoclingServiceId(serviceInstanceId);
    const rows = await this.database
      .select({
        deadlineAt: doclingTaskCheckpoints.deadlineAt,
        serviceInstanceId: doclingTaskCheckpoints.serviceInstanceId,
        submittedAt: doclingTaskCheckpoints.submittedAt,
        taskId: doclingTaskCheckpoints.taskId,
      })
      .from(doclingTaskCheckpoints)
      .innerJoin(
        ingestionJobs,
        eq(ingestionJobs.sourceFile, doclingTaskCheckpoints.sourceFile),
      )
      .where(and(
        eq(doclingTaskCheckpoints.sourceFile, sourceFile),
        eq(doclingTaskCheckpoints.requestKey, normalizedRequestKey),
        buildOwnedRunningJobCondition(ownerId, sourceFile),
      ))
      .limit(1);
    const row = rows[0];
    if (row !== undefined) {
      return decodeDoclingTaskCheckpoint(
        row,
        sourceFile,
        normalizedRequestKey,
        normalizedServiceId,
      );
    }
    return null;
  }

  public async recordDoclingTaskCheckpoint(
    sourceFile: string,
    ownerId: string,
    requestKey: string,
    task: DoclingTaskReference,
    serviceInstanceId: string,
  ): Promise<boolean> {
    const normalizedRequestKey = readDoclingRequestKey(requestKey);
    const normalizedServiceId = readDoclingServiceId(serviceInstanceId);
    const normalizedTask = decodeDoclingTaskCheckpoint({
      deadlineAt: new Date(task.deadlineAt),
      serviceInstanceId: normalizedServiceId,
      submittedAt: new Date(task.submittedAt),
      taskId: task.id,
    }, sourceFile, normalizedRequestKey, normalizedServiceId);
    const recorded = await this.database.transaction(async (transaction) => {
      const assignedServiceId = await readRecordableCheckpointServiceId(
        transaction,
        ownerId,
        sourceFile,
      );
      if (assignedServiceId !== normalizedServiceId) {
        return false;
      }
      await insertDoclingTaskCheckpoint(
        transaction,
        sourceFile,
        normalizedRequestKey,
        normalizedServiceId,
        normalizedTask,
      );
      const stored = await readStoredDoclingTaskCheckpoint(
        transaction,
        sourceFile,
        normalizedRequestKey,
        normalizedServiceId,
      );
      if (stored === null) {
        return false;
      }
      return doclingTaskReferencesEqual(stored, normalizedTask);
    });
    return recorded;
  }

  public async clearDoclingTaskCheckpoint(
    sourceFile: string,
    ownerId: string,
    requestKey: string,
    taskId: string,
    serviceInstanceId: string,
  ): Promise<boolean> {
    const normalizedRequestKey = readDoclingRequestKey(requestKey);
    const normalizedServiceId = readDoclingServiceId(serviceInstanceId);
    const cleared = await this.database.transaction(async (transaction) => {
      const job = await readClearableCheckpointJob(
        transaction,
        ownerId,
        sourceFile,
      );
      const checkpoints = await transaction
        .select({
          serviceInstanceId: doclingTaskCheckpoints.serviceInstanceId,
          taskId: doclingTaskCheckpoints.taskId,
        })
        .from(doclingTaskCheckpoints)
        .where(and(
          eq(doclingTaskCheckpoints.sourceFile, sourceFile),
          eq(doclingTaskCheckpoints.requestKey, normalizedRequestKey),
        ))
        .limit(1)
        .for("update");
      const checkpoint = checkpoints[0];
      if (checkpoint === undefined) {
        return true;
      }
      if (
        checkpoint.serviceInstanceId !== normalizedServiceId
        || checkpoint.taskId !== taskId
      ) {
        return false;
      }
      if (job === undefined) {
        return false;
      }
      if (job.serviceInstanceId !== normalizedServiceId) {
        throw new Error(
          `Docling checkpoint service does not match the assignment for ${sourceFile}.`,
        );
      }
      return deleteDoclingTaskCheckpoint(
        transaction,
        sourceFile,
        normalizedRequestKey,
        normalizedServiceId,
        taskId,
      );
    });
    return cleared;
  }

  public async readRequestedControlDoclingTasks(
    sourceFile?: string,
  ): Promise<IngestionControlDoclingTask[]> {
    const controlCondition = inArray(
      ingestionJobs.controlState,
      ["pause_requested", "cancel_requested"],
    );
    const condition = sourceFile === undefined
      ? controlCondition
      : and(
        controlCondition,
        eq(ingestionJobs.sourceFile, sourceFile),
      );
    const rows = await this.database
      .select({
        controlState: ingestionJobs.controlState,
        serviceInstanceId: doclingTaskCheckpoints.serviceInstanceId,
        sourceFile: ingestionJobs.sourceFile,
        taskId: doclingTaskCheckpoints.taskId,
      })
      .from(ingestionJobs)
      .innerJoin(
        doclingTaskCheckpoints,
        eq(ingestionJobs.sourceFile, doclingTaskCheckpoints.sourceFile),
      )
      .where(condition);
    return rows.map(decodeIngestionControlDoclingTask);
  }

  public async acknowledgeDoclingTaskControl(
    sourceFile: string,
    serviceInstanceId: string,
    taskId: string,
    outcome: "paused" | "terminated",
  ): Promise<boolean> {
    const normalizedServiceId = readDoclingServiceId(serviceInstanceId);
    const normalizedTaskId = readDoclingTaskId(taskId);
    const currentTime = this.clock.now();
    return this.database.transaction(async (transaction) => {
      const jobs = await transaction
        .select({
          controlState: ingestionJobs.controlState,
        })
        .from(ingestionJobs)
        .where(eq(ingestionJobs.sourceFile, sourceFile))
        .limit(1)
        .for("update");
      const job = jobs[0];
      if (
        job === undefined
        || (
          job.controlState !== "pause_requested"
          && job.controlState !== "cancel_requested"
        )
      ) {
        return false;
      }
      if (
        job.controlState === "cancel_requested"
        && outcome !== "terminated"
      ) {
        return false;
      }
      const retainCheckpoint = (
        job.controlState === "pause_requested"
        && outcome === "paused"
      );

      const checkpoints = await transaction
        .select({
          serviceInstanceId: doclingTaskCheckpoints.serviceInstanceId,
          taskId: doclingTaskCheckpoints.taskId,
        })
        .from(doclingTaskCheckpoints)
        .where(eq(doclingTaskCheckpoints.sourceFile, sourceFile))
        .for("update");
      const checkpoint = checkpoints.find((candidate) => {
        return candidate.serviceInstanceId === normalizedServiceId
          && candidate.taskId === normalizedTaskId;
      });
      if (checkpoint === undefined && checkpoints.length > 0) {
        return false;
      }
      if (retainCheckpoint && checkpoint === undefined) {
        return false;
      }
      if (!retainCheckpoint && checkpoint !== undefined) {
        await transaction
          .delete(doclingTaskCheckpoints)
          .where(and(
            eq(doclingTaskCheckpoints.sourceFile, sourceFile),
            eq(doclingTaskCheckpoints.serviceInstanceId, normalizedServiceId),
            eq(doclingTaskCheckpoints.taskId, normalizedTaskId),
          ));
      }
      if (retainCheckpoint) {
        const paused = await transaction
          .update(ingestionJobs)
          .set({
            controlError: null,
            controlState: "paused",
            doclingServiceInstanceId: null,
            doclingServiceSlot: null,
            leaseExpiresAt: null,
            ownerId: null,
            state: "pending",
            updatedAt: currentTime,
          })
          .where(and(
            eq(ingestionJobs.sourceFile, sourceFile),
            eq(ingestionJobs.controlState, "pause_requested"),
          ))
          .returning({ sourceFile: ingestionJobs.sourceFile });
        return paused.length === 1;
      }

      const settled = await transaction
        .update(ingestionJobs)
        .set({
          controlError: null,
          controlState: (
            job.controlState === "pause_requested"
              ? "paused"
              : "cancel_requested"
          ),
          doclingServiceInstanceId: null,
          doclingServiceSlot: null,
          leaseExpiresAt: null,
          ownerId: null,
          state: "pending",
          updatedAt: currentTime,
        })
        .where(and(
          eq(ingestionJobs.sourceFile, sourceFile),
          inArray(
            ingestionJobs.controlState,
            ["pause_requested", "cancel_requested"],
          ),
          buildAvailableJobCondition(),
        ))
        .returning({ sourceFile: ingestionJobs.sourceFile });
      if (settled.length > 0) {
        return true;
      }

      const acknowledged = await transaction
        .update(ingestionJobs)
        .set({
          controlError: null,
          updatedAt: currentTime,
        })
        .where(and(
          eq(ingestionJobs.sourceFile, sourceFile),
          inArray(
            ingestionJobs.controlState,
            ["pause_requested", "cancel_requested"],
          ),
        ))
        .returning({ sourceFile: ingestionJobs.sourceFile });
      return acknowledged.length === 1;
    });
  }

  public async recordIngestionControlError(
    sourceFile: string,
    error: string,
  ): Promise<boolean> {
    const currentTime = this.clock.now();
    const rows = await this.database
      .update(ingestionJobs)
      .set({
        controlError: error,
        updatedAt: currentTime,
      })
      .where(and(
        eq(ingestionJobs.sourceFile, sourceFile),
        inArray(
          ingestionJobs.controlState,
          ["pause_requested", "cancel_requested"],
        ),
      ))
      .returning({ sourceFile: ingestionJobs.sourceFile });
    return rows.length === 1;
  }

  public async completeNormalization(
    sourceFile: string,
    ownerId: string,
    elementSetId: string,
    statistics: DocumentStatistics,
  ): Promise<void> {
    const currentTime = this.clock.now();
    await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .update(ingestionJobs)
        .set({
          attemptCount: 0,
          doclingAttemptConfig: sql`CASE WHEN ${ingestionJobs.doclingRunId} IS NULL THEN NULL ELSE ${ingestionJobs.doclingAttemptConfig} END`,
          doclingServiceInstanceId: null,
          doclingServiceSlot: null,
          elementSetId,
          errorMessage: null,
          images: statistics.images,
          nextAttemptAt: currentTime,
          phase: "normalized",
          pageCount: statistics.pageCount,
          tables: statistics.tables,
          textChunks: statistics.textChunks,
          totalElements: statistics.totalElements,
          updatedAt: currentTime,
        })
        .where(
          and(
            buildOwnedRunningJobCondition(ownerId, sourceFile),
            eq(ingestionJobs.phase, "discovered"),
          ),
        )
        .returning({ sourceFile: ingestionJobs.sourceFile });
      requireSingleJobTransition(rows, sourceFile, "discovered");
      await transaction
        .delete(doclingTaskCheckpoints)
        .where(eq(doclingTaskCheckpoints.sourceFile, sourceFile));
    });
  }

  public async completeIndexing(
    sourceFile: string,
    ownerId: string,
  ): Promise<void> {
    await this.transitionPhase(sourceFile, ownerId, "normalized", "indexed");
  }

  public async markJobFailed(
    sourceFile: string,
    ownerId: string,
    errorMessage: string,
    applicationError: PreparedApplicationErrorEvent,
    retryBaseMs: number = 5_000,
  ): Promise<JobFailureResult | null> {
    const currentTime = this.clock.now();
    const failure = await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(ingestionJobs)
        .where(buildOwnedRunningJobCondition(ownerId, sourceFile))
        .limit(1)
        .for("update");
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      const job = decodeIngestionJob(row);
      const attempts = job.attemptCount + 1;
      const retryScheduled = attempts < job.maxAttempts;
      const retryAt = retryScheduled
        ? calculateRetryAt(currentTime, retryBaseMs, attempts)
        : currentTime;
      const state = retryScheduled ? "pending" : "failed";
      const retainDoclingAssignment = await shouldRetainDoclingAssignment(
        transaction,
        row,
      );
      const releasedDoclingState = buildReleasedDoclingState(
        row,
        retainDoclingAssignment,
      );
      await persistApplicationErrorEvent(
        transaction,
        withApplicationErrorAttempt(applicationError, attempts),
      );

      const updatedRows = await transaction
        .update(ingestionJobs)
        .set({
          attemptCount: attempts,
          ...releasedDoclingState,
          controlState: settleControlStateSql(),
          errorMessage,
          leaseExpiresAt: null,
          nextAttemptAt: retryAt,
          ownerId: null,
          state,
          updatedAt: currentTime,
        })
        .where(buildOwnedRunningJobCondition(ownerId, sourceFile))
        .returning({ sourceFile: ingestionJobs.sourceFile });
      if (updatedRows.length !== 1) {
        return null;
      }
      return {
        attempts,
        retryAt: retryScheduled ? retryAt.toISOString() : null,
        retryScheduled,
      };
    });
    return failure;
  }

  public async releaseJob(
    sourceFile: string,
    ownerId: string,
    delayMs: number = 0,
  ): Promise<boolean> {
    if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_RETRY_DELAY_MS) {
      throw new Error("Job release delay must be a nonnegative bounded integer.");
    }
    const currentTime = this.clock.now();
    const nextAttemptAt = new Date(currentTime.getTime() + delayMs);
    const released = await this.database.transaction(async (transaction) => {
      const jobs = await transaction
        .select()
        .from(ingestionJobs)
        .where(buildOwnedRunningJobCondition(ownerId, sourceFile))
        .limit(1)
        .for("update");
      const job = jobs[0];
      if (job === undefined) {
        return false;
      }
      const retainDoclingAssignment = await shouldRetainDoclingAssignment(
        transaction,
        job,
      );
      const releasedDoclingState = buildReleasedDoclingState(
        job,
        retainDoclingAssignment,
      );
      const rows = await transaction
        .update(ingestionJobs)
        .set({
          ...releasedDoclingState,
          controlState: settleControlStateSql(),
          errorMessage: null,
          leaseExpiresAt: null,
          nextAttemptAt,
          ownerId: null,
          state: "pending",
          updatedAt: currentTime,
        })
        .where(buildOwnedRunningJobCondition(ownerId, sourceFile))
        .returning({ sourceFile: ingestionJobs.sourceFile });
      return rows.length === 1;
    });
    return released;
  }

  public async requestControl(
    sourceFile: string,
    action: "pause" | "cancel",
    actor: { isAdministrator: boolean; userId: string },
  ): Promise<RequestIngestionControlResult> {
    const currentTime = this.clock.now();
    return this.database.transaction(async (transaction) => {
      const job = await readLockedIngestionJob(transaction, sourceFile);
      if (job === null) {
        return { kind: "not-found" };
      }
      if (!canControlJob(job, actor)) {
        return { kind: "forbidden" };
      }
      const nextControlState = readRequestedControlState(job, action);
      if (nextControlState === null) {
        return {
          controlState: job.controlState,
          kind: "invalid",
          state: job.state,
        };
      }
      const rows = await transaction
        .update(ingestionJobs)
        .set({
          controlError: null,
          controlState: nextControlState,
          updatedAt: currentTime,
        })
        .where(and(
          eq(ingestionJobs.sourceFile, sourceFile),
          eq(ingestionJobs.controlState, job.controlState),
          eq(ingestionJobs.state, job.state),
        ))
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new Error(`Could not request ${action} for ${sourceFile}.`);
      }
      return { job: decodeIngestionJob(row), kind: "accepted" };
    });
  }

  public async resumePausedJob(
    sourceFile: string,
    actor: { isAdministrator: boolean; userId: string },
  ): Promise<ResumeIngestionResult> {
    const currentTime = this.clock.now();
    return this.database.transaction(async (transaction) => {
      const job = await readLockedIngestionJob(transaction, sourceFile);
      if (job === null) {
        return { kind: "not-found" };
      }
      if (!canControlJob(job, actor)) {
        return { kind: "forbidden" };
      }
      if (job.state !== "pending" || job.controlState !== "paused") {
        return { kind: "not-paused" };
      }
      const pausedAtMs = Date.parse(job.updatedAt);
      const pausedDurationMs = Math.max(
        0,
        currentTime.getTime() - pausedAtMs,
      );
      const checkpoints = await transaction
        .select({
          deadlineAt: doclingTaskCheckpoints.deadlineAt,
          requestKey: doclingTaskCheckpoints.requestKey,
        })
        .from(doclingTaskCheckpoints)
        .where(eq(doclingTaskCheckpoints.sourceFile, sourceFile))
        .for("update");
      for (const checkpoint of checkpoints) {
        const extendedDeadline = new Date(
          checkpoint.deadlineAt.getTime() + pausedDurationMs,
        );
        await transaction
          .update(doclingTaskCheckpoints)
          .set({ deadlineAt: extendedDeadline })
          .where(and(
            eq(doclingTaskCheckpoints.sourceFile, sourceFile),
            eq(
              doclingTaskCheckpoints.requestKey,
              checkpoint.requestKey,
            ),
          ));
      }
      const rows = await transaction
        .update(ingestionJobs)
        .set({ controlError: null, controlState: "active", updatedAt: currentTime })
        .where(and(
          eq(ingestionJobs.sourceFile, sourceFile),
          eq(ingestionJobs.state, "pending"),
          eq(ingestionJobs.controlState, "paused"),
        ))
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new Error(`Paused ingestion changed while resuming: ${sourceFile}`);
      }
      return { job: decodePendingIngestionJob(row), kind: "resumed" };
    });
  }

  public async settleOwnedControl(
    sourceFile: string,
    ownerId: string,
  ): Promise<IngestionJob | null> {
    const currentTime = this.clock.now();
    const rows = await this.database
      .update(ingestionJobs)
      .set({
        doclingServiceInstanceId: null,
        doclingServiceSlot: null,
        leaseExpiresAt: null,
        ownerId: null,
        state: "pending",
        controlState: sql`CASE WHEN ${ingestionJobs.controlState} = 'pause_requested' THEN 'paused'::ingestion_control_state ELSE ${ingestionJobs.controlState} END`,
        updatedAt: currentTime,
      })
      .where(and(
        buildOwnedRunningJobCondition(ownerId, sourceFile),
        inArray(ingestionJobs.controlState, ["pause_requested", "cancel_requested"]),
        notExists(
          this.database
            .select({ taskId: doclingTaskCheckpoints.taskId })
            .from(doclingTaskCheckpoints)
            .where(
              eq(
                doclingTaskCheckpoints.sourceFile,
                ingestionJobs.sourceFile,
              ),
            ),
        ),
      ))
      .returning();
    const row = rows[0];
    return row === undefined ? null : decodeIngestionJob(row);
  }

  public async settleExpiredControls(): Promise<IngestionJob[]> {
    const currentTime = this.clock.now();
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(ingestionJobs)
        .where(and(
          eq(ingestionJobs.state, "running"),
          inArray(ingestionJobs.controlState, ["pause_requested", "cancel_requested"]),
          notExists(
            transaction
              .select({ taskId: doclingTaskCheckpoints.taskId })
              .from(doclingTaskCheckpoints)
              .where(
                eq(
                  doclingTaskCheckpoints.sourceFile,
                  ingestionJobs.sourceFile,
                ),
              ),
          ),
          or(
            isNull(ingestionJobs.leaseExpiresAt),
            lte(ingestionJobs.leaseExpiresAt, databaseClock()),
          ),
        ))
        .for("update", { skipLocked: true });
      const settledJobs: IngestionJob[] = [];
      for (const row of rows) {
        const settledRows = await transaction
          .update(ingestionJobs)
          .set({
            controlState: row.controlState === "pause_requested" ? "paused" : "cancel_requested",
            doclingServiceInstanceId: null,
            doclingServiceSlot: null,
            leaseExpiresAt: null,
            ownerId: null,
            state: "pending",
            updatedAt: currentTime,
          })
          .where(eq(ingestionJobs.sourceFile, row.sourceFile))
          .returning();
        const settledRow = settledRows[0];
        if (settledRow !== undefined) {
          settledJobs.push(decodeIngestionJob(settledRow));
        }
      }
      return settledJobs;
    });
  }

  public async retryFailedJob(
    sourceFile: string,
  ): Promise<RetryFailedJobResult> {
    const currentTime = this.clock.now();
    const result = await this.database.transaction(async (
      transaction,
    ): Promise<RetryFailedJobResult> => {
      const job = await readLockedIngestionJob(transaction, sourceFile);
      if (job === null) {
        return { kind: "not-found" };
      }
      if (job.state !== "failed") {
        return { kind: "not-failed", state: job.state };
      }
      const pendingJob = await persistRetriedIngestionJob(
        transaction,
        sourceFile,
        currentTime,
      );
      return { job: pendingJob, kind: "retried" };
    });
    return result;
  }

  public async listJobs(): Promise<IngestionJob[]> {
    const rows = await this.database
      .select()
      .from(ingestionJobs)
      .orderBy(asc(ingestionJobs.sourceFile));
    const jobs: IngestionJob[] = [];
    for (const row of rows) {
      jobs.push(decodeIngestionJob(row));
    }
    return jobs;
  }

  public async cancelAvailableJob(
    sourceFile: string,
  ): Promise<IngestionJob | null> {
    const rows = await this.database
      .delete(ingestionJobs)
      .where(
        and(
          eq(ingestionJobs.sourceFile, sourceFile),
          buildAvailableJobCondition(),
        ),
      )
      .returning();
    const row = rows[0];
    return row === undefined ? null : decodeIngestionJob(row);
  }

  public async cancelAvailableJobs(
    sourceFiles: string[],
  ): Promise<IngestionJob[]> {
    if (sourceFiles.length === 0) {
      return [];
    }
    const uniqueSourceFiles = new Set(sourceFiles);
    if (uniqueSourceFiles.size !== sourceFiles.length) {
      throw new Error("Cannot cancel duplicate ingestion source files.");
    }
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .delete(ingestionJobs)
        .where(
          and(
            inArray(ingestionJobs.sourceFile, sourceFiles),
            buildAvailableJobCondition(),
          ),
        )
        .returning();
      if (rows.length !== sourceFiles.length) {
        throw new Error(
          "The ingestion queue changed during reconciliation; no jobs were canceled.",
        );
      }
      const jobs: IngestionJob[] = [];
      for (const row of rows) {
        jobs.push(decodeIngestionJob(row));
      }
      jobs.sort((left, right) => left.sourceFile.localeCompare(right.sourceFile));
      return jobs;
    });
  }

  private async transitionPhase(
    sourceFile: string,
    ownerId: string,
    expectedPhase: IngestionPhase,
    nextPhase: IngestionPhase,
  ): Promise<void> {
    const currentTime = this.clock.now();
    const rows = await this.database
      .update(ingestionJobs)
      .set({
        attemptCount: 0,
        errorMessage: null,
        nextAttemptAt: currentTime,
        phase: nextPhase,
        updatedAt: currentTime,
      })
      .where(
        and(
          buildOwnedRunningJobCondition(ownerId, sourceFile),
          eq(ingestionJobs.phase, expectedPhase),
        ),
      )
      .returning({ sourceFile: ingestionJobs.sourceFile });
    requireSingleJobTransition(rows, sourceFile, expectedPhase);
  }

  private readLeaseExpiration(): SQL<Date> {
    return sql<Date>`clock_timestamp() + ${this.leaseDurationMs} * interval '1 millisecond'`;
  }
}

type CatalogJobTransaction = Parameters<
  Parameters<CiteLoomDatabase["transaction"]>[0]
>[0];

function buildDueJobCondition(currentTime: Date): SQL {
  const condition = or(
    and(
      eq(ingestionJobs.state, "pending"),
      lte(ingestionJobs.nextAttemptAt, currentTime),
    ),
    and(
      eq(ingestionJobs.state, "running"),
      or(
        isNull(ingestionJobs.leaseExpiresAt),
        lt(ingestionJobs.leaseExpiresAt, databaseClock()),
      ),
    ),
  );
  if (condition === undefined) {
    throw new Error("Could not build the due ingestion job condition.");
  }
  return condition;
}

function buildDoclingServiceCondition(
  eligibleServiceIds: readonly string[],
  allowUnassignedJobs: boolean,
): SQL | null {
  const uniqueServiceIds: string[] = [];
  const seen = new Set<string>();
  for (const value of eligibleServiceIds) {
    const serviceId = readDoclingServiceId(value);
    if (seen.has(serviceId)) {
      continue;
    }
    seen.add(serviceId);
    uniqueServiceIds.push(serviceId);
  }
  if (uniqueServiceIds.length === 0) {
    return null;
  }
  const assignedServiceIsEligible = inArray(
    ingestionJobs.doclingServiceInstanceId,
    uniqueServiceIds,
  );
  const checkpointServiceIsEligible = sql<boolean>`
    EXISTS (
      SELECT 1
      FROM ${doclingTaskCheckpoints}
      WHERE ${doclingTaskCheckpoints.sourceFile} = ${ingestionJobs.sourceFile}
        AND ${inArray(
          doclingTaskCheckpoints.serviceInstanceId,
          uniqueServiceIds,
        )}
    )
  `;
  if (!allowUnassignedJobs) {
    const condition = or(
      assignedServiceIsEligible,
      and(
        isNull(ingestionJobs.doclingServiceInstanceId),
        checkpointServiceIsEligible,
      ),
    );
    return condition ?? null;
  }
  const hasCheckpoint = sql<boolean>`
    EXISTS (
      SELECT 1
      FROM ${doclingTaskCheckpoints}
      WHERE ${doclingTaskCheckpoints.sourceFile} = ${ingestionJobs.sourceFile}
    )
  `;
  const condition = or(
    assignedServiceIsEligible,
    and(
      isNull(ingestionJobs.doclingServiceInstanceId),
      checkpointServiceIsEligible,
    ),
    and(
      isNull(ingestionJobs.doclingServiceInstanceId),
      sql<boolean>`NOT (${hasCheckpoint})`,
    ),
  );
  if (condition === undefined) {
    throw new Error("Could not build the Docling service eligibility condition.");
  }
  return condition;
}

function effectiveDoclingServiceIdSql(): SQL<string | null> {
  return sql<string | null>`
    COALESCE(
      ${ingestionJobs.doclingServiceInstanceId},
      ${doclingTaskCheckpoints.serviceInstanceId}
    )
  `;
}

interface ClearableCheckpointJob {
  serviceInstanceId: string | null;
}

interface ReleasedDoclingState {
  doclingAttemptConfig: DoclingAttemptConfigSnapshot | null;
  doclingRunId: string | null;
  doclingServiceInstanceId: string | null;
  doclingServiceSlot: number | null;
}

async function readLockedIngestionJob(
  transaction: CatalogJobTransaction,
  sourceFile: string,
): Promise<IngestionJob | null> {
  const rows = await transaction
    .select()
    .from(ingestionJobs)
    .where(eq(ingestionJobs.sourceFile, sourceFile))
    .limit(1)
    .for("update");
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return decodeIngestionJob(row);
}

async function persistRetriedIngestionJob(
  transaction: CatalogJobTransaction,
  sourceFile: string,
  currentTime: Date,
): Promise<PendingIngestionJob> {
  const rows = await transaction
    .update(ingestionJobs)
    .set({
      attemptCount: 0,
      errorMessage: null,
      leaseExpiresAt: null,
      nextAttemptAt: currentTime,
      ownerId: null,
      controlError: null,
      controlState: "active",
      state: "pending",
      updatedAt: currentTime,
    })
    .where(
      and(
        eq(ingestionJobs.sourceFile, sourceFile),
        eq(ingestionJobs.state, "failed"),
      ),
    )
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Failed ingestion job changed while retrying: ${sourceFile}`);
  }
  return decodePendingIngestionJob(row);
}

function settleControlStateSql(): SQL<IngestionControlState> {
  return sql`
    CASE
      WHEN ${ingestionJobs.controlState} = 'pause_requested'
        AND NOT EXISTS (
          SELECT 1
          FROM ${doclingTaskCheckpoints}
          WHERE ${doclingTaskCheckpoints.sourceFile} = ${ingestionJobs.sourceFile}
        )
      THEN 'paused'::ingestion_control_state
      ELSE ${ingestionJobs.controlState}
    END
  `;
}

async function readRecordableCheckpointServiceId(
  transaction: CatalogJobTransaction,
  ownerId: string,
  sourceFile: string,
): Promise<string | null> {
  const rows = await transaction
    .select({ serviceInstanceId: ingestionJobs.doclingServiceInstanceId })
    .from(ingestionJobs)
    .where(and(
      buildOwnedRunningJobCondition(ownerId, sourceFile),
      eq(ingestionJobs.phase, "discovered"),
    ))
    .limit(1)
    .for("update");
  return rows[0]?.serviceInstanceId ?? null;
}

async function insertDoclingTaskCheckpoint(
  transaction: CatalogJobTransaction,
  sourceFile: string,
  requestKey: string,
  serviceInstanceId: string,
  task: DoclingTaskReference,
): Promise<void> {
  await transaction
    .insert(doclingTaskCheckpoints)
    .values({
      deadlineAt: new Date(task.deadlineAt),
      requestKey,
      serviceInstanceId,
      sourceFile,
      submittedAt: new Date(task.submittedAt),
      taskId: task.id,
    })
    .onConflictDoNothing();
}

async function readStoredDoclingTaskCheckpoint(
  transaction: CatalogJobTransaction,
  sourceFile: string,
  requestKey: string,
  serviceInstanceId: string,
): Promise<DoclingTaskReference | null> {
  const rows = await transaction
    .select({
      deadlineAt: doclingTaskCheckpoints.deadlineAt,
      serviceInstanceId: doclingTaskCheckpoints.serviceInstanceId,
      submittedAt: doclingTaskCheckpoints.submittedAt,
      taskId: doclingTaskCheckpoints.taskId,
    })
    .from(doclingTaskCheckpoints)
    .where(and(
      eq(doclingTaskCheckpoints.sourceFile, sourceFile),
      eq(doclingTaskCheckpoints.requestKey, requestKey),
    ))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return decodeDoclingTaskCheckpoint(
    row,
    sourceFile,
    requestKey,
    serviceInstanceId,
  );
}

function doclingTaskReferencesEqual(
  left: DoclingTaskReference,
  right: DoclingTaskReference,
): boolean {
  return left.id === right.id
    && left.submittedAt === right.submittedAt
    && left.deadlineAt === right.deadlineAt;
}

async function readClearableCheckpointJob(
  transaction: CatalogJobTransaction,
  ownerId: string,
  sourceFile: string,
): Promise<ClearableCheckpointJob | undefined> {
  const rows = await transaction
    .select({
      serviceInstanceId: ingestionJobs.doclingServiceInstanceId,
    })
    .from(ingestionJobs)
    .where(buildOwnedRunningJobCondition(ownerId, sourceFile))
    .limit(1)
    .for("update");
  return rows[0];
}

async function deleteDoclingTaskCheckpoint(
  transaction: CatalogJobTransaction,
  sourceFile: string,
  requestKey: string,
  serviceInstanceId: string,
  taskId: string,
): Promise<boolean> {
  const deleted = await transaction
    .delete(doclingTaskCheckpoints)
    .where(and(
      eq(doclingTaskCheckpoints.sourceFile, sourceFile),
      eq(doclingTaskCheckpoints.requestKey, requestKey),
      eq(doclingTaskCheckpoints.serviceInstanceId, serviceInstanceId),
      eq(doclingTaskCheckpoints.taskId, taskId),
    ))
    .returning({ taskId: doclingTaskCheckpoints.taskId });
  return deleted.length > 0;
}

function buildReleasedDoclingState(
  job: typeof ingestionJobs.$inferSelect,
  retainAssignment: boolean,
): ReleasedDoclingState {
  if (!retainAssignment) {
    return {
      doclingAttemptConfig: null,
      doclingRunId: null,
      doclingServiceInstanceId: null,
      doclingServiceSlot: null,
    };
  }
  return {
    doclingAttemptConfig: job.doclingAttemptConfig,
    doclingRunId: job.doclingRunId,
    doclingServiceInstanceId: job.doclingServiceInstanceId,
    doclingServiceSlot: job.doclingServiceSlot,
  };
}

export function buildAvailableJobCondition() {
  const condition = or(
    ne(ingestionJobs.state, "running"),
    isNull(ingestionJobs.leaseExpiresAt),
    lte(ingestionJobs.leaseExpiresAt, databaseClock()),
  );
  if (condition === undefined) {
    throw new Error("Could not build the ingestion availability condition.");
  }
  return condition;
}

export function buildOwnedRunningJobCondition(
  ownerId: string,
  sourceFile: string,
) {
  return and(
    eq(ingestionJobs.sourceFile, sourceFile),
    eq(ingestionJobs.state, "running"),
    eq(ingestionJobs.ownerId, ownerId),
    gt(ingestionJobs.leaseExpiresAt, databaseClock()),
  );
}

function databaseClock(): SQL<Date> {
  return sql<Date>`clock_timestamp()`;
}

function requireRunningIngestionJob(row: unknown): RunningIngestionJob {
  const job = decodeIngestionJob(row);
  if (job.state !== "running") {
    throw new Error(`Claimed ingestion job is not running: ${job.sourceFile}.`);
  }
  return job;
}

function readRequestedControlState(
  job: IngestionJob,
  action: "pause" | "cancel",
): IngestionControlState | null {
  if (action === "cancel") {
    return "cancel_requested";
  }
  if (
    job.state === "failed"
    || job.controlState === "cancel_requested"
    || job.controlState === "cleanup_failed"
  ) {
    return null;
  }
  if (job.controlState === "pause_requested" || job.controlState === "paused") {
    return job.controlState;
  }
  return job.state === "running" ? "pause_requested" : "paused";
}

function canControlJob(
  job: IngestionJob,
  actor: { isAdministrator: boolean; userId: string },
): boolean {
  if (job.uploadedByUserId === null) {
    return false;
  }
  return actor.isAdministrator || job.uploadedByUserId === actor.userId;
}

export function requireSingleJobTransition(
  rows: Array<{ sourceFile: string }>,
  sourceFile: string,
  phase: IngestionPhase,
): void {
  if (rows.length !== 1) {
    throw new Error(`Cannot transition ${sourceFile} from ingestion phase ${phase}.`);
  }
}

function calculateRetryAt(
  currentTime: Date,
  retryBaseMs: number,
  attempts: number,
): Date {
  if (!Number.isInteger(retryBaseMs) || retryBaseMs <= 0) {
    throw new Error("Retry base delay must be a positive integer.");
  }
  const multiplier = 2 ** Math.max(0, attempts - 1);
  const delayMs = Math.min(retryBaseMs * multiplier, MAX_RETRY_DELAY_MS);
  return new Date(currentTime.getTime() + delayMs);
}

function readDoclingRequestKey(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > 128
    || !/^[a-z0-9][a-z0-9:,_-]*$/.test(normalized)
  ) {
    throw new Error("Invalid Docling request checkpoint key.");
  }
  return normalized;
}

function decodeDoclingTaskCheckpoint(
  value: unknown,
  sourceFile: string,
  requestKey: string,
  expectedServiceInstanceId: string,
): DoclingTaskReference {
  const result = doclingTaskCheckpointRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid Docling task checkpoint for ${sourceFile} (${requestKey}): ${result.error.message}`,
    );
  }
  if (result.data.deadlineAt <= result.data.submittedAt) {
    throw new Error(
      `Invalid Docling task checkpoint deadline for ${sourceFile} (${requestKey}).`,
    );
  }
  if (result.data.serviceInstanceId !== expectedServiceInstanceId) {
    throw new Error(
      `Docling task checkpoint service ${result.data.serviceInstanceId} does not match assigned service ${expectedServiceInstanceId} for ${sourceFile} (${requestKey}).`,
    );
  }
  return {
    deadlineAt: result.data.deadlineAt.toISOString(),
    id: result.data.taskId,
    submittedAt: result.data.submittedAt.toISOString(),
  };
}

function readDoclingServiceId(value: string): string {
  const result = z.string().trim().min(1).max(100).regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
  ).safeParse(value);
  if (!result.success) {
    throw new Error("Invalid Docling service instance ID.");
  }
  return result.data;
}

function readDoclingTaskId(value: string): string {
  const result = z.string().uuid().safeParse(value);
  if (!result.success) {
    throw new Error("Invalid Docling task ID.");
  }
  return result.data;
}

function decodeIngestionControlDoclingTask(
  value: unknown,
): IngestionControlDoclingTask {
  const result = ingestionControlDoclingTaskRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid ingestion control Docling task: ${result.error.message}`,
    );
  }
  return result.data;
}

async function shouldRetainDoclingAssignment(
  database: CiteLoomDatabase,
  job: {
    doclingRunId: string | null;
    sourceFile: string;
  },
): Promise<boolean> {
  const checkpoints = await database
    .select({ sourceFile: doclingTaskCheckpoints.sourceFile })
    .from(doclingTaskCheckpoints)
    .where(eq(doclingTaskCheckpoints.sourceFile, job.sourceFile))
    .limit(1);
  if (checkpoints.length > 0) {
    return true;
  }
  if (job.doclingRunId === null) {
    return false;
  }
  const runs = await database
    .select({ completedAt: doclingConversionRuns.completedAt })
    .from(doclingConversionRuns)
    .where(eq(doclingConversionRuns.id, job.doclingRunId))
    .limit(1);
  const run = runs[0];
  if (run === undefined) {
    throw new Error(`Missing Docling metrics run ${job.doclingRunId}.`);
  }
  return run.completedAt === null;
}
