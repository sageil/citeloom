import {
  readArray,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readNullableNonEmptyString,
  readPlainObject,
  readTimestamp,
} from "./boundary-readers.js";
import { requestConfirmation } from "./confirmation.js";

const API_KEY_SCOPES = ["citeloom.search", "citeloom.answer"];

function readMcpApiKey(value, includeSecret = false) {
  const key = readPlainObject(value, "MCP API key");
  const scopeValues = readArray(key.scopes, "MCP API key scopes");
  const scopes = [];
  for (const scope of scopeValues) {
    scopes.push(readEnum(scope, API_KEY_SCOPES, "MCP API key scope"));
  }
  const record = {
    createdAt: readTimestamp(key.createdAt, "MCP API key creation time"),
    expiresAt: readTimestamp(key.expiresAt, "MCP API key expiry"),
    id: readNonEmptyString(key.id, "MCP API key identifier"),
    label: readNullableNonEmptyString(key.label, "MCP API key label"),
    revokedAt: key.revokedAt === null
      ? null
      : readTimestamp(key.revokedAt, "MCP API key revocation time"),
    scopes,
    userId: readNonEmptyString(key.userId, "MCP API key user identifier"),
  };
  if (!includeSecret) {
    return record;
  }
  return {
    ...record,
    apiKey: readNonEmptyString(key.apiKey, "MCP API key secret"),
  };
}

export function createMcpApiKeyManagement() {
  return {
    mcpApiKeyAnswerScope: true,
    mcpApiKeyBusy: false,
    mcpApiKeyCopied: false,
    mcpApiKeyDrawerOpen: false,
    mcpApiKeyExpirationDays: 90,
    mcpApiKeyLabel: "",
    mcpApiKeys: [],
    mcpApiKeySearchScope: true,
    mcpApiKeySecret: "",
    mcpApiKeyUser: null,

    accountCanManageMcpApiKeys(user) {
      if (user.state !== "active") {
        return false;
      }
      return this.currentGlobalRole === "global_admin"
        || user.currentWorkspaceAccess;
    },

    closeMcpApiKeyDrawer() {
      if (this.mcpApiKeyBusy) {
        return;
      }
      this.mcpApiKeyDrawerOpen = false;
      this.mcpApiKeySecret = "";
      this.mcpApiKeyUser = null;
      this.mcpApiKeys = [];
    },

    copyMcpApiKey() {
      if (this.mcpApiKeySecret === "") {
        return;
      }
      navigator.clipboard.writeText(this.mcpApiKeySecret).then(() => {
        this.mcpApiKeyCopied = true;
      }).catch(() => {
        this.accountError =
          "The MCP API key could not be copied. Select and copy it manually.";
      });
    },

    async createMcpApiKey() {
      if (
        this.mcpApiKeyBusy
        || this.mcpApiKeyUser === null
        || (!this.mcpApiKeySearchScope && !this.mcpApiKeyAnswerScope)
      ) {
        return;
      }
      const scopes = [];
      if (this.mcpApiKeySearchScope) {
        scopes.push("citeloom.search");
      }
      if (this.mcpApiKeyAnswerScope) {
        scopes.push("citeloom.answer");
      }
      const expiresAt = new Date();
      expiresAt.setUTCDate(
        expiresAt.getUTCDate() + Number(this.mcpApiKeyExpirationDays),
      );
      this.mcpApiKeyBusy = true;
      this.accountError = "";
      try {
        const response = await fetch(
          `/api/security/users/${encodeURIComponent(this.mcpApiKeyUser.userId)}/mcp-api-keys`,
          {
            body: JSON.stringify({
              expiresAt: expiresAt.toISOString(),
              label: this.mcpApiKeyLabel.trim() || null,
              scopes,
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        const value = await readJsonResponse(response, "Create MCP API key");
        const created = readMcpApiKey(value, true);
        this.mcpApiKeySecret = created.apiKey;
        this.mcpApiKeyCopied = false;
        this.mcpApiKeyLabel = "";
        this.mcpApiKeys.unshift(readMcpApiKey(value));
      } catch (error) {
        this.accountError = error instanceof Error
          ? error.message
          : "The MCP API key could not be created.";
      } finally {
        this.mcpApiKeyBusy = false;
      }
    },

    formatMcpApiKeyScopes(key) {
      return key.scopes.map((scope) => scope.replace("citeloom.", "")).join(", ");
    },

    mcpApiKeyStatus(key) {
      if (key.revokedAt !== null) {
        return "Revoked";
      }
      if (new Date(key.expiresAt).getTime() <= Date.now()) {
        return "Expired";
      }
      return "Active";
    },

    async openMcpApiKeyDrawer(user) {
      if (!this.accountCanManageMcpApiKeys(user)) {
        return;
      }
      this.mcpApiKeyDrawerOpen = true;
      this.mcpApiKeyUser = user;
      this.mcpApiKeySecret = "";
      this.mcpApiKeyCopied = false;
      this.mcpApiKeyLabel = "";
      this.mcpApiKeySearchScope = true;
      this.mcpApiKeyAnswerScope = true;
      await this.loadMcpApiKeys();
    },

    async loadMcpApiKeys() {
      if (this.mcpApiKeyUser === null) {
        return;
      }
      this.mcpApiKeyBusy = true;
      this.accountError = "";
      try {
        const response = await fetch(
          `/api/security/users/${encodeURIComponent(this.mcpApiKeyUser.userId)}/mcp-api-keys`,
          { headers: { accept: "application/json" } },
        );
        const value = await readJsonResponse(response, "MCP API keys");
        const rows = readArray(value, "MCP API keys");
        const keys = [];
        for (const row of rows) {
          const key = readMcpApiKey(row);
          if (key.revokedAt === null) {
            keys.push(key);
          }
        }
        this.mcpApiKeys = keys;
      } catch (error) {
        this.accountError = error instanceof Error
          ? error.message
          : "The MCP API keys could not be loaded.";
      } finally {
        this.mcpApiKeyBusy = false;
      }
    },

    async revokeMcpApiKey(key) {
      if (
        this.mcpApiKeyBusy
        || this.mcpApiKeyUser === null
        || this.mcpApiKeyStatus(key) !== "Active"
      ) {
        return;
      }
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep key",
        confirmLabel: "Revoke key",
        description: "Clients using this key will immediately lose access.",
        title: `Revoke ${key.label ?? "this MCP API key"}?`,
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      this.mcpApiKeyBusy = true;
      this.accountError = "";
      try {
        const response = await fetch(
          `/api/security/users/${encodeURIComponent(this.mcpApiKeyUser.userId)}/mcp-api-keys/${encodeURIComponent(key.id)}`,
          { method: "DELETE" },
        );
        if (!response.ok) {
          await readJsonResponse(response, "Revoke MCP API key");
        }
        await this.loadMcpApiKeys();
      } catch (error) {
        this.accountError = error instanceof Error
          ? error.message
          : "The MCP API key could not be revoked.";
      } finally {
        this.mcpApiKeyBusy = false;
      }
    },
  };
}
