import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  createMcpHandler,
  McpServer,
  ResourceNotFoundError,
  ResourceTemplate,
  type AuthInfo,
  type ContentBlock,
} from "@modelcontextprotocol/server";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

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
} from "../retrieval/discovery/boundary.js";
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
  MCP_ANSWER_CANCEL_TOOL,
  MCP_ANSWER_STATUS_TOOL,
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
} from "./mcp.js";
import {
  buildMcpAnswerPrompt,
  buildMcpSearchPrompt,
  buildMcpServerInstructions,
} from "./guidance.js";
import { McpTaskDispatcher } from "./tasks/dispatcher.js";
import {
  buildMcpAnswerHandle,
  buildMcpAnswerStatus,
  mcpAnswerCancellationSchema,
  mcpAnswerHandleSchema,
  mcpAnswerStatusSchema,
  mcpAnswerTaskRequestSchema,
  type McpTaskOwner,
} from "./tasks/model.js";

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

const mcpTaskOwnerSchema = z.object({
  clientId: z.string().min(1),
  issuer: z.string().min(1),
  subject: z.string().min(1),
  userId: z.uuid(),
}).strict();

const mcpRequestContextSchema = z.object({
  principals: z.array(mcpPrincipalSchema).min(1),
  taskOwner: mcpTaskOwnerSchema,
}).strict();

const mcpAnswerTaskIdSchema = z.object({
  taskId: z.uuid().describe(
    "Durable answer task identifier returned by citeloom.ask_documents.",
  ),
}).strict();

const mcpSearchPromptArgumentsSchema = sourceDiscoveryRequestSchema.pick({
  query: true,
}).describe(
  "Arguments for a source-search workflow across every available CiteLoom workspace.",
);

