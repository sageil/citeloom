import { z } from "zod";

import { MCP_ANSWER_SCOPE, MCP_SEARCH_SCOPE } from "./contract.js";

export const mcpApiKeyScopeSchema = z.enum([
  MCP_SEARCH_SCOPE,
  MCP_ANSWER_SCOPE,
]);

export type McpApiKeyScope = z.output<typeof mcpApiKeyScopeSchema>;

export interface CreateMcpApiKeyInput {
  expiresAt: Date;
  label: string | null;
  scopes: McpApiKeyScope[];
}

export interface McpApiKeyRecord {
  createdAt: string;
  expiresAt: string;
  id: string;
  label: string | null;
  revokedAt: string | null;
  scopes: McpApiKeyScope[];
  userId: string;
}

export interface CreatedMcpApiKey extends McpApiKeyRecord {
  apiKey: string;
}

export interface McpApiKeyAccess {
  apiKeyId: string;
  expiresAt: number;
  principal: import("../auth/model.js").AuthorizationPrincipal;
  scopes: McpApiKeyScope[];
}
