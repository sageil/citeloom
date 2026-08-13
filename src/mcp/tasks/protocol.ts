import {
  classifyInboundRequest,
  isJsonContentType,
} from "@modelcontextprotocol/server";
import type { FastifyReply } from "fastify";
import { z } from "zod";

import { applicationMetadata } from "../../app/application-metadata.js";
import {
  MCP_ANSWER_TOOL,
  MCP_PROTOCOL_VERSION,
} from "../contract.js";
import {
  buildCreateTaskResult,
  buildDetailedTask,
  MCP_TASK_EXTENSION_ID,
  mcpAnswerTaskRequestSchema,
  type McpTaskOwner,
  type McpTaskServices,
} from "./model.js";
import type { McpTaskDispatcher } from "./dispatcher.js";

const MCP_CLIENT_CAPABILITIES_META_KEY =
  "io.modelcontextprotocol/clientCapabilities";
const MCP_PROTOCOL_VERSION_META_KEY =
  "io.modelcontextprotocol/protocolVersion";

const jsonRpcIdSchema = z.union([
  z.string(),
  z.number().int().safe(),
]);
const extensionSettingsSchema = z.object({}).passthrough();
const clientCapabilitiesSchema = z.object({
  extensions: z.record(z.string(), extensionSettingsSchema).optional(),
}).passthrough();
const requestMetaSchema = z.object({
  [MCP_CLIENT_CAPABILITIES_META_KEY]: clientCapabilitiesSchema,
  [MCP_PROTOCOL_VERSION_META_KEY]: z.literal(MCP_PROTOCOL_VERSION),
}).passthrough();
const answerRequestSchema = z.object({
  id: jsonRpcIdSchema,
  jsonrpc: z.literal("2.0"),
  method: z.literal("tools/call"),
  params: z.object({
    _meta: requestMetaSchema,
    arguments: mcpAnswerTaskRequestSchema,
    name: z.literal(MCP_ANSWER_TOOL),
  }).strict(),
}).strict();
const getTaskRequestSchema = buildTaskRequestSchema("tasks/get", false);
const cancelTaskRequestSchema = buildTaskRequestSchema("tasks/cancel", false);
const updateTaskRequestSchema = buildTaskRequestSchema("tasks/update", true);

type McpExtensionRequest =
  | z.output<typeof answerRequestSchema>
  | z.output<typeof getTaskRequestSchema>
  | z.output<typeof cancelTaskRequestSchema>
  | z.output<typeof updateTaskRequestSchema>;

export interface McpTaskProtocolRequest {
  acceptHeader: string | string[] | undefined;
  body: unknown;
  contentTypeHeader: string | string[] | undefined;
  methodHeader: string | string[] | undefined;
  nameHeader: string | string[] | undefined;
  owner: McpTaskOwner;
  protocolVersionHeader: string | string[] | undefined;
  reply: FastifyReply;
}

export interface McpTaskProtocolOptions {
  dispatcher: McpTaskDispatcher;
  onError(error: unknown): void;
  tasks: McpTaskServices;
}

export class McpTaskProtocol {
  public constructor(private readonly options: McpTaskProtocolOptions) {}

  public canHandle(
    methodHeader: string | string[] | undefined,
    nameHeader: string | string[] | undefined,
  ): boolean {
    if (methodHeader === "tasks/get") {
      return true;
    }
    if (methodHeader === "tasks/update") {
      return true;
    }
    if (methodHeader === "tasks/cancel") {
      return true;
    }
    return methodHeader === "tools/call" && nameHeader === MCP_ANSWER_TOOL;
  }

  public async handle(request: McpTaskProtocolRequest): Promise<void> {
    const decoded = readMcpExtensionRequest(request);
    if (!decoded.success) {
      sendJsonRpcError(
        request.reply,
        decoded.id,
        decoded.statusCode,
        decoded.code,
        decoded.message,
        decoded.data,
      );
      return;
    }
    if (!hasTaskCapability(decoded.request)) {
      sendMissingCapabilityError(request.reply, decoded.request.id);
      return;
    }
    try {
      await this.dispatch(decoded.request, request.owner, request.reply);
    } catch (error: unknown) {
      this.options.onError(error);
      sendJsonRpcError(
        request.reply,
        decoded.request.id,
        200,
        -32_603,
        "Internal error",
      );
    }
  }

