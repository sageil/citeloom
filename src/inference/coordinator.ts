import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import {
  and,
  asc,
  eq,
  gt,
  isNull,
  isNotNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import {
  TaskLimiter,
  type TaskScheduler,
  type TaskTimingObserver,
} from "../shared/concurrency.js";
import {
  startLeaseHeartbeat,
  type LeaseConfirmation,
  type LeaseHeartbeat,
} from "../shared/lease-heartbeat.js";
import type {
  ProviderConcurrencyConfig,
  SchedulingConfig,
  WorkloadClass,
} from "../config/index.js";
import type { CiteLoomDatabase } from "../database/client.js";
import {
  applicationSettings,
  inferenceLimits,
  inferenceQueue,
  inferenceSchedulingEvents,
  inferenceSlots,
} from "../database/schema.js";
import { ApplicationErrorReporter } from "../observability/application-errors.js";

export interface AcquiredSlot {
  databaseNow: Date;
  leaseExpiresAt: Date;
  ownerId: string;
  queuedAt: Date;
  resourceGroup: string;
  slotNumber: number;
}

export interface InferenceLeaseRenewal {
  databaseNow: Date;
  leaseExpiresAt: Date;
}

export interface AdmissionCandidate {
  id: string;
  queuedAt: Date;
  workload: WorkloadClass;
}

export interface QueuedRequest extends AdmissionCandidate {
  ownerId: string;
  resourceGroup: string;
  settingsVersion: number;
}

export type QueueRequestInput = Omit<QueuedRequest, "queuedAt">;

export interface EnqueuedInferenceRequest {
  lease: InferenceLeaseRenewal;
  request: QueuedRequest;
}

export interface SchedulingEventRecord {
  completedAt: Date;
  executionDurationMs: number | null;
  outcome: "abort" | "error" | "success";
  queueWaitMs: number;
  queuedAt: Date;
  resourceGroup: string;
  startedAt: Date | null;
  workload: WorkloadClass;
}

export interface InferenceCoordinatorPersistence {
  configure(config: SchedulingConfig): Promise<void>;
  enqueue(
    request: QueueRequestInput,
    leaseDurationMs: number,
  ): Promise<EnqueuedInferenceRequest>;
  recordSchedulingEvent(record: SchedulingEventRecord): Promise<void>;
  releaseSlot(slot: AcquiredSlot): Promise<boolean>;
  removeQueuedRequest(request: QueuedRequest): Promise<void>;
  renewQueuedRequest(
    request: QueuedRequest,
    leaseDurationMs: number,
  ): Promise<InferenceLeaseRenewal | null>;
  renewSlot(
    slot: AcquiredSlot,
    leaseDurationMs: number,
  ): Promise<InferenceLeaseRenewal | null>;
  tryAcquire(
    request: QueuedRequest,
    ownerId: string,
    leaseDurationMs: number,
  ): Promise<AcquiredSlot | null>;
}

const workloadSchema = z.enum([
  "offline-tool",
  "ingestion",
  "interactive-answer",
  "interactive-search",
  "maintenance",
]);
const inferenceLimitRowSchema = z.object({
  backgroundProgressIntervalMs: z.number().int().min(100).max(3_600_000),
  backgroundStartedAt: z.date(),
  capacity: z.number().int().min(1).max(16),
  databaseNow: z.coerce.date(),
  resourceGroup: z.string().min(1).max(100),
});
const inferenceSlotRowSchema = z.object({
  resourceGroup: z.string().min(1).max(100),
  slotNumber: z.number().int().min(1).max(16),
});
const inferenceSlotLeaseRowSchema = z.object({
  databaseNow: z.coerce.date(),
  leaseExpiresAt: z.coerce.date(),
});
const inferenceQueueLeaseRowSchema = inferenceSlotLeaseRowSchema.extend({
  queuedAt: z.coerce.date(),
});
const applicationSettingsVersionRowSchema = z.object({
  version: z.number().int().positive(),
});
const queueCandidateSchema = z.object({
  id: z.uuid(),
  queuedAt: z.date(),
  workload: workloadSchema,
});
const MAX_SLOT_COUNT = 16;
const DEFAULT_LEASE_DURATION_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const taskNotRun = Symbol("task-not-run");
const passiveAbortSignal = new AbortController().signal;
const QUEUE_RENEWAL_RETRY_MAX_MS = 1_000;

interface MonotonicLeaseSchedule {
  deadline: number;
  renewalAt: number;
}

export class InferenceLeaseLostError extends Error {
  public constructor(resourceGroup: string, slotNumber: number, cause?: unknown) {
    super(
      `Inference lease was lost for ${resourceGroup} slot ${slotNumber}.`,
      { cause },
    );
    this.name = "InferenceLeaseLostError";
  }
}

export class InferenceCoordinator {
  private settingsVersion = -1;
  private telemetryEnabled = false;

  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly ownerId: string = randomUUID(),
    private readonly leaseDurationMs: number = DEFAULT_LEASE_DURATION_MS,
    private readonly pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
    private readonly persistence: InferenceCoordinatorPersistence | null = null,
  ) {}

  public async configure(config: SchedulingConfig): Promise<void> {
    const providerIds = new Set(
      config.providers.map((provider) => provider.providerId),
    );
    for (const target of Object.values(config.targets)) {
      if (!providerIds.has(target.providerId)) {
        throw new Error(
          `Provider capability refers to unknown provider ${target.providerId}.`,
        );
      }
    }
    this.telemetryEnabled = config.telemetryEnabled;
    if (this.persistence !== null) {
      await this.persistence.configure(config);
      this.settingsVersion = config.settingsVersion;
      return;
    }
    await this.database.transaction(async (transaction) => {
      await assertCurrentSettingsVersion(
        transaction,
        config.settingsVersion,
      );
      for (const provider of config.providers) {
        await this.configureResourceGroup(
          transaction,
          provider,
          config.backgroundProgressIntervalMs,
        );
      }
      await removeUnusedProviders(
        transaction,
        providerIds,
      );
    });
    this.settingsVersion = config.settingsVersion;
  }

  public createScheduler(
    resourceGroup: string,
    workload: WorkloadClass,
    localCapacity: number,
  ): TaskScheduler {
    return new DistributedTaskScheduler(
      this,
      resourceGroup,
      workload,
      localCapacity,
    );
  }

  public async run<T>(
    resourceGroup: string,
    workload: WorkloadClass,
    task: (abortSignal: AbortSignal) => Promise<T>,
    abortSignal?: AbortSignal,
    timingObserver?: TaskTimingObserver,
  ): Promise<T> {
    if (this.settingsVersion < 0) {
      throw new Error("Inference providers have not been configured.");
    }
    const enqueued = await this.enqueue(resourceGroup, workload, abortSignal);
    const request = enqueued.request;
    let slot: AcquiredSlot;
    try {
      slot = await this.acquire(request, enqueued.lease, abortSignal);
    } catch (error: unknown) {
      const removalError = await this.removeQueuedRequest(request);
      await this.recordSchedulingEvent(
        request,
        null,
        readOutcome(abortSignal),
        null,
      );
      if (removalError !== null) {
        throw new AggregateError(
          [error, removalError],
          "Queued inference cancellation could not be persisted cleanly.",
        );
      }
      throw error;
    }

    const heartbeat = await this.startHeartbeat(slot);
    const executionSignal = AbortSignal.any([
      abortSignal ?? passiveAbortSignal,
      heartbeat.signal,
    ]);
    let executionDurationMs: number | null = null;
    let startedAt: Date | null = null;
    let outcome: "abort" | "error" | "success" = "success";
    let result: T | typeof taskNotRun = taskNotRun;
    let taskError: unknown = taskNotRun;
    try {
      executionSignal.throwIfAborted();
      startedAt = slot.databaseNow;
      const executionStartedAt = performance.now();
      timingObserver?.started({ resourceGroup, workload });
      try {
        result = await task(executionSignal);
      } finally {
        executionDurationMs = elapsedMonotonicMilliseconds(executionStartedAt);
        timingObserver?.completed();
      }
    } catch (error: unknown) {
      outcome = readOutcome(abortSignal);
      taskError = error;
    }

    await heartbeat.stop();
    const cleanupErrors: unknown[] = [];
    if (heartbeat.signal.aborted) {
      cleanupErrors.push(heartbeat.signal.reason);
    }
    try {
      const released = await this.release(slot);
      if (!released && !heartbeat.signal.aborted) {
        cleanupErrors.push(
          new InferenceLeaseLostError(slot.resourceGroup, slot.slotNumber),
        );
      }
    } catch (error: unknown) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0 && outcome === "success") {
      outcome = "error";
    }
    await this.recordSchedulingEvent(
      request,
      startedAt,
      outcome,
      executionDurationMs,
    );

    if (taskError !== taskNotRun) {
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [taskError, ...cleanupErrors],
          "Inference task and lease cleanup both failed.",
        );
      }
      throw taskError;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "Inference lease cleanup failed.",
      );
    }
    if (result === taskNotRun) {
      throw new Error("Inference task completed without a result.");
    }
    return result;
  }

  private async configureResourceGroup(
    transaction: CoordinatorTransaction,
    provider: ProviderConcurrencyConfig,
    backgroundProgressIntervalMs: number,
  ): Promise<void> {
    await transaction
      .insert(inferenceLimits)
      .values({
        backgroundProgressIntervalMs,
        backgroundStartedAt: databaseClock(),
        capacity: provider.maximumParallelRequests,
        resourceGroup: provider.providerId,
        updatedAt: databaseClock(),
      })
      .onConflictDoUpdate({
        set: {
          backgroundProgressIntervalMs,
          capacity: provider.maximumParallelRequests,
          updatedAt: databaseClock(),
        },
        target: inferenceLimits.resourceGroup,
      });

    const slotValues: Array<typeof inferenceSlots.$inferInsert> = [];
    for (let slotNumber = 1; slotNumber <= MAX_SLOT_COUNT; slotNumber += 1) {
      slotValues.push({ resourceGroup: provider.providerId, slotNumber });
    }
    await transaction
      .insert(inferenceSlots)
      .values(slotValues)
      .onConflictDoNothing({
        target: [inferenceSlots.resourceGroup, inferenceSlots.slotNumber],
      });
  }

  private async enqueue(
    resourceGroup: string,
    workload: WorkloadClass,
    abortSignal?: AbortSignal,
  ): Promise<EnqueuedInferenceRequest> {
    abortSignal?.throwIfAborted();
    const input: QueueRequestInput = {
      id: randomUUID(),
      ownerId: this.ownerId,
      resourceGroup,
      settingsVersion: this.settingsVersion,
      workload,
    };
    if (this.persistence !== null) {
      return this.persistence.enqueue(input, this.leaseDurationMs);
    }
    const rows = await this.database
      .insert(inferenceQueue)
      .values({
        expiresAt: databaseLeaseExpiration(this.leaseDurationMs),
        id: input.id,
        ownerId: input.ownerId,
        queuedAt: databaseClock(),
        resourceGroup: input.resourceGroup,
        workload: input.workload,
      })
      .returning({
        databaseNow: databaseClock(),
        leaseExpiresAt: inferenceQueue.expiresAt,
        queuedAt: inferenceQueue.queuedAt,
      });
    const row = inferenceQueueLeaseRowSchema.parse(rows[0]);
    return {
      lease: {
        databaseNow: row.databaseNow,
        leaseExpiresAt: row.leaseExpiresAt,
      },
      request: {
        ...input,
        queuedAt: row.queuedAt,
      },
    };
  }

  private async acquire(
    request: QueuedRequest,
    initialLease: InferenceLeaseRenewal,
    abortSignal?: AbortSignal,
  ): Promise<AcquiredSlot> {
    let schedule = readMonotonicLeaseSchedule(initialLease);
    let confirmedDeadline = schedule.deadline;
    let renewalAt = schedule.renewalAt;
    while (true) {
      abortSignal?.throwIfAborted();
      const currentTime = performance.now();
      if (currentTime >= renewalAt) {
        let renewed: InferenceLeaseRenewal | null;
        let retryRenewal = false;
        try {
          renewed = await this.renewQueuedRequest(request);
        } catch (error: unknown) {
          const remainingMs = confirmedDeadline - performance.now();
          if (remainingMs <= 0) {
            throw new Error(
              `Inference queue lease expired for ${request.id}.`,
              { cause: error },
            );
          }
          renewalAt = performance.now()
            + Math.min(QUEUE_RENEWAL_RETRY_MAX_MS, remainingMs / 6);
          renewed = null;
          retryRenewal = true;
        }
        if (!retryRenewal && renewed === null) {
          throw new Error(`Inference queue lease expired for ${request.id}.`);
        }
        if (renewed !== null) {
          schedule = readMonotonicLeaseSchedule(renewed);
          confirmedDeadline = schedule.deadline;
          renewalAt = schedule.renewalAt;
        }
      }
      const slot = await this.tryAcquire(request);
      if (slot !== null) {
        return slot;
      }
      const renewalDelayMs = renewalAt - performance.now();
      await wait(
        Math.max(1, Math.min(this.pollIntervalMs, renewalDelayMs)),
        abortSignal,
      );
    }
  }

  private async tryAcquire(
    request: QueuedRequest,
  ): Promise<AcquiredSlot | null> {
    const ownerId = randomUUID();
    if (this.persistence !== null) {
      return this.persistence.tryAcquire(
        request,
        ownerId,
        this.leaseDurationMs,
      );
    }
    const acquired = await this.database.transaction(async (transaction) => {
      await assertCurrentSettingsVersion(
        transaction,
        request.settingsVersion,
      );
      await deleteExpiredQueueRequests(transaction);
      const limit = await readInferenceLimit(
        transaction,
        request.resourceGroup,
      );
      const slot = await readAvailableSlot(
        transaction,
        request.resourceGroup,
        limit.capacity,
      );
      if (slot === null) {
        return null;
      }
      const candidate = await readAdmissionCandidate(
        transaction,
        request.resourceGroup,
        limit,
      );
      if (candidate?.id !== request.id) {
        return null;
      }
      const removed = await removeAdmittedQueueRequest(transaction, request);
      if (!removed) {
        return null;
      }
      const lease = await acquireAvailableSlot(
        transaction,
        slot,
        ownerId,
        this.leaseDurationMs,
      );
      if (!isInteractiveWorkload(request.workload)) {
        await recordBackgroundAdmission(
          transaction,
          request.resourceGroup,
        );
      }
      return {
        databaseNow: lease.databaseNow,
        leaseExpiresAt: lease.leaseExpiresAt,
        ownerId,
        queuedAt: request.queuedAt,
        resourceGroup: slot.resourceGroup,
        slotNumber: slot.slotNumber,
      };
    });
    return acquired;
  }

  private async renewQueuedRequest(
    request: QueuedRequest,
  ): Promise<InferenceLeaseRenewal | null> {
    if (this.persistence !== null) {
      return this.persistence.renewQueuedRequest(
        request,
        this.leaseDurationMs,
      );
    }
    const rows = await this.database
      .update(inferenceQueue)
      .set({
        expiresAt: databaseLeaseExpiration(this.leaseDurationMs),
      })
      .where(and(
        eq(inferenceQueue.id, request.id),
        eq(inferenceQueue.ownerId, request.ownerId),
        gt(inferenceQueue.expiresAt, databaseClock()),
      ))
      .returning({
        databaseNow: databaseClock(),
        leaseExpiresAt: inferenceQueue.expiresAt,
      });
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return inferenceSlotLeaseRowSchema.parse(row);
  }

  private async removeQueuedRequest(
    request: QueuedRequest,
  ): Promise<Error | null> {
    try {
      if (this.persistence !== null) {
        await this.persistence.removeQueuedRequest(request);
        return null;
      }
      await this.database
        .delete(inferenceQueue)
        .where(and(
          eq(inferenceQueue.id, request.id),
          eq(inferenceQueue.ownerId, request.ownerId),
        ));
      return null;
    } catch (error: unknown) {
      return readError(error);
    }
  }

  private async renew(
    slot: AcquiredSlot,
  ): Promise<InferenceLeaseRenewal | null> {
    if (this.persistence !== null) {
      return this.persistence.renewSlot(
        slot,
        this.leaseDurationMs,
      );
    }
    const rows = await this.database
      .update(inferenceSlots)
      .set({
        leaseExpiresAt: databaseLeaseExpiration(this.leaseDurationMs),
        updatedAt: databaseClock(),
      })
      .where(and(
        eq(inferenceSlots.resourceGroup, slot.resourceGroup),
        eq(inferenceSlots.slotNumber, slot.slotNumber),
        eq(inferenceSlots.ownerId, slot.ownerId),
        gt(inferenceSlots.leaseExpiresAt, databaseClock()),
      ))
      .returning({
        databaseNow: databaseClock(),
        leaseExpiresAt: inferenceSlots.leaseExpiresAt,
      });
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return inferenceSlotLeaseRowSchema.parse(row);
  }

  private async release(slot: AcquiredSlot): Promise<boolean> {
    if (this.persistence !== null) {
      return this.persistence.releaseSlot(slot);
    }
    const rows = await this.database
      .update(inferenceSlots)
      .set({
        leaseExpiresAt: null,
        ownerId: null,
        updatedAt: databaseClock(),
      })
      .where(and(
        eq(inferenceSlots.resourceGroup, slot.resourceGroup),
        eq(inferenceSlots.slotNumber, slot.slotNumber),
        eq(inferenceSlots.ownerId, slot.ownerId),
        gt(inferenceSlots.leaseExpiresAt, databaseClock()),
      ))
      .returning({ slotNumber: inferenceSlots.slotNumber });
    return rows.length === 1;
  }

  private startHeartbeat(slot: AcquiredSlot): Promise<LeaseHeartbeat> {
    return startLeaseHeartbeat({
      confirmedLease: buildInferenceLeaseConfirmation(slot),
      createLeaseLostError: (cause) => new InferenceLeaseLostError(
        slot.resourceGroup,
        slot.slotNumber,
        cause,
      ),
      renew: async () => {
        const lease = await this.renew(slot);
        if (lease === null) {
          return null;
        }
        return buildInferenceLeaseConfirmation(lease);
      },
    });
  }

  private async recordSchedulingEvent(
    request: QueuedRequest,
    startedAt: Date | null,
    outcome: "abort" | "error" | "success",
    executionDurationMs: number | null,
  ): Promise<void> {
    if (!this.telemetryEnabled) {
      return;
    }
    const completedAt = new Date();
    const record: SchedulingEventRecord = {
      completedAt,
      executionDurationMs,
      outcome,
      queuedAt: request.queuedAt,
      queueWaitMs: elapsedWallMilliseconds(
        request.queuedAt,
        startedAt ?? completedAt,
      ),
      resourceGroup: request.resourceGroup,
      startedAt,
      workload: request.workload,
    };
    try {
      if (this.persistence !== null) {
        await this.persistence.recordSchedulingEvent(record);
        return;
      }
      await this.database.insert(inferenceSchedulingEvents).values({
        completedAt: record.completedAt,
        executionDurationMs: record.executionDurationMs,
        id: randomUUID(),
        outcome: record.outcome,
        queuedAt: record.queuedAt,
        queueWaitMs: record.queueWaitMs,
        resourceGroup: record.resourceGroup,
        startedAt: record.startedAt,
        workload: record.workload,
      });
    } catch (error: unknown) {
      const reporter = new ApplicationErrorReporter(this.database);
      await reporter.report(error, {
        category: "database-operation",
        code: "scheduling_event_persistence_failed",
        instance: hostname(),
        operation: "record-inference-scheduling-event",
        origin: "scheduler",
        requestId: request.id,
        retryable: true,
        service: "inference-scheduler",
        severity: "warning",
      });
    }
  }
}

