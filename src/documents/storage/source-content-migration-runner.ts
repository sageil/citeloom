import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { CiteLoomDatabase } from "../../database/client.js";
import {
  applicationSettings,
  sourceContentMigrations,
  sourceDocuments,
} from "../../database/schema.js";
import { sanitizeDiagnosticMessage } from "../../observability/application-errors.js";
import { parseStoredApplicationSettings } from "../../providers/settings-persistence.js";
import { createSourceContentBackend } from "./source-content-backend.js";
import {
  copyAndVerifySourceContentDocument,
  readSourceContentMigrationBatch,
  visitSourceContentDocuments,
  visitSourceContentDocumentsPublishedSince,
} from "./source-content-migration.js";
import {
  SourceContentMigrationConflictError,
  type SourceContentMigrationRecord,
  SourceContentMigrationRepository,
  sourceContentConfigsMatch,
} from "./source-content-migration-store.js";

const MIGRATION_POLL_INTERVAL_MS = 2_000;
const MIGRATION_LEASE_HEARTBEAT_MS = 30_000;

const applicationSettingsCutoverRowSchema = z.object({
  defaults: z.unknown(),
  settings: z.unknown(),
  version: z.number().int().positive(),
});

export interface SourceContentMigrationActivityRegistry {
  jobFinished(): Promise<void>;
  jobStarted(): Promise<void>;
}

export interface SourceContentMigrationWorkerOptions {
  once: boolean;
  registry?: SourceContentMigrationActivityRegistry;
  reportError?: (error: unknown) => Promise<void>;
  reportProgress?: (message: string) => void;
  signal?: AbortSignal;
}

export async function runSourceContentMigrationWorker(
  database: CiteLoomDatabase,
  options: SourceContentMigrationWorkerOptions,
): Promise<void> {
  const repository = new SourceContentMigrationRepository(database);
  while (options.signal?.aborted !== true) {
    const ownerId = randomUUID();
    const migration = await repository.claim(ownerId);
    if (migration === null) {
      if (options.once) {
        return;
      }
      try {
        await delay(MIGRATION_POLL_INTERVAL_MS, undefined, {
          signal: options.signal,
        });
      } catch (error: unknown) {
        if (isSignalAborted(options.signal)) {
          return;
        }
        throw error;
      }
      continue;
    }
    await options.registry?.jobStarted();
    try {
      await processClaimedSourceContentMigration(
        database,
        repository,
        migration,
        ownerId,
        options,
      );
    } finally {
      await options.registry?.jobFinished();
    }
    if (options.once) {
      return;
    }
  }
}

async function processClaimedSourceContentMigration(
  database: CiteLoomDatabase,
  repository: SourceContentMigrationRepository,
  migration: SourceContentMigrationRecord,
  ownerId: string,
  options: SourceContentMigrationWorkerOptions,
): Promise<void> {
  const lease = new SourceContentMigrationLease(
    repository,
    migration.id,
    ownerId,
  );
  lease.start();
  try {
    if (migration.state === "cancel_requested") {
      await repository.markCancelled(migration.id, ownerId);
      options.reportProgress?.(
        `Source-content migration ${migration.id} was cancelled.`,
      );
      return;
    }
    const source = createSourceContentBackend(migration.sourceConfig);
    const target = createSourceContentBackend(migration.targetConfig);
    await source.initialize("read");
    await target.initialize();
    await lease.checkpoint();

    let state = migration.state;
    if (state === "validating") {
      await repository.markValidated(migration.id, ownerId);
      state = "copying";
      options.reportProgress?.(
        `Source-content migration ${migration.id} validated its target.`,
      );
    }
    if (state === "copying") {
      const readyForCutover = await copyMigrationDocuments(
        database,
        repository,
        migration,
        ownerId,
        source,
        target,
        lease,
        options,
      );
      if (!readyForCutover) {
        return;
      }
      await repository.beginCutover(migration.id, ownerId);
      state = "cutover";
    }
    if (state !== "cutover") {
      throw new Error(`Unsupported source-content migration state: ${state}.`);
    }
    await lease.checkpoint();
    let preCutoverVerifiedDocuments = 0;
    await visitSourceContentDocuments(
      database,
      options.signal,
      async (document) => {
        await copyAndVerifySourceContentDocument(
          source,
          target,
          document,
          options.signal,
        );
        preCutoverVerifiedDocuments += 1;
      },
    );
    options.reportProgress?.(
      `Source-content migration ${migration.id} verified ${preCutoverVerifiedDocuments} objects before cutover.`,
    );
    await lease.checkpoint();
    const verified = await completeMigrationCutover(
      database,
      migration,
      ownerId,
      source,
      target,
      options.signal,
    );
    options.reportProgress?.(
      `Source-content migration ${migration.id} completed with ${verified} verified objects.`,
    );
  } catch (error: unknown) {
    if (options.signal?.aborted === true) {
      await repository.releaseLease(migration.id, ownerId);
      return;
    }
    const owned = await repository.readOwned(migration.id, ownerId);
    if (owned === null) {
      await options.reportError?.(error);
      return;
    }
    if (owned?.state === "cancel_requested") {
      await repository.markCancelled(migration.id, ownerId);
      return;
    }
    const message = sanitizeDiagnosticMessage(readErrorMessage(error));
    try {
      await repository.markFailed(migration.id, ownerId, message);
    } catch (settlementError: unknown) {
      if (!(settlementError instanceof SourceContentMigrationConflictError)) {
        throw new AggregateError(
          [error, settlementError],
          "Source-content migration and failure settlement both failed.",
        );
      }
    }
    options.reportProgress?.(
      `Source-content migration ${migration.id} failed: ${message}`,
    );
    await options.reportError?.(error);
  } finally {
    await lease.close();
  }
}

