import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
  type AuthInfo,
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
  MCP_API_KEY_TASK_ISSUER,
  MCP_ANSWER_TOOL,
  MCP_CITATION_RESOURCE_TEMPLATE,
  MCP_SEARCH_SCOPE,
  MCP_SEARCH_TOOL,
  MCP_THREAD_RESOURCE_TEMPLATE,
  MCP_WORKSPACE_NAME_HEADER,
} from "./contract.js";
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
    const access = await options.services.authenticateMcpApiKey(
      authorizationHeader,
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
): McpServer {
  const mcp = new McpServer({
    name: applicationMetadata.name,
    version: applicationMetadata.version,
  }, {
    capabilities: {
      extensions: { [MCP_TASK_EXTENSION_ID]: {} },
    },
    instructions: "Search the selected CiteLoom workspace and preserve source identifiers in results.",
  });
  const scopes = new Set(grantedScopes);
  if (scopes.has(MCP_SEARCH_SCOPE)) {
    registerSourceSearchTool(mcp, principal, services);
  }
  if (scopes.has(MCP_ANSWER_SCOPE)) {
    registerAnswerTool(mcp);
    registerResearchResources(mcp, principal, services);
  }
  mcp.registerResource(
    "workspace-context",
    "citeloom://workspace/context",
    {
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
      description: "Search documents in the selected CiteLoom workspace.",
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
      description: "Answer a question from documents in the selected CiteLoom workspace and save the cited research turn.",
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

function registerResearchResources(
  mcp: McpServer,
  principal: AuthorizationPrincipal,
  services: WebServices,
): void {
  mcp.registerResource(
    "research-thread",
    new ResourceTemplate(MCP_THREAD_RESOURCE_TEMPLATE, { list: undefined }),
    {
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
    && name !== "citeloom://workspace/context"
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
  const metadataUrl = new URL(
    buildProtectedResourceMetadataPath(
      new URL(OAUTH_MCP_RESOURCE_PATH, publicOrigin).toString(),
    ),
    publicOrigin,
  ).toString();
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