class DistributedTaskScheduler implements TaskScheduler {
  private readonly localLimiter: TaskLimiter;

  public constructor(
    private readonly coordinator: InferenceCoordinator,
    private readonly resourceGroup: string,
    private readonly workload: WorkloadClass,
    public readonly capacity: number,
  ) {
    this.localLimiter = new TaskLimiter(capacity);
  }

  public run<T>(
    task: (abortSignal: AbortSignal) => Promise<T>,
    abortSignal?: AbortSignal,
    timingObserver?: TaskTimingObserver,
  ): Promise<T> {
    return this.localLimiter.run(
      async (localSignal) => this.coordinator.run(
        this.resourceGroup,
        this.workload,
        task,
        localSignal,
        timingObserver,
      ),
      abortSignal,
    );
  }
}

type CoordinatorTransaction = Parameters<
  Parameters<CiteLoomDatabase["transaction"]>[0]
>[0];

export class StaleInferenceSettingsError extends Error {
  public constructor(
    public readonly expectedVersion: number,
    public readonly currentVersion: number,
  ) {
    super(
      `Inference settings changed from version ${expectedVersion} to ${currentVersion} before the task started.`,
    );
    this.name = "StaleInferenceSettingsError";
  }
}

type InferenceLimit = z.output<typeof inferenceLimitRowSchema>;

