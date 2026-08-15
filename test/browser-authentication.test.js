import { webcrypto } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function buildOAuthBootstrap() {
  return {
    mode: "oauth",
    oauth: {
      apiResource: "https://citeloom.example/api",
      apiScopes: ["citeloom.app"],
      browserCallbackUri: "https://citeloom.example/oauth/callback",
      browserClientId: "browser-client",
      browserPostLogoutRedirectUri: "https://citeloom.example/login",
      browserScopes: ["citeloom.app", "openid"],
      issuer: "https://identity.example/oidc",
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  const sessionStorage = createStorage();
  vi.stubGlobal("window", {
    btoa: (value) => Buffer.from(value, "binary").toString("base64"),
    crypto: webcrypto,
    fetch: vi.fn(async () => jsonResponse({ mode: "local", oauth: null })),
    location: {
      assign: vi.fn(),
      hash: "",
      href: "https://citeloom.example/login",
      origin: "https://citeloom.example",
      pathname: "/login",
      replace: vi.fn(),
      search: "",
    },
    sessionStorage,
  });
});

describe("browser OAuth authentication", () => {
  it("adds the bearer token and selected local workspace to API requests", async () => {
    const module = await import(
      "../web/assets/scripts/browser-authentication.js?workspace-request"
    );
    await module.browserAuthentication.ready();
    const storage = createStorage();
    storage.setItem("citeloom.oauth.tokens.v1", JSON.stringify({
      accessToken: "access-token",
      clientId: "browser-client",
      expiresAt: Date.now() + 120_000,
      idToken: null,
      issuer: "https://identity.example/oidc",
      refreshToken: null,
      resource: "https://citeloom.example/api",
    }));
    const requests = [];
    const fetchImplementation = vi.fn(async (input, init) => {
      const url = new URL(input, window.location.origin);
      requests.push({ init, pathname: url.pathname });
      if (url.pathname === "/api/auth/bootstrap") {
        return jsonResponse(buildOAuthBootstrap());
      }
      if (url.pathname === "/api/auth/context") {
        return jsonResponse({
          displayName: "OAuth User",
          globalRole: "standard",
          userId: "00000000-0000-4000-8000-000000000001",
          username: "oauth-user",
          workspaces: [{
            id: "00000000-0000-4000-8000-000000000002",
            name: "Local Workspace",
            role: "member",
          }],
        });
      }
      return jsonResponse([]);
    });
    const authentication = module.createBrowserAuthentication({
      fetchImplementation,
      sessionStorage: storage,
    });

    const response = await authentication.withAuthentication(
      "/api/workspaces",
      { headers: { accept: "application/json" } },
    );

    expect(response.status).toBe(200);
    const request = requests.find((candidate) => {
      return candidate.pathname === "/api/workspaces";
    });
    const headers = new Headers(request.init.headers);
    expect(headers.get("authorization")).toBe("Bearer access-token");
    expect(headers.get("x-citeloom-workspace-id")).toBe(
      "00000000-0000-4000-8000-000000000002",
    );

    const resource = await authentication.readAuthorizedResource(
      "/api/documents/test/file#page=3",
    );
    expect(resource.href).toMatch(/^blob:.*#page=3$/u);
    const resourceRequest = requests.find((candidate) => {
      return candidate.pathname === "/api/documents/test/file";
    });
    const resourceHeaders = new Headers(resourceRequest.init.headers);
    expect(resourceHeaders.get("authorization")).toBe("Bearer access-token");
    expect(resourceHeaders.get("x-citeloom-workspace-id")).toBe(
      "00000000-0000-4000-8000-000000000002",
    );
    resource.revoke();
  });

  it("starts authorization code flow with PKCE and the configured resource", async () => {
    const module = await import(
      "../web/assets/scripts/browser-authentication.js?pkce"
    );
    await module.browserAuthentication.ready();
    const storage = createStorage();
    const fetchImplementation = vi.fn(async (input) => {
      const url = new URL(input, window.location.origin);
      if (url.pathname === "/api/auth/bootstrap") {
        return jsonResponse(buildOAuthBootstrap());
      }
      return jsonResponse({
        authorization_endpoint: "https://identity.example/oidc/authorize",
        issuer: "https://identity.example/oidc",
        jwks_uri: "https://identity.example/oidc/jwks",
        token_endpoint: "https://identity.example/oidc/token",
      });
    });
    const authentication = module.createBrowserAuthentication({
      fetchImplementation,
      sessionStorage: storage,
    });
    await authentication.ready();

    await authentication.beginSignIn("/documents");

    expect(window.location.assign).toHaveBeenCalledOnce();
    const authorizationUrl = new URL(window.location.assign.mock.calls[0][0]);
    expect(authorizationUrl.origin).toBe("https://identity.example");
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorizationUrl.searchParams.get("resource")).toBe(
      "https://citeloom.example/api",
    );
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "citeloom.app openid",
    );
    expect(storage.getItem("citeloom.oauth.transaction.v1")).not.toBeNull();
  });

  it("tells the user how to correct an OAuth origin mismatch", async () => {
    const module = await import(
      "../web/assets/scripts/browser-authentication.js?activation-origin"
    );
    await module.browserAuthentication.ready();
    const authentication = module.createBrowserAuthentication({
      fetchImplementation: vi.fn(async () => jsonResponse({
        mode: "local",
        oauth: null,
      })),
      sessionStorage: createStorage(),
    });
    const configuration = buildOAuthBootstrap().oauth;
    configuration.apiResource = "https://other-citeloom.example/api";
    configuration.browserCallbackUri = "https://other-citeloom.example/oauth/callback";
    configuration.browserPostLogoutRedirectUri = "https://other-citeloom.example/login";

    await expect(authentication.beginActivation(configuration, 7)).rejects.toThrow(
      "This page uses https://citeloom.example, but OAuth uses https://other-citeloom.example. Open https://other-citeloom.example and try again.",
    );
  });

  it("moves an active OAuth browser to the configured application origin", async () => {
    const module = await import(
      "../web/assets/scripts/browser-authentication.js?canonical-origin"
    );
    await module.browserAuthentication.ready();
    window.location.href = "https://localhost:3443/index.html?view=overview";
    window.location.origin = "https://localhost:3443";
    window.location.pathname = "/index.html";
    window.location.search = "?view=overview";
    module.createBrowserAuthentication({
      fetchImplementation: vi.fn(async () => jsonResponse(buildOAuthBootstrap())),
      sessionStorage: createStorage(),
    });

    await vi.waitFor(() => {
      expect(window.location.replace).toHaveBeenCalledWith(
        "https://citeloom.example/index.html?view=overview",
      );
    });
  });

  it("rejects an expired OAuth callback transaction", async () => {
    const module = await import(
      "../web/assets/scripts/browser-authentication.js?expired-transaction"
    );
    await module.browserAuthentication.ready();
    const storage = createStorage();
    storage.setItem("citeloom.oauth.transaction.v1", JSON.stringify({
      codeVerifier: "expired-code-verifier",
      createdAt: Date.now() - 11 * 60 * 1_000,
      expectedVersion: null,
      oauth: buildOAuthBootstrap().oauth,
      purpose: "sign-in",
      returnTo: "/documents",
      state: "expired-state",
    }));
    window.location.href = "https://citeloom.example/oauth/callback?code=test-code&state=expired-state";
    window.location.pathname = "/oauth/callback";
    window.location.search = "?code=test-code&state=expired-state";
    const authentication = module.createBrowserAuthentication({
      fetchImplementation: vi.fn(async () => jsonResponse({
        mode: "local",
        oauth: null,
      })),
      sessionStorage: storage,
    });

    await expect(authentication.ready()).rejects.toThrow(
      "The OAuth callback could not be verified.",
    );
    expect(storage.getItem("citeloom.oauth.transaction.v1")).toBeNull();
  });

  it("rejects an OAuth callback from another issuer", async () => {
    const module = await import(
      "../web/assets/scripts/browser-authentication.js?callback-issuer"
    );
    await module.browserAuthentication.ready();
    const storage = createStorage();
    storage.setItem("citeloom.oauth.transaction.v1", JSON.stringify({
      codeVerifier: "callback-code-verifier",
      createdAt: Date.now(),
      expectedVersion: null,
      oauth: buildOAuthBootstrap().oauth,
      purpose: "sign-in",
      returnTo: "/documents",
      state: "callback-state",
    }));
    window.location.href = "https://citeloom.example/oauth/callback?code=test-code&state=callback-state&iss=https%3A%2F%2Fanother-identity.example%2Foidc";
    window.location.pathname = "/oauth/callback";
    window.location.search = "?code=test-code&state=callback-state&iss=https%3A%2F%2Fanother-identity.example%2Foidc";
    const fetchImplementation = vi.fn(async (input) => {
      const url = new URL(input, window.location.origin);
      if (url.pathname === "/api/auth/bootstrap") {
        return jsonResponse(buildOAuthBootstrap());
      }
      return jsonResponse({
        authorization_endpoint: "https://identity.example/oidc/authorize",
        issuer: "https://identity.example/oidc",
        token_endpoint: "https://identity.example/oidc/token",
      });
    });
    const authentication = module.createBrowserAuthentication({
      fetchImplementation,
      sessionStorage: storage,
    });

    await expect(authentication.ready()).rejects.toThrow(
      "The OAuth callback issuer does not match the authorization server.",
    );
  });

  it("requires the callback issuer when the server advertises it", async () => {
    const module = await import(
      "../web/assets/scripts/browser-authentication.js?missing-callback-issuer"
    );
    await module.browserAuthentication.ready();
    const storage = createStorage();
    storage.setItem("citeloom.oauth.transaction.v1", JSON.stringify({
      codeVerifier: "callback-code-verifier",
      createdAt: Date.now(),
      expectedVersion: null,
      oauth: buildOAuthBootstrap().oauth,
      purpose: "sign-in",
      returnTo: "/documents",
      state: "callback-state",
    }));
    window.location.href = "https://citeloom.example/oauth/callback?code=test-code&state=callback-state";
    window.location.pathname = "/oauth/callback";
    window.location.search = "?code=test-code&state=callback-state";
    const fetchImplementation = vi.fn(async (input) => {
      const url = new URL(input, window.location.origin);
      if (url.pathname === "/api/auth/bootstrap") {
        return jsonResponse(buildOAuthBootstrap());
      }
      return jsonResponse({
        authorization_endpoint: "https://identity.example/oidc/authorize",
        authorization_response_iss_parameter_supported: true,
        issuer: "https://identity.example/oidc",
        token_endpoint: "https://identity.example/oidc/token",
      });
    });
    const authentication = module.createBrowserAuthentication({
      fetchImplementation,
      sessionStorage: storage,
    });

    await expect(authentication.ready()).rejects.toThrow(
      "The OAuth callback issuer is missing.",
    );
  });

  it("restores the active issuer token when staged issuer activation fails", async () => {
    const module = await import(
      "../web/assets/scripts/browser-authentication.js?activation-rollback"
    );
    await module.browserAuthentication.ready();
    const storage = createStorage();
    const activeTokens = {
      accessToken: "active-access-token",
      clientId: "browser-client",
      expiresAt: Date.now() + 120_000,
      idToken: "active-id-token",
      issuer: "https://identity.example/oidc",
      refreshToken: "active-refresh-token",
      resource: "https://citeloom.example/api",
    };
    storage.setItem(
      "citeloom.oauth.tokens.v1",
      JSON.stringify(activeTokens),
    );
    const stagedOAuth = {
      ...buildOAuthBootstrap().oauth,
      browserClientId: "replacement-browser-client",
      issuer: "https://replacement-identity.example/oidc",
    };
    storage.setItem("citeloom.oauth.transaction.v1", JSON.stringify({
      codeVerifier: "replacement-code-verifier",
      createdAt: Date.now(),
      expectedVersion: 7,
      oauth: stagedOAuth,
      purpose: "activation",
      returnTo: "/overview",
      state: "replacement-state",
    }));
    window.location.href = "https://citeloom.example/oauth/callback?code=replacement-code&state=replacement-state";
    window.location.pathname = "/oauth/callback";
    window.location.search = "?code=replacement-code&state=replacement-state";
    const fetchImplementation = vi.fn(async (input) => {
      const url = new URL(input, window.location.origin);
      if (url.pathname === "/api/auth/bootstrap") {
        return jsonResponse(buildOAuthBootstrap());
      }
      if (url.pathname.endsWith("/.well-known/openid-configuration")) {
        return jsonResponse({
          authorization_endpoint: "https://replacement-identity.example/oidc/authorize",
          issuer: stagedOAuth.issuer,
          token_endpoint: "https://replacement-identity.example/oidc/token",
        });
      }
      if (url.pathname === "/oidc/token") {
        return jsonResponse({
          access_token: "replacement-access-token",
          expires_in: 120,
          token_type: "Bearer",
        });
      }
      if (url.pathname === "/api/security/authentication/oauth/activate") {
        return jsonResponse({
          error: { message: "The authentication settings changed." },
        }, 409);
      }
      throw new Error(`Unexpected request to ${url.toString()}`);
    });
    const authentication = module.createBrowserAuthentication({
      fetchImplementation,
      sessionStorage: storage,
    });

    await expect(authentication.ready()).rejects.toThrow(
      "The authentication settings changed.",
    );
    const activationRequest = fetchImplementation.mock.calls.find(([input]) => {
      const url = new URL(input, window.location.origin);
      return url.pathname === "/api/security/authentication/oauth/activate";
    });
    expect(activationRequest).toBeDefined();
    const activationHeaders = new Headers(activationRequest[1].headers);
    expect(activationHeaders.get("x-citeloom-oauth-activation-proof")).toBe(
      "Bearer replacement-access-token",
    );
    expect(JSON.parse(storage.getItem("citeloom.oauth.tokens.v1"))).toEqual(
      activeTokens,
    );
  });
});
