import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  createOAuthAccessTokenVerifier,
  OAuthAccessTokenRejectedError,
  OAuthConfigurationVerificationError,
  OAuthInsufficientScopeError,
  verifyOAuthAuthorizationServerConfiguration,
} from "../src/oauth/access-token.js";

const issuer = "https://identity.example.com/oidc";
const resource = "https://citeloom.example.com/api";
const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
const jwksUrl = "https://identity.example.com/oidc/jwks";
const keyId = "oauth-access-token-test-key";

let privateKey: CryptoKey;
let publicJwk: JWK;
let otherPrivateKey: CryptoKey;

beforeAll(async () => {
  const signingKeys = await generateKeyPair("RS256");
  privateKey = signingKeys.privateKey;
  publicJwk = {
    ...await exportJWK(signingKeys.publicKey),
    alg: "RS256",
    kid: keyId,
    use: "sig",
  };
  otherPrivateKey = (await generateKeyPair("RS256")).privateKey;
});

describe("OAuth access-token verifier", () => {
  it("verifies signatures and normalizes the authenticated identity", async () => {
    const provider = createOAuthProviderFetch();
    const verifier = createOAuthAccessTokenVerifier(
      { issuer, resource },
      provider,
    );
    const token = await signAccessToken({
      clientId: "browser-client",
      scopes: "citeloom.write citeloom.read citeloom.read",
    });

    await expect(verifier.verify(
      `bearer ${token}`,
      ["citeloom.read"],
    )).resolves.toMatchObject({
      clientId: "browser-client",
      issuer,
      scopes: ["citeloom.read", "citeloom.write"],
      subject: "external-user",
    });
    expect(provider).toHaveBeenCalledWith(
      expect.objectContaining({ href: discoveryUrl }),
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("accepts azp as the client identity when client_id is absent", async () => {
    const verifier = createOAuthAccessTokenVerifier(
      { issuer, resource },
      createOAuthProviderFetch(),
    );
    const token = await signAccessToken({ authorizedParty: "native-client" });

    await expect(verifier.verify(`Bearer ${token}`)).resolves.toMatchObject({
      clientId: "native-client",
    });
  });

  it("rejects invalid signatures, issuer, audience, and expiry", async () => {
    const invalidTokens = [
      await signAccessToken({ signingKey: otherPrivateKey }),
      await signAccessToken({ tokenIssuer: "https://other.example.com" }),
      await signAccessToken({ audience: "https://other.example.com/api" }),
      await signAccessToken({ expiresAt: Math.floor(Date.now() / 1_000) - 60 }),
    ];

    for (const token of invalidTokens) {
      const verifier = createOAuthAccessTokenVerifier(
        { issuer, resource },
        createOAuthProviderFetch(),
      );
      await expect(verifier.verify(`Bearer ${token}`)).rejects.toBeInstanceOf(
        OAuthAccessTokenRejectedError,
      );
    }
  });

  it("reports missing required scopes separately from invalid tokens", async () => {
    const verifier = createOAuthAccessTokenVerifier(
      { issuer, resource },
      createOAuthProviderFetch(),
    );
    const token = await signAccessToken({ scopes: "citeloom.read" });

    await expect(verifier.verify(
      `Bearer ${token}`,
      ["citeloom.write"],
    )).rejects.toMatchObject({
      requiredScopes: ["citeloom.write"],
    });
    await expect(verifier.verify(
      `Bearer ${token}`,
      ["citeloom.write"],
    )).rejects.toBeInstanceOf(OAuthInsufficientScopeError);
  });

  it("rejects discovery metadata for another issuer", async () => {
    const provider = createOAuthProviderFetch({
      metadataIssuer: "https://other.example.com",
    });

    await expect(verifyOAuthAuthorizationServerConfiguration(
      { issuer, resource },
      provider,
    )).rejects.toBeInstanceOf(OAuthConfigurationVerificationError);
  });

  it("retries discovery after a temporary failure", async () => {
    let discoveryAttempts = 0;
    const provider = createOAuthProviderFetch({
      onDiscovery: () => {
        discoveryAttempts += 1;
        if (discoveryAttempts === 1) {
          return new Response(null, { status: 503 });
        }
        return null;
      },
    });
    const verifier = createOAuthAccessTokenVerifier(
      { issuer, resource },
      provider,
    );
    const token = await signAccessToken({});

    await expect(verifier.verify(`Bearer ${token}`)).rejects.toThrow(
      "OAuth authorization-server discovery failed with status 503.",
    );
    await expect(verifier.verify(`Bearer ${token}`)).resolves.toMatchObject({
      subject: "external-user",
    });
    expect(discoveryAttempts).toBe(2);
  });
});

interface OAuthProviderFetchOptions {
  metadataIssuer?: string;
  onDiscovery?: () => Response | null;
}

function createOAuthProviderFetch(
  options: OAuthProviderFetchOptions = {},
): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url === discoveryUrl) {
      const override = options.onDiscovery?.();
      if (override !== null && override !== undefined) {
        return override;
      }
      return Response.json({
        issuer: options.metadataIssuer ?? issuer,
        jwks_uri: jwksUrl,
      });
    }
    if (url === jwksUrl) {
      return Response.json({ keys: [publicJwk] });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

interface SignAccessTokenOptions {
  audience?: string;
  authorizedParty?: string;
  clientId?: string;
  expiresAt?: number;
  scopes?: string;
  signingKey?: CryptoKey;
  tokenIssuer?: string;
}

async function signAccessToken(
  options: SignAccessTokenOptions,
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const claims: Record<string, string> = {
    scope: options.scopes ?? "citeloom.read",
  };
  if (options.clientId !== undefined) {
    claims.client_id = options.clientId;
  }
  if (options.authorizedParty !== undefined) {
    claims.azp = options.authorizedParty;
  }
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: keyId })
    .setIssuer(options.tokenIssuer ?? issuer)
    .setAudience(options.audience ?? resource)
    .setSubject("external-user")
    .setIssuedAt(now)
    .setExpirationTime(options.expiresAt ?? now + 600)
    .sign(options.signingKey ?? privateKey);
}
