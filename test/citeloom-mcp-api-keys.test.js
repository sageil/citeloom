import { describe, expect, it, vi } from "vitest";

import {
  createMcpApiKeyManagement,
} from "../web/assets/scripts/mcp-api-keys.js";

describe("CiteLoom MCP API key management", () => {
  it("creates a key for the selected user without sending an administrator owner", async () => {
    const page = {
      ...createMcpApiKeyManagement(),
      accountError: "",
    };
    const userId = "00000000-0000-4000-8000-000000000701";
    page.mcpApiKeyUser = {
      currentWorkspaceAccess: true,
      displayName: "Jane Doe",
      state: "active",
      userId,
    };
    const fetchRequest = vi.fn(async () => Response.json({
      apiKey: `clm_mcp_${"a".repeat(80)}`,
      createdAt: "2026-08-13T19:00:00.000Z",
      expiresAt: "2026-11-11T19:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000702",
      label: "Codex",
      revokedAt: null,
      scopes: ["citeloom.search", "citeloom.answer"],
      userId,
      workspaceId: "00000000-0000-4000-8000-000000000703",
      workspaceName: "DefaultSpace",
    }, { status: 201 }));
    vi.stubGlobal("fetch", fetchRequest);
    page.mcpApiKeyLabel = "Codex";

    await page.createMcpApiKey();

    expect(fetchRequest).toHaveBeenCalledOnce();
    const [url, init] = fetchRequest.mock.calls[0];
    expect(url).toBe(`/api/security/users/${userId}/mcp-api-keys`);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({
      label: "Codex",
      scopes: ["citeloom.search", "citeloom.answer"],
    });
    expect(body).not.toHaveProperty("createdByUserId");
    expect(body).not.toHaveProperty("userId");
    expect(body).not.toHaveProperty("workspaceId");
    expect(page.mcpApiKeySecret).toContain("clm_mcp_");
  });
});
