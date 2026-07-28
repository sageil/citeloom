import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  exchangeOpenAICodexDeviceAuthorization,
  OPENAI_CODEX_CLIENT_ID,
  pollOpenAICodexDeviceAuthorization,
  refreshOpenAICodexCredentials,
  requestOpenAICodexDeviceAuthorization,
  type OpenAICodexDeviceAuthorization,
} from "../src/providers/openai-codex-oauth.js";

describe("OpenAI Codex device OAuth", () => {
  it("starts a device flow without an API key", async () => {
    const requestFetch = vi.fn((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe(
        "https://auth.openai.com/api/accounts/deviceauth/usercode",
      );
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        client_id: OPENAI_CODEX_CLIENT_ID,
      });
      return Promise.resolve(Response.json({
        device_auth_id: "device-auth",
        interval: 3,
        user_code: "ABCD-EFGH",
      }));
    });

    const authorization = await requestOpenAICodexDeviceAuthorization({
      fetch: requestFetch,
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });

    expect(authorization).toEqual({
      deviceAuthId: "device-auth",
      expiresAt: new Date("2026-07-27T12:15:00.000Z"),
      intervalSeconds: 3,
      userCode: "ABCD-EFGH",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
  });

  it("treats an unapproved device code as pending", async () => {
    const requestFetch = vi.fn(async () => {
      return new Response(null, { status: 403 });
    });

    await expect(pollOpenAICodexDeviceAuthorization(
      buildDeviceAuthorization(),
      { fetch: requestFetch },
    )).resolves.toEqual({ state: "pending" });
  });

  it("verifies PKCE before accepting an authorized device code", async () => {
    const verifier = "verified-device-code";
    const challenge = createHash("sha256")
      .update(verifier)
      .digest("base64url");
    const requestFetch = vi.fn(async () => Response.json({
      authorization_code: "authorization-code",
      code_challenge: challenge,
      code_verifier: verifier,
    }));

    await expect(pollOpenAICodexDeviceAuthorization(
      buildDeviceAuthorization(),
      { fetch: requestFetch },
    )).resolves.toEqual({
      authorization: {
        authorizationCode: "authorization-code",
        codeVerifier: verifier,
      },
      state: "authorized",
    });
  });

  it("exchanges the device code and reads the account from the ID token", async () => {
    const requestFetch = vi.fn((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe("https://auth.openai.com/oauth/token");
      expect(init?.headers).toEqual({
        "content-type": "application/x-www-form-urlencoded",
      });
      const form = new URLSearchParams(String(init?.body));
      expect(Object.fromEntries(form)).toMatchObject({
        client_id: OPENAI_CODEX_CLIENT_ID,
        code: "authorization-code",
        code_verifier: "verified-device-code",
        grant_type: "authorization_code",
        redirect_uri: "https://auth.openai.com/deviceauth/callback",
      });
      return Promise.resolve(Response.json({
        access_token: buildJwt({ exp: 1_785_155_400 }),
        expires_in: 3_600,
        id_token: buildJwt({ chatgpt_account_id: "account-123" }),
        refresh_token: "refresh-token",
      }));
    });

    const credentials = await exchangeOpenAICodexDeviceAuthorization(
      {
        authorizationCode: "authorization-code",
        codeVerifier: "verified-device-code",
      },
      {
        fetch: requestFetch,
        now: () => new Date("2026-07-27T12:00:00.000Z"),
      },
    );

    expect(credentials).toEqual({
      accessToken: buildJwt({ exp: 1_785_155_400 }),
      accountId: "account-123",
      expiresAt: new Date("2026-07-27T13:00:00.000Z"),
      refreshToken: "refresh-token",
    });
  });

  it("preserves the current refresh token when refresh rotation is omitted", async () => {
    const requestFetch = vi.fn((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      expect(String(input)).toBe("https://auth.openai.com/oauth/token");
      expect(init?.headers).toEqual({
        "content-type": "application/json",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        client_id: OPENAI_CODEX_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: "current-refresh-token",
      });
      return Promise.resolve(Response.json({
        access_token: "opaque-refreshed-access-token",
        expires_in: 3_600,
      }));
    });

    const credentials = await refreshOpenAICodexCredentials(
      {
        accessToken: "old-access",
        accountId: "account-123",
        expiresAt: new Date("2026-07-27T12:00:00.000Z"),
        refreshToken: "current-refresh-token",
      },
      {
        fetch: requestFetch,
        now: () => new Date("2026-07-27T12:00:00.000Z"),
      },
    );

    expect(credentials.refreshToken).toBe("current-refresh-token");
    expect(credentials.accountId).toBe("account-123");
  });

  it("rejects a refresh response for a different ChatGPT account", async () => {
    const requestFetch = vi.fn(async () => Response.json({
      access_token: buildJwt({
        chatgpt_account_id: "account-456",
        exp: 1_785_155_400,
      }),
      expires_in: 3_600,
    }));

    await expect(refreshOpenAICodexCredentials(
      {
        accessToken: "old-access",
        accountId: "account-123",
        expiresAt: new Date("2026-07-27T12:00:00.000Z"),
        refreshToken: "current-refresh-token",
      },
      {
        fetch: requestFetch,
        now: () => new Date("2026-07-27T12:00:00.000Z"),
      },
    )).rejects.toMatchObject({
      reauthenticationRequired: true,
    });
  });
});

function buildDeviceAuthorization(): OpenAICodexDeviceAuthorization {
  return {
    deviceAuthId: "device-auth",
    expiresAt: new Date("2026-07-27T12:15:00.000Z"),
    intervalSeconds: 3,
    userCode: "ABCD-EFGH",
    verificationUrl: "https://auth.openai.com/codex/device",
  };
}

function buildJwt(claims: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" }))
    .toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.signature`;
}
