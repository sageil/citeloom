import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type { SourceContentConfig } from "../../config/index.js";
import type { CiteLoomDatabase } from "../../database/client.js";
import {
  applicationSettings,
  sourceContentMigrations,
  sourceDocuments,
} from "../../database/schema.js";
import {
  parseSourceContentConfig,
  parseStoredApplicationSettings,
} from "../../providers/settings-persistence.js";

const ACTIVE_MIGRATION_SLOT = 1;
const DEFAULT_LEASE_MS = 5 * 60 * 1_000;
const MIGRATION_QUEUE_LOCK_IDENTITY = "source-content-migration-queue";

export const sourceContentMigrationStateSchema = z.enum([
  "queued",
  "validating",
  "copying",
  "cutover",
  "cancel_requested",
  "completed",
  "failed",
  "cancelled",
]);

export type SourceContentMigrationState = z.output<
  typeof sourceContentMigrationStateSchema
>;

const activeMigrationStates: SourceContentMigrationState[] = [
  "queued",
  "validating",
  "copying",
  "cutover",
  "cancel_requested",
];

const sourceContentMigrationRowSchema = z.object({
  activeSlot: z.number().int().nullable(),
  attemptCount: z.number().int().nonnegative(),
  completedAt: z.date().nullable(),
  copiedDocuments: z.number().int().nonnegative(),
  createdAt: z.date(),
  errorMessage: z.string().nullable(),
  id: z.uuid(),
  lastDocumentId: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  leaseExpiresAt: z.date().nullable(),
  leaseOwner: z.uuid().nullable(),
  requestedByUserId: z.uuid(),
  sourceConfig: z.unknown(),
  startedAt: z.date().nullable(),
  state: sourceContentMigrationStateSchema,
  targetConfig: z.unknown(),
  totalDocuments: z.number().int().nonnegative(),
  updatedAt: z.date(),
  verifiedDocuments: z.number().int().nonnegative(),
});

const applicationSettingsRowSchema = z.object({
  settings: z.unknown(),
  version: z.number().int().positive(),
});
const databaseTimestampRowSchema = z.object({
  value: z.coerce.date(),
});

export interface SourceContentMigrationRecord {
  activeSlot: number | null;
  attemptCount: number;
  completedAt: Date | null;
  copiedDocuments: number;
  createdAt: Date;
  errorMessage: string | null;
  id: string;
  lastDocumentId: string | null;
  leaseExpiresAt: Date | null;
  leaseOwner: string | null;
  requestedByUserId: string;
  sourceConfig: SourceContentConfig;
  startedAt: Date | null;
  state: SourceContentMigrationState;
  targetConfig: SourceContentConfig;
  totalDocuments: number;
  updatedAt: Date;
  verifiedDocuments: number;
}

export interface SourceContentStorageOverview {
  activeConfig: SourceContentConfig;
  documentCount: number;
  migration: SourceContentMigrationRecord | null;
  settingsVersion: number;
}

export interface QueueSourceContentMigrationRequest {
  expectedSettingsVersion: number;
  requestedByUserId: string;
  targetConfig: SourceContentConfig;
}

export class SourceContentMigrationConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SourceContentMigrationConflictError";
  }
}

export class SourceContentMigrationNotFoundError extends Error {
  public constructor() {
    super("The source-content migration does not exist.");
    this.name = "SourceContentMigrationNotFoundError";
  }
}

type SourceContentMigrationTransaction = Parameters<
  Parameters<CiteLoomDatabase["transaction"]>[0]
>[0];

export class SourceContentMigrationRepository {
  public constructor(private readonly database: CiteLoomDatabase) {}

