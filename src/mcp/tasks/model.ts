import type { ContentBlock } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  streamedAnswerSchema,
  type StreamedAnswer,
} from "../../answers/stream.js";
import { queryScopeSchema } from "../../domain/query-scope.js";

export const MCP_TASK_EXTENSION_ID = "io.modelcontextprotocol/tasks";

export const mcpAnswerTaskRequestSchema = z.object({
  question: z.string().trim().min(1).max(8_000),
  scope: queryScopeSchema,
  threadTitle: z.string().trim().min(1).max(500),
}).strict();

export const mcpTaskStatusSchema = z.enum([
  "working",
  "input_required",
  "completed",
  "cancelled",
  "failed",
]);

const mcpTextContentSchema = z.object({
  text: z.string(),
  type: z.literal("text"),
}).strict();

const mcpResourceLinkContentSchema = z.object({
  description: z.string(),
  mimeType: z.string(),
  name: z.string(),
  title: z.string(),
  type: z.literal("resource_link"),
  uri: z.string(),
}).strict();

export const mcpAnswerTaskResultSchema = z.object({
  content: z.array(z.union([
    mcpTextContentSchema,
    mcpResourceLinkContentSchema,
  ])),
  resultType: z.literal("complete"),
  structuredContent: streamedAnswerSchema,
}).strict();

export const mcpTaskErrorSchema = z.object({
  code: z.number().int(),
  message: z.string().min(1),
}).strict();

const mcpTaskBaseSchema = z.object({
  createdAt: z.iso.datetime({ offset: true }),
  lastUpdatedAt: z.iso.datetime({ offset: true }),
  statusMessage: z.string().min(1).optional(),
  taskId: z.uuid(),
  ttlMs: z.number().int().positive(),
}).strict();

export const mcpCreateTaskResultSchema = mcpTaskBaseSchema.extend({
  resultType: z.literal("task"),
  status: z.literal("working"),
}).strict();

const mcpWorkingTaskSchema = mcpTaskBaseSchema.extend({
  resultType: z.literal("complete"),
  status: z.literal("working"),
}).strict();

const mcpCompletedTaskSchema = mcpTaskBaseSchema.extend({
  result: mcpAnswerTaskResultSchema,
  resultType: z.literal("complete"),
  status: z.literal("completed"),
}).strict();

const mcpCancelledTaskSchema = mcpTaskBaseSchema.extend({
  resultType: z.literal("complete"),
  status: z.literal("cancelled"),
}).strict();

const mcpFailedTaskSchema = mcpTaskBaseSchema.extend({
  error: mcpTaskErrorSchema,
  resultType: z.literal("complete"),
  status: z.literal("failed"),
}).strict();

export const mcpDetailedTaskSchema = z.discriminatedUnion("status", [
  mcpWorkingTaskSchema,
  mcpCompletedTaskSchema,
  mcpCancelledTaskSchema,
  mcpFailedTaskSchema,
]);

export interface McpTaskOwner {
  clientId: string;
  issuer: string;
  subject: string;
  userId: string;
  workspaceId: string;
}

export type McpAnswerTaskRequest = z.output<
  typeof mcpAnswerTaskRequestSchema
>;
export type McpAnswerTaskResult = z.output<
  typeof mcpAnswerTaskResultSchema
>;
export type McpTaskError = z.output<typeof mcpTaskErrorSchema>;
export type McpTaskStatus = z.output<typeof mcpTaskStatusSchema>;

export interface McpTaskRecord {
  cancellationRequestedAt: Date | null;
  clientId: string;
  createdAt: Date;
  error: McpTaskError | null;
  expiresAt: Date;
  id: string;
  issuer: string;
  leaseExpiresAt: Date | null;
  leaseOwner: string | null;
  request: McpAnswerTaskRequest;
  result: McpAnswerTaskResult | null;
  status: McpTaskStatus;
  statusMessage: string | null;
  subject: string;
  updatedAt: Date;
  userId: string;
  workspaceId: string;
}

export interface McpTaskServices {
  cancelClaimed(taskId: string, leaseOwner: string): Promise<boolean>;
  claim(
    taskId: string,
    leaseOwner: string,
    leaseExpiresAt: Date,
  ): Promise<McpTaskRecord | null>;
  complete(
    taskId: string,
    leaseOwner: string,
    result: McpAnswerTaskResult,
  ): Promise<boolean>;
  deleteExpiredTerminalBatch(now: Date): Promise<number>;
  create(
    owner: McpTaskOwner,
    request: McpAnswerTaskRequest,
  ): Promise<McpTaskRecord>;
  fail(
    taskId: string,
    leaseOwner: string,
    error: McpTaskError,
    statusMessage: string,
  ): Promise<boolean>;
  failExpiredLeases(now: Date): Promise<number>;
  listUnclaimedTaskIds(): Promise<string[]>;
  readForOwner(
    owner: McpTaskOwner,
    taskId: string,
  ): Promise<McpTaskRecord | null>;
  renewLease(
    taskId: string,
    leaseOwner: string,
    leaseExpiresAt: Date,
  ): Promise<"active" | "cancel" | "lost">;
  requestCancellation(
    owner: McpTaskOwner,
    taskId: string,
  ): Promise<boolean>;
}

export type McpDetailedTask = z.output<typeof mcpDetailedTaskSchema>;
export type McpCreateTaskResult = z.output<typeof mcpCreateTaskResultSchema>;

export function buildMcpAnswerTaskResult(
  answer: StreamedAnswer,
  content: ContentBlock[],
): McpAnswerTaskResult {
  return mcpAnswerTaskResultSchema.parse({
    content,
    resultType: "complete",
    structuredContent: answer,
  });
}

export function buildCreateTaskResult(
  task: McpTaskRecord,
): McpCreateTaskResult {
  const result: McpCreateTaskResult = {
    createdAt: task.createdAt.toISOString(),
    lastUpdatedAt: task.updatedAt.toISOString(),
    resultType: "task",
    status: "working",
    taskId: task.id,
    ttlMs: readTaskTtlMs(task),
  };
  if (task.statusMessage !== null) {
    result.statusMessage = task.statusMessage;
  }
  return result;
}

export function buildDetailedTask(task: McpTaskRecord): McpDetailedTask {
  const base = {
    createdAt: task.createdAt.toISOString(),
    lastUpdatedAt: task.updatedAt.toISOString(),
    resultType: "complete" as const,
    taskId: task.id,
    ttlMs: readTaskTtlMs(task),
  };
  const statusMessage = task.statusMessage === null
    ? {}
    : { statusMessage: task.statusMessage };
  if (task.status === "working") {
    return { ...base, ...statusMessage, status: "working" };
  }
  if (task.status === "completed") {
    if (task.result === null) {
      throw new Error("A completed MCP task is missing its result.");
    }
    return {
      ...base,
      ...statusMessage,
      result: task.result,
      status: "completed",
    };
  }
  if (task.status === "cancelled") {
    return { ...base, ...statusMessage, status: "cancelled" };
  }
  if (task.status === "failed") {
    if (task.error === null) {
      throw new Error("A failed MCP task is missing its JSON-RPC error.");
    }
    return {
      ...base,
      ...statusMessage,
      error: task.error,
      status: "failed",
    };
  }
  throw new Error("CiteLoom ask-document tasks do not request client input.");
}

function readTaskTtlMs(task: McpTaskRecord): number {
  const ttlMs = task.expiresAt.getTime() - task.createdAt.getTime();
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("The MCP task retention period is invalid.");
  }
  return ttlMs;
}
