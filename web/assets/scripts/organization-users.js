import {
  readArray,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readNonNegativeInteger,
  readPlainObject,
  readTimestamp,
} from "./boundary-readers.js";
import { requestConfirmation } from "./confirmation.js";

function readOrganizationUser(value) {
  const user = readPlainObject(value, "organization user");
  return {
    displayName: readNonEmptyString(user.displayName, "user display name"),
    globalRole: readEnum(
      user.globalRole,
      ["global_admin", "standard"],
      "user global role",
    ),
    state: readEnum(
      user.state,
      ["active", "pending", "suspended"],
      "user account state",
    ),
    userId: readNonEmptyString(user.userId, "user identifier"),
    username: readNonEmptyString(user.username, "username"),
    workspaceCount: readNonNegativeInteger(
      user.workspaceCount,
      "user workspace count",
    ),
  };
}

function readPasswordLink(value) {
  const link = readPlainObject(value, "user password link");
  return {
    expiresAt: readTimestamp(link.expiresAt, "password link expiry"),
    purpose: readEnum(
      link.purpose,
      ["setup", "reset"],
      "password link purpose",
    ),
    setupToken: readNonEmptyString(link.setupToken, "password link token"),
    userId: readNonEmptyString(link.userId, "password link user identifier"),
  };
}

export function createOrganizationUserManagement() {
  return {
    accountCreationOpen: false,
    accountDisplayName: "",
    accountError: "",
    accountLoading: false,
    accountStatusMessage: "",
    accountUsername: "",
    organizationUsers: [],
    passwordLinkCopied: false,
    passwordLinkExpiresAt: "",
    passwordLinkPurpose: "setup",
    passwordLinkUrl: "",
    userAccountBusy: false,

    accountCanCreatePasswordLink(user) {
      return user.state !== "suspended" && user.workspaceCount > 0;
    },

    accountPasswordActionLabel(user) {
      return user.state === "pending" ? "Create setup link" : "Create reset link";
    },

    accountWorkspaceLabel(user) {
      if (user.workspaceCount === 0) {
        return "No workspaces";
      }
      return `${user.workspaceCount} ${user.workspaceCount === 1 ? "workspace" : "workspaces"}`;
    },

    closeAccountCreation() {
      if (this.userAccountBusy) {
        return;
      }
      this.accountCreationOpen = false;
      this.accountDisplayName = "";
      this.accountUsername = "";
    },

    copyPasswordLink() {
      if (this.passwordLinkUrl === "") {
        return;
      }
      navigator.clipboard.writeText(this.passwordLinkUrl).then(() => {
        this.passwordLinkCopied = true;
      }).catch(() => {
        this.accountError =
          "The password link could not be copied. Select and copy it manually.";
      });
    },

    async createOrganizationUser() {
      if (this.userAccountBusy) {
        return;
      }
      this.userAccountBusy = true;
      this.accountError = "";
      this.accountStatusMessage = "";
      try {
        const response = await fetch("/api/security/users", {
          body: JSON.stringify({
            displayName: this.accountDisplayName,
            username: this.accountUsername,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const value = await readJsonResponse(response, "Create user account");
        const user = readOrganizationUser(value);
        this.accountCreationOpen = false;
        this.accountDisplayName = "";
        this.accountUsername = "";
        this.accountStatusMessage = `${user.displayName} was created. Add the account to a workspace, then create its setup link here.`;
        await this.loadOrganizationUsers();
      } catch (error) {
        this.accountError = error instanceof Error
          ? error.message
          : "The user account could not be created.";
      } finally {
        this.userAccountBusy = false;
      }
    },

    async createPasswordLink(user) {
      this.userAccountBusy = true;
      this.accountError = "";
      this.accountStatusMessage = "";
      this.passwordLinkUrl = "";
      try {
        const response = await fetch(
          `/api/security/users/${encodeURIComponent(user.userId)}/password-link`,
          { method: "POST" },
        );
        const value = await readJsonResponse(response, "Create password link");
        const link = readPasswordLink(value);
        const mode = link.purpose === "reset" ? "&mode=reset" : "";
        this.passwordLinkUrl = `${window.location.origin}/login?setup=${encodeURIComponent(link.setupToken)}${mode}`;
        this.passwordLinkCopied = false;
        this.passwordLinkExpiresAt = link.expiresAt;
        this.passwordLinkPurpose = link.purpose;
      } catch (error) {
        this.accountError = error instanceof Error
          ? error.message
          : "The password link could not be created.";
      } finally {
        this.userAccountBusy = false;
      }
    },

    formatPasswordLinkExpiry() {
      if (this.passwordLinkExpiresAt === "") {
        return "";
      }
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(this.passwordLinkExpiresAt));
    },

    initializeOrganizationUserManagement() {
      if (this.currentGlobalRole === "global_admin") {
        void this.loadOrganizationUsers();
      }
    },

    async loadOrganizationUsers() {
      this.accountLoading = true;
      this.accountError = "";
      try {
        const response = await fetch("/api/security/users", {
          headers: { accept: "application/json" },
        });
        const value = await readJsonResponse(response, "Organization users");
        const rows = readArray(value, "organization users");
        const accounts = [];
        for (const row of rows) {
          accounts.push(readOrganizationUser(row));
        }
        this.organizationUsers = accounts;
      } catch (error) {
        this.accountError = error instanceof Error
          ? error.message
          : "Organization users could not be loaded.";
      } finally {
        this.accountLoading = false;
      }
    },

    openAccountCreation() {
      this.accountCreationOpen = true;
      this.accountError = "";
      this.accountStatusMessage = "";
    },

    organizationUserInitials(displayName) {
      const words = displayName.trim().split(/\s+/u).filter(Boolean);
      if (words.length === 0) {
        return "?";
      }
      const first = words[0]?.[0] ?? "";
      const last = words.length > 1
        ? words.at(-1)?.[0] ?? ""
        : words[0]?.[1] ?? "";
      return `${first}${last}`.toLocaleUpperCase();
    },

    async requestPasswordLink(user) {
      if (this.userAccountBusy || !this.accountCanCreatePasswordLink(user)) {
        return;
      }
      const purpose = user.state === "pending" ? "setup" : "reset";
      const confirmed = await requestConfirmation({
        cancelLabel: "Cancel",
        confirmLabel: purpose === "setup" ? "Create setup link" : "Create reset link",
        description: purpose === "setup"
          ? `This creates a single-use password setup link for ${user.displayName}.`
          : `This creates a single-use password reset link for ${user.displayName}. Their current password remains active until the link is used.`,
        title: purpose === "setup"
          ? `Create a setup link for ${user.displayName}?`
          : `Create a reset link for ${user.displayName}?`,
        tone: "default",
      });
      if (confirmed) {
        await this.createPasswordLink(user);
      }
    },
  };
}
