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
import { browserAuthentication } from "./browser-authentication.js";
import { requestConfirmation, showMessage } from "./confirmation.js";

const userStates = ["active", "pending", "suspended"];

function readScopes(value, label) {
  const scopes = [];
  for (const scope of readArray(value, label)) {
    scopes.push(readNonEmptyString(scope, "OAuth scope"));
  }
  if (scopes.length === 0) {
    throw new Error(`The ${label} response is invalid.`);
  }
  return scopes;
}

function readOAuthConfiguration(value) {
  const configuration = readPlainObject(value, "OAuth configuration");
  return {
    apiResource: readNonEmptyString(
      configuration.apiResource,
      "OAuth API resource",
    ),
    apiScopes: readScopes(configuration.apiScopes, "OAuth API scopes"),
    browserCallbackUri: readNonEmptyString(
      configuration.browserCallbackUri,
      "OAuth browser callback URI",
    ),
    browserClientId: readNonEmptyString(
      configuration.browserClientId,
      "OAuth browser client ID",
    ),
    browserPostLogoutRedirectUri: readNonEmptyString(
      configuration.browserPostLogoutRedirectUri,
      "OAuth browser post-logout URI",
    ),
    browserScopes: readScopes(
      configuration.browserScopes,
      "OAuth browser scopes",
    ),
    issuer: readNonEmptyString(configuration.issuer, "OAuth issuer"),
    mcpResource: readNonEmptyString(
      configuration.mcpResource,
      "OAuth MCP resource",
    ),
    mcpScopes: readScopes(configuration.mcpScopes, "OAuth MCP scopes"),
  };
}

function readNullableOAuthConfiguration(value) {
  return value === null ? null : readOAuthConfiguration(value);
}

