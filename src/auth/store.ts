import { randomUUID } from "node:crypto";

import { and, asc, count, eq, gt, ne } from "drizzle-orm";

import type { CiteLoomDatabase } from "../database/client.js";
import {
  userPasswordCredentials,
  userSessions,
  userSetupTokens,
  users,
  workspaceMemberships,
  workspaces,
} from "../database/schema.js";
import type {
  AuthenticatedPrincipal,
  AuthenticationSession,
  PendingUserSetup,
  WorkspaceMember,
  WorkspaceMemberAddition,
  WorkspaceRole,
} from "./model.js";
import type { LoginInput, NormalizedUserIdentity } from "./boundary.js";
import { hashPassword, verifyPassword } from "./password.js";
import { createOpaqueToken, digestOpaqueToken } from "./token.js";

const setupTokenLifetimeMs = 24 * 60 * 60 * 1_000;
const sessionIdleLifetimeSeconds = 2 * 60 * 60;
const rememberedSessionIdleLifetimeSeconds = 7 * 24 * 60 * 60;
const sessionAbsoluteLifetimeMs = 12 * 60 * 60 * 1_000;
const rememberedSessionAbsoluteLifetimeMs = 30 * 24 * 60 * 60 * 1_000;
const dummyPasswordHash = hashPassword("invalid-password-placeholder");

export class AuthenticationRejectedError extends Error {
  public constructor() {
    super("Invalid username or password.");
    this.name = "AuthenticationRejectedError";
  }
}

export class SetupTokenRejectedError extends Error {
  public constructor() {
    super("The password link is invalid or has expired.");
    this.name = "SetupTokenRejectedError";
  }
}

export class WorkspaceAuthorizationError extends Error {
  public constructor(message: string = "Workspace administrator access is required.") {
    super(message);
    this.name = "WorkspaceAuthorizationError";
  }
}

export class UsernameUnavailableError extends Error {
  public constructor() {
    super("The requested username is unavailable.");
    this.name = "UsernameUnavailableError";
  }
}

export class FinalWorkspaceAdministratorError extends Error {
  public constructor() {
    super("A workspace must retain at least one active administrator.");
    this.name = "FinalWorkspaceAdministratorError";
  }
}

export class WorkspaceMemberNotFoundError extends Error {
  public constructor() {
    super("The workspace member was not found.");
    this.name = "WorkspaceMemberNotFoundError";
  }
}

