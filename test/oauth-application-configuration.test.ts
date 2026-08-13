import { describe, expect, it } from "vitest";

import {
  buildEffectiveOAuthApplicationConfiguration,
  OAuthApplicationConfigurationError,
  parseOAuthApplicationConfiguration,
  requireSecureOAuthPublicOrigin,
  readStoredOAuthApplicationConfiguration,
} from "../src/oauth/application-configuration.js";

describe("application OAuth configuration", () => {
  it("normalizes scopes once and derives CiteLoom resource identifiers", () => {
    const stored = parseOAuthApplicationConfiguration({
      apiScopes: ["citeloom.app", "citeloom.app"],
      browserClientId: "citeloom-browser",
      browserScopes: ["profile", "openid", "citeloom.app", "profile"],
      issuer: "https://identity.example.com/oidc",
      mcpScopes: ["citeloom.search", "citeloom.answer"],
    });

    expect(stored).toEqual({
      apiScopes: ["citeloom.app"],
      browserClientId: "citeloom-browser",
      browserScopes: ["citeloom.app", "openid", "profile"],
      issuer: "https://identity.example.com/oidc",
      mcpScopes: ["citeloom.answer", "citeloom.search"],
      schemaVersion: 1,
    });
    expect(
      buildEffectiveOAuthApplicationConfiguration(
        stored,
        "https://citeloom.example.com",
      ),
    ).toMatchObject({
      apiResource: "https://citeloom.example.com/api",
      apiScopes: ["citeloom.app"],
      browserCallbackUri: "https://citeloom.example.com/oauth/callback",
      browserPostLogoutRedirectUri: "https://citeloom.example.com/login",
      mcpResource: "https://citeloom.example.com/mcp",
    });
  });

  it("rejects browser configuration without OpenID Connect identity", () => {
    expect(() => parseOAuthApplicationConfiguration({
      apiScopes: ["citeloom.app"],
      browserClientId: "citeloom-browser",
      browserScopes: ["profile"],
      issuer: "https://identity.example.com/oidc",
      mcpScopes: ["citeloom.search"],
    })).toThrow(OAuthApplicationConfigurationError);
  });

  it("rejects API scopes that the browser does not request", () => {
    expect(() => parseOAuthApplicationConfiguration({
      apiScopes: ["citeloom.app"],
      browserClientId: "citeloom-browser",
      browserScopes: ["openid", "profile"],
      issuer: "https://identity.example.com/oidc",
      mcpScopes: ["citeloom.search"],
    })).toThrow(
      "The browser authorization scopes must include every required API scope.",
    );
  });

  it("rejects unsafe issuers and non-origin public URLs", () => {
    expect(() => parseOAuthApplicationConfiguration({
      apiScopes: ["citeloom.app"],
      browserClientId: "citeloom-browser",
      browserScopes: ["citeloom.app", "openid"],
      issuer: "http://identity.example.com/oidc",
      mcpScopes: ["citeloom.search"],
    })).toThrow(OAuthApplicationConfigurationError);

    const stored = readStoredOAuthApplicationConfiguration({
      apiScopes: ["citeloom.app"],
      browserClientId: "citeloom-browser",
      browserScopes: ["citeloom.app", "openid"],
      issuer: "https://identity.example.com/oidc",
      mcpScopes: ["citeloom.search"],
      schemaVersion: 1,
    });
    expect(() => buildEffectiveOAuthApplicationConfiguration(
      stored,
      "https://citeloom.example.com/nested",
    )).toThrow(OAuthApplicationConfigurationError);
    expect(() => requireSecureOAuthPublicOrigin(
      "http://citeloom.example.com",
    )).toThrow(OAuthApplicationConfigurationError);
  });
});
