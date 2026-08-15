import { describe, expect, it } from "vitest";

import { registerPage } from "../web/assets/scripts/security.js";

describe("CiteLoom security page", () => {
  it("preserves live OAuth status accessors when composing page state", () => {
    let pageFactory = null;
    registerPage({
      data: (name, factory) => {
        expect(name).toBe("citeloomSecurityPage");
        pageFactory = factory;
      },
    });
    expect(pageFactory).not.toBeNull();

    const page = pageFactory();
    const configuration = {
      apiResource: "https://citeloom.example",
      apiScopes: ["citeloom.app"],
      browserCallbackUri: "https://citeloom.example/auth/oauth/callback",
      browserClientId: "browser-client",
      browserPostLogoutRedirectUri: "https://citeloom.example/login",
      browserScopes: ["citeloom.app", "openid", "profile"],
      issuer: "https://identity.example/oidc",
      mcpResource: "https://citeloom.example/mcp",
      mcpScopes: ["citeloom.answer", "citeloom.search"],
    };
    page.oauthSettings = {
      activeOAuthConfiguration: null,
      hostRecoveryEnabled: true,
      mode: "local",
      stagedOAuthConfiguration: configuration,
    };

    expect(page.oauthActive).toBe(false);
    expect(page.oauthConfigured).toBe(true);
    expect(page.oauthHostRecoveryEnabled).toBe(true);
    expect(page.oauthManagedConfiguration).toBe(configuration);
    expect(page.oauthStaged).toBe(true);

    page.openOAuthConfiguration();
    expect(page.oauthConfigurationDrawerOpen).toBe(true);
    expect(page.oauthIssuer).toBe(configuration.issuer);
    expect(page.oauthBrowserClientId).toBe(configuration.browserClientId);

    page.openOAuthMappingDrawer();
    expect(page.oauthMappingDrawer).toBe("user");

    page.oauthSettings.mode = "oauth";
    expect(page.oauthActive).toBe(true);
  });
});
