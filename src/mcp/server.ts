import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
  type AuthInfo,
  type ServerCapabilities,
} from "@modelcontextprotocol/server";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { streamedAnswerSchema } from "../answers/stream.js";
import { decodeWorkspaceName } from "../auth/boundary.js";
import {
  globalRoleSchema,
  workspaceRoleSchema,
  type AuthorizationPrincipal,
} from "../auth/model.js";
import {
  OAuthAccessTokenRejectedError,
  OAuthInsufficientScopeError,
  readOAuthBearerToken,
} from "../oauth/access-token.js";
import { OAUTH_MCP_RESOURCE_PATH } from "../oauth/application-configuration.js";
import { OAuthIdentityUnavailableError } from "../oauth/principal-store.js";
import { buildProtectedResourceMetadataPath } from "../oauth/protected-resource.js";
import { hasMcpApiKeyPrefix } from "./api-key-boundary.js";
import {
  McpApiKeyInsufficientScopeError,
  McpApiKeyRejectedError,
} from "./api-key-store.js";
import {
  sourceDiscoveryRequestSchema,
  sourceDiscoveryResponseSchema,
} from "../retrieval/discovery/schema.js";
import {
  SourceDiscoveryScopeError,
  SourceDiscoveryUnavailableError,
} from "../retrieval/discovery/pipeline.js";
import type {
  ApplicationOAuthRequestAuthenticator,
} from "../api/application-authentication.js";
import type { WebConfig } from "../api/config.js";
import type { WebServices } from "../api/services.js";
import { applicationMetadata } from "../app/application-metadata.js";
import {
  MCP_ANSWER_SCOPE,
  MCP_ANSWER_PROMPT,
  MCP_API_KEY_TASK_ISSUER,
  MCP_ANSWER_TOOL,
  MCP_CITATION_RESOURCE_TEMPLATE,
  MCP_SEARCH_PROMPT,
  MCP_SEARCH_SCOPE,
  MCP_SEARCH_TOOL,
  MCP_SERVER_DESCRIPTION,
  MCP_SERVER_TITLE,
  MCP_THREAD_RESOURCE_TEMPLATE,
  MCP_WORKSPACE_CONTEXT_RESOURCE,
  MCP_WORKSPACE_NAME_HEADER,
} from "./contract.js";
import {
  buildMcpAnswerPrompt,
  buildMcpSearchPrompt,
  buildMcpServerInstructions,
} from "./guidance.js";
import { McpTaskDispatcher } from "./tasks/dispatcher.js";
import {
  MCP_TASK_EXTENSION_ID,
  mcpAnswerTaskRequestSchema,
  type McpTaskOwner,
} from "./tasks/model.js";
import { McpTaskProtocol } from "./tasks/protocol.js";

const mcpPrincipalSchema = z.object({
  dataScope: z.enum(["all", "workspace"]),
  displayName: z.string().min(1),
  globalRole: globalRoleSchema,
  role: workspaceRoleSchema,
  userId: z.uuid(),
  username: z.string().min(1),
  workspaceId: z.uuid(),
  workspaceName: z.string().min(1),
}).strict();

const mcpSearchPromptArgumentsSchema = sourceDiscoveryRequestSchema.pick({
  query: true,
}).describe(
  "Arguments for a source-search workflow in the selected CiteLoom workspace.",
);

const mcpAnswerPromptArgumentsSchema = mcpAnswerTaskRequestSchema.pick({
  question: true,
  threadTitle: true,
}).describe(
  "Arguments for a durable cited-answer workflow using the MCP Tasks extension.",
);

class McpWorkspaceSelectorError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "McpWorkspaceSelectorError";
  }
}

export interface McpRouteOptions {
  oauthAuthenticator: ApplicationOAuthRequestAuthenticator;
  services: WebServices;
  webConfig: WebConfig;
}

