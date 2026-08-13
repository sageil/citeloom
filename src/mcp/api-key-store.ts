import { randomUUID } from "node:crypto";

import { and, desc, eq, gt, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";

import { requireWorkspaceAdministrator } from "../auth/authorization.js";
import type { AuthorizationPrincipal } from "../auth/model.js";
import { createOpaqueToken, digestOpaqueToken } from "../auth/token.js";
import type { CiteLoomDatabase } from "../database/client.js";
import {
  mcpApiKeys,
  users,
  workspaceMemberships,
  workspaces,
} from "../database/schema.js";
import { parseMcpApiKeyAuthorization } from "./api-key-boundary.js";
import {
  mcpApiKeyScopeSchema,
  type CreateMcpApiKeyInput,
  type CreatedMcpApiKey,
  type McpApiKeyAccess,
  type McpApiKeyRecord,
} from "./api-key-model.js";
import { MCP_API_KEY_PREFIX } from "./contract.js";

const mcpApiKeyRecordRowSchema = z.object({
  createdAt: z.date(),
  expiresAt: z.date(),
  id: z.uuid(),
  label: z.string().nullable(),
  revokedAt: z.date().nullable(),
  scopes: z.array(mcpApiKeyScopeSchema).min(1),
  userId: z.uuid(),
  workspaceId: z.uuid(),
  workspaceName: z.string().min(1),
}).strict();

const mcpApiKeyAccessRowSchema = z.object({
  displayName: z.string().min(1),
  expiresAt: z.date(),
  globalRole: z.enum(["global_admin", "standard"]),
  id: z.uuid(),
  role: z.enum(["admin", "member"]),
  scopes: z.array(mcpApiKeyScopeSchema).min(1),
  userId: z.uuid(),
  username: z.string().min(1),
  workspaceId: z.uuid(),
  workspaceName: z.string().min(1),
}).strict();

export class McpApiKeyRejectedError extends Error {
  public constructor() {
    super("The MCP API key is invalid or expired.");
    this.name = "McpApiKeyRejectedError";
  }
}

export class McpApiKeyInsufficientScopeError extends Error {
  public constructor() {
    super("The MCP API key does not grant the required scope.");
    this.name = "McpApiKeyInsufficientScopeError";
  }
}

export class McpApiKeyTargetUnavailableError extends Error {
  public constructor() {
    super("The user must be active in the selected workspace.");
    this.name = "McpApiKeyTargetUnavailableError";
  }
}

export class McpApiKeyExpiryInvalidError extends Error {
  public constructor() {
    super("The MCP API key expiry must be in the future.");
    this.name = "McpApiKeyExpiryInvalidError";
  }
}

export class McpApiKeyUnavailableError extends Error {
  public constructor() {
    super("The MCP API key is unavailable.");
    this.name = "McpApiKeyUnavailableError";
  }
}

export class McpApiKeyStore {
  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async create(
    principal: AuthorizationPrincipal,
    userId: string,
    input: CreateMcpApiKeyInput,
  ): Promise<CreatedMcpApiKey> {
    requireWorkspaceAdministrator(principal, principal.workspaceId);
    const now = this.now();
    if (input.expiresAt.getTime() <= now.getTime()) {
      throw new McpApiKeyExpiryInvalidError();
    }
    const id = randomUUID();
    const apiKey = `${MCP_API_KEY_PREFIX}${id}.${createOpaqueToken()}`;
    return this.database.transaction(async (transaction) => {
      const targetRows = await transaction
        .select({ userId: users.id })
        .from(users)
        .innerJoin(
          workspaceMemberships,
          eq(workspaceMemberships.userId, users.id),
        )
        .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
        .where(and(
          eq(users.id, userId),
          eq(users.state, "active"),
          eq(workspaceMemberships.access, "enabled"),
          eq(workspaces.id, principal.workspaceId),
          eq(workspaces.state, "active"),
        ))
        .for("update")
        .limit(1);
      if (targetRows[0] === undefined) {
        throw new McpApiKeyTargetUnavailableError();
      }
      const rows = await transaction
        .insert(mcpApiKeys)
        .values({
          createdAt: now,
          createdByUserId: principal.userId,
          expiresAt: input.expiresAt,
          id,
          label: input.label,
          scopes: input.scopes,
          tokenDigest: digestOpaqueToken(apiKey),
          userId,
          workspaceId: principal.workspaceId,
        })
        .returning({
          createdAt: mcpApiKeys.createdAt,
          expiresAt: mcpApiKeys.expiresAt,
          id: mcpApiKeys.id,
          label: mcpApiKeys.label,
          revokedAt: mcpApiKeys.revokedAt,
          scopes: mcpApiKeys.scopes,
          userId: mcpApiKeys.userId,
          workspaceId: mcpApiKeys.workspaceId,
        });
      const row = rows[0];
      if (row === undefined) {
        throw new Error("The MCP API key was not stored.");
      }
      return buildMcpApiKeyRecord({
        ...row,
        workspaceName: principal.workspaceName,
      }, apiKey);
    });
  }

  public async list(
    principal: AuthorizationPrincipal,
    userId: string,
  ): Promise<McpApiKeyRecord[]> {
    requireWorkspaceAdministrator(principal, principal.workspaceId);
    const rows = await this.database
      .select({
        createdAt: mcpApiKeys.createdAt,
        expiresAt: mcpApiKeys.expiresAt,
        id: mcpApiKeys.id,
        label: mcpApiKeys.label,
        revokedAt: mcpApiKeys.revokedAt,
        scopes: mcpApiKeys.scopes,
        userId: mcpApiKeys.userId,
        workspaceId: mcpApiKeys.workspaceId,
        workspaceName: workspaces.name,
      })
      .from(mcpApiKeys)
      .innerJoin(workspaces, eq(workspaces.id, mcpApiKeys.workspaceId))
      .where(and(
        eq(mcpApiKeys.userId, userId),
        eq(mcpApiKeys.workspaceId, principal.workspaceId),
      ))
      .orderBy(desc(mcpApiKeys.createdAt), desc(mcpApiKeys.id));
    const records: McpApiKeyRecord[] = [];
    for (const row of rows) {
      records.push(buildMcpApiKeyRecord(row));
    }
    return records;
  }

  public async revoke(
    principal: AuthorizationPrincipal,
    userId: string,
    apiKeyId: string,
  ): Promise<void> {
    requireWorkspaceAdministrator(principal, principal.workspaceId);
    const rows = await this.database
      .update(mcpApiKeys)
      .set({
        revokedAt: this.now(),
        revokedByUserId: principal.userId,
      })
      .where(and(
        eq(mcpApiKeys.id, apiKeyId),
        eq(mcpApiKeys.userId, userId),
        eq(mcpApiKeys.workspaceId, principal.workspaceId),
        isNull(mcpApiKeys.revokedAt),
      ))
      .returning({ id: mcpApiKeys.id });
    if (rows[0] === undefined) {
      throw new McpApiKeyUnavailableError();
    }
  }

  public async authenticate(
    authorizationHeader: string | string[] | undefined,
    requiredScopes: readonly string[],
  ): Promise<McpApiKeyAccess> {
    let parsed: ReturnType<typeof parseMcpApiKeyAuthorization>;
    try {
      parsed = parseMcpApiKeyAuthorization(authorizationHeader);
    } catch {
      throw new McpApiKeyRejectedError();
    }
    return this.readAccess(
      parsed.id,
      requiredScopes,
      eq(mcpApiKeys.tokenDigest, digestOpaqueToken(parsed.apiKey)),
    );
  }

  public async resolveForTask(
    apiKeyId: string,
    requiredScopes: readonly string[],
  ): Promise<McpApiKeyAccess> {
    return this.readAccess(apiKeyId, requiredScopes);
  }

  private async readAccess(
    apiKeyId: string,
    requiredScopes: readonly string[],
    secretCondition?: SQL,
  ): Promise<McpApiKeyAccess> {
    const conditions: SQL[] = [
      eq(mcpApiKeys.id, apiKeyId),
      isNull(mcpApiKeys.revokedAt),
      gt(mcpApiKeys.expiresAt, this.now()),
      eq(users.state, "active"),
      eq(workspaceMemberships.access, "enabled"),
      eq(workspaces.state, "active"),
    ];
    if (secretCondition !== undefined) {
      conditions.push(secretCondition);
    }
    const rows = await this.database
      .select({
        displayName: users.displayName,
        expiresAt: mcpApiKeys.expiresAt,
        globalRole: users.globalRole,
        id: mcpApiKeys.id,
        role: workspaceMemberships.role,
        scopes: mcpApiKeys.scopes,
        userId: users.id,
        username: users.username,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
      })
      .from(mcpApiKeys)
      .innerJoin(users, eq(users.id, mcpApiKeys.userId))
      .innerJoin(
        workspaceMemberships,
        and(
          eq(workspaceMemberships.userId, users.id),
          eq(workspaceMemberships.workspaceId, mcpApiKeys.workspaceId),
        ),
      )
      .innerJoin(workspaces, eq(workspaces.id, mcpApiKeys.workspaceId))
      .where(and(...conditions))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new McpApiKeyRejectedError();
    }
    const key = mcpApiKeyAccessRowSchema.parse(row);
    const scopeSet = new Set<string>(key.scopes);
    for (const requiredScope of requiredScopes) {
      if (!scopeSet.has(requiredScope)) {
        throw new McpApiKeyInsufficientScopeError();
      }
    }
    return {
      apiKeyId: key.id,
      expiresAt: Math.floor(key.expiresAt.getTime() / 1_000),
      principal: {
        dataScope: "workspace",
        displayName: key.displayName,
        globalRole: key.globalRole,
        role: key.role,
        userId: key.userId,
        username: key.username,
        workspaceId: key.workspaceId,
        workspaceName: key.workspaceName,
      },
      scopes: key.scopes,
    };
  }
}

function buildMcpApiKeyRecord(value: unknown): McpApiKeyRecord;
function buildMcpApiKeyRecord(
  value: unknown,
  apiKey: string,
): CreatedMcpApiKey;
function buildMcpApiKeyRecord(
  value: unknown,
  apiKey?: string,
): McpApiKeyRecord | CreatedMcpApiKey {
  const row = mcpApiKeyRecordRowSchema.parse(value);
  const record: McpApiKeyRecord = {
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    id: row.id,
    label: row.label,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    scopes: row.scopes,
    userId: row.userId,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
  };
  if (apiKey === undefined) {
    return record;
  }
  return { ...record, apiKey };
}
