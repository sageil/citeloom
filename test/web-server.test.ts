import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SettingsVersionConflictError,
} from "../src/app/settings.js";
import type { StagedIngestionDocument } from "../src/ingestion/service.js";
import type {
  BrowseDocumentCatalogRequest,
} from "../src/documents/catalog/browser.js";
import {
  type AppConfig,
  type SourceContentConfig,
} from "../src/config/index.js";
import { createTestProviderSettings } from "./provider-settings-fixture.js";
import {
  readProviderConnectionConfiguration,
  requireProviderConnection,
} from "../src/providers/profiles.js";
import {
  SourceDiscoveryScopeError,
  SourceDiscoveryUnavailableError,
} from "../src/retrieval/discovery/pipeline.js";
import type {
  AuthenticationSecurityWebServices,
  SecurityWebServices,
} from "../src/api/services.js";
import { TextToSpeechUnavailableError } from "../src/providers/text-to-speech.js";
import {
  SpeechToTextProviderError,
  SpeechToTextTimeoutError,
} from "../src/providers/speech-to-text.js";
import {
  buildWebServer as buildProductionWebServer,
  openApplicationStateRevisionEventStream,
  type BuildWebServerOptions,
  type QuestionRequest,
  type RuntimeWebServices,
  type WebServices,
} from "../src/web-server.js";
import { createDeferred } from "./deferred-fixture.js";
import {
  TestRevisionResponse,
  buildApplicationErrorPage,
  buildAuthenticatedPrincipal,
  buildBrowserDocument,
  buildCatalogResult,
  buildConfig,
  buildEffectiveSettings,
  buildOAuthAuthenticationSettings,
  buildOAuthPrincipal,
  buildPendingJob,
  buildPrincipalWorkspace,
  buildReadyDiagnosticCheck,
  buildServices,
  buildSourceContentMigrationRecord,
  buildSourceDiscoveryRequest,
  buildSourceDiscoveryResponse,
  buildSpeechToTextConfig,
  buildAudioFile,
  buildTranscriptionForm,
  createAnswerStream,
} from "./web-server-fixture.js";
import {
  AuthenticationRejectedError,
  WorkspaceAuthorizationError,
  WorkspaceNameUnavailableError,
} from "../src/auth/store.js";
import type { DoctorLiveChecks } from "../src/observability/doctor.js";
import { SourceLibraryArchiveConflictError } from "../src/workspaces/source-library-store.js";
import { SourceLibraryDeletionConflictError } from "../src/workspaces/source-library-deletion.js";
import { OAuthIdentityLinkRemovalRejectedError } from "../src/oauth/identity-link-store.js";

const temporaryDirectories: string[] = [];