async function copyMigrationDocuments(
  database: CiteLoomDatabase,
  repository: SourceContentMigrationRepository,
  migration: SourceContentMigrationRecord,
  ownerId: string,
  source: ReturnType<typeof createSourceContentBackend>,
  target: ReturnType<typeof createSourceContentBackend>,
  lease: SourceContentMigrationLease,
  options: SourceContentMigrationWorkerOptions,
): Promise<boolean> {
  let afterDocumentId = migration.lastDocumentId;
  let copiedDocuments = migration.copiedDocuments;
  let totalDocuments = Math.max(
    migration.totalDocuments,
    migration.copiedDocuments,
  );
  while (true) {
    options.signal?.throwIfAborted();
    await lease.checkpoint();
    const owned = await repository.readOwned(migration.id, ownerId);
    if (owned === null) {
      throw new SourceContentMigrationConflictError(
        "The source-content migration lease was lost.",
      );
    }
    if (owned.state === "cancel_requested") {
      await repository.markCancelled(migration.id, ownerId);
      options.reportProgress?.(
        `Source-content migration ${migration.id} was cancelled.`,
      );
      return false;
    }
    const documents = await readSourceContentMigrationBatch(
      database,
      afterDocumentId,
    );
    if (documents.length === 0) {
      return true;
    }
    for (const document of documents) {
      options.signal?.throwIfAborted();
      await copyAndVerifySourceContentDocument(
        source,
        target,
        document,
        options.signal,
      );
      copiedDocuments += 1;
      afterDocumentId = document.documentId;
    }
    totalDocuments = Math.max(totalDocuments, copiedDocuments);
    if (afterDocumentId === null) {
      throw new Error("Source-content migration progress has no document ID.");
    }
    await repository.saveCopyProgress(
      migration.id,
      ownerId,
      copiedDocuments,
      afterDocumentId,
      totalDocuments,
    );
    options.reportProgress?.(
      `Source-content migration ${migration.id} copied and verified ${copiedDocuments} objects.`,
    );
  }
}

