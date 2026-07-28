import {
  argon2id,
  hash as hashWithArgon2,
  verify as verifyWithArgon2,
} from "argon2";
import { z } from "zod";

const maximumPasswordBytes = 4_096;
const passwordSchema = z.string().min(15).max(1_024);

export class PasswordValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PasswordValidationError";
  }
}

export function readPassword(value: unknown): string {
  const result = passwordSchema.safeParse(value);
  if (!result.success) {
    throw new PasswordValidationError(
      "Password must contain between 15 and 1,024 characters.",
    );
  }
  if (Buffer.byteLength(result.data, "utf8") > maximumPasswordBytes) {
    throw new PasswordValidationError(
      `Password must not exceed ${maximumPasswordBytes.toLocaleString("en-US")} UTF-8 bytes.`,
    );
  }
  return result.data;
}

export async function hashPassword(password: string): Promise<string> {
  const normalizedPassword = readPassword(password);
  return hashWithArgon2(normalizedPassword, {
    memoryCost: 19_456,
    parallelism: 1,
    timeCost: 2,
    type: argon2id,
  });
}

export async function verifyPassword(
  passwordHash: string,
  candidatePassword: string,
): Promise<boolean> {
  if (Buffer.byteLength(candidatePassword, "utf8") > maximumPasswordBytes) {
    return false;
  }
  return verifyWithArgon2(passwordHash, candidatePassword);
}
