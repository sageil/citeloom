import { randomBytes } from "node:crypto";

import {
  Client,
  SdkError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";

import { sourceDiscoveryResponseSchema } from "../src/retrieval/discovery/boundary.js";
import {
  MCP_ANSWER_CANCEL_TOOL,
  MCP_ANSWER_STATUS_TOOL,
  MCP_ANSWER_TOOL,
  MCP_PROTOCOL_VERSION,
  MCP_SEARCH_TOOL,
} from "../src/mcp/mcp.js";
import {
  mcpAnswerHandleSchema,
  mcpAnswerStatusSchema,
  type McpAnswerHandle,
  type McpAnswerStatus,
} from "../src/mcp/tasks/model.js";
import { listenForOAuthCallback } from "./callback-server.js";
import type {
  McpClientConfig,
  McpApiKeyClientConfig,
  McpOAuthClientConfig,
} from "./config.js";
import { InMemoryMcpOAuthProvider } from "./oauth-provider.js";
import { configureTlsTrust } from "./tls-trust.js";

const MCP_SMOKE_CLIENT_INFO = {
  name: "citeloom-mcp-smoke-client",
  version: "1.1.0",
} as const;

export interface McpSmokeReport {
  answer: string;
  linkedResourcesRead: string[];
  searchDocumentCount: number;
  taskId: string;
  tools: string[];
}

export async function runMcpSmokeTest(
  config: McpClientConfig,
  options: {
    log(message: string): void;
    signal: AbortSignal;
  },
): Promise<McpSmokeReport> {
  await configureTlsTrust(config.caFile);
  const authentication = await createClientAuthentication(config, options.log);
  const client = new Client(
    MCP_SMOKE_CLIENT_INFO,
    {
      capabilities: {},
      enforceStrictCapabilities: true,
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    },
  );
  try {
    await authentication.connect(client);
    options.log(`Connected with MCP protocol ${MCP_PROTOCOL_VERSION}.`);
    const listedTools = await client.listTools(undefined, { cacheMode: "bypass" });
    const tools = listedTools.tools.map((tool) => tool.name).sort();
    requireTool(tools, MCP_SEARCH_TOOL);
    requireTool(tools, MCP_ANSWER_TOOL);
    requireTool(tools, MCP_ANSWER_STATUS_TOOL);
    requireTool(tools, MCP_ANSWER_CANCEL_TOOL);
    options.log(`Discovered tools: ${tools.join(", ")}.`);

    const searchCall = await client.callTool({
      arguments: {
        includeRelated: false,
        keywordPage: 1,
        query: config.question,
        scope: { kind: "all" },
      },
      name: MCP_SEARCH_TOOL,
    }, { signal: options.signal });
    if (searchCall.isError === true) {
      throw new Error("The MCP source search tool returned an error.");
    }
    const search = sourceDiscoveryResponseSchema.parse(
      searchCall.structuredContent,
    );
    const searchDocumentCount = search.results.kind === "exact"
      ? search.results.totalDocuments
      : search.results.exact.totalDocuments;
    options.log(`Source search returned ${searchDocumentCount} document(s).`);

    const answerCall = await client.callTool({
      arguments: {
        question: config.question,
        scope: { kind: "all" },
        threadTitle: `MCP smoke test: ${config.question.slice(0, 450)}`,
      },
      name: MCP_ANSWER_TOOL,
    }, { signal: options.signal });
    if (answerCall.isError === true) {
      throw new Error("The MCP answer tool returned an error.");
    }
    const createdTask = mcpAnswerHandleSchema.parse(
      answerCall.structuredContent,
    );
    options.log(`Created asynchronous answer task ${createdTask.taskId}.`);
    const completedTask = await waitForCoreAnswer(client, createdTask, {
      log: options.log,
      pollIntervalMs: config.pollIntervalMs,
      signal: options.signal,
      timeoutMs: config.timeoutMs,
    });

    const linkedResourcesRead: string[] = [];
    for (const content of completedTask.resources) {
      const resource = await client.readResource(
        { uri: content.uri },
        { cacheMode: "bypass", signal: options.signal },
      );
      if (resource.contents.length === 0) {
        throw new Error(`The MCP resource ${content.uri} returned no content.`);
      }
      linkedResourcesRead.push(content.uri);
    }
    options.log(`Read ${linkedResourcesRead.length} linked MCP resource(s).`);

    return {
      answer: completedTask.answer.answerDocument.content,
      linkedResourcesRead,
      searchDocumentCount,
      taskId: completedTask.taskId,
      tools,
    };
  } finally {
    await authentication.close().catch(() => undefined);
    await client.close().catch(() => undefined);
  }
}

type CompletedMcpAnswerStatus = Extract<
  McpAnswerStatus,
  { status: "completed" }
>;

async function waitForCoreAnswer(
  client: Client,
  handle: McpAnswerHandle,
  options: {
    log(message: string): void;
    pollIntervalMs: number;
    signal: AbortSignal;
    timeoutMs: number;
  },
): Promise<CompletedMcpAnswerStatus> {
  const deadline = Date.now() + options.timeoutMs;
  let lastUpdatedAt = "";
  let status: McpAnswerStatus = handle;
  while (status.status === "working") {
    if (Date.now() >= deadline) {
      throw new Error(`MCP answer task ${handle.taskId} timed out.`);
    }
    const pollIntervalMs = Math.max(
      options.pollIntervalMs,
      status.pollIntervalMs,
    );
    await waitForPollInterval(pollIntervalMs, options.signal);
    const statusCall = await client.callTool({
      arguments: { taskId: handle.taskId },
      name: MCP_ANSWER_STATUS_TOOL,
    }, { signal: options.signal });
    if (statusCall.isError === true) {
      throw new Error(`MCP answer task ${handle.taskId} could not be read.`);
    }
    status = mcpAnswerStatusSchema.parse(statusCall.structuredContent);
    if (status.lastUpdatedAt !== lastUpdatedAt) {
      lastUpdatedAt = status.lastUpdatedAt;
      options.log(`Task ${status.taskId}: ${status.status}.`);
    }
  }
  if (status.status === "completed") {
    return status;
  }
  if (status.status === "failed") {
    throw new Error(
      `MCP answer task ${status.taskId} failed: ${status.error.message}`,
    );
  }
  throw new Error(`MCP answer task ${status.taskId} was cancelled.`);
}

function waitForPollInterval(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(readAbortReason(signal));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      reject(readAbortReason(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function readAbortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The MCP smoke test was cancelled.");
}

interface McpClientAuthentication {
  close(): Promise<void>;
  connect(client: Client): Promise<void>;
}

async function createClientAuthentication(
  config: McpClientConfig,
  log: (message: string) => void,
): Promise<McpClientAuthentication> {
  if (isApiKeyConfig(config)) {
    return {
      close: async () => undefined,
      connect: async (client) => {
        await client.connect(createTransport(config));
      },
    };
  }
  const oauthState = randomBytes(32).toString("base64url");
  const callbackListener = await listenForOAuthCallback(
    config.authentication.callbackUrl,
    oauthState,
    config.timeoutMs,
  );
  const provider = new InMemoryMcpOAuthProvider(
    config.authentication.clientId,
    config.authentication.callbackUrl,
    oauthState,
    (authorizationUrl) => {
      log("Authorize the MCP client in your browser:");
      log(authorizationUrl.toString());
    },
  );
  return {
    close: () => callbackListener.close(),
    connect: (client) => connectWithOAuth(
      client,
      provider,
      config,
      callbackListener.callback,
    ),
  };
}

async function connectWithOAuth(
  client: Client,
  provider: InMemoryMcpOAuthProvider,
  config: McpOAuthClientConfig,
  callback: Promise<URLSearchParams>,
): Promise<void> {
  const firstTransport = createTransport(config, provider);
  try {
    await client.connect(firstTransport);
    return;
  } catch (error: unknown) {
    if (!containsUnauthorizedError(error)) {
      throw error;
    }
  }
  const callbackParameters = await callback;
  await firstTransport.finishAuth(callbackParameters);
  const authenticatedTransport = createTransport(config, provider);
  await client.connect(authenticatedTransport);
}

function createTransport(
  config: McpClientConfig,
  provider?: InMemoryMcpOAuthProvider,
): StreamableHTTPClientTransport {
  if (isApiKeyConfig(config)) {
    return new StreamableHTTPClientTransport(new URL(config.serverUrl), {
      authProvider: { token: async () => config.authentication.apiKey },
    });
  }
  if (provider === undefined) {
    throw new Error("The MCP OAuth provider is unavailable.");
  }
  return new StreamableHTTPClientTransport(new URL(config.serverUrl), {
    authProvider: provider,
  });
}

function isApiKeyConfig(
  config: McpClientConfig,
): config is McpApiKeyClientConfig {
  return config.authentication.kind === "api-key";
}

function containsUnauthorizedError(error: unknown): boolean {
  if (error instanceof UnauthorizedError) {
    return true;
  }
  if (error instanceof SdkError) {
    return containsUnauthorizedError(readSdkErrorCause(error));
  }
  if (error instanceof Error && error.cause !== undefined) {
    return containsUnauthorizedError(error.cause);
  }
  return false;
}

function readSdkErrorCause(error: SdkError): unknown {
  const data = error.data;
  if (typeof data !== "object" || data === null || !("cause" in data)) {
    return undefined;
  }
  return data.cause;
}

function requireTool(tools: readonly string[], tool: string): void {
  if (!tools.includes(tool)) {
    throw new Error(`The MCP credential does not expose the required tool ${tool}.`);
  }
}
