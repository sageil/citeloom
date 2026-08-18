import {
  readArray,
  readBoolean,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readPlainObject,
  readPositiveInteger,
} from "./boundary-readers.js";
import { browserAuthentication } from "./browser-authentication.js";

function readPasswordPolicy(value) {
  const policy = readPlainObject(value, "password policy");
  const minimumPasswordLength = readPositiveInteger(
    policy.minimumPasswordLength,
    "minimum password length",
  );
  if (minimumPasswordLength < 9 || minimumPasswordLength > 64) {
    throw new Error("The minimum password length response is invalid.");
  }
  return {
    minimumPasswordLength,
    requireLetterAndNumber: readBoolean(
      policy.requireLetterAndNumber,
      "letter and number requirement",
    ),
    requireSpecialCharacter: readBoolean(
      policy.requireSpecialCharacter,
      "special character requirement",
    ),
  };
}

function readWorkspace(value) {
  const workspace = readPlainObject(value, "account workspace");
  return {
    id: readNonEmptyString(workspace.id, "workspace ID"),
    name: readNonEmptyString(workspace.name, "workspace name"),
    role: readEnum(workspace.role, ["admin", "member"], "workspace role"),
  };
}

function readWorkspacePreference(value) {
  const preference = readPlainObject(value, "default workspace preference");
  const workspaces = [];
  for (const value of readArray(preference.workspaces, "account workspaces")) {
    workspaces.push(readWorkspace(value));
  }
  const currentWorkspaceId = readNonEmptyString(
    preference.currentWorkspaceId,
    "current workspace ID",
  );
  const defaultWorkspaceId = readNonEmptyString(
    preference.defaultWorkspaceId,
    "default workspace ID",
  );
  if (!workspaces.some((workspace) => workspace.id === currentWorkspaceId)) {
    throw new Error("The current workspace is unavailable.");
  }
  if (!workspaces.some((workspace) => workspace.id === defaultWorkspaceId)) {
    throw new Error("The default workspace is unavailable.");
  }
  return { currentWorkspaceId, defaultWorkspaceId, workspaces };
}

function readWorkspaceTransition(value) {
  const transition = readPlainObject(value, "default workspace transition");
  return {
    currentWorkspaceId: readNonEmptyString(
      transition.currentWorkspaceId,
      "current workspace ID",
    ),
    defaultWorkspaceId: readNonEmptyString(
      transition.defaultWorkspaceId,
      "default workspace ID",
    ),
    workspace: readWorkspace(transition.workspace),
  };
}

