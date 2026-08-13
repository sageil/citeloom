import { z } from "zod";

import {
  parseOAuthConfigurationValues,
  type OAuthConfigurationValues,
} from "./config.js";

const externalIdentifierSchema = z.string()
  .min(1)
  .max(1_024)
  .refine((value) => value === value.trim(), "must not have surrounding whitespace");

export interface OAuthUserIdentityLinkInput {
  subject: string;
}

export interface OAuthWorkspaceLinkInput {
  externalWorkspaceId: string;
}

export interface OAuthConfigurationUpdateInput extends OAuthConfigurationValues {
  expectedVersion: number;
}

const oauthConfigurationRequestSchema = z.object({
  issuer: z.unknown(),
  resource: z.unknown(),
  scopes: z.unknown(),
  workspaceClaim: z.unknown(),
}).strict();

export function decodeOAuthUserIdentityLinkInput(
  input: unknown,
): OAuthUserIdentityLinkInput {
  return z.object({ subject: externalIdentifierSchema }).strict().parse(input);
}

export function decodeOAuthWorkspaceLinkInput(
  input: unknown,
): OAuthWorkspaceLinkInput {
  return z.object({
    externalWorkspaceId: externalIdentifierSchema,
  }).strict().parse(input);
}

export function decodeOAuthUserLinkTarget(input: unknown): string {
  return z.object({ userId: z.uuid() }).strict().parse(input).userId;
}

export function decodeOAuthWorkspaceLinkTarget(input: unknown): string {
  return z.object({ workspaceId: z.uuid() }).strict().parse(input).workspaceId;
}

export function decodeOAuthConfigurationVerificationInput(
  input: unknown,
  publicOrigin: string,
): OAuthConfigurationValues {
  const request = oauthConfigurationRequestSchema.parse(input);
  return parseOAuthConfigurationValues(request, publicOrigin);
}

export function decodeOAuthConfigurationUpdateInput(
  input: unknown,
  publicOrigin: string,
): OAuthConfigurationUpdateInput {
  const request = oauthConfigurationRequestSchema.extend({
    expectedVersion: z.number().int().positive(),
  }).parse(input);
  const configuration = parseOAuthConfigurationValues({
    issuer: request.issuer,
    resource: request.resource,
    scopes: request.scopes,
    workspaceClaim: request.workspaceClaim,
  }, publicOrigin);
  return {
    ...configuration,
    expectedVersion: request.expectedVersion,
  };
}

export function decodeOAuthConfigurationDisableInput(input: unknown): number {
  return z.object({
    expectedVersion: z.number().int().positive(),
  }).strict().parse(input).expectedVersion;
}
