import { randomUUID } from "node:crypto";

import { and, asc, count, eq, ne, sql, type SQL } from "drizzle-orm";

import type { CiteLoomDatabase } from "../database/client.js";
import { readUniqueConstraintName } from "../database/errors.js";
import {
  userSetupTokens,
  users,
  workspaceMemberships,
  workspaceSecurityPolicies,
  workspaces,
} from "../database/schema.js";
import { DEFAULT_WORKSPACE_SECURITY_POLICY } from "../domain/security-policy-defaults.js";
import { requireGlobalAdministrator } from "./authorization.js";
import type { NormalizedUserIdentity } from "./boundary.js";
import type {
  AuthorizationPrincipal,
  OrganizationUserAccount,
  UserPasswordLink,
} from "./model.js";
import { createOpaqueToken, digestOpaqueToken } from "./token.js";

const USERNAME_UNIQUE_CONSTRAINT = "users_username_normalized_idx";

export class OrganizationUsernameUnavailableError extends Error {
  public constructor() {
    super("The requested username is unavailable.");
    this.name = "OrganizationUsernameUnavailableError";
  }
}

export class OrganizationUserUnavailableError extends Error {
  public constructor() {
    super("The requested user account is unavailable.");
    this.name = "OrganizationUserUnavailableError";
  }
}

export class OrganizationUserWorkspaceRequiredError extends Error {
  public constructor() {
    super("Add this user to at least one workspace before creating a password link.");
    this.name = "OrganizationUserWorkspaceRequiredError";
  }
}

export class UserAccountStore {
  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async create(
    principal: AuthorizationPrincipal,
    identity: NormalizedUserIdentity,
  ): Promise<OrganizationUserAccount> {
    requireGlobalAdministrator(principal);
    const userId = randomUUID();
    const now = this.now();
    try {
      await this.database.insert(users).values({
        createdAt: now,
        displayName: identity.displayName,
        globalRole: "standard",
        id: userId,
        state: "pending",
        updatedAt: now,
        username: identity.username,
        usernameNormalized: identity.usernameNormalized,
      });
    } catch (error: unknown) {
      if (readUniqueConstraintName(error) === USERNAME_UNIQUE_CONSTRAINT) {
        throw new OrganizationUsernameUnavailableError();
      }
      throw error;
    }
    return {
      currentWorkspaceAccess: false,
      displayName: identity.displayName,
      globalRole: "standard",
      state: "pending",
      userId,
      username: identity.username,
      workspaceCount: 0,
    };
  }

  public async list(
    principal: AuthorizationPrincipal,
  ): Promise<OrganizationUserAccount[]> {
    const visibility: SQL | undefined = principal.globalRole === "global_admin"
      ? undefined
      : eq(workspaceMemberships.workspaceId, principal.workspaceId);
    return this.database
      .select({
        currentWorkspaceAccess: sql<boolean>`coalesce(bool_or(
          ${workspaces.id} = ${principal.workspaceId}
        ), false)`,
        displayName: users.displayName,
        globalRole: users.globalRole,
        state: users.state,
        userId: users.id,
        username: users.username,
        workspaceCount: count(workspaces.id),
      })
      .from(users)
      .leftJoin(
        workspaceMemberships,
        and(
          eq(workspaceMemberships.userId, users.id),
          eq(workspaceMemberships.access, "enabled"),
        ),
      )
      .leftJoin(
        workspaces,
        and(
          eq(workspaces.id, workspaceMemberships.workspaceId),
          eq(workspaces.state, "active"),
        ),
      )
      .where(visibility)
      .groupBy(
        users.id,
        users.displayName,
        users.globalRole,
        users.state,
        users.username,
        users.usernameNormalized,
      )
      .orderBy(asc(users.usernameNormalized), asc(users.id));
  }

  public async createPasswordLink(
    principal: AuthorizationPrincipal,
    userId: string,
  ): Promise<UserPasswordLink> {
    requireGlobalAdministrator(principal);
    const setupToken = createOpaqueToken();
    const tokenDigest = digestOpaqueToken(setupToken);
    const now = this.now();
    return this.database.transaction(async (transaction) => {
      const userRows = await transaction
        .select({ state: users.state })
        .from(users)
        .where(and(
          eq(users.id, userId),
          ne(users.state, "suspended"),
        ))
        .for("update")
        .limit(1);
      const user = userRows[0];
      if (user === undefined) {
        throw new OrganizationUserUnavailableError();
      }

      const workspaceRows = await transaction
        .select({
          resetLinkLifetimeSeconds: workspaceSecurityPolicies.resetLinkLifetimeSeconds,
          workspaceId: workspaceMemberships.workspaceId,
        })
        .from(workspaceMemberships)
        .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
        .leftJoin(
          workspaceSecurityPolicies,
          eq(workspaceSecurityPolicies.workspaceId, workspaceMemberships.workspaceId),
        )
        .where(and(
          eq(workspaceMemberships.access, "enabled"),
          eq(workspaceMemberships.userId, userId),
          eq(workspaces.state, "active"),
        ))
        .orderBy(asc(workspaces.createdAt), asc(workspaces.id));
      const firstWorkspace = workspaceRows[0];
      if (firstWorkspace === undefined) {
        throw new OrganizationUserWorkspaceRequiredError();
      }

      let lifetimeSeconds = Number.POSITIVE_INFINITY;
      for (const workspace of workspaceRows) {
        const workspaceLifetime = workspace.resetLinkLifetimeSeconds
          ?? DEFAULT_WORKSPACE_SECURITY_POLICY.resetLinkLifetimeSeconds;
        lifetimeSeconds = Math.min(lifetimeSeconds, workspaceLifetime);
      }
      const expiresAt = new Date(now.getTime() + lifetimeSeconds * 1_000);

      await transaction
        .delete(userSetupTokens)
        .where(eq(userSetupTokens.userId, userId));
      await transaction.insert(userSetupTokens).values({
        createdAt: now,
        createdByUserId: principal.userId,
        expiresAt,
        tokenDigest,
        userId,
        workspaceId: firstWorkspace.workspaceId,
      });

      return {
        expiresAt: expiresAt.toISOString(),
        purpose: user.state === "pending" ? "setup" : "reset",
        setupToken,
        userId,
      };
    });
  }
}
