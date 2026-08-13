import {
  readArray,
  readBoolean,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readNullableNonEmptyString,
  readNullableTimestamp,
  readPlainObject,
  readPositiveInteger,
  readTimestamp,
} from "./boundary-readers.js";
import { requestConfirmation } from "./confirmation.js";

const userStates = ["active", "pending", "suspended"];
const workspaceStates = ["active", "archived"];
const oauthConfigurationStates = [
  "disabled",
  "enabled",
  "invalid_origin",
  "unconfigured",
];

function readOAuthConfiguration(value) {
  const configuration = readPlainObject(value, "OAuth configuration");
  const issuer = readNullableNonEmptyString(
    configuration.issuer,
    "OAuth issuer",
  );
  const resource = readNullableNonEmptyString(
    configuration.resource,
    "OAuth resource",
  );
  const workspaceClaim = readNullableNonEmptyString(
    configuration.workspaceClaim,
    "OAuth workspace claim",
  );
  const scopes = [];
  for (const scope of readArray(configuration.scopes, "OAuth scopes")) {
    scopes.push(readNonEmptyString(scope, "OAuth scope"));
  }
  const enabled = readBoolean(configuration.enabled, "OAuth enabled state");
  const status = readEnum(
    configuration.status,
    oauthConfigurationStates,
    "OAuth configuration status",
  );
  const unconfigured = issuer === null
    && resource === null
    && workspaceClaim === null
    && scopes.length === 0;
  const configured = issuer !== null
    && resource !== null
    && workspaceClaim !== null
    && scopes.length > 0;
  if (
    (!unconfigured && !configured)
    || (enabled && !configured)
    || (unconfigured && status !== "unconfigured")
    || (configured && status === "unconfigured")
    || (configured && !enabled && status !== "disabled")
    || (configured && enabled && status === "disabled")
  ) {
    throw new Error("The OAuth configuration response is invalid.");
  }
  return {
    enabled,
    issuer,
    resource,
    scopes,
    status,
    updatedAt: readNullableTimestamp(
      configuration.updatedAt,
      "OAuth configuration update time",
    ),
    version: readPositiveInteger(
      configuration.version,
      "OAuth configuration version",
    ),
    workspaceClaim,
  };
}

function readOAuthUserIdentityLink(value) {
  const link = readPlainObject(value, "OAuth user identity link");
  return {
    createdAt: readTimestamp(link.createdAt, "OAuth user link creation time"),
    displayName: readNonEmptyString(link.displayName, "OAuth user display name"),
    subject: readNonEmptyString(link.subject, "OAuth subject"),
    userId: readNonEmptyString(link.userId, "OAuth user identifier"),
    username: readNonEmptyString(link.username, "OAuth username"),
    userState: readEnum(link.userState, userStates, "OAuth user state"),
  };
}

function readOAuthWorkspaceLink(value) {
  const link = readPlainObject(value, "OAuth workspace link");
  return {
    createdAt: readTimestamp(link.createdAt, "OAuth workspace link creation time"),
    externalWorkspaceId: readNonEmptyString(
      link.externalWorkspaceId,
      "OAuth external workspace identifier",
    ),
    workspaceId: readNonEmptyString(link.workspaceId, "OAuth workspace identifier"),
    workspaceName: readNonEmptyString(link.workspaceName, "OAuth workspace name"),
    workspaceState: readEnum(
      link.workspaceState,
      workspaceStates,
      "OAuth workspace state",
    ),
  };
}

function readOAuthOverview(value) {
  const overview = readPlainObject(value, "OAuth security overview");
  const userIdentityLinks = [];
  for (const link of readArray(overview.userIdentityLinks, "OAuth user links")) {
    userIdentityLinks.push(readOAuthUserIdentityLink(link));
  }
  const workspaceLinks = [];
  for (const link of readArray(overview.workspaceLinks, "OAuth workspace links")) {
    workspaceLinks.push(readOAuthWorkspaceLink(link));
  }
  return {
    configuration: readOAuthConfiguration(overview.configuration),
    userIdentityLinks,
    workspaceLinks,
  };
}

function readWorkspace(value) {
  const workspace = readPlainObject(value, "workspace");
  return {
    id: readNonEmptyString(workspace.id, "workspace identifier"),
    name: readNonEmptyString(workspace.name, "workspace name"),
  };
}

function normalizeSearch(value) {
  return value.trim().toLocaleLowerCase();
}

function parseScopeDraft(value) {
  const scopes = value.split(/[\s,]+/u).filter(Boolean);
  return [...new Set(scopes)].sort();
}

