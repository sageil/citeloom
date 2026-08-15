import { and, asc, eq, type SQL } from "drizzle-orm";

import type {
  AuthorizationPrincipal,
  GlobalRole,
  WorkspaceRole,
  WorkspaceSummary,
} from "../auth/model.js";
import type { CiteLoomDatabase } from "../database/client.js";
import {
  oauthUserIdentityLinks,
  users,
  workspaceMemberships,
  workspaces,
} from "../database/schema.js";

export interface OAuthPrincipalIdentity {
  clientId?: string | null;
  expiresAt?: number;
  issuer: string;
  scopes: string[];
  subject: string;
}

export interface OAuthIdentityAccessToken extends OAuthPrincipalIdentity {
  clientId: string | null;
  expiresAt: number;
}

export interface McpOAuthIdentityAccessToken extends OAuthIdentityAccessToken {
  clientId: string;
}

export interface OAuthAuthorizationPrincipal extends AuthorizationPrincipal {
  issuer: string;
  scopes: string[];
  subject: string;
}

export interface OAuthIdentityContext {
  displayName: string;
  globalRole: GlobalRole;
  userId: string;
  username: string;
  workspaces: WorkspaceSummary[];
}

export class OAuthIdentityUnavailableError extends Error {
  public constructor() {
    super("The OAuth identity is not authorized for this CiteLoom workspace.");
    this.name = "OAuthIdentityUnavailableError";
  }
}

interface AccessibleIdentityRow {
  displayName: string;
  globalRole: GlobalRole;
  role: WorkspaceRole;
  userId: string;
  username: string;
  workspaceId: string;
  workspaceName: string;
}

export class OAuthPrincipalStore {
  public constructor(private readonly database: CiteLoomDatabase) {}

  public async resolvePrincipal(
    token: OAuthPrincipalIdentity,
    workspaceId: string,
  ): Promise<OAuthAuthorizationPrincipal> {
    const rows = await this.readAccessibleIdentities(token, workspaceId);
    return buildOAuthAuthorizationPrincipal(token, rows);
  }

  public async resolvePrincipals(
    token: OAuthPrincipalIdentity,
  ): Promise<OAuthAuthorizationPrincipal[]> {
    const rows = await this.readAccessibleIdentities(token, null);
    if (rows.length === 0) {
      throw new OAuthIdentityUnavailableError();
    }
    const principals: OAuthAuthorizationPrincipal[] = [];
    for (const row of rows) {
      principals.push(buildOAuthAuthorizationPrincipal(token, [row]));
    }
    return principals;
  }

  public async readContext(
    token: OAuthIdentityAccessToken,
  ): Promise<OAuthIdentityContext> {
    const rows = await this.readAccessibleIdentities(token, null);
    const row = rows[0];
    if (row === undefined) {
      throw new OAuthIdentityUnavailableError();
    }
    const workspaces: WorkspaceSummary[] = [];
    for (const row of rows) {
      workspaces.push({
        id: row.workspaceId,
        name: row.workspaceName,
        role: row.role,
      });
    }
    return {
      displayName: row.displayName,
      globalRole: row.globalRole,
      userId: row.userId,
      username: row.username,
      workspaces,
    };
  }

  private async readAccessibleIdentities(
    token: OAuthPrincipalIdentity,
    workspaceId: string | null,
  ): Promise<AccessibleIdentityRow[]> {
    const conditions: SQL[] = [
      eq(oauthUserIdentityLinks.issuer, token.issuer),
      eq(oauthUserIdentityLinks.subject, token.subject),
      eq(users.state, "active"),
      eq(workspaceMemberships.access, "enabled"),
      eq(workspaces.state, "active"),
    ];
    if (workspaceId !== null) {
      conditions.push(eq(workspaces.id, workspaceId));
    }
    return this.database
      .select({
        displayName: users.displayName,
        globalRole: users.globalRole,
        role: workspaceMemberships.role,
        userId: users.id,
        username: users.username,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
      })
      .from(oauthUserIdentityLinks)
      .innerJoin(users, eq(users.id, oauthUserIdentityLinks.userId))
      .innerJoin(
        workspaceMemberships,
        eq(workspaceMemberships.userId, users.id),
      )
      .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
      .where(and(...conditions))
      .orderBy(asc(workspaces.name), asc(workspaces.id));
  }
}

function buildOAuthAuthorizationPrincipal(
  token: OAuthPrincipalIdentity,
  rows: AccessibleIdentityRow[],
): OAuthAuthorizationPrincipal {
  const row = rows[0];
  if (row === undefined) {
    throw new OAuthIdentityUnavailableError();
  }
  return {
    dataScope: "workspace",
    displayName: row.displayName,
    globalRole: row.globalRole,
    issuer: token.issuer,
    role: row.role,
    scopes: [...token.scopes],
    subject: token.subject,
    userId: row.userId,
    username: row.username,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
  };
}
