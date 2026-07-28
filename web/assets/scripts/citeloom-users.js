import {
readArray,
readEnum,
readJsonResponse,
readNonEmptyString,
readPlainObject,
} from "./citeloom-boundaries.js";
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

export function registerPage(alpine) {
  alpine.data("citeloomUsersPage", () => ({
    addUserOpen: false,
    busy: false,
    errorMessage: "",
    loading: true,
    members: [],
    pendingActionKind: null,
    pendingActionUserId: "",
    newDisplayName: "",
    newRole: "member",
    newUsername: "",
    setupUrl: "",
    setupLinkPurpose: "setup",
    setupLinkCopied: false,
    successMessage: "",

    initialize() {
      void this.loadUsers();
    },

    cancelMemberAction() {
      if (this.busy) {
        return;
      }
      this.pendingActionKind = null;
      this.pendingActionUserId = "";
    },

    closeAddUser() {
      if (this.busy) {
        return;
      }
      this.addUserOpen = false;
      this.newDisplayName = "";
      this.newRole = "member";
      this.newUsername = "";
    },

    openAddUser() {
      this.addUserOpen = true;
      this.errorMessage = "";
      this.successMessage = "";
      this.setupLinkCopied = false;
    },

    requestMemberAction(member, kind) {
      this.pendingActionKind = kind;
      this.pendingActionUserId = member.userId;
      this.errorMessage = "";
      this.successMessage = "";
    },

    async copySetupLink() {
      if (this.setupUrl === "") {
        return;
      }
      try {
        await navigator.clipboard.writeText(this.setupUrl);
        this.setupLinkCopied = true;
      } catch {
        dispatchNotice(
          "error",
          "The setup link could not be copied. Select and copy it manually.",
        );
      }
    },

    async loadUsers() {
      this.loading = true;
      this.errorMessage = "";
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
        this.errorMessage = error instanceof Error ? error.message : "Users could not be loaded.";
      } finally {
        this.loading = false;
      }
    },

    async addUser() {
      this.busy = true;
      this.errorMessage = "";
      this.successMessage = "";
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
        this.successMessage = kind === "setup"
          ? "User added. Share the setup link with them."
          : "Existing user added to this workspace.";
        await this.loadUsers();
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error ? error.message : "The user could not be added.",
        );
      } finally {
        this.busy = false;
      }
    },

    async changeRole(member, role) {
      this.busy = true;
      this.errorMessage = "";
      try {
        const response = await fetch(`/api/workspace/members/${encodeURIComponent(member.userId)}/role`, {
          body: JSON.stringify({ role }),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        });
        if (!response.ok) {
          await readJsonResponse(response, "Change user role");
        }
        await this.loadUsers();
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error ? error.message : "The role could not be changed.",
        );
        await this.loadUsers();
      } finally {
        this.busy = false;
      }
    },

    async createPasswordReset(member) {
      this.busy = true;
      this.errorMessage = "";
      this.successMessage = "";
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
        this.successMessage = `Password-reset link created for ${member.username}.`;
        this.pendingActionKind = null;
        this.pendingActionUserId = "";
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error
            ? error.message
            : "The password-reset link could not be created.",
        );
      } finally {
        this.busy = false;
      }
    },

    async removeUser(member) {
      this.busy = true;
      this.errorMessage = "";
      try {
        const response = await fetch(`/api/workspace/members/${encodeURIComponent(member.userId)}`, {
          method: "DELETE",
        });
        if (!response.ok) {
          await readJsonResponse(response, "Remove user");
        }
        this.pendingActionKind = null;
        this.pendingActionUserId = "";
        await this.loadUsers();
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error ? error.message : "The user could not be removed.",
        );
      } finally {
        this.busy = false;
      }
    },
  }));
}
