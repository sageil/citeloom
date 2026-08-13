import { describe, expect, it, vi } from "vitest";

import { MCP_WORKSPACE_NAME_HEADER } from "../src/mcp/contract.js";
import { createMcpRequestFetch } from "./request-fetch.js";

const MCP_URL = "https://citeloom.example/mcp";
const WORKSPACE_NAME = "DefaultSpace";

describe("MCP request fetch adapter", () => {
  it("adds the selected workspace name to MCP requests", async () => {
    let sentInit: RequestInit | undefined;
    const fetchImplementation = vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      sentInit = init;
      return Response.json({ ok: true });
    });
    const request = createMcpRequestFetch(
      MCP_URL,
      WORKSPACE_NAME,
      fetchImplementation,
    );

    await request(MCP_URL, {
      body: "{}",
      headers: { "mcp-method": "tools/list" },
      method: "POST",
    });

    const headers = new Headers(sentInit?.headers);
    expect(headers.get(MCP_WORKSPACE_NAME_HEADER)).toBe(WORKSPACE_NAME);
  });

  it("does not send the workspace selector to the authorization server", async () => {
    const fetchImplementation = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => Response.json({ ok: true }));
    const request = createMcpRequestFetch(
      MCP_URL,
      WORKSPACE_NAME,
      fetchImplementation,
    );

    await request("https://identity.example/oidc/token", { method: "POST" });

    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://identity.example/oidc/token",
      { method: "POST" },
    );
  });

  it("omits a workspace selector for a workspace-bound API key", async () => {
    let sentInit: RequestInit | undefined;
    const request = createMcpRequestFetch(
      MCP_URL,
      null,
      async (_input, init) => {
        sentInit = init;
        return Response.json({ ok: true });
      },
    );

    await request(MCP_URL, { method: "POST" });

    const headers = new Headers(sentInit?.headers);
    expect(headers.has(MCP_WORKSPACE_NAME_HEADER)).toBe(false);
  });
});
