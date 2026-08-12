import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkspaceUserManagement,
} from "../web/assets/scripts/workspace-users.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CiteLoom workspace user access", () => {
  it("uses the existing workspace user table for roles and access", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/workspace-users-management.html", import.meta.url),
      "utf8",
    );

    expect(fragment).toContain("Manage membership, roles, and access");
    expect(fragment).toContain('@change="changeRole(member, $event.target.value)"');
    expect(fragment).toContain('@change="changeAccess(member, $event.target.value)"');
    expect(fragment).toContain("member.globalRole === 'global_admin'");
    expect(fragment).toContain("member.userId === currentUserId");
  });

  it("sends a typed access change and refreshes the same table", async () => {
    const page = createWorkspaceUserManagement();
    page.loadUsers = vi.fn(async () => undefined);
    page.afterWorkspaceUserMutation = vi.fn(async () => undefined);
    const fetchRequest = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchRequest);
    vi.stubGlobal("window", new EventTarget());
    const member = {
      access: "enabled",
      displayName: "Workspace Member",
      globalRole: "standard",
      role: "member",
      state: "active",
      userId: "00000000-0000-4000-8000-000000000501",
      username: "workspace-member",
    };

    await page.changeAccess(member, "disabled");

    expect(fetchRequest).toHaveBeenCalledWith(
      "/api/workspace/members/00000000-0000-4000-8000-000000000501/access",
      {
        body: JSON.stringify({ access: "disabled" }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      },
    );
    expect(page.loadUsers).toHaveBeenCalledOnce();
    expect(page.afterWorkspaceUserMutation).toHaveBeenCalledOnce();
  });
});
