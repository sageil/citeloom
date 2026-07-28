import {
  asc,
  count,
  inArray,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type {
  ApplicationErrorRetentionConfig,
} from "../config/index.js";
import type { CiteLoomDatabase } from "../database/client.js";
import { applicationErrorEvents } from "../database/schema.js";

const APPLICATION_ERROR_RETENTION_LOCK =
  "citeloom.application-error-retention";
const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_MAXIMUM_BATCHES = 20;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1_000;
const DEFAULT_CATCH_UP_DELAY_MS = 1_000;

const applicationErrorCountRowSchema = z.object({
  value: z.number().int().nonnegative(),
});
const applicationErrorRetentionLockRowSchema = z.object({
  acquired: z.boolean(),
});

export interface ApplicationErrorRetentionBatchResult {
  deleted: number;
  hasMore: boolean;
}

export interface ApplicationErrorRetentionResult
  extends ApplicationErrorRetentionBatchResult {
  batches: number;
}

export interface ApplicationErrorRetentionController {
  close(): Promise<void>;
}

export interface ApplicationErrorRetentionControllerDependencies {
  catchUpDelayMs?: number;
  cleanup(): Promise<ApplicationErrorRetentionResult>;
  intervalMs?: number;
  reportError(error: unknown): Promise<void>;
  reportProgress?(message: string): void;
}

export async function deleteApplicationErrorRetentionBatch(
  database: CiteLoomDatabase,
  config: ApplicationErrorRetentionConfig,
  batchSize: number = DEFAULT_BATCH_SIZE,
): Promise<ApplicationErrorRetentionBatchResult> {
  const normalizedBatchSize = readPositiveInteger(batchSize, "retention batch size");
  return database.transaction(async (transaction) => {
    const lockResult = await transaction.execute(sql`
      select pg_try_advisory_xact_lock(
        hashtextextended(${APPLICATION_ERROR_RETENTION_LOCK}, 0)
      ) as acquired
    `);
    const lock = applicationErrorRetentionLockRowSchema.parse(
      lockResult.rows[0],
    );
    if (!lock.acquired) {
      return { deleted: 0, hasMore: true };
    }
    const countRows = await transaction
      .select({ value: count() })
      .from(applicationErrorEvents);
    const total = applicationErrorCountRowSchema.parse(countRows[0]).value;
    const candidates = await transaction
      .select({
        expired: sql<boolean>`${applicationErrorEvents.occurredAt}
          < clock_timestamp() - ${config.retentionDays} * interval '1 day'`,
        id: applicationErrorEvents.id,
      })
      .from(applicationErrorEvents)
      .orderBy(
        asc(applicationErrorEvents.occurredAt),
        asc(applicationErrorEvents.id),
      )
      .limit(normalizedBatchSize)
      .for("update", { skipLocked: true });

    let deleteCount = Math.min(
      Math.max(0, total - config.maximumRows),
      candidates.length,
    );
    for (let index = 0; index < candidates.length; index += 1) {
      if (candidates[index]?.expired === true) {
        deleteCount = Math.max(deleteCount, index + 1);
      }
    }
    if (deleteCount === 0) {
      return { deleted: 0, hasMore: false };
    }

    const ids: string[] = [];
    for (let index = 0; index < deleteCount; index += 1) {
      const candidate = candidates[index];
      if (candidate !== undefined) {
        ids.push(candidate.id);
      }
    }
    const deletedRows = await transaction
      .delete(applicationErrorEvents)
      .where(inArray(applicationErrorEvents.id, ids))
      .returning({ id: applicationErrorEvents.id });
    const deleted = deletedRows.length;
    const lastCandidate = candidates.at(-1);
    const hasMoreExpired = candidates.length === normalizedBatchSize
      && lastCandidate?.expired === true;
    const hasMoreAboveLimit = total - deleted > config.maximumRows;
    return {
      deleted,
      hasMore: hasMoreExpired || hasMoreAboveLimit,
    };
  });
}

export async function enforceApplicationErrorRetention(
  database: CiteLoomDatabase,
  config: ApplicationErrorRetentionConfig,
  batchSize: number = DEFAULT_BATCH_SIZE,
  maximumBatches: number = DEFAULT_MAXIMUM_BATCHES,
): Promise<ApplicationErrorRetentionResult> {
  const normalizedMaximumBatches = readPositiveInteger(
    maximumBatches,
    "maximum retention batches",
  );
  let batches = 0;
  let deleted = 0;
  let hasMore = false;
  while (batches < normalizedMaximumBatches) {
    const result = await deleteApplicationErrorRetentionBatch(
      database,
      config,
      batchSize,
    );
    batches += 1;
    deleted += result.deleted;
    hasMore = result.hasMore;
    if (!hasMore || result.deleted === 0) {
      break;
    }
  }
  return { batches, deleted, hasMore };
}

export function startApplicationErrorRetentionController(
  dependencies: ApplicationErrorRetentionControllerDependencies,
): ApplicationErrorRetentionController {
  const intervalMs = readPositiveInteger(
    dependencies.intervalMs ?? DEFAULT_INTERVAL_MS,
    "retention interval",
  );
  const catchUpDelayMs = readPositiveInteger(
    dependencies.catchUpDelayMs ?? DEFAULT_CATCH_UP_DELAY_MS,
    "retention catch-up delay",
  );
  let closed = false;
  let failureDelayMs = Math.min(catchUpDelayMs, intervalMs);
  let running: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const schedule = (delayMs: number): void => {
    if (closed) {
      return;
    }
    timer = setTimeout(requestRun, delayMs);
    timer.unref();
  };
  const execute = async (): Promise<void> => {
    let nextDelayMs = intervalMs;
    try {
      const result = await dependencies.cleanup();
      failureDelayMs = Math.min(catchUpDelayMs, intervalMs);
      if (result.deleted > 0) {
        dependencies.reportProgress?.(
          `Deleted ${result.deleted} expired or excess application error event(s) in ${result.batches} batch(es).`,
        );
      }
      if (result.hasMore) {
        nextDelayMs = catchUpDelayMs;
      }
    } catch (error: unknown) {
      nextDelayMs = failureDelayMs;
      failureDelayMs = Math.min(intervalMs, failureDelayMs * 2);
      try {
        await dependencies.reportError(error);
      } catch (reportingError: unknown) {
        console.error(
          `Application error retention and failure reporting both failed: ${readErrorMessage(reportingError)}`,
        );
      }
    } finally {
      running = null;
      schedule(nextDelayMs);
    }
  };
  function requestRun(): void {
    if (closed || running !== null) {
      return;
    }
    running = execute();
  }

  queueMicrotask(requestRun);
  return {
    close: async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      await running;
    },
  };
}

function readPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
