import { createHash, randomBytes } from "node:crypto";

export function createOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function digestOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