export class AuthenticationStore {
  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async completePasswordSetup(
    setupToken: string,
    password: string,
  ): Promise<AuthenticationSession> {
    const passwordHash = await hashPassword(password);
    const tokenDigest = digestOpaqueToken(setupToken);
    const now = this.now();
    const sessionToken = createOpaqueToken();
    const sessionTokenDigest = digestOpaqueToken(sessionToken);
    const expiresAt = new Date(now.getTime() + sessionAbsoluteLifetimeMs);

    const principal = await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          displayName: users.displayName,
          role: workspaceMemberships.role,
          state: users.state,
          userId: users.id,
          username: users.username,
          workspaceId: workspaces.id,
          workspaceName: workspaces.name,
        })
        .from(userSetupTokens)
        .innerJoin(users, eq(users.id, userSetupTokens.userId))
        .innerJoin(
          workspaceMemberships,
          eq(workspaceMemberships.userId, users.id),
        )
        .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
        .where(and(
          eq(userSetupTokens.tokenDigest, tokenDigest),
          gt(userSetupTokens.expiresAt, now),
        ))
        .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
        .limit(1)
        .for("update");
      const row = rows[0];
      if (
        row === undefined
        || (row.state !== "pending" && row.state !== "active")
      ) {
        throw new SetupTokenRejectedError();
      }
      if (row.state === "pending") {
        await transaction.insert(userPasswordCredentials).values({
          passwordHash,
          updatedAt: now,
          userId: row.userId,
        });
        await transaction
          .update(users)
          .set({ state: "active", updatedAt: now })
          .where(eq(users.id, row.userId));
      } else {
        await transaction
          .update(userPasswordCredentials)
          .set({ passwordHash, updatedAt: now })
          .where(eq(userPasswordCredentials.userId, row.userId));
        await transaction
          .delete(userSessions)
          .where(eq(userSessions.userId, row.userId));
      }
      await transaction
        .delete(userSetupTokens)
        .where(eq(userSetupTokens.userId, row.userId));
      await transaction.insert(userSessions).values({
        activeWorkspaceId: row.workspaceId,
        createdAt: now,
        expiresAt,
        idleTimeoutSeconds: sessionIdleLifetimeSeconds,
        lastSeenAt: now,
        tokenDigest: sessionTokenDigest,
        userId: row.userId,
      });
      return buildPrincipal(row, sessionTokenDigest);
    });
    return { expiresAt: expiresAt.toISOString(), principal, token: sessionToken };
  }

  public async authenticate(input: LoginInput): Promise<AuthenticationSession> {
    const rows = await this.database
      .select({
        displayName: users.displayName,
        passwordHash: userPasswordCredentials.passwordHash,
        role: workspaceMemberships.role,
        state: users.state,
        userId: users.id,
        username: users.username,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
      })
      .from(users)
      .innerJoin(
        userPasswordCredentials,
        eq(userPasswordCredentials.userId, users.id),
      )
      .innerJoin(workspaceMemberships, eq(workspaceMemberships.userId, users.id))
      .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
      .where(eq(users.usernameNormalized, input.usernameNormalized))
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
      .limit(1);
    const row = rows[0];
    const passwordHash = row?.passwordHash ?? await dummyPasswordHash;
    const passwordMatches = await verifyPassword(passwordHash, input.password);
    if (!passwordMatches || row === undefined || row.state !== "active") {
      throw new AuthenticationRejectedError();
    }

    const sessionToken = createOpaqueToken();
    const sessionTokenDigest = digestOpaqueToken(sessionToken);
    const now = this.now();
    const absoluteLifetime = input.remember
      ? rememberedSessionAbsoluteLifetimeMs
      : sessionAbsoluteLifetimeMs;
    const idleLifetime = input.remember
      ? rememberedSessionIdleLifetimeSeconds
      : sessionIdleLifetimeSeconds;
    const expiresAt = new Date(now.getTime() + absoluteLifetime);
    await this.database.insert(userSessions).values({
      activeWorkspaceId: row.workspaceId,
      createdAt: now,
      expiresAt,
      idleTimeoutSeconds: idleLifetime,
      lastSeenAt: now,
      tokenDigest: sessionTokenDigest,
      userId: row.userId,
    });
    return {
      expiresAt: expiresAt.toISOString(),
      principal: buildPrincipal(row, sessionTokenDigest),
      token: sessionToken,
    };
  }

  public async readSession(sessionToken: string): Promise<AuthenticatedPrincipal | null> {
    const tokenDigest = digestOpaqueToken(sessionToken);
    const now = this.now();
    const rows = await this.database
      .select({
        displayName: users.displayName,
        expiresAt: userSessions.expiresAt,
        idleTimeoutSeconds: userSessions.idleTimeoutSeconds,
        lastSeenAt: userSessions.lastSeenAt,
        role: workspaceMemberships.role,
        state: users.state,
        userId: users.id,
        username: users.username,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
      })
      .from(userSessions)
      .innerJoin(users, eq(users.id, userSessions.userId))
      .innerJoin(workspaces, eq(workspaces.id, userSessions.activeWorkspaceId))
      .innerJoin(
        workspaceMemberships,
        and(
          eq(workspaceMemberships.userId, users.id),
          eq(workspaceMemberships.workspaceId, workspaces.id),
        ),
      )
      .where(eq(userSessions.tokenDigest, tokenDigest))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const idleExpiresAt = new Date(
      row.lastSeenAt.getTime() + row.idleTimeoutSeconds * 1_000,
    );
    if (
      row.state !== "active"
      || row.expiresAt <= now
      || idleExpiresAt <= now
    ) {
      await this.database
        .delete(userSessions)
        .where(eq(userSessions.tokenDigest, tokenDigest));
      return null;
    }
    await this.database
      .update(userSessions)
      .set({ lastSeenAt: now })
      .where(eq(userSessions.tokenDigest, tokenDigest));
    return buildPrincipal(row, tokenDigest);
  }

  public async revokeSession(sessionToken: string): Promise<void> {
    await this.database
      .delete(userSessions)
      .where(eq(userSessions.tokenDigest, digestOpaqueToken(sessionToken)));
  }

  public async changePassword(
    principal: AuthenticatedPrincipal,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const rows = await this.database
      .select({ passwordHash: userPasswordCredentials.passwordHash })
      .from(userPasswordCredentials)
      .where(eq(userPasswordCredentials.userId, principal.userId))
      .limit(1);
    const credential = rows[0];
    if (
      credential === undefined
      || !await verifyPassword(credential.passwordHash, currentPassword)
    ) {
      throw new AuthenticationRejectedError();
    }
    const passwordHash = await hashPassword(newPassword);
    const now = this.now();
    await this.database.transaction(async (transaction) => {
      await transaction
        .update(userPasswordCredentials)
        .set({ passwordHash, updatedAt: now })
        .where(eq(userPasswordCredentials.userId, principal.userId));
      await transaction.delete(userSessions).where(and(
        eq(userSessions.userId, principal.userId),
        ne(userSessions.tokenDigest, principal.sessionTokenDigest),
      ));
    });
  }

  public async createWorkspaceMember(
    principal: AuthenticatedPrincipal,
    identity: NormalizedUserIdentity,
    role: WorkspaceRole = "member",
  ): Promise<WorkspaceMemberAddition> {
    requireAdministrator(principal);
    const setupToken = createOpaqueToken();
    const setupTokenDigest = digestOpaqueToken(setupToken);
    const userId = randomUUID();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + setupTokenLifetimeMs);
    try {
      const addition = await this.database.transaction(async (transaction) => {
        const existingUsers = await transaction
          .select({ id: users.id, state: users.state })
          .from(users)
          .where(eq(users.usernameNormalized, identity.usernameNormalized))
          .for("update")
          .limit(1);
        const existingUser = existingUsers[0];
        if (existingUser !== undefined) {
          if (existingUser.state === "suspended") {
            throw new UsernameUnavailableError();
          }
          await transaction.insert(workspaceMemberships).values({
            createdAt: now,
            role,
            updatedAt: now,
            userId: existingUser.id,
            workspaceId: principal.workspaceId,
          });
          return { kind: "existing" as const, userId: existingUser.id };
        }
        await transaction.insert(users).values({
          createdAt: now,
          displayName: identity.displayName,
          id: userId,
          state: "pending",
          updatedAt: now,
          username: identity.username,
          usernameNormalized: identity.usernameNormalized,
        });
        await transaction.insert(workspaceMemberships).values({
          createdAt: now,
          role,
          updatedAt: now,
          userId,
          workspaceId: principal.workspaceId,
        });
        await transaction.insert(userSetupTokens).values({
          createdAt: now,
          createdByUserId: principal.userId,
          expiresAt,
          tokenDigest: setupTokenDigest,
          userId,
        });
        return {
          expiresAt: expiresAt.toISOString(),
          kind: "setup" as const,
          setupToken,
          userId,
        };
      });
      return addition;
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        throw new UsernameUnavailableError();
      }
      throw error;
    }
  }

  public async listWorkspaceMembers(
    principal: AuthenticatedPrincipal,
  ): Promise<WorkspaceMember[]> {
    requireAdministrator(principal);
    const rows = await this.database
      .select({
        displayName: users.displayName,
        role: workspaceMemberships.role,
        state: users.state,
        userId: users.id,
        username: users.username,
      })
      .from(workspaceMemberships)
      .innerJoin(users, eq(users.id, workspaceMemberships.userId))
      .where(eq(workspaceMemberships.workspaceId, principal.workspaceId))
      .orderBy(asc(users.usernameNormalized), asc(users.id));
    return rows;
  }

  public async createPasswordReset(
    principal: AuthenticatedPrincipal,
    userId: string,
  ): Promise<PendingUserSetup> {
    requireAdministrator(principal);
    const setupToken = createOpaqueToken();
    const tokenDigest = digestOpaqueToken(setupToken);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + setupTokenLifetimeMs);
    await this.database.transaction(async (transaction) => {
      const membershipRows = await transaction
        .select({ state: users.state })
        .from(workspaceMemberships)
        .innerJoin(users, eq(users.id, workspaceMemberships.userId))
        .where(and(
          eq(workspaceMemberships.workspaceId, principal.workspaceId),
          eq(workspaceMemberships.userId, userId),
          eq(users.state, "active"),
        ))
        .for("update")
        .limit(1);
      if (membershipRows[0] === undefined) {
        throw new WorkspaceMemberNotFoundError();
      }
      await transaction
        .delete(userSetupTokens)
        .where(eq(userSetupTokens.userId, userId));
      await transaction.insert(userSetupTokens).values({
        createdAt: now,
        createdByUserId: principal.userId,
        expiresAt,
        tokenDigest,
        userId,
      });
    });
    return {
      expiresAt: expiresAt.toISOString(),
      setupToken,
      userId,
    };
  }

  public async removeWorkspaceMember(
    principal: AuthenticatedPrincipal,
    userId: string,
  ): Promise<void> {
    requireAdministrator(principal);
    await this.database.transaction(async (transaction) => {
      const membershipRows = await transaction
        .select({ role: workspaceMemberships.role, state: users.state })
        .from(workspaceMemberships)
        .innerJoin(users, eq(users.id, workspaceMemberships.userId))
        .where(and(
          eq(workspaceMemberships.workspaceId, principal.workspaceId),
          eq(workspaceMemberships.userId, userId),
        ))
        .for("update")
        .limit(1);
      const membership = membershipRows[0];
      if (membership === undefined) {
        throw new WorkspaceMemberNotFoundError();
      }
      if (membership.role === "admin") {
        await requireAnotherAdministrator(transaction, principal.workspaceId, userId);
      }
      await transaction.delete(userSessions).where(and(
        eq(userSessions.activeWorkspaceId, principal.workspaceId),
        eq(userSessions.userId, userId),
      ));
      await transaction.delete(workspaceMemberships).where(and(
        eq(workspaceMemberships.workspaceId, principal.workspaceId),
        eq(workspaceMemberships.userId, userId),
      ));
      if (membership.state === "pending") {
        const remainingRows = await transaction
          .select({ value: count(workspaceMemberships.userId) })
          .from(workspaceMemberships)
          .where(eq(workspaceMemberships.userId, userId));
        if ((remainingRows[0]?.value ?? 0) === 0) {
          await transaction.delete(users).where(eq(users.id, userId));
        }
      }
    });
  }

  public async changeWorkspaceMemberRole(
    principal: AuthenticatedPrincipal,
    userId: string,
    role: WorkspaceRole,
  ): Promise<void> {
    requireAdministrator(principal);
    await this.database.transaction(async (transaction) => {
      const membershipRows = await transaction
        .select({ role: workspaceMemberships.role })
        .from(workspaceMemberships)
        .where(and(
          eq(workspaceMemberships.workspaceId, principal.workspaceId),
          eq(workspaceMemberships.userId, userId),
        ))
        .for("update")
        .limit(1);
      const membership = membershipRows[0];
      if (membership === undefined) {
        throw new WorkspaceMemberNotFoundError();
      }
      if (membership.role === "admin" && role === "member") {
        await requireAnotherAdministrator(transaction, principal.workspaceId, userId);
      }
      await transaction
        .update(workspaceMemberships)
        .set({ role, updatedAt: this.now() })
        .where(and(
          eq(workspaceMemberships.workspaceId, principal.workspaceId),
          eq(workspaceMemberships.userId, userId),
        ));
    });
  }
}