const mcpAnswerPromptArgumentsSchema = mcpAnswerTaskRequestSchema.pick({
  question: true,
  threadTitle: true,
}).describe(
  "Arguments for a durable cited-answer workflow.",
);

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
  const handler = createMcpHandler((context) => {
    const requestContext = readMcpRequestContext(context.authInfo);
    return createCiteLoomMcpServer(
      requestContext.principals,
      requestContext.taskOwner,
      context.authInfo?.scopes ?? [],
      dispatcher,
      options.services,
      options.webConfig.publicOrigin,
      reportTaskError,
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

  const sendMcpGetResponse = async (
    authorizationHeader: string | string[] | undefined,
    reply: FastifyReply,
  ): Promise<unknown> => {
    if (authorizationHeader !== undefined) {
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
  };
  server.get(OAUTH_MCP_RESOURCE_PATH, async (request, reply) => {
    return sendMcpGetResponse(request.headers.authorization, reply);
  });

  server.route({
    handler: async (request, reply) => {
      if (
        request.headers.origin !== undefined
        && !options.webConfig.publicOrigins.includes(request.headers.origin)
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
          requiredScopes,
        );
        const rawToken = readOAuthBearerToken(request.headers.authorization);
        const authInfo: AuthInfo = {
          clientId: access.identity.clientId,
          expiresAt: access.expiresAt,
          extra: {
            principals: buildMcpPrincipalAuthData(access.principals),
            taskOwner: buildMcpTaskOwner(access.principals, access.identity),
          },
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
  principals: AuthorizationPrincipal[];
  resource: URL;
  scopes: string[];
}

async function authenticateMcpRequest(
  options: McpRouteOptions,
  authorizationHeader: string | string[] | undefined,
  requiredScopes: readonly string[],
): Promise<McpRequestAccess> {
  if (hasMcpApiKeyPrefix(authorizationHeader)) {
    const access = await options.services.authenticateMcpApiKey(
      authorizationHeader,
      requiredScopes,
    );
    const principal = readFirstPrincipal(access.principals);
    return {
      expiresAt: access.expiresAt,
      identity: {
        clientId: access.apiKeyId,
        issuer: MCP_API_KEY_TASK_ISSUER,
        subject: principal.userId,
      },
      principals: access.principals,
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
  const access = await options.oauthAuthenticator.verifyMcpAccess(
    settings,
    authorizationHeader,
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
    principals: access.principals,
    resource: new URL(configuration.mcpResource),
    scopes,
  };
}

function buildMcpTaskOwner(
  principals: readonly AuthorizationPrincipal[],
  token: { clientId: string; issuer: string; subject: string },
): McpTaskOwner {
  const principal = readFirstPrincipal(principals);
  return {
    clientId: token.clientId,
    issuer: token.issuer,
    subject: token.subject,
    userId: principal.userId,
  };
}

function buildMcpPrincipalAuthData(
  principals: readonly AuthorizationPrincipal[],
): AuthorizationPrincipal[] {
  const result: AuthorizationPrincipal[] = [];
  for (const principal of principals) {
    result.push({
      dataScope: principal.dataScope,
      displayName: principal.displayName,
      globalRole: principal.globalRole,
      role: principal.role,
      userId: principal.userId,
      username: principal.username,
      workspaceId: principal.workspaceId,
      workspaceName: principal.workspaceName,
    });
  }
  return result;
}

function readFirstPrincipal(
  principals: readonly AuthorizationPrincipal[],
): AuthorizationPrincipal {
  const principal = principals[0];
  if (principal === undefined) {
    throw new OAuthIdentityUnavailableError();
  }
  return principal;
}

function createCiteLoomMcpServer(
  principals: AuthorizationPrincipal[],
  taskOwner: McpTaskOwner,
  grantedScopes: readonly string[],
  dispatcher: McpTaskDispatcher,
  services: WebServices,
  publicOrigin: string,
  onError: (error: unknown) => void,
): McpServer {
  const scopes = new Set(grantedScopes);
  const mcp = new McpServer({
    description: MCP_SERVER_DESCRIPTION,
    name: applicationMetadata.name,
    title: MCP_SERVER_TITLE,
    version: applicationMetadata.version,
    websiteUrl: publicOrigin,
  }, {
    capabilities: {
      prompts: { listChanged: false },
      resources: { listChanged: false },
      tools: { listChanged: false },
    },
    instructions: buildMcpServerInstructions(grantedScopes),
  });
  if (scopes.has(MCP_SEARCH_SCOPE)) {
    registerSourceSearchTool(mcp, principals, services, onError);
    registerSourceSearchPrompt(mcp);
  }
  if (scopes.has(MCP_ANSWER_SCOPE)) {
    registerAnswerTools(mcp, principals, taskOwner, dispatcher, services);
    registerAnswerPrompt(mcp);
    registerResearchResources(mcp, principals, services);
  }
  mcp.registerResource(
    "workspace-context",
    MCP_WORKSPACE_CONTEXT_RESOURCE,
    {
      annotations: {
        audience: ["assistant", "user"],
        priority: 1,
      },
      description: "The authenticated CiteLoom user and every workspace available to that user.",
      mimeType: "application/json",
      title: "CiteLoom workspace access",
    },
    async (uri) => {
      const principal = readFirstPrincipal(principals);
      const workspaces = principals.map((workspacePrincipal) => ({
        id: workspacePrincipal.workspaceId,
        name: workspacePrincipal.workspaceName,
        role: workspacePrincipal.role,
      }));
      return {
        contents: [{
          mimeType: "application/json",
          text: JSON.stringify({
            displayName: principal.displayName,
            globalRole: principal.globalRole,
            userId: principal.userId,
            username: principal.username,
            workspaces,
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
  principals: readonly AuthorizationPrincipal[],
  services: WebServices,
  onError: (error: unknown) => void,
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
      description: "Search the combined authorized document set from every CiteLoom workspace available to the authenticated user. One search returns exact keyword matches and, when requested, semantically related passages with source identifiers, files, page numbers, section paths, and source regions.",
      inputSchema: sourceDiscoveryRequestSchema,
      outputSchema: sourceDiscoveryResponseSchema,
      title: "Search CiteLoom sources",
    },
    async (input, context) => {
      const principal = readFirstPrincipal(principals);
      const workspaceIds = principals.map((workspacePrincipal) => {
        return workspacePrincipal.workspaceId;
      });
      try {
        const result = await services.run(async (runtime) => {
          return runtime.searchSources(
            principal,
            input,
            context.mcpReq.signal,
            workspaceIds,
          );
        });
        const parsed = sourceDiscoveryResponseSchema.parse(result);
        return {
          content: [{ type: "text", text: JSON.stringify(parsed) }],
          structuredContent: parsed,
        };
      } catch (error: unknown) {
        onError(error);
        return {
          content: [{
            type: "text",
            text: readMcpSearchError(error),
          }],
          isError: true,
        };
      }
    },
  );
}

function readMcpSearchError(error: unknown): string {
  if (
    error instanceof SourceDiscoveryScopeError
    || error instanceof SourceDiscoveryUnavailableError
  ) {
    return error.message;
  }
  return "CiteLoom could not search the available documents.";
}

function registerSourceSearchPrompt(mcp: McpServer): void {
  mcp.registerPrompt(
    MCP_SEARCH_PROMPT,
    {
      argsSchema: mcpSearchPromptArgumentsSchema,
      description: "Prepare a source-grounded search across every available CiteLoom workspace while preserving workspace, document, and passage evidence metadata.",
      title: "Search CiteLoom workspaces",
    },
    ({ query }) => ({
      description: "Search every available CiteLoom workspace and report evidence-bearing source passages.",
      messages: [{
        content: { text: buildMcpSearchPrompt(query), type: "text" },
        role: "user",
      }],
    }),
  );
}

function registerAnswerTools(
  mcp: McpServer,
  principals: readonly AuthorizationPrincipal[],
  taskOwner: McpTaskOwner,
  dispatcher: McpTaskDispatcher,
  services: WebServices,
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
      description: "Start one durable cited-answer task over the combined authorized document set from every CiteLoom workspace available to the authenticated user. Call citeloom.get_answer with the returned task ID until the status is completed, failed, or cancelled.",
      inputSchema: mcpAnswerTaskRequestSchema,
      outputSchema: mcpAnswerHandleSchema,
      title: "Ask CiteLoom documents",
    },
    async (input) => {
      const task = await services.mcpTasks.create(taskOwner, input);
      dispatcher.enqueue(task.id);
      const handle = buildMcpAnswerHandle(task);
      return {
        content: [{
          text: `CiteLoom started answer task ${task.id}. Call ${MCP_ANSWER_STATUS_TOOL} with this task ID until the task reaches a final status.`,
          type: "text",
        }],
        structuredContent: handle,
      };
    },
  );
  mcp.registerTool(
    MCP_ANSWER_STATUS_TOOL,
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: true,
      },
      description: "Read the current state of a durable CiteLoom answer task. Call this tool again after pollIntervalMs while the status is working. A completed result contains one cited answer over the combined authorized document set.",
      inputSchema: mcpAnswerTaskIdSchema,
      outputSchema: mcpAnswerStatusSchema,
      title: "Get a CiteLoom answer",
    },
    async ({ taskId }) => {
      const task = await services.mcpTasks.readForOwner(taskOwner, taskId);
      if (task === null) {
        return buildMissingAnswerTaskResult(taskId);
      }
      const availableWorkspaceIds = new Set<string>();
      for (const principal of principals) {
        availableWorkspaceIds.add(principal.workspaceId);
      }
      const status = buildMcpAnswerStatus(task, availableWorkspaceIds);
      return {
        content: buildAnswerStatusContent(status),
        structuredContent: status,
      };
    },
  );
  mcp.registerTool(
    MCP_ANSWER_CANCEL_TOOL,
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false,
      },
      description: "Request cancellation of a durable CiteLoom answer task. Call citeloom.get_answer after this tool to confirm the final task state.",
      inputSchema: mcpAnswerTaskIdSchema,
      outputSchema: mcpAnswerCancellationSchema,
      title: "Cancel a CiteLoom answer",
    },
    async ({ taskId }) => {
      const found = await dispatcher.requestCancellation(taskOwner, taskId);
      if (!found) {
        return buildMissingAnswerTaskResult(taskId);
      }
      const result = { cancellationRequested: true as const, taskId };
      return {
        content: [{
          text: `CiteLoom accepted the cancellation request for answer task ${taskId}.`,
          type: "text",
        }],
        structuredContent: result,
      };
    },
  );
}

function buildAnswerStatusContent(
  status: z.output<typeof mcpAnswerStatusSchema>,
): ContentBlock[] {
  if (status.status === "completed") {
    const content: ContentBlock[] = [{
      text: status.answer.answerDocument.content,
      type: "text",
    }];
    content.push(...status.resources);
    return content;
  }
  return [{ text: JSON.stringify(status), type: "text" as const }];
}

function buildMissingAnswerTaskResult(taskId: string) {
  return {
    content: [{
      text: `CiteLoom cannot find answer task ${taskId} for this credential. Check the task ID. The task can also be expired.`,
      type: "text" as const,
    }],
    isError: true as const,
  };
}

function registerAnswerPrompt(mcp: McpServer): void {
  mcp.registerPrompt(
    MCP_ANSWER_PROMPT,
    {
      argsSchema: mcpAnswerPromptArgumentsSchema,
      description: "Prepare a cited document-answer workflow that saves its result as a CiteLoom research turn. Use citeloom.get_answer to read the completed result.",
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
  principals: readonly AuthorizationPrincipal[],
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
      description: "A saved CiteLoom research thread in one available workspace.",
      mimeType: "application/json",
      title: "CiteLoom research thread",
    },
    async (uri, variables) => {
      const workspaceId = readMcpResourceId(
        variables.workspaceId,
        "workspace ID",
      );
      const principal = findMcpWorkspacePrincipal(principals, workspaceId);
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
      const workspaceId = readMcpResourceId(
        variables.workspaceId,
        "workspace ID",
      );
      const principal = findMcpWorkspacePrincipal(principals, workspaceId);
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

function findMcpWorkspacePrincipal(
  principals: readonly AuthorizationPrincipal[],
  workspaceId: string,
): AuthorizationPrincipal {
  for (const principal of principals) {
    if (principal.workspaceId === workspaceId) {
      return principal;
    }
  }
  throw new ResourceNotFoundError(
    `citeloom://workspaces/${workspaceId}`,
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
  if (
    method === "tools/call"
    && (
      name === MCP_ANSWER_TOOL
      || name === MCP_ANSWER_STATUS_TOOL
      || name === MCP_ANSWER_CANCEL_TOOL
    )
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

function readMcpRequestContext(authInfo: AuthInfo | undefined): {
  principals: AuthorizationPrincipal[];
  taskOwner: McpTaskOwner;
} {
  return mcpRequestContextSchema.parse(authInfo?.extra);
}

function sendMcpAuthenticationError(
  reply: FastifyReply,
  error: unknown,
  requiredScopes: readonly string[],
  publicOrigin: string,
): unknown {
  const metadataUrl = buildMcpProtectedResourceMetadataUrl(publicOrigin);
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