  private async dispatch(
    request: McpExtensionRequest,
    owner: McpTaskOwner,
    reply: FastifyReply,
  ): Promise<void> {
    if (request.method === "tools/call") {
      const task = await this.options.tasks.create(
        owner,
        request.params.arguments,
      );
      sendJsonRpcResult(reply, request.id, buildCreateTaskResult(task));
      this.options.dispatcher.enqueue(task.id);
      return;
    }
    if (request.method === "tasks/get") {
      const task = await this.options.tasks.readForOwner(
        owner,
        request.params.taskId,
      );
      if (task === null) {
        sendTaskNotFound(reply, request.id);
        return;
      }
      sendJsonRpcResult(reply, request.id, buildDetailedTask(task));
      return;
    }
    if (request.method === "tasks/cancel") {
      const found = await this.options.dispatcher.requestCancellation(
        owner,
        request.params.taskId,
      );
      if (!found) {
        sendTaskNotFound(reply, request.id);
        return;
      }
      sendJsonRpcResult(reply, request.id, { resultType: "complete" });
      return;
    }
    const task = await this.options.tasks.readForOwner(
      owner,
      request.params.taskId,
    );
    if (task === null) {
      sendTaskNotFound(reply, request.id);
      return;
    }
    sendJsonRpcResult(reply, request.id, { resultType: "complete" });
  }
}

function buildTaskRequestSchema(
  method: "tasks/get" | "tasks/update" | "tasks/cancel",
  includeInputResponses: boolean,
) {
  const taskParams = includeInputResponses
    ? z.object({
      _meta: requestMetaSchema,
      inputResponses: z.record(z.string(), z.json()),
      taskId: z.uuid(),
    }).strict()
    : z.object({
      _meta: requestMetaSchema,
      taskId: z.uuid(),
    }).strict();
  return z.object({
    id: jsonRpcIdSchema,
    jsonrpc: z.literal("2.0"),
    method: z.literal(method),
    params: taskParams,
  }).strict();
}

type McpExtensionRequestReadResult =
  | { request: McpExtensionRequest; success: true }
  | {
    code: number;
    data?: unknown;
    id: number | string | null;
    message: string;
    statusCode: number;
    success: false;
  };

function readMcpExtensionRequest(
  input: McpTaskProtocolRequest,
): McpExtensionRequestReadResult {
  const id = readJsonRpcId(input.body);
  if (!acceptsMcpResponse(input.acceptHeader)) {
    return buildReadError(
      id,
      406,
      -32_000,
      "Not Acceptable: Client must accept both application/json and text/event-stream",
    );
  }
  const contentType = typeof input.contentTypeHeader === "string"
    ? input.contentTypeHeader
    : null;
  if (!isJsonContentType(contentType)) {
    return buildReadError(
      id,
      415,
      -32_000,
      "Unsupported Media Type: Content-Type must be application/json",
    );
  }
  const classification = classifyMcpExtensionRequest(input);
  if (classification.kind === "reject") {
    return buildReadError(
      id,
      classification.httpStatus,
      classification.code,
      classification.message,
      classification.data,
    );
  }
  if (classification.kind !== "modern") {
    return buildUnsupportedProtocolVersionError(
      id,
      input.protocolVersionHeader,
    );
  }
  if (classification.messageKind !== "request") {
    return buildReadError(
      id,
      400,
      -32_600,
      "Bad Request: task methods require a JSON-RPC request.",
    );
  }
  if (input.protocolVersionHeader !== MCP_PROTOCOL_VERSION) {
    return buildUnsupportedProtocolVersionError(
      id,
      input.protocolVersionHeader,
    );
  }
  let result:
    | ReturnType<typeof answerRequestSchema.safeParse>
    | ReturnType<typeof getTaskRequestSchema.safeParse>
    | ReturnType<typeof updateTaskRequestSchema.safeParse>
    | ReturnType<typeof cancelTaskRequestSchema.safeParse>;
  if (input.methodHeader === "tools/call") {
    result = answerRequestSchema.safeParse(input.body);
  } else if (input.methodHeader === "tasks/get") {
    result = getTaskRequestSchema.safeParse(input.body);
  } else if (input.methodHeader === "tasks/update") {
    result = updateTaskRequestSchema.safeParse(input.body);
  } else if (input.methodHeader === "tasks/cancel") {
    result = cancelTaskRequestSchema.safeParse(input.body);
  } else {
    return buildReadError(id, 400, -32_600, "Invalid MCP method header.");
  }
  if (!result.success) {
    return buildReadError(id, 200, -32_602, "Invalid params");
  }
  const request = result.data as McpExtensionRequest;
  const expectedName = request.method === "tools/call"
    ? request.params.name
    : request.params.taskId;
  if (input.nameHeader !== expectedName) {
    return buildReadError(
      id,
      400,
      -32_020,
      "Bad Request: the Mcp-Name header and request body disagree.",
      {
        mismatch: {
          body: expectedName,
          header: input.nameHeader ?? "(missing)",
        },
      },
    );
  }
  return { request, success: true };
}