export function registerPage(alpine) {
  alpine.data("citeloomAccountPage", () => ({
    busy: false,
    confirmation: "",
    currentPassword: "",
    currentWorkspaceId: null,
    defaultWorkspaceId: null,
    errorMessage: "",
    minimumPasswordLength: null,
    newPassword: "",
    passwordFormOpen: false,
    requireLetterAndNumber: null,
    requireSpecialCharacter: null,
    selectedWorkspaceId: null,
    workspaceBusy: false,
    workspaceErrorMessage: "",
    workspaceLoading: true,
    workspaces: [],

    get currentWorkspace() {
      return this.findWorkspace(this.currentWorkspaceId);
    },

    get defaultWorkspace() {
      return this.findWorkspace(this.defaultWorkspaceId);
    },

    get hasWorkspaceSelectionChange() {
      return this.selectedWorkspaceId !== null
        && this.selectedWorkspaceId !== this.defaultWorkspaceId;
    },

    get selectedWorkspace() {
      return this.findWorkspace(this.selectedWorkspaceId);
    },

    get passwordRequirementSummary() {
      if (this.minimumPasswordLength === null) {
        return "Loading requirements…";
      }
      const requirements = [`At least ${this.minimumPasswordLength} characters`];
      if (this.requireLetterAndNumber) {
        requirements.push("one letter and one number");
      }
      if (this.requireSpecialCharacter) {
        requirements.push("one special character");
      }
      return requirements.join(", ");
    },

    initialize() {
      void this.loadPasswordPolicy();
      void this.loadWorkspacePreference();
    },

    cancelWorkspaceSelection() {
      this.selectedWorkspaceId = this.defaultWorkspaceId;
      this.workspaceErrorMessage = "";
    },

    closePasswordForm() {
      this.currentPassword = "";
      this.newPassword = "";
      this.confirmation = "";
      this.errorMessage = "";
      this.passwordFormOpen = false;
    },

    openPasswordForm() {
      if (this.minimumPasswordLength === null) {
        return;
      }
      this.errorMessage = "";
      this.passwordFormOpen = true;
    },

    findWorkspace(workspaceId) {
      return this.workspaces.find((workspace) => {
        return workspace.id === workspaceId;
      }) ?? null;
    },

    async loadPasswordPolicy() {
      try {
        const response = await fetch("/api/auth/password-policy", {
          headers: { accept: "application/json" },
        });
        const value = await readJsonResponse(response, "Password policy");
        const policy = readPasswordPolicy(value);
        this.minimumPasswordLength = policy.minimumPasswordLength;
        this.requireLetterAndNumber = policy.requireLetterAndNumber;
        this.requireSpecialCharacter = policy.requireSpecialCharacter;
      } catch (error) {
        this.errorMessage = error instanceof Error
          ? error.message
          : "Password policy could not be loaded.";
      }
    },

    async loadWorkspacePreference() {
      this.workspaceLoading = true;
      this.workspaceErrorMessage = "";
      try {
        const response = await fetch("/api/account/default-workspace", {
          headers: { accept: "application/json" },
        });
        const value = await readJsonResponse(response, "Default workspace");
        const preference = readWorkspacePreference(value);
        this.currentWorkspaceId = preference.currentWorkspaceId;
        this.defaultWorkspaceId = preference.defaultWorkspaceId;
        this.selectedWorkspaceId = preference.defaultWorkspaceId;
        this.workspaces = preference.workspaces;
      } catch (error) {
        this.workspaceErrorMessage = error instanceof Error
          ? error.message
          : "Your workspaces could not be loaded.";
      } finally {
        this.workspaceLoading = false;
      }
    },

    async saveDefaultWorkspace() {
      if (!this.hasWorkspaceSelectionChange) {
        return;
      }
      const workspaceId = this.selectedWorkspaceId;
      this.workspaceBusy = true;
      this.workspaceErrorMessage = "";
      let oauthTransitionStarted = false;
      try {
        oauthTransitionStarted = await browserAuthentication
          .beginDefaultWorkspaceTransition(workspaceId);
        const response = await fetch("/api/account/default-workspace", {
          body: JSON.stringify({ workspaceId }),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        });
        if (!response.ok) {
          browserAuthentication.cancelDefaultWorkspaceTransition();
          oauthTransitionStarted = false;
        }
        const value = await readJsonResponse(response, "Default workspace change");
        const transition = readWorkspaceTransition(value);
        if (
          transition.currentWorkspaceId !== workspaceId
          || transition.defaultWorkspaceId !== workspaceId
          || transition.workspace.id !== workspaceId
        ) {
          throw new Error("The default workspace change response is invalid.");
        }
        await browserAuthentication.completeDefaultWorkspaceTransition(workspaceId);
        window.location.reload();
      } catch (error) {
        this.workspaceErrorMessage = error instanceof Error
          ? error.message
          : "Your default workspace could not be changed.";
        if (!oauthTransitionStarted) {
          browserAuthentication.cancelDefaultWorkspaceTransition();
        }
      } finally {
        this.workspaceBusy = false;
      }
    },

    async changePassword() {
      if (this.minimumPasswordLength === null) {
        this.errorMessage = "Password requirements are still loading.";
        return;
      }
      if (this.newPassword !== this.confirmation) {
        this.errorMessage = "The new passwords do not match.";
        return;
      }
      this.busy = true;
      this.errorMessage = "";
      try {
        const response = await fetch("/api/auth/password", {
          body: JSON.stringify({
            currentPassword: this.currentPassword,
            newPassword: this.newPassword,
          }),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        });
        if (!response.ok) {
          await readJsonResponse(response, "Password change");
        }
        this.currentPassword = "";
        this.newPassword = "";
        this.confirmation = "";
        this.passwordFormOpen = false;
      } catch (error) {
        this.errorMessage = error instanceof Error
          ? error.message
          : "Your password could not be changed.";
      } finally {
        this.busy = false;
      }
    },
  }));
}
