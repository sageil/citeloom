import {
  createRemoteJWKSet,
  customFetch,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { z } from "zod";

import {
  BearerTokenRejectedError,
  readBearerToken,
} from "../auth/bearer-token.js";
import type { VerifiedOAuthAccessToken } from "./model.js";

const DISCOVERY_TIMEOUT_MS = 10_000;
const oidcMetadataSchema = z.object({
  issuer: z.url(),
  jwks_uri: z.url(),
}).passthrough();
const jsonWebKeySetSchema = z.object({
  keys: z.array(z.object({
    kty: z.string().min(1),
  }).passthrough()).min(1),
}).passthrough();

export class OAuthAccessTokenRejectedError extends Error {
  public constructor() {
    super("The OAuth access token is invalid.");
    this.name = "OAuthAccessTokenRejectedError";
  }
}

export class OAuthInsufficientScopeError extends Error {
  public readonly requiredScopes: string[];

  public constructor(requiredScopes: readonly string[]) {
    super("The OAuth access token does not grant the required scopes.");
    this.name = "OAuthInsufficientScopeError";
    this.requiredScopes = [...requiredScopes];
  }
}

export class OAuthConfigurationVerificationError extends Error {
  public constructor() {
    super("The OAuth authorization server configuration could not be verified.");
    this.name = "OAuthConfigurationVerificationError";
  }
}

export interface OAuthAccessTokenVerifier {
  verify(
    authorizationHeader: string | string[] | undefined,
    requiredScopes?: readonly string[],
  ): Promise<VerifiedOAuthAccessToken>;
}

export interface OAuthAccessTokenVerificationConfig {
  issuer: string;
  resource: string;
}

export function createOAuthAccessTokenVerifier(
  config: OAuthAccessTokenVerificationConfig,
  fetchImplementation: typeof fetch = fetch,
): OAuthAccessTokenVerifier {
  let verificationKey: Promise<JWTVerifyGetKey> | null = null;

  return {
    verify: async (authorizationHeader, requiredScopes = []) => {
      const accessToken = readOAuthBearerToken(authorizationHeader);
      try {
        verificationKey ??= discoverVerificationKey(
          config,
          fetchImplementation,
        ).catch((error: unknown) => {
          verificationKey = null;
          throw error;
        });
        const key = await verificationKey;
        const result = await jwtVerify(accessToken, key, {
          audience: config.resource,
          issuer: config.issuer,
        });
        const token = readVerifiedAccessTokenClaims(result.payload, config);
        requireOAuthScopes(token.scopes, requiredScopes);
        return token;
      } catch (error: unknown) {
        if (error instanceof OAuthInsufficientScopeError) {
          throw error;
        }
        if (error instanceof OAuthAccessTokenRejectedError) {
          throw error;
        }
        if (error instanceof joseErrors.JOSEError) {
          throw new OAuthAccessTokenRejectedError();
        }
        throw error;
      }
    },
  };
}

export function readOAuthBearerToken(
  authorizationHeader: string | string[] | undefined,
): string {
  try {
    return readBearerToken(authorizationHeader);
  } catch (error: unknown) {
    if (!(error instanceof BearerTokenRejectedError)) {
      throw error;
    }
    throw new OAuthAccessTokenRejectedError();
  }
}

export async function verifyOAuthAuthorizationServerConfiguration(
  config: OAuthAccessTokenVerificationConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  try {
    const jwksUrl = await discoverJsonWebKeySetUrl(
      config,
      fetchImplementation,
    );
    const response = await fetchImplementation(jwksUrl, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      throw new Error(
        `OAuth JSON Web Key Set retrieval failed with status ${response.status}.`,
      );
    }
    const value: unknown = await response.json();
    if (!jsonWebKeySetSchema.safeParse(value).success) {
      throw new Error("OAuth JSON Web Key Set is invalid.");
    }
  } catch {
    throw new OAuthConfigurationVerificationError();
  }
}

async function discoverVerificationKey(
  config: OAuthAccessTokenVerificationConfig,
  fetchImplementation: typeof fetch,
): Promise<JWTVerifyGetKey> {
  const jwksUrl = await discoverJsonWebKeySetUrl(config, fetchImplementation);
  return createRemoteJWKSet(jwksUrl, {
    [customFetch]: async (url, options) => {
      return fetchImplementation(url, options);
    },
    timeoutDuration: DISCOVERY_TIMEOUT_MS,
  });
}

async function discoverJsonWebKeySetUrl(
  config: OAuthAccessTokenVerificationConfig,
  fetchImplementation: typeof fetch,
): Promise<URL> {
  const discoveryUrl = buildOpenIdDiscoveryUrl(config.issuer);
  const response = await fetchImplementation(discoveryUrl, {
    headers: { accept: "application/json" },
    redirect: "manual",
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    throw new Error(
      `OAuth authorization-server discovery failed with status ${response.status}.`,
    );
  }
  const value: unknown = await response.json();
  const result = oidcMetadataSchema.safeParse(value);
  if (!result.success) {
    throw new Error("OAuth authorization-server metadata is invalid.");
  }
  if (result.data.issuer !== config.issuer) {
    throw new Error("OAuth authorization-server metadata returned another issuer.");
  }
  return readHttpsUrl(result.data.jwks_uri, "JWKS URI");
}

function buildOpenIdDiscoveryUrl(issuer: string): URL {
  const url = new URL(issuer);
  const path = url.pathname.endsWith("/")
    ? url.pathname
    : `${url.pathname}/`;
  url.pathname = `${path}.well-known/openid-configuration`;
  return url;
}

function readVerifiedAccessTokenClaims(
  payload: Record<string, unknown>,
  config: OAuthAccessTokenVerificationConfig,
): VerifiedOAuthAccessToken {
  const registeredClaims = z.object({
    azp: z.string().min(1).max(1_024).optional(),
    client_id: z.string().min(1).max(1_024).optional(),
    exp: z.number().int().positive(),
    scope: z.string().max(10_000).default(""),
    sub: z.string().min(1).max(1_024),
  }).passthrough().safeParse(payload);
  if (!registeredClaims.success) {
    throw new OAuthAccessTokenRejectedError();
  }
  const clientId = registeredClaims.data.client_id
    ?? registeredClaims.data.azp;
  const scopes = registeredClaims.data.scope.split(/\s+/u).filter(Boolean);
  return {
    clientId: clientId ?? null,
    expiresAt: registeredClaims.data.exp,
    issuer: config.issuer,
    scopes: [...new Set(scopes)].sort(),
    subject: registeredClaims.data.sub,
  };
}

function requireOAuthScopes(
  grantedScopes: readonly string[],
  requiredScopes: readonly string[],
): void {
  const granted = new Set(grantedScopes);
  const missing: string[] = [];
  for (const requiredScope of requiredScopes) {
    if (!granted.has(requiredScope)) {
      missing.push(requiredScope);
    }
  }
  if (missing.length > 0) {
    throw new OAuthInsufficientScopeError(missing);
  }
}

function readHttpsUrl(value: string, field: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`OAuth authorization-server ${field} must use HTTPS.`);
  }
  return url;
}
