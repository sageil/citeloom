import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  buildWebServer as buildProductionWebServer,
  type RuntimeWebServices,
  type WebServices,
} from "../src/web-server.js";
import { OAuthInsufficientScopeError } from "../src/oauth/access-token.js";
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

  it("serves a workspace-bound MCP API key without OAuth or a workspace header", async () => {
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
            _meta: {
              "io.modelcontextprotocol/clientCapabilities": {
                extensions: { "io.modelcontextprotocol/tasks": {} },
              },
              "io.modelcontextprotocol/clientInfo": {
                name: "api-key-client",
                version: "1.0.0",
              },
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            },
          },
        },
        url: "/mcp",
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(authenticateMcpApiKey).toHaveBeenCalledWith(
        "bEaReR clm_mcp_test-key",
        [],
      );
      expect(response.body).toContain("io.modelcontextprotocol/tasks");
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