function buildConfigurationDraftKey(configuration) {
  return JSON.stringify({
    issuer: configuration.issuer,
    resource: configuration.resource,
    scopes: configuration.scopes,
    workspaceClaim: configuration.workspaceClaim,
  });
}

export function createOAuthLinkManagement() {
  return {
    oauthBusy: false,
    oauthConfiguration: null,
    oauthConfigurationDrawerOpen: false,
    oauthConfigurationVerifiedKey: null,
    oauthDraftIssuer: "",
    oauthDraftResource: "",
    oauthDraftScopes: "",
    oauthDraftWorkspaceClaim: "",
    oauthError: "",
    oauthExternalWorkspaceId: "",
    oauthLoading: false,
    oauthMappingDrawer: null,
    oauthSubject: "",
    oauthUserId: "",
    oauthUserIdentityLinks: [],
    oauthUserSearch: "",
    oauthVerificationBusy: false,
    oauthWorkspaceId: "",
    oauthWorkspaceLinks: [],
    oauthWorkspaceSearch: "",
    oauthWorkspaces: [],

    get oauthConfigured() {
      return this.oauthConfiguration?.issuer !== null
        && this.oauthConfiguration?.issuer !== undefined;
    },

    get oauthEnabled() {
      return this.oauthConfiguration?.status === "enabled";
    },

    get oauthStoredEnabled() {
      return this.oauthConfiguration?.enabled === true;
    },

    get oauthDraftScopesList() {
      return parseScopeDraft(this.oauthDraftScopes);
    },

    get oauthDraftVerified() {
      if (this.oauthConfigurationVerifiedKey === null) {
        return false;
      }
      return this.oauthConfigurationVerifiedKey === this.oauthDraftKey();
    },

    oauthAvailableUsers() {
      const linked = new Set(this.oauthUserIdentityLinks.map((link) => link.userId));
      return this.organizationUsers.filter((user) => {
        return user.state !== "suspended" && !linked.has(user.userId);
      });
    },

    oauthAvailableWorkspaces() {
      const linked = new Set(
        this.oauthWorkspaceLinks.map((link) => link.workspaceId),
      );
      return this.oauthWorkspaces.filter((workspace) => !linked.has(workspace.id));
    },

    oauthFilteredUserLinks() {
      const query = normalizeSearch(this.oauthUserSearch);
      if (query === "") {
        return this.oauthUserIdentityLinks;
      }
      return this.oauthUserIdentityLinks.filter((link) => {
        return link.subject.toLocaleLowerCase().includes(query)
          || link.displayName.toLocaleLowerCase().includes(query)
          || link.username.toLocaleLowerCase().includes(query);
      });
    },

    oauthFilteredWorkspaceLinks() {
      const query = normalizeSearch(this.oauthWorkspaceSearch);
      if (query === "") {
        return this.oauthWorkspaceLinks;
      }
      return this.oauthWorkspaceLinks.filter((link) => {
        return link.externalWorkspaceId.toLocaleLowerCase().includes(query)
          || link.workspaceName.toLocaleLowerCase().includes(query);
      });
    },

    oauthIssuerHost() {
      const issuer = this.oauthConfiguration?.issuer;
      if (issuer === null || issuer === undefined) {
        return "Not configured";
      }
      try {
        return new URL(issuer).host;
      } catch {
        return issuer;
      }
    },

    oauthDraftKey() {
      const configuration = {
        issuer: this.oauthDraftIssuer.trim(),
        resource: this.oauthDraftResource.trim(),
        scopes: this.oauthDraftScopesList,
        workspaceClaim: this.oauthDraftWorkspaceClaim.trim(),
      };
      return buildConfigurationDraftKey(configuration);
    },

    oauthConfigurationInput() {
      return {
        issuer: this.oauthDraftIssuer.trim(),
        resource: this.oauthDraftResource.trim(),
        scopes: this.oauthDraftScopesList,
        workspaceClaim: this.oauthDraftWorkspaceClaim.trim(),
      };
    },

    oauthConfigurationComplete() {
      const input = this.oauthConfigurationInput();
      return input.issuer !== ""
        && input.resource !== ""
        && input.scopes.length > 0
        && input.workspaceClaim !== "";
    },

    initializeOAuthLinkManagement() {
      if (this.currentGlobalRole !== "global_admin") {
        return;
      }
      void Promise.all([
        this.loadOAuthLinks(),
        this.loadOAuthWorkspaces(),
      ]);
    },

    applyOAuthOverview(overview) {
      this.oauthConfiguration = overview.configuration;
      this.oauthUserIdentityLinks = overview.userIdentityLinks;
      this.oauthWorkspaceLinks = overview.workspaceLinks;
    },

    openOAuthConfiguration() {
      const configuration = this.oauthConfiguration;
      this.oauthDraftIssuer = configuration?.issuer ?? "";
      this.oauthDraftResource = configuration?.resource ?? "";
      this.oauthDraftScopes = configuration?.scopes.join(" ") ?? "";
      this.oauthDraftWorkspaceClaim = configuration?.workspaceClaim ?? "";
      this.oauthConfigurationVerifiedKey = null;
      this.oauthError = "";
      this.oauthConfigurationDrawerOpen = true;
    },

    closeOAuthConfiguration() {
      if (this.oauthBusy || this.oauthVerificationBusy) {
        return;
      }
      this.oauthConfigurationDrawerOpen = false;
      this.oauthConfigurationVerifiedKey = null;
    },

    openOAuthMappingDrawer(kind) {
      if (!this.oauthEnabled || this.oauthBusy) {
        return;
      }
      this.oauthError = "";
      this.oauthSubject = "";
      this.oauthUserId = "";
      this.oauthExternalWorkspaceId = "";
      this.oauthWorkspaceId = "";
      this.oauthMappingDrawer = kind;
    },

    closeOAuthMappingDrawer() {
      if (this.oauthBusy) {
        return;
      }
      this.oauthMappingDrawer = null;
    },

    closeOAuthDrawers() {
      if (this.oauthConfigurationDrawerOpen) {
        this.closeOAuthConfiguration();
        return;
      }
      this.closeOAuthMappingDrawer();
    },

    async verifyOAuthConfiguration() {
      if (this.oauthVerificationBusy || !this.oauthConfigurationComplete()) {
        return;
      }
      this.oauthVerificationBusy = true;
      this.oauthError = "";
      this.oauthConfigurationVerifiedKey = null;
      try {
        const response = await fetch(
          "/api/security/oauth/configuration/verify",
          {
            body: JSON.stringify(this.oauthConfigurationInput()),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        await requireSuccessfulResponse(response, "Verify OAuth configuration");
        this.oauthConfigurationVerifiedKey = this.oauthDraftKey();
      } catch (error) {
        this.oauthError = error instanceof Error
          ? error.message
          : "The OAuth configuration could not be verified.";
      } finally {
        this.oauthVerificationBusy = false;
      }
    },

    async saveOAuthConfiguration() {
      if (
        this.oauthBusy
        || !this.oauthDraftVerified
        || this.oauthConfiguration === null
      ) {
        return;
      }
      this.oauthBusy = true;
      this.oauthError = "";
      try {
        const body = {
          ...this.oauthConfigurationInput(),
          expectedVersion: this.oauthConfiguration.version,
        };
        const response = await fetch("/api/security/oauth/configuration", {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
          method: "PUT",
        });
        await readJsonResponse(
          response,
          "Save OAuth configuration",
          readOAuthConfiguration,
        );
        this.oauthConfigurationDrawerOpen = false;
        this.oauthConfigurationVerifiedKey = null;
        await this.loadOAuthLinks();
      } catch (error) {
        this.oauthError = error instanceof Error
          ? error.message
          : "The OAuth configuration could not be saved.";
      } finally {
        this.oauthBusy = false;
      }
    },

    async disableOAuthConfiguration() {
      if (
        this.oauthBusy
        || !this.oauthStoredEnabled
        || this.oauthConfiguration === null
      ) {
        return;
      }
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep enabled",
        confirmLabel: "Disable OAuth",
        description: "OAuth access tokens will stop working immediately. Existing mappings and configuration will be preserved.",
        title: "Disable OAuth resource access?",
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      this.oauthBusy = true;
      this.oauthError = "";
      try {
        const response = await fetch(
          "/api/security/oauth/configuration/disable",
          {
            body: JSON.stringify({
              expectedVersion: this.oauthConfiguration.version,
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        await readJsonResponse(
          response,
          "Disable OAuth resource access",
          readOAuthConfiguration,
        );
        await this.loadOAuthLinks();
      } catch (error) {
        this.oauthError = error instanceof Error
          ? error.message
          : "OAuth resource access could not be disabled.";
      } finally {
        this.oauthBusy = false;
      }
    },

    async linkOAuthUser() {
      if (
        this.oauthBusy
        || this.oauthUserId === ""
        || this.oauthSubject.trim() === ""
      ) {
        return;
      }
      this.oauthBusy = true;
      this.oauthError = "";
      try {
        const response = await fetch(
          `/api/security/oauth/users/${encodeURIComponent(this.oauthUserId)}`,
          {
            body: JSON.stringify({ subject: this.oauthSubject.trim() }),
            headers: { "Content-Type": "application/json" },
            method: "PUT",
          },
        );
        await requireSuccessfulResponse(response, "Link OAuth user");
        this.oauthMappingDrawer = null;
        await Promise.all([
          this.loadOAuthLinks(),
          this.loadOrganizationUsers(),
        ]);
      } catch (error) {
        this.oauthError = error instanceof Error
          ? error.message
          : "The OAuth user could not be linked.";
      } finally {
        this.oauthBusy = false;
      }
    },

    async linkOAuthWorkspace() {
      if (
        this.oauthBusy
        || this.oauthWorkspaceId === ""
        || this.oauthExternalWorkspaceId.trim() === ""
      ) {
        return;
      }
      this.oauthBusy = true;
      this.oauthError = "";
      try {
        const response = await fetch(
          `/api/security/oauth/workspaces/${encodeURIComponent(this.oauthWorkspaceId)}`,
          {
            body: JSON.stringify({
              externalWorkspaceId: this.oauthExternalWorkspaceId.trim(),
            }),
            headers: { "Content-Type": "application/json" },
            method: "PUT",
          },
        );
        await requireSuccessfulResponse(response, "Link OAuth workspace");
        this.oauthMappingDrawer = null;
        await this.loadOAuthLinks();
      } catch (error) {
        this.oauthError = error instanceof Error
          ? error.message
          : "The OAuth workspace could not be linked.";
      } finally {
        this.oauthBusy = false;
      }
    },

    async loadOAuthLinks() {
      this.oauthLoading = true;
      this.oauthError = "";
      try {
        const response = await fetch("/api/security/oauth", {
          headers: { accept: "application/json" },
        });
        const value = await readJsonResponse(response, "OAuth security settings");
        this.applyOAuthOverview(readOAuthOverview(value));
      } catch (error) {
        this.oauthError = error instanceof Error
          ? error.message
          : "OAuth security settings could not be loaded.";
      } finally {
        this.oauthLoading = false;
      }
    },

    async loadOAuthWorkspaces() {
      try {
        const response = await fetch("/api/workspaces", {
          headers: { accept: "application/json" },
        });
        const value = await readJsonResponse(response, "OAuth workspaces");
        const workspaces = [];
        for (const row of readArray(value, "OAuth workspaces")) {
          workspaces.push(readWorkspace(row));
        }
        this.oauthWorkspaces = workspaces;
      } catch (error) {
        this.oauthError = error instanceof Error
          ? error.message
          : "Workspaces for OAuth linking could not be loaded.";
      }
    },

    async unlinkOAuthUser(link) {
      if (this.oauthBusy) {
        return;
      }
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep mapping",
        confirmLabel: "Remove mapping",
        description: `${link.displayName} will no longer be recognized as OAuth subject ${link.subject}.`,
        title: `Remove the OAuth mapping for ${link.displayName}?`,
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      await this.removeOAuthLink(
        `/api/security/oauth/users/${encodeURIComponent(link.userId)}`,
        "OAuth user mapping",
      );
    },

    async unlinkOAuthWorkspace(link) {
      if (this.oauthBusy) {
        return;
      }
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep mapping",
        confirmLabel: "Remove mapping",
        description: `${link.workspaceName} will no longer accept OAuth requests for external workspace ${link.externalWorkspaceId}.`,
        title: `Remove the OAuth mapping for ${link.workspaceName}?`,
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      await this.removeOAuthLink(
        `/api/security/oauth/workspaces/${encodeURIComponent(link.workspaceId)}`,
        "OAuth workspace mapping",
      );
    },

    async removeOAuthLink(endpoint, operation) {
      this.oauthBusy = true;
      this.oauthError = "";
      try {
        const response = await fetch(endpoint, { method: "DELETE" });
        await requireSuccessfulResponse(response, operation);
        await this.loadOAuthLinks();
      } catch (error) {
        this.oauthError = error instanceof Error
          ? error.message
          : "The OAuth mapping could not be removed.";
      } finally {
        this.oauthBusy = false;
      }
    },
  };
}

async function requireSuccessfulResponse(response, operation) {
  if (response.ok) {
    return;
  }
  await readJsonResponse(response, operation);
}