function requireAdministrator(principal: AuthenticatedPrincipal): void {
  if (principal.role !== "admin") {
    throw new WorkspaceAuthorizationError();
  }
}

function buildPrincipal(row: {
  displayName: string;
  role: WorkspaceRole;
  userId: string;
  username: string;
  workspaceId: string;
  workspaceName: string;
}, sessionTokenDigest: string): AuthenticatedPrincipal {
  return {
    displayName: row.displayName,
    role: row.role,
    sessionTokenDigest,
    userId: row.userId,
    username: row.username,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("cause" in error)) {
    return false;
  }
  const cause = error.cause;
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return false;
  }
  return cause.code === "23505";
}

async function requireAnotherAdministrator(
  transaction: Parameters<Parameters<CiteLoomDatabase["transaction"]>[0]>[0],
  workspaceId: string,
  excludedUserId: string,
): Promise<void> {
  const administratorRows = await transaction
    .select({ userId: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .innerJoin(users, eq(users.id, workspaceMemberships.userId))
    .where(and(
      eq(workspaceMemberships.workspaceId, workspaceId),
      eq(workspaceMemberships.role, "admin"),
      eq(users.state, "active"),
    ))
    .for("update");
  const hasAnotherAdministrator = administratorRows.some((row) => {
    return row.userId !== excludedUserId;
  });
  if (!hasAnotherAdministrator) {
    throw new FinalWorkspaceAdministratorError();
  }
}
