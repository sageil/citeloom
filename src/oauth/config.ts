import { z } from "zod";

const httpsUrlSchema = z.url().max(2_048).refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:";
}, "must use https");
const claimNameSchema = z.string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_.:-]*$/,
    "must be a valid JWT claim name",
  );
const scopeSchema = z.string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[\x21\x23-\x5B\x5D-\x7E]+$/,
    "must be a valid OAuth scope value",
  );
const oauthConfigurationValuesSchema = z.object({
  issuer: httpsUrlSchema,
  resource: httpsUrlSchema,
  scopes: z.array(scopeSchema).min(1).max(100),
  workspaceClaim: claimNameSchema,
}).strict();
const storedOAuthResourceSettingsSchema = z.object({
  enabled: z.boolean(),
  issuer: z.string().nullable(),
  resource: z.string().nullable(),
  scopes: z.array(z.string()),
  updatedAt: z.date(),
  version: z.number().int().positive(),
  workspaceClaim: z.string().nullable(),
}).strict();

export interface DisabledOAuthConfig {
  enabled: false;
}

export interface EnabledOAuthConfig {
  enabled: true;
  issuer: string;
  resource: string;
  scopes: string[];
  workspaceClaim: string;
}

export type OAuthConfig = DisabledOAuthConfig | EnabledOAuthConfig;

export class OAuthConfigurationValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OAuthConfigurationValidationError";
  }
}

export interface UnconfiguredOAuthResourceSettings {
  enabled: false;
  issuer: null;
  resource: null;
  scopes: [];
  status: "unconfigured";
  updatedAt: string | null;
  version: number;
  workspaceClaim: null;
}

export interface ConfiguredOAuthResourceSettings {
  enabled: boolean;
  issuer: string;
  resource: string;
  scopes: string[];
  status: "disabled" | "enabled" | "invalid_origin";
  updatedAt: string;
  version: number;
  workspaceClaim: string;
}

export type OAuthResourceSettings =
  | ConfiguredOAuthResourceSettings
  | UnconfiguredOAuthResourceSettings;

export interface OAuthConfigurationValues {
  issuer: string;
  resource: string;
  scopes: string[];
  workspaceClaim: string;
}

export function parseOAuthConfigurationValues(
  input: unknown,
  publicOrigin: string,
): OAuthConfigurationValues {
  const configuration = normalizeOAuthConfigurationValues(input);
  if (new URL(configuration.resource).origin !== new URL(publicOrigin).origin) {
    throw new OAuthConfigurationValidationError(
      "The OAuth resource must use the configured CiteLoom public origin.",
    );
  }
  return configuration;
}

function normalizeOAuthConfigurationValues(
  input: unknown,
): OAuthConfigurationValues {
  const parsed = oauthConfigurationValuesSchema.parse(input);
  const issuer = readOAuthUri(parsed.issuer, "issuer");
  const resource = readOAuthUri(parsed.resource, "resource");
  return {
    issuer,
    resource,
    scopes: [...new Set(parsed.scopes)].sort(),
    workspaceClaim: parsed.workspaceClaim,
  };
}

export function readStoredOAuthResourceSettings(
  row: unknown | undefined,
  publicOrigin: string,
): OAuthResourceSettings {
  if (row === undefined) {
    return {
      enabled: false,
      issuer: null,
      resource: null,
      scopes: [],
      status: "unconfigured",
      updatedAt: null,
      version: 1,
      workspaceClaim: null,
    };
  }
  const stored = storedOAuthResourceSettingsSchema.parse(row);
  const hasNoConfiguration = stored.issuer === null
    && stored.resource === null
    && stored.scopes.length === 0
    && stored.workspaceClaim === null;
  if (hasNoConfiguration && !stored.enabled) {
    return {
      enabled: false,
      issuer: null,
      resource: null,
      scopes: [],
      status: "unconfigured",
      updatedAt: stored.updatedAt.toISOString(),
      version: stored.version,
      workspaceClaim: null,
    };
  }
  const configuration = normalizeOAuthConfigurationValues({
    issuer: stored.issuer,
    resource: stored.resource,
    scopes: stored.scopes,
    workspaceClaim: stored.workspaceClaim,
  });
  return {
    ...configuration,
    enabled: stored.enabled,
    status: readOAuthResourceStatus(
      stored.enabled,
      configuration.resource,
      publicOrigin,
    ),
    updatedAt: stored.updatedAt.toISOString(),
    version: stored.version,
  };
}

export function readEnabledOAuthConfig(
  settings: OAuthResourceSettings,
): OAuthConfig {
  if (settings.status !== "enabled") {
    return { enabled: false };
  }
  return {
    enabled: true,
    issuer: settings.issuer,
    resource: settings.resource,
    scopes: [...settings.scopes],
    workspaceClaim: settings.workspaceClaim,
  };
}

function readOAuthResourceStatus(
  enabled: boolean,
  resource: string,
  publicOrigin: string,
): ConfiguredOAuthResourceSettings["status"] {
  if (!enabled) {
    return "disabled";
  }
  if (new URL(resource).origin !== new URL(publicOrigin).origin) {
    return "invalid_origin";
  }
  return "enabled";
}

function readOAuthUri(value: string, field: "issuer" | "resource"): string {
  const url = new URL(value);
  if (
    url.username !== ""
    || url.password !== ""
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new OAuthConfigurationValidationError(
      `The OAuth ${field} must not contain credentials, a query, or a fragment.`,
    );
  }
  return value;
}
