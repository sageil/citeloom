import {
  readArray,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readPlainObject,
} from "./boundary-readers.js";
import { requestConfirmation } from "./confirmation.js";

function readMember(value) {
  const member = readPlainObject(value, "workspace member");
  return {
    access: readEnum(
      member.access,
      ["enabled", "disabled"],
      "member workspace access",
    ),
    displayName: readNonEmptyString(member.displayName, "member display name"),
    globalRole: readEnum(
      member.globalRole,
      ["global_admin", "standard"],
      "member global role",
    ),
    role: readEnum(member.role, ["admin", "member"], "member role"),
    state: readEnum(member.state, ["active", "pending", "suspended"], "member state"),
    userId: readNonEmptyString(member.userId, "member identifier"),
    username: readNonEmptyString(member.username, "member username"),
  };
}

function readMemberCandidate(value) {
  const candidate = readPlainObject(value, "workspace member candidate");
  return {
    displayName: readNonEmptyString(
      candidate.displayName,
      "candidate display name",
    ),
    globalRole: readEnum(
      candidate.globalRole,
      ["global_admin", "standard"],
      "candidate global role",
    ),
    state: readEnum(
      candidate.state,
      ["active", "pending", "suspended"],
      "candidate account state",
    ),
    userId: readNonEmptyString(candidate.userId, "candidate identifier"),
    username: readNonEmptyString(candidate.username, "candidate username"),
  };
}