interface AvailableSlot {
  resourceGroup: string;
  slotNumber: number;
}

async function assertCurrentSettingsVersion(
  transaction: CoordinatorTransaction,
  expectedVersion: number,
): Promise<void> {
  if (expectedVersion === 0) {
    return;
  }
  const rows = await transaction
    .select({ version: applicationSettings.version })
    .from(applicationSettings)
    .where(eq(applicationSettings.id, "runtime"))
    .limit(1)
    .for("share");
  const result = applicationSettingsVersionRowSchema.safeParse(rows[0]);
  if (!result.success) {
    throw new Error("Application settings version is unavailable.");
  }
  if (result.data.version !== expectedVersion) {
    throw new StaleInferenceSettingsError(
      expectedVersion,
      result.data.version,
    );
  }
}

async function removeUnusedProviders(
  transaction: CoordinatorTransaction,
  currentProviderIds: ReadonlySet<string>,
): Promise<void> {
  const rows = await transaction
    .select({ providerId: inferenceLimits.resourceGroup })
    .from(inferenceLimits);
  for (const row of rows) {
    if (currentProviderIds.has(row.providerId)) {
      continue;
    }
    const activeSlots = await transaction
      .select({ slotNumber: inferenceSlots.slotNumber })
      .from(inferenceSlots)
      .where(and(
        eq(inferenceSlots.resourceGroup, row.providerId),
        isNotNull(inferenceSlots.ownerId),
        gt(inferenceSlots.leaseExpiresAt, databaseClock()),
      ))
      .limit(1);
    if (activeSlots.length > 0) {
      throw new Error(
        `Provider ${row.providerId} still has an active request.`,
      );
    }
    await transaction
      .delete(inferenceQueue)
      .where(eq(inferenceQueue.resourceGroup, row.providerId));
    await transaction
      .delete(inferenceSlots)
      .where(eq(inferenceSlots.resourceGroup, row.providerId));
    await transaction
      .delete(inferenceLimits)
      .where(eq(inferenceLimits.resourceGroup, row.providerId));
  }
}