function classifyMcpExtensionRequest(input: McpTaskProtocolRequest) {
  const methodHeader = typeof input.methodHeader === "string"
    ? input.methodHeader
    : undefined;
  const protocolVersionHeader = typeof input.protocolVersionHeader === "string"
    ? input.protocolVersionHeader
    : undefined;
  if (methodHeader === undefined) {
    return classifyInboundRequest({
      body: input.body,
      httpMethod: "POST",
    });
  }
  if (protocolVersionHeader === undefined) {
    return classifyInboundRequest({
      body: input.body,
      httpMethod: "POST",
      mcpMethodHeader: methodHeader,
    });
  }
  return classifyInboundRequest({
    body: input.body,
    httpMethod: "POST",
    mcpMethodHeader: methodHeader,
    protocolVersionHeader,
  });
}

function buildReadError(
  id: number | string | null,
  statusCode: number,
  code: number,
  message: string,
  data?: unknown,
): McpExtensionRequestReadResult {
  if (data !== undefined) {
    return { code, data, id, message, statusCode, success: false };
  }
  return { code, id, message, statusCode, success: false };
}

function buildUnsupportedProtocolVersionError(
  id: number | string | null,
  requestedHeader: string | string[] | undefined,
): McpExtensionRequestReadResult {
  if (typeof requestedHeader === "string") {
    return buildReadError(
      id,
      400,
      -32_022,
      `Unsupported protocol version: ${requestedHeader}`,
      {
        requested: requestedHeader,
        supported: [MCP_PROTOCOL_VERSION],
      },
    );
  }
  return buildReadError(
    id,
    400,
    -32_022,
    "Unsupported protocol version: the request did not name a protocol version",
    { supported: [MCP_PROTOCOL_VERSION] },
  );
}

function acceptsMcpResponse(value: string | string[] | undefined): boolean {
  return typeof value === "string"
    && value.includes("application/json")
    && value.includes("text/event-stream");
}

function readJsonRpcId(value: unknown): number | string | null {
  const result = z.object({ id: jsonRpcIdSchema }).passthrough().safeParse(value);
  return result.success ? result.data.id : null;
}

function hasTaskCapability(request: McpExtensionRequest): boolean {
  const capabilities = request.params._meta[MCP_CLIENT_CAPABILITIES_META_KEY];
  return capabilities.extensions?.[MCP_TASK_EXTENSION_ID] !== undefined;
}

function sendMissingCapabilityError(reply: FastifyReply, id: number | string) {
  return reply
    .header("Cache-Control", "no-store")
    .status(200)
    .send({
      error: {
        code: -32_003,
        data: {
          requiredCapabilities: {
            extensions: { [MCP_TASK_EXTENSION_ID]: {} },
          },
        },
        message: "Missing required client capability",
      },
      id,
      jsonrpc: "2.0",
    });
}

function sendTaskNotFound(reply: FastifyReply, id: number | string): void {
  sendJsonRpcError(
    reply,
    id,
    200,
    -32_602,
    "Failed to retrieve task: Task not found",
  );
}

function sendJsonRpcError(
  reply: FastifyReply,
  id: number | string | null,
  statusCode: number,
  code: number,
  message: string,
  data?: unknown,
): void {
  const error = data === undefined
    ? { code, message }
    : { code, data, message };
  void reply
    .header("Cache-Control", "no-store")
    .status(statusCode)
    .send({
      error,
      id,
      jsonrpc: "2.0",
    });
}

function sendJsonRpcResult(
  reply: FastifyReply,
  id: number | string,
  result: object,
): void {
  const resultWithServerInfo = {
    ...result,
    _meta: {
      "io.modelcontextprotocol/serverInfo": {
        name: applicationMetadata.name,
        version: applicationMetadata.version,
      },
    },
  };
  void reply
    .header("Cache-Control", "no-store")
    .status(200)
    .send({ id, jsonrpc: "2.0", result: resultWithServerInfo });
}