export function createWorkspaceUserManagement(options = {}) {
  const title = options.title ?? "Workspace users";
  const showRoleGuide = options.showRoleGuide ?? true;
  const actionsLabel = options.actionsLabel ?? "Actions";
  return {
    addMemberOpen: false,
    memberCandidates: [],
    memberRoleDraft: "member",
    members: [],
    selectedMemberCandidateId: "",
    showUserRoleGuide: showRoleGuide,
    userManagementActionsLabel: actionsLabel,
    userManagementBusy: false,
    userManagementError: "",
    userManagementLoadFailed: false,
    userManagementLoading: true,
    userManagementTitle: title,

    workspaceMembersUrl(userId = null, action = null) {
      const scope = this.settings?.scope;
      if (scope?.kind !== "workspace") {
        throw new Error("Select a workspace before managing users.");
      }
      let url = `/api/workspaces/${encodeURIComponent(scope.id)}/members`;
      if (userId !== null) {
        url += `/${encodeURIComponent(userId)}`;
      }
      if (action !== null) {
        url += `/${action}`;
      }
      return url;
    },

    workspaceMemberCandidatesUrl() {
      const scope = this.settings?.scope;
      if (scope?.kind !== "workspace") {
        throw new Error("Select a workspace before managing users.");
      }
      return `/api/workspaces/${encodeURIComponent(scope.id)}/member-candidates`;
    },

    afterWorkspaceUserMutation() {
      return Promise.resolve();
    },

    closeAddMember() {
      if (this.userManagementBusy) {
        return;
      }
      this.addMemberOpen = false;
      this.memberRoleDraft = "member";
      this.selectedMemberCandidateId = "";
    },

    initializeUserManagement() {
      void this.loadUsers();
    },

    destroyUserManagement() {
      this.addMemberOpen = false;
      this.memberCandidates = [];
      this.memberRoleDraft = "member";
      this.members = [];
      this.selectedMemberCandidateId = "";
      this.userManagementBusy = false;
      this.userManagementError = "";
      this.userManagementLoadFailed = false;
      this.userManagementLoading = true;
    },

    openAddMember() {
      this.addMemberOpen = true;
      const candidate = this.memberCandidates[0];
      this.selectedMemberCandidateId = candidate?.userId ?? "";
      this.memberRoleDraft = candidate?.globalRole === "global_admin"
        ? "admin"
        : "member";
    },

    selectMemberCandidate(userId) {
      this.selectedMemberCandidateId = userId;
      if (this.selectedMemberCandidateIsGlobalAdministrator()) {
        this.memberRoleDraft = "admin";
      }
    },

    selectedMemberCandidateIsGlobalAdministrator() {
      for (const candidate of this.memberCandidates) {
        if (candidate.userId === this.selectedMemberCandidateId) {
          return candidate.globalRole === "global_admin";
        }
      }
      return false;
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

    enabledWorkspaceUserCount() {
      let count = 0;
      for (const member of this.members) {
        if (member.access === "enabled") {
          count += 1;
        }
      }
      return count;
    },

    async loadUsers() {
      this.userManagementLoading = true;
      this.userManagementError = "";
      this.userManagementLoadFailed = false;
      try {
        const requestOptions = { headers: { accept: "application/json" } };
        const responses = await Promise.all([
          fetch(this.workspaceMembersUrl(), requestOptions),
          fetch(this.workspaceMemberCandidatesUrl(), requestOptions),
        ]);
        const memberValue = await readJsonResponse(
          responses[0],
          "Workspace users",
        );
        const candidateValue = await readJsonResponse(
          responses[1],
          "Available workspace users",
        );
        const memberRows = readArray(memberValue, "workspace users");
        const candidateRows = readArray(
          candidateValue,
          "available workspace users",
        );
        const members = [];
        for (const row of memberRows) {
          members.push(readMember(row));
        }
        const memberCandidates = [];
        for (const row of candidateRows) {
          memberCandidates.push(readMemberCandidate(row));
        }
        this.members = members;
        this.memberCandidates = memberCandidates;
        if (this.addMemberOpen) {
          this.selectMemberCandidate(memberCandidates[0]?.userId ?? "");
        }
      } catch (error) {
        this.userManagementLoadFailed = true;
        this.userManagementError = error instanceof Error
          ? error.message
          : "Users could not be loaded.";
      } finally {
        this.userManagementLoading = false;
      }
    },

    async addWorkspaceMember() {
      if (this.selectedMemberCandidateId === "") {
        return;
      }
      this.userManagementBusy = true;
      this.userManagementError = "";
      try {
        const response = await fetch(this.workspaceMembersUrl(), {
          body: JSON.stringify({
            role: this.memberRoleDraft,
            userId: this.selectedMemberCandidateId,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        if (!response.ok) {
          await readJsonResponse(response, "Add user to workspace");
        }
        this.addMemberOpen = false;
        this.memberRoleDraft = "member";
        this.selectedMemberCandidateId = "";
        await this.loadUsers();
        await this.afterWorkspaceUserMutation();
      } catch (error) {
        this.userManagementError = error instanceof Error
          ? error.message
          : "The user could not be added to this workspace.";
      } finally {
        this.userManagementBusy = false;
      }
    },

    async changeRole(member, role) {
      this.userManagementBusy = true;
      this.userManagementError = "";
      try {
        const response = await fetch(
          this.workspaceMembersUrl(member.userId, "role"),
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
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : "The role could not be changed.";
        await this.loadUsers();
        this.userManagementError = message;
      } finally {
        this.userManagementBusy = false;
      }
    },

    async changeAccess(member, access) {
      this.userManagementBusy = true;
      this.userManagementError = "";
      try {
        const response = await fetch(
          this.workspaceMembersUrl(member.userId, "access"),
          {
            body: JSON.stringify({ access }),
            headers: { "Content-Type": "application/json" },
            method: "PUT",
          },
        );
        if (!response.ok) {
          await readJsonResponse(response, "Change workspace access");
        }
        await this.loadUsers();
        await this.afterWorkspaceUserMutation();
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : "Workspace access could not be changed.";
        await this.loadUsers();
        this.userManagementError = message;
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
      this.userManagementError = "";
      try {
        const response = await fetch(
          this.workspaceMembersUrl(member.userId),
          { method: "DELETE" },
        );
        if (!response.ok) {
          await readJsonResponse(response, "Remove user");
        }
        await this.loadUsers();
        await this.afterWorkspaceUserMutation();
      } catch (error) {
        this.userManagementError = error instanceof Error
          ? error.message
          : "The user could not be removed.";
      } finally {
        this.userManagementBusy = false;
      }
    },
  };
}