async function deleteExpiredQueueRequests(
  transaction: CoordinatorTransaction,
): Promise<void> {
  await transaction
    .delete(inferenceQueue)
    .where(lte(inferenceQueue.expiresAt, databaseClock()));
}

async function readInferenceLimit(
  transaction: CoordinatorTransaction,
  resourceGroup: string,
): Promise<InferenceLimit> {
  const rows = await transaction
    .select({
      backgroundProgressIntervalMs:
        inferenceLimits.backgroundProgressIntervalMs,
      backgroundStartedAt: inferenceLimits.backgroundStartedAt,
      capacity: inferenceLimits.capacity,
      databaseNow: databaseClock(),
      resourceGroup: inferenceLimits.resourceGroup,
    })
    .from(inferenceLimits)
    .where(eq(inferenceLimits.resourceGroup, resourceGroup))
    .limit(1)
    .for("update");
  const result = inferenceLimitRowSchema.safeParse(rows[0]);
  if (!result.success) {
    throw new Error(
      `Inference limit is not configured for ${resourceGroup}.`,
    );
  }
  return result.data;
}

async function readAdmissionCandidate(
  transaction: CoordinatorTransaction,
  resourceGroup: string,
  limit: InferenceLimit,
): Promise<AdmissionCandidate | null> {
  const primary = await readPrimaryCandidate(
    transaction,
    resourceGroup,
  );
  const backgroundDue = isBackgroundAdmissionDue(
    limit.backgroundStartedAt,
    limit.databaseNow,
    limit.backgroundProgressIntervalMs,
  );
  if (!backgroundDue) {
    return primary;
  }
  const background = await readBackgroundCandidate(
    transaction,
    resourceGroup,
  );
  return selectAdmissionCandidate(primary, background);
}

