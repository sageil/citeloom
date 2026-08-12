import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createWorkspaceUserManagement,
} from "../web/assets/scripts/workspace-users.js";
import {
  findHtmlElementByAttribute,
  htmlElementHasClass,
  readHtmlElements,
} from "./html-test-helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CiteLoom workspace user access", () => {
  it("uses the workspace editor to add existing accounts only", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/settings.html", import.meta.url),
      "utf8",
    );

    expect(fragment).toContain("Manage membership, roles, and access");
    expect(fragment).toContain("Add user");
    expect(fragment).not.toContain("Add existing user");
    expect(fragment).toContain("Give an existing CiteLoom account access");
    expect(fragment).toContain('candidate in memberCandidates');
    expect(fragment).not.toContain("create a new account");
    expect(fragment).not.toContain('x-model="newUsername"');
    expect(fragment).not.toContain('x-model="newDisplayName"');
    expect(fragment).not.toContain("Create reset link");
    expect(fragment).not.toContain("passwordResetUrl");
    expect(fragment).toContain('@change="changeRole(member, $event.target.value)"');
    expect(fragment).toContain('@change="changeAccess(member, $event.target.value)"');
    expect(fragment).toContain("member.globalRole === 'global_admin'");
    expect(fragment).toContain("member.userId === currentUserId");
  });

  it("uses one control size for role, access, and actions", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/settings.html", import.meta.url),
      "utf8",
    );
    const elements = readHtmlElements(fragment);
    const roleControl = findHtmlElementByAttribute(
      elements,
      "@change",
      "changeRole(member, $event.target.value)",
    );
    const accessControl = findHtmlElementByAttribute(
      elements,
      "@change",
      "changeAccess(member, $event.target.value)",
    );
    const actionControl = findHtmlElementByAttribute(
      elements,
      ":aria-label",
      "`Workspace actions for ${member.username}`",
    );

    expect(htmlElementHasClass(roleControl, "access-user-row-control")).toBe(true);
    expect(htmlElementHasClass(accessControl, "access-user-row-control")).toBe(true);
    expect(htmlElementHasClass(actionControl, "access-user-row-control")).toBe(true);
  });

  it("keeps account-security operations out of workspace membership", () => {
    const page = createWorkspaceUserManagement();

    expect(page).not.toHaveProperty("requestPasswordReset");
    expect(page).not.toHaveProperty("createPasswordReset");
    expect(page).not.toHaveProperty("passwordResetUrl");
  });

  it("adds a selected existing account without account profile data", async () => {
    const page = createWorkspaceUserManagement();
    page.settings = {
      scope: {
        id: "00000000-0000-4000-8000-000000000601",
        kind: "workspace",
      },
    };
    page.selectedMemberCandidateId =
      "00000000-0000-4000-8000-000000000501";
    page.memberRoleDraft = "member";
    page.loadUsers = vi.fn(async () => undefined);
    page.afterWorkspaceUserMutation = vi.fn(async () => undefined);
    const fetchRequest = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchRequest);

    await page.addWorkspaceMember();

    expect(fetchRequest).toHaveBeenCalledWith(
      "/api/workspaces/00000000-0000-4000-8000-000000000601/members",
      {
        body: JSON.stringify({
          role: "member",
          userId: "00000000-0000-4000-8000-000000000501",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      },
    );
    expect(page.loadUsers).toHaveBeenCalledOnce();
    expect(page.afterWorkspaceUserMutation).toHaveBeenCalledOnce();
  });

  it("sends a typed access change and refreshes the same table", async () => {
    const page = createWorkspaceUserManagement();
    page.settings = {
      scope: {
        id: "00000000-0000-4000-8000-000000000601",
        kind: "workspace",
      },
    };
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
      "/api/workspaces/00000000-0000-4000-8000-000000000601/members/00000000-0000-4000-8000-000000000501/access",
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
