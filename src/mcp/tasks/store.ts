import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
} from "drizzle-orm";
import { z } from "zod";

import type { CiteLoomDatabase } from "../../database/client.js";
import { mcpTasks } from "../../database/schema.js";
import {
  mcpAnswerTaskRequestSchema,
  mcpAnswerTaskResultSchema,
  mcpTaskErrorSchema,
  mcpTaskStatusSchema,
  type McpAnswerTaskRequest,
  type McpAnswerTaskResult,
  type McpTaskError,
  type McpTaskOwner,
  type McpTaskRecord,
} from "./model.js";

const mcpTaskRowSchema = z.object({
  cancellationRequestedAt: z.date().nullable(),
  clientId: z.string().min(1),
  createdAt: z.date(),
  error: mcpTaskErrorSchema.nullable(),
  expiresAt: z.date(),
  id: z.uuid(),
  issuer: z.string().min(1),
  leaseExpiresAt: z.date().nullable(),
  leaseOwner: z.uuid().nullable(),
  request: mcpAnswerTaskRequestSchema,
  result: mcpAnswerTaskResultSchema.nullable(),
  status: mcpTaskStatusSchema,
  statusMessage: z.string().nullable(),
  subject: z.string().min(1),
  updatedAt: z.date(),
  userId: z.uuid(),
  workspaceId: z.uuid(),
}).strict();