export function registerMcpRoutes(
  server: FastifyInstance,
  options: McpRouteOptions,
): Promise<void> {
  const reportTaskError = (error: unknown): void => {
    server.log.error(error, "MCP task operation failed.");
  };
  const dispatcher = new McpTaskDispatcher({
    onError: reportTaskError,
    publicOrigin: options.webConfig.publicOrigin,
    services: options.services,
    tasks: options.services.mcpTasks,
  });
  const taskProtocol = new McpTaskProtocol({
    dispatcher,
    onError: reportTaskError,
    tasks: options.services.mcpTasks,
  });
  const handler = createMcpHandler((context) => {
    const principal = readMcpPrincipal(context.authInfo);
    return createCiteLoomMcpServer(
      principal,
      context.authInfo?.scopes ?? [],
      options.services,
      options.webConfig.publicOrigin,
    );
  }, {
    legacy: "reject",
    onerror: (error) => server.log.error(error, "MCP request failed."),
    responseMode: "auto",
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => server.log.error(error, "MCP adapter failed."),
  });
  server.addHook("onClose", async () => {
    await dispatcher.close();
    await handler.close();
  });

  server.get(OAUTH_MCP_RESOURCE_PATH, async (request, reply) => {
    if (request.headers.authorization !== undefined) {
      return reply
        .header("Allow", "POST")
        .status(405)
        .send({
          error: "method_not_allowed",
          error_description: "Use POST for MCP protocol requests.",
        });
    }
    const settings = await options.services.readAuthenticationSettings(
      options.webConfig.publicOrigin,
    );
    const configuration = settings.activeOAuthConfiguration;
    const challenge = settings.mode === "oauth" && configuration !== null
      ? `Bearer resource_metadata="${buildMcpProtectedResourceMetadataUrl(options.webConfig.publicOrigin)}"`
      : "Bearer";
    return reply
      .header("Cache-Control", "no-store")
      .header("WWW-Authenticate", challenge)
      .status(401)
      .send({
        error: "invalid_token",
        error_description: "An MCP bearer credential is required.",
      });
  });

  server.route({
    handler: async (request, reply) => {
      if (
        request.headers.origin !== undefined
        && request.headers.origin !== options.webConfig.publicOrigin
      ) {
        return reply.status(403).send({
          error: "invalid_request",
          error_description: "The request origin is not allowed.",
        });
      }
      const requiredScopes = readMcpOperationScopes(
        request.headers["mcp-method"],
        request.headers["mcp-name"],
      );
      try {
        const access = await authenticateMcpRequest(
          options,
          request.headers.authorization,
          request.headers[MCP_WORKSPACE_NAME_HEADER],
          requiredScopes,
        );
        if (taskProtocol.canHandle(
          request.headers["mcp-method"],
          request.headers["mcp-name"],
        )) {
          await taskProtocol.handle({
            acceptHeader: request.headers.accept,
            body: request.body,
            contentTypeHeader: request.headers["content-type"],
            methodHeader: request.headers["mcp-method"],
            nameHeader: request.headers["mcp-name"],
            owner: buildMcpTaskOwner(access.principal, access.identity),
            protocolVersionHeader: request.headers["mcp-protocol-version"],
            reply,
          });
          return reply;
        }
        const rawToken = readOAuthBearerToken(request.headers.authorization);
        const authInfo: AuthInfo = {
          clientId: access.identity.clientId,
          expiresAt: access.expiresAt,
          extra: { principal: buildMcpPrincipalAuthData(access.principal) },
          resource: access.resource,
          scopes: access.scopes,
          token: rawToken,
        };
        const rawRequest = Object.assign(request.raw, {
          auth: authInfo,
          method: request.method,
          url: request.url,
        });
        reply.hijack();
        await nodeHandler(rawRequest, reply.raw, request.body);
        return reply;
      } catch (error: unknown) {
        return sendMcpAuthenticationError(
          reply,
          error,
          requiredScopes,
          options.webConfig.publicOrigin,
        );
      }
    },
    method: "POST",
    url: OAUTH_MCP_RESOURCE_PATH,
  });
  return dispatcher.start();
}

interface McpRequestAccess {
  expiresAt: number;
  identity: {
    clientId: string;
    issuer: string;
    subject: string;
  };
  principal: AuthorizationPrincipal;
  resource: URL;
  scopes: string[];
}

