import { createHash } from "node:crypto";

import { z } from "zod";

export const OPENAI_CODEX_AUTH_BASE_URL = "https://auth.openai.com";
export const OPENAI_CODEX_BACKEND_BASE_URL =
  "https://chatgpt.com/backend-api/codex";
export const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_CODEX_DEVICE_VERIFICATION_URL =
  `${OPENAI_CODEX_AUTH_BASE_URL}/codex/device`;
export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

const DEVICE_AUTHORIZATION_LIFETIME_MS = 15 * 60 * 1_000;
const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5;

const deviceAuthorizationResponseSchema = z.object({
  device_auth_id: z.string().trim().min(1),
  interval: z.union([
    z.number().int().positive(),
    z.string().trim().regex(/^[1-9][0-9]*$/u).transform(Number),
  ]).optional(),
  user_code: z.string().trim().min(1).optional(),
  usercode: z.string().trim().min(1).optional(),
}).loose();

const deviceAuthorizationCodeSchema = z.object({
  authorization_code: z.string().trim().min(1),
  code_challenge: z.string().trim().min(1),
  code_verifier: z.string().trim().min(1),
}).loose();

const tokenResponseSchema = z.object({
  access_token: z.string().trim().min(1),
  expires_in: z.number().int().positive().optional(),
  id_token: z.string().trim().min(1).optional(),
  refresh_token: z.string().trim().min(1).optional(),
}).loose();

const oauthErrorSchema = z.object({
  error: z.string().trim().min(1).max(200).optional(),
  error_description: z.string().trim().min(1).max(500).optional(),
}).loose();

const jwtClaimsSchema = z.object({
  chatgpt_account_id: z.string().trim().min(1).optional(),
  exp: z.number().int().positive().optional(),
  organizations: z.array(z.object({
    id: z.string().trim().min(1).optional(),
  }).loose()).optional(),
  "https://api.openai.com/auth": z.object({
    chatgpt_account_id: z.string().trim().min(1).optional(),
  }).loose().optional(),
}).loose();

export interface OpenAICodexDeviceAuthorization {
  deviceAuthId: string;
  expiresAt: Date;
  intervalSeconds: number;
  userCode: string;
  verificationUrl: string;
}

export interface OpenAICodexDeviceAuthorizationCode {
  authorizationCode: string;
  codeVerifier: string;
}

export interface OpenAICodexOAuthCredentials {
  accessToken: string;
  accountId: string;
  expiresAt: Date;
  refreshToken: string;
}

export type OpenAICodexDevicePollResult =
  | { state: "pending" }
  | {
    authorization: OpenAICodexDeviceAuthorizationCode;
    state: "authorized";
  };

export interface OpenAICodexOAuthRequestOptions {
  fetch?: typeof fetch;
  now?: () => Date;
  signal?: AbortSignal;
}

export class OpenAICodexOAuthError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number | null,
    public readonly reauthenticationRequired = false,
  ) {
    super(message);
    this.name = "OpenAICodexOAuthError";
  }
}

export async function requestOpenAICodexDeviceAuthorization(
  options: OpenAICodexOAuthRequestOptions = {},
): Promise<OpenAICodexDeviceAuthorization> {
  const requestFetch = options.fetch ?? fetch;
  const now = options.now?.() ?? new Date();
  const response = await requestFetch(
    `${OPENAI_CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`,
    buildOAuthPostRequest(
      JSON.stringify({ client_id: OPENAI_CODEX_CLIENT_ID }),
      "application/json",
      options.signal,
    ),
  );
  if (!response.ok) {
    throw await readOpenAICodexOAuthFailure(
      response,
      "OpenAI Codex device sign-in could not be started.",
    );
  }
  const value: unknown = await response.json();
  const decoded = deviceAuthorizationResponseSchema.safeParse(value);
  if (!decoded.success) {
    throw new OpenAICodexOAuthError(
      "OpenAI Codex returned an invalid device authorization response.",
      response.status,
    );
  }
  const userCode = decoded.data.user_code ?? decoded.data.usercode;
  if (userCode === undefined) {
    throw new OpenAICodexOAuthError(
      "OpenAI Codex did not return a device authorization code.",
      response.status,
    );
  }
  return {
    deviceAuthId: decoded.data.device_auth_id,
    expiresAt: new Date(now.getTime() + DEVICE_AUTHORIZATION_LIFETIME_MS),
    intervalSeconds:
      decoded.data.interval ?? DEFAULT_DEVICE_POLL_INTERVAL_SECONDS,
    userCode,
    verificationUrl: OPENAI_CODEX_DEVICE_VERIFICATION_URL,
  };
}

