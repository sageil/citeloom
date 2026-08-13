import { describe, expect, it, vi } from "vitest";

import {
  MCP_ANSWER_TOOL,
  MCP_PROTOCOL_VERSION,
  MCP_WORKSPACE_NAME_HEADER,
} from "../src/mcp/contract.js";
import { MCP_TASK_EXTENSION_ID } from "../src/mcp/tasks/model.js";
import { McpTaskExtensionClient } from "./task-client.js";

const TASK_ID = "00000000-0000-4000-8000-000000000002";

describe("MCP draft Tasks extension client", () => {
  it("creates an answer task with explicit extension metadata and headers", async () => {
    let sentInit: RequestInit | undefined;
    const fetchImplementation = vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      sentInit = init;
      return Response.json({
        id: 1,
        jsonrpc: "2.0",
        result: {
          _meta: {
            "io.modelcontextprotocol/serverInfo": {
              name: "citeloom",
              version: "1.0.0",
            },
          },
          createdAt: "2026-08-13T18:00:00.000Z",
          lastUpdatedAt: "2026-08-13T18:00:00.000Z",
          resultType: "task",
          status: "working",
          taskId: TASK_ID,
          ttlMs: 30 * 24 * 60 * 60 * 1_000,
        },
      });
    });
    const client = new McpTaskExtensionClient({
      fetchImplementation,
      serverUrl: "https://citeloom.example/mcp",
      tokenProvider: { accessToken: () => "access-token" },
      workspaceName: "DefaultSpace",
    });

    const task = await client.createAnswerTask({
      question: "What is the retention period?",
      scope: { kind: "all" },
      threadTitle: "Retention research",
    }, new AbortController().signal);

    expect(task.taskId).toBe(TASK_ID);
    const headers = new Headers(sentInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer access-token");
    expect(headers.get("mcp-method")).toBe("tools/call");
    expect(headers.get("mcp-name")).toBe(MCP_ANSWER_TOOL);
    expect(headers.get("mcp-protocol-version")).toBe(MCP_PROTOCOL_VERSION);
    expect(headers.get(MCP_WORKSPACE_NAME_HEADER)).toBe("DefaultSpace");
    const body = JSON.parse(String(sentInit?.body)) as unknown;
    expect(body).toMatchObject({
      id: 1,
      jsonrpc: "2.0",
      method: "tools/call",
      params: {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": {
            extensions: { [MCP_TASK_EXTENSION_ID]: {} },
          },
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_VERSION,
        },
        arguments: {
          question: "What is the retention period?",
        },
        name: MCP_ANSWER_TOOL,
      },
    });
  });

  it("surfaces a JSON-RPC task error", async () => {
    const client = new McpTaskExtensionClient({
      fetchImplementation: async () => Response.json({
        error: { code: -32_602, message: "Task not found" },
        id: 1,
        jsonrpc: "2.0",
      }),
      serverUrl: "https://citeloom.example/mcp",
      tokenProvider: { accessToken: () => "access-token" },
      workspaceName: "DefaultSpace",
    });

    await expect(client.readTask(
      TASK_ID,
      new AbortController().signal,
    )).rejects.toThrow("MCP task request failed (-32602): Task not found");
  });
});