  public async readOverview(): Promise<SourceContentStorageOverview> {
    const [settingsRows, countRows, migrationRows] = await Promise.all([
      this.database
        .select({
          settings: applicationSettings.settings,
          version: applicationSettings.version,
        })
        .from(applicationSettings)
        .where(eq(applicationSettings.id, "runtime"))
        .limit(1),
      this.database.select({ value: count() }).from(sourceDocuments),
      this.database
        .select()
        .from(sourceContentMigrations)
        .orderBy(desc(sourceContentMigrations.createdAt))
        .limit(1),
    ]);
    const current = readApplicationSettingsRow(settingsRows[0]);
    return {
      activeConfig: current.settings.sourceContent,
      documentCount: countRows[0]?.value ?? 0,
      migration: migrationRows[0] === undefined
        ? null
        : decodeSourceContentMigrationRow(migrationRows[0]),
      settingsVersion: current.version,
    };
  }

  public async queue(
    request: QueueSourceContentMigrationRequest,
  ): Promise<SourceContentMigrationRecord> {
    return this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${MIGRATION_QUEUE_LOCK_IDENTITY}, 0))`,
      );
      const current = await readApplicationSettingsForUpdate(transaction);
      if (current.version !== request.expectedSettingsVersion) {
        throw new SourceContentMigrationConflictError(
          "Settings changed after the storage page was loaded. Reload and try again.",
        );
      }
      if (
        isDeepStrictEqual(
          current.settings.sourceContent,
          request.targetConfig,
        )
      ) {
        throw new SourceContentMigrationConflictError(
          "Source-content storage already uses the requested configuration.",
        );
      }
      const active = await transaction
        .select({ id: sourceContentMigrations.id })
        .from(sourceContentMigrations)
        .where(eq(sourceContentMigrations.activeSlot, ACTIVE_MIGRATION_SLOT))
        .limit(1)
        .for("update");
      if (active.length > 0) {
        throw new SourceContentMigrationConflictError(
          "Another source-content migration is already active.",
        );
      }
      await transaction.execute(
        sql`LOCK TABLE ${sourceDocuments} IN SHARE MODE`,
      );
      const timestampRows = await transaction
        .select({ value: sql<Date>`clock_timestamp()` })
        .from(applicationSettings)
        .where(eq(applicationSettings.id, "runtime"))
        .limit(1);
      const timestamp = databaseTimestampRowSchema.parse(timestampRows[0]).value;
      const countRows = await transaction
        .select({ value: count() })
        .from(sourceDocuments);
      const rows = await transaction
        .insert(sourceContentMigrations)
        .values({
          activeSlot: ACTIVE_MIGRATION_SLOT,
          createdAt: timestamp,
          id: randomUUID(),
          requestedByUserId: request.requestedByUserId,
          sourceConfig: current.settings.sourceContent,
          state: "queued",
          targetConfig: request.targetConfig,
          totalDocuments: countRows[0]?.value ?? 0,
          updatedAt: timestamp,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) {
        throw new Error("The source-content migration could not be queued.");
      }
      return decodeSourceContentMigrationRow(row);
    });
  }

  public async requestCancellation(
    id: string,
  ): Promise<SourceContentMigrationRecord> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(sourceContentMigrations)
        .where(eq(sourceContentMigrations.id, id))
        .limit(1)
        .for("update");
      const row = rows[0];
      if (row === undefined) {
        throw new SourceContentMigrationNotFoundError();
      }
      const migration = decodeSourceContentMigrationRow(row);
      if (migration.state === "cutover" || migration.state === "completed") {
        throw new SourceContentMigrationConflictError(
          "The migration can no longer be cancelled because cutover has started.",
        );
      }
      if (migration.state === "failed" || migration.state === "cancelled") {
        return migration;
      }
      const now = new Date();
      const canCancelImmediately = migration.leaseOwner === null;
      const state: SourceContentMigrationState = canCancelImmediately
        ? "cancelled"
        : "cancel_requested";
      const updated = await transaction
        .update(sourceContentMigrations)
        .set({
          activeSlot: canCancelImmediately ? null : ACTIVE_MIGRATION_SLOT,
          completedAt: canCancelImmediately ? now : null,
          leaseExpiresAt: canCancelImmediately ? null : migration.leaseExpiresAt,
          leaseOwner: canCancelImmediately ? null : migration.leaseOwner,
          state,
          updatedAt: now,
        })
        .where(eq(sourceContentMigrations.id, id))
        .returning();
      return decodeRequiredMigrationRow(updated[0]);
    });
  }

  public async claim(
    ownerId: string,
    currentTime: Date = new Date(),
    leaseMs: number = DEFAULT_LEASE_MS,
  ): Promise<SourceContentMigrationRecord | null> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select()
        .from(sourceContentMigrations)
        .where(and(
          inArray(sourceContentMigrations.state, activeMigrationStates),
          or(
            isNull(sourceContentMigrations.leaseExpiresAt),
            lte(sourceContentMigrations.leaseExpiresAt, currentTime),
          ),
        ))
        .orderBy(asc(sourceContentMigrations.createdAt))
        .limit(1)
        .for("update", { skipLocked: true });
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      const migration = decodeSourceContentMigrationRow(row);
      const state = migration.state === "queued"
        ? "validating"
        : migration.state;
      const leaseExpiresAt = new Date(currentTime.getTime() + leaseMs);
      const updated = await transaction
        .update(sourceContentMigrations)
        .set({
          attemptCount: sql`${sourceContentMigrations.attemptCount} + 1`,
          errorMessage: null,
          leaseExpiresAt,
          leaseOwner: ownerId,
          startedAt: migration.startedAt ?? currentTime,
          state,
          updatedAt: currentTime,
        })
        .where(eq(sourceContentMigrations.id, migration.id))
        .returning();
      return decodeRequiredMigrationRow(updated[0]);
    });
  }

  public async renewLease(
    id: string,
    ownerId: string,
    currentTime: Date = new Date(),
    leaseMs: number = DEFAULT_LEASE_MS,
  ): Promise<boolean> {
    const rows = await this.database
      .update(sourceContentMigrations)
      .set({
        leaseExpiresAt: new Date(currentTime.getTime() + leaseMs),
        updatedAt: currentTime,
      })
      .where(and(
        eq(sourceContentMigrations.id, id),
        eq(sourceContentMigrations.leaseOwner, ownerId),
        inArray(sourceContentMigrations.state, activeMigrationStates),
      ))
      .returning({ id: sourceContentMigrations.id });
    return rows.length === 1;
  }

  public async releaseLease(id: string, ownerId: string): Promise<void> {
    await this.database
      .update(sourceContentMigrations)
      .set({
        leaseExpiresAt: null,
        leaseOwner: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(sourceContentMigrations.id, id),
        eq(sourceContentMigrations.leaseOwner, ownerId),
        inArray(sourceContentMigrations.state, activeMigrationStates),
      ));
  }

  public async markValidated(id: string, ownerId: string): Promise<void> {
    await this.updateOwnedMigration(
      id,
      ownerId,
      ["validating"],
      { state: "copying", updatedAt: new Date() },
    );
  }

  public async saveCopyProgress(
    id: string,
    ownerId: string,
    copiedDocuments: number,
    lastDocumentId: string,
    totalDocuments: number,
  ): Promise<void> {
    await this.updateOwnedMigration(
      id,
      ownerId,
      ["copying"],
      {
        copiedDocuments,
        lastDocumentId,
        totalDocuments,
        updatedAt: new Date(),
      },
    );
  }

  public async beginCutover(id: string, ownerId: string): Promise<void> {
    await this.updateOwnedMigration(
      id,
      ownerId,
      ["copying"],
      { state: "cutover", updatedAt: new Date() },
    );
  }

  public async readOwned(
    id: string,
    ownerId: string,
  ): Promise<SourceContentMigrationRecord | null> {
    const rows = await this.database
      .select()
      .from(sourceContentMigrations)
      .where(and(
        eq(sourceContentMigrations.id, id),
        eq(sourceContentMigrations.leaseOwner, ownerId),
      ))
      .limit(1);
    return rows[0] === undefined
      ? null
      : decodeSourceContentMigrationRow(rows[0]);
  }

  public async markCancelled(id: string, ownerId: string): Promise<void> {
    const now = new Date();
    await this.updateOwnedMigration(
      id,
      ownerId,
      ["cancel_requested"],
      {
        activeSlot: null,
        completedAt: now,
        leaseExpiresAt: null,
        leaseOwner: null,
        state: "cancelled",
        updatedAt: now,
      },
    );
  }

  public async markFailed(
    id: string,
    ownerId: string,
    errorMessage: string,
  ): Promise<void> {
    const now = new Date();
    await this.updateOwnedMigration(
      id,
      ownerId,
      ["validating", "copying", "cutover"],
      {
        activeSlot: null,
        completedAt: now,
        errorMessage,
        leaseExpiresAt: null,
        leaseOwner: null,
        state: "failed",
        updatedAt: now,
      },
    );
  }

  private async updateOwnedMigration(
    id: string,
    ownerId: string,
    expectedStates: SourceContentMigrationState[],
    values: Partial<typeof sourceContentMigrations.$inferInsert>,
  ): Promise<void> {
    const rows = await this.database
      .update(sourceContentMigrations)
      .set(values)
      .where(and(
        eq(sourceContentMigrations.id, id),
        eq(sourceContentMigrations.leaseOwner, ownerId),
        inArray(sourceContentMigrations.state, expectedStates),
      ))
      .returning({ id: sourceContentMigrations.id });
    if (rows.length !== 1) {
      throw new SourceContentMigrationConflictError(
        "The source-content migration lease was lost.",
      );
    }
  }
}

async function readApplicationSettingsForUpdate(
  transaction: SourceContentMigrationTransaction,
): Promise<{
  settings: ReturnType<typeof parseStoredApplicationSettings>;
  version: number;
}> {
  const rows = await transaction
    .select({
      settings: applicationSettings.settings,
      version: applicationSettings.version,
    })
    .from(applicationSettings)
    .where(eq(applicationSettings.id, "runtime"))
    .limit(1)
    .for("update");
  return readApplicationSettingsRow(rows[0]);
}

function readApplicationSettingsRow(value: unknown): {
  settings: ReturnType<typeof parseStoredApplicationSettings>;
  version: number;
} {
  const decoded = applicationSettingsRowSchema.safeParse(value);
  if (!decoded.success) {
    throw new Error(
      `Invalid application settings row: ${decoded.error.message}`,
    );
  }
  return {
    settings: parseStoredApplicationSettings(decoded.data.settings),
    version: decoded.data.version,
  };
}

function decodeRequiredMigrationRow(
  value: unknown,
): SourceContentMigrationRecord {
  if (value === undefined) {
    throw new Error("The source-content migration update did not return a row.");
  }
  return decodeSourceContentMigrationRow(value);
}

export function decodeSourceContentMigrationRow(
  value: unknown,
): SourceContentMigrationRecord {
  const decoded = sourceContentMigrationRowSchema.safeParse(value);
  if (!decoded.success) {
    throw new Error(
      `Invalid source-content migration row: ${decoded.error.message}`,
    );
  }
  const sourceConfig = parseSourceContentConfig(decoded.data.sourceConfig);
  const targetConfig = parseSourceContentConfig(decoded.data.targetConfig);
  return {
    activeSlot: decoded.data.activeSlot,
    attemptCount: decoded.data.attemptCount,
    completedAt: decoded.data.completedAt,
    copiedDocuments: decoded.data.copiedDocuments,
    createdAt: decoded.data.createdAt,
    errorMessage: decoded.data.errorMessage,
    id: decoded.data.id,
    lastDocumentId: decoded.data.lastDocumentId,
    leaseExpiresAt: decoded.data.leaseExpiresAt,
    leaseOwner: decoded.data.leaseOwner,
    requestedByUserId: decoded.data.requestedByUserId,
    sourceConfig,
    startedAt: decoded.data.startedAt,
    state: decoded.data.state,
    targetConfig,
    totalDocuments: decoded.data.totalDocuments,
    updatedAt: decoded.data.updatedAt,
    verifiedDocuments: decoded.data.verifiedDocuments,
  };
}

export function sourceContentConfigsMatch(
  left: SourceContentConfig,
  right: SourceContentConfig,
): boolean {
  return isDeepStrictEqual(
    parseSourceContentConfig(left),
    parseSourceContentConfig(right),
  );
}
