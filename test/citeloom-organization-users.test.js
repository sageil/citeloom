import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createOrganizationUserManagement,
} from "../web/assets/scripts/organization-users.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CiteLoom organization user accounts", () => {
  it("keeps account creation and password links on Security", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/security.html", import.meta.url),
      "utf8",
    );
    const help = await readFile(
      new URL("../web/fragments/help.html", import.meta.url),
      "utf8",
    );

    expect(fragment).toContain("User accounts");
    expect(fragment).toContain("Create organization accounts");
    expect(fragment).toContain("requestPasswordLink(user)");
    expect(fragment).toContain("without assigning workspace access");
    expect(fragment).not.toContain('button secondary compact-header-control');
    expect(fragment).not.toContain('button primary compact-header-control');
    expect(fragment).not.toContain("Remove from workspace");
    expect(help).toContain("Create and activate a user");
    expect(help).toContain("Reset a user's password");
    expect(help).toContain("removes only that membership");
  });

  it("creates an organization account without workspace fields", async () => {
    const page = createOrganizationUserManagement();
    page.accountDisplayName = "Jane Doe";
    page.accountUsername = "jdoe";
    page.loadOrganizationUsers = vi.fn(async () => undefined);
    const fetchRequest = vi.fn(async () => new Response(JSON.stringify({
      displayName: "Jane Doe",
      globalRole: "standard",
      state: "pending",
      userId: "00000000-0000-4000-8000-000000000701",
      username: "jdoe",
      workspaceCount: 0,
    }), {
      headers: { "Content-Type": "application/json" },
      status: 201,
    }));
    vi.stubGlobal("fetch", fetchRequest);

    await page.createOrganizationUser();

    expect(fetchRequest).toHaveBeenCalledWith("/api/security/users", {
      body: JSON.stringify({
        displayName: "Jane Doe",
        username: "jdoe",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(page.accountStatusMessage).toContain("Add the account to a workspace");
    expect(page.loadOrganizationUsers).toHaveBeenCalledOnce();
  });

  it("creates a setup or reset link only after workspace assignment", async () => {
    const page = createOrganizationUserManagement();
    const pendingUser = {
      displayName: "Jane Doe",
      globalRole: "standard",
      state: "pending",
      userId: "00000000-0000-4000-8000-000000000701",
      username: "jdoe",
      workspaceCount: 1,
    };
    vi.stubGlobal("window", {
      location: { origin: "https://citeloom.example" },
    });
    const fetchRequest = vi.fn(async () => new Response(JSON.stringify({
      expiresAt: "2026-08-12T14:00:00.000Z",
      purpose: "setup",
      setupToken: "b".repeat(48),
      userId: pendingUser.userId,
    }), {
      headers: { "Content-Type": "application/json" },
      status: 201,
    }));
    vi.stubGlobal("fetch", fetchRequest);

    expect(page.accountCanCreatePasswordLink({
      ...pendingUser,
      workspaceCount: 0,
    })).toBe(false);
    expect(page.accountPasswordActionLabel(pendingUser)).toBe("Create setup link");
    expect(page.accountPasswordActionLabel({
      ...pendingUser,
      state: "active",
    })).toBe("Create reset link");
    await page.createPasswordLink(pendingUser);

    expect(fetchRequest).toHaveBeenCalledWith(
      `/api/security/users/${pendingUser.userId}/password-link`,
      { method: "POST" },
    );
    expect(page.passwordLinkUrl).toBe(
      `https://citeloom.example/login?setup=${"b".repeat(48)}`,
    );
  });
});
