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

export function canAdministerWorkspace(role, globalRole) {
  return role === "admin" || globalRole === "global_admin";
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
    workspaceActionBusy: false,
    workspaceCreateConfigurationKind: "organization-defaults",
    workspaceCreateError: "",
    workspaceCreateName: "",
    workspaceCreateOpen: false,
    workspaceCreateRestoreFocusElement: null,
    workspaceCreateSourceWorkspaceId: "",
    workspaceNameDraft: "",
    workspaceNameError: "",

    managedWorkspaces() {
      const workspaces = [];
      for (const target of this.settings?.scope.available ?? []) {
        if (target.kind !== "workspace") {
          continue;
        }
        workspaces.push({
          id: target.id,
          name: target.label,
          role: "admin",
        });
      }
      return workspaces;
    },

    canRenameSelectedWorkspace() {
      if (this.settings?.scope.kind !== "workspace") {
        return false;
      }
      for (const target of this.settings.scope.available) {
        if (target.kind === "organization") {
          return true;
        }
      }
      return false;
    },

    workspaceNameValidationMessage(name, excludedWorkspaceId = null) {
      const normalizedName = normalizeWorkspaceName(name);
      if (normalizedName === "") {
        return "";
      }
      for (const workspace of this.managedWorkspaces()) {
        if (workspace.id === excludedWorkspaceId) {
          continue;
        }
        if (normalizeWorkspaceName(workspace.name) === normalizedName) {
          return `A workspace named ${name.trim()} already exists.`;
        }
      }
      return "";
    },

    workspaceCreateSourceValidationMessage() {
      if (this.workspaceCreateConfigurationKind !== "workspace-copy") {
        return "";
      }
      for (const workspace of this.managedWorkspaces()) {
        if (workspace.id === this.workspaceCreateSourceWorkspaceId) {
          return "";
        }
      }
      return "Select a workspace to copy.";
    },

    workspaceCreateCanSubmit() {
      return !this.workspaceActionBusy
        && this.workspaceCreateName.trim() !== ""
        && this.workspaceNameValidationMessage(this.workspaceCreateName) === ""
        && this.workspaceCreateSourceValidationMessage() === "";
    },

    destroyWorkspaceActions() {
      this.workspaceActionBusy = false;
      this.workspaceCreateError = "";
      this.workspaceNameError = "";
      this.closeWorkspaceCreate();
    },

    openWorkspaceCreate() {
      if (this.workspaceActionBusy) {
        return;
      }
      this.workspaceCreateConfigurationKind = "organization-defaults";
      this.workspaceCreateError = "";
      this.workspaceCreateName = "";
      this.workspaceCreateSourceWorkspaceId = this.currentWorkspaceId
        ?? this.managedWorkspaces()[0]?.id
        ?? "";
      this.workspaceCreateRestoreFocusElement = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      this.workspaceCreateOpen = true;
      this.$nextTick(() => this.$refs.workspaceCreateName?.focus());
    },

    async openWorkspaceManagement(workspace) {
      await this.changeSettingsTarget(workspace.id, "Workspace");
    },

    closeWorkspaceCreate() {
      if (this.workspaceActionBusy && this.workspaceCreateOpen) {
        return;
      }
      const restoreFocusElement = this.workspaceCreateRestoreFocusElement;
      this.workspaceCreateOpen = false;
      this.workspaceCreateRestoreFocusElement = null;
      if (restoreFocusElement?.isConnected === true) {
        this.$nextTick(() => restoreFocusElement.focus());
      }
    },

    cycleWorkspaceCreateFocus(event) {
      const dialog = this.$refs.workspaceCreateDialog;
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

    async createWorkspace() {
      if (!this.workspaceCreateCanSubmit()) {
        return;
      }
      this.workspaceActionBusy = true;
      this.workspaceCreateError = "";
      try {
        const response = await fetch("/api/workspaces", {
          body: JSON.stringify(this.buildWorkspaceCreationRequest()),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          method: "POST",
        });
        const workspace = await readJsonResponse(
          response,
          "Workspace creation",
          (value) => readWorkspaceSummary(value, "created workspace"),
        );
        this.registerWorkspace(workspace);
        this.workspaceActionBusy = false;
        this.closeWorkspaceCreate();
        await this.changeSettingsTarget(workspace.id, "Workspace");
      } catch (error) {
        this.workspaceCreateError = error instanceof Error
          ? error.message
          : "Workspace creation failed.";
        this.workspaceActionBusy = false;
      }
    },

    buildWorkspaceCreationRequest() {
      let configuration = { kind: "organization-defaults" };
      if (this.workspaceCreateConfigurationKind === "workspace-copy") {
        configuration = {
          kind: "workspace-copy",
          workspaceId: this.workspaceCreateSourceWorkspaceId,
        };
      }
      return {
        configuration,
        name: this.workspaceCreateName,
      };
    },

    registerWorkspace(workspace) {
      this.settings.scope.available.push({
        id: workspace.id,
        kind: "workspace",
        label: workspace.name,
      });
      this.settings.scope.available.sort((left, right) => {
        if (left.kind === "organization") {
          return -1;
        }
        if (right.kind === "organization") {
          return 1;
        }
        return left.label.localeCompare(right.label);
      });
      this.workspaces.push(workspace);
      this.workspaces.sort((left, right) => left.name.localeCompare(right.name));
    },

    syncWorkspaceNameDraft() {
      if (this.settings?.scope.kind !== "workspace") {
        this.workspaceNameDraft = "";
        this.workspaceNameError = "";
        return;
      }
      this.workspaceNameDraft = this.settings.scope.label;
      this.workspaceNameError = "";
    },

    workspaceNameCanSave() {
      const scope = this.settings?.scope;
      if (
        scope?.kind !== "workspace"
        || !this.canRenameSelectedWorkspace()
        || this.workspaceActionBusy
      ) {
        return false;
      }
      return this.workspaceNameDraft.trim() !== ""
        && this.workspaceNameDraft.trim() !== scope.label
        && this.workspaceNameValidationMessage(
          this.workspaceNameDraft,
          scope.id,
        ) === "";
    },

    async saveWorkspaceName() {
      if (!this.workspaceNameCanSave()) {
        return;
      }
      const workspaceId = this.settings.scope.id;
      this.workspaceActionBusy = true;
      this.workspaceNameError = "";
      try {
        const encodedWorkspaceId = encodeURIComponent(workspaceId);
        const response = await fetch(`/api/workspaces/${encodedWorkspaceId}`, {
          body: JSON.stringify({ name: this.workspaceNameDraft }),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          method: "PATCH",
        });
        const workspace = await readJsonResponse(
          response,
          "Workspace update",
          (value) => readWorkspaceSummary(value, "updated workspace"),
        );
        this.updateWorkspaceName(workspace);
      } catch (error) {
        this.workspaceNameError = error instanceof Error
          ? error.message
          : "Workspace update failed.";
      } finally {
        this.workspaceActionBusy = false;
      }
    },

    updateWorkspaceName(workspace) {
      for (const target of this.settings.scope.available) {
        if (target.id === workspace.id) {
          target.label = workspace.name;
        }
      }
      this.settings.scope.label = workspace.name;
      this.workspaceNameDraft = workspace.name;
      for (const availableWorkspace of this.workspaces ?? []) {
        if (availableWorkspace.id === workspace.id) {
          availableWorkspace.name = workspace.name;
        }
      }
      if (this.currentWorkspaceId === workspace.id) {
        this.currentWorkspaceName = workspace.name;
      }
    },
  };
}
