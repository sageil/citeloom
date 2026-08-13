import {
  readArray,
  readBoolean,
  readJsonResponse,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullableNonEmptyString,
  readPlainObject,
  readPositiveInteger,
  readTimestamp,
} from "./boundary-readers.js";
import { requestConfirmation } from "./confirmation.js";
import { createOrganizationUserManagement } from "./organization-users.js";
import { createOAuthLinkManagement } from "./oauth-links.js";

function readAdministrator(value) {
  const administrator = readPlainObject(value, "security administrator");
  const state = readNonEmptyString(administrator.state, "administrator state");
  if (!["active", "pending", "suspended"].includes(state)) {
    throw new Error("The administrator state response is invalid.");
  }
  return {
    displayName: readNonEmptyString(administrator.displayName, "administrator display name"),
    role: "admin",
    state,
    userId: readNonEmptyString(administrator.userId, "administrator identifier"),
    username: readNonEmptyString(administrator.username, "administrator username"),
  };
}

function readPolicy(value) {
  const policy = readPlainObject(value, "security policy");
  const minimumPasswordLength = readPositiveInteger(
    policy.minimumPasswordLength,
    "minimum password length",
  );
  if (minimumPasswordLength < 9 || minimumPasswordLength > 64) {
    throw new Error("The minimum password length response is invalid.");
  }
  const resetLinkLifetimeSeconds = readPositiveInteger(
    policy.resetLinkLifetimeSeconds,
    "reset link lifetime",
  );
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
    resetLinkLifetimeSeconds,
    updatedAt: readTimestamp(policy.updatedAt, "policy update time"),
    version: readPositiveInteger(policy.version, "security policy version"),
  };
}

function readPolicyChange(value) {
  const change = readPlainObject(value, "security policy change");
  return {
    changedAt: readTimestamp(change.changedAt, "policy change time"),
    changedByDisplayName: readNullableNonEmptyString(
      change.changedByDisplayName,
      "policy administrator display name",
    ),
    changedByUsername: readNullableNonEmptyString(
      change.changedByUsername,
      "policy administrator username",
    ),
    id: readNonEmptyString(change.id, "policy change identifier"),
    minimumPasswordLength: readPositiveInteger(
      change.minimumPasswordLength,
      "changed minimum password length",
    ),
    requireLetterAndNumber: readBoolean(
      change.requireLetterAndNumber,
      "changed letter and number requirement",
    ),
    requireSpecialCharacter: readBoolean(
      change.requireSpecialCharacter,
      "changed special character requirement",
    ),
    resetLinkLifetimeSeconds: readPositiveInteger(
      change.resetLinkLifetimeSeconds,
      "changed reset link lifetime",
    ),
    revokedResetLinkCount: readNonNegativeInteger(
      change.revokedResetLinkCount,
      "revoked reset link count",
    ),
  };
}

function readSecurityOverview(value) {
  const overview = readPlainObject(value, "security overview");
  const administratorValues = readArray(
    overview.administrators,
    "security administrators",
  );
  const administrators = [];
  for (const administrator of administratorValues) {
    administrators.push(readAdministrator(administrator));
  }
  const changeValues = readArray(overview.recentChanges, "security policy changes");
  const recentChanges = [];
  for (const change of changeValues) {
    recentChanges.push(readPolicyChange(change));
  }
  return {
    activeResetLinkCount: readNonNegativeInteger(
      overview.activeResetLinkCount,
      "active reset link count",
    ),
    administrators,
    policy: readPolicy(overview.policy),
    recentChanges,
  };
}

function copyEditablePolicy(policy) {
  return {
    minimumPasswordLength: policy.minimumPasswordLength,
    requireLetterAndNumber: policy.requireLetterAndNumber,
    requireSpecialCharacter: policy.requireSpecialCharacter,
    resetLinkLifetimeSeconds: policy.resetLinkLifetimeSeconds,
    version: policy.version,
  };
}