async function removeAdmittedQueueRequest(
  transaction: CoordinatorTransaction,
  request: QueuedRequest,
): Promise<boolean> {
  const rows = await transaction
    .delete(inferenceQueue)
    .where(and(
      eq(inferenceQueue.id, request.id),
      eq(inferenceQueue.ownerId, request.ownerId),
      gt(inferenceQueue.expiresAt, databaseClock()),
    ))
    .returning({ id: inferenceQueue.id });
  return rows.length === 1;
}

async function acquireAvailableSlot(
  transaction: CoordinatorTransaction,
  slot: AvailableSlot,
  ownerId: string,
  leaseDurationMs: number,
): Promise<InferenceLeaseRenewal> {
  const rows = await transaction
    .update(inferenceSlots)
    .set({
      leaseExpiresAt: databaseLeaseExpiration(leaseDurationMs),
      ownerId,
      updatedAt: databaseClock(),
    })
    .where(and(
      eq(inferenceSlots.resourceGroup, slot.resourceGroup),
      eq(inferenceSlots.slotNumber, slot.slotNumber),
    ))
    .returning({
      databaseNow: databaseClock(),
      leaseExpiresAt: inferenceSlots.leaseExpiresAt,
    });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Available inference slot could not be acquired.");
  }
  return inferenceSlotLeaseRowSchema.parse(row);
}