async function completeMigrationCutover(
  database: CiteLoomDatabase,
  migration: SourceContentMigrationRecord,
  ownerId: string,
  source: ReturnType<typeof createSourceContentBackend>,
  target: ReturnType<typeof createSourceContentBackend>,
  abortSignal?: AbortSignal,
): Promise<number> {
  return database.transaction(async (transaction) => {
    await transaction.execute(
      sql`LOCK TABLE ${sourceDocuments} IN SHARE MODE`,
    );
    const migrationRows = await transaction
      .select({ id: sourceContentMigrations.id })
      .from(sourceContentMigrations)
      .where(and(
        eq(sourceContentMigrations.id, migration.id),
        eq(sourceContentMigrations.leaseOwner, ownerId),
        eq(sourceContentMigrations.state, "cutover"),
      ))
      .limit(1);
    if (migrationRows.length !== 1) {
      throw new SourceContentMigrationConflictError(
        "The source-content migration lease was lost before cutover.",
      );
    }
    const settingsRows = await transaction
      .select({
        defaults: applicationSettings.defaults,
        settings: applicationSettings.settings,
        version: applicationSettings.version,
      })
      .from(applicationSettings)
      .where(eq(applicationSettings.id, "runtime"))
      .limit(1)
      .for("update");
    const decoded = applicationSettingsCutoverRowSchema.safeParse(
      settingsRows[0],
    );
    if (!decoded.success) {
      throw new Error(
        `Invalid application settings at source-content cutover: ${decoded.error.message}`,
      );
    }
    const defaults = parseStoredApplicationSettings(decoded.data.defaults);
    const settings = parseStoredApplicationSettings(decoded.data.settings);
    if (!sourceContentConfigsMatch(
      settings.sourceContent,
      migration.sourceConfig,
    )) {
      throw new SourceContentMigrationConflictError(
        "The active source-content backend changed before cutover.",
      );
    }

    await visitSourceContentDocumentsPublishedSince(
      transaction,
      migration.createdAt,
      abortSignal,
      async (document) => {
        await copyAndVerifySourceContentDocument(
          source,
          target,
          document,
          abortSignal,
        );
      },
    );
    abortSignal?.throwIfAborted();
    const countRows = await transaction
      .select({ value: sql<number>`count(*)::integer` })
      .from(sourceDocuments);
    const verifiedDocuments = countRows[0]?.value;
    if (verifiedDocuments === undefined) {
      throw new Error("Source-content cutover could not count source documents.");
    }

    const nextDefaults = {
      ...defaults,
      sourceContent: migration.targetConfig,
    };
    const nextSettings = {
      ...settings,
      sourceContent: migration.targetConfig,
    };
    const completedAt = new Date();
    const updatedSettings = await transaction
      .update(applicationSettings)
      .set({
        defaults: nextDefaults,
        settings: nextSettings,
        updatedAt: completedAt,
        version: decoded.data.version + 1,
      })
      .where(and(
        eq(applicationSettings.id, "runtime"),
        eq(applicationSettings.version, decoded.data.version),
      ))
      .returning({ id: applicationSettings.id });
    if (updatedSettings.length !== 1) {
      throw new SourceContentMigrationConflictError(
        "Application settings changed during source-content cutover.",
      );
    }
    const completedMigration = await transaction
      .update(sourceContentMigrations)
      .set({
        activeSlot: null,
        completedAt,
        copiedDocuments: verifiedDocuments,
        errorMessage: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        state: "completed",
        totalDocuments: verifiedDocuments,
        updatedAt: completedAt,
        verifiedDocuments,
      })
      .where(and(
        eq(sourceContentMigrations.id, migration.id),
        eq(sourceContentMigrations.leaseOwner, ownerId),
        eq(sourceContentMigrations.state, "cutover"),
      ))
      .returning({ id: sourceContentMigrations.id });
    if (completedMigration.length !== 1) {
      throw new SourceContentMigrationConflictError(
        "The source-content migration lease was lost during cutover.",
      );
    }
    return verifiedDocuments;
  });
}

class SourceContentMigrationLease {
  private closed = false;
  private error: unknown = null;
  private pendingRenewal: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;

  public constructor(
    private readonly repository: SourceContentMigrationRepository,
    private readonly migrationId: string,
    private readonly ownerId: string,
  ) {}

  public start(): void {
    this.timer = setInterval(() => {
      this.queueRenewal();
    }, MIGRATION_LEASE_HEARTBEAT_MS);
    this.timer.unref();
  }

  public async checkpoint(): Promise<void> {
    this.queueRenewal();
    await this.pendingRenewal;
    if (this.error !== null) {
      throw this.error;
    }
  }

  public async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.pendingRenewal;
  }

  private queueRenewal(): void {
    if (this.closed || this.error !== null) {
      return;
    }
    this.pendingRenewal = this.pendingRenewal.then(async () => {
      const renewed = await this.repository.renewLease(
        this.migrationId,
        this.ownerId,
      );
      if (!renewed) {
        throw new SourceContentMigrationConflictError(
          "The source-content migration lease was lost.",
        );
      }
    }).catch((error: unknown) => {
      this.error = error;
    });
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
