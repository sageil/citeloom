import {
  createOAuthAccessTokenVerifier,
  OAuthAccessTokenRejectedError,
  type OAuthAccessTokenVerifier,
} from "../oauth/access-token.js";
import type {
  AuthenticationSettings,
} from "../oauth/application-store.js";
import type {
  OAuthIdentityContext,
  McpOAuthIdentityAccessToken,
} from "../oauth/principal-store.js";
import type { OAuthPrincipal } from "../oauth/model.js";
import type { WebServices } from "./services.js";

export const CITELOOM_WORKSPACE_HEADER = "x-citeloom-workspace-id";
export const OAUTH_ACTIVATION_PROOF_HEADER = "x-citeloom-oauth-activation-proof";

export interface ApplicationOAuthRequestAuthenticator {
  authenticate(
    settings: AuthenticationSettings,
    authorizationHeader: string | string[] | undefined,
    workspaceId: string,
  ): Promise<OAuthPrincipal>;
  readIdentityContext(
    settings: AuthenticationSettings,
    authorizationHeader: string | string[] | undefined,
  ): Promise<OAuthIdentityContext>;
  verifyMcpAccess(
    settings: AuthenticationSettings,
    authorizationHeader: string | string[] | undefined,
    workspaceName: string,
    requiredScopes: readonly string[],
  ): Promise<{
    principal: OAuthPrincipal;
    token: McpOAuthIdentityAccessToken;
  }>;
}

export class OAuthApplicationModeUnavailableError extends Error {
  public constructor() {
    super("OAuth authentication is not enabled.");
    this.name = "OAuthApplicationModeUnavailableError";
  }
}

export function createApplicationOAuthRequestAuthenticator(
  services: Pick<
    WebServices,
    "readOAuthIdentityContext" | "resolveOAuthPrincipal"
    | "resolveOAuthPrincipalByWorkspaceName"
  >,
  fetchImplementation: typeof fetch = fetch,
): ApplicationOAuthRequestAuthenticator {
  const verifiers = new Map<string, OAuthAccessTokenVerifier>();

  const verify = async (
    settings: AuthenticationSettings,
    authorizationHeader: string | string[] | undefined,
    resourceKind: "api" | "mcp",
    operationScopes?: readonly string[],
  ) => {
    const configuration = settings.activeOAuthConfiguration;
    if (settings.mode !== "oauth" || configuration === null) {
      throw new OAuthApplicationModeUnavailableError();
    }
    const resource = resourceKind === "api"
      ? configuration.apiResource
      : configuration.mcpResource;
    const requiredScopes = resourceKind === "api"
      ? configuration.apiScopes
      : operationScopes ?? [];
    const verifierKey = JSON.stringify({
      issuer: configuration.issuer,
      resource,
    });
    let verifier = verifiers.get(verifierKey);
    if (verifier === undefined) {
      verifier = createOAuthAccessTokenVerifier(
        {
          issuer: configuration.issuer,
          resource,
        },
        fetchImplementation,
      );
      verifiers.set(verifierKey, verifier);
    }
    return verifier.verify(authorizationHeader, requiredScopes);
  };

  return {
    authenticate: async (settings, authorizationHeader, workspaceId) => {
      const token = await verify(settings, authorizationHeader, "api");
      return services.resolveOAuthPrincipal(token, workspaceId);
    },
    readIdentityContext: async (settings, authorizationHeader) => {
      const token = await verify(settings, authorizationHeader, "api");
      return services.readOAuthIdentityContext(token);
    },
    verifyMcpAccess: async (
      settings,
      authorizationHeader,
      workspaceName,
      requiredScopes,
    ) => {
      const token = await verify(
        settings,
        authorizationHeader,
        "mcp",
        requiredScopes,
      );
      if (token.clientId === null) {
        throw new OAuthAccessTokenRejectedError();
      }
      const mcpToken: McpOAuthIdentityAccessToken = {
        clientId: token.clientId,
        expiresAt: token.expiresAt,
        issuer: token.issuer,
        scopes: token.scopes,
        subject: token.subject,
      };
      const principal = await services.resolveOAuthPrincipalByWorkspaceName(
        mcpToken,
        workspaceName,
      );
      return { principal, token: mcpToken };
    },
  };
}
