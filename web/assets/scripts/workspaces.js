import {
  readArray,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readPlainObject,
} from "./boundary-readers.js";

function normalizeWorkspaceName(value) {
  return value.trim().toLocaleLowerCase("en-US");
}

function readWorkspaceSummary(value, label) {
  const workspace = readPlainObject(value, label);
  return {
    id: readNonEmptyString(workspace.id, `${label} ID`),
    name: readNonEmptyString(workspace.name, `${label} name`),
    role: readEnum(workspace.role, ["admin", "member"], `${label} role`),
  };
}

export function readWorkspaceSummaries(value) {
  const workspaces = [];
  const workspaceIds = new Set();
  for (const candidate of readArray(value, "workspaces")) {
    const workspace = readWorkspaceSummary(candidate, "workspace");
    if (workspaceIds.has(workspace.id)) {
      throw new Error("A workspace appears more than once.");
    }
    workspaceIds.add(workspace.id);
    workspaces.push(workspace);
  }
  return workspaces;
}

export function createWorkspaceAdministrationActions() {
  return {
    workspaceAdministration: null,
    workspaceAdministrationBusy: false,
    workspaceAdministrationError: "",
    workspaceEditorConfigurationKind: "organization-defaults",
    workspaceEditorError: "",
    workspaceEditorMode: "create",
    workspaceEditorName: "",
    workspaceEditorOpen: false,
    workspaceEditorRestoreFocusElement: null,
    workspaceEditorSourceWorkspaceId: "",
    workspaceEditorTargetId: null,

    workspaceEditorCopySources() {
      return this.workspaceAdministration ?? [];
    },

    workspaceEditorNameValidationMessage() {
      const normalizedName = normalizeWorkspaceName(this.workspaceEditorName);
      if (normalizedName === "") {
        return "";
      }
      for (const workspace of this.workspaceEditorCopySources()) {
        if (workspace.id === this.workspaceEditorTargetId) {
          continue;
        }
        if (normalizeWorkspaceName(workspace.name) === normalizedName) {
          return `A workspace named ${this.workspaceEditorName.trim()} already exists.`;
        }
      }
      return "";
    },

    workspaceEditorCopySourceValidationMessage() {
      if (
        this.workspaceEditorMode !== "create"
        || this.workspaceEditorConfigurationKind !== "workspace-copy"
      ) {
        return "";
      }
      const sourceExists = this.workspaceEditorCopySources().some((workspace) => {
        return workspace.id === this.workspaceEditorSourceWorkspaceId;
      });
      return sourceExists ? "" : "Select a workspace to copy.";
    },

    workspaceEditorCanSubmit() {
      if (
        this.workspaceAdministrationBusy
        || this.workspaceEditorName.trim() === ""
        || this.workspaceEditorNameValidationMessage() !== ""
      ) {
        return false;
      }
      if (this.workspaceEditorMode === "rename") {
        return this.workspaceEditorTargetId !== null;
      }
      return this.workspaceEditorCopySourceValidationMessage() === "";
    },

    async loadWorkspaceAdministration() {
      this.workspaceAdministrationBusy = true;
      this.workspaceAdministrationError = "";
      try {
        const response = await fetch("/api/workspaces", {
          headers: { accept: "application/json" },
        });
        this.workspaceAdministration = await readJsonResponse(
          response,
          "Workspace administration request",
          readWorkspaceSummaries,
        );
      } catch (error) {
        this.workspaceAdministrationError = error instanceof Error
          ? error.message
          : "Workspaces could not be loaded.";
      } finally {
        this.workspaceAdministrationBusy = false;
      }
    },

    destroyWorkspaceAdministration() {
      this.workspaceAdministration = null;
      this.workspaceAdministrationBusy = false;
      this.workspaceAdministrationError = "";
      this.closeWorkspaceEditor();
    },

    openWorkspaceCreate() {
      if (this.workspaceAdministrationBusy) {
        return;
      }
      this.workspaceEditorConfigurationKind = "organization-defaults";
      this.workspaceEditorError = "";
      this.workspaceEditorMode = "create";
      this.workspaceEditorName = "";
      this.workspaceEditorSourceWorkspaceId = this.currentWorkspaceId
        ?? this.workspaceEditorCopySources()[0]?.id
        ?? "";
      this.workspaceEditorTargetId = null;
      this.openWorkspaceEditor();
    },

    openWorkspaceRename(workspace) {
      if (this.workspaceAdministrationBusy) {
        return;
      }
      this.workspaceEditorError = "";
      this.workspaceEditorMode = "rename";
      this.workspaceEditorName = workspace.name;
      this.workspaceEditorTargetId = workspace.id;
      this.openWorkspaceEditor();
    },

    openWorkspaceEditor() {
      this.workspaceEditorRestoreFocusElement = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      this.workspaceEditorOpen = true;
      this.$nextTick(() => this.$refs.workspaceEditorName?.focus());
    },

    closeWorkspaceEditor() {
      if (this.workspaceAdministrationBusy && this.workspaceEditorOpen) {
        return;
      }
      const restoreFocusElement = this.workspaceEditorRestoreFocusElement;
      this.workspaceEditorOpen = false;
      this.workspaceEditorRestoreFocusElement = null;
      if (restoreFocusElement?.isConnected === true) {
        this.$nextTick(() => restoreFocusElement.focus());
      }
    },

    cycleWorkspaceEditorFocus(event) {
      const dialog = this.$refs.workspaceEditorDialog;
      if (!(dialog instanceof HTMLElement)) {
        return;
      }
      const controls = Array.from(dialog.querySelectorAll(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
      ));
      const first = controls[0];
      const last = controls.at(-1);
      if (!(first instanceof HTMLElement) || !(last instanceof HTMLElement)) {
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },

    async submitWorkspaceEditor() {
      if (!this.workspaceEditorCanSubmit()) {
        return;
      }
      if (this.workspaceEditorMode === "rename") {
        await this.renameWorkspace();
        return;
      }
      await this.createWorkspace();
    },

    async createWorkspace() {
      if (!this.workspaceEditorCanSubmit()) {
        return;
      }
      this.workspaceAdministrationBusy = true;
      this.workspaceEditorError = "";
      try {
        const response = await fetch("/api/workspaces", {
          body: JSON.stringify(this.buildWorkspaceCreationRequest()),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          method: "POST",
        });
        await readJsonResponse(
          response,
          "Workspace creation",
          (value) => readWorkspaceSummary(value, "created workspace"),
        );
        window.location.reload();
      } catch (error) {
        this.workspaceEditorError = error instanceof Error
          ? error.message
          : "Workspace creation failed.";
        this.workspaceAdministrationBusy = false;
      }
    },

    buildWorkspaceCreationRequest() {
      let configuration = { kind: "organization-defaults" };
      if (this.workspaceEditorConfigurationKind === "workspace-copy") {
        configuration = {
          kind: "workspace-copy",
          workspaceId: this.workspaceEditorSourceWorkspaceId,
        };
      }
      return {
        configuration,
        name: this.workspaceEditorName,
      };
    },

    async renameWorkspace() {
      if (
        !this.workspaceEditorCanSubmit()
        || this.workspaceEditorTargetId === null
      ) {
        return;
      }
      this.workspaceAdministrationBusy = true;
      this.workspaceEditorError = "";
      try {
        const workspaceId = encodeURIComponent(this.workspaceEditorTargetId);
        const response = await fetch(`/api/workspaces/${workspaceId}`, {
          body: JSON.stringify({ name: this.workspaceEditorName }),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          method: "PATCH",
        });
        if (!response.ok) {
          await readJsonResponse(response, "Workspace rename");
        }
        window.location.reload();
      } catch (error) {
        this.workspaceEditorError = error instanceof Error
          ? error.message
          : "Workspace rename failed.";
        this.workspaceAdministrationBusy = false;
      }
    },
  };
}
