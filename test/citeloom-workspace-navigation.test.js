import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canAdministerWorkspace,
  createWorkspaceAdministrationActions,
} from "../web/assets/scripts/workspaces.js";
import {
  findHtmlElementByAttribute,
  readHtmlAttribute,
  readHtmlElements,
} from "./html-test-helpers.js";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000601";
const CREATED_WORKSPACE_ID = "00000000-0000-4000-8000-000000000602";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CiteLoom workspace navigation", () => {
  it("loads root application assets when the shell is served from the OAuth callback", async () => {
    const index = await readFile(
      new URL("../web/index.html", import.meta.url),
      "utf8",
    );
    const elements = readHtmlElements(index);
    const base = findHtmlElementByAttribute(elements, "href", "/");
    const appScript = findHtmlElementByAttribute(
      elements,
      "src",
      "./assets/scripts/app.js",
    );
    const callbackUrl = new URL("https://citeloom.example/oauth/callback");
    const documentBaseUrl = new URL(readHtmlAttribute(base, "href"), callbackUrl);
    const appScriptUrl = new URL(
      readHtmlAttribute(appScript, "src"),
      documentBaseUrl,
    );

    expect(base.tagName).toBe("base");
    expect(appScriptUrl.pathname).toBe("/assets/scripts/app.js");
  });

  it("gives global administrators every current-workspace administrator capability", () => {
    expect(canAdministerWorkspace("member", "global_admin")).toBe(true);
    expect(canAdministerWorkspace("admin", "standard")).toBe(true);
    expect(canAdministerWorkspace("member", "standard")).toBe(false);
  });

  it("selects the active application workspace when workspace options render", async () => {
    const index = await readFile(
      new URL("../web/index.html", import.meta.url),
      "utf8",
    );
    const elements = readHtmlElements(index);
    const workspaceSelect = findHtmlElementByAttribute(
      elements,
      "x-ref",
      "workspaceSelect",
    );
    const selectedWorkspaceOption = findHtmlElementByAttribute(
      elements,
      ":selected",
      "workspace.id === currentWorkspaceId",
    );

    expect(readHtmlAttribute(workspaceSelect, ":value")).toBeNull();
    expect(selectedWorkspaceOption.tagName).toBe("option");
  });

  it("keeps create and edit in one settings workflow", async () => {
    const [index, settings] = await Promise.all([
      readFile(new URL("../web/index.html", import.meta.url), "utf8"),
      readFile(new URL("../web/fragments/settings.html", import.meta.url), "utf8"),
    ]);

    expect(index).not.toContain("Create workspace");
    expect(index).not.toContain("Rename workspace");
    expect(settings).toContain("Create workspace");
    expect(settings).toContain('@click="openWorkspaceManagement(workspace)"');
    expect(settings).toContain('@submit.prevent="saveWorkspaceName()"');
    expect(settings).toContain('class="workspace-user-management"');
    expect(settings).toContain("Add user");
    expect(settings).not.toContain("Add existing user");
    expect(settings).not.toContain("Rename workspace");
    expect(settings).not.toContain("submitWorkspaceEditor");
  });

  it("creates a workspace and opens that workspace in the unified editor", async () => {
    const createdWorkspace = buildWorkspace({
      id: CREATED_WORKSPACE_ID,
      name: "Operations",
    });
    const fetchRequest = vi.fn(async () => Response.json(createdWorkspace));
    vi.stubGlobal("fetch", fetchRequest);
    const page = buildWorkspacePage();
    page.workspaceCreateName = "Operations";

    await page.createWorkspace();

    expect(fetchRequest).toHaveBeenCalledWith("/api/workspaces", {
      body: JSON.stringify({
        configuration: { kind: "organization-defaults" },
        name: "Operations",
      }),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(page.changeSettingsTarget).toHaveBeenCalledWith(
      CREATED_WORKSPACE_ID,
      "Workspace",
    );
    expect(page.managedWorkspaces()).toContainEqual(createdWorkspace);
  });

  it("renames the selected workspace without changing application context", async () => {
    const updatedWorkspace = buildWorkspace({ name: "Legal Operations" });
    const fetchRequest = vi.fn(async () => Response.json(updatedWorkspace));
    vi.stubGlobal("fetch", fetchRequest);
    const page = buildWorkspacePage({ target: "workspace" });
    page.workspaceNameDraft = updatedWorkspace.name;

    await page.saveWorkspaceName();

    expect(fetchRequest).toHaveBeenCalledWith(`/api/workspaces/${WORKSPACE_ID}`, {
      body: JSON.stringify({ name: updatedWorkspace.name }),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      method: "PATCH",
    });
    expect(page.settings.scope.label).toBe(updatedWorkspace.name);
    expect(page.currentWorkspaceName).toBe(updatedWorkspace.name);
    expect(page.changeSettingsTarget).not.toHaveBeenCalled();
  });

  it("validates workspace names and copy sources before submission", () => {
    const page = buildWorkspacePage();
    page.workspaceCreateName = " LEGAL ";

    expect(page.workspaceNameValidationMessage(page.workspaceCreateName)).toBe(
      "A workspace named LEGAL already exists.",
    );
    expect(page.workspaceCreateCanSubmit()).toBe(false);

    page.workspaceCreateName = "Legal Operations";
    page.workspaceCreateConfigurationKind = "workspace-copy";
    page.workspaceCreateSourceWorkspaceId = "";
    expect(page.workspaceCreateSourceValidationMessage()).toBe(
      "Select a workspace to copy.",
    );
    expect(page.workspaceCreateCanSubmit()).toBe(false);

    page.workspaceCreateSourceWorkspaceId = WORKSPACE_ID;
    expect(page.workspaceCreateCanSubmit()).toBe(true);

    page.settings.scope.kind = "workspace";
    page.settings.scope.id = WORKSPACE_ID;
    page.settings.scope.label = "legal";
    page.workspaceNameDraft = "LEGAL";
    expect(page.workspaceNameValidationMessage("LEGAL", WORKSPACE_ID)).toBe("");
    expect(page.workspaceNameCanSave()).toBe(true);
  });

  it("uses the shared creation modal structure from Create Chat", async () => {
    const [chat, settings] = await Promise.all([
      readFile(new URL("../web/fragments/chat.html", import.meta.url), "utf8"),
      readFile(new URL("../web/fragments/settings.html", import.meta.url), "utf8"),
    ]);

    for (const className of [
      "creation-modal-backdrop",
      "creation-modal",
      "creation-modal-header",
      "creation-modal-close",
      "creation-modal-actions",
    ]) {
      expect(chat).toContain(className);
      expect(settings).toContain(className);
    }
    expect(settings).toContain("workspaceNameValidationMessage(workspaceCreateName)");
    expect(settings).toContain("workspaceCreateSourceValidationMessage()");
    expect(settings).toContain(':disabled="!workspaceCreateCanSubmit()"');
  });
});

function buildWorkspace(overrides = {}) {
  return {
    id: WORKSPACE_ID,
    name: "legal",
    role: "admin",
    ...overrides,
  };
}

function buildWorkspacePage({ target = "organization" } = {}) {
  const workspace = buildWorkspace();
  const organizationSelected = target === "organization";
  return {
    ...createWorkspaceAdministrationActions(),
    $nextTick(callback) {
      callback();
    },
    $refs: {},
    changeSettingsTarget: vi.fn(async () => true),
    currentWorkspaceId: WORKSPACE_ID,
    currentWorkspaceName: workspace.name,
    settings: {
      scope: {
        available: [
          {
            id: "organization",
            kind: "organization",
            label: "Organization",
          },
          {
            id: WORKSPACE_ID,
            kind: "workspace",
            label: workspace.name,
          },
        ],
        id: organizationSelected ? "organization" : WORKSPACE_ID,
        kind: organizationSelected ? "organization" : "workspace",
        label: organizationSelected ? "Organization" : workspace.name,
      },
    },
    workspaces: [workspace],
  };
}