export function registerPage(alpine) {
  alpine.data("citeloomSecurityPage", () => ({
    ...createOrganizationUserManagement(),
    ...createOAuthLinkManagement(),
    activeResetLinkCount: 0,
    administrators: [],
    busy: false,
    errorMessage: "",
    globalAdministratorSectionsInitialized: false,
    invalidateOutstandingResetLinks: false,
    loadFailed: false,
    loading: true,
    minimumPasswordLength: null,
    recentChanges: [],
    requireLetterAndNumber: null,
    requireSpecialCharacter: null,
    resetLinkLifetimeSeconds: null,
    savedPolicy: null,
    securitySection: "password",
    version: null,

    get policyChanged() {
      if (this.savedPolicy === null) {
        return false;
      }
      return this.minimumPasswordLength !== this.savedPolicy.minimumPasswordLength
        || this.requireLetterAndNumber !== this.savedPolicy.requireLetterAndNumber
        || this.requireSpecialCharacter !== this.savedPolicy.requireSpecialCharacter
        || this.resetLinkLifetimeSeconds !== this.savedPolicy.resetLinkLifetimeSeconds;
    },

    initialize() {
      this.$watch("currentGlobalRole", () => {
        this.initializeGlobalAdministratorSections();
      });
      void this.loadOverview();
      this.initializeGlobalAdministratorSections();
    },

    initializeGlobalAdministratorSections() {
      if (
        this.currentGlobalRole !== "global_admin"
        || this.globalAdministratorSectionsInitialized
      ) {
        return;
      }
      this.globalAdministratorSectionsInitialized = true;
      this.securitySection = "users";
      this.initializeOrganizationUserManagement();
      this.initializeOAuthLinkManagement();
    },

    selectSecuritySection(section) {
      if (
        section !== "password"
        && section !== "users"
        && section !== "oauth"
      ) {
        return;
      }
      if (
        this.currentGlobalRole !== "global_admin"
        && section !== "password"
      ) {
        return;
      }
      this.securitySection = section;
    },

    applyOverview(overview) {
      this.activeResetLinkCount = overview.activeResetLinkCount;
      this.administrators = overview.administrators;
      this.recentChanges = overview.recentChanges;
      this.minimumPasswordLength = overview.policy.minimumPasswordLength;
      this.requireLetterAndNumber = overview.policy.requireLetterAndNumber;
      this.requireSpecialCharacter = overview.policy.requireSpecialCharacter;
      this.resetLinkLifetimeSeconds = overview.policy.resetLinkLifetimeSeconds;
      this.version = overview.policy.version;
      this.savedPolicy = copyEditablePolicy(overview.policy);
      this.invalidateOutstandingResetLinks = false;
    },

    discardChanges() {
      if (this.savedPolicy === null || this.busy) {
        return;
      }
      this.minimumPasswordLength = this.savedPolicy.minimumPasswordLength;
      this.requireLetterAndNumber = this.savedPolicy.requireLetterAndNumber;
      this.requireSpecialCharacter = this.savedPolicy.requireSpecialCharacter;
      this.resetLinkLifetimeSeconds = this.savedPolicy.resetLinkLifetimeSeconds;
      this.invalidateOutstandingResetLinks = false;
    },

    formatChange(change) {
      const requirements = [];
      if (change.requireLetterAndNumber) {
        requirements.push("letters and numbers");
      }
      if (change.requireSpecialCharacter) {
        requirements.push("special character");
      }
      const requirementText = requirements.length === 0
        ? "no content rules"
        : requirements.join(" and ");
      const revokedText = change.revokedResetLinkCount === 0
        ? ""
        : `, ${change.revokedResetLinkCount} ${change.revokedResetLinkCount === 1 ? "link" : "links"} revoked`;
      return `Minimum ${change.minimumPasswordLength}, ${requirementText}, reset lifetime ${this.formatLifetime(change.resetLinkLifetimeSeconds)}${revokedText}`;
    },

    formatDate(value) {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value));
    },

    formatLifetime(seconds) {
      if (seconds < 3_600) {
        const minutes = seconds / 60;
        return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
      }
      if (seconds < 86_400) {
        const hours = seconds / 3_600;
        return `${hours} ${hours === 1 ? "hour" : "hours"}`;
      }
      const days = seconds / 86_400;
      return `${days} ${days === 1 ? "day" : "days"}`;
    },

    async loadOverview() {
      this.loading = true;
      this.errorMessage = "";
      this.loadFailed = false;
      try {
        const response = await fetch("/api/security", {
          headers: { accept: "application/json" },
        });
        const value = await readJsonResponse(response, "Security settings");
        this.applyOverview(readSecurityOverview(value));
      } catch (error) {
        this.loadFailed = true;
        this.errorMessage = error instanceof Error
          ? error.message
          : "Security settings could not be loaded.";
      } finally {
        this.loading = false;
      }
    },

    async afterWorkspaceUserMutation() {
      try {
        const response = await fetch("/api/security", {
          headers: { accept: "application/json" },
        });
        const value = await readJsonResponse(response, "Security settings");
        const overview = readSecurityOverview(value);
        this.activeResetLinkCount = overview.activeResetLinkCount;
        this.administrators = overview.administrators;
        this.recentChanges = overview.recentChanges;
      } catch (error) {
        this.errorMessage = error instanceof Error
          ? error.message
          : "Security status could not be refreshed.";
      }
    },

    async persistPolicy(revokeLinks) {
      const policy = {
        minimumPasswordLength: this.minimumPasswordLength,
        requireLetterAndNumber: this.requireLetterAndNumber,
        requireSpecialCharacter: this.requireSpecialCharacter,
        resetLinkLifetimeSeconds: this.resetLinkLifetimeSeconds,
      };
      return this.persistPolicyValues(policy, revokeLinks);
    },

    async persistPolicyValues(policy, revokeLinks) {
      this.busy = true;
      this.errorMessage = "";
      try {
        const response = await fetch("/api/security/policy", {
          body: JSON.stringify({
            expectedVersion: this.version,
            invalidateOutstandingResetLinks: revokeLinks,
            minimumPasswordLength: policy.minimumPasswordLength,
            requireLetterAndNumber: policy.requireLetterAndNumber,
            requireSpecialCharacter: policy.requireSpecialCharacter,
            resetLinkLifetimeSeconds: policy.resetLinkLifetimeSeconds,
          }),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        });
        const value = await readJsonResponse(response, "Save security policy");
        this.applyOverview(readSecurityOverview(value));
        return true;
      } catch (error) {
        this.errorMessage = error instanceof Error
          ? error.message
          : "The security policy could not be saved.";
        return false;
      } finally {
        this.busy = false;
      }
    },

    async revokeAllLinks() {
      if (this.busy || this.activeResetLinkCount === 0) {
        return;
      }
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep links",
        confirmLabel: "Revoke all links",
        description: `This permanently invalidates ${this.activeResetLinkCount} active password ${this.activeResetLinkCount === 1 ? "link" : "links"}. Users will need a new link to set or reset their password.`,
        title: "Revoke all password links?",
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      if (this.savedPolicy === null) {
        return;
      }
      const draftPolicy = this.policyChanged
        ? {
          minimumPasswordLength: this.minimumPasswordLength,
          requireLetterAndNumber: this.requireLetterAndNumber,
          requireSpecialCharacter: this.requireSpecialCharacter,
          resetLinkLifetimeSeconds: this.resetLinkLifetimeSeconds,
        }
        : null;
      const saved = await this.persistPolicyValues(
        this.savedPolicy,
        true,
      );
      if (saved && draftPolicy !== null) {
        this.minimumPasswordLength = draftPolicy.minimumPasswordLength;
        this.requireLetterAndNumber = draftPolicy.requireLetterAndNumber;
        this.requireSpecialCharacter = draftPolicy.requireSpecialCharacter;
        this.resetLinkLifetimeSeconds = draftPolicy.resetLinkLifetimeSeconds;
      }
    },

    async savePolicy() {
      if (this.busy) {
        return;
      }
      if (
        !Number.isInteger(this.minimumPasswordLength)
        || this.minimumPasswordLength < 9
        || this.minimumPasswordLength > 64
      ) {
        this.errorMessage =
          "Minimum password length must be between 9 and 64 characters.";
        return;
      }
      const revokeLinks = this.invalidateOutstandingResetLinks
        && this.activeResetLinkCount > 0;
      if (revokeLinks) {
        const confirmed = await requestConfirmation({
          cancelLabel: "Review policy",
          confirmLabel: "Save and revoke",
          description: `Saving this policy will also permanently invalidate ${this.activeResetLinkCount} active password ${this.activeResetLinkCount === 1 ? "link" : "links"}.`,
          title: "Save policy and revoke links?",
          tone: "danger",
        });
        if (!confirmed) {
          return;
        }
      }
      await this.persistPolicy(revokeLinks);
    },
  }));
}