async function authenticateMcpRequest(
  options: McpRouteOptions,
  authorizationHeader: string | string[] | undefined,
  workspaceHeader: string | string[] | undefined,
  requiredScopes: readonly string[],
): Promise<McpRequestAccess> {
  if (hasMcpApiKeyPrefix(authorizationHeader)) {
    const workspaceName = readMcpWorkspaceName(workspaceHeader);
    const access = await options.services.authenticateMcpApiKey(
      authorizationHeader,
      workspaceName,
      requiredScopes,
    );
    return {
      expiresAt: access.expiresAt,
      identity: {
        clientId: access.apiKeyId,
        issuer: MCP_API_KEY_TASK_ISSUER,
        subject: access.principal.userId,
      },
      principal: access.principal,
      resource: new URL(OAUTH_MCP_RESOURCE_PATH, options.webConfig.publicOrigin),
      scopes: access.scopes,
    };
  }
  const settings = await options.services.readAuthenticationSettings(
    options.webConfig.publicOrigin,
  );
  const configuration = settings.activeOAuthConfiguration;
  if (settings.mode !== "oauth" || configuration === null) {
    throw new McpApiKeyRejectedError();
  }
  const workspaceName = readMcpWorkspaceName(workspaceHeader);
  const access = await options.oauthAuthenticator.verifyMcpAccess(
    settings,
    authorizationHeader,
    workspaceName,
    requiredScopes,
  );
  const configuredScopes = new Set(configuration.mcpScopes);
  const scopes = access.token.scopes.filter((scope) => {
    return configuredScopes.has(scope);
  });
  return {
    expiresAt: access.token.expiresAt,
    identity: {
      clientId: access.token.clientId,
      issuer: access.token.issuer,
      subject: access.token.subject,
    },
    principal: access.principal,
    resource: new URL(configuration.mcpResource),
    scopes,
  };
}

function buildMcpTaskOwner(
  principal: AuthorizationPrincipal,
  token: { clientId: string; issuer: string; subject: string },
): McpTaskOwner {
  return {
    clientId: token.clientId,
    issuer: token.issuer,
    subject: token.subject,
    userId: principal.userId,
    workspaceId: principal.workspaceId,
  };
}

function buildMcpPrincipalAuthData(
  principal: AuthorizationPrincipal,
): AuthorizationPrincipal {
  return {
    dataScope: principal.dataScope,
    displayName: principal.displayName,
    globalRole: principal.globalRole,
    role: principal.role,
    userId: principal.userId,
    username: principal.username,
    workspaceId: principal.workspaceId,
    workspaceName: principal.workspaceName,
  };
}

function createCiteLoomMcpServer(
  principal: AuthorizationPrincipal,
  grantedScopes: readonly string[],
  services: WebServices,
  publicOrigin: string,
): McpServer {
  const scopes = new Set(grantedScopes);
  const mcp = new McpServer({
    description: MCP_SERVER_DESCRIPTION,
    name: applicationMetadata.name,
    title: MCP_SERVER_TITLE,
    version: applicationMetadata.version,
    websiteUrl: publicOrigin,
  }, {
    capabilities: buildMcpServerCapabilities(scopes),
    instructions: buildMcpServerInstructions(grantedScopes),
  });
  if (scopes.has(MCP_SEARCH_SCOPE)) {
    registerSourceSearchTool(mcp, principal, services);
    registerSourceSearchPrompt(mcp);
  }
  if (scopes.has(MCP_ANSWER_SCOPE)) {
    registerAnswerTool(mcp);
    registerAnswerPrompt(mcp);
    registerResearchResources(mcp, principal, services);
  }
  mcp.registerResource(
    "workspace-context",
    MCP_WORKSPACE_CONTEXT_RESOURCE,
    {
      annotations: {
        audience: ["assistant", "user"],
        priority: 1,
      },
      description: "The CiteLoom user and local workspace selected for this authenticated request.",
      mimeType: "application/json",
      title: "CiteLoom workspace context",
    },
    async (uri) => {
      return {
        contents: [{
          mimeType: "application/json",
          text: JSON.stringify({
            displayName: principal.displayName,
            globalRole: principal.globalRole,
            role: principal.role,
            userId: principal.userId,
            username: principal.username,
            workspaceId: principal.workspaceId,
            workspaceName: principal.workspaceName,
          }),
          uri: uri.toString(),
        }],
      };
    },
  );
  return mcp;
}

function buildMcpServerCapabilities(
  scopes: ReadonlySet<string>,
): ServerCapabilities {
  const capabilities: ServerCapabilities = {};
  if (scopes.has(MCP_ANSWER_SCOPE)) {
    capabilities.extensions = { [MCP_TASK_EXTENSION_ID]: {} };
  }
  return capabilities;
}

