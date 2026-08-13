import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

import {
  readEnabledOAuthConfig,
  type EnabledOAuthConfig,
  type OAuthConfig,
} from "../oauth/config.js";
import {
  createOAuthAccessTokenVerifier,
  type OAuthAccessTokenVerifier,
} from "../oauth/access-token.js";
import {
  OAuthResourceDisabledError,
} from "../oauth/configuration-store.js";
import type { OAuthPrincipal } from "../oauth/model.js";
import type { OAuthSecurityWebServices } from "./services.js";

const OAUTH_PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource";

export interface OAuthRequestAuthenticator {
  authenticate(
    authorizationHeader: string | string[] | undefined,
    requiredScopes: readonly string[],
  ): Promise<OAuthPrincipal>;
}

export function createOAuthRequestAuthenticator(
  services: Pick<
    OAuthSecurityWebServices,
    "readOAuthConfiguration" | "resolveOAuthPrincipal"
  >,
  publicOrigin: string,
  fetchImplementation: typeof fetch = fetch,
): OAuthRequestAuthenticator {
  let verifier: OAuthAccessTokenVerifier | null = null;
  let verifierKey: string | null = null;

  return {
    authenticate: async (authorizationHeader, requiredScopes) => {
      const settings = await services.readOAuthConfiguration(publicOrigin);
      const config = readEnabledOAuthConfig(settings);
      if (!config.enabled) {
        throw new OAuthResourceDisabledError();
      }
      const currentVerifierKey = buildOAuthVerifierKey(config);
      if (verifier === null || verifierKey !== currentVerifierKey) {
        verifier = createOAuthAccessTokenVerifier(config, fetchImplementation);
        verifierKey = currentVerifierKey;
      }
      const token = await verifier.verify(authorizationHeader, requiredScopes);
      return services.resolveOAuthPrincipal(token);
    },
  };
}

export function registerOAuthProtectedResourceMetadata(
  server: FastifyInstance,
  options: {
    publicOrigin: string;
    services: Pick<OAuthSecurityWebServices, "readOAuthConfiguration">;
  },
): void {
  const handler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> => {
    const settings = await options.services.readOAuthConfiguration(
      options.publicOrigin,
    );
    const config = readEnabledOAuthConfig(settings);
    const metadataPath = buildOAuthProtectedResourceMetadataPath(config);
    if (
      !config.enabled
      || metadataPath === null
      || readRequestPathname(request.url) !== metadataPath
    ) {
      return reply.header("Cache-Control", "no-store").status(404).send();
    }
    reply.header("Cache-Control", "public, max-age=60");
    return {
      authorization_servers: [config.issuer],
      bearer_methods_supported: ["header"],
      resource: config.resource,
      scopes_supported: [...config.scopes],
    };
  };
  server.get(OAUTH_PROTECTED_RESOURCE_METADATA_PATH, handler);
  server.get(`${OAUTH_PROTECTED_RESOURCE_METADATA_PATH}/*`, handler);
}

export function buildOAuthProtectedResourceMetadataPath(
  config: OAuthConfig,
): string | null {
  if (!config.enabled) {
    return null;
  }
  const resourcePath = new URL(config.resource).pathname;
  if (resourcePath === "/") {
    return OAUTH_PROTECTED_RESOURCE_METADATA_PATH;
  }
  return `${OAUTH_PROTECTED_RESOURCE_METADATA_PATH}${resourcePath}`;
}

export function isOAuthProtectedResourceMetadataPath(pathname: string): boolean {
  return pathname === OAUTH_PROTECTED_RESOURCE_METADATA_PATH
    || pathname.startsWith(`${OAUTH_PROTECTED_RESOURCE_METADATA_PATH}/`);
}

function buildOAuthVerifierKey(config: EnabledOAuthConfig): string {
  return JSON.stringify({
    issuer: config.issuer,
    resource: config.resource,
    scopes: config.scopes,
    workspaceClaim: config.workspaceClaim,
  });
}

function readRequestPathname(url: string): string {
  return url.split("?", 1)[0] ?? url;
}
