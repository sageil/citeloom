import { describe, expect, it } from "vitest";

import {
  decodeBootstrapAdministratorInput,
  decodeLoginInput,
  normalizeUserIdentity,
} from "../src/auth/boundary.js";
import {
  hashPassword,
  PasswordValidationError,
  readPassword,
  verifyPassword,
} from "../src/auth/password.js";
import { createOpaqueToken, digestOpaqueToken } from "../src/auth/token.js";
import {
  LoginRateLimiter,
  LoginRateLimitExceededError,
} from "../src/auth/rate-limit.js";

describe("authentication boundaries", () => {
  it("normalizes usernames once at the input boundary", () => {
    expect(normalizeUserIdentity({
      displayName: "  Sage User  ",
      username: "  Sage.User  ",
    })).toEqual({
      displayName: "Sage User",
      username: "Sage.User",
      usernameNormalized: "sage.user",
    });
  });

  it("rejects unsafe usernames and workspace slugs", () => {
    expect(() => normalizeUserIdentity({
      displayName: "Sage",
      username: "sage user",
    })).toThrow();
    expect(() => decodeBootstrapAdministratorInput({
      displayName: "Sage",
      username: "sage",
      workspaceName: "CiteLoom",
      workspaceSlug: "Cite Loom",
    })).toThrow();
  });

  it("decodes login input without applying password setup policy", () => {
    expect(decodeLoginInput({
      password: "short existing password",
      remember: true,
      username: "Admin",
    })).toEqual({
      password: "short existing password",
      remember: true,
      usernameNormalized: "admin",
    });
  });
});

describe("password credentials", () => {
  it("hashes and verifies passwords with Argon2id", async () => {
    const password = "a long private passphrase";
    const passwordHash = await hashPassword(password);

    expect(passwordHash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(passwordHash, password)).resolves.toBe(true);
    await expect(verifyPassword(passwordHash, "a different passphrase")).resolves.toBe(false);
  });

  it("rejects passwords below the setup minimum", () => {
    expect(() => readPassword("too short")).toThrow(PasswordValidationError);
  });

  it("rejects oversized password input before hashing", () => {
    expect(() => readPassword("🧶".repeat(1_025))).toThrow(PasswordValidationError);
  });
});

describe("opaque authentication tokens", () => {
  it("generates random tokens and stores only deterministic digests", () => {
    const firstToken = createOpaqueToken();
    const secondToken = createOpaqueToken();

    expect(firstToken).not.toBe(secondToken);
    expect(digestOpaqueToken(firstToken)).toMatch(/^[a-f0-9]{64}$/);
    expect(digestOpaqueToken(firstToken)).toBe(digestOpaqueToken(firstToken));
    expect(digestOpaqueToken(firstToken)).not.toBe(digestOpaqueToken(secondToken));
  });
});

describe("login throttling", () => {
  it("limits attempts independently by source and normalized username", () => {
    let now = 1_000;
    const limiter = new LoginRateLimiter(() => now);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      limiter.check(`192.0.2.${attempt}`, "admin");
      limiter.recordFailure(`192.0.2.${attempt}`, "admin");
    }
    expect(() => limiter.check("192.0.2.99", "admin")).toThrow(
      LoginRateLimitExceededError,
    );

    now += 15 * 60 * 1_000;
    expect(() => limiter.check("192.0.2.99", "admin")).not.toThrow();
  });

  it("clears the username bucket but retains source-wide failures", () => {
    const limiter = new LoginRateLimiter();
    limiter.recordFailure("192.0.2.1", "admin");
    limiter.recordSuccess("admin");
    for (let attempt = 0; attempt < 4; attempt += 1) {
      limiter.recordFailure("192.0.2.1", `other-${attempt}`);
    }
    expect(() => limiter.check("192.0.2.1", "admin")).toThrow(
      LoginRateLimitExceededError,
    );
    expect(() => limiter.check("192.0.2.2", "admin")).not.toThrow();
  });
});
