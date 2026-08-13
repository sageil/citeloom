import type { FetchLike } from "@modelcontextprotocol/client";
import { z } from "zod";

import {
  MCP_ANSWER_TOOL,
  MCP_PROTOCOL_VERSION,
  MCP_WORKSPACE_NAME_HEADER,
} from "../src/mcp/contract.js";
import {
  mcpCreateTaskResultSchema,
  mcpDetailedTaskSchema,
  type McpAnswerTaskRequest,
  type McpCreateTaskResult,
  type McpDetailedTask,
} from "../src/mcp/tasks/model.js";
import { buildMcpSmokeRequestMeta } from "./protocol.js";

const jsonRpcIdSchema = z.number().int().positive();
const jsonRpcResultResponseSchema = z.object({
  id: jsonRpcIdSchema,
  jsonrpc: z.literal("2.0"),
  result: z.unknown(),
}).strict();
const jsonRpcErrorResponseSchema = z.object({
  error: z.object({
    code: z.number().int(),
    message: z.string().min(1),
  }).passthrough(),
  id: jsonRpcIdSchema.nullable(),
  jsonrpc: z.literal("2.0"),
}).strict();
const jsonRpcResponseSchema = z.union([
  jsonRpcResultResponseSchema,
  jsonRpcErrorResponseSchema,
]);
const taskWireResultSchema = z.object({
  _meta: z.object({
    "io.modelcontextprotocol/serverInfo": z.object({
      name: z.string().min(1),
      version: z.string().min(1),
    }).strict(),
  }).passthrough(),
}).passthrough();

export interface McpAccessTokenProvider {
  accessToken(): string;
}

export class McpTaskExtensionClient {
  private requestId = 1;

  public constructor(
    private readonly options: {
      fetchImplementation?: FetchLike;
      serverUrl: string;
      tokenProvider: McpAccessTokenProvider;
      workspaceName: string | null;
    },
  ) {}

  public createAnswerTask(
    request: McpAnswerTaskRequest,
    signal: AbortSignal,
  ): Promise<McpCreateTaskResult> {
    return this.send(
      "tools/call",
      MCP_ANSWER_TOOL,
      {
        arguments: request,
        name: MCP_ANSWER_TOOL,
      },
      mcpCreateTaskResultSchema,
      signal,
    );
  }

  public readTask(
    taskId: string,
    signal: AbortSignal,
  ): Promise<McpDetailedTask> {
    return this.send(
      "tasks/get",
      taskId,
      { taskId },
      mcpDetailedTaskSchema,
      signal,
    );
  }

  private async send<T>(
    method: "tools/call" | "tasks/get",
    name: string,
    params: object,
    resultSchema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const id = this.requestId;
    this.requestId += 1;
    const body = {
      id,
      jsonrpc: "2.0" as const,
      method,
      params: {
        ...params,
        _meta: buildMcpSmokeRequestMeta(MCP_PROTOCOL_VERSION),
      },
    };
    const headers = new Headers({
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.options.tokenProvider.accessToken()}`,
      "content-type": "application/json",
      "mcp-method": method,
      "mcp-name": name,
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
    });
    if (this.options.workspaceName !== null) {
      headers.set(MCP_WORKSPACE_NAME_HEADER, this.options.workspaceName);
    }
    const fetchImplementation = this.options.fetchImplementation ?? fetch;
    const response = await fetchImplementation(this.options.serverUrl, {
      body: JSON.stringify(body),
      headers,
      method: "POST",
      signal,
    });
    if (!response.ok) {
      throw new Error(
        `The MCP task request failed with HTTP status ${response.status}.`,
      );
    }
    const value: unknown = await response.json();
    const envelope = jsonRpcResponseSchema.parse(value);
    if (envelope.id !== id) {
      throw new Error("The MCP task response ID does not match its request.");
    }
    if ("error" in envelope) {
      throw new Error(
        `MCP task request failed (${envelope.error.code}): ${envelope.error.message}`,
      );
    }
    const wireResult = taskWireResultSchema.parse(envelope.result);
    const { _meta: _serverMetadata, ...taskResult } = wireResult;
    return resultSchema.parse(taskResult);
  }
}
