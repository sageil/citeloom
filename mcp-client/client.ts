import { randomBytes } from "node:crypto";

import {
  Client,
  SdkError,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from "@modelcontextprotocol/client";

import { sourceDiscoveryResponseSchema } from "../src/retrieval/discovery/schema.js";
import {
  MCP_ANSWER_TOOL,
  MCP_PROTOCOL_VERSION,
  MCP_SEARCH_TOOL,
} from "../src/mcp/contract.js";
import { MCP_TASK_EXTENSION_ID } from "../src/mcp/tasks/model.js";
import { listenForOAuthCallback } from "./callback-server.js";
import type {
  McpClientConfig,
  McpApiKeyClientConfig,
  McpOAuthClientConfig,
} from "./config.js";
import { InMemoryMcpOAuthProvider } from "./oauth-provider.js";
import {
  buildMcpSmokeClientCapabilities,
  MCP_SMOKE_CLIENT_INFO,
} from "./protocol.js";
import { createMcpRequestFetch } from "./request-fetch.js";
import { McpTaskExtensionClient } from "./task-client.js";
import { waitForAnswerTask } from "./task-extension.js";
import { configureTlsTrust } from "./tls-trust.js";

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
      capabilities: buildMcpSmokeClientCapabilities(),
      enforceStrictCapabilities: true,
      versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } },
    },
  );
  try {
    await authentication.connect(client);
    options.log(`Connected with MCP protocol ${MCP_PROTOCOL_VERSION}.`);
    const discovery = client.getDiscoverResult();
    if (discovery?.capabilities.extensions?.[MCP_TASK_EXTENSION_ID] === undefined) {
      throw new Error(
        `The server did not advertise ${MCP_TASK_EXTENSION_ID}.`,
      );
    }

    const listedTools = await client.listTools(undefined, { cacheMode: "bypass" });
    const tools = listedTools.tools.map((tool) => tool.name).sort();
    requireTool(tools, MCP_SEARCH_TOOL);
    requireTool(tools, MCP_ANSWER_TOOL);
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

    const taskClient = new McpTaskExtensionClient({
      serverUrl: config.serverUrl,
      tokenProvider: authentication.tokenProvider,
      workspaceName: config.workspaceName,
    });
    const createdTask = await taskClient.createAnswerTask(
      {
        question: config.question,
        scope: { kind: "all" },
        threadTitle: `MCP smoke test: ${config.question.slice(0, 450)}`,
      },
      options.signal,
    );
    options.log(`Created asynchronous answer task ${createdTask.taskId}.`);
    let lastTaskUpdate = "";
    const completedTask = await waitForAnswerTask(taskClient, createdTask.taskId, {
      onStatus: (task) => {
        if (task.lastUpdatedAt === lastTaskUpdate) {
          return;
        }
        lastTaskUpdate = task.lastUpdatedAt;
        options.log(`Task ${task.taskId}: ${task.status}.`);
      },
      pollIntervalMs: config.pollIntervalMs,
      signal: options.signal,
      timeoutMs: config.timeoutMs,
    });

    const linkedResourcesRead: string[] = [];
    for (const content of completedTask.result.content) {
      if (content.type !== "resource_link") {
        continue;
      }
      const resource = await client.readResource(
        { uri: content.uri },
        { cacheMode: "bypass", signal: options.signal },
      );
      if (resource.contents.length === 0) {
        throw new Error(`The MCP resource ${content.uri} returned no content.`);
      }
      linkedResourcesRead.push(content.uri);
    }
    if (linkedResourcesRead.length === 0) {
      throw new Error("The completed MCP answer returned no linked resources.");
    }
    options.log(`Read ${linkedResourcesRead.length} linked MCP resource(s).`);

    return {
      answer: completedTask.result.structuredContent.answerDocument.content,
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

interface McpClientAuthentication {
  close(): Promise<void>;
  connect(client: Client): Promise<void>;
  tokenProvider: { accessToken(): string };
}

async function createClientAuthentication(
  config: McpClientConfig,
  log: (message: string) => void,
): Promise<McpClientAuthentication> {
  if (isApiKeyConfig(config)) {
    const apiKey = config.authentication.apiKey;
    return {
      close: async () => undefined,
      connect: async (client) => {
        await client.connect(createTransport(config));
      },
      tokenProvider: { accessToken: () => apiKey },
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
    tokenProvider: provider,
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
      fetch: createMcpRequestFetch(config.serverUrl, config.workspaceName),
    });
  }
  if (provider === undefined) {
    throw new Error("The MCP OAuth provider is unavailable.");
  }
  return new StreamableHTTPClientTransport(new URL(config.serverUrl), {
    authProvider: provider,
    fetch: createMcpRequestFetch(config.serverUrl, config.workspaceName),
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
