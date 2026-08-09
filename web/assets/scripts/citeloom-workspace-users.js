import {
  readArray,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readPlainObject,
} from "./citeloom-boundaries.js";
import { requestConfirmation } from "./citeloom-confirmation.js";
import { dispatchNotice } from "./citeloom-notices.js";

function readMember(value) {
  const member = readPlainObject(value, "workspace member");
  return {
    displayName: readNonEmptyString(member.displayName, "member display name"),
    role: readEnum(member.role, ["admin", "member"], "member role"),
    state: readEnum(member.state, ["active", "pending", "suspended"], "member state"),
    userId: readNonEmptyString(member.userId, "member identifier"),
    username: readNonEmptyString(member.username, "member username"),
  };
}

export function createWorkspaceUserManagement(options = {}) {
  const title = options.title ?? "Workspace users";
  const showRoleGuide = options.showRoleGuide ?? true;
  const actionsLabel = options.actionsLabel ?? "Actions";
  return {
    addUserOpen: false,
    members: [],
    newDisplayName: "",
    newRole: "member",
    newUsername: "",
    setupLinkCopied: false,
    setupLinkPurpose: "setup",
    setupUrl: "",
    showUserRoleGuide: showRoleGuide,
    userManagementActionsLabel: actionsLabel,
    userManagementBusy: false,
    userManagementLoadFailed: false,
    userManagementLoading: true,
    userManagementTitle: title,

    userResetLinkLifetimeLabel() {
      if (this.resetLinkLifetimeSeconds < 3_600) {
        const minutes = this.resetLinkLifetimeSeconds / 60;
        return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
      }
      if (this.resetLinkLifetimeSeconds < 86_400) {
        const hours = this.resetLinkLifetimeSeconds / 3_600;
        return `${hours} ${hours === 1 ? "hour" : "hours"}`;
      }
      const days = this.resetLinkLifetimeSeconds / 86_400;
      return `${days} ${days === 1 ? "day" : "days"}`;
    },

    afterWorkspaceUserMutation() {
      return Promise.resolve();
    },

    closeAddUser() {
      if (this.userManagementBusy) {
        return;
      }
      this.addUserOpen = false;
      this.newDisplayName = "";
      this.newRole = "member";
      this.newUsername = "";
    },

    initializeUserManagement() {
      void this.loadUsers();
    },

    openAddUser() {
      this.addUserOpen = true;
      this.setupLinkCopied = false;
    },

    workspaceUserInitials(displayName) {
      const words = displayName.trim().split(/\s+/u).filter(Boolean);
      if (words.length === 0) {
        return "?";
      }
      const first = words[0]?.[0] ?? "";
      const last = words.length > 1 ? words.at(-1)?.[0] ?? "" : words[0]?.[1] ?? "";
      return `${first}${last}`.toLocaleUpperCase();
    },

    async copySetupLink() {
      if (this.setupUrl === "") {
        return;
      }
      try {
        await navigator.clipboard.writeText(this.setupUrl);
        this.setupLinkCopied = true;
        dispatchNotice("success", "The password link was copied.");
      } catch {
        dispatchNotice(
          "error",
          "The password link could not be copied. Select and copy it manually.",
        );
      }
    },

    async loadUsers() {
      this.userManagementLoading = true;
      this.userManagementLoadFailed = false;
      try {
        const response = await fetch("/api/workspace/members", {
          headers: { accept: "application/json" },
        });
        const value = await readJsonResponse(response, "Workspace users");
        const rows = readArray(value, "workspace users");
        const members = [];
        for (const row of rows) {
          members.push(readMember(row));
        }
        this.members = members;
      } catch (error) {
        this.userManagementLoadFailed = true;
        dispatchNotice(
          "error",
          error instanceof Error ? error.message : "Users could not be loaded.",
        );
      } finally {
        this.userManagementLoading = false;
      }
    },

    async addUser() {
      this.userManagementBusy = true;
      this.setupUrl = "";
      try {
        const response = await fetch("/api/workspace/members", {
          body: JSON.stringify({
            displayName: this.newDisplayName,
            role: this.newRole,
            username: this.newUsername,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const value = await readJsonResponse(response, "Add user");
        const addition = readPlainObject(value, "user addition");
        const kind = readEnum(addition.kind, ["existing", "setup"], "user addition kind");
        if (kind === "setup") {
          const token = readNonEmptyString(addition.setupToken, "setup token");
          this.setupUrl = `${window.location.origin}/login?setup=${encodeURIComponent(token)}`;
          this.setupLinkPurpose = "setup";
        }
        this.newDisplayName = "";
        this.newUsername = "";
        this.newRole = "member";
        this.addUserOpen = false;
        this.setupLinkCopied = false;
        dispatchNotice(
          "success",
          kind === "setup"
            ? "User added. Share the setup link with them."
            : "Existing user added to this workspace.",
        );
        await this.loadUsers();
        await this.afterWorkspaceUserMutation();
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error ? error.message : "The user could not be added.",
        );
      } finally {
        this.userManagementBusy = false;
      }
    },

    async changeRole(member, role) {
      this.userManagementBusy = true;
      try {
        const response = await fetch(
          `/api/workspace/members/${encodeURIComponent(member.userId)}/role`,
          {
            body: JSON.stringify({ role }),
            headers: { "Content-Type": "application/json" },
            method: "PUT",
          },
        );
        if (!response.ok) {
          await readJsonResponse(response, "Change user role");
        }
        await this.loadUsers();
        dispatchNotice("success", `${member.displayName}'s role was updated.`);
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error ? error.message : "The role could not be changed.",
        );
        await this.loadUsers();
      } finally {
        this.userManagementBusy = false;
      }
    },

    async requestPasswordReset(member) {
      if (this.userManagementBusy || member.state !== "active") {
        return;
      }
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep current access",
        confirmLabel: "Create reset link",
        description: `This creates a single-use password-reset link for ${member.displayName}. It expires after ${this.userResetLinkLifetimeLabel()}, and their current password remains active until the link is used.`,
        title: `Create a reset link for ${member.displayName}?`,
        tone: "default",
      });
      if (!confirmed) {
        return;
      }
      await this.createPasswordReset(member);
    },

    async createPasswordReset(member) {
      this.userManagementBusy = true;
      this.setupUrl = "";
      try {
        const response = await fetch(
          `/api/workspace/members/${encodeURIComponent(member.userId)}/password-reset`,
          { method: "POST" },
        );
        const value = await readJsonResponse(response, "Create password reset");
        const reset = readPlainObject(value, "password reset");
        const token = readNonEmptyString(reset.setupToken, "password-reset token");
        this.setupUrl = `${window.location.origin}/login?setup=${encodeURIComponent(token)}&mode=reset`;
        this.setupLinkPurpose = "reset";
        this.setupLinkCopied = false;
        dispatchNotice("success", `Password-reset link created for ${member.username}.`);
        await this.afterWorkspaceUserMutation();
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error
            ? error.message
            : "The password-reset link could not be created.",
        );
      } finally {
        this.userManagementBusy = false;
      }
    },

    async requestRemoveUser(member) {
      if (this.userManagementBusy) {
        return;
      }
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep user",
        confirmLabel: "Remove access",
        description: `${member.displayName} will lose access to this workspace. Their user account and access to other workspaces are not deleted.`,
        title: `Remove ${member.displayName} from this workspace?`,
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      await this.removeUser(member);
    },

    async removeUser(member) {
      this.userManagementBusy = true;
      try {
        const response = await fetch(
          `/api/workspace/members/${encodeURIComponent(member.userId)}`,
          { method: "DELETE" },
        );
        if (!response.ok) {
          await readJsonResponse(response, "Remove user");
        }
        await this.loadUsers();
        dispatchNotice("success", `${member.displayName} was removed from this workspace.`);
        await this.afterWorkspaceUserMutation();
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error ? error.message : "The user could not be removed.",
        );
      } finally {
        this.userManagementBusy = false;
      }
    },
  };
}