export async function pollOpenAICodexDeviceAuthorization(
  authorization: OpenAICodexDeviceAuthorization,
  options: OpenAICodexOAuthRequestOptions = {},
): Promise<OpenAICodexDevicePollResult> {
  const requestFetch = options.fetch ?? fetch;
  const response = await requestFetch(
    `${OPENAI_CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`,
    buildOAuthPostRequest(
      JSON.stringify({
        device_auth_id: authorization.deviceAuthId,
        user_code: authorization.userCode,
      }),
      "application/json",
      options.signal,
    ),
  );
  if (response.status === 403 || response.status === 404) {
    return { state: "pending" };
  }
  if (!response.ok) {
    throw await readOpenAICodexOAuthFailure(
      response,
      "OpenAI Codex device authorization failed.",
    );
  }
  const value: unknown = await response.json();
  const decoded = deviceAuthorizationCodeSchema.safeParse(value);
  if (!decoded.success) {
    throw new OpenAICodexOAuthError(
      "OpenAI Codex returned an invalid device authorization result.",
      response.status,
    );
  }
  verifyCodeChallenge(
    decoded.data.code_verifier,
    decoded.data.code_challenge,
  );
  return {
    authorization: {
      authorizationCode: decoded.data.authorization_code,
      codeVerifier: decoded.data.code_verifier,
    },
    state: "authorized",
  };
}

export async function exchangeOpenAICodexDeviceAuthorization(
  authorization: OpenAICodexDeviceAuthorizationCode,
  options: OpenAICodexOAuthRequestOptions = {},
): Promise<OpenAICodexOAuthCredentials> {
  const form = new URLSearchParams({
    client_id: OPENAI_CODEX_CLIENT_ID,
    code: authorization.authorizationCode,
    code_verifier: authorization.codeVerifier,
    grant_type: "authorization_code",
    redirect_uri: `${OPENAI_CODEX_AUTH_BASE_URL}/deviceauth/callback`,
  });
  const response = await requestOpenAICodexToken(
    form,
    "application/x-www-form-urlencoded",
    null,
    options,
  );
  if (response.refreshToken === null) {
    throw new OpenAICodexOAuthError(
      "OpenAI Codex did not return a refresh token.",
      200,
    );
  }
  return {
    accessToken: response.accessToken,
    accountId: response.accountId,
    expiresAt: response.expiresAt,
    refreshToken: response.refreshToken,
  };
}

export async function refreshOpenAICodexCredentials(
  current: OpenAICodexOAuthCredentials,
  options: OpenAICodexOAuthRequestOptions = {},
): Promise<OpenAICodexOAuthCredentials> {
  const body = JSON.stringify({
    client_id: OPENAI_CODEX_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
  });
  const response = await requestOpenAICodexToken(
    body,
    "application/json",
    current.accountId,
    options,
  );
  return {
    accessToken: response.accessToken,
    accountId: response.accountId,
    expiresAt: response.expiresAt,
    refreshToken: response.refreshToken ?? current.refreshToken,
  };
}

interface DecodedTokenResponse {
  accessToken: string;
  accountId: string;
  expiresAt: Date;
  refreshToken: string | null;
}

