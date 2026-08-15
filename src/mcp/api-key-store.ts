import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, gt, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";

import {
  requireWorkspaceAdministrator,
  WorkspaceAuthorizationError,
} from "../auth/authorization.js";
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
import { MCP_API_KEY_PREFIX } from "./mcp.js";

const mcpApiKeyRecordRowSchema = z.object({
  createdAt: z.date(),
  expiresAt: z.date(),
  id: z.uuid(),
  label: z.string().nullable(),
  revokedAt: z.date().nullable(),
  scopes: z.array(mcpApiKeyScopeSchema).min(1),
  userId: z.uuid(),
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
    super("The user must be active and available to this administrator.");
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
    requireMcpApiKeyManager(principal);
    const now = this.now();
    if (input.expiresAt.getTime() <= now.getTime()) {
      throw new McpApiKeyExpiryInvalidError();
    }
    const id = randomUUID();
    const apiKey = `${MCP_API_KEY_PREFIX}${id}.${createOpaqueToken()}`;
    return this.database.transaction(async (transaction) => {
      let targetRows: { userId: string }[];
      if (principal.globalRole === "global_admin") {
        targetRows = await transaction
          .select({ userId: users.id })
          .from(users)
          .where(and(
            eq(users.id, userId),
            eq(users.state, "active"),
          ))
          .for("update")
          .limit(1);
      } else {
        targetRows = await transaction
          .select({ userId: users.id })
          .from(users)
          .innerJoin(
            workspaceMemberships,
            eq(workspaceMemberships.userId, users.id),
          )
          .innerJoin(
            workspaces,
            eq(workspaces.id, workspaceMemberships.workspaceId),
          )
          .where(and(
            eq(users.id, userId),
            eq(users.state, "active"),
            eq(workspaceMemberships.access, "enabled"),
            eq(workspaces.id, principal.workspaceId),
            eq(workspaces.state, "active"),
          ))
          .for("update")
          .limit(1);
      }
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
        })
        .returning({
          createdAt: mcpApiKeys.createdAt,
          expiresAt: mcpApiKeys.expiresAt,
          id: mcpApiKeys.id,
          label: mcpApiKeys.label,
          revokedAt: mcpApiKeys.revokedAt,
          scopes: mcpApiKeys.scopes,
          userId: mcpApiKeys.userId,
        });
      const row = rows[0];
      if (row === undefined) {
        throw new Error("The MCP API key was not stored.");
      }
      return buildMcpApiKeyRecord(row, apiKey);
    });
  }

  public async list(
    principal: AuthorizationPrincipal,
    userId: string,
  ): Promise<McpApiKeyRecord[]> {
    requireMcpApiKeyManager(principal);
    await this.assertCanManageTarget(principal, userId);
    const rows = await this.database
      .select({
        createdAt: mcpApiKeys.createdAt,
        expiresAt: mcpApiKeys.expiresAt,
        id: mcpApiKeys.id,
        label: mcpApiKeys.label,
        revokedAt: mcpApiKeys.revokedAt,
        scopes: mcpApiKeys.scopes,
        userId: mcpApiKeys.userId,
      })
      .from(mcpApiKeys)
      .where(eq(mcpApiKeys.userId, userId))
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
    requireMcpApiKeyManager(principal);
    await this.assertCanManageTarget(principal, userId);
    const rows = await this.database
      .update(mcpApiKeys)
      .set({
        revokedAt: this.now(),
        revokedByUserId: principal.userId,
      })
      .where(and(
        eq(mcpApiKeys.id, apiKeyId),
        eq(mcpApiKeys.userId, userId),
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
    return this.readAccess(
      apiKeyId,
      requiredScopes,
    );
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
        eq(workspaceMemberships.userId, users.id),
      )
      .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
      .where(and(...conditions))
      .orderBy(asc(workspaces.name), asc(workspaces.id));
    if (rows.length === 0) {
      throw new McpApiKeyRejectedError();
    }
    const keys = mcpApiKeyAccessRowSchema.array().parse(rows);
    const key = keys[0];
    if (key === undefined) {
      throw new McpApiKeyRejectedError();
    }
    const scopeSet = new Set<string>(key.scopes);
    for (const requiredScope of requiredScopes) {
      if (!scopeSet.has(requiredScope)) {
        throw new McpApiKeyInsufficientScopeError();
      }
    }
    const principals: AuthorizationPrincipal[] = [];
    for (const workspaceKey of keys) {
      principals.push({
        dataScope: "workspace",
        displayName: workspaceKey.displayName,
        globalRole: workspaceKey.globalRole,
        role: workspaceKey.role,
        userId: workspaceKey.userId,
        username: workspaceKey.username,
        workspaceId: workspaceKey.workspaceId,
        workspaceName: workspaceKey.workspaceName,
      });
    }
    return {
      apiKeyId: key.id,
      expiresAt: Math.floor(key.expiresAt.getTime() / 1_000),
      principals,
      scopes: key.scopes,
    };
  }

  private async assertCanManageTarget(
    principal: AuthorizationPrincipal,
    userId: string,
  ): Promise<void> {
    if (principal.globalRole === "global_admin") {
      return;
    }
    const rows = await this.database
      .select({ userId: workspaceMemberships.userId })
      .from(workspaceMemberships)
      .where(and(
        eq(workspaceMemberships.userId, userId),
        eq(workspaceMemberships.workspaceId, principal.workspaceId),
      ))
      .limit(1);
    if (rows[0] === undefined) {
      throw new WorkspaceAuthorizationError(
        "The MCP API key owner must belong to the administered workspace.",
      );
    }
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
  };
  if (apiKey === undefined) {
    return record;
  }
  return { ...record, apiKey };
}

function requireMcpApiKeyManager(
  principal: AuthorizationPrincipal,
): void {
  requireWorkspaceAdministrator(principal, principal.workspaceId);
}