function readAuthenticationSettings(value) {
  const settings = readPlainObject(value, "authentication settings");
  const mode = readEnum(
    settings.mode,
    ["local", "oauth"],
    "authentication mode",
  );
  const activeOAuthConfiguration = readNullableOAuthConfiguration(
    settings.activeOAuthConfiguration,
  );
  const stagedOAuthConfiguration = readNullableOAuthConfiguration(
    settings.stagedOAuthConfiguration,
  );
  if (mode === "oauth" && activeOAuthConfiguration === null) {
    throw new Error("The OAuth authentication settings response is invalid.");
  }
  return {
    activeOAuthConfiguration,
    activatedAt: readNullableTimestamp(
      settings.activatedAt,
      "OAuth activation time",
    ),
    hostRecoveryEnabled: readBoolean(
      settings.hostRecoveryEnabled,
      "host authentication recovery setting",
    ),
    mode,
    stagedOAuthConfiguration,
    updatedAt: readNullableTimestamp(
      settings.updatedAt,
      "authentication update time",
    ),
    version: readPositiveInteger(
      settings.version,
      "authentication settings version",
    ),
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

function readAuthenticationOverview(value) {
  const overview = readPlainObject(value, "authentication security overview");
  const userIdentityLinks = [];
  for (const link of readArray(overview.userIdentityLinks, "OAuth user links")) {
    userIdentityLinks.push(readOAuthUserIdentityLink(link));
  }
  return {
    managedIssuer: readNullableNonEmptyString(
      overview.managedIssuer,
      "managed OAuth issuer",
    ),
    settings: readAuthenticationSettings(overview.settings),
    userIdentityLinks,
  };
}

function normalizeSearch(value) {
  return value.trim().toLocaleLowerCase();
}

function showOAuthError(error, fallback, title) {
  const description = error instanceof Error ? error.message : fallback;
  void showMessage({
    actionLabel: "Close",
    description,
    title,
    tone: "danger",
  });
}

function parseScopeDraft(value) {
  return [...new Set(value.split(/[\s,]+/u).filter(Boolean))].sort();
}

async function requireSuccessfulResponse(response, operation) {
  if (response.ok) {
    return;
  }
  await readJsonResponse(response, operation);
}

export function createOAuthLinkManagement() {
  return {
    oauthApiScopes: "",
    oauthBrowserClientId: "",
    oauthBrowserScopes: "",
    oauthBusy: false,
    oauthConfigurationDrawerOpen: false,
    oauthLoading: false,
    oauthMappingDrawer: null,
    oauthMcpScopes: "",
    oauthSettings: null,
    oauthIssuer: "",
    oauthSubject: "",
    oauthUserId: "",
    oauthUserIdentityLinks: [],
    oauthUserSearch: "",

    get oauthActive() {
      return this.oauthSettings?.mode === "oauth";
    },

    get oauthConfigured() {
      return this.oauthManagedConfiguration !== null;
    },

    get oauthHostRecoveryEnabled() {
      return this.oauthSettings?.hostRecoveryEnabled === true;
    },

    get oauthManagedConfiguration() {
      return this.oauthSettings?.stagedOAuthConfiguration
        ?? this.oauthSettings?.activeOAuthConfiguration
        ?? null;
    },

    get oauthStaged() {
      return this.oauthSettings?.stagedOAuthConfiguration !== null
        && this.oauthSettings?.stagedOAuthConfiguration !== undefined;
    },

    oauthAvailableUsers() {
      const linked = new Set(this.oauthUserIdentityLinks.map((link) => link.userId));
      return this.organizationUsers.filter((user) => {
        return user.state !== "suspended" && !linked.has(user.userId);
      });
    },

    oauthConfigurationComplete() {
      return this.oauthIssuer.trim() !== ""
        && this.oauthBrowserClientId.trim() !== ""
        && parseScopeDraft(this.oauthBrowserScopes).length > 0
        && parseScopeDraft(this.oauthApiScopes).length > 0
        && parseScopeDraft(this.oauthMcpScopes).length > 0;
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

    oauthIssuerHost() {
      const issuer = this.oauthManagedConfiguration?.issuer;
      if (issuer === null || issuer === undefined) {
        return "Not configured";
      }
      try {
        return new URL(issuer).host;
      } catch {
        return issuer;
      }
    },

    initializeOAuthLinkManagement() {
      if (this.currentGlobalRole === "global_admin") {
        void this.loadOAuthLinks();
      }
    },

    applyOAuthOverview(overview) {
      this.oauthSettings = overview.settings;
      this.oauthUserIdentityLinks = overview.userIdentityLinks;
    },

    openOAuthConfiguration() {
      const configuration = this.oauthManagedConfiguration;
      this.oauthIssuer = configuration?.issuer ?? "";
      this.oauthBrowserClientId = configuration?.browserClientId ?? "";
      this.oauthBrowserScopes = configuration?.browserScopes.join(" ") ?? "";
      this.oauthApiScopes = configuration?.apiScopes.join(" ") ?? "";
      this.oauthMcpScopes = configuration?.mcpScopes.join(" ") ?? "";
      this.oauthConfigurationDrawerOpen = true;
    },

    closeOAuthConfiguration() {
      if (!this.oauthBusy) {
        this.oauthConfigurationDrawerOpen = false;
      }
    },

    openOAuthMappingDrawer() {
      if (!this.oauthConfigured || this.oauthBusy) {
        return;
      }
      this.oauthSubject = "";
      this.oauthUserId = "";
      this.oauthMappingDrawer = "user";
    },

    closeOAuthMappingDrawer() {
      if (!this.oauthBusy) {
        this.oauthMappingDrawer = null;
      }
    },

    closeOAuthDrawers() {
      if (this.oauthConfigurationDrawerOpen) {
        this.closeOAuthConfiguration();
        return;
      }
      this.closeOAuthMappingDrawer();
    },

    async saveOAuthConfiguration() {
      if (
        this.oauthBusy
        || !this.oauthConfigurationComplete()
        || this.oauthSettings === null
      ) {
        return;
      }
      this.oauthBusy = true;
      try {
        const response = await fetch(
          "/api/security/authentication/oauth/staged",
          {
            body: JSON.stringify({
              apiScopes: parseScopeDraft(this.oauthApiScopes),
              browserClientId: this.oauthBrowserClientId.trim(),
              browserScopes: parseScopeDraft(this.oauthBrowserScopes),
              expectedVersion: this.oauthSettings.version,
              issuer: this.oauthIssuer.trim(),
              mcpScopes: parseScopeDraft(this.oauthMcpScopes),
            }),
            headers: { "content-type": "application/json" },
            method: "PUT",
          },
        );
        await readJsonResponse(response, "Stage OAuth authentication");
        this.oauthConfigurationDrawerOpen = false;
        await this.loadOAuthLinks();
      } catch (error) {
        showOAuthError(
          error,
          "OAuth authentication could not be staged.",
          "OAuth settings could not be staged",
        );
      } finally {
        this.oauthBusy = false;
      }
    },

    async activateOAuthConfiguration() {
      if (
        !this.oauthStaged
        || !this.oauthHostRecoveryEnabled
        || this.oauthSettings === null
        || this.oauthBusy
      ) {
        return;
      }
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep cookie sign-in",
        confirmLabel: "Verify and activate OAuth",
        description: "You will verify the staged external identity. Successful activation revokes every CiteLoom cookie session and makes OAuth the only application sign-in method.",
        title: "Replace cookie authentication?",
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      this.oauthBusy = true;
      try {
        await browserAuthentication.beginActivation(
          this.oauthSettings.stagedOAuthConfiguration,
          this.oauthSettings.version,
        );
      } catch (error) {
        this.oauthBusy = false;
        showOAuthError(
          error,
          "OAuth activation could not be started.",
          "OAuth activation could not start",
        );
      }
    },

    async toggleHostAuthenticationRecovery() {
      if (this.oauthSettings === null || this.oauthBusy || this.oauthActive) {
        return;
      }
      const enabled = !this.oauthHostRecoveryEnabled;
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep current setting",
        confirmLabel: enabled ? "Enable host recovery" : "Disable host recovery",
        description: enabled
          ? "This allows a host operator with database access to switch OAuth back to cookie sign-in if the identity provider is unavailable. It does not sign in any user or change passwords."
          : "The host recovery command will no longer be able to switch authentication modes. OAuth cannot be activated until host recovery is enabled again.",
        title: enabled
          ? "Enable host authentication recovery?"
          : "Disable host authentication recovery?",
        tone: enabled ? "default" : "danger",
      });
      if (!confirmed) {
        return;
      }
      this.oauthBusy = true;
      try {
        const response = await fetch(
          "/api/security/authentication/host-recovery",
          {
            body: JSON.stringify({
              enabled,
              expectedVersion: this.oauthSettings.version,
            }),
            headers: { "content-type": "application/json" },
            method: "PUT",
          },
        );
        await readJsonResponse(response, "Configure host authentication recovery");
        await this.loadOAuthLinks();
      } catch (error) {
        showOAuthError(
          error,
          "Host authentication recovery could not be configured.",
          "Host recovery could not be changed",
        );
      } finally {
        this.oauthBusy = false;
      }
    },

    async disableOAuthConfiguration() {
      if (!this.oauthActive || this.oauthSettings === null || this.oauthBusy) {
        return;
      }
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep OAuth active",
        confirmLabel: "Use cookie sign-in",
        description: "OAuth bearer tokens will stop authenticating CiteLoom. Users must sign in with their CiteLoom username and password.",
        title: "Switch back to cookie authentication?",
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      this.oauthBusy = true;
      try {
        const response = await fetch(
          "/api/security/authentication/oauth/disable",
          {
            body: JSON.stringify({ expectedVersion: this.oauthSettings.version }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
        );
        await readJsonResponse(response, "Disable OAuth authentication");
        await browserAuthentication.signOut();
      } catch (error) {
        this.oauthBusy = false;
        showOAuthError(
          error,
          "OAuth authentication could not be disabled.",
          "OAuth could not be disabled",
        );
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
      try {
        const response = await fetch(
          `/api/security/authentication/oauth/users/${encodeURIComponent(this.oauthUserId)}`,
          {
            body: JSON.stringify({ subject: this.oauthSubject.trim() }),
            headers: { "content-type": "application/json" },
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
        showOAuthError(
          error,
          "The OAuth user could not be linked.",
          "The OAuth user could not be linked",
        );
      } finally {
        this.oauthBusy = false;
      }
    },

    async loadOAuthLinks() {
      this.oauthLoading = true;
      try {
        const response = await fetch("/api/security/authentication", {
          headers: { accept: "application/json" },
        });
        const value = await readJsonResponse(
          response,
          "Authentication security settings",
        );
        this.applyOAuthOverview(readAuthenticationOverview(value));
      } catch (error) {
        showOAuthError(
          error,
          "Authentication security settings could not be loaded.",
          "Authentication settings could not load",
        );
      } finally {
        this.oauthLoading = false;
      }
    },

    oauthLinkRemovalDisabled(link) {
      return this.oauthBusy
        || (
          this.oauthActive
          && this.currentUserId !== null
          && link.userId === this.currentUserId
        );
    },

    async unlinkOAuthUser(link) {
      if (this.oauthLinkRemovalDisabled(link)) {
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
      this.oauthBusy = true;
      try {
        const response = await fetch(
          `/api/security/authentication/oauth/users/${encodeURIComponent(link.userId)}`,
          { method: "DELETE" },
        );
        await requireSuccessfulResponse(response, "Remove OAuth user mapping");
        await this.loadOAuthLinks();
      } catch (error) {
        showOAuthError(
          error,
          "The OAuth mapping could not be removed.",
          "The OAuth mapping could not be removed",
        );
      } finally {
        this.oauthBusy = false;
      }
    },
  };
}