async function recordBackgroundAdmission(
  transaction: CoordinatorTransaction,
  resourceGroup: string,
): Promise<void> {
  await transaction
    .update(inferenceLimits)
    .set({
      backgroundStartedAt: databaseClock(),
      updatedAt: databaseClock(),
    })
    .where(eq(inferenceLimits.resourceGroup, resourceGroup));
}

async function readAvailableSlot(
  transaction: CoordinatorTransaction,
  resourceGroup: string,
  capacity: number,
): Promise<AvailableSlot | null> {
  const availability = or(
    isNull(inferenceSlots.ownerId),
    isNull(inferenceSlots.leaseExpiresAt),
    lt(inferenceSlots.leaseExpiresAt, databaseClock()),
  );
  if (availability === undefined) {
    throw new Error("Could not build the inference slot availability condition.");
  }
  const rows = await transaction
    .select({
      resourceGroup: inferenceSlots.resourceGroup,
      slotNumber: inferenceSlots.slotNumber,
    })
    .from(inferenceSlots)
    .where(and(
      eq(inferenceSlots.resourceGroup, resourceGroup),
      lte(inferenceSlots.slotNumber, capacity),
      availability,
    ))
    .orderBy(asc(inferenceSlots.slotNumber))
    .limit(1)
    .for("update", { skipLocked: true });
  const result = inferenceSlotRowSchema.safeParse(rows[0]);
  return result.success ? result.data : null;
}

