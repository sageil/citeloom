import {
  argon2id,
  hash as hashWithArgon2,
  verify as verifyWithArgon2,
} from "argon2";
import { z } from "zod";

import { DEFAULT_PASSWORD_REQUIREMENTS } from "../domain/security-policy-defaults.js";

const maximumPasswordBytes = 4_096;
const passwordInputSchema = z.string().min(1).max(1_024);

const validatedPasswordBrand: unique symbol = Symbol("ValidatedPassword");

export type PasswordInput = string;
export type ValidatedPassword = string & {
  readonly [validatedPasswordBrand]: true;
};

export interface PasswordRequirements {
  minimumPasswordLength: number;
  requireLetterAndNumber: boolean;
  requireSpecialCharacter: boolean;
}

export class PasswordValidationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PasswordValidationError";
  }
}

export function readPasswordInput(value: unknown): PasswordInput {
  const result = passwordInputSchema.safeParse(value);
  if (!result.success) {
    throw new PasswordValidationError(
      "Password must contain between 1 and 1,024 characters.",
    );
  }
  if (Buffer.byteLength(result.data, "utf8") > maximumPasswordBytes) {
    throw new PasswordValidationError(
      `Password must not exceed ${maximumPasswordBytes.toLocaleString("en-US")} UTF-8 bytes.`,
    );
  }
  return result.data;
}

export function validatePassword(
  password: PasswordInput,
  requirements: PasswordRequirements,
): ValidatedPassword {
  if (password.length < requirements.minimumPasswordLength) {
    throw new PasswordValidationError(
      `Password must contain at least ${requirements.minimumPasswordLength} characters.`,
    );
  }
  if (
    requirements.requireLetterAndNumber
    && (!/\p{L}/u.test(password) || !/\p{N}/u.test(password))
  ) {
    throw new PasswordValidationError(
      "Password must contain at least one letter and one number.",
    );
  }
  if (
    requirements.requireSpecialCharacter
    && !/[^\p{L}\p{N}\s]/u.test(password)
  ) {
    throw new PasswordValidationError(
      "Password must contain at least one special character.",
    );
  }
  return password as unknown as ValidatedPassword;
}

export function readPassword(value: unknown): ValidatedPassword {
  return validatePassword(readPasswordInput(value), DEFAULT_PASSWORD_REQUIREMENTS);
}

export async function hashValidatedPassword(
  password: ValidatedPassword,
): Promise<string> {
  return hashWithArgon2(password, {
    memoryCost: 19_456,
    parallelism: 1,
    timeCost: 2,
    type: argon2id,
  });
}

export async function hashPassword(password: unknown): Promise<string> {
  return hashValidatedPassword(readPassword(password));
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
