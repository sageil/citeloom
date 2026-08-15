import type { ContentBlock } from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  streamedAnswerSchema,
} from "../../answers/stream.js";
import { queryScopeSchema } from "../../domain/query-scope.js";

export const MCP_ANSWER_POLL_INTERVAL_MS = 1_000;

export const mcpAnswerTaskRequestSchema = z.object({
  question: z.string().trim().min(1).max(8_000).describe(
    "Question CiteLoom should answer from authorized documents in every available workspace.",
  ),
  scope: queryScopeSchema,
  threadTitle: z.string().trim().min(1).max(500).describe(
    "Title for the durable CiteLoom research thread that will store this cited answer.",
  ),
}).strict().describe(
  "A durable request for a cited answer from authorized CiteLoom documents.",
);

export const mcpTaskStatusSchema = z.enum([
  "working",
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
  answer: streamedAnswerSchema,
  content: z.array(z.union([
    mcpTextContentSchema,
    mcpResourceLinkContentSchema,
  ])),
  resultType: z.literal("complete"),
  workspaceIds: z.array(z.uuid()).min(1),
}).strict();

export const mcpTaskErrorSchema = z.object({
  code: z.number().int(),
  message: z.string().min(1),
}).strict();

const mcpAnswerStatusBaseSchema = z.object({
  createdAt: z.iso.datetime({ offset: true }),
  expiresAt: z.iso.datetime({ offset: true }),
  lastUpdatedAt: z.iso.datetime({ offset: true }),
  pollIntervalMs: z.number().int().positive(),
  statusMessage: z.string().min(1).optional(),
  taskId: z.uuid(),
}).strict();

export const mcpAnswerHandleSchema = mcpAnswerStatusBaseSchema.extend({
  status: z.literal("working"),
}).strict();

const mcpWorkingAnswerStatusSchema = mcpAnswerStatusBaseSchema.extend({
  status: z.literal("working"),
}).strict();

const mcpCompletedAnswerStatusSchema = mcpAnswerStatusBaseSchema.extend({
  answer: streamedAnswerSchema,
  resources: z.array(mcpResourceLinkContentSchema),
  status: z.literal("completed"),
  workspaceIds: z.array(z.uuid()).min(1),
}).strict();

const mcpCancelledAnswerStatusSchema = mcpAnswerStatusBaseSchema.extend({
  status: z.literal("cancelled"),
}).strict();

const mcpFailedAnswerStatusSchema = mcpAnswerStatusBaseSchema.extend({
  error: mcpTaskErrorSchema,
  status: z.literal("failed"),
}).strict();

export const mcpAnswerStatusSchema = z.discriminatedUnion("status", [
  mcpWorkingAnswerStatusSchema,
  mcpCompletedAnswerStatusSchema,
  mcpCancelledAnswerStatusSchema,
  mcpFailedAnswerStatusSchema,
]);

export const mcpAnswerCancellationSchema = z.object({
  cancellationRequested: z.literal(true),
  taskId: z.uuid(),
}).strict();

export interface McpTaskOwner {
  clientId: string;
  issuer: string;
  subject: string;
  userId: string;
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

export type McpAnswerHandle = z.output<typeof mcpAnswerHandleSchema>;
export type McpAnswerStatus = z.output<typeof mcpAnswerStatusSchema>;
export type McpAnswerCancellation = z.output<
  typeof mcpAnswerCancellationSchema
>;

export function buildMcpAnswerTaskResult(
  answer: z.output<typeof streamedAnswerSchema>,
  content: ContentBlock[],
  workspaceIds: readonly string[],
): McpAnswerTaskResult {
  return mcpAnswerTaskResultSchema.parse({
    answer,
    content,
    resultType: "complete",
    workspaceIds,
  });
}

export function buildMcpAnswerHandle(
  task: McpTaskRecord,
): McpAnswerHandle {
  const result: McpAnswerHandle = {
    createdAt: task.createdAt.toISOString(),
    expiresAt: task.expiresAt.toISOString(),
    lastUpdatedAt: task.updatedAt.toISOString(),
    pollIntervalMs: MCP_ANSWER_POLL_INTERVAL_MS,
    status: "working",
    taskId: task.id,
  };
  if (task.statusMessage !== null) {
    result.statusMessage = task.statusMessage;
  }
  return result;
}

export function buildMcpAnswerStatus(
  task: McpTaskRecord,
  availableWorkspaceIds: ReadonlySet<string>,
): McpAnswerStatus {
  const base: {
    createdAt: string;
    expiresAt: string;
    lastUpdatedAt: string;
    pollIntervalMs: number;
    statusMessage?: string;
    taskId: string;
  } = {
    createdAt: task.createdAt.toISOString(),
    expiresAt: task.expiresAt.toISOString(),
    lastUpdatedAt: task.updatedAt.toISOString(),
    pollIntervalMs: MCP_ANSWER_POLL_INTERVAL_MS,
    taskId: task.id,
  };
  if (task.statusMessage !== null) {
    base.statusMessage = task.statusMessage;
  }
  if (task.status === "working") {
    return { ...base, status: "working" };
  }
  if (task.status === "completed") {
    if (task.result === null) {
      throw new Error("A completed MCP task is missing its result.");
    }
    const unavailableWorkspace = task.result.workspaceIds.some((workspaceId) => {
      return !availableWorkspaceIds.has(workspaceId);
    });
    if (unavailableWorkspace) {
      return {
        ...base,
        error: {
          code: -32_003,
          message: "This answer used a workspace that is no longer available to this user.",
        },
        status: "failed",
      };
    }
    const resources: z.output<typeof mcpResourceLinkContentSchema>[] = [];
    for (const content of task.result.content) {
      if (
        content.type === "resource_link"
      ) {
        resources.push(content);
      }
    }
    return {
      ...base,
      answer: task.result.answer,
      resources,
      status: "completed",
      workspaceIds: task.result.workspaceIds,
    };
  }
  if (task.status === "cancelled") {
    return { ...base, status: "cancelled" };
  }
  if (task.status === "failed") {
    if (task.error === null) {
      throw new Error("A failed MCP task is missing its JSON-RPC error.");
    }
    return { ...base, error: task.error, status: "failed" };
  }
  throw new Error("The MCP task status is invalid.");
}