function registerSourceSearchTool(
  mcp: McpServer,
  principal: AuthorizationPrincipal,
  services: WebServices,
): void {
  mcp.registerTool(
    MCP_SEARCH_TOOL,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: "Search authorized documents in the selected CiteLoom workspace for exact keyword matches and, when requested, semantically related passages. This read-only operation does not create a saved research turn and returns source identifiers, files, page numbers, section paths, and source regions for evidence-aware use.",
      inputSchema: sourceDiscoveryRequestSchema,
      outputSchema: sourceDiscoveryResponseSchema,
      title: "Search CiteLoom sources",
    },
    async (input, context) => {
      try {
        const result = await services.runInWorkspace(
          principal,
          async (runtime) => {
            return runtime.searchSources(
              principal,
              input,
              context.mcpReq.signal,
            );
          },
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error: unknown) {
        if (
          error instanceof SourceDiscoveryScopeError
          || error instanceof SourceDiscoveryUnavailableError
        ) {
          return {
            content: [{ type: "text", text: error.message }],
            isError: true,
          };
        }
        throw error;
      }
    },
  );
}

function registerSourceSearchPrompt(mcp: McpServer): void {
  mcp.registerPrompt(
    MCP_SEARCH_PROMPT,
    {
      argsSchema: mcpSearchPromptArgumentsSchema,
      description: "Prepare a source-grounded search of the selected CiteLoom workspace while preserving document and passage evidence metadata.",
      title: "Search a CiteLoom workspace",
    },
    ({ query }) => ({
      description: "Search the selected CiteLoom workspace and report evidence-bearing source passages.",
      messages: [{
        content: { text: buildMcpSearchPrompt(query), type: "text" },
        role: "user",
      }],
    }),
  );
}

function registerAnswerTool(
  mcp: McpServer,
): void {
  mcp.registerTool(
    MCP_ANSWER_TOOL,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description: "Create a synthesized answer from authorized documents in the selected CiteLoom workspace and save the cited result as a durable research turn. This operation requires host support for the io.modelcontextprotocol/tasks extension, returns a task handle for the host to resolve, and can expose resource links for the saved thread and immutable citation evidence when complete.",
      inputSchema: mcpAnswerTaskRequestSchema,
      outputSchema: streamedAnswerSchema,
      title: "Ask CiteLoom documents",
    },
    async () => {
      throw new Error(
        "citeloom.ask_documents requires the MCP Tasks extension.",
      );
    },
  );
}

function registerAnswerPrompt(mcp: McpServer): void {
  mcp.registerPrompt(
    MCP_ANSWER_PROMPT,
    {
      argsSchema: mcpAnswerPromptArgumentsSchema,
      description: "Prepare a cited document-answer workflow that saves its result as a CiteLoom research turn and uses the completed task result supplied by the MCP host.",
      title: "Answer with CiteLoom citations",
    },
    ({ question, threadTitle }) => ({
      description: "Create and follow a durable CiteLoom document-answer task.",
      messages: [{
        content: {
          text: buildMcpAnswerPrompt(question, threadTitle),
          type: "text",
        },
        role: "user",
      }],
    }),
  );
}

function registerResearchResources(
  mcp: McpServer,
  principal: AuthorizationPrincipal,
  services: WebServices,
): void {
  mcp.registerResource(
    "research-thread",
    new ResourceTemplate(MCP_THREAD_RESOURCE_TEMPLATE, { list: undefined }),
    {
      annotations: {
        audience: ["assistant", "user"],
        priority: 0.9,
      },
      description: "A saved CiteLoom research thread in the selected workspace.",
      mimeType: "application/json",
      title: "CiteLoom research thread",
    },
    async (uri, variables) => {
      const threadId = readMcpResourceId(variables.threadId, "thread ID");
      const thread = await services.runInWorkspace(principal, async (runtime) => {
        return runtime.readResearchThread(principal, threadId);
      });
      if (thread === null) {
        throw new ResourceNotFoundError(uri.toString());
      }
      return {
        contents: [{
          mimeType: "application/json",
          text: JSON.stringify(thread),
          uri: uri.toString(),
        }],
      };
    },
  );
  mcp.registerResource(
    "research-citation",
    new ResourceTemplate(MCP_CITATION_RESOURCE_TEMPLATE, { list: undefined }),
    {
      annotations: {
        audience: ["assistant", "user"],
        priority: 1,
      },
      description: "Immutable citation evidence from a saved CiteLoom answer.",
      mimeType: "application/json",
      title: "CiteLoom citation evidence",
    },
    async (uri, variables) => {
      const citationId = readMcpResourceId(
        variables.citationId,
        "citation ID",
      );
      const citation = await services.runInWorkspace(
        principal,
        async (runtime) => {
          return runtime.readCitationEvidence(principal, citationId);
        },
      );
      if (citation === null) {
        throw new ResourceNotFoundError(uri.toString());
      }
      return {
        contents: [{
          mimeType: "application/json",
          text: JSON.stringify(citation),
          uri: uri.toString(),
        }],
      };
    },
  );
}

