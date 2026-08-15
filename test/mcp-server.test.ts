import { describe, expect, it, vi } from "vitest";

import {
  buildWebServer as buildProductionWebServer,
  type RuntimeWebServices,
  type WebServices,
} from "../src/web-server.js";
import { OAuthInsufficientScopeError } from "../src/oauth/access-token.js";
import {
  MCP_ANSWER_CANCEL_TOOL,
  MCP_ANSWER_PROMPT,
  MCP_ANSWER_STATUS_TOOL,
  MCP_ANSWER_TOOL,
  MCP_API_KEY_TASK_ISSUER,
  MCP_SEARCH_PROMPT,
  MCP_SEARCH_TOOL,
  MCP_SERVER_DESCRIPTION,
  MCP_SERVER_TITLE,
  MCP_WORKSPACE_CONTEXT_RESOURCE,
} from "../src/mcp/mcp.js";
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

const MCP_URL = "/mcp";

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

  it("rejects authenticated GET requests because MCP uses POST", async () => {
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
        url: MCP_URL,
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
        url: MCP_URL,
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: "invalid_token" });
    } finally {
      await server.close();
    }
  });

  it("serves a user-bound MCP API key across its available workspaces", async () => {
    const principal = buildAuthenticatedPrincipal("member", "standard");
    const apiKeyId = "00000000-0000-4000-8000-000000000810";
    const authenticateMcpApiKey = vi.fn<WebServices["authenticateMcpApiKey"]>(
      async () => ({
        apiKeyId,
        expiresAt: 1_800_000_000,
        principals: [principal],
        scopes: ["citeloom.search", "citeloom.answer"],
      }),
    );
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ authenticateMcpApiKey }),
      staticDirectory: null,
    });
    const requestMetadata = {
      "io.modelcontextprotocol/clientCapabilities": {},
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
        url: MCP_URL,
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(authenticateMcpApiKey).toHaveBeenCalledWith(
        "bEaReR clm_mcp_test-key",
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
            prompts: { listChanged: false },
            resources: { listChanged: false },
            tools: { listChanged: false },
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
        },
        method: "POST",
        payload: {
          id: 2,
          jsonrpc: "2.0",
          method: "tools/list",
          params: { _meta: requestMetadata },
        },
        url: MCP_URL,
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
                properties: expect.objectContaining({
                  results: expect.any(Object),
                }),
              }),
              title: "Search CiteLoom sources",
            }),
            expect.objectContaining({
              description: expect.stringContaining("task ID"),
              name: MCP_ANSWER_TOOL,
              title: "Ask CiteLoom documents",
            }),
            expect.objectContaining({
              name: MCP_ANSWER_STATUS_TOOL,
              title: "Get a CiteLoom answer",
            }),
            expect.objectContaining({
              name: MCP_ANSWER_CANCEL_TOOL,
              title: "Cancel a CiteLoom answer",
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
        },
        method: "POST",
        payload: {
          id: 3,
          jsonrpc: "2.0",
          method: "prompts/list",
          params: { _meta: requestMetadata },
        },
        url: MCP_URL,
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
        url: MCP_URL,
      });
      expect(promptResponse.statusCode, promptResponse.body).toBe(200);
      expect(promptResponse.body).toContain(MCP_ANSWER_TOOL);
      expect(promptResponse.body).toContain(MCP_ANSWER_STATUS_TOOL);
      expect(promptResponse.body).toContain("Retention policy");

      const resourcesResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer clm_mcp_test-key",
          "mcp-method": "resources/list",
          "mcp-protocol-version": "2026-07-28",
        },
        method: "POST",
        payload: {
          id: 5,
          jsonrpc: "2.0",
          method: "resources/list",
          params: { _meta: requestMetadata },
        },
        url: MCP_URL,
      });
      expect(resourcesResponse.statusCode, resourcesResponse.body).toBe(200);
      expect(resourcesResponse.json()).toMatchObject({
        result: {
          resources: [expect.objectContaining({
            description: expect.stringContaining("every workspace"),
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
        },
        method: "POST",
        payload: {
          id: 6,
          jsonrpc: "2.0",
          method: "resources/templates/list",
          params: { _meta: requestMetadata },
        },
        url: MCP_URL,
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

  it("serves authenticated modern MCP requests across available workspaces", async () => {
    const settings = buildOAuthAuthenticationSettings();
    const principal = buildOAuthPrincipal();
    const secondPrincipal = {
      ...principal,
      role: "member" as const,
      workspaceId: "00000000-0000-4000-8000-000000000304",
      workspaceName: "Second Workspace",
    };
    let currentPrincipals = [principal, secondPrincipal];
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
      principals: currentPrincipals,
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
        resolveOAuthPrincipals: async () => currentPrincipals,
        searchSources,
        streamAnswer,
      }),
      staticDirectory: null,
    });
    const requestMetadata = {
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": {
        name: "test-client",
        version: "1.0.0",
      },
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    };
    try {
      const response = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-mcp-token",
          "mcp-method": "server/discover",
          "mcp-protocol-version": "2026-07-28",
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
        url: MCP_URL,
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("citeloom");
      expect(response.body).toContain("2026-07-28");
      expect(response.json().result.capabilities.extensions).toBeUndefined();

      const toolResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-mcp-token",
          "mcp-method": "tools/call",
          "mcp-name": "citeloom.search_sources",
          "mcp-protocol-version": "2026-07-28",
        },
        method: "POST",
        payload: {
          id: 2,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            _meta: requestMetadata,
            arguments: {
              includeRelated: false,
              keywordPage: 1,
              query: "retention requirements",
              scope: { kind: "all" },
            },
            name: "citeloom.search_sources",
          },
        },
        url: MCP_URL,
      });

      expect(toolResponse.statusCode).toBe(200);
      expect(toolResponse.body).toContain("structuredContent");
      expect(searchSources).toHaveBeenCalledWith(
        expect.objectContaining({
          dataScope: principal.dataScope,
          userId: principal.userId,
        }),
        {
          includeRelated: false,
          keywordPage: 1,
          query: "retention requirements",
          scope: { kind: "all" },
        },
        expect.objectContaining({ aborted: expect.any(Boolean) }),
        [principal.workspaceId, secondPrincipal.workspaceId],
      );
      expect(searchSources).toHaveBeenCalledOnce();
      expect(toolResponse.json().result.structuredContent).toMatchObject({
        query: "loan",
        results: expect.any(Object),
      });
      expect(verifyMcpAccess).toHaveBeenCalledWith(
        settings,
        "Bearer valid-mcp-token",
        ["citeloom.search"],
      );

      const answerResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-mcp-token",
          "mcp-method": "tools/call",
          "mcp-name": "citeloom.ask_documents",
          "mcp-protocol-version": "2026-07-28",
        },
        method: "POST",
        payload: {
          id: 3,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            _meta: requestMetadata,
            arguments: {
              question: "How long are records retained?",
              scope: { kind: "all" },
              threadTitle: "Retention research",
            },
            name: "citeloom.ask_documents",
          },
        },
        url: MCP_URL,
      });

      expect(answerResponse.statusCode).toBe(200);
      expect(answerResponse.json()).toMatchObject({
        result: {
          _meta: {
            "io.modelcontextprotocol/serverInfo": {
              name: "citeloom",
            },
          },
          structuredContent: {
            pollIntervalMs: 1_000,
            status: "working",
          },
        },
      });
      const taskId = answerResponse.json().result.structuredContent
        .taskId as string;
      let completedStatus: unknown = null;
      await vi.waitFor(async () => {
        const statusResponse = await server.inject({
          headers: {
            accept: "application/json, text/event-stream",
            authorization: "Bearer valid-mcp-token",
            "mcp-method": "tools/call",
            "mcp-name": MCP_ANSWER_STATUS_TOOL,
            "mcp-protocol-version": "2026-07-28",
          },
          method: "POST",
          payload: {
            id: 4,
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
              _meta: requestMetadata,
              arguments: { taskId },
              name: MCP_ANSWER_STATUS_TOOL,
            },
          },
          url: MCP_URL,
        });
        expect(statusResponse.statusCode).toBe(200);
        const status = statusResponse.json().result.structuredContent;
        expect(status.status).toBe("completed");
        completedStatus = status;
      });
      expect(completedStatus).toMatchObject({
        answer: {
          answerDocument: {
            content: "The retention period is seven years.",
          },
        },
        resources: [],
        status: "completed",
        taskId,
        workspaceIds: [principal.workspaceId, secondPrincipal.workspaceId],
      });
      expect(createResearchThread).toHaveBeenCalledWith(
        expect.objectContaining({ dataScope: "all" }),
        "Retention research",
      );
      expect(streamAnswer).toHaveBeenCalledWith(
        expect.objectContaining({ dataScope: "all" }),
        {
          question: "How long are records retained?",
          scope: { kind: "all" },
          threadId,
        },
        expect.objectContaining({ aborted: expect.any(Boolean) }),
        [principal.workspaceId, secondPrincipal.workspaceId],
      );
      expect(createResearchThread).toHaveBeenCalledOnce();
      expect(streamAnswer).toHaveBeenCalledOnce();
      expect(verifyMcpAccess).toHaveBeenLastCalledWith(
        settings,
        "Bearer valid-mcp-token",
        ["citeloom.answer"],
      );

      currentPrincipals = [principal];
      const filteredStatusResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-mcp-token",
          "mcp-method": "tools/call",
          "mcp-name": MCP_ANSWER_STATUS_TOOL,
          "mcp-protocol-version": "2026-07-28",
        },
        method: "POST",
        payload: {
          id: 5,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            _meta: requestMetadata,
            arguments: { taskId },
            name: MCP_ANSWER_STATUS_TOOL,
          },
        },
        url: MCP_URL,
      });
      expect(filteredStatusResponse.statusCode).toBe(200);
      expect(
        filteredStatusResponse.json().result.structuredContent,
      ).toMatchObject({
        error: expect.objectContaining({
          message: expect.stringContaining("no longer available"),
        }),
        status: "failed",
      });

      const threadUri = `citeloom://workspaces/${principal.workspaceId}/research/threads/${threadId}`;
      const threadResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-mcp-token",
          "mcp-method": "resources/read",
          "mcp-name": threadUri,
          "mcp-protocol-version": "2026-07-28",
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
        url: MCP_URL,
      });

      expect(threadResponse.statusCode, threadResponse.body).toBe(200);
      expect(threadResponse.body).toContain("Retention research");
      expect(readResearchThread).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: principal.workspaceId }),
        threadId,
      );

      const citationUri =
        `citeloom://workspaces/${principal.workspaceId}/research/citations/${citationId}`;
      const citationResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-mcp-token",
          "mcp-method": "resources/read",
          "mcp-name": citationUri,
          "mcp-protocol-version": "2026-07-28",
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
        url: MCP_URL,
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

  it("completes document answers through standard tools", async () => {
    const settings = buildOAuthAuthenticationSettings();
    const principal = buildOAuthPrincipal();
    const createResearchThread = vi.fn<
      RuntimeWebServices["createResearchThread"]
    >(async (_principal, title) => ({
      createdAt: "2026-07-15T12:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000001",
      title,
      turns: [],
      updatedAt: "2026-07-15T12:00:00.000Z",
    }));
    const streamAnswer = vi.fn<RuntimeWebServices["streamAnswer"]>(
      () => createAnswerStream("The retention period is seven years."),
    );
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      oauthAuthenticator: {
        authenticate: vi.fn(),
        readIdentityContext: vi.fn(),
        verifyMcpAccess: vi.fn(async () => ({
          principals: [principal],
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
        resolveOAuthPrincipals: async () => [principal],
        streamAnswer,
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
        url: MCP_URL,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        result: {
          resultType: "complete",
          structuredContent: {
            pollIntervalMs: 1_000,
            status: "working",
          },
        },
      });
      const taskId = response.json().result.structuredContent.taskId as string;
      let completedStatus: unknown = null;
      await vi.waitFor(async () => {
        const statusResponse = await server.inject({
          headers: {
            accept: "application/json, text/event-stream",
            authorization: "Bearer valid-mcp-token",
            "mcp-method": "tools/call",
            "mcp-name": MCP_ANSWER_STATUS_TOOL,
            "mcp-protocol-version": "2026-07-28",
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
              arguments: { taskId },
              name: MCP_ANSWER_STATUS_TOOL,
            },
          },
          url: MCP_URL,
        });
        expect(statusResponse.statusCode, statusResponse.body).toBe(200);
        const structuredContent = statusResponse.json().result.structuredContent;
        expect(structuredContent.status).toBe("completed");
        completedStatus = structuredContent;
      });
      expect(completedStatus).toMatchObject({
        answer: {
          answerDocument: {
            content: "The retention period is seven years.",
          },
        },
        resources: [],
        status: "completed",
        taskId,
        workspaceIds: [principal.workspaceId],
      });
      expect(createResearchThread).toHaveBeenCalledOnce();
      expect(streamAnswer).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("cancels a document-answer task through standard tools", async () => {
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
          principals: [principal],
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
        resolveOAuthPrincipals: async () => [principal],
        streamAnswer,
      }),
      staticDirectory: null,
    });
    const coreMeta = {
      "io.modelcontextprotocol/clientCapabilities": {},
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
        },
        method: "POST",
        payload: {
          id: 1,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            _meta: coreMeta,
            arguments: {
              question: "How long are records retained?",
              scope: { kind: "all" },
              threadTitle: "Retention research",
            },
            name: "citeloom.ask_documents",
          },
        },
        url: MCP_URL,
      });
      const taskId = createResponse.json().result.structuredContent
        .taskId as string;
      await vi.waitFor(() => expect(streamAnswer).toHaveBeenCalledOnce());

      const cancelResponse = await server.inject({
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer valid-mcp-token",
          "mcp-method": "tools/call",
          "mcp-name": MCP_ANSWER_CANCEL_TOOL,
          "mcp-protocol-version": "2026-07-28",
        },
        method: "POST",
        payload: {
          id: 2,
          jsonrpc: "2.0",
          method: "tools/call",
          params: {
            _meta: coreMeta,
            arguments: { taskId },
            name: MCP_ANSWER_CANCEL_TOOL,
          },
        },
        url: MCP_URL,
      });
      expect(cancelResponse.json()).toMatchObject({
        result: {
          structuredContent: { cancellationRequested: true, taskId },
        },
      });

      await vi.waitFor(async () => {
        const taskResponse = await server.inject({
          headers: {
            accept: "application/json, text/event-stream",
            authorization: "Bearer valid-mcp-token",
            "mcp-method": "tools/call",
            "mcp-name": MCP_ANSWER_STATUS_TOOL,
            "mcp-protocol-version": "2026-07-28",
          },
          method: "POST",
          payload: {
            id: 3,
            jsonrpc: "2.0",
            method: "tools/call",
            params: {
              _meta: coreMeta,
              arguments: { taskId },
              name: MCP_ANSWER_STATUS_TOOL,
            },
          },
          url: MCP_URL,
        });
        expect(taskResponse.json()).toMatchObject({
          result: {
            structuredContent: { status: "cancelled", taskId },
          },
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
        resolveOAuthPrincipals: async () => [principal],
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

  it("revalidates an API key task across its current workspaces after restart", async () => {
    const principal = buildAuthenticatedPrincipal("member", "standard");
    const apiKeyId = "00000000-0000-4000-8000-000000000811";
    const tasks = createInMemoryMcpTaskServices();
    const owner = {
      clientId: apiKeyId,
      issuer: MCP_API_KEY_TASK_ISSUER,
      subject: principal.userId,
      userId: principal.userId,
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
      principals: [principal],
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
      requiredScopes: readonly string[],
    ) => {
      if (requiredScopes.includes("citeloom.answer")) {
        throw new OAuthInsufficientScopeError(["citeloom.answer"]);
      }
      return {
        principals: [principal],
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
        url: MCP_URL,
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
        url: MCP_URL,
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
        url: MCP_URL,
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
        url: MCP_URL,
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
          principals: [principal],
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
        url: MCP_URL,
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
