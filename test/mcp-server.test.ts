import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  buildWebServer as buildProductionWebServer,
  type RuntimeWebServices,
  type WebServices,
} from "../src/web-server.js";
import { OAuthInsufficientScopeError } from "../src/oauth/access-token.js";
import {
  MCP_ANSWER_PROMPT,
  MCP_ANSWER_TOOL,
  MCP_API_KEY_TASK_ISSUER,
  MCP_SEARCH_PROMPT,
  MCP_SEARCH_TOOL,
  MCP_SERVER_DESCRIPTION,
  MCP_SERVER_TITLE,
  MCP_WORKSPACE_CONTEXT_RESOURCE,
} from "../src/mcp/contract.js";
import {
  buildAuthenticatedPrincipal,
  buildConfig,
  buildOAuthAuthenticationSettings,
  buildOAuthPrincipal,
  buildServices,
  buildSourceDiscoveryResponse,
  createAnswerStream,
  createInMemoryMcpTaskServices,
} from "./web-server-fixture.js";

describe("MCP server", () => {
  it("advertises OAuth discovery for an unauthenticated MCP GET", async () => {
    const settings = buildOAuthAuthenticationSettings();
    const readAuthenticationSettings = vi.fn<
      WebServices["readAuthenticationSettings"]
    >(async () => settings);
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ readAuthenticationSettings }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        method: "GET",
        url: "/mcp",
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["www-authenticate"]).toBe(
        "Bearer resource_metadata=\"https://localhost:3443/.well-known/oauth-protected-resource/mcp\"",
      );
      expect(response.json()).toEqual({
        error: "invalid_token",
        error_description: "An MCP bearer credential is required.",
      });
      expect(readAuthenticationSettings).toHaveBeenCalledWith(
        "https://localhost:3443",
      );
    } finally {
      await server.close();
    }
  });

  it("rejects authenticated MCP GET requests without restarting OAuth", async () => {
    const readAuthenticationSettings = vi.fn<
      WebServices["readAuthenticationSettings"]
    >();
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ readAuthenticationSettings }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        headers: { authorization: "Bearer token" },
        method: "GET",
        url: "/mcp",
      });

      expect(response.statusCode).toBe(405);
      expect(response.headers.allow).toBe("POST");
      expect(response.headers["www-authenticate"]).toBeUndefined();
      expect(readAuthenticationSettings).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("requires an MCP credential while cookie authentication is active", async () => {
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices(),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        method: "POST",
        payload: {
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
            protocolVersion: "2025-11-25",
          },
        },
        url: "/mcp",
      });

      expect(response.statusCode).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("accepts an MCP request origin from the public origin list", async () => {
    const config = buildConfig();
    config.web.publicOrigins.push("https://citeloom.example");
    const server = await buildProductionWebServer(config, {
      logger: false,
      services: buildServices(),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        headers: { origin: "https://citeloom.example" },
        method: "POST",
        payload: {
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
            protocolVersion: "2025-11-25",
          },
        },
        url: "/mcp",
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: "invalid_token" });
    } finally {
      await server.close();
    }
  });

  it("serves a user-bound MCP API key in the selected workspace", async () => {
    const principal = buildAuthenticatedPrincipal("member", "standard");
    const apiKeyId = "00000000-0000-4000-8000-000000000810";
    const authenticateMcpApiKey = vi.fn<WebServices["authenticateMcpApiKey"]>(
      async () => ({
        apiKeyId,
        expiresAt: 1_800_000_000,
        principal,
        scopes: ["citeloom.search", "citeloom.answer"],
      }),
    );
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ authenticateMcpApiKey }),
      staticDirectory: null,
    });
    const requestMetadata = {
      "io.modelcontextprotocol/clientCapabilities": {
        extensions: { "io.modelcontextprotocol/tasks": {} },
      },
      "io.modelcontextprotocol/clientInfo": {
        name: "api-key-client",
        version: "1.0.0",
      },
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    };
    try {
      const response = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "bEaReR clm_mcp_test-key",
          "mcp-method": "server/discover",
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 1,
          jsonrpc: "2.0",
          method: "server/discover",
          params: {
            _meta: requestMetadata,
          },
        },
        url: "/mcp",
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(authenticateMcpApiKey).toHaveBeenCalledWith(
        "bEaReR clm_mcp_test-key",
        principal.workspaceName,
        [],
      );
      expect(response.json()).toMatchObject({
        result: {
          _meta: {
            "io.modelcontextprotocol/serverInfo": {
              description: MCP_SERVER_DESCRIPTION,
              name: "citeloom",
              title: MCP_SERVER_TITLE,
              version: expect.any(String),
              websiteUrl: "https://localhost:3443",
            },
          },
          capabilities: {
            extensions: { "io.modelcontextprotocol/tasks": {} },
            prompts: expect.any(Object),
            resources: expect.any(Object),
            tools: expect.any(Object),
          },
          instructions: expect.stringContaining(MCP_SEARCH_TOOL),
          supportedVersions: ["2026-07-28"],
        },
      });

      const toolsResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer clm_mcp_test-key",
          "mcp-method": "tools/list",
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 2,
          jsonrpc: "2.0",
          method: "tools/list",
          params: { _meta: requestMetadata },
        },
        url: "/mcp",
      });
      expect(toolsResponse.statusCode, toolsResponse.body).toBe(200);
      expect(toolsResponse.json()).toMatchObject({
        result: {
          tools: expect.arrayContaining([
            expect.objectContaining({
              description: expect.stringContaining("exact keyword matches"),
              inputSchema: expect.objectContaining({
                properties: expect.objectContaining({
                  query: expect.objectContaining({
                    description: expect.stringContaining("query"),
                  }),
                  scope: expect.objectContaining({
                    description: expect.stringContaining("document set"),
                  }),
                }),
              }),
              name: MCP_SEARCH_TOOL,
              outputSchema: expect.objectContaining({
                description: expect.stringContaining("evidence passages"),
              }),
              title: "Search CiteLoom sources",
            }),
            expect.objectContaining({
              description: expect.stringContaining(
                "io.modelcontextprotocol/tasks",
              ),
              name: MCP_ANSWER_TOOL,
              title: "Ask CiteLoom documents",
            }),
          ]),
        },
      });

      const promptsResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer clm_mcp_test-key",
          "mcp-method": "prompts/list",
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 3,
          jsonrpc: "2.0",
          method: "prompts/list",
          params: { _meta: requestMetadata },
        },
        url: "/mcp",
      });
      expect(promptsResponse.statusCode, promptsResponse.body).toBe(200);
      expect(promptsResponse.json()).toMatchObject({
        result: {
          prompts: expect.arrayContaining([
            expect.objectContaining({
              description: expect.stringContaining("source-grounded search"),
              name: MCP_SEARCH_PROMPT,
            }),
            expect.objectContaining({
              description: expect.stringContaining("cited document-answer"),
              name: MCP_ANSWER_PROMPT,
            }),
          ]),
        },
      });

      const promptResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer clm_mcp_test-key",
          "mcp-method": "prompts/get",
          "mcp-name": MCP_ANSWER_PROMPT,
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 4,
          jsonrpc: "2.0",
          method: "prompts/get",
          params: {
            _meta: requestMetadata,
            arguments: {
              question: "What is the retention policy?",
              threadTitle: "Retention policy",
            },
            name: MCP_ANSWER_PROMPT,
          },
        },
        url: "/mcp",
      });
      expect(promptResponse.statusCode, promptResponse.body).toBe(200);
      expect(promptResponse.body).toContain(MCP_ANSWER_TOOL);
      expect(promptResponse.body).toContain(
        "The MCP host resolves the asynchronous task",
      );
      expect(promptResponse.body).not.toContain("Poll the returned task");
      expect(promptResponse.body).toContain("Retention policy");

      const resourcesResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer clm_mcp_test-key",
          "mcp-method": "resources/list",
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 5,
          jsonrpc: "2.0",
          method: "resources/list",
          params: { _meta: requestMetadata },
        },
        url: "/mcp",
      });
      expect(resourcesResponse.statusCode, resourcesResponse.body).toBe(200);
      expect(resourcesResponse.json()).toMatchObject({
        result: {
          resources: [expect.objectContaining({
            description: expect.stringContaining("selected"),
            name: "workspace-context",
            uri: MCP_WORKSPACE_CONTEXT_RESOURCE,
          })],
        },
      });

      const templatesResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer clm_mcp_test-key",
          "mcp-method": "resources/templates/list",
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 6,
          jsonrpc: "2.0",
          method: "resources/templates/list",
          params: { _meta: requestMetadata },
        },
        url: "/mcp",
      });
      expect(templatesResponse.statusCode, templatesResponse.body).toBe(200);
      expect(templatesResponse.json()).toMatchObject({
        result: {
          resourceTemplates: expect.arrayContaining([
            expect.objectContaining({ name: "research-thread" }),
            expect.objectContaining({ name: "research-citation" }),
          ]),
        },
      });
    } finally {
      await server.close();
    }
  });

  it("requires a workspace selector for an MCP API key", async () => {
    const authenticateMcpApiKey = vi.fn<WebServices["authenticateMcpApiKey"]>();
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ authenticateMcpApiKey }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer clm_mcp_test-key",
          "mcp-method": "server/discover",
          "mcp-protocol-version": "2026-07-28",
        },
        method: "POST",
        payload: {
          id: 1,
          jsonrpc: "2.0",
          method: "server/discover",
          params: {},
        },
        url: "/mcp",
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: "invalid_request",
        error_description: expect.stringContaining(
          "x-citeloom-workspace-name",
        ),
      });
      expect(authenticateMcpApiKey).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("serves authenticated modern MCP requests for an explicit local workspace", async () => {
    const settings = buildOAuthAuthenticationSettings();
    const principal = buildOAuthPrincipal();
    const threadId = "00000000-0000-4000-8000-000000000001";
    const citationId = "00000000-0000-4000-8000-000000000003";
    const searchSources = vi.fn<RuntimeWebServices["searchSources"]>(
      async () => buildSourceDiscoveryResponse(),
    );
    const createResearchThread = vi.fn<
      RuntimeWebServices["createResearchThread"]
    >(async (_principal, title) => ({
      createdAt: "2026-07-15T12:00:00.000Z",
      id: threadId,
      title,
      turns: [],
      updatedAt: "2026-07-15T12:00:00.000Z",
    }));
    const streamAnswer = vi.fn<RuntimeWebServices["streamAnswer"]>(
      () => createAnswerStream("The retention period is seven years."),
    );
    const readResearchThread = vi.fn<
      RuntimeWebServices["readResearchThread"]
    >(async () => ({
      createdAt: "2026-07-15T12:00:00.000Z",
      id: threadId,
      title: "Retention research",
      turns: [],
      updatedAt: "2026-07-15T12:00:00.000Z",
    }));
    const readCitationEvidence = vi.fn<
      RuntimeWebServices["readCitationEvidence"]
    >(async () => ({
      citationNumber: 1,
      createdAt: "2026-07-15T12:00:00.000Z",
      documentId: "a".repeat(64),
      documentVersionId: "00000000-0000-4000-8000-000000000002",
      elementId: "b".repeat(64),
      evidence: { excerpt: "Supporting evidence.", kind: "text" },
      id: citationId,
      pageNumbers: [1],
      regions: [],
      sectionPath: [],
      sourceFile: "/tmp/report.pdf",
      stale: false,
      turnId: "00000000-0000-4000-8000-000000000005",
    }));
    const verifyMcpAccess = vi.fn(async () => ({
      principal,
      token: {
        clientId: "test-mcp-client",
        expiresAt: 1_800_000_000,
        issuer: principal.issuer,
        scopes: settings.activeOAuthConfiguration?.mcpScopes ?? [],
        subject: principal.subject,
      },
    }));
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      oauthAuthenticator: {
        authenticate: vi.fn(),
        readIdentityContext: vi.fn(),
        verifyMcpAccess,
      },
      services: buildServices({
        createResearchThread,
        readCitationEvidence,
        readAuthenticationSettings: async () => settings,
        readResearchThread,
        resolveOAuthPrincipal: async () => principal,
        searchSources,
        streamAnswer,
      }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-mcp-token",
          "mcp-method": "server/discover",
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 1,
          jsonrpc: "2.0",
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {
                extensions: {
                  "io.modelcontextprotocol/tasks": {},
                },
              },
              "io.modelcontextprotocol/clientInfo": {
                name: "test-client",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
          },
        },
        url: "/mcp",
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("citeloom");
      expect(response.body).toContain("2026-07-28");
      expect(response.body).toContain("io.modelcontextprotocol/tasks");

      const toolResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-mcp-token",
          "mcp-method": "tools/call",
          "mcp-name": "citeloom.search_sources",
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 2,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {
                extensions: {
                  "io.modelcontextprotocol/tasks": {},
                },
              },
              "io.modelcontextprotocol/clientInfo": {
                name: "test-client",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
            arguments: {
              includeRelated: false,
              keywordPage: 1,
              query: "retention requirements",
              scope: { kind: "all" },
            },
            name: "citeloom.search_sources",
          },
        },
        url: "/mcp",
      });

      expect(toolResponse.statusCode).toBe(200);
      expect(toolResponse.body).toContain("structuredContent");
      expect(searchSources).toHaveBeenCalledWith(
        expect.objectContaining({
          dataScope: principal.dataScope,
          userId: principal.userId,
          workspaceId: principal.workspaceId,
        }),
        {
          includeRelated: false,
          keywordPage: 1,
          query: "retention requirements",
          scope: { kind: "all" },
        },
        expect.objectContaining({ aborted: expect.any(Boolean) }),
      );
      expect(verifyMcpAccess).toHaveBeenCalledWith(
        settings,
        "Bearer valid-mcp-token",
        principal.workspaceName,
        ["citeloom.search"],
      );

      const answerResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-mcp-token",
          "mcp-method": "tools/call",
          "mcp-name": "citeloom.ask_documents",
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 3,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {
                extensions: {
                  "io.modelcontextprotocol/tasks": {},
                },
              },
              "io.modelcontextprotocol/clientInfo": {
                name: "test-client",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
            arguments: {
              question: "How long are records retained?",
              scope: { kind: "all" },
              threadTitle: "Retention research",
            },
            name: "citeloom.ask_documents",
          },
        },
        url: "/mcp",
      });

      expect(answerResponse.statusCode).toBe(200);
      expect(answerResponse.json()).toMatchObject({
        result: {
          _meta: {
            "io.modelcontextprotocol/serverInfo": {
              name: "citeloom",
            },
          },
          resultType: "task",
          status: "working",
          ttlMs: 30 * 24 * 60 * 60 * 1_000,
        },
      });
      const taskId = answerResponse.json().result.taskId as string;
      const updateResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-mcp-token",
          "mcp-method": "tasks/update",
          "mcp-name": taskId,
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 4,
          jsonrpc: "2.0",
          method: "tasks/update",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {
                extensions: {
                  "io.modelcontextprotocol/tasks": {},
                },
              },
              "io.modelcontextprotocol/clientInfo": {
                name: "test-client",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
            inputResponses: {},
            taskId,
          },
        },
        url: "/mcp",
      });
      expect(updateResponse.json()).toMatchObject({
        result: { resultType: "complete" },
      });
      let completedTask: unknown = null;
      await vi.waitFor(async () => {
        const taskResponse = await server.inject({
          headers: {
            accept: "application/json, text/event-stream",
            authorization: "Bearer valid-mcp-token",
            "mcp-method": "tasks/get",
            "mcp-name": taskId,
            "mcp-protocol-version": "2026-07-28",
            "x-citeloom-workspace-name": principal.workspaceName,
          },
          method: "POST",
          payload: {
            id: 4,
            jsonrpc: "2.0",
            method: "tasks/get",
            params: {
              _meta: {
                "io.modelcontextprotocol/clientCapabilities": {
                  extensions: {
                    "io.modelcontextprotocol/tasks": {},
                  },
                },
                "io.modelcontextprotocol/clientInfo": {
                  name: "test-client",
                  version: "1.0.0",
                },
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              },
              taskId,
            },
          },
          url: "/mcp",
        });
        expect(taskResponse.statusCode).toBe(200);
        const result = taskResponse.json().result;
        expect(result.status).toBe("completed");
        completedTask = result;
      });
      expect(completedTask).toMatchObject({
        result: {
          resultType: "complete",
          structuredContent: {
            answerDocument: {
              content: "The retention period is seven years.",
            },
          },
        },
        resultType: "complete",
        status: "completed",
      });
      expect(JSON.stringify(completedTask)).toContain(
        `citeloom://workspace/research/threads/${threadId}`,
      );
      expect(JSON.stringify(completedTask)).toContain(
        `citeloom://workspace/research/citations/${citationId}`,
      );
      expect(createResearchThread).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: principal.workspaceId }),
        "Retention research",
      );
      expect(streamAnswer).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: principal.workspaceId }),
        {
          question: "How long are records retained?",
          scope: { kind: "all" },
          threadId,
        },
        expect.objectContaining({ aborted: expect.any(Boolean) }),
      );
      expect(verifyMcpAccess).toHaveBeenLastCalledWith(
        settings,
        "Bearer valid-mcp-token",
        principal.workspaceName,
        ["citeloom.answer"],
      );

      const threadUri = `citeloom://workspace/research/threads/${threadId}`;
      const threadResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-mcp-token",
          "mcp-method": "resources/read",
          "mcp-name": threadUri,
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 4,
          jsonrpc: "2.0",
          method: "resources/read",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": {
                name: "test-client",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
            uri: threadUri,
          },
        },
        url: "/mcp",
      });

      expect(threadResponse.statusCode, threadResponse.body).toBe(200);
      expect(threadResponse.body).toContain("Retention research");
      expect(readResearchThread).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: principal.workspaceId }),
        threadId,
      );

      const citationUri =
        `citeloom://workspace/research/citations/${citationId}`;
      const citationResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-mcp-token",
          "mcp-method": "resources/read",
          "mcp-name": citationUri,
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 5,
          jsonrpc: "2.0",
          method: "resources/read",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": {
                name: "test-client",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
            uri: citationUri,
          },
        },
        url: "/mcp",
      });

      expect(citationResponse.statusCode, citationResponse.body).toBe(200);
      expect(citationResponse.body).toContain("Supporting evidence.");
      expect(readCitationEvidence).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: principal.workspaceId }),
        citationId,
      );
    } finally {
      await server.close();
    }
  });

  it("requires the Tasks extension for document answers", async () => {
    const settings = buildOAuthAuthenticationSettings();
    const principal = buildOAuthPrincipal();
    const createResearchThread = vi.fn<
      RuntimeWebServices["createResearchThread"]
    >();
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      oauthAuthenticator: {
        authenticate: vi.fn(),
        readIdentityContext: vi.fn(),
        verifyMcpAccess: vi.fn(async () => ({
          principal,
          token: {
            clientId: "test-mcp-client",
            expiresAt: 1_800_000_000,
            issuer: principal.issuer,
            scopes: settings.activeOAuthConfiguration?.mcpScopes ?? [],
            subject: principal.subject,
          },
        })),
      },
      services: buildServices({
        createResearchThread,
        readAuthenticationSettings: async () => settings,
      }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-mcp-token",
          "mcp-method": "tools/call",
          "mcp-name": "citeloom.ask_documents",
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": {
                name: "test-client",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
            arguments: {
              question: "How long are records retained?",
              scope: { kind: "all" },
              threadTitle: "Retention research",
            },
            name: "citeloom.ask_documents",
          },
        },
        url: "/mcp",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        error: {
          code: -32_003,
          data: {
            requiredCapabilities: {
              extensions: {
                "io.modelcontextprotocol/tasks": {},
              },
            },
          },
        },
      });
      expect(createResearchThread).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("enforces MCP transport validation for task requests", async () => {
    const settings = buildOAuthAuthenticationSettings();
    const principal = buildOAuthPrincipal();
    const createResearchThread = vi.fn<
      RuntimeWebServices["createResearchThread"]
    >();
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      oauthAuthenticator: {
        authenticate: vi.fn(),
        readIdentityContext: vi.fn(),
        verifyMcpAccess: vi.fn(async () => ({
          principal,
          token: {
            clientId: "test-mcp-client",
            expiresAt: 1_800_000_000,
            issuer: principal.issuer,
            scopes: settings.activeOAuthConfiguration?.mcpScopes ?? [],
            subject: principal.subject,
          },
        })),
      },
      services: buildServices({
        createResearchThread,
        readAuthenticationSettings: async () => settings,
      }),
      staticDirectory: null,
    });
    const headers = {
      authorization: "Bearer valid-mcp-token",
      "mcp-method": "tools/call",
      "mcp-name": "citeloom.ask_documents",
      "mcp-protocol-version": "2026-07-28",
      "x-citeloom-workspace-name": principal.workspaceName,
    };
    const payload = {
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {
            extensions: { "io.modelcontextprotocol/tasks": {} },
          },
          "io.modelcontextprotocol/clientInfo": {
            name: "test-client",
            version: "1.0.0",
          },
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        },
        arguments: {
          question: "How long are records retained?",
          scope: { kind: "all" },
          threadTitle: "Retention research",
        },
        name: "citeloom.ask_documents",
      },
    };
    try {
      const unacceptableResponse = await server.inject({
        headers: { ...headers, accept: "application/json" },
        method: "POST",
        payload,
        url: "/mcp",
      });
      expect(unacceptableResponse.statusCode).toBe(406);
      expect(unacceptableResponse.json()).toMatchObject({
        error: { code: -32_000 },
      });

      const mediaTypeResponse = await server.inject({
        headers: {
          ...headers,
          accept: "application/json, text/event-stream",
          "content-type": "text/plain",
        },
        method: "POST",
        payload: JSON.stringify(payload),
        url: "/mcp",
      });
      expect(mediaTypeResponse.statusCode).toBe(415);
      expect(mediaTypeResponse.json()).toMatchObject({
        error: { code: -32_000 },
      });

      const protocolResponse = await server.inject({
        headers: {
          ...headers,
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        method: "POST",
        payload,
        url: "/mcp",
      });
      expect(protocolResponse.statusCode).toBe(400);
      expect(protocolResponse.json()).toMatchObject({
        error: {
          code: -32_020,
          data: {
            mismatch: {
              header: "2025-11-25",
            },
          },
        },
      });

      const unknownTaskId = randomUUID();
      const unknownTaskResponse = await server.inject({
        headers: {
          ...headers,
          accept: "application/json, text/event-stream",
          "mcp-method": "tasks/get",
          "mcp-name": unknownTaskId,
        },
        method: "POST",
        payload: {
          id: 2,
          jsonrpc: "2.0",
          method: "tasks/get",
          params: {
            _meta: payload.params._meta,
            taskId: unknownTaskId,
          },
        },
        url: "/mcp",
      });
      expect(unknownTaskResponse.statusCode).toBe(200);
      expect(unknownTaskResponse.json()).toMatchObject({
        error: { code: -32_602 },
      });
      expect(createResearchThread).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("cancels an asynchronous document-answer task", async () => {
    const settings = buildOAuthAuthenticationSettings();
    const principal = buildOAuthPrincipal();
    const streamAnswer = vi.fn<RuntimeWebServices["streamAnswer"]>(
      (_principal, _request, abortSignal) => {
        return new ReadableStream({
          start(controller) {
            abortSignal.addEventListener("abort", () => {
              controller.error(abortSignal.reason);
            }, { once: true });
          },
        });
      },
    );
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      oauthAuthenticator: {
        authenticate: vi.fn(),
        readIdentityContext: vi.fn(),
        verifyMcpAccess: vi.fn(async () => ({
          principal,
          token: {
            clientId: "test-mcp-client",
            expiresAt: 1_800_000_000,
            issuer: principal.issuer,
            scopes: settings.activeOAuthConfiguration?.mcpScopes ?? [],
            subject: principal.subject,
          },
        })),
      },
      services: buildServices({
        readAuthenticationSettings: async () => settings,
        resolveOAuthPrincipal: async () => principal,
        streamAnswer,
      }),
      staticDirectory: null,
    });
    const taskMeta = {
      "io.modelcontextprotocol/clientCapabilities": {
        extensions: { "io.modelcontextprotocol/tasks": {} },
      },
      "io.modelcontextprotocol/clientInfo": {
        name: "test-client",
        version: "1.0.0",
      },
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    };
    try {
      const createResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-mcp-token",
          "mcp-method": "tools/call",
          "mcp-name": "citeloom.ask_documents",
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            _meta: taskMeta,
            arguments: {
              question: "How long are records retained?",
              scope: { kind: "all" },
              threadTitle: "Retention research",
            },
            name: "citeloom.ask_documents",
          },
        },
        url: "/mcp",
      });
      const taskId = createResponse.json().result.taskId as string;
      await vi.waitFor(() => expect(streamAnswer).toHaveBeenCalledOnce());

      const cancelResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-mcp-token",
          "mcp-method": "tasks/cancel",
          "mcp-name": taskId,
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 2,
          jsonrpc: "2.0",
          method: "tasks/cancel",
          params: { _meta: taskMeta, taskId },
        },
        url: "/mcp",
      });
      expect(cancelResponse.json()).toMatchObject({
        result: { resultType: "complete" },
      });

      await vi.waitFor(async () => {
        const taskResponse = await server.inject({
          headers: {
            accept: "application/json, text/event-stream",
            authorization: "Bearer valid-mcp-token",
            "mcp-method": "tasks/get",
            "mcp-name": taskId,
            "mcp-protocol-version": "2026-07-28",
            "x-citeloom-workspace-name": principal.workspaceName,
          },
          method: "POST",
          payload: {
            id: 3,
            jsonrpc: "2.0",
            method: "tasks/get",
            params: { _meta: taskMeta, taskId },
          },
          url: "/mcp",
        });
        expect(taskResponse.json()).toMatchObject({
          result: { resultType: "complete", status: "cancelled" },
        });
      });
    } finally {
      await server.close();
    }
  });

  it("dispatches an unclaimed document-answer task after restart", async () => {
    const settings = buildOAuthAuthenticationSettings();
    const principal = buildOAuthPrincipal();
    const tasks = createInMemoryMcpTaskServices();
    const owner = {
      clientId: "test-mcp-client",
      issuer: principal.issuer,
      subject: principal.subject,
      userId: principal.userId,
      workspaceId: principal.workspaceId,
    };
    const task = await tasks.create(owner, {
      question: "How long are records retained?",
      scope: { kind: "all" },
      threadTitle: "Retention research",
    });
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        mcpTasks: tasks,
        readAuthenticationSettings: async () => settings,
        resolveOAuthPrincipal: async () => principal,
        streamAnswer: () => createAnswerStream("Seven years."),
      }),
      staticDirectory: null,
    });
    try {
      await vi.waitFor(async () => {
        await expect(tasks.readForOwner(owner, task.id)).resolves.toMatchObject({
          status: "completed",
        });
      });
    } finally {
      await server.close();
    }
  });

  it("revalidates an API key task in its stored workspace after restart", async () => {
    const principal = buildAuthenticatedPrincipal("member", "standard");
    const apiKeyId = "00000000-0000-4000-8000-000000000811";
    const tasks = createInMemoryMcpTaskServices();
    const owner = {
      clientId: apiKeyId,
      issuer: MCP_API_KEY_TASK_ISSUER,
      subject: principal.userId,
      userId: principal.userId,
      workspaceId: principal.workspaceId,
    };
    const task = await tasks.create(owner, {
      question: "How long are records retained?",
      scope: { kind: "all" },
      threadTitle: "Retention research",
    });
    const resolveMcpApiKeyPrincipal = vi.fn<
      WebServices["resolveMcpApiKeyPrincipal"]
    >(async () => ({
      apiKeyId,
      expiresAt: 1_800_000_000,
      principal,
      scopes: ["citeloom.answer"],
    }));
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        mcpTasks: tasks,
        resolveMcpApiKeyPrincipal,
        streamAnswer: () => createAnswerStream("Seven years."),
      }),
      staticDirectory: null,
    });
    try {
      await vi.waitFor(async () => {
        await expect(tasks.readForOwner(owner, task.id)).resolves.toMatchObject({
          status: "completed",
        });
      });
      expect(resolveMcpApiKeyPrincipal).toHaveBeenCalledWith(
        apiKeyId,
        principal.workspaceId,
        ["citeloom.answer"],
      );
    } finally {
      await server.close();
    }
  });

  it("limits MCP discovery and calls to the token's operation scopes", async () => {
    const settings = buildOAuthAuthenticationSettings();
    const principal = buildOAuthPrincipal();
    const streamAnswer = vi.fn<RuntimeWebServices["streamAnswer"]>(
      () => createAnswerStream("Unexpected answer"),
    );
    const verifyMcpAccess = vi.fn(async (
      _settings,
      _authorizationHeader,
      _workspaceId,
      requiredScopes: readonly string[],
    ) => {
      if (requiredScopes.includes("citeloom.answer")) {
        throw new OAuthInsufficientScopeError(["citeloom.answer"]);
      }
      return {
        principal,
        token: {
          clientId: "search-only-client",
          expiresAt: 1_800_000_000,
          issuer: principal.issuer,
          scopes: ["citeloom.search"],
          subject: principal.subject,
        },
      };
    });
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      oauthAuthenticator: {
        authenticate: vi.fn(),
        readIdentityContext: vi.fn(),
        verifyMcpAccess,
      },
      services: buildServices({
        readAuthenticationSettings: async () => settings,
        streamAnswer,
      }),
      staticDirectory: null,
    });
    try {
      const discoveryResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer search-only-token",
          "mcp-method": "server/discover",
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 1,
          jsonrpc: "2.0",
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": {
                name: "search-only-client",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
          },
        },
        url: "/mcp",
      });
      expect(discoveryResponse.statusCode, discoveryResponse.body).toBe(200);
      expect(discoveryResponse.json().result.capabilities.extensions)
        .toBeUndefined();
      expect(discoveryResponse.json().result.instructions).toContain(
        MCP_SEARCH_TOOL,
      );
      expect(discoveryResponse.json().result.instructions).not.toContain(
        MCP_ANSWER_TOOL,
      );

      const listResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer search-only-token",
          "mcp-method": "tools/list",
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 1,
          jsonrpc: "2.0",
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": {
                name: "test-client",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
          },
        },
        url: "/mcp",
      });

      expect(listResponse.statusCode).toBe(200);
      expect(listResponse.body).toContain("citeloom.search_sources");
      expect(listResponse.body).not.toContain("citeloom.ask_documents");

      const promptsResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer search-only-token",
          "mcp-method": "prompts/list",
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 2,
          jsonrpc: "2.0",
          method: "prompts/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": {
                name: "search-only-client",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
          },
        },
        url: "/mcp",
      });
      expect(promptsResponse.statusCode, promptsResponse.body).toBe(200);
      expect(promptsResponse.body).toContain(MCP_SEARCH_PROMPT);
      expect(promptsResponse.body).not.toContain(MCP_ANSWER_PROMPT);

      const answerResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer search-only-token",
          "mcp-method": "tools/call",
          "mcp-name": "citeloom.ask_documents",
          "mcp-protocol-version": "2026-07-28",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 2,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": {
                name: "test-client",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
            arguments: {
              question: "How long are records retained?",
              scope: { kind: "all" },
              threadTitle: "Retention research",
            },
            name: "citeloom.ask_documents",
          },
        },
        url: "/mcp",
      });

      expect(answerResponse.statusCode).toBe(403);
      expect(answerResponse.headers["www-authenticate"]).toContain(
        'scope="citeloom.answer"',
      );
      expect(streamAnswer).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects authenticated legacy MCP initialization", async () => {
    const settings = buildOAuthAuthenticationSettings();
    const principal = buildOAuthPrincipal();
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      oauthAuthenticator: {
        authenticate: vi.fn(),
        readIdentityContext: vi.fn(),
        verifyMcpAccess: vi.fn(async () => ({
          principal,
          token: {
            clientId: "test-mcp-client",
            expiresAt: 1_800_000_000,
            issuer: principal.issuer,
            scopes: settings.activeOAuthConfiguration?.mcpScopes ?? [],
            subject: principal.subject,
          },
        })),
      },
      services: buildServices({
        readAuthenticationSettings: async () => settings,
      }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-mcp-token",
          "x-citeloom-workspace-name": principal.workspaceName,
        },
        method: "POST",
        payload: {
          id: 1,
          jsonrpc: "2.0",
          method: "initialize",
          params: {
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0.0" },
            protocolVersion: "2025-11-25",
          },
        },
        url: "/mcp",
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: -32_022,
          data: { supported: ["2026-07-28"] },
        },
      });
    } finally {
      await server.close();
    }
  });

});