async function readPrimaryCandidate(
  transaction: CoordinatorTransaction,
  resourceGroup: string,
): Promise<AdmissionCandidate | null> {
  const priority = sql<number>`case ${inferenceQueue.workload}
    when 'interactive-answer' then 0
    when 'interactive-search' then 1
    when 'ingestion' then 2
    when 'offline-tool' then 3
    else 4
  end`;
  const rows = await transaction
    .select({
      id: inferenceQueue.id,
      queuedAt: inferenceQueue.queuedAt,
      workload: inferenceQueue.workload,
    })
    .from(inferenceQueue)
    .where(and(
      eq(inferenceQueue.resourceGroup, resourceGroup),
      gt(inferenceQueue.expiresAt, databaseClock()),
    ))
    .orderBy(asc(priority), asc(inferenceQueue.queuedAt), asc(inferenceQueue.id))
    .limit(1);
  return decodeQueueCandidate(rows[0]);
}

async function readBackgroundCandidate(
  transaction: CoordinatorTransaction,
  resourceGroup: string,
): Promise<AdmissionCandidate | null> {
  const rows = await transaction
    .select({
      id: inferenceQueue.id,
      queuedAt: inferenceQueue.queuedAt,
      workload: inferenceQueue.workload,
    })
    .from(inferenceQueue)
    .where(and(
      eq(inferenceQueue.resourceGroup, resourceGroup),
      gt(inferenceQueue.expiresAt, databaseClock()),
      ne(inferenceQueue.workload, "interactive-answer"),
      ne(inferenceQueue.workload, "interactive-search"),
    ))
    .orderBy(asc(inferenceQueue.queuedAt), asc(inferenceQueue.id))
    .limit(1);
  return decodeQueueCandidate(rows[0]);
}

