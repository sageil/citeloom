import { z } from "zod";

import {
  hasBearerTokenPrefix,
  readBearerToken,
} from "../auth/bearer-token.js";
import { MCP_API_KEY_PREFIX } from "./mcp.js";
import {
  mcpApiKeyScopeSchema,
  type CreateMcpApiKeyInput,
} from "./api-key-model.js";

const apiKeyLabelSchema = z.string().trim().min(1).max(100);
const apiKeySecretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const apiKeyScopesSchema = z.array(mcpApiKeyScopeSchema)
  .min(1)
  .max(2)
  .refine((scopes) => new Set(scopes).size === scopes.length);

export interface ParsedMcpApiKey {
  apiKey: string;
  id: string;
}

export function decodeCreateMcpApiKeyInput(
  input: unknown,
): CreateMcpApiKeyInput {
  const value = z.object({
    expiresAt: z.iso.datetime({ offset: true }),
    label: z.string().max(100).nullable(),
    scopes: apiKeyScopesSchema,
  }).strict().parse(input);
  const label = value.label === null || value.label.trim() === ""
    ? null
    : apiKeyLabelSchema.parse(value.label);
  return {
    expiresAt: new Date(value.expiresAt),
    label,
    scopes: value.scopes,
  };
}

export function decodeMcpApiKeyTarget(input: unknown): {
  userId: string;
} {
  return z.object({ userId: z.uuid() }).strict().parse(input);
}

export function decodeMcpApiKeyRecordTarget(input: unknown): {
  apiKeyId: string;
  userId: string;
} {
  return z.object({
    apiKeyId: z.uuid(),
    userId: z.uuid(),
  }).strict().parse(input);
}

export function hasMcpApiKeyPrefix(
  authorizationHeader: string | string[] | undefined,
): boolean {
  return hasBearerTokenPrefix(authorizationHeader, MCP_API_KEY_PREFIX);
}

export function parseMcpApiKeyAuthorization(
  authorizationHeader: string | string[] | undefined,
): ParsedMcpApiKey {
  if (typeof authorizationHeader !== "string") {
    throw new Error("The MCP API key is missing.");
  }
  const apiKey = readBearerToken(authorizationHeader);
  if (!apiKey.startsWith(MCP_API_KEY_PREFIX)) {
    throw new Error("The MCP API key is invalid.");
  }
  const separator = apiKey.indexOf(".");
  if (separator < 0) {
    throw new Error("The MCP API key is invalid.");
  }
  const id = z.uuid().parse(apiKey.slice(MCP_API_KEY_PREFIX.length, separator));
  apiKeySecretSchema.parse(apiKey.slice(separator + 1));
  return { apiKey, id };
}
