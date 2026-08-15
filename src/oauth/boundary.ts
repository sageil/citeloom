import { z } from "zod";

const externalIdentifierSchema = z.string()
  .min(1)
  .max(1_024)
  .refine((value) => value === value.trim(), "must not have surrounding whitespace");

export interface OAuthUserIdentityLinkInput {
  subject: string;
}

export function decodeOAuthUserIdentityLinkInput(
  input: unknown,
): OAuthUserIdentityLinkInput {
  return z.object({ subject: externalIdentifierSchema }).strict().parse(input);
}

export function decodeOAuthUserLinkTarget(input: unknown): string {
  return z.object({ userId: z.uuid() }).strict().parse(input).userId;
}