function decodeQueueCandidate(value: unknown): AdmissionCandidate | null {
  const result = queueCandidateSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function isBackgroundAdmissionDue(
  backgroundStartedAt: Date,
  currentTime: Date,
  backgroundProgressIntervalMs: number,
): boolean {
  return currentTime.getTime() - backgroundStartedAt.getTime()
    >= backgroundProgressIntervalMs;
}

export function selectAdmissionCandidate(
  primary: AdmissionCandidate | null,
  dueBackground: AdmissionCandidate | null,
): AdmissionCandidate | null {
  return dueBackground ?? primary;
}

export function isInteractiveWorkload(workload: WorkloadClass): boolean {
  return workload === "interactive-answer" || workload === "interactive-search";
}

async function wait(
  milliseconds: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (abortSignal !== undefined) {
        abortSignal.removeEventListener("abort", onAbort);
      }
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
      reject(abortSignal?.reason);
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted === true) {
      onAbort();
    }
  });
}

function elapsedMonotonicMilliseconds(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function readMonotonicLeaseSchedule(
  lease: InferenceLeaseRenewal,
): MonotonicLeaseSchedule {
  const remainingMs =
    lease.leaseExpiresAt.getTime() - lease.databaseNow.getTime();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new Error("Inference lease has no remaining duration.");
  }
  const currentTime = performance.now();
  return {
    deadline: currentTime + remainingMs,
    renewalAt: currentTime + remainingMs / 3,
  };
}

function elapsedWallMilliseconds(startedAt: Date, completedAt: Date): number {
  return Math.max(0, completedAt.getTime() - startedAt.getTime());
}

function buildInferenceLeaseConfirmation(
  lease: InferenceLeaseRenewal,
): LeaseConfirmation<null> {
  return {
    databaseNowMs: lease.databaseNow.getTime(),
    details: null,
    leaseExpiresAtMs: lease.leaseExpiresAt.getTime(),
  };
}

function databaseClock() {
  return sql<Date>`clock_timestamp()`;
}

function databaseLeaseExpiration(leaseDurationMs: number) {
  return sql<Date>`clock_timestamp() + ${leaseDurationMs} * interval '1 millisecond'`;
}

function readOutcome(
  abortSignal?: AbortSignal,
): "abort" | "error" {
  return abortSignal?.aborted === true ? "abort" : "error";
}

function readError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