async function buildWebServer(
  config: AppConfig,
  options: BuildWebServerOptions,
) {
  return buildProductionWebServer(config, {
    ...options,
    authentication: "disabled",
  });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("web server boundary", () => {
  it("exposes the active authentication mode without requiring a session", async () => {
    const readAuthenticationBootstrap = vi.fn<
      WebServices["readAuthenticationBootstrap"]
    >(async () => ({
      mode: "oauth",
      oauth: {
        apiResource: "https://localhost:3443/api",
        apiScopes: ["citeloom.app"],
        browserCallbackUri: "https://localhost:3443/oauth/callback",
        browserClientId: "citeloom-browser",
        browserPostLogoutRedirectUri: "https://localhost:3443/login",
        browserScopes: ["openid", "citeloom.app"],
        issuer: "https://identity.example.com/oidc",
      },
    }));
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ readAuthenticationBootstrap }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/auth/bootstrap",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toMatchObject({
        mode: "oauth",
        oauth: {
          apiResource: "https://localhost:3443/api",
          browserClientId: "citeloom-browser",
        },
      });
      expect(readAuthenticationBootstrap).toHaveBeenCalledWith(
        "https://localhost:3443",
      );
    } finally {
      await server.close();
    }
  });

  it("fails closed for unauthenticated API requests", async () => {
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices(),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({ method: "GET", url: "/api/dashboard" });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { message: "Authentication is required." },
      });
    } finally {
      await server.close();
    }
  });

  it("replaces cookie authentication with bearer authentication in OAuth mode", async () => {
    const settings = buildOAuthAuthenticationSettings();
    const readSession = vi.fn<WebServices["readSession"]>();
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        readAuthenticationSettings: async () => settings,
        readSession,
      }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "stale-local-session" },
        headers: {
          "x-citeloom-workspace-id": "00000000-0000-4000-8000-000000000000",
        },
        method: "GET",
        url: "/api/workspaces",
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe(
        'Bearer error="invalid_token"',
      );
      expect(response.headers["set-cookie"]).toContain(
        "__Host-citeloom_session=;",
      );
      expect(readSession).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("authorizes an OAuth API request against its explicit local workspace", async () => {
    const settings = buildOAuthAuthenticationSettings();
    const principal = buildOAuthPrincipal();
    const authenticate = vi.fn(async () => principal);
    const readIdentityContext = vi.fn();
    const listWorkspaces = vi.fn<WebServices["listWorkspaces"]>(async () => [{
      id: principal.workspaceId,
      name: principal.workspaceName,
      role: principal.role,
    }]);
    const readSession = vi.fn<WebServices["readSession"]>();
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      oauthAuthenticator: {
        authenticate,
        readIdentityContext,
        verifyMcpAccess: vi.fn(),
      },
      services: buildServices({
        listWorkspaces,
        readAuthenticationSettings: async () => settings,
        readSession,
      }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "stale-local-session" },
        headers: {
          authorization: "Bearer valid-access-token",
          "x-citeloom-workspace-id": principal.workspaceId,
        },
        method: "GET",
        url: "/api/workspaces",
      });

      expect(response.statusCode).toBe(200);
      expect(authenticate).toHaveBeenCalledWith(
        settings,
        "Bearer valid-access-token",
        principal.workspaceId,
      );
      expect(listWorkspaces).toHaveBeenCalledWith(principal);
      expect(readSession).not.toHaveBeenCalled();
      expect(response.headers["set-cookie"]).toContain(
        "__Host-citeloom_session=;",
      );
    } finally {
      await server.close();
    }
  });

  it("uses a bearer identity context without an external workspace claim", async () => {
    const settings = buildOAuthAuthenticationSettings();
    const principal = buildOAuthPrincipal();
    const context = {
      displayName: principal.displayName,
      globalRole: principal.globalRole,
      userId: principal.userId,
      username: principal.username,
      workspaces: [{
        id: principal.workspaceId,
        name: principal.workspaceName,
        role: principal.role,
      }],
    };
    const authenticate = vi.fn();
    const readIdentityContext = vi.fn(async () => context);
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      oauthAuthenticator: {
        authenticate,
        readIdentityContext,
        verifyMcpAccess: vi.fn(),
      },
      services: buildServices({
        readAuthenticationSettings: async () => settings,
      }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        headers: { authorization: "Bearer valid-access-token" },
        method: "GET",
        url: "/api/auth/context",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.json()).toEqual(context);
      expect(readIdentityContext).toHaveBeenCalledWith(
        settings,
        "Bearer valid-access-token",
      );
      expect(authenticate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("disables local authentication endpoints after OAuth activation", async () => {
    const authenticateLocally = vi.fn<WebServices["authenticate"]>();
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        authenticate: authenticateLocally,
        readAuthenticationSettings: async () => {
          return buildOAuthAuthenticationSettings();
        },
      }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/auth/login",
      });

      expect(response.statusCode).toBe(404);
      expect(authenticateLocally).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("publishes separate OAuth metadata for the API and MCP resources", async () => {
    const settings = buildOAuthAuthenticationSettings();
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        readAuthenticationSettings: async () => settings,
      }),
      staticDirectory: null,
    });
    try {
      const apiResponse = await server.inject({
        method: "GET",
        url: "/.well-known/oauth-protected-resource/api",
      });
      const mcpResponse = await server.inject({
        method: "GET",
        url: "/.well-known/oauth-protected-resource/mcp",
      });

      expect(apiResponse.statusCode).toBe(200);
      expect(apiResponse.json()).toMatchObject({
        resource: "https://localhost:3443/api",
        scopes_supported: ["citeloom.app"],
      });
      expect(mcpResponse.statusCode).toBe(200);
      expect(mcpResponse.json()).toMatchObject({
        resource: "https://localhost:3443/mcp",
        scopes_supported: ["citeloom.answer", "citeloom.search"],
      });
    } finally {
      await server.close();
    }
  });


  it("stages verified application-wide OAuth settings without changing local auth", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "global_admin");
    const stageOAuthApplicationConfiguration = vi.fn<
      AuthenticationSecurityWebServices["stageOAuthApplicationConfiguration"]
    >(async () => buildOAuthAuthenticationSettings());
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        readSession: async () => principal,
        stageOAuthApplicationConfiguration,
      }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "PUT",
        payload: {
          apiScopes: ["citeloom.app", "citeloom.app"],
          browserClientId: "citeloom-browser",
          browserScopes: ["profile", "openid", "citeloom.app"],
          expectedVersion: 1,
          issuer: "https://identity.example.com/oidc",
          mcpScopes: ["citeloom.search", "citeloom.answer"],
        },
        url: "/api/security/authentication/oauth/staged",
      });

      expect(response.statusCode).toBe(200);
      expect(stageOAuthApplicationConfiguration).toHaveBeenCalledWith(
        principal,
        {
          apiScopes: ["citeloom.app"],
          browserClientId: "citeloom-browser",
          browserScopes: ["citeloom.app", "openid", "profile"],
          issuer: "https://identity.example.com/oidc",
          mcpScopes: ["citeloom.answer", "citeloom.search"],
          schemaVersion: 1,
        },
        1,
        "https://localhost:3443",
      );
    } finally {
      await server.close();
    }
  });

  it("configures host authentication recovery as a versioned security setting", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "global_admin");
    const configureHostAuthenticationRecovery = vi.fn<
      AuthenticationSecurityWebServices["configureHostAuthenticationRecovery"]
    >(async () => ({
      ...buildOAuthAuthenticationSettings(),
      hostRecoveryEnabled: true,
    }));
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        configureHostAuthenticationRecovery,
        readSession: async () => principal,
      }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "PUT",
        payload: { enabled: true, expectedVersion: 2 },
        url: "/api/security/authentication/host-recovery",
      });

      expect(response.statusCode).toBe(200);
      expect(configureHostAuthenticationRecovery).toHaveBeenCalledWith(
        principal,
        true,
        2,
        "https://localhost:3443",
      );
    } finally {
      await server.close();
    }
  });

  it("requires a verified bearer identity to activate staged OAuth", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "global_admin");
    const activateOAuthApplication = vi.fn<
      AuthenticationSecurityWebServices["activateOAuthApplication"]
    >(async () => buildOAuthAuthenticationSettings());
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        activateOAuthApplication,
        readSession: async () => principal,
      }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: {
          origin: "https://localhost:3443",
          "x-citeloom-oauth-activation-proof": "Bearer staged-issuer-token",
        },
        method: "POST",
        payload: { expectedVersion: 2 },
        url: "/api/security/authentication/oauth/activate",
      });

      expect(response.statusCode).toBe(200);
      expect(activateOAuthApplication).toHaveBeenCalledWith(
        principal,
        "Bearer staged-issuer-token",
        2,
        "https://localhost:3443",
      );
    } finally {
      await server.close();
    }
  });

  it("reports protected OAuth identity removal as a conflict", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "global_admin");
    const unlinkOAuthApplicationUserIdentity = vi.fn<
      AuthenticationSecurityWebServices["unlinkOAuthApplicationUserIdentity"]
    >(async () => {
      throw new OAuthIdentityLinkRemovalRejectedError(
        "You cannot remove your own identity mapping while OAuth is active.",
      );
    });
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        readSession: async () => principal,
        unlinkOAuthApplicationUserIdentity,
      }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "DELETE",
        url: `/api/security/authentication/oauth/users/${principal.userId}`,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: {
          code: "invalid_request",
          message: "You cannot remove your own identity mapping while OAuth is active.",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("does not expose the removed external workspace mapping API", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "global_admin");
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ readSession: async () => principal }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "PUT",
        payload: { externalWorkspaceId: "external-workspace" },
        url: `/api/security/oauth/workspaces/${principal.workspaceId}`,
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("returns a generic internal error with its recorded error ID", async () => {
    const browseDocuments = vi.fn<RuntimeWebServices["browseDocuments"]>(
      async () => {
        const error = new Error("private database query detail");
        Object.assign(error, { statusCode: 501 });
        throw error;
      },
    );
    const reportApplicationError = vi.fn<WebServices["reportApplicationError"]>(
      async () => ({ id: "00000000-0000-4000-8000-000000000098" }),
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        browseDocuments,
        reportApplicationError,
      }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/dashboard",
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: {
          code: "internal_error",
          id: "00000000-0000-4000-8000-000000000098",
          message: "The request could not be completed.",
        },
      });
      expect(response.body).not.toContain("private database query detail");
      expect(reportApplicationError).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("does not record a wrapped expected request cancellation", async () => {
    const browseDocuments = vi.fn<RuntimeWebServices["browseDocuments"]>(
      async () => {
        const cancellation = new DOMException("client left", "AbortError");
        throw new AggregateError([
          new Error("request wrapper", { cause: cancellation }),
        ]);
      },
    );
    const reportApplicationError = vi.fn<WebServices["reportApplicationError"]>(
      async () => ({ id: "00000000-0000-4000-8000-000000000097" }),
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        browseDocuments,
        reportApplicationError,
      }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/dashboard",
      });

      expect(response.statusCode).toBe(499);
      expect(response.json()).toEqual({
        error: {
          code: "request_cancelled",
          message: "The request was cancelled.",
        },
      });
      expect(reportApplicationError).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("only exposes the login shell to unauthenticated browser requests", async () => {
    const staticDirectory = await mkdtemp(join(tmpdir(), "citeloom-login-boundary-"));
    temporaryDirectories.push(staticDirectory);
    await writeFile(join(staticDirectory, "index.html"), "<main>CiteLoom</main>");
    const scriptsDirectory = join(staticDirectory, "assets", "scripts");
    await mkdir(scriptsDirectory, { recursive: true });
    await writeFile(
      join(scriptsDirectory, "dashboard-extensions.js"),
      "export const loaded = true;",
    );
    await writeFile(
      join(scriptsDirectory, "bootstrap.js"),
      "window.citeloomBootstrapLoaded = true;",
    );
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices(),
      staticDirectory,
    });

    try {
      const loginResponse = await server.inject({ method: "GET", url: "/login" });
      expect(loginResponse.statusCode).toBe(200);
      expect(loginResponse.body).toBe("<main>CiteLoom</main>");

      const oauthCallbackResponse = await server.inject({
        method: "GET",
        url: "/oauth/callback?code=authorization-code&state=callback-state",
      });
      expect(oauthCallbackResponse.statusCode).toBe(200);
      expect(oauthCallbackResponse.body).toBe("<main>CiteLoom</main>");

      const dependencyResponse = await server.inject({
        method: "GET",
        url: "/assets/scripts/dashboard-extensions.js",
      });
      expect(dependencyResponse.statusCode).toBe(200);
      expect(dependencyResponse.body).toBe("export const loaded = true;");

      const bootstrapResponse = await server.inject({
        method: "GET",
        url: "/assets/scripts/bootstrap.js",
      });
      expect(bootstrapResponse.statusCode).toBe(200);
      expect(bootstrapResponse.body).toBe("window.citeloomBootstrapLoaded = true;");

      for (const url of ["/", "/documents", "/settings", "/unknown"]) {
        const response = await server.inject({ method: "GET", url });
        expect(response.statusCode).toBe(302);
        expect(response.headers.location).toBe("/login");
      }
    } finally {
      await server.close();
    }
  });

  it("creates a secure host-only session cookie after login", async () => {
    const principal = buildAuthenticatedPrincipal("admin");
    const authenticate = vi.fn<WebServices["authenticate"]>(async () => ({
      expiresAt: "2026-08-01T12:00:00.000Z",
      principal,
      token: "private-session-token",
    }));
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ authenticate }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        payload: {
          password: "correct horse battery staple",
          remember: true,
          username: "Admin",
        },
        url: "/api/auth/login",
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["set-cookie"]).toContain(
        "__Host-citeloom_session=private-session-token",
      );
      expect(response.headers["set-cookie"]).toContain("HttpOnly");
      expect(response.headers["set-cookie"]).toContain("Secure");
      expect(response.headers["set-cookie"]).toContain("SameSite=Strict");
      expect(response.headers["cache-control"]).toBe("no-store");
    } finally {
      await server.close();
    }
  });

  it("rejects login requests from another origin", async () => {
    const authenticate = vi.fn<WebServices["authenticate"]>();
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ authenticate }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        headers: { origin: "https://attacker.example" },
        method: "POST",
        payload: { password: "attempted password", username: "admin" },
        url: "/api/auth/login",
      });
      expect(response.statusCode).toBe(403);
      expect(authenticate).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns one generic response for rejected credentials", async () => {
    const authenticate = vi.fn<WebServices["authenticate"]>(async () => {
      throw new AuthenticationRejectedError();
    });
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ authenticate }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        payload: { password: "attempted password", username: "admin" },
        url: "/api/auth/login",
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: { message: "Invalid username or password." },
      });
    } finally {
      await server.close();
    }
  });

  it("maps non-admin membership changes to forbidden", async () => {
    const principal = buildAuthenticatedPrincipal("member");
    const addWorkspaceMember = vi.fn<WebServices["addWorkspaceMember"]>(
      async () => {
        throw new WorkspaceAuthorizationError();
      },
    );
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        addWorkspaceMember,
        readSession: async () => principal,
      }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        payload: {
          role: "member",
          userId: "00000000-0000-4000-8000-000000000401",
        },
        url: `/api/workspaces/${principal.workspaceId}/members`,
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("decodes workspace access changes before updating membership", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "standard");
    const changeWorkspaceMemberAccess = vi.fn<
      WebServices["changeWorkspaceMemberAccess"]
    >();
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        changeWorkspaceMemberAccess,
        readSession: async () => principal,
      }),
      staticDirectory: null,
    });
    const memberId = "00000000-0000-4000-8000-000000000401";

    try {
      const cookies = { "__Host-citeloom_session": "private-session-token" };
      const headers = { origin: "https://localhost:3443" };
      const response = await server.inject({
        cookies,
        headers,
        method: "PUT",
        payload: { access: "disabled" },
        url: `/api/workspaces/${principal.workspaceId}/members/${memberId}/access`,
      });
      const invalidResponse = await server.inject({
        cookies,
        headers,
        method: "PUT",
        payload: { access: "paused" },
        url: `/api/workspaces/${principal.workspaceId}/members/${memberId}/access`,
      });

      expect(response.statusCode).toBe(204);
      expect(changeWorkspaceMemberAccess).toHaveBeenCalledOnce();
      expect(changeWorkspaceMemberAccess).toHaveBeenCalledWith(
        principal,
        principal.workspaceId,
        memberId,
        "disabled",
      );
      expect(invalidResponse.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("changes the authenticated user's password", async () => {
    const principal = buildAuthenticatedPrincipal("member");
    const changePassword = vi.fn<WebServices["changePassword"]>();
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        changePassword,
        readSession: async () => principal,
      }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "PUT",
        payload: {
          currentPassword: "correct horse battery staple",
          newPassword: "a newer secure passphrase",
        },
        url: "/api/auth/password",
      });
      expect(response.statusCode).toBe(204);
      expect(changePassword).toHaveBeenCalledWith(
        principal,
        "correct horse battery staple",
        "a newer secure passphrase",
      );
    } finally {
      await server.close();
    }
  });

  it("creates and switches workspaces for a global administrator", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "global_admin");
    const createdWorkspace = {
      id: "00000000-0000-4000-8000-000000000401",
      name: "Legal Research",
      role: "admin" as const,
    };
    const createWorkspace = vi.fn<WebServices["createWorkspace"]>(
      async () => createdWorkspace,
    );
    const listWorkspaces = vi.fn<WebServices["listWorkspaces"]>(
      async () => [createdWorkspace],
    );
    const switchWorkspace = vi.fn<WebServices["switchWorkspace"]>(
      async (current, workspaceId) => ({
        ...current,
        workspaceId,
        workspaceName: createdWorkspace.name,
      }),
    );
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        createWorkspace,
        listWorkspaces,
        readSession: async () => principal,
        switchWorkspace,
      }),
      staticDirectory: null,
    });

    try {
      const cookies = { "__Host-citeloom_session": "private-session-token" };
      const headers = { origin: "https://localhost:3443" };
      const created = await server.inject({
        cookies,
        headers,
        method: "POST",
        payload: { name: "Legal Research" },
        url: "/api/workspaces",
      });
      const listed = await server.inject({
        cookies,
        method: "GET",
        url: "/api/workspaces",
      });
      const switched = await server.inject({
        cookies,
        headers,
        method: "PUT",
        payload: { workspaceId: createdWorkspace.id },
        url: "/api/auth/session/workspace",
      });

      expect(created.statusCode).toBe(201);
      expect(created.json()).toEqual(createdWorkspace);
      expect(createWorkspace).toHaveBeenCalledWith(principal, {
        configuration: { kind: "organization-defaults" },
        name: "Legal Research",
      });
      expect(listed.json()).toEqual([createdWorkspace]);
      expect(switched.statusCode).toBe(200);
      expect(switched.json()).toMatchObject({
        user: { globalRole: "global_admin" },
        workspace: {
          id: createdWorkspace.id,
          name: createdWorkspace.name,
        },
      });
      expect(switchWorkspace).toHaveBeenCalledWith(
        principal,
        createdWorkspace.id,
      );
    } finally {
      await server.close();
    }
  });

  it("decodes a workspace settings copy source during creation", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "global_admin");
    const sourceWorkspaceId = "00000000-0000-4000-8000-000000000311";
    const createWorkspace = vi.fn<WebServices["createWorkspace"]>(async () => ({
      id: "00000000-0000-4000-8000-000000000312",
      name: "Copied Workspace",
      role: "admin",
    }));
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        createWorkspace,
        readSession: async () => principal,
      }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        payload: {
          configuration: {
            kind: "workspace-copy",
            workspaceId: sourceWorkspaceId,
          },
          name: "Copied Workspace",
        },
        url: "/api/workspaces",
      });

      expect(response.statusCode).toBe(201);
      expect(createWorkspace).toHaveBeenCalledWith(principal, {
        configuration: {
          kind: "workspace-copy",
          workspaceId: sourceWorkspaceId,
        },
        name: "Copied Workspace",
      });
    } finally {
      await server.close();
    }
  });

  it("renames a workspace for a global administrator", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "global_admin");
    const renamedWorkspace = {
      id: principal.workspaceId,
      name: "Knowledge Operations",
      role: "admin" as const,
    };
    const renameWorkspace = vi.fn<WebServices["renameWorkspace"]>(
      async () => renamedWorkspace,
    );
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        listWorkspaces: async () => [buildPrincipalWorkspace(principal)],
        readSession: async () => principal,
        renameWorkspace,
      }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "PATCH",
        payload: { name: "  Knowledge Operations  " },
        url: `/api/workspaces/${principal.workspaceId}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(renamedWorkspace);
      expect(renameWorkspace).toHaveBeenCalledWith(
        principal,
        principal.workspaceId,
        { name: "Knowledge Operations" },
      );
    } finally {
      await server.close();
    }
  });

  it("reports a duplicate workspace name as a conflict", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "global_admin");
    const createWorkspace = vi.fn<WebServices["createWorkspace"]>(async () => {
      throw new WorkspaceNameUnavailableError();
    });
    const renameWorkspace = vi.fn<WebServices["renameWorkspace"]>(async () => {
      throw new WorkspaceNameUnavailableError();
    });
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        createWorkspace,
        readSession: async () => principal,
        renameWorkspace,
      }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "PATCH",
        payload: { name: "Existing workspace" },
        url: `/api/workspaces/${principal.workspaceId}`,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: {
          code: "invalid_request",
          message: "The requested workspace name is unavailable.",
        },
      });
      const createResponse = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        payload: { name: "Existing workspace" },
        url: "/api/workspaces",
      });
      expect(createResponse.statusCode).toBe(409);
      expect(createResponse.json()).toEqual({
        error: {
          code: "invalid_request",
          message: "The requested workspace name is unavailable.",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("does not allow a workspace administrator to create a workspace", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "standard");
    const createWorkspace = vi.fn<WebServices["createWorkspace"]>();
    const renameWorkspace = vi.fn<WebServices["renameWorkspace"]>();
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        createWorkspace,
        readSession: async () => principal,
        renameWorkspace,
      }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        payload: { name: "Forbidden" },
        url: "/api/workspaces",
      });

      expect(response.statusCode).toBe(403);
      expect(createWorkspace).not.toHaveBeenCalled();
      const renameResponse = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "PATCH",
        payload: { name: "Forbidden Rename" },
        url: `/api/workspaces/${principal.workspaceId}`,
      });
      expect(renameResponse.statusCode).toBe(403);
      expect(renameWorkspace).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("manages shared source libraries only through global administration", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "global_admin");
    const library = {
      access: "manage" as const,
      id: "00000000-0000-4000-8000-000000000402",
      kind: "shared" as const,
      name: "Common Sources",
    };
    const targetWorkspaceId = "00000000-0000-4000-8000-000000000403";
    const createSharedSourceLibrary = vi.fn<
      WebServices["createSharedSourceLibrary"]
    >(async () => library);
    const listSourceLibraries = vi.fn<WebServices["listSourceLibraries"]>(
      async () => [library],
    );
    const setSourceLibraryGrant = vi.fn<
      WebServices["setSourceLibraryGrant"]
    >(async () => undefined);
    const archiveSharedSourceLibrary = vi.fn<
      WebServices["archiveSharedSourceLibrary"]
    >(async () => undefined);
    const deleteSharedSourceLibrary = vi.fn<
      WebServices["deleteSharedSourceLibrary"]
    >(async () => undefined);
    const renameSharedSourceLibrary = vi.fn<
      WebServices["renameSharedSourceLibrary"]
    >(async () => undefined);
    const restoreSharedSourceLibrary = vi.fn<
      WebServices["restoreSharedSourceLibrary"]
    >(async () => undefined);
    const readSourceLibraryAdministration = vi.fn<
      WebServices["readSourceLibraryAdministration"]
    >(async () => ({
      libraries: [{
        grants: [{ access: "manage", workspaceId: principal.workspaceId }],
        id: library.id,
        name: library.name,
        state: "active",
      }],
      workspaces: [{ id: principal.workspaceId, name: principal.workspaceName }],
    }));
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        archiveSharedSourceLibrary,
        createSharedSourceLibrary,
        deleteSharedSourceLibrary,
        listSourceLibraries,
        readSourceLibraryAdministration,
        readSession: async () => principal,
        renameSharedSourceLibrary,
        restoreSharedSourceLibrary,
        setSourceLibraryGrant,
      }),
      staticDirectory: null,
    });

    try {
      const cookies = { "__Host-citeloom_session": "private-session-token" };
      const headers = { origin: "https://localhost:3443" };
      const listed = await server.inject({
        cookies,
        method: "GET",
        url: "/api/source-libraries",
      });
      const administration = await server.inject({
        cookies,
        method: "GET",
        url: "/api/source-libraries/administration",
      });
      const created = await server.inject({
        cookies,
        headers,
        method: "POST",
        payload: { name: "Common Sources" },
        url: "/api/source-libraries",
      });
      const granted = await server.inject({
        cookies,
        headers,
        method: "PUT",
        payload: { access: "use" },
        url: `/api/source-libraries/${library.id}/grants/${targetWorkspaceId}`,
      });
      const renamed = await server.inject({
        cookies,
        headers,
        method: "PATCH",
        payload: { name: "Organization Handbook" },
        url: `/api/source-libraries/${library.id}`,
      });
      const archived = await server.inject({
        cookies,
        headers,
        method: "POST",
        url: `/api/source-libraries/${library.id}/archive`,
      });
      const restored = await server.inject({
        cookies,
        headers,
        method: "POST",
        url: `/api/source-libraries/${library.id}/restore`,
      });
      const deleted = await server.inject({
        cookies,
        headers,
        method: "DELETE",
        url: `/api/source-libraries/${library.id}`,
      });

      expect(listed.json()).toEqual([library]);
      expect(administration.statusCode).toBe(200);
      expect(administration.json()).toEqual({
        libraries: [{
          grants: [{ access: "manage", workspaceId: principal.workspaceId }],
          id: library.id,
          name: library.name,
          state: "active",
        }],
        workspaces: [{
          id: principal.workspaceId,
          name: principal.workspaceName,
        }],
      });
      expect(readSourceLibraryAdministration).toHaveBeenCalledWith(principal);
      expect(created.statusCode).toBe(201);
      expect(createSharedSourceLibrary).toHaveBeenCalledWith(principal, {
        name: "Common Sources",
      });
      expect(granted.statusCode).toBe(204);
      expect(setSourceLibraryGrant).toHaveBeenCalledWith(
        principal,
        library.id,
        targetWorkspaceId,
        "use",
      );
      expect(renamed.statusCode).toBe(204);
      expect(renameSharedSourceLibrary).toHaveBeenCalledWith(
        principal,
        library.id,
        { name: "Organization Handbook" },
      );
      expect(archived.statusCode).toBe(204);
      expect(archiveSharedSourceLibrary).toHaveBeenCalledWith(
        principal,
        library.id,
      );
      expect(restored.statusCode).toBe(204);
      expect(restoreSharedSourceLibrary).toHaveBeenCalledWith(
        principal,
        library.id,
      );
      expect(deleted.statusCode).toBe(202);
      expect(deleteSharedSourceLibrary).toHaveBeenCalledWith(
        principal,
        library.id,
      );
    } finally {
      await server.close();
    }
  });

  it("does not expose source library administration to workspace administrators", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "standard");
    const libraryId = "00000000-0000-4000-8000-000000000402";
    const archiveSharedSourceLibrary = vi.fn<
      WebServices["archiveSharedSourceLibrary"]
    >();
    const deleteSharedSourceLibrary = vi.fn<
      WebServices["deleteSharedSourceLibrary"]
    >();
    const renameSharedSourceLibrary = vi.fn<
      WebServices["renameSharedSourceLibrary"]
    >();
    const restoreSharedSourceLibrary = vi.fn<
      WebServices["restoreSharedSourceLibrary"]
    >();
    const readSourceLibraryAdministration = vi.fn<
      WebServices["readSourceLibraryAdministration"]
    >();
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        archiveSharedSourceLibrary,
        deleteSharedSourceLibrary,
        readSession: async () => principal,
        readSourceLibraryAdministration,
        renameSharedSourceLibrary,
        restoreSharedSourceLibrary,
      }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "GET",
        url: "/api/source-libraries/administration",
      });
      const headers = { origin: "https://localhost:3443" };
      const renamed = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers,
        method: "PATCH",
        payload: { name: "Restricted" },
        url: `/api/source-libraries/${libraryId}`,
      });
      const archived = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers,
        method: "POST",
        url: `/api/source-libraries/${libraryId}/archive`,
      });
      const restored = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers,
        method: "POST",
        url: `/api/source-libraries/${libraryId}/restore`,
      });
      const deleted = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers,
        method: "DELETE",
        url: `/api/source-libraries/${libraryId}`,
      });

      expect(response.statusCode).toBe(403);
      expect(renamed.statusCode).toBe(403);
      expect(archived.statusCode).toBe(403);
      expect(restored.statusCode).toBe(403);
      expect(deleted.statusCode).toBe(403);
      expect(readSourceLibraryAdministration).not.toHaveBeenCalled();
      expect(archiveSharedSourceLibrary).not.toHaveBeenCalled();
      expect(deleteSharedSourceLibrary).not.toHaveBeenCalled();
      expect(renameSharedSourceLibrary).not.toHaveBeenCalled();
      expect(restoreSharedSourceLibrary).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("reports active ingestion as a shared library archive conflict", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "global_admin");
    const libraryId = "00000000-0000-4000-8000-000000000402";
    const archiveSharedSourceLibrary = vi.fn<
      WebServices["archiveSharedSourceLibrary"]
    >(async () => {
      throw new SourceLibraryArchiveConflictError();
    });
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        archiveSharedSourceLibrary,
        readSession: async () => principal,
      }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        url: `/api/source-libraries/${libraryId}/archive`,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: {
          code: "invalid_request",
          message: "The shared library cannot be archived while documents are processing.",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("reports a shared library permanent deletion conflict", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "global_admin");
    const libraryId = "00000000-0000-4000-8000-000000000402";
    const deleteSharedSourceLibrary = vi.fn<
      WebServices["deleteSharedSourceLibrary"]
    >(async () => {
      throw new SourceLibraryDeletionConflictError(
        "The shared library cannot be deleted while documents are processing.",
      );
    });
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        deleteSharedSourceLibrary,
        readSession: async () => principal,
      }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "DELETE",
        url: `/api/source-libraries/${libraryId}`,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        error: {
          code: "invalid_request",
          message: "The shared library cannot be deleted while documents are processing.",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("delegates member document deletion to library authorization", async () => {
    const principal = buildAuthenticatedPrincipal("member", "standard");
    const documentId = "d".repeat(64);
    const sourceFile = "/documents/shared-handbook.pdf";
    const deleteIndexedDocument = vi.fn<
      NonNullable<RuntimeWebServices["deleteIndexedDocument"]>
    >(async () => ({ kind: "deleted", sourceFile }));
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        deleteIndexedDocument,
        readSession: async () => principal,
      }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "DELETE",
        payload: { sourceFile },
        url: `/api/documents/${documentId}`,
      });

      expect(response.statusCode).toBe(200);
      expect(deleteIndexedDocument).toHaveBeenCalledWith(principal, {
        documentId,
        sourceFile,
      });
    } finally {
      await server.close();
    }
  });

  it("serves canonical application routes that survive browser refresh", async () => {
    const staticDirectory = await mkdtemp(join(tmpdir(), "citeloom-web-routes-"));
    temporaryDirectories.push(staticDirectory);
    await writeFile(join(staticDirectory, "index.html"), "<main>CiteLoom</main>");
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices(),
      staticDirectory,
    });

    try {
      const baseResponse = await server.inject({ method: "GET", url: "/" });
      expect(baseResponse.statusCode).toBe(200);
      expect(baseResponse.body).toBe("<main>CiteLoom</main>");
      expect(baseResponse.headers.location).toBeUndefined();
      expect(baseResponse.headers["content-security-policy"]).toContain(
        "script-src 'self'",
      );
      expect(baseResponse.headers["content-security-policy"]).toContain(
        "script-src 'self' 'unsafe-eval'",
      );

      for (const route of [
        "/assets/vendor/alpine.min.js",
        "/assets/vendor/htmx.min.js",
        "/assets/vendor/marked.umd.js",
        "/assets/vendor/purify.min.js",
      ]) {
        const vendorResponse = await server.inject({ method: "GET", url: route });
        expect(vendorResponse.statusCode).toBe(200);
        expect(vendorResponse.headers["content-type"]).toContain(
          "application/javascript",
        );
        expect(vendorResponse.headers["cache-control"]).toBe(
          "public, max-age=31536000, immutable",
        );
      }

      const fallbackResponse = await server.inject({
        method: "GET",
        url: "/?section=documents&theme=dark",
      });
      expect(fallbackResponse.statusCode).toBe(200);
      expect(fallbackResponse.body).toBe("<main>CiteLoom</main>");
      expect(fallbackResponse.headers.location).toBeUndefined();

      for (const route of [
        "/account",
        "/overview",
        "/documents",
        "/errors",
        "/ask",
        "/help",
        "/settings",
        "/system-health",
        "/users",
        "/login",
      ]) {
        const response = await server.inject({ method: "GET", url: route });
        expect(response.statusCode).toBe(200);
        expect(response.body).toBe("<main>CiteLoom</main>");
      }

      const unknownResponse = await server.inject({ method: "GET", url: "/unknown" });
      expect(unknownResponse.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("serves error reports to workspace and global administrators", async () => {
    const staticDirectory = await mkdtemp(join(tmpdir(), "citeloom-error-reports-"));
    temporaryDirectories.push(staticDirectory);
    await mkdir(join(staticDirectory, "fragments"), { recursive: true });
    await writeFile(join(staticDirectory, "index.html"), "<main>CiteLoom</main>");
    await writeFile(
      join(staticDirectory, "fragments", "errors.html"),
      "<section>Error reports</section>",
    );
    const readApplicationErrors = vi.fn<WebServices["readApplicationErrors"]>(
      async () => buildApplicationErrorPage(),
    );
    const purgeApplicationErrors = vi.fn<WebServices["purgeApplicationErrors"]>(
      async () => ({ deleted: 3 }),
    );
    const memberServer = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        purgeApplicationErrors,
        readApplicationErrors,
        readSession: async () => buildAuthenticatedPrincipal("member"),
      }),
      staticDirectory,
    });

    try {
      for (const url of ["/errors", "/fragments/errors.html", "/api/errors"]) {
        const response = await memberServer.inject({
          cookies: { "__Host-citeloom_session": "private-session-token" },
          method: "GET",
          url,
        });
        expect(response.statusCode).toBe(403);
      }
      const purgeResponse = await memberServer.inject({
        headers: { origin: "https://localhost:3443" },
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "DELETE",
        url: "/api/errors",
      });
      expect(purgeResponse.statusCode).toBe(403);
      expect(readApplicationErrors).not.toHaveBeenCalled();
      expect(purgeApplicationErrors).not.toHaveBeenCalled();
    } finally {
      await memberServer.close();
    }

    const principal = buildAuthenticatedPrincipal("admin");
    const administratorServer = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        purgeApplicationErrors,
        readApplicationErrors,
        readSession: async () => principal,
      }),
      staticDirectory,
    });

    try {
      const routeResponse = await administratorServer.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "GET",
        url: "/errors",
      });
      const fragmentResponse = await administratorServer.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "GET",
        url: "/fragments/errors.html",
      });
      const apiResponse = await administratorServer.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "GET",
        url: "/api/errors?area=ingestion&page=2&pageSize=25",
      });
      const invalidResponse = await administratorServer.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "GET",
        url: "/api/errors?area=private",
      });
      const purgeResponse = await administratorServer.inject({
        headers: { origin: "https://localhost:3443" },
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "DELETE",
        url: "/api/errors",
      });

      expect(routeResponse.statusCode).toBe(200);
      expect(fragmentResponse.statusCode).toBe(200);
      expect(fragmentResponse.body).toBe("<section>Error reports</section>");
      expect(apiResponse.statusCode).toBe(200);
      expect(apiResponse.json()).toEqual(buildApplicationErrorPage());
      expect(invalidResponse.statusCode).toBe(400);
      expect(purgeResponse.statusCode).toBe(200);
      expect(purgeResponse.json()).toEqual({ deleted: 3 });
      expect(readApplicationErrors).toHaveBeenCalledTimes(1);
      expect(readApplicationErrors).toHaveBeenCalledWith(principal, {
        area: "ingestion",
        page: 2,
        pageSize: 25,
      });
      expect(purgeApplicationErrors).toHaveBeenCalledOnce();
      expect(purgeApplicationErrors).toHaveBeenCalledWith(principal);
    } finally {
      await administratorServer.close();
    }

    const globalAdministratorServer = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        readSession: async () => buildAuthenticatedPrincipal(
          "member",
          "global_admin",
        ),
      }),
      staticDirectory,
    });

    try {
      for (const url of ["/errors", "/fragments/errors.html"]) {
        const response = await globalAdministratorServer.inject({
          cookies: { "__Host-citeloom_session": "private-session-token" },
          method: "GET",
          url,
        });
        expect(response.statusCode).toBe(200);
      }
    } finally {
      await globalAdministratorServer.close();
    }
  });

  it("returns typed source discovery results", async () => {
    const searchSources = vi.fn<RuntimeWebServices["searchSources"]>(async () => {
      return buildSourceDiscoveryResponse();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ searchSources }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: buildSourceDiscoveryRequest(),
        url: "/api/search",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(buildSourceDiscoveryResponse());
      expect(searchSources).toHaveBeenCalledWith(
        expect.objectContaining({ username: "disabled-authentication" }),
        buildSourceDiscoveryRequest(),
        expect.any(AbortSignal),
      );
    } finally {
      await server.close();
    }
  });

  it("rejects invalid source discovery input at the HTTP boundary", async () => {
    const searchSources = vi.fn<RuntimeWebServices["searchSources"]>(async () => {
      return buildSourceDiscoveryResponse();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ searchSources }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { ...buildSourceDiscoveryRequest(), query: " " },
        url: "/api/search",
      });

      expect(response.statusCode).toBe(400);
      expect(searchSources).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns service unavailable when every requested retrieval path fails", async () => {
    const searchSources = vi.fn<RuntimeWebServices["searchSources"]>(async () => {
      throw new SourceDiscoveryUnavailableError("Retrieval services failed.");
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ searchSources }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: buildSourceDiscoveryRequest(),
        url: "/api/search",
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: {
          id: "00000000-0000-4000-8000-000000000099",
          message: "A required service is unavailable.",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("returns conflict when the selected discovery scope no longer resolves", async () => {
    const searchSources = vi.fn<RuntimeWebServices["searchSources"]>(async () => {
      throw new SourceDiscoveryScopeError("The selected document is no longer ready.");
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ searchSources }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: buildSourceDiscoveryRequest(),
        url: "/api/search",
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { message: "The selected document is no longer ready." },
      });
    } finally {
      await server.close();
    }
  });

  it("returns a typed dashboard assembled from catalog and system services", async () => {
    const effectiveConfig = buildConfig();
    effectiveConfig.textToSpeech = {
      adapter: "omlx-speech",
      apiToken: null,
      baseUrl: "http://localhost:9000/v1",
      providerId: "local-ai",
      model: "Kokoro-82M-bf16",
      preload: true,
      runtimeName: "oMLX",
      speed: 1,
      timeoutMs: 30_000,
      voice: "af_heart",
    };
    effectiveConfig.speechToText = buildSpeechToTextConfig();
    const services = buildServices({ config: effectiveConfig });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services,
      staticDirectory: null,
    });

    try {
      const response = await server.inject({ method: "GET", url: "/api/dashboard" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        documentSummary: {
          queryable: 1,
          total: 1,
        },
        embeddingSpace: {
          dimensions: 768,
          id: "embedding-model:plain:768:window-87caf59d17b4baa5:representations-v2",
          model: "embedding-model",
          retrievalWindowPolicyFingerprint:
            "87caf59d17b4baa5dfa11a48876e2113061ed943b23827a515384c2f5b35120f",
          retrievalWindowPolicyId:
            "citeloom/retrieval-window:structured-token-v3",
        },
        features: {
          speechToText: true,
          textToSpeech: true,
          textToSpeechPreload: true,
        },
        inferenceRuntime: {
          answerModel: "vision-model",
          claimVerifier: {
            model: "vectara/hallucination_evaluation_model@8e4a2e6e96c708cc76c2344f7e4757df2515292c",
            name: "test verifier runtime",
          },
          name: "LM Studio",
          queryExpansionModel: "indexing-model",
          reranker: null,
          indexingModel: "indexing-model",
        },
        supportedExtensions: [
          ".pdf",
          ".html",
          ".htm",
          ".docx",
          ".xlsx",
          ".pptx",
          ".png",
          ".jpg",
          ".jpeg",
          ".webp",
        ],
        system: { queue: [], workers: [] },
        telemetry: {
          corrections: [],
          enabled: false,
          requests: [],
          stages: [],
          windowHours: 24,
        },
      });
    } finally {
      await server.close();
    }
  });

  it("streams canonical revision snapshots and publishes committed changes", async () => {
    let revisions = { catalog: "0", jobs: "0", settings: "0" };
    const subscription: {
      current: ((signal: {
        channel: "catalog" | "jobs" | "settings";
        revision: string;
      }) => void) | null;
    } = { current: null };
    const services = buildServices({
      readRevisions: async () => revisions,
      subscribeRevisions: (receive) => {
        subscription.current = receive;
        return () => {
          subscription.current = null;
        };
      },
    });
    const response = new TestRevisionResponse();
    const close = openApplicationStateRevisionEventStream(
      response as unknown as ServerResponse,
      services,
    );
    try {
      await vi.waitFor(() => {
        expect(response.text).toContain("data: {\"catalog\":\"0\"");
      });

      revisions = { catalog: "0", jobs: "1", settings: "0" };
      subscription.current?.({ channel: "jobs", revision: "1" });
      await vi.waitFor(() => {
        expect(response.text).toContain(
          "data: {\"catalog\":\"0\",\"jobs\":\"1\"",
        );
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["Content-Type"]).toContain("text/event-stream");
      expect(response.text).toContain("id: 0.0.0");
      expect(response.text).toContain("id: 0.1.0");
    } finally {
      close();
    }
  });

  it("runs selected diagnostics only on POST and coalesces matching requests", async () => {
    const diagnosticGates = [createDeferred(), createDeferred()];
    const diagnosticSelections: DoctorLiveChecks[] = [];
    const services = buildServices({
      readHealth: async (liveChecks) => {
        const callIndex = diagnosticSelections.length;
        diagnosticSelections.push(liveChecks);
        await diagnosticGates[callIndex]?.promise;
        return [buildReadyDiagnosticCheck()];
      },
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services,
      staticDirectory: null,
    });

    try {
      expect((await server.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(404);
      const first = server.inject({ method: "POST", url: "/api/diagnostics" });
      const second = server.inject({ method: "POST", url: "/api/diagnostics" });
      const live = server.inject({
        method: "POST",
        payload: {
          liveChecks: {
            modelResponse: true,
            searchRanking: false,
            speech: true,
          },
        },
        url: "/api/diagnostics",
      });
      await vi.waitFor(() => expect(diagnosticSelections).toHaveLength(2));
      expect(diagnosticSelections).toEqual([
        { modelResponse: false, searchRanking: false, speech: false },
        { modelResponse: true, searchRanking: false, speech: true },
      ]);
      diagnosticGates[0]?.resolve();
      diagnosticGates[1]?.resolve();
      const responses = await Promise.all([first, second, live]);
      expect(responses.every((response) => response.statusCode === 200)).toBe(true);
      expect(diagnosticSelections).toHaveLength(2);

      const invalid = await server.inject({
        method: "POST",
        payload: { liveChecks: { modelResponse: true } },
        url: "/api/diagnostics",
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toEqual({
        error: {
          code: "invalid_request",
          message: "Diagnostic check selection is invalid.",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("returns effective settings with provenance and redacted credentials", async () => {
    const config = buildConfig();
    config.database.url = "postgresql://database-user:database-password@localhost:5432/citeloom?sslpassword=query-secret#fragment-secret";
    const settings = buildEffectiveSettings();
    const customConnection = requireProviderConnection(
      settings.providerSettings,
      "custom",
    );
    const openAIConnection = requireProviderConnection(
      settings.providerSettings,
      "openai",
    );
    customConnection.answer.apiToken = "database-secret";
    customConnection.answer.model = "database-vision";
    openAIConnection.apiToken = "openai-secret";
    openAIConnection.textToSpeech.apiToken =
      "openai-speech-secret";
    delete settings.providerSettings.connections.openrouter;
    settings.runtimeSettings.retrievalChunkTargetTokens = 4_096;
    settings.indexedDocumentCount = 7;
    settings.selectedEmbeddingSpaceDocumentCount = 2;
    settings.updatedAt = "2026-07-14T20:00:00.000Z";
    settings.version = 3;
    const server = await buildWebServer(config, {
      logger: false,
      services: buildServices({ readSettings: async () => settings }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({ method: "GET", url: "/api/settings" });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ updatedAt: settings.updatedAt, version: 3 });
      expect(body.embeddingSpace).toEqual({
        activeDocumentCount: 2,
        dimensions: settings.config.embeddingSpace.dimensions,
        id: settings.config.embeddingSpace.id,
        totalDocumentCount: 7,
      });
      expect(body.warnings).toEqual([
        "Document section size 4096 exceeds the embedding model's maximum input of "
        + "2048 tokens. CiteLoom will use 2048 tokens instead.",
        "5 indexed documents do not use the selected search setup. "
        + "Reindex before asking questions about them.",
      ]);
      expect(body.fields).toEqual(expect.arrayContaining([
        expect.objectContaining({
          group: "Search and answers",
          key: "searchMethod",
          label: "Search method",
          options: [
            { label: "Hybrid - Recommended", value: "hybrid" },
            { label: "Keyword", value: "bm25" },
            { label: "Semantic", value: "dense" },
          ],
          value: "hybrid",
        }),
        expect.objectContaining({
          group: "Embedding space",
          key: "embeddingDimensions",
          label: "Vector dimensions",
          options: [
            { label: "384", value: 384 },
            { label: "768", value: 768 },
            { label: "1024", value: 1024 },
            { label: "1536", value: 1536 },
            { label: "2048", value: 2048 },
          ],
        }),
        expect.objectContaining({
          key: "retrievalChunkTargetTokens",
          min: 1,
          step: 1,
          unit: "tokens",
          value: 4_096,
        }),
        expect.objectContaining({
          defaultValue: 5,
          key: "retryBaseSeconds",
          max: 3_600,
          min: 0.1,
          step: 0.1,
          unit: "seconds",
          value: 5,
        }),
        expect.objectContaining({
          defaultValue: 5,
          key: "backgroundProgressIntervalSeconds",
          max: 3_600,
          min: 0.1,
          step: 0.1,
          unit: "seconds",
          value: 5,
        }),
        expect.objectContaining({
          defaultValue: 1,
          key: "workerFallbackPollSeconds",
          max: 300,
          min: 1,
          step: 1,
          unit: "seconds",
          value: 1,
        }),
      ]));
      expect(body.fields).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ key: "backgroundProgressIntervalMs" }),
        expect.objectContaining({ key: "inferenceApiToken" }),
        expect.objectContaining({ key: "retryBaseMs" }),
        expect.objectContaining({ key: "ttsApiToken" }),
        expect.objectContaining({ key: "ttsBaseUrl" }),
        expect.objectContaining({ key: "visionModel" }),
        expect.objectContaining({ key: "workerFallbackPollMs" }),
      ]));
      expect(body.providers.connections).toEqual(expect.arrayContaining([
        expect.objectContaining({
          apiTokenConfigured: true,
          capabilityApiTokensConfigured: expect.objectContaining({
            textToSpeech: true,
          }),
          providerId: "openai",
        }),
        expect.objectContaining({
          capabilityApiTokensConfigured: expect.objectContaining({
            answer: true,
          }),
          configuration: expect.objectContaining({
            answer: expect.objectContaining({ model: "database-vision" }),
          }),
          providerId: "custom",
        }),
      ]));
      const openAi = body.providers.connections.find((connection: {
        providerId: string;
      }) => connection.providerId === "openai");
      expect(openAi.configuration.baseUrl).toBe("https://api.openai.com/v1");
      expect(body.providers.catalog).toEqual(expect.arrayContaining([
        expect.objectContaining({
          authentication: "openai-device",
          id: "openai-codex",
        }),
      ]));
      expect(body.providers.routing.queryExpansion).toBe("lmstudio");
      const doclingVlmProvider = body.fields.find((field: {
        key: string;
      }) => field.key === "doclingVlmProviderId");
      expect(doclingVlmProvider.options).not.toContainEqual({
        label: "OpenRouter",
        value: "openrouter",
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("database-secret");
      expect(serialized).not.toContain("database-password");
      expect(serialized).not.toContain("query-secret");
      expect(serialized).not.toContain("fragment-secret");
      expect(serialized).not.toContain("openai-secret");
      expect(serialized).not.toContain("openai-speech-secret");
    } finally {
      await server.close();
    }
  });

  it("manages source-content storage without returning static credentials", async () => {
    const target: SourceContentConfig = {
      bucket: "citeloom",
      credentials: {
        accessKeyId: "storage-access-key",
        kind: "static",
        secretAccessKey: "storage-secret-key",
      },
      endpointUrl: "http://seaweedfs:8333",
      forcePathStyle: true,
      kind: "s3",
      prefix: "sources",
      region: "us-east-1",
    };
    const migrationId = "00000000-0000-4000-8000-000000000401";
    const migration = buildSourceContentMigrationRecord(migrationId, target);
    const testSourceContentStorage = vi.fn<
      WebServices["testSourceContentStorage"]
    >(async () => undefined);
    const queueSourceContentMigration = vi.fn<
      WebServices["queueSourceContentMigration"]
    >(async () => migration);
    const cancelSourceContentMigration = vi.fn<
      WebServices["cancelSourceContentMigration"]
    >(async () => ({ ...migration, activeSlot: null, state: "cancelled" }));
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        cancelSourceContentMigration,
        queueSourceContentMigration,
        readSourceContentStorage: async () => ({
          activeConfig: target,
          documentCount: 34,
          migration,
          settingsVersion: 7,
        }),
        testSourceContentStorage,
      }),
      staticDirectory: null,
    });

    try {
      const overviewResponse = await server.inject({
        method: "GET",
        url: "/api/source-content-storage",
      });
      expect(overviewResponse.statusCode).toBe(200);
      expect(overviewResponse.json()).toMatchObject({
        active: {
          bucket: "citeloom",
          credentialSource: "static",
          credentialsConfigured: true,
          endpointUrl: "http://seaweedfs:8333",
          forcePathStyle: true,
          kind: "s3",
          prefix: "sources",
          region: "us-east-1",
        },
        documentCount: 34,
        migration: {
          id: migrationId,
          source: { kind: "filesystem" },
          target: { credentialSource: "static", kind: "s3" },
        },
        settingsVersion: 7,
      });
      expect(overviewResponse.body).not.toContain("storage-access-key");
      expect(overviewResponse.body).not.toContain("storage-secret-key");

      const probeResponse = await server.inject({
        method: "POST",
        payload: { target },
        url: "/api/source-content-storage/probes",
      });
      expect(probeResponse.statusCode).toBe(200);
      expect(probeResponse.json()).toEqual({ ok: true });
      expect(testSourceContentStorage).toHaveBeenCalledWith(target);

      const migrationResponse = await server.inject({
        method: "POST",
        payload: { expectedSettingsVersion: 7, target },
        url: "/api/source-content-storage/migrations",
      });
      expect(migrationResponse.statusCode).toBe(202);
      expect(migrationResponse.body).not.toContain("storage-access-key");
      expect(migrationResponse.body).not.toContain("storage-secret-key");
      expect(queueSourceContentMigration).toHaveBeenCalledWith(
        "00000000-0000-4000-8000-000000000000",
        { expectedSettingsVersion: 7, targetConfig: target },
      );

      const cancellationResponse = await server.inject({
        method: "POST",
        url: `/api/source-content-storage/migrations/${migrationId}/cancellation`,
      });
      expect(cancellationResponse.statusCode).toBe(200);
      expect(cancelSourceContentMigration).toHaveBeenCalledWith(migrationId);
    } finally {
      await server.close();
    }
  });

  it("rejects invalid source-content storage requests at the API boundary", async () => {
    const testSourceContentStorage = vi.fn<
      WebServices["testSourceContentStorage"]
    >(async () => undefined);
    const queueSourceContentMigration = vi.fn<
      WebServices["queueSourceContentMigration"]
    >();
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        queueSourceContentMigration,
        testSourceContentStorage,
      }),
      staticDirectory: null,
    });

    try {
      const invalidTarget = {
        bucket: "citeloom",
        credentials: { accessKeyId: "incomplete", kind: "static" },
        endpointUrl: "http://seaweedfs:8333",
        forcePathStyle: true,
        kind: "s3",
        prefix: "sources",
        region: "us-east-1",
      };
      const probeResponse = await server.inject({
        method: "POST",
        payload: { target: invalidTarget },
        url: "/api/source-content-storage/probes",
      });
      const migrationResponse = await server.inject({
        method: "POST",
        payload: { expectedSettingsVersion: 2, target: invalidTarget },
        url: "/api/source-content-storage/migrations",
      });

      expect(probeResponse.statusCode).toBe(400);
      expect(migrationResponse.statusCode).toBe(400);
      expect(testSourceContentStorage).not.toHaveBeenCalled();
      expect(queueSourceContentMigration).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("allows workspace settings while limiting deployment controls to global administrators", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "standard");
    const readSettings = vi.fn<WebServices["readSettings"]>();
    const readWorkspaceSettings = vi.fn<WebServices["readWorkspaceSettings"]>(
      async () => ({
        ...buildEffectiveSettings(),
        providerOverrideCapabilities: [],
      }),
    );
    const updateWorkspaceSettings = vi.fn<
      WebServices["updateWorkspaceSettings"]
    >(async () => ({
      ...buildEffectiveSettings(),
      providerOverrideCapabilities: ["answer"],
    }));
    const readSourceContentStorage = vi.fn<
      WebServices["readSourceContentStorage"]
    >();
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        listWorkspaces: async () => [buildPrincipalWorkspace(principal)],
        readSession: async () => principal,
        readSettings,
        readWorkspaceSettings,
        readSourceContentStorage,
        updateWorkspaceSettings,
      }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "GET",
        url: "/api/source-content-storage",
      });
      const settingsResponse = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "GET",
        url: "/api/settings",
      });
      const diagnosticsResponse = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        url: "/api/diagnostics",
      });
      const settingsUpdateResponse = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "PUT",
        payload: {
          changes: [{ action: "set", key: "topK", value: 12 }],
          expectedVersion: 1,
        },
        url: `/api/workspaces/${principal.workspaceId}/settings`,
      });
      const systemHealthResponse = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "GET",
        url: "/system-health",
      });
      const systemHealthFragmentResponse = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "GET",
        url: "/fragments/system-health.html",
      });
      const settingsFragmentResponse = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "GET",
        url: "/fragments/settings.html",
      });
      expect(response.statusCode).toBe(403);
      expect(settingsResponse.statusCode).toBe(200);
      expect(settingsResponse.json()).toMatchObject({
        embeddingInputFormats: [],
        embeddingSpace: null,
        scope: {
          editableProviderConnections: false,
          kind: "workspace",
          label: principal.workspaceName,
        },
        startupSettings: [],
        warnings: [],
      });
      expect(settingsResponse.json().fields.map((field: { key: string }) => {
        return field.key;
      })).not.toContain("doclingBaseUrl");
      const featureCapabilities = settingsResponse.json().features.map(
        (feature: { capability: string }) => feature.capability,
      );
      expect(featureCapabilities).not.toContain("embedding");
      expect(featureCapabilities).not.toContain("indexing");
      expect(settingsUpdateResponse.statusCode).toBe(200);
      expect(diagnosticsResponse.statusCode).toBe(403);
      expect(systemHealthResponse.statusCode).toBe(403);
      expect(systemHealthFragmentResponse.statusCode).toBe(403);
      expect(settingsFragmentResponse.statusCode).toBe(404);
      expect(readSettings).not.toHaveBeenCalled();
      expect(readWorkspaceSettings).toHaveBeenCalledWith(
        principal,
        principal.workspaceId,
      );
      expect(updateWorkspaceSettings).toHaveBeenCalledWith(
        principal,
        principal.workspaceId,
        {
          changes: [{ key: "topK", value: 12 }],
          expectedVersion: 1,
          providerChanges: [],
        },
      );
      expect(readSourceContentStorage).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("uses separate organization and explicit workspace settings resources", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "global_admin");
    const readSettings = vi.fn<WebServices["readSettings"]>(
      async () => buildEffectiveSettings(),
    );
    const updateSettings = vi.fn<WebServices["updateSettings"]>(
      async () => buildEffectiveSettings(),
    );
    const readWorkspaceSettings = vi.fn<WebServices["readWorkspaceSettings"]>(
      async () => ({
        ...buildEffectiveSettings(),
        providerOverrideCapabilities: [],
      }),
    );
    const updateWorkspaceSettings = vi.fn<
      WebServices["updateWorkspaceSettings"]
    >(async () => ({
      ...buildEffectiveSettings(),
      providerOverrideCapabilities: [],
    }));
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        listWorkspaces: async () => [buildPrincipalWorkspace(principal)],
        readSession: async () => principal,
        readSettings,
        readWorkspaceSettings,
        updateSettings,
        updateWorkspaceSettings,
      }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "GET",
        url: "/api/settings",
      });
      const workspaceResponse = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        method: "GET",
        url: `/api/workspaces/${principal.workspaceId}/settings`,
      });
      const organizationUpdateResponse = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "PUT",
        payload: {
          changes: [{ action: "set", key: "topK", value: 12 }],
          expectedVersion: 1,
        },
        url: "/api/settings",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        scope: {
          available: [
            {
              id: "organization",
              kind: "organization",
              label: "Organization",
            },
            {
              id: principal.workspaceId,
              kind: "workspace",
              label: principal.workspaceName,
            },
          ],
          editableProviderConnections: true,
          id: "organization",
          kind: "organization",
          label: "Organization",
        },
      });
      expect(workspaceResponse.statusCode).toBe(200);
      expect(workspaceResponse.json()).toMatchObject({
        scope: {
          editableProviderConnections: false,
          id: principal.workspaceId,
          kind: "workspace",
          label: principal.workspaceName,
        },
      });
      expect(organizationUpdateResponse.statusCode).toBe(200);
      expect(readWorkspaceSettings).toHaveBeenCalledWith(
        principal,
        principal.workspaceId,
      );
      expect(readSettings).toHaveBeenCalledOnce();
      expect(updateSettings).toHaveBeenCalledWith({
        changes: [{ key: "topK", value: 12 }],
        expectedVersion: 1,
        providerChanges: [],
      });
      expect(updateWorkspaceSettings).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("allows global administrators to manage another workspace explicitly", async () => {
    const principal = buildAuthenticatedPrincipal("member", "global_admin");
    const targetWorkspace = {
      id: "00000000-0000-4000-8000-000000000402",
      name: "Target Workspace",
      role: "admin" as const,
    };
    const memberId = "00000000-0000-4000-8000-000000000401";
    const addWorkspaceMember = vi.fn<WebServices["addWorkspaceMember"]>();
    const listWorkspaceMemberCandidates = vi.fn<
      WebServices["listWorkspaceMemberCandidates"]
    >(async () => [{
      displayName: "Workspace Member",
      globalRole: "standard",
      state: "active",
      userId: memberId,
      username: "workspace-member",
    }]);
    const listWorkspaceMembers = vi.fn<WebServices["listWorkspaceMembers"]>(
      async () => [],
    );
    const removeWorkspaceMember = vi.fn<WebServices["removeWorkspaceMember"]>();
    const readApplicationErrors = vi.fn<WebServices["readApplicationErrors"]>(
      async () => buildApplicationErrorPage(),
    );
    const readWorkspaceSettings = vi.fn<WebServices["readWorkspaceSettings"]>(
      async () => ({
        ...buildEffectiveSettings(),
        providerOverrideCapabilities: [],
      }),
    );
    const securityOverview = {
      activeResetLinkCount: 0,
      administrators: [],
      policy: {
        minimumPasswordLength: 12,
        requireLetterAndNumber: true,
        requireSpecialCharacter: false,
        resetLinkLifetimeSeconds: 3_600,
        updatedAt: "2026-08-12T12:00:00.000Z",
        version: 1,
      },
      recentChanges: [],
    };
    const readWorkspaceSecurityOverview = vi.fn(async () => securityOverview);
    const organizationUser = {
      currentWorkspaceAccess: false,
      displayName: "Workspace Member",
      globalRole: "standard" as const,
      state: "pending" as const,
      userId: memberId,
      username: "workspace-member",
      workspaceCount: 0,
    };
    const createOrganizationUser = vi.fn<
      SecurityWebServices["createOrganizationUser"]
    >(async () => organizationUser);
    const createOrganizationUserPasswordLink = vi.fn<
      SecurityWebServices["createOrganizationUserPasswordLink"]
    >(async () => ({
      expiresAt: "2026-08-12T13:00:00.000Z",
      purpose: "setup",
      setupToken: "a".repeat(48),
      userId: memberId,
    }));
    const listOrganizationUsers = vi.fn<
      SecurityWebServices["listOrganizationUsers"]
    >(async () => [organizationUser]);
    const services = {
      ...buildServices({
        addWorkspaceMember,
        listWorkspaceMemberCandidates,
        listWorkspaces: async () => [targetWorkspace],
        listWorkspaceMembers,
        readApplicationErrors,
        readSession: async () => principal,
        readWorkspaceSettings,
        removeWorkspaceMember,
      }),
      createOrganizationUser,
      createOrganizationUserPasswordLink,
      createMcpApiKey: async () => {
        throw new Error("Not used in this test.");
      },
      listOrganizationUsers,
      listMcpApiKeys: async () => [],
      readPasswordPolicy: async () => securityOverview.policy,
      readWorkspaceSecurityOverview,
      revokeMcpApiKey: async () => undefined,
      updateWorkspaceSecurityPolicy: async () => securityOverview,
    };
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services,
      staticDirectory: null,
    });

    try {
      const cookies = { "__Host-citeloom_session": "private-session-token" };
      const settingsResponse = await server.inject({
        cookies,
        method: "GET",
        url: `/api/workspaces/${targetWorkspace.id}/settings`,
      });
      const membersResponse = await server.inject({
        cookies,
        method: "GET",
        url: `/api/workspaces/${targetWorkspace.id}/members`,
      });
      const candidatesResponse = await server.inject({
        cookies,
        method: "GET",
        url: `/api/workspaces/${targetWorkspace.id}/member-candidates`,
      });
      const addMemberResponse = await server.inject({
        cookies,
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        payload: {
          role: "member",
          userId: memberId,
        },
        url: `/api/workspaces/${targetWorkspace.id}/members`,
      });
      const removeMemberResponse = await server.inject({
        cookies,
        headers: { origin: "https://localhost:3443" },
        method: "DELETE",
        url: `/api/workspaces/${targetWorkspace.id}/members/${memberId}`,
      });
      const passwordResetResponse = await server.inject({
        cookies,
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        url: `/api/workspaces/${targetWorkspace.id}/members/${memberId}/password-reset`,
      });
      const errorsResponse = await server.inject({
        cookies,
        method: "GET",
        url: "/api/errors",
      });
      const securityResponse = await server.inject({
        cookies,
        method: "GET",
        url: "/api/security",
      });
      const organizationUsersResponse = await server.inject({
        cookies,
        method: "GET",
        url: "/api/security/users",
      });
      const createOrganizationUserResponse = await server.inject({
        cookies,
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        payload: {
          displayName: "Workspace Member",
          username: "workspace-member",
        },
        url: "/api/security/users",
      });
      const passwordLinkResponse = await server.inject({
        cookies,
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        url: `/api/security/users/${memberId}/password-link`,
      });

      expect(settingsResponse.statusCode).toBe(200);
      expect(settingsResponse.json()).toMatchObject({
        scope: {
          available: [
            { kind: "organization", label: "Organization" },
            { kind: "workspace", label: targetWorkspace.name },
          ],
          editableProviderConnections: false,
          kind: "workspace",
        },
      });
      expect(membersResponse.statusCode).toBe(200);
      expect(candidatesResponse.statusCode).toBe(200);
      expect(candidatesResponse.json()).toEqual([{
        displayName: "Workspace Member",
        globalRole: "standard",
        state: "active",
        userId: memberId,
        username: "workspace-member",
      }]);
      expect(addMemberResponse.statusCode).toBe(204);
      expect(removeMemberResponse.statusCode).toBe(204);
      expect(passwordResetResponse.statusCode).toBe(404);
      expect(errorsResponse.statusCode).toBe(200);
      expect(securityResponse.statusCode).toBe(200);
      expect(organizationUsersResponse.statusCode).toBe(200);
      expect(organizationUsersResponse.json()).toEqual([organizationUser]);
      expect(createOrganizationUserResponse.statusCode).toBe(201);
      expect(passwordLinkResponse.statusCode).toBe(201);
      expect(readWorkspaceSettings).toHaveBeenCalledWith(
        principal,
        targetWorkspace.id,
      );
      expect(listWorkspaceMembers).toHaveBeenCalledWith(
        principal,
        targetWorkspace.id,
      );
      expect(listWorkspaceMemberCandidates).toHaveBeenCalledWith(
        principal,
        targetWorkspace.id,
      );
      expect(addWorkspaceMember).toHaveBeenCalledWith(
        principal,
        targetWorkspace.id,
        memberId,
        "member",
      );
      expect(removeWorkspaceMember).toHaveBeenCalledWith(
        principal,
        targetWorkspace.id,
        memberId,
      );
      expect(readApplicationErrors).toHaveBeenCalledWith(principal, {
        area: "all",
        page: 1,
        pageSize: 50,
      });
      expect(readWorkspaceSecurityOverview).toHaveBeenCalledWith(principal);
      expect(createOrganizationUser).toHaveBeenCalledWith(
        principal,
        expect.objectContaining({
          displayName: "Workspace Member",
          username: "workspace-member",
          usernameNormalized: "workspace-member",
        }),
      );
      expect(createOrganizationUserPasswordLink).toHaveBeenCalledWith(
        principal,
        memberId,
      );
      expect(listOrganizationUsers).toHaveBeenCalledWith(principal);
    } finally {
      await server.close();
    }
  });

  it("allows workspace administrators to view users but not manage passwords", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "standard");
    const createOrganizationUser = vi.fn<
      SecurityWebServices["createOrganizationUser"]
    >();
    const createOrganizationUserPasswordLink = vi.fn<
      SecurityWebServices["createOrganizationUserPasswordLink"]
    >();
    const listOrganizationUsers = vi.fn<
      SecurityWebServices["listOrganizationUsers"]
    >(async () => []);
    const securityOverview = {
      activeResetLinkCount: 0,
      administrators: [],
      policy: {
        minimumPasswordLength: 12,
        requireLetterAndNumber: true,
        requireSpecialCharacter: false,
        resetLinkLifetimeSeconds: 3_600,
        updatedAt: "2026-08-12T12:00:00.000Z",
        version: 1,
      },
      recentChanges: [],
    };
    const services = {
      ...buildServices({ readSession: async () => principal }),
      createOrganizationUser,
      createOrganizationUserPasswordLink,
      createMcpApiKey: async () => {
        throw new Error("Not used in this test.");
      },
      listOrganizationUsers,
      listMcpApiKeys: async () => [],
      readPasswordPolicy: async () => securityOverview.policy,
      readWorkspaceSecurityOverview: async () => securityOverview,
      revokeMcpApiKey: async () => undefined,
      updateWorkspaceSecurityPolicy: async () => securityOverview,
    };
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services,
      staticDirectory: null,
    });

    try {
      const cookies = { "__Host-citeloom_session": "private-session-token" };
      const responses = await Promise.all([
        server.inject({
          cookies,
          method: "GET",
          url: "/api/security/users",
        }),
        server.inject({
          cookies,
          headers: { origin: "https://localhost:3443" },
          method: "POST",
          payload: { displayName: "Jane Doe", username: "jdoe" },
          url: "/api/security/users",
        }),
        server.inject({
          cookies,
          headers: { origin: "https://localhost:3443" },
          method: "POST",
          url: "/api/security/users/00000000-0000-4000-8000-000000000701/password-link",
        }),
      ]);

      expect(responses.map((response) => response.statusCode)).toEqual([
        200,
        403,
        403,
      ]);
      expect(createOrganizationUser).not.toHaveBeenCalled();
      expect(createOrganizationUserPasswordLink).not.toHaveBeenCalled();
      expect(listOrganizationUsers).toHaveBeenCalledWith(principal);
    } finally {
      await server.close();
    }
  });

  it("allows a workspace administrator to issue and revoke a key for its target user", async () => {
    const principal = buildAuthenticatedPrincipal("admin", "standard");
    const userId = "00000000-0000-4000-8000-000000000701";
    const apiKeyId = "00000000-0000-4000-8000-000000000702";
    const record = {
      createdAt: "2026-08-13T19:00:00.000Z",
      expiresAt: "2026-11-13T19:00:00.000Z",
      id: apiKeyId,
      label: "Codex",
      revokedAt: null,
      scopes: ["citeloom.search" as const],
      userId,
      workspaceId: principal.workspaceId,
      workspaceName: principal.workspaceName,
    };
    const createMcpApiKey = vi.fn<SecurityWebServices["createMcpApiKey"]>(
      async () => ({ ...record, apiKey: "clm_mcp_secret" }),
    );
    const listMcpApiKeys = vi.fn<SecurityWebServices["listMcpApiKeys"]>(
      async () => [record],
    );
    const revokeMcpApiKey = vi.fn<SecurityWebServices["revokeMcpApiKey"]>(
      async () => undefined,
    );
    const services = {
      ...buildServices({ readSession: async () => principal }),
      createMcpApiKey,
      createOrganizationUser: vi.fn<SecurityWebServices["createOrganizationUser"]>(),
      createOrganizationUserPasswordLink:
        vi.fn<SecurityWebServices["createOrganizationUserPasswordLink"]>(),
      listMcpApiKeys,
      listOrganizationUsers: async () => [],
      readPasswordPolicy: async () => ({
        minimumPasswordLength: 12,
        requireLetterAndNumber: true,
        requireSpecialCharacter: false,
      }),
      readWorkspaceSecurityOverview: async () => ({
        activeResetLinkCount: 0,
        administrators: [],
        policy: {
          minimumPasswordLength: 12,
          requireLetterAndNumber: true,
          requireSpecialCharacter: false,
          resetLinkLifetimeSeconds: 3_600,
          updatedAt: "2026-08-13T19:00:00.000Z",
          version: 1,
        },
        recentChanges: [],
      }),
      revokeMcpApiKey,
      updateWorkspaceSecurityPolicy: vi.fn<
        SecurityWebServices["updateWorkspaceSecurityPolicy"]
      >(),
    };
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services,
      staticDirectory: null,
    });
    try {
      const cookies = { "__Host-citeloom_session": "private-session-token" };
      const createResponse = await server.inject({
        cookies,
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        payload: {
          expiresAt: record.expiresAt,
          label: record.label,
          scopes: record.scopes,
        },
        url: `/api/security/users/${userId}/mcp-api-keys`,
      });
      const listResponse = await server.inject({
        cookies,
        method: "GET",
        url: `/api/security/users/${userId}/mcp-api-keys`,
      });
      const revokeResponse = await server.inject({
        cookies,
        headers: { origin: "https://localhost:3443" },
        method: "DELETE",
        url: `/api/security/users/${userId}/mcp-api-keys/${apiKeyId}`,
      });

      expect(createResponse.statusCode).toBe(201);
      expect(createResponse.headers["cache-control"]).toBe("no-store");
      expect(createResponse.json()).toMatchObject({
        apiKey: "clm_mcp_secret",
        userId,
      });
      expect(listResponse.json()).toEqual([record]);
      expect(revokeResponse.statusCode).toBe(204);
      expect(createMcpApiKey).toHaveBeenCalledWith(
        principal,
        userId,
        {
          expiresAt: new Date(record.expiresAt),
          label: "Codex",
          scopes: ["citeloom.search"],
        },
      );
      expect(listMcpApiKeys).toHaveBeenCalledWith(principal, userId);
      expect(revokeMcpApiKey).toHaveBeenCalledWith(
        principal,
        userId,
        apiKeyId,
      );
    } finally {
      await server.close();
    }
  });

  it("decodes typed setting changes before updating persisted configuration", async () => {
    const updateSettings = vi.fn<WebServices["updateSettings"]>(async () => {
      return buildEffectiveSettings();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ updateSettings }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "PUT",
        payload: {
          changes: [
            { action: "set", key: "doclingTimeoutSeconds", value: 240 },
            { action: "set", key: "retryBaseSeconds", value: 2.5 },
            {
              action: "set",
              key: "backgroundProgressIntervalSeconds",
              value: 1.001,
            },
            { action: "reset", key: "workerFallbackPollSeconds" },
            { action: "reset", key: "queryExpansions" },
          ],
          expectedVersion: 2,
        },
        url: "/api/settings",
      });

      expect(response.statusCode).toBe(200);
      expect(updateSettings).toHaveBeenCalledWith({
        changes: [
          { key: "doclingTimeoutSeconds", value: 240 },
          { key: "retryBaseMs", value: 2_500 },
          { key: "backgroundProgressIntervalMs", value: 1_001 },
          { key: "workerFallbackPollMs", reset: true },
          { key: "queryExpansions", reset: true },
        ],
        expectedVersion: 2,
        providerChanges: [],
      });
    } finally {
      await server.close();
    }
  });

  it("exposes administrator-only OpenAI Codex connection and model state", async () => {
    const disconnect = vi.fn(async () => undefined);
    const readModels = vi.fn(async () => [{
      defaultReasoningLevel: "medium",
      id: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      reasoning: true,
      supportedReasoningLevels: ["low", "medium", "high"],
    }]);
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        openAICodex: {
          disconnect,
          readConnectionState: async () => ({
            expiresAt: "2026-07-27T13:00:00.000Z",
            state: "connected",
            updatedAt: "2026-07-27T12:00:00.000Z",
          }),
          readModels,
          replaceCredentials: async () => undefined,
        },
      }),
      staticDirectory: null,
    });

    try {
      const auth = await server.inject({
        method: "GET",
        url: "/api/providers/openai-codex/auth",
      });
      const models = await server.inject({
        method: "GET",
        url: "/api/providers/openai-codex/models",
      });
      const disconnected = await server.inject({
        method: "DELETE",
        url: "/api/providers/openai-codex/auth",
      });

      expect(auth.statusCode).toBe(200);
      expect(auth.json()).toEqual({
        connection: {
          expiresAt: "2026-07-27T13:00:00.000Z",
          state: "connected",
          updatedAt: "2026-07-27T12:00:00.000Z",
        },
        flow: null,
      });
      expect(models.statusCode).toBe(200);
      expect(models.json()).toEqual({
        models: [expect.objectContaining({ id: "gpt-5.6-terra" })],
      });
      expect(disconnected.statusCode).toBe(204);
      expect(readModels).toHaveBeenCalledOnce();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("rejects internal millisecond keys and imprecise browser seconds", async () => {
    const updateSettings = vi.fn<WebServices["updateSettings"]>(async () => {
      return buildEffectiveSettings();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ updateSettings }),
      staticDirectory: null,
    });

    try {
      const internalKey = await server.inject({
        method: "PUT",
        payload: {
          changes: [{ action: "set", key: "retryBaseMs", value: 5_000 }],
          expectedVersion: 0,
        },
        url: "/api/settings",
      });
      const impreciseSeconds = await server.inject({
        method: "PUT",
        payload: {
          changes: [{
            action: "set",
            key: "retryBaseSeconds",
            value: 0.1001,
          }],
          expectedVersion: 0,
        },
        url: "/api/settings",
      });
      const belowMinimum = await server.inject({
        method: "PUT",
        payload: {
          changes: [{
            action: "set",
            key: "retryBaseSeconds",
            value: 0.05,
          }],
          expectedVersion: 0,
        },
        url: "/api/settings",
      });

      expect(internalKey.statusCode).toBe(400);
      expect(internalKey.json()).toMatchObject({
        error: { message: "Unknown runtime setting: retryBaseMs." },
      });
      expect(impreciseSeconds.statusCode).toBe(400);
      expect(impreciseSeconds.json()).toMatchObject({
        error: {
          message: expect.stringContaining(
            "seconds must resolve to a whole number of milliseconds",
          ),
        },
      });
      expect(belowMinimum.statusCode).toBe(400);
      expect(updateSettings).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects invalid setting values and stale settings revisions", async () => {
    const updateSettings = vi.fn<WebServices["updateSettings"]>(async () => {
      throw new SettingsVersionConflictError();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ updateSettings }),
      staticDirectory: null,
    });

    try {
      const invalid = await server.inject({
        method: "PUT",
        payload: {
          changes: [{ action: "set", key: "doclingTimeoutSeconds", value: "slow" }],
          expectedVersion: 0,
        },
        url: "/api/settings",
      });
      const stale = await server.inject({
        method: "PUT",
        payload: {
          changes: [{ action: "set", key: "doclingTimeoutSeconds", value: 240 }],
          expectedVersion: 0,
        },
        url: "/api/settings",
      });

      expect(invalid.statusCode).toBe(400);
      expect(stale.statusCode).toBe(409);
      expect(updateSettings).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("decodes provider configuration, credential, and route changes", async () => {
    const updateSettings = vi.fn<WebServices["updateSettings"]>(async () => {
      return buildEffectiveSettings();
    });
    const providers = createTestProviderSettings();
    const configuration = readProviderConnectionConfiguration(
      providers.connections.groq,
    );
    configuration.speechToText.model = "configured-stt";
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ updateSettings }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "PUT",
        payload: {
          changes: [],
          expectedVersion: 0,
          providerChanges: [
            { action: "configure", configuration, providerId: "groq" },
            {
              action: "credential",
              providerId: "groq",
              target: "shared",
              value: "groq-secret",
            },
            {
              action: "route",
              capability: "speechToText",
              providerId: "groq",
            },
          ],
        },
        url: "/api/settings",
      });

      expect(response.statusCode).toBe(200);
      expect(updateSettings).toHaveBeenCalledWith({
        changes: [],
        expectedVersion: 0,
        providerChanges: [
          { action: "configure", configuration, providerId: "groq" },
          {
            action: "credential",
            providerId: "groq",
            target: "shared",
            value: "groq-secret",
          },
          {
            action: "route",
            capability: "speechToText",
            providerId: "groq",
          },
        ],
      });
    } finally {
      await server.close();
    }
  });

  it("decodes feature-scoped and provider-scoped reset changes", async () => {
    const updateSettings = vi.fn<WebServices["updateSettings"]>(async () => {
      return buildEffectiveSettings();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ updateSettings }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "PUT",
        payload: {
          changes: [],
          expectedVersion: 0,
          providerChanges: [
            { action: "reset-feature", capability: "chat" },
            { action: "reset-provider", providerId: "ollama" },
          ],
        },
        url: "/api/settings",
      });

      expect(response.statusCode).toBe(200);
      expect(updateSettings).toHaveBeenCalledWith({
        changes: [],
        expectedVersion: 0,
        providerChanges: [
          { action: "reset-feature", capability: "chat" },
          { action: "reset-provider", providerId: "ollama" },
        ],
      });
    } finally {
      await server.close();
    }
  });

  it("accepts database-owned provider identifiers at the HTTP boundary", async () => {
    const updateSettings = vi.fn<WebServices["updateSettings"]>(async () => {
      return buildEffectiveSettings();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ updateSettings }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "PUT",
        payload: {
          changes: [],
          expectedVersion: 0,
          providerChanges: [{
            action: "route",
            capability: "textToSpeech",
            providerId: "database-provider",
          }],
        },
        url: "/api/settings",
      });

      expect(response.statusCode).toBe(200);
      expect(updateSettings).toHaveBeenCalledWith({
        changes: [],
        expectedVersion: 0,
        providerChanges: [{
          action: "route",
          capability: "textToSpeech",
          providerId: "database-provider",
        }],
      });
    } finally {
      await server.close();
    }
  });

  it("does not contact providers while settings load or save", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const updateSettings = vi.fn<WebServices["updateSettings"]>(async () => {
      return buildEffectiveSettings();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ updateSettings }),
      staticDirectory: null,
    });

    try {
      const readResponse = await server.inject({
        method: "GET",
        url: "/api/settings",
      });
      const saveResponse = await server.inject({
        method: "PUT",
        payload: {
          changes: [{ action: "set", key: "ttsSpeed", value: 1.1 }],
          expectedVersion: 0,
        },
        url: "/api/settings",
      });

      expect(readResponse.statusCode).toBe(200);
      expect(saveResponse.statusCode).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("decodes document catalog filters before browsing a bounded page", async () => {
    const sourceLibraryId = "00000000-0000-4000-8000-000000000405";
    let receivedRequest: BrowseDocumentCatalogRequest | null = null;
    const removedDocument = buildBrowserDocument({
      displayStatus: "reindex-required",
      embeddingSpaceIds: ["previous-model:plain:768"],
      pageCount: 27,
      queryStatus: "reindex-required",
      sourceFile: "/documents/removed.pdf",
    });
    const services = buildServices({
      browseDocuments: async (_principal, request) => {
        receivedRequest = request;
        return buildCatalogResult([removedDocument]);
      },
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services,
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: `/api/documents?collection=tag%3Alegal&page=2&pageSize=50&search=privacy&sourceLibraryId=${sourceLibraryId}&sort=name-asc&status=reindex-required&tag=statute`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        documents: [{
          displayStatus: "reindex-required",
          embeddingProgress: {
            completedElements: 5,
            state: "complete",
            totalElements: 5,
          },
          mediaDescriptionProgress: {
            completedImages: 0,
            completedTables: 1,
          },
          indexingActivity: null,
          pageCount: 27,
          queryStatus: "reindex-required",
          sourceFile: "/documents/removed.pdf",
          status: "ready",
        }],
      });
      expect(receivedRequest).toEqual({
        collection: { kind: "tag", tag: "legal" },
        page: 2,
        pageSize: 50,
        search: "privacy",
        sourceLibraryId,
        sort: "name-asc",
        status: "reindex-required",
        tag: "statute",
      });
    } finally {
      await server.close();
    }
  });

  it("rejects invalid document catalog filters before calling the catalog", async () => {
    const browseDocuments = vi.fn<RuntimeWebServices["browseDocuments"]>(async () => {
      return buildCatalogResult();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ browseDocuments }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/api/documents?pageSize=500&status=unknown",
      });

      expect(response.statusCode).toBe(400);
      expect(browseDocuments).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("serves the catalog-validated stored source document inline", async () => {
    const documentId = "a".repeat(64);
    const sourceFile = "/app/documents/uploads/group/handbook.pdf";
    const content = Buffer.from("%PDF-test-document");
    const readDocumentFile = vi.fn<RuntimeWebServices["readDocumentFile"]>(async () => ({
      content,
      documentId,
      filename: "handbook.pdf",
      mediaType: "application/pdf",
      sourceFile,
    }));
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ readDocumentFile }),
      staticDirectory: null,
    });

    try {
      const parameters = new URLSearchParams({ sourceFile });
      const response = await server.inject({
        method: "GET",
        url: `/api/documents/${documentId}/file?${parameters.toString()}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["content-disposition"]).toContain("inline;");
      expect(response.headers["content-type"]).toContain("application/pdf");
      expect(response.rawPayload).toEqual(content);
      expect(readDocumentFile).toHaveBeenCalledWith(
        expect.objectContaining({ username: "disabled-authentication" }),
        { documentId, sourceFile },
      );
    } finally {
      await server.close();
    }
  });

  it("sandboxes stored HTML documents opened from answer links", async () => {
    const documentId = "a".repeat(64);
    const sourceFile = "/documents/reference.html";
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        readDocumentFile: async () => ({
          content: Buffer.from("<h1>Reference</h1>"),
          documentId,
          filename: "reference.html",
          mediaType: "text/html",
          sourceFile,
        }),
      }),
      staticDirectory: null,
    });

    try {
      const parameters = new URLSearchParams({ sourceFile });
      const response = await server.inject({
        method: "GET",
        url: `/api/documents/${documentId}/file?${parameters.toString()}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-security-policy"]).toContain("sandbox");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    } finally {
      await server.close();
    }
  });

  it("does not serve a document when the catalog ID and source path do not match", async () => {
    const readDocumentFile = vi.fn<RuntimeWebServices["readDocumentFile"]>(async () => null);
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ readDocumentFile }),
      staticDirectory: null,
    });

    try {
      const sourceFile = "/documents/other.pdf";
      const parameters = new URLSearchParams({ sourceFile });
      const response = await server.inject({
        method: "GET",
        url: `/api/documents/${"a".repeat(64)}/file?${parameters.toString()}`,
      });

      expect(response.statusCode).toBe(404);
      expect(readDocumentFile).toHaveBeenCalledWith(
        expect.objectContaining({ username: "disabled-authentication" }),
        {
          documentId: "a".repeat(64),
          sourceFile,
        },
      );
    } finally {
      await server.close();
    }
  });

  it("rejects invalid document links before reading stored content", async () => {
    const readDocumentFile = vi.fn<RuntimeWebServices["readDocumentFile"]>(async () => null);
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ readDocumentFile }),
      staticDirectory: null,
    });

    try {
      const missingSourceResponse = await server.inject({
        method: "GET",
        url: `/api/documents/${"a".repeat(64)}/file?sourceFile=`,
      });
      const invalidIdResponse = await server.inject({
        method: "GET",
        url: "/api/documents/not-a-document-id/file?sourceFile=%2Fdocuments%2Fhandbook.pdf",
      });

      expect(missingSourceResponse.statusCode).toBe(400);
      expect(invalidIdResponse.statusCode).toBe(400);
      expect(readDocumentFile).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("decodes a scoped question before streaming the RAG pipeline", async () => {
    let receivedQuestion: QuestionRequest | null = null;
    const services = buildServices({
      streamAnswer: (_principal, request) => {
        receivedQuestion = request;
        return createAnswerStream("The milestone is Friday.");
      },
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services,
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: {
          question: "When is the milestone?",
          scope: { kind: "sourceFiles", sourceFiles: ["/documents/handbook.docx"] },
          threadId: "00000000-0000-4000-8000-000000000001",
        },
        url: "/api/questions",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.body).toContain("data-answer");
      expect(response.body).toContain("The milestone is Friday.");
      expect(receivedQuestion).toEqual({
        question: "When is the milestone?",
        scope: { kind: "sourceFiles", sourceFiles: ["/documents/handbook.docx"] },
        threadId: "00000000-0000-4000-8000-000000000001",
      });
    } finally {
      await server.close();
    }
  });

  it("rejects an empty question before starting a stream", async () => {
    const streamAnswer = vi.fn<RuntimeWebServices["streamAnswer"]>(() => {
      return createAnswerStream("Unexpected answer");
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ streamAnswer }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { question: "   ", scope: { kind: "all" } },
        url: "/api/questions",
      });

      expect(response.statusCode).toBe(400);
      expect(streamAnswer).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("streams validated speech audio with private response headers", async () => {
    const audioBytes = Buffer.from("RIFF speech audio");
    const answerDocument = {
      citations: [] as [],
      content: "The supplied source material does not answer this question.",
      schemaVersion: 2 as const,
      statements: [] as [],
    };
    const generateSpeech = vi.fn<RuntimeWebServices["generateSpeech"]>(async () => ({
      audio: Readable.from([audioBytes]),
      completion: Promise.resolve(),
      contentType: "audio/wav",
    }));
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ generateSpeech }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { answerDocument },
        url: "/api/speech",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["content-type"]).toContain("audio/wav");
      expect(response.rawPayload).toEqual(audioBytes);
      expect(generateSpeech).toHaveBeenCalledWith(
        { answerDocument },
        expect.any(AbortSignal),
      );
    } finally {
      await server.close();
    }
  });

  it("rejects an invalid speech answer document before generating audio", async () => {
    const generateSpeech = vi.fn<RuntimeWebServices["generateSpeech"]>();
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ generateSpeech }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: {
          answerDocument: {
            citations: [],
            content: "The supplied source material does not answer this question.",
            schemaVersion: 1,
            statements: [],
          },
        },
        url: "/api/speech",
      });

      expect(response.statusCode).toBe(400);
      expect(generateSpeech).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns service unavailable when text-to-speech is disabled", async () => {
    const generateSpeech = vi.fn<RuntimeWebServices["generateSpeech"]>(async () => {
      throw new TextToSpeechUnavailableError();
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ generateSpeech }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: {
          answerDocument: {
            citations: [],
            content: "The supplied source material does not answer this question.",
            schemaVersion: 2,
            statements: [],
          },
        },
        url: "/api/speech",
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: {
          id: "00000000-0000-4000-8000-000000000099",
          message: "A required service is unavailable.",
        },
      });
    } finally {
      await server.close();
    }
  });

  it("returns a typed transcription with private response headers", async () => {
    const effectiveConfig = buildConfig();
    effectiveConfig.speechToText = buildSpeechToTextConfig();
    const transcribeAudio = vi.fn<RuntimeWebServices["transcribeAudio"]>(
      async () => ({ text: "CiteLoom should search the evidence for Section 42." }),
    );
    const uploadDirectory = await createTemporaryDirectory();
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ config: effectiveConfig, transcribeAudio }),
      staticDirectory: null,
      uploadDirectory,
    });
    const form = new FormData();
    form.append(
      "file",
      new File(["recorded audio"], "browser-supplied-name.webm", {
        type: "audio/webm;codecs=opus",
      }),
    );
    const request = await buildMultipartRequest(form);

    try {
      const response = await server.inject({
        headers: request.headers,
        method: "POST",
        payload: request.payload,
        url: "/api/transcriptions",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        text: "CiteLoom should search the evidence for Section 42.",
      });
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(transcribeAudio).toHaveBeenCalledOnce();
      const [audio, signal] = transcribeAudio.mock.calls[0] ?? [];
      expect(audio).toMatchObject({
        content: Buffer.from("recorded audio"),
        mediaType: "audio/webm",
      });
      expect(audio?.filename).toMatch(
        /^recording-[0-9a-f-]{36}\.webm$/,
      );
      expect(audio?.filename).not.toContain("browser-supplied-name");
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(await readDirectoryEntries(uploadDirectory)).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("keeps an accepted transcription on one runtime snapshot during a settings reload", async () => {
    const firstConfig = buildConfig();
    firstConfig.speechToText = {
      ...buildSpeechToTextConfig(),
      model: "first-transcription-model",
    };
    const secondConfig = buildConfig();
    secondConfig.speechToText = {
      ...buildSpeechToTextConfig(),
      model: "second-transcription-model",
    };
    const firstGate = createDeferred<void>();
    const firstTranscribe = vi.fn<RuntimeWebServices["transcribeAudio"]>(async () => {
      await firstGate.promise;
      return { text: "First runtime transcript" };
    });
    const secondTranscribe = vi.fn<RuntimeWebServices["transcribeAudio"]>(
      async () => ({ text: "Second runtime transcript" }),
    );
    const services = buildServices({
      config: firstConfig,
      transcribeAudio: firstTranscribe,
    });
    const replacementServices = buildServices({
      config: secondConfig,
      transcribeAudio: secondTranscribe,
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services,
      staticDirectory: null,
    });
    const firstRequest = await buildMultipartRequest(buildTranscriptionForm([
      buildAudioFile("first audio", "audio/webm"),
    ]));

    try {
      const acceptedResponse = server.inject({
        headers: firstRequest.headers,
        method: "POST",
        payload: firstRequest.payload,
        url: "/api/transcriptions",
      });
      await vi.waitFor(() => expect(firstTranscribe).toHaveBeenCalledOnce());
      services.runInWorkspace = replacementServices.runInWorkspace;
      firstGate.resolve(undefined);

      await expect(acceptedResponse.then((response) => response.json())).resolves.toEqual({
        text: "First runtime transcript",
      });
      expect(secondTranscribe).not.toHaveBeenCalled();

      const secondRequest = await buildMultipartRequest(buildTranscriptionForm([
        buildAudioFile("second audio", "audio/webm"),
      ]));
      const replacementResponse = await server.inject({
        headers: secondRequest.headers,
        method: "POST",
        payload: secondRequest.payload,
        url: "/api/transcriptions",
      });
      expect(replacementResponse.json()).toEqual({
        text: "Second runtime transcript",
      });
    } finally {
      firstGate.resolve(undefined);
      await server.close();
    }
  });

  it("rejects disabled transcription before parsing the multipart body", async () => {
    const transcribeAudio = vi.fn<RuntimeWebServices["transcribeAudio"]>();
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ transcribeAudio }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        headers: { "content-type": "multipart/form-data; boundary=broken" },
        method: "POST",
        payload: "this is not a multipart body",
        url: "/api/transcriptions",
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: {
          id: "00000000-0000-4000-8000-000000000099",
          message: "A required service is unavailable.",
        },
      });
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(transcribeAudio).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it.each([
    ["non-multipart", "text/plain", Buffer.from("audio"), 415],
    ["malformed multipart", "multipart/form-data; boundary=broken", Buffer.from("audio"), 400],
  ])("rejects a %s transcription upload", async (_name, contentType, payload, status) => {
    const effectiveConfig = buildConfig();
    effectiveConfig.speechToText = buildSpeechToTextConfig();
    const transcribeAudio = vi.fn<RuntimeWebServices["transcribeAudio"]>();
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ config: effectiveConfig, transcribeAudio }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        headers: { "content-type": contentType },
        method: "POST",
        payload,
        url: "/api/transcriptions",
      });

      expect(response.statusCode).toBe(status);
      expect(transcribeAudio).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it.each([
    ["missing file", new FormData(), 400],
    ["empty file", buildTranscriptionForm([buildAudioFile("", "audio/webm")]), 400],
    ["undersized MP4", buildTranscriptionForm([
      buildAudioFile("x".repeat(1_499), "audio/mp4"),
    ]), 400],
    ["unsupported file", buildTranscriptionForm([buildAudioFile("audio", "audio/mpeg")]), 415],
    ["unexpected field", buildTranscriptionForm(
      [buildAudioFile("audio", "audio/webm")],
      ["language", "English"],
    ), 400],
    ["multiple files", buildTranscriptionForm([
      buildAudioFile("first", "audio/webm"),
      buildAudioFile("second", "audio/webm"),
    ]), 400],
  ])("rejects a transcription request with %s", async (_name, form, status) => {
    const effectiveConfig = buildConfig();
    effectiveConfig.speechToText = buildSpeechToTextConfig();
    const transcribeAudio = vi.fn<RuntimeWebServices["transcribeAudio"]>();
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ config: effectiveConfig, transcribeAudio }),
      staticDirectory: null,
    });
    const request = await buildMultipartRequest(form);

    try {
      const response = await server.inject({
        headers: request.headers,
        method: "POST",
        payload: request.payload,
        url: "/api/transcriptions",
      });

      expect(response.statusCode).toBe(status);
      expect(transcribeAudio).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects audio above the runtime snapshot byte limit", async () => {
    const effectiveConfig = buildConfig();
    effectiveConfig.speechToText = {
      ...buildSpeechToTextConfig(),
      maxAudioBytes: 4,
    };
    const transcribeAudio = vi.fn<RuntimeWebServices["transcribeAudio"]>();
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ config: effectiveConfig, transcribeAudio }),
      staticDirectory: null,
    });
    const request = await buildMultipartRequest(buildTranscriptionForm([
      buildAudioFile("12345", "audio/webm"),
    ]));

    try {
      const response = await server.inject({
        headers: request.headers,
        method: "POST",
        payload: request.payload,
        url: "/api/transcriptions",
      });

      expect(response.statusCode).toBe(413);
      expect(transcribeAudio).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it.each([
    [new SpeechToTextProviderError(), 502],
    [new SpeechToTextTimeoutError(), 504],
  ])("maps transcription provider failures without exposing provider content", async (error, status) => {
    const effectiveConfig = buildConfig();
    effectiveConfig.speechToText = buildSpeechToTextConfig();
    const transcribeAudio = vi.fn<RuntimeWebServices["transcribeAudio"]>(async () => {
      throw error;
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ config: effectiveConfig, transcribeAudio }),
      staticDirectory: null,
    });
    const request = await buildMultipartRequest(buildTranscriptionForm([
      buildAudioFile("audio", "audio/webm"),
    ]));

    try {
      const response = await server.inject({
        headers: request.headers,
        method: "POST",
        payload: request.payload,
        url: "/api/transcriptions",
      });

      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain("transcription-token");
      expect(response.headers["cache-control"]).toBe("private, no-store");
    } finally {
      await server.close();
    }
  });

  it("propagates a browser disconnect to the active transcription", async () => {
    const effectiveConfig = buildConfig();
    effectiveConfig.speechToText = buildSpeechToTextConfig();
    const transcribeAudio = vi.fn<RuntimeWebServices["transcribeAudio"]>(
      async (_audio, signal) => {
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ config: effectiveConfig, transcribeAudio }),
      staticDirectory: null,
    });
    let disconnect = (): void => {
      throw new Error("Expected the transcription request to start.");
    };
    server.addHook("onRequest", async (request) => {
      disconnect = () => request.raw.emit("close");
    });
    const request = await buildMultipartRequest(buildTranscriptionForm([
      buildAudioFile("audio", "audio/webm"),
    ]));

    try {
      const response = server.inject({
        headers: request.headers,
        method: "POST",
        payload: request.payload,
        url: "/api/transcriptions",
      });
      await vi.waitFor(() => expect(transcribeAudio).toHaveBeenCalledOnce());
      const providerSignal = transcribeAudio.mock.calls[0]?.[1];

      disconnect();

      await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
      await response.catch(() => undefined);
    } finally {
      await server.close();
    }
  });

  it("streams supported uploads and normalizes ingestion options", async () => {
    const uploadDirectory = await createTemporaryDirectory();
    const sourceLibraryId = "00000000-0000-4000-8000-000000000404";
    let receivedDocuments: StagedIngestionDocument[] = [];
    const receivedContents: string[] = [];
    let receivedOptions: Parameters<RuntimeWebServices["ingest"]>[2] | null = null;
    let receivedSourceLibraryId: string | null = null;
    const services = buildServices({
      ingest: async (_principal, documents, options, _uploadRoot, libraryId) => {
        receivedDocuments = [...documents];
        for (const document of documents) {
          receivedContents.push(await readFile(document.sourceFile, "utf8"));
        }
        receivedOptions = options;
        receivedSourceLibraryId = libraryId;
        return { documents: [], failures: [] };
      },
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services,
      staticDirectory: null,
      uploadDirectory,
    });

    try {
      const form = new FormData();
      form.append("force", "true");
      form.append("sourceLibraryId", sourceLibraryId);
      form.append("tags", "Finance,quarterly,finance");
      form.append("documents", new Blob(["<html>Revenue</html>"], { type: "text/html" }), "report.HTML");
      form.append("documents", new Blob(["docx bytes"]), "handbook.docx");
      const request = await buildMultipartRequest(form);
      const response = await server.inject({
        headers: request.headers,
        method: "POST",
        payload: request.payload,
        url: "/api/ingestions",
      });

      expect(response.statusCode).toBe(200);
      expect(receivedOptions).toEqual({
        enqueue: true,
        force: true,
        recursive: false,
        tags: ["finance", "quarterly"],
      });
      expect(receivedSourceLibraryId).toBe(sourceLibraryId);
      expect(receivedDocuments.map((document) => ({
        byteLength: document.byteLength,
        documentId: document.documentId,
        extension: document.extension,
        mediaType: document.mediaType,
        sourceFilename: document.sourceFile.split("/").at(-1),
      }))).toEqual([
        {
          byteLength: 20,
          documentId: createHash("sha256").update("<html>Revenue</html>").digest("hex"),
          extension: ".html",
          mediaType: "text/html",
          sourceFilename: "report.html",
        },
        {
          byteLength: 10,
          documentId: createHash("sha256").update("docx bytes").digest("hex"),
          extension: ".docx",
          mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          sourceFilename: "handbook.docx",
        },
      ]);
      expect(receivedContents).toEqual(["<html>Revenue</html>", "docx bytes"]);
      await expect(readDirectoryEntries(uploadDirectory)).resolves.toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("rejects oversized uploads and removes the incomplete upload group", async () => {
    const uploadDirectory = await createTemporaryDirectory();
    const ingest = vi.fn<RuntimeWebServices["ingest"]>(async () => ({ documents: [], failures: [] }));
    const config = buildConfig();
    config.maxDocumentBytes = 16;
    const services = buildServices({
      ingest,
      config,
    });
    const server = await buildWebServer(config, {
      logger: false,
      services,
      staticDirectory: null,
      uploadDirectory,
    });

    try {
      const form = new FormData();
      form.append("documents", new Blob(["x".repeat(32)]), "oversized.html");
      const request = await buildMultipartRequest(form);
      const response = await server.inject({
        headers: request.headers,
        method: "POST",
        payload: request.payload,
        url: "/api/ingestions",
      });

      expect(response.statusCode).toBe(413);
      expect(ingest).not.toHaveBeenCalled();
      await expect(readDirectoryEntries(uploadDirectory)).resolves.toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("queues a failed job retry from its stored durable phase", async () => {
    const sourceFile = "/app/documents/uploads/group/handbook.pdf";
    const retryFailedJob = vi.fn<RuntimeWebServices["retryFailedJob"]>(
      async (_principal, requestedSourceFile) => {
        return {
          job: buildPendingJob(requestedSourceFile),
          kind: "retried",
        };
      },
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ retryFailedJob }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile },
        url: "/api/ingestion-jobs/retry",
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        phase: "normalized",
        sourceFile,
        state: "pending",
        updatedAt: "2026-07-14T04:00:00.000Z",
      });
      expect(retryFailedJob).toHaveBeenCalledWith(
        expect.objectContaining({ username: "disabled-authentication" }),
        sourceFile,
      );
    } finally {
      await server.close();
    }
  });

  it("queues a force reindex for the selected stored document", async () => {
    const documentId = "a".repeat(64);
    const sourceFile = "/app/documents/uploads/group/handbook.pdf";
    const reindexDocument = vi.fn<RuntimeWebServices["reindexDocument"]>(
      async (_principal, request) => ({
        documentId: request.documentId,
        kind: "queued",
        sourceFile: request.sourceFile,
      }),
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ reindexDocument }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile },
        url: `/api/documents/${documentId}/reindex`,
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        documentId,
        sourceFile,
        status: "queued",
      });
      expect(reindexDocument).toHaveBeenCalledWith(
        expect.objectContaining({ username: "disabled-authentication" }),
        { documentId, sourceFile },
        {
          isAdministrator: true,
          userId: "00000000-0000-4000-8000-000000000000",
        },
      );
    } finally {
      await server.close();
    }
  });

  it("passes the authenticated member to document reindexing", async () => {
    const principal = buildAuthenticatedPrincipal("member");
    const reindexDocument = vi.fn<RuntimeWebServices["reindexDocument"]>(
      async (_principal, request) => ({
        documentId: request.documentId,
        kind: "queued",
        sourceFile: request.sourceFile,
      }),
    );
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        readSession: async () => principal,
        reindexDocument,
      }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        payload: {
          sourceFile: "/app/documents/uploads/group/handbook.pdf",
        },
        url: `/api/documents/${"a".repeat(64)}/reindex`,
      });

      expect(response.statusCode).toBe(202);
      expect(reindexDocument).toHaveBeenCalledWith(
        principal,
        {
          documentId: "a".repeat(64),
          sourceFile: "/app/documents/uploads/group/handbook.pdf",
        },
        {
          isAdministrator: false,
          userId: principal.userId,
        },
      );
    } finally {
      await server.close();
    }
  });

  it("gives a global administrator workspace ingestion controls", async () => {
    const principal = buildAuthenticatedPrincipal("member", "global_admin");
    const reindexDocument = vi.fn<RuntimeWebServices["reindexDocument"]>(
      async (_principal, request) => ({
        documentId: request.documentId,
        kind: "queued",
        sourceFile: request.sourceFile,
      }),
    );
    const server = await buildProductionWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        readSession: async () => principal,
        reindexDocument,
      }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        cookies: { "__Host-citeloom_session": "private-session-token" },
        headers: { origin: "https://localhost:3443" },
        method: "POST",
        payload: {
          sourceFile: "/app/documents/uploads/group/handbook.pdf",
        },
        url: `/api/documents/${"a".repeat(64)}/reindex`,
      });

      expect(response.statusCode).toBe(202);
      expect(reindexDocument).toHaveBeenCalledWith(
        principal,
        {
          documentId: "a".repeat(64),
          sourceFile: "/app/documents/uploads/group/handbook.pdf",
        },
        {
          isAdministrator: true,
          userId: principal.userId,
        },
      );
    } finally {
      await server.close();
    }
  });

  it("rejects an invalid document reindex request at the HTTP boundary", async () => {
    const reindexDocument = vi.fn<RuntimeWebServices["reindexDocument"]>(
      async () => ({ kind: "not-found" }),
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ reindexDocument }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile: "" },
        url: "/api/documents/not-a-document-id/reindex",
      });

      expect(response.statusCode).toBe(400);
      expect(reindexDocument).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("returns not found when the selected document is no longer indexed", async () => {
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices(),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile: "/documents/missing.pdf" },
        url: `/api/documents/${"a".repeat(64)}/reindex`,
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("returns a conflict when the selected document cannot be queued", async () => {
    const reindexDocument = vi.fn<RuntimeWebServices["reindexDocument"]>(
      async () => ({
        error: "Another ingestion worker is processing this document.",
        kind: "rejected",
      }),
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ reindexDocument }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile: "/documents/active.pdf" },
        url: `/api/documents/${"a".repeat(64)}/reindex`,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { message: "Another ingestion worker is processing this document." },
      });
    } finally {
      await server.close();
    }
  });

  it("rejects an invalid retry request at the HTTP boundary", async () => {
    const retryFailedJob = vi.fn<RuntimeWebServices["retryFailedJob"]>(async () => {
      return { kind: "not-found" };
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ retryFailedJob }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile: "   " },
        url: "/api/ingestion-jobs/retry",
      });

      expect(response.statusCode).toBe(400);
      expect(retryFailedJob).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("passes the authenticated administrator to ingestion control", async () => {
    const sourceFile = "/documents/uploads/request/document.pdf";
    const requestIngestionControl = vi.fn<
      RuntimeWebServices["requestIngestionControl"]
    >(async () => ({ job: buildPendingJob(sourceFile), kind: "accepted" }));
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ requestIngestionControl }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile },
        url: "/api/ingestion-jobs/pause",
      });

      expect(response.statusCode).toBe(202);
      expect(requestIngestionControl).toHaveBeenCalledWith(
        expect.objectContaining({ username: "disabled-authentication" }),
        sourceFile,
        "pause",
        {
          isAdministrator: true,
          userId: "00000000-0000-4000-8000-000000000000",
        },
      );
    } finally {
      await server.close();
    }
  });

  it("returns a conflict when a requested job is not failed", async () => {
    const retryFailedJob = vi.fn<RuntimeWebServices["retryFailedJob"]>(async () => {
      return { kind: "not-failed", state: "running" };
    });
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ retryFailedJob }),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile: "/documents/active.pdf" },
        url: "/api/ingestion-jobs/retry",
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error: { message: "Ingestion job is running, not failed: /documents/active.pdf." },
      });
    } finally {
      await server.close();
    }
  });

  it("returns not found when no matching ingestion job exists", async () => {
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices(),
      staticDirectory: null,
    });

    try {
      const response = await server.inject({
        method: "POST",
        payload: { sourceFile: "/documents/missing.pdf" },
        url: "/api/ingestion-jobs/retry",
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
});

describe("research API boundary", () => {
  it("creates, lists, reopens, and exports explicit research threads", async () => {
    const thread = {
      createdAt: "2026-07-15T12:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000201",
      title: "Quarterly evidence",
      turns: [],
      updatedAt: "2026-07-15T12:00:00.000Z",
    };
    const createResearchThread = vi.fn<RuntimeWebServices["createResearchThread"]>(
      async () => thread,
    );
    const deleteResearchThread = vi.fn<RuntimeWebServices["deleteResearchThread"]>(
      async () => undefined,
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        createResearchThread,
        deleteResearchThread,
        exportResearchThread: async () => ({
          content: "# Quarterly evidence\n",
          filename: "thread.md",
          mediaType: "text/markdown; charset=utf-8",
        }),
        listResearchThreads: async () => [{
          createdAt: thread.createdAt,
          id: thread.id,
          title: thread.title,
          turnCount: 0,
          updatedAt: thread.updatedAt,
        }],
        readResearchThread: async () => thread,
      }),
      staticDirectory: null,
    });
    try {
      const created = await server.inject({
        method: "POST",
        payload: { title: "  Quarterly evidence  " },
        url: "/api/research/threads",
      });
      const listed = await server.inject({
        method: "GET",
        url: "/api/research/threads",
      });
      const reopened = await server.inject({
        method: "GET",
        url: `/api/research/threads/${thread.id}`,
      });
      const exported = await server.inject({
        method: "GET",
        url: `/api/research/threads/${thread.id}/export?format=markdown`,
      });
      const deleted = await server.inject({
        method: "DELETE",
        url: `/api/research/threads/${thread.id}`,
      });

      expect(created.statusCode).toBe(201);
      expect(createResearchThread).toHaveBeenCalledWith(
        expect.objectContaining({ username: "disabled-authentication" }),
        "Quarterly evidence",
      );
      expect(listed.json()).toEqual([expect.objectContaining({ id: thread.id })]);
      expect(reopened.json()).toMatchObject({ id: thread.id });
      expect(exported.headers["content-type"]).toContain("text/markdown");
      expect(exported.headers["content-disposition"]).toContain("thread.md");
      expect(deleted.statusCode).toBe(204);
      expect(deleteResearchThread).toHaveBeenCalledWith(
        expect.objectContaining({ username: "disabled-authentication" }),
        thread.id,
      );
    } finally {
      await server.close();
    }
  });

  it("returns bounded document version metadata", async () => {
    const sourceFile = "/documents/test.pdf";
    const version = {
      createdAt: "2026-07-24T05:03:27.369Z",
      documentId: "a".repeat(64),
      elementCount: 37,
      elementSetId: "b".repeat(64),
      format: {
        extension: ".pdf" as const,
        mediaType: "application/pdf" as const,
      },
      generationId: "00000000-0000-4000-8000-000000000002",
      id: "00000000-0000-4000-8000-000000000001",
      pageCount: 12,
      sourceFile,
      version: 1,
    };
    const listDocumentVersions = vi.fn<
      RuntimeWebServices["listDocumentVersions"]
    >(async () => [version]);
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({ listDocumentVersions }),
      staticDirectory: null,
    });
    try {
      const response = await server.inject({
        method: "GET",
        url: `/api/document-versions?sourceFile=${encodeURIComponent(sourceFile)}`,
      });

      expect(response.statusCode).toBe(200);
      expect(listDocumentVersions).toHaveBeenCalledWith(
        expect.objectContaining({ username: "disabled-authentication" }),
        sourceFile,
      );
      expect(response.json()).toEqual([version]);
      expect(response.json()[0]).not.toHaveProperty("elementIds");
    } finally {
      await server.close();
    }
  });

  it("returns immutable citation evidence and validates dimension-specific feedback", async () => {
    const citationId = "00000000-0000-4000-8000-000000000202";
    const turnId = "00000000-0000-4000-8000-000000000203";
    const addResearchFeedback = vi.fn<RuntimeWebServices["addResearchFeedback"]>(
      async () => ({ negativeCount: 1, positiveCount: 0, rating: -1 }),
    );
    const server = await buildWebServer(buildConfig(), {
      logger: false,
      services: buildServices({
        addResearchFeedback,
        readCitationEvidence: async () => ({
          citationNumber: 1,
          createdAt: "2026-07-15T12:00:00.000Z",
          documentId: "a".repeat(64),
          documentVersionId: "00000000-0000-4000-8000-000000000205",
          elementId: "b".repeat(64),
          evidence: { excerpt: "Exact evidence.", kind: "text" },
          id: citationId,
          pageNumbers: [1],
          regions: [],
          sectionPath: [],
          sourceFile: "/documents/evidence.txt",
          stale: false,
          turnId,
        }),
      }),
      staticDirectory: null,
    });
    try {
      const evidence = await server.inject({
        method: "GET",
        url: `/api/citations/${citationId}`,
      });
      const invalidFeedback = await server.inject({
        method: "POST",
        payload: {
          citationId: null,
          comment: null,
          dimension: "citation-correctness",
          rating: 1,
          turnId,
        },
        url: "/api/research/feedback",
      });
      const validFeedback = await server.inject({
        method: "POST",
        payload: {
          citationId,
          comment: null,
          dimension: "citation-correctness",
          rating: -1,
          turnId,
        },
        url: "/api/research/feedback",
      });

      expect(evidence.statusCode).toBe(200);
      expect(evidence.json()).toMatchObject({
        documentVersionId: "00000000-0000-4000-8000-000000000205",
        evidence: { excerpt: "Exact evidence.", kind: "text" },
      });
      expect(invalidFeedback.statusCode).toBe(400);
      expect(validFeedback.statusCode).toBe(200);
      expect(addResearchFeedback).toHaveBeenCalledWith(
        expect.objectContaining({ username: "disabled-authentication" }),
        {
          citationId,
          comment: null,
          dimension: "citation-correctness",
          rating: -1,
          turnId,
        },
      );
    } finally {
      await server.close();
    }
  });

});


async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "citeloom-web-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function buildMultipartRequest(form: FormData): Promise<{
  headers: Record<string, string>;
  payload: Buffer;
}> {
  const request = new Request("http://citeloom.test/api/ingestions", {
    body: form,
    method: "POST",
  });
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const payload = Buffer.from(await request.arrayBuffer());
  return { headers, payload };
}

async function readDirectoryEntries(directory: string): Promise<string[]> {
  return readdir(directory);
}
