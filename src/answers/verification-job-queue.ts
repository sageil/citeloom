import {
  and,
  asc,
  eq,
  lte,
  or,
  sql,
} from "drizzle-orm";

import type { CiteLoomDatabase } from "../database/client.js";
import {
  chatVerificationJobs,
  researchVerificationJobs,
} from "../database/schema.js";

const MINIMUM_VERIFICATION_JOB_LEASE_MS = 5 * 60 * 1_000;

type VerificationJobDatabase = Pick<CiteLoomDatabase, "select" | "update">;
type VerificationJobTable =
  | typeof chatVerificationJobs
  | typeof researchVerificationJobs;
type VerificationJobIdColumn =
  | typeof chatVerificationJobs.assistantMessageId
  | typeof researchVerificationJobs.turnId;

interface VerificationJobDefinition {
  idColumn: VerificationJobIdColumn;
  label: string;
  table: VerificationJobTable;
}

interface VerificationJobLease {
  attemptCount: number;
  failureCount: number;
  id: string;
}

class VerificationJobQueue {
  public constructor(private readonly definition: VerificationJobDefinition) {}

  public async claim(
    database: VerificationJobDatabase,
    currentTime: Date,
    verifierTimeoutMs: number,
  ): Promise<VerificationJobLease | null> {
    const table = this.definition.table;
    const rows = await database
      .select({
        attemptCount: table.attemptCount,
        failureCount: table.failureCount,
        id: this.definition.idColumn,
      })
      .from(table)
      .where(or(
        and(
          eq(table.state, "pending"),
          lte(table.availableAt, currentTime),
        ),
        and(
          eq(table.state, "running"),
          lte(table.leaseExpiresAt, currentTime),
        ),
      ))
      .orderBy(
        asc(table.availableAt),
        asc(table.updatedAt),
      )
      .limit(1)
      .for("update", { skipLocked: true });
    const row = rows[0];
    if (row === undefined) {
      return null;
    }

    const attemptCount = row.attemptCount + 1;
    const claimed = await database
      .update(table)
      .set({
        attemptCount,
        errorMessage: null,
        leaseExpiresAt: readLeaseExpiration(currentTime, verifierTimeoutMs),
        state: "running",
        updatedAt: currentTime,
      })
      .where(eq(this.definition.idColumn, row.id))
      .returning({ id: this.definition.idColumn });
    if (claimed[0] === undefined) {
      throw new Error(
        `Could not claim ${this.definition.label} verification job ${row.id}.`,
      );
    }
    return {
      attemptCount,
      failureCount: row.failureCount,
      id: row.id,
    };
  }

  public async complete(
    database: VerificationJobDatabase,
    id: string,
    attemptCount: number,
    completedAt: Date,
    applyResults: () => Promise<void>,
  ): Promise<boolean> {
    const table = this.definition.table;
    const active = await database
      .select({ id: this.definition.idColumn })
      .from(table)
      .where(and(
        eq(this.definition.idColumn, id),
        eq(table.attemptCount, attemptCount),
        eq(table.state, "running"),
      ))
      .for("update")
      .limit(1);
    if (active[0] === undefined) {
      return false;
    }

    await applyResults();
    const completed = await database
      .update(table)
      .set({
        completedAt,
        errorMessage: null,
        leaseExpiresAt: null,
        state: "completed",
        updatedAt: completedAt,
      })
      .where(and(
        eq(this.definition.idColumn, id),
        eq(table.attemptCount, attemptCount),
        eq(table.state, "running"),
      ))
      .returning({ id: this.definition.idColumn });
    if (completed[0] === undefined) {
      throw new Error(
        `${this.definition.label} verification job ${id} lost its lease.`,
      );
    }
    return true;
  }

  public async settleFailure(
    database: VerificationJobDatabase,
    id: string,
    attemptCount: number,
    error: unknown,
    retryAt: Date | null,
  ): Promise<boolean> {
    const table = this.definition.table;
    const now = new Date();
    const terminal = retryAt === null;
    const settled = await database
      .update(table)
      .set({
        availableAt: retryAt ?? now,
        completedAt: terminal ? now : null,
        errorMessage: readFailureMessage(error),
        failureCount: sql`${table.failureCount} + 1`,
        leaseExpiresAt: null,
        state: terminal ? "failed" : "pending",
        updatedAt: now,
      })
      .where(and(
        eq(this.definition.idColumn, id),
        eq(table.attemptCount, attemptCount),
        eq(table.state, "running"),
      ))
      .returning({ id: this.definition.idColumn });
    return settled[0] !== undefined;
  }

  public async release(
    database: VerificationJobDatabase,
    id: string,
    attemptCount: number,
  ): Promise<boolean> {
    const table = this.definition.table;
    const now = new Date();
    const released = await database
      .update(table)
      .set({
        availableAt: now,
        errorMessage: null,
        leaseExpiresAt: null,
        state: "pending",
        updatedAt: now,
      })
      .where(and(
        eq(this.definition.idColumn, id),
        eq(table.attemptCount, attemptCount),
        eq(table.state, "running"),
      ))
      .returning({ id: this.definition.idColumn });
    return released[0] !== undefined;
  }
}

export const chatVerificationJobQueue = new VerificationJobQueue({
  idColumn: chatVerificationJobs.assistantMessageId,
  label: "Chat",
  table: chatVerificationJobs,
});

export const researchVerificationJobQueue = new VerificationJobQueue({
  idColumn: researchVerificationJobs.turnId,
  label: "Research",
  table: researchVerificationJobs,
});

function readLeaseExpiration(currentTime: Date, verifierTimeoutMs: number): Date {
  const leaseMs = Math.max(
    MINIMUM_VERIFICATION_JOB_LEASE_MS,
    verifierTimeoutMs + 60_000,
  );
  return new Date(currentTime.getTime() + leaseMs);
}

function readFailureMessage(error: unknown): string {
  const rawMessage = error instanceof Error ? error.message : String(error);
  return rawMessage.trim().slice(0, 4_000)
    || "Automated evidence verification failed.";
}