export class McpTaskStore {
  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly taskRetentionMs: number,
  ) {
    if (!Number.isSafeInteger(taskRetentionMs) || taskRetentionMs <= 0) {
      throw new Error("MCP task retention must be a positive safe integer.");
    }
  }

  public async create(
    owner: McpTaskOwner,
    request: McpAnswerTaskRequest,
  ): Promise<McpTaskRecord> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.taskRetentionMs);
    const rows = await this.database
      .insert(mcpTasks)
      .values({
        clientId: owner.clientId,
        createdAt: now,
        expiresAt,
        id: randomUUID(),
        issuer: owner.issuer,
        request,
        status: "working",
        subject: owner.subject,
        updatedAt: now,
        userId: owner.userId,
        workspaceId: owner.workspaceId,
      })
      .returning();
    return readMcpTaskRow(rows[0]);
  }

  public async readForOwner(
    owner: McpTaskOwner,
    taskId: string,
  ): Promise<McpTaskRecord | null> {
    const rows = await this.database
      .select()
      .from(mcpTasks)
      .where(and(
        eq(mcpTasks.id, taskId),
        eq(mcpTasks.issuer, owner.issuer),
        eq(mcpTasks.subject, owner.subject),
        eq(mcpTasks.userId, owner.userId),
        eq(mcpTasks.workspaceId, owner.workspaceId),
      ))
      .limit(1);
    return rows[0] === undefined ? null : readMcpTaskRow(rows[0]);
  }

  public async deleteExpiredTerminalBatch(
    now: Date,
    batchSize: number = 500,
  ): Promise<number> {
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new Error("MCP task retention batch size must be a positive safe integer.");
    }
    return this.database.transaction(async (transaction) => {
      const candidates = await transaction
        .select({ id: mcpTasks.id })
        .from(mcpTasks)
        .where(and(
          inArray(mcpTasks.status, ["completed", "failed", "cancelled"]),
          lte(mcpTasks.expiresAt, now),
        ))
        .orderBy(asc(mcpTasks.expiresAt), asc(mcpTasks.id))
        .limit(batchSize)
        .for("update", { skipLocked: true });
      if (candidates.length === 0) {
        return 0;
      }
      const ids: string[] = [];
      for (const candidate of candidates) {
        ids.push(candidate.id);
      }
      const deletedRows = await transaction
        .delete(mcpTasks)
        .where(inArray(mcpTasks.id, ids))
        .returning({ id: mcpTasks.id });
      return deletedRows.length;
    });
  }

  public async claim(
    taskId: string,
    leaseOwner: string,
    leaseExpiresAt: Date,
  ): Promise<McpTaskRecord | null> {
    const rows = await this.database
      .update(mcpTasks)
      .set({ leaseExpiresAt, leaseOwner })
      .where(and(
        eq(mcpTasks.id, taskId),
        eq(mcpTasks.status, "working"),
        isNull(mcpTasks.cancellationRequestedAt),
        isNull(mcpTasks.leaseOwner),
      ))
      .returning();
    return rows[0] === undefined ? null : readMcpTaskRow(rows[0]);
  }

  public async renewLease(
    taskId: string,
    leaseOwner: string,
    leaseExpiresAt: Date,
  ): Promise<"active" | "cancel" | "lost"> {
    const rows = await this.database
      .update(mcpTasks)
      .set({ leaseExpiresAt })
      .where(and(
        eq(mcpTasks.id, taskId),
        eq(mcpTasks.status, "working"),
        eq(mcpTasks.leaseOwner, leaseOwner),
      ))
      .returning({
        cancellationRequestedAt: mcpTasks.cancellationRequestedAt,
      });
    const row = rows[0];
    if (row === undefined) {
      return "lost";
    }
    return row.cancellationRequestedAt === null ? "active" : "cancel";
  }

  public async complete(
    taskId: string,
    leaseOwner: string,
    result: McpAnswerTaskResult,
  ): Promise<boolean> {
    const rows = await this.database
      .update(mcpTasks)
      .set({
        cancellationRequestedAt: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        result,
        status: "completed",
        statusMessage: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(mcpTasks.id, taskId),
        eq(mcpTasks.status, "working"),
        eq(mcpTasks.leaseOwner, leaseOwner),
      ))
      .returning({ id: mcpTasks.id });
    return rows.length === 1;
  }

  public async fail(
    taskId: string,
    leaseOwner: string,
    error: McpTaskError,
    statusMessage: string,
  ): Promise<boolean> {
    const rows = await this.database
      .update(mcpTasks)
      .set({
        cancellationRequestedAt: null,
        error,
        leaseExpiresAt: null,
        leaseOwner: null,
        status: "failed",
        statusMessage,
        updatedAt: new Date(),
      })
      .where(and(
        eq(mcpTasks.id, taskId),
        eq(mcpTasks.status, "working"),
        eq(mcpTasks.leaseOwner, leaseOwner),
      ))
      .returning({ id: mcpTasks.id });
    return rows.length === 1;
  }

  public async cancelClaimed(
    taskId: string,
    leaseOwner: string,
  ): Promise<boolean> {
    const rows = await this.database
      .update(mcpTasks)
      .set({
        cancellationRequestedAt: null,
        leaseExpiresAt: null,
        leaseOwner: null,
        status: "cancelled",
        statusMessage: "The task was cancelled.",
        updatedAt: new Date(),
      })
      .where(and(
        eq(mcpTasks.id, taskId),
        eq(mcpTasks.status, "working"),
        eq(mcpTasks.leaseOwner, leaseOwner),
      ))
      .returning({ id: mcpTasks.id });
    return rows.length === 1;
  }

  public async requestCancellation(
    owner: McpTaskOwner,
    taskId: string,
  ): Promise<boolean> {
    const now = new Date();
    const cancelledRows = await this.database
      .update(mcpTasks)
      .set({
        status: "cancelled",
        statusMessage: "The task was cancelled.",
        updatedAt: now,
      })
      .where(and(
        ...buildOwnerConditions(owner, taskId),
        eq(mcpTasks.status, "working"),
        isNull(mcpTasks.leaseOwner),
      ))
      .returning({ id: mcpTasks.id });
    if (cancelledRows.length === 1) {
      return true;
    }
    const requestedRows = await this.database
      .update(mcpTasks)
      .set({ cancellationRequestedAt: now })
      .where(and(
        ...buildOwnerConditions(owner, taskId),
        eq(mcpTasks.status, "working"),
        isNotNull(mcpTasks.leaseOwner),
      ))
      .returning({ id: mcpTasks.id });
    if (requestedRows.length === 1) {
      return true;
    }
    return await this.readForOwner(owner, taskId) !== null;
  }

  public async listUnclaimedTaskIds(): Promise<string[]> {
    const rows = await this.database
      .select({ id: mcpTasks.id })
      .from(mcpTasks)
      .where(and(
        eq(mcpTasks.status, "working"),
        isNull(mcpTasks.cancellationRequestedAt),
        isNull(mcpTasks.leaseOwner),
      ))
      .orderBy(asc(mcpTasks.createdAt), asc(mcpTasks.id));
    const ids: string[] = [];
    for (const row of rows) {
      ids.push(z.uuid().parse(row.id));
    }
    return ids;
  }

  public async failExpiredLeases(now: Date): Promise<number> {
    const rows = await this.database
      .update(mcpTasks)
      .set({
        cancellationRequestedAt: null,
        error: {
          code: -32603,
          message: "Task execution was interrupted.",
        },
        leaseExpiresAt: null,
        leaseOwner: null,
        status: "failed",
        statusMessage: "Task execution was interrupted.",
        updatedAt: now,
      })
      .where(and(
        eq(mcpTasks.status, "working"),
        isNotNull(mcpTasks.leaseOwner),
        lte(mcpTasks.leaseExpiresAt, now),
      ))
      .returning({ id: mcpTasks.id });
    return rows.length;
  }
}

function buildOwnerConditions(owner: McpTaskOwner, taskId: string) {
  return [
    eq(mcpTasks.id, taskId),
    eq(mcpTasks.issuer, owner.issuer),
    eq(mcpTasks.subject, owner.subject),
    eq(mcpTasks.userId, owner.userId),
    eq(mcpTasks.workspaceId, owner.workspaceId),
  ];
}

function readMcpTaskRow(value: unknown): McpTaskRecord {
  return mcpTaskRowSchema.parse(value);
}
