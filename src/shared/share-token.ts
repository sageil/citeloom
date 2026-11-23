import { createHmac, timingSafeEqual } from "node:crypto";

interface ShareTokenPayload {
  answerId: string;
  expiresAt: number;
}

function encodeBase64UrlUtf8(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function signShareToken(
  secret: Buffer,
  answerId: string,
  expiresAt: number,
): string {
  const payload = encodeBase64UrlUtf8(
    JSON.stringify({ answerId, expiresAt } satisfies ShareTokenPayload),
  );
  const signature = createHmac("sha256", secret).update(payload).digest(
    "base64url",
  );
  return `${payload}.${signature}`;
}

function decodeShareToken(
  secret: Buffer,
  token: string,
): ShareTokenPayload | null {
  const separator = token.indexOf(".");
  if (separator === -1) {
    return null;
  }
  const payloadPart = token.slice(0, separator);
  const signaturePart = token.slice(separator + 1);
  if (signaturePart.length === 0) {
    return null;
  }
  let expectedSignature: Buffer;
  let payloadJson: string;
  try {
    expectedSignature = createHmac("sha256", secret).update(payloadPart).digest();
    const payloadBytes = Buffer.from(payloadPart, "base64url");
    // base64url decoding accepts absent padding; re-encode to reject altered or truncated tokens.
    if (payloadBytes.length === 0
      || payloadBytes.toString("base64url") !== payloadPart
    ) {
      return null;
    }
    payloadJson = payloadBytes.toString("utf8");
  } catch {
    return null;
  }
  const givenSignature = Buffer.from(signaturePart, "base64url");
  if (givenSignature.length === 0
    || givenSignature.toString("base64url") !== signaturePart
    || givenSignature.length !== expectedSignature.length
    || !timingSafeEqual(givenSignature, expectedSignature)
  ) {
    return null;
  }
  try {
    const payload: unknown = JSON.parse(payloadJson);
    if (typeof payload !== "object" || payload === null) {
      return null;
    }
    const { answerId, expiresAt } = payload as Record<string, unknown>;
    if (typeof answerId !== "string"
      || typeof expiresAt !== "number"
      || !Number.isSafeInteger(expiresAt)
    ) {
      return null;
    }
    return { answerId, expiresAt };
  } catch {
    return null;
  }
}

// claim(share_token_roundtrip_exact): verifyShareToken accepts every token signShareToken signed while its expiry is in the future, and returns exactly the answerId and expiresAt it was signed with
export function verifyShareToken(
  secret: Buffer,
  token: string,
  now: number,
): { answerId: string; expiresAt: number } | null {
  const decoded = decodeShareToken(secret, token);
  if (decoded === null) {
    return null;
  }
  if (decoded.expiresAt <= now) {
    return null;
  }
  return decoded;
}
