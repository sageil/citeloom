import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  signShareToken,
  verifyShareToken,
} from "../src/shared/share-token.js";

const secret = randomBytes(32);
const answerId = "01933b52-7c1a-7dd0-8f4e-2f9d1a6b3c10";
const expiresAt = 1_900_000_000_000;

describe("share tokens", () => {
  it("round-trips a genuine token to the exact answerId and expiry", () => {
    const token = signShareToken(secret, answerId, expiresAt);
    expect(verifyShareToken(secret, token, expiresAt - 1)).toEqual({
      answerId,
      expiresAt,
    });
  });

  it("accepts a token at the instant just before expiry and refuses at expiry", () => {
    const token = signShareToken(secret, answerId, expiresAt);
    expect(verifyShareToken(secret, token, expiresAt - 1)).not.toBeNull();
    expect(verifyShareToken(secret, token, expiresAt)).toBeNull();
  });

  it("refuses a token signed with a different secret", () => {
    const token = signShareToken(secret, answerId, expiresAt);
    expect(verifyShareToken(randomBytes(32), token, expiresAt - 1)).toBeNull();
  });

  it("refuses a token whose payload was altered, even with a valid signature for the altered payload", () => {
    const token = signShareToken(secret, answerId, expiresAt);
    const dotIndex = token.indexOf(".");
    const payload = token.slice(0, dotIndex);
    const signature = token.slice(dotIndex + 1);
    const payloadBuffer = Buffer.from(payload, "base64url");
    const lastByte = payloadBuffer.length - 1;
    payloadBuffer[lastByte] = Number(payloadBuffer[lastByte]) ^ 0x01;
    const tamperedPayload = payloadBuffer.toString("base64url");
    expect(
      verifyShareToken(secret, `${tamperedPayload}.${signature}`, expiresAt - 1),
    ).toBeNull();
  });

  it("refuses a token with any signature character changed", () => {
    const token = signShareToken(secret, answerId, expiresAt);
    const [payload, signature] = token.split(".") as [string, string];
    const last = signature.at(-1)!;
    const replacement = last === "A" ? "B" : "A";
    expect(
      verifyShareToken(
        secret,
        `${payload}.${signature.slice(0, -1)}${replacement}`,
        expiresAt - 1,
      ),
    ).toBeNull();
  });

  it("refuses a truncated token", () => {
    const token = signShareToken(secret, answerId, expiresAt);
    expect(verifyShareToken(secret, token.slice(0, -1), expiresAt - 1))
      .toBeNull();
    expect(
      verifyShareToken(
        secret,
        token.slice(0, Math.floor(token.length / 2)),
        expiresAt - 1,
      ),
    ).toBeNull();
  });

  it("refuses a token with no signature or an empty one", () => {
    const token = signShareToken(secret, answerId, expiresAt);
    const [payload, signature] = token.split(".");
    expect(verifyShareToken(secret, payload!, expiresAt - 1)).toBeNull();
    expect(verifyShareToken(secret, `${payload}.`, expiresAt - 1)).toBeNull();
    expect(signature!.length).toBeGreaterThan(0);  });

  it("refuses malformed input without a dot separator", () => {
    expect(verifyShareToken(secret, "", expiresAt - 1)).toBeNull();
    expect(verifyShareToken(secret, "not-a-token", expiresAt - 1)).toBeNull();
  });

  it("round-trips a token containing unicode answerIds and large expiries", () => {
    const unicodeAnswerId = "answer-π-✔-id";
    const token = signShareToken(
      secret,
      unicodeAnswerId,
      Number.MAX_SAFE_INTEGER,
    );
    expect(
      verifyShareToken(secret, token, Number.MAX_SAFE_INTEGER - 1),
    ).toEqual({ answerId: unicodeAnswerId, expiresAt: Number.MAX_SAFE_INTEGER });
  });
});