function readMcpResourceId(
  value: string | string[] | undefined,
  field: string,
): string {
  if (typeof value !== "string" || !z.uuid().safeParse(value).success) {
    throw new Error(`The MCP resource ${field} is invalid.`);
  }
  return value;
}

function readMcpOperationScopes(
  methodHeader: string | string[] | undefined,
  nameHeader: string | string[] | undefined,
): string[] {
  const method = typeof methodHeader === "string" ? methodHeader : null;
  const name = typeof nameHeader === "string" ? nameHeader : null;
  if (method === "tools/call" && name === MCP_SEARCH_TOOL) {
    return [MCP_SEARCH_SCOPE];
  }
  if (method === "tools/call" && name === MCP_ANSWER_TOOL) {
    return [MCP_ANSWER_SCOPE];
  }
  if (
    method === "tasks/get"
    || method === "tasks/update"
    || method === "tasks/cancel"
  ) {
    return [MCP_ANSWER_SCOPE];
  }
  if (
    method === "resources/read"
    && name !== MCP_WORKSPACE_CONTEXT_RESOURCE
  ) {
    return [MCP_ANSWER_SCOPE];
  }
  return [];
}

function readMcpPrincipal(authInfo: AuthInfo | undefined): AuthorizationPrincipal {
  return mcpPrincipalSchema.parse(authInfo?.extra?.principal);
}

function readMcpWorkspaceName(value: string | string[] | undefined): string {
  if (typeof value !== "string") {
    throw new McpWorkspaceSelectorError(
      `The ${MCP_WORKSPACE_NAME_HEADER} header must identify one workspace.`,
    );
  }
  try {
    return decodeWorkspaceName({ workspaceName: value });
  } catch {
    throw new McpWorkspaceSelectorError(
      `The ${MCP_WORKSPACE_NAME_HEADER} header must be a valid workspace name.`,
    );
  }
}

function sendMcpAuthenticationError(
  reply: FastifyReply,
  error: unknown,
  requiredScopes: readonly string[],
  publicOrigin: string,
): unknown {
  const metadataUrl = buildMcpProtectedResourceMetadataUrl(publicOrigin);
  if (error instanceof McpWorkspaceSelectorError) {
    return reply.status(400).send({
      error: "invalid_request",
      error_description: error.message,
    });
  }
  if (error instanceof OAuthAccessTokenRejectedError) {
    const scope = requiredScopes.length === 0
      ? ""
      : `, scope="${requiredScopes.join(" ")}"`;
    return reply
      .header(
        "WWW-Authenticate",
        `Bearer error="invalid_token"${scope}, resource_metadata="${metadataUrl}"`,
      )
      .status(401)
      .send({ error: "invalid_token", error_description: error.message });
  }
  if (error instanceof McpApiKeyRejectedError) {
    const scope = requiredScopes.length === 0
      ? ""
      : `, scope="${requiredScopes.join(" ")}"`;
    return reply
      .header("WWW-Authenticate", `Bearer error="invalid_token"${scope}`)
      .status(401)
      .send({ error: "invalid_token", error_description: error.message });
  }
  if (error instanceof OAuthInsufficientScopeError) {
    return reply
      .header(
        "WWW-Authenticate",
        `Bearer error="insufficient_scope", scope="${requiredScopes.join(" ")}", resource_metadata="${metadataUrl}"`,
      )
      .status(403)
      .send({ error: "insufficient_scope", error_description: error.message });
  }
  if (error instanceof McpApiKeyInsufficientScopeError) {
    return reply
      .header(
        "WWW-Authenticate",
        `Bearer error="insufficient_scope", scope="${requiredScopes.join(" ")}"`,
      )
      .status(403)
      .send({ error: "insufficient_scope", error_description: error.message });
  }
  if (error instanceof OAuthIdentityUnavailableError) {
    return reply.status(403).send({
      error: "access_denied",
      error_description: error.message,
    });
  }
  throw error;
}

function buildMcpProtectedResourceMetadataUrl(publicOrigin: string): string {
  return new URL(
    buildProtectedResourceMetadataPath(
      new URL(OAUTH_MCP_RESOURCE_PATH, publicOrigin).toString(),
    ),
    publicOrigin,
  ).toString();
}
