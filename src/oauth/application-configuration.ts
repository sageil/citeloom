import { z } from "zod";

export const OAUTH_API_RESOURCE_PATH = "/api";
export const OAUTH_BROWSER_CALLBACK_PATH = "/oauth/callback";
export const OAUTH_BROWSER_POST_LOGOUT_PATH = "/login";
export const OAUTH_MCP_RESOURCE_PATH = "/mcp";

const oauthScopeSchema = z.string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[\x21\x23-\x5B\x5D-\x7E]+$/,
    "must be a valid OAuth scope value",
  );

const oauthApplicationConfigurationSchema = z.object({
  apiScopes: z.array(oauthScopeSchema).min(1).max(100),
  browserClientId: z.string().trim().min(1).max(1_024),
  browserScopes: z.array(oauthScopeSchema).min(1).max(100),
  issuer: z.url().max(2_048),
  mcpScopes: z.array(oauthScopeSchema).min(1).max(100),
}).strict();

const storedOAuthApplicationConfigurationSchema = z.object({
  apiScopes: z.array(z.string()),
  browserClientId: z.string(),
  browserScopes: z.array(z.string()),
  issuer: z.string(),
  mcpScopes: z.array(z.string()),
  schemaVersion: z.literal(1),
}).strict();

export interface OAuthApplicationConfigurationInput {
  apiScopes: string[];
  browserClientId: string;
  browserScopes: string[];
  issuer: string;
  mcpScopes: string[];
}

export interface OAuthApplicationConfigurationStageInput {
  configuration: StoredOAuthApplicationConfiguration;
  expectedVersion: number;
}

export interface HostRecoveryConfigurationInput {
  enabled: boolean;
  expectedVersion: number;
}

export interface StoredOAuthApplicationConfiguration
  extends OAuthApplicationConfigurationInput {
  schemaVersion: 1;
}

export interface EffectiveOAuthApplicationConfiguration
  extends OAuthApplicationConfigurationInput {
  apiResource: string;
  browserCallbackUri: string;
  browserPostLogoutRedirectUri: string;
  mcpResource: string;
}

export class OAuthApplicationConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OAuthApplicationConfigurationError";
  }
}

export function parseOAuthApplicationConfiguration(
  input: unknown,
): StoredOAuthApplicationConfiguration {
  const parsed = oauthApplicationConfigurationSchema.parse(input);
  const issuer = readOAuthIssuer(parsed.issuer);
  const apiScopes = normalizeScopes(parsed.apiScopes);
  const browserScopes = normalizeScopes(parsed.browserScopes);
  if (!browserScopes.includes("openid")) {
    throw new OAuthApplicationConfigurationError(
      "The browser OAuth scopes must include openid.",
    );
  }
  const missingApiScopes = apiScopes.filter((scope) => {
    return !browserScopes.includes(scope);
  });
  if (missingApiScopes.length > 0) {
    throw new OAuthApplicationConfigurationError(
      "The browser authorization scopes must include every required API scope.",
    );
  }
  return {
    apiScopes,
    browserClientId: parsed.browserClientId,
    browserScopes,
    issuer,
    mcpScopes: normalizeScopes(parsed.mcpScopes),
    schemaVersion: 1,
  };
}

export function decodeOAuthApplicationConfigurationStageInput(
  input: unknown,
): OAuthApplicationConfigurationStageInput {
  const request = z.object({
    apiScopes: z.unknown(),
    browserClientId: z.unknown(),
    browserScopes: z.unknown(),
    expectedVersion: z.number().int().positive(),
    issuer: z.unknown(),
    mcpScopes: z.unknown(),
  }).strict().parse(input);
  const configuration = parseOAuthApplicationConfiguration({
    apiScopes: request.apiScopes,
    browserClientId: request.browserClientId,
    browserScopes: request.browserScopes,
    issuer: request.issuer,
    mcpScopes: request.mcpScopes,
  });
  return { configuration, expectedVersion: request.expectedVersion };
}

export function decodeOAuthApplicationActivationInput(input: unknown): number {
  return z.object({
    expectedVersion: z.number().int().positive(),
  }).strict().parse(input).expectedVersion;
}

export function decodeHostRecoveryConfigurationInput(
  input: unknown,
): HostRecoveryConfigurationInput {
  return z.object({
    enabled: z.boolean(),
    expectedVersion: z.number().int().positive(),
  }).strict().parse(input);
}

export function readStoredOAuthApplicationConfiguration(
  input: unknown,
): StoredOAuthApplicationConfiguration {
  const stored = storedOAuthApplicationConfigurationSchema.parse(input);
  return parseOAuthApplicationConfiguration({
    apiScopes: stored.apiScopes,
    browserClientId: stored.browserClientId,
    browserScopes: stored.browserScopes,
    issuer: stored.issuer,
    mcpScopes: stored.mcpScopes,
  });
}

export function buildEffectiveOAuthApplicationConfiguration(
  stored: StoredOAuthApplicationConfiguration,
  publicOrigin: string,
): EffectiveOAuthApplicationConfiguration {
  const normalizedOrigin = readPublicOrigin(publicOrigin);
  return {
    apiScopes: [...stored.apiScopes],
    browserClientId: stored.browserClientId,
    browserScopes: [...stored.browserScopes],
    issuer: stored.issuer,
    mcpScopes: [...stored.mcpScopes],
    apiResource: buildPublicUri(normalizedOrigin, OAUTH_API_RESOURCE_PATH),
    browserCallbackUri: buildPublicUri(
      normalizedOrigin,
      OAUTH_BROWSER_CALLBACK_PATH,
    ),
    browserPostLogoutRedirectUri: buildPublicUri(
      normalizedOrigin,
      OAUTH_BROWSER_POST_LOGOUT_PATH,
    ),
    mcpResource: buildPublicUri(normalizedOrigin, OAUTH_MCP_RESOURCE_PATH),
  };
}

export function requireSecureOAuthPublicOrigin(value: string): string {
  const publicOrigin = readPublicOrigin(value);
  if (new URL(publicOrigin).protocol !== "https:") {
    throw new OAuthApplicationConfigurationError(
      "The CiteLoom public origin must use HTTPS before OAuth can be configured.",
    );
  }
  return publicOrigin;
}

function normalizeScopes(scopes: readonly string[]): string[] {
  return [...new Set(scopes)].sort();
}

function readOAuthIssuer(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new OAuthApplicationConfigurationError(
      "The OAuth issuer must use HTTPS.",
    );
  }
  if (
    url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new OAuthApplicationConfigurationError(
      "The OAuth issuer must not contain credentials, a query, or a fragment.",
    );
  }
  return value;
}

function readPublicOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OAuthApplicationConfigurationError(
      "The CiteLoom public origin must use HTTP or HTTPS.",
    );
  }
  if (
    url.username !== ""
    || url.password !== ""
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new OAuthApplicationConfigurationError(
      "The CiteLoom public origin must not contain credentials, a path, a query, or a fragment.",
    );
  }
  return url.origin;
}

function buildPublicUri(publicOrigin: string, pathname: string): string {
  return new URL(pathname, publicOrigin).toString();
}