async function requestOpenAICodexToken(
  body: Exclude<RequestInit["body"], null | undefined>,
  contentType: string,
  expectedAccountId: string | null,
  options: OpenAICodexOAuthRequestOptions,
): Promise<DecodedTokenResponse> {
  const requestFetch = options.fetch ?? fetch;
  const response = await requestFetch(
    `${OPENAI_CODEX_AUTH_BASE_URL}/oauth/token`,
    buildOAuthPostRequest(
      body,
      contentType,
      options.signal,
    ),
  );
  if (!response.ok) {
    throw await readOpenAICodexOAuthFailure(
      response,
      "OpenAI Codex token exchange failed.",
    );
  }
  const value: unknown = await response.json();
  const decoded = tokenResponseSchema.safeParse(value);
  if (!decoded.success) {
    throw new OpenAICodexOAuthError(
      "OpenAI Codex returned an invalid token response.",
      response.status,
    );
  }
  const tokenAccountId = readAccountId(
    decoded.data.id_token,
    decoded.data.access_token,
  );
  if (
    expectedAccountId !== null
    && tokenAccountId !== null
    && tokenAccountId !== expectedAccountId
  ) {
    throw new OpenAICodexOAuthError(
      "OpenAI Codex refreshed credentials for a different ChatGPT account. Sign in again.",
      response.status,
      true,
    );
  }
  const accountId = tokenAccountId ?? expectedAccountId;
  if (accountId === null) {
    throw new OpenAICodexOAuthError(
      "OpenAI Codex did not identify the ChatGPT account.",
      response.status,
    );
  }
  const now = options.now?.() ?? new Date();
  const expiresAt = readTokenExpiry(
    decoded.data.access_token,
    decoded.data.expires_in,
    now,
  );
  if (expiresAt === null) {
    throw new OpenAICodexOAuthError(
      "OpenAI Codex did not provide a valid access-token expiry.",
      response.status,
    );
  }
  return {
    accessToken: decoded.data.access_token,
    accountId,
    expiresAt,
    refreshToken: decoded.data.refresh_token ?? null,
  };
}

function buildOAuthPostRequest(
  body: Exclude<RequestInit["body"], null | undefined>,
  contentType: string,
  signal: AbortSignal | undefined,
): RequestInit {
  const request: RequestInit = {
    body,
    headers: { "content-type": contentType },
    method: "POST",
  };
  if (signal !== undefined) {
    request.signal = signal;
  }
  return request;
}

function verifyCodeChallenge(codeVerifier: string, codeChallenge: string): void {
  const actual = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  if (actual !== codeChallenge) {
    throw new OpenAICodexOAuthError(
      "OpenAI Codex returned an invalid device authorization verifier.",
      200,
    );
  }
}

function readAccountId(
  idToken: string | undefined,
  accessToken: string,
): string | null {
  const idClaims = idToken === undefined ? null : readJwtClaims(idToken);
  const idAccount = readAccountIdFromClaims(idClaims);
  if (idAccount !== null) {
    return idAccount;
  }
  return readAccountIdFromClaims(readJwtClaims(accessToken));
}

function readAccountIdFromClaims(
  claims: z.output<typeof jwtClaimsSchema> | null,
): string | null {
  if (claims === null) {
    return null;
  }
  if (claims.chatgpt_account_id !== undefined) {
    return claims.chatgpt_account_id;
  }
  const authAccount =
    claims["https://api.openai.com/auth"]?.chatgpt_account_id;
  if (authAccount !== undefined) {
    return authAccount;
  }
  const firstOrganization = claims.organizations?.[0];
  return firstOrganization?.id ?? null;
}

function readTokenExpiry(
  accessToken: string,
  expiresIn: number | undefined,
  now: Date,
): Date | null {
  if (expiresIn !== undefined) {
    return new Date(now.getTime() + expiresIn * 1_000);
  }
  const claims = readJwtClaims(accessToken);
  if (claims?.exp === undefined) {
    return null;
  }
  const expiresAt = new Date(claims.exp * 1_000);
  return Number.isNaN(expiresAt.getTime()) ? null : expiresAt;
}

function readJwtClaims(
  token: string,
): z.output<typeof jwtClaimsSchema> | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[1] === undefined || parts[1] === "") {
    return null;
  }
  try {
    const value: unknown = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    const decoded = jwtClaimsSchema.safeParse(value);
    return decoded.success ? decoded.data : null;
  } catch {
    return null;
  }
}

async function readOpenAICodexOAuthFailure(
  response: Response,
  fallback: string,
): Promise<OpenAICodexOAuthError> {
  let detail = "";
  try {
    const value: unknown = await response.json();
    const decoded = oauthErrorSchema.safeParse(value);
    if (decoded.success) {
      detail = decoded.data.error_description
        ?? decoded.data.error
        ?? "";
    }
  } catch {
    detail = "";
  }
  const message = detail === "" ? fallback : `${fallback} ${detail}`;
  return new OpenAICodexOAuthError(message, response.status);
}
