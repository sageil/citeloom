import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  createWorkspaceAdministrationActions,
} from "../web/assets/scripts/workspaces.js";

describe("CiteLoom workspace navigation", () => {
  it("selects the active workspace when workspace options render", async () => {
    const index = await readFile(
      new URL("../web/index.html", import.meta.url),
      "utf8",
    );
    const workspaceSelect = index.match(
      /<select[\s\S]*?x-ref="workspaceSelect"[\s\S]*?>/,
    )?.[0];

    expect(workspaceSelect).toBeDefined();
    expect(workspaceSelect).not.toContain(':value="currentWorkspaceId"');
    expect(index).toContain(
      ':selected="workspace.id === currentWorkspaceId"',
    );
  });

  it("keeps workspace creation and renaming in organization settings", async () => {
    const [index, appScript, settings, workspaceScript] = await Promise.all([
      readFile(new URL("../web/index.html", import.meta.url), "utf8"),
      readFile(
        new URL("../web/assets/scripts/app.js", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../web/fragments/settings.html", import.meta.url), "utf8"),
      readFile(
        new URL("../web/assets/scripts/workspaces.js", import.meta.url),
        "utf8",
      ),
    ]);

    expect(index).not.toContain("Create workspace");
    expect(index).not.toContain("Rename workspace");
    expect(appScript).not.toContain("openWorkspaceCreate()");
    expect(appScript).not.toContain("openWorkspaceRename()");
    expect(settings).toContain("Create workspace");
    expect(settings).toContain("Rename workspace");
    expect(settings).toContain('@submit.prevent="submitWorkspaceEditor()"');
    expect(settings).toContain("Settings, sources, and memberships remain attached");
    expect(workspaceScript).toContain('method: "POST"');
    expect(workspaceScript).toContain('method: "PATCH"');
  });

  it("keeps copy sources reactive after composing settings state", () => {
    const page = { ...createWorkspaceAdministrationActions() };
    page.workspaceAdministration = [buildWorkspace()];

    expect(page.workspaceEditorCopySources()).toEqual([buildWorkspace()]);
  });

  it("validates workspace names and copy sources before submission", () => {
    const page = { ...createWorkspaceAdministrationActions() };
    const workspace = buildWorkspace();
    page.workspaceAdministration = [workspace];
    page.workspaceEditorMode = "create";
    page.workspaceEditorName = " LEGAL ";

    expect(page.workspaceEditorNameValidationMessage()).toBe(
      "A workspace named LEGAL already exists.",
    );
    expect(page.workspaceEditorCanSubmit()).toBe(false);

    page.workspaceEditorName = "Legal Operations";
    page.workspaceEditorConfigurationKind = "workspace-copy";
    page.workspaceEditorSourceWorkspaceId = "";
    expect(page.workspaceEditorCopySourceValidationMessage()).toBe(
      "Select a workspace to copy.",
    );
    expect(page.workspaceEditorCanSubmit()).toBe(false);

    page.workspaceEditorSourceWorkspaceId = workspace.id;
    expect(page.workspaceEditorCanSubmit()).toBe(true);

    page.workspaceEditorMode = "rename";
    page.workspaceEditorTargetId = workspace.id;
    page.workspaceEditorName = "LEGAL";
    expect(page.workspaceEditorNameValidationMessage()).toBe("");
    expect(page.workspaceEditorCanSubmit()).toBe(true);
  });

  it("uses the same shared creation modal structure as Create Chat", async () => {
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
    expect(settings).toContain("workspaceEditorNameValidationMessage()");
    expect(settings).toContain("workspaceEditorCopySources()");
    expect(settings).toContain(':disabled="!workspaceEditorCanSubmit()"');
  });
});

function buildWorkspace() {
  return {
    id: "00000000-0000-4000-8000-000000000601",
    name: "legal",
    role: "admin",
  };
}
