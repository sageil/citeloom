import { randomUUID } from "node:crypto";

import { and, asc, count, eq, gt, ne } from "drizzle-orm";
import { z } from "zod";

import type {
  CiteLoomDatabase,
  CiteLoomDatabaseExecutor,
} from "../database/client.js";
import {
  applicationSettings,
  userPasswordCredentials,
  userSessions,
  userSetupTokens,
  users,
  sourceLibraries,
  workspaceAuditEvents,
  workspaceMemberships,
  workspaceSecurityPolicies,
  workspaceSettings,
  workspaces,
} from "../database/schema.js";
import {
  EMPTY_WORKSPACE_SETTINGS,
  parseStoredWorkspaceSettings,
  type StoredWorkspaceSettings,
} from "../workspaces/settings-persistence.js";
import type {
  AuthenticatedPrincipal,
  AuthenticationSession,
  PendingUserSetup,
  WorkspaceMember,
  WorkspaceMemberAddition,
  WorkspaceMembershipAccess,
  WorkspaceRole,
  WorkspaceSummary,
} from "./model.js";
import type {
  CreateWorkspaceInput,
  LoginInput,
  NormalizedUserIdentity,
  RenameWorkspaceInput,
} from "./boundary.js";
import {
  hashPassword,
  hashValidatedPassword,
  validatePassword,
  verifyPassword,
  type PasswordInput,
} from "./password.js";
import { createOpaqueToken, digestOpaqueToken } from "./token.js";
import {
  requireGlobalAdministrator,
  requireWorkspaceOrGlobalAdministrator,
} from "./authorization.js";
import {
  DEFAULT_WORKSPACE_SECURITY_POLICY,
  WorkspaceSecurityPolicyStore,
} from "./security-policy-store.js";

export {
  GlobalAuthorizationError,
  WorkspaceAuthorizationError,
} from "./authorization.js";

const sessionIdleLifetimeSeconds = 2 * 60 * 60;
const rememberedSessionIdleLifetimeSeconds = 7 * 24 * 60 * 60;
const sessionAbsoluteLifetimeMs = 12 * 60 * 60 * 1_000;
const rememberedSessionAbsoluteLifetimeMs = 30 * 24 * 60 * 60 * 1_000;
const dummyPasswordHash = hashPassword("invalid-password-placeholder");
const POSTGRES_UNIQUE_VIOLATION_CODE = "23505";
const WORKSPACE_NAME_UNIQUE_CONSTRAINT = "workspaces_name_normalized_idx";
const postgresConstraintErrorSchema = z.object({
  code: z.string(),
  constraint: z.string().min(1),
}).passthrough();

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

export class WorkspaceMemberAccessConflictError extends Error {
  public constructor() {
    super("You cannot disable your own access to the current workspace.");
    this.name = "WorkspaceMemberAccessConflictError";
  }
}

export class ProtectedGlobalAdministratorError extends Error {
  public constructor() {
    super("Global administrator workspace access cannot be reduced.");
    this.name = "ProtectedGlobalAdministratorError";
  }
}

export class WorkspaceNameUnavailableError extends Error {
  public constructor() {
    super("The requested workspace name is unavailable.");
    this.name = "WorkspaceNameUnavailableError";
  }
}

export class WorkspaceUnavailableError extends Error {
  public constructor() {
    super("The requested workspace is unavailable.");
    this.name = "WorkspaceUnavailableError";
  }
}

export class WorkspaceArchiveConflictError extends Error {
  public constructor() {
    super("Switch to another workspace before archiving this workspace.");
    this.name = "WorkspaceArchiveConflictError";
  }
}

export class WorkspaceConfigurationSourceUnavailableError extends Error {
  public constructor() {
    super("The workspace selected for copying is unavailable.");
    this.name = "WorkspaceConfigurationSourceUnavailableError";
  }
}

export class AuthenticationStore {
  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async completePasswordSetup(
    setupToken: string,
    password: PasswordInput,
  ): Promise<AuthenticationSession> {
    const tokenDigest = digestOpaqueToken(setupToken);
    const now = this.now();
    const tokenRows = await this.database
      .select({ userId: userSetupTokens.userId })
      .from(userSetupTokens)
      .where(and(
        eq(userSetupTokens.tokenDigest, tokenDigest),
        gt(userSetupTokens.expiresAt, now),
      ))
      .limit(1);
    const token = tokenRows[0];
    if (token === undefined) {
      throw new SetupTokenRejectedError();
    }
    const securityPolicy = new WorkspaceSecurityPolicyStore(
      this.database,
      this.now,
    );
    const passwordRequirements = await securityPolicy
      .readEffectivePasswordPolicy(token.userId);
    const validatedPassword = validatePassword(password, passwordRequirements);
    const passwordHash = await hashValidatedPassword(validatedPassword);
    const sessionToken = createOpaqueToken();
    const sessionTokenDigest = digestOpaqueToken(sessionToken);
    const expiresAt = new Date(now.getTime() + sessionAbsoluteLifetimeMs);

    const principal = await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          displayName: users.displayName,
          globalRole: users.globalRole,
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
          and(
            eq(workspaceMemberships.userId, users.id),
            eq(workspaceMemberships.workspaceId, userSetupTokens.workspaceId),
          ),
        )
        .innerJoin(workspaces, eq(workspaces.id, userSetupTokens.workspaceId))
        .where(and(
          eq(userSetupTokens.tokenDigest, tokenDigest),
          gt(userSetupTokens.expiresAt, now),
          eq(workspaceMemberships.access, "enabled"),
          eq(workspaces.state, "active"),
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
      const currentSecurityPolicy = new WorkspaceSecurityPolicyStore(
        transaction,
        this.now,
      );
      const currentPasswordRequirements = await currentSecurityPolicy
        .readEffectivePasswordPolicy(row.userId);
      validatePassword(password, currentPasswordRequirements);
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
        globalRole: users.globalRole,
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
      .where(and(
        eq(users.usernameNormalized, input.usernameNormalized),
        eq(workspaceMemberships.access, "enabled"),
        eq(workspaces.state, "active"),
      ))
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
        globalRole: users.globalRole,
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
      .where(and(
        eq(userSessions.tokenDigest, tokenDigest),
        eq(workspaceMemberships.access, "enabled"),
        eq(workspaces.state, "active"),
      ))
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

  public async createWorkspace(
    principal: AuthenticatedPrincipal,
    input: CreateWorkspaceInput,
  ): Promise<WorkspaceSummary> {
    requireGlobalAdministrator(principal);
    const workspaceId = randomUUID();
    const sourceLibraryId = randomUUID();
    const now = this.now();
    try {
      await this.database.transaction(async (transaction) => {
        const settings = await readInitialWorkspaceSettings(
          transaction,
          principal,
          input,
        );
        await transaction.insert(workspaces).values({
          createdAt: now,
          id: workspaceId,
          name: input.name,
          state: "active",
          updatedAt: now,
        });
        await transaction.insert(workspaceSecurityPolicies).values({
          workspaceId,
        });
        await transaction.insert(workspaceSettings).values({
          settings,
          updatedAt: now,
          updatedByUserId: principal.userId,
          version: 1,
          workspaceId,
        });
        await transaction.insert(sourceLibraries).values({
          createdAt: now,
          id: sourceLibraryId,
          kind: "private",
          name: null,
          ownerWorkspaceId: workspaceId,
          state: "active",
          updatedAt: now,
        });
        const administratorRows = await transaction
          .select({ userId: users.id })
          .from(users)
          .where(and(
            eq(users.globalRole, "global_admin"),
            eq(users.state, "active"),
          ));
        if (!administratorRows.some((administrator) => {
          return administrator.userId === principal.userId;
        })) {
          throw new WorkspaceUnavailableError();
        }
        await transaction.insert(workspaceMemberships).values(
          administratorRows.map((administrator) => ({
            access: "enabled" as const,
            createdAt: now,
            role: "admin" as const,
            updatedAt: now,
            userId: administrator.userId,
            workspaceId,
          })),
        );
        await transaction.insert(workspaceAuditEvents).values({
          actorUserId: principal.userId,
          createdAt: now,
          eventType: "workspace.created",
          id: randomUUID(),
          workspaceId,
        });
        const updatedSessions = await transaction
          .update(userSessions)
          .set({ activeWorkspaceId: workspaceId, lastSeenAt: now })
          .where(and(
            eq(userSessions.tokenDigest, principal.sessionTokenDigest),
            eq(userSessions.userId, principal.userId),
          ))
          .returning({ tokenDigest: userSessions.tokenDigest });
        if (updatedSessions[0] === undefined) {
          throw new WorkspaceUnavailableError();
        }
      });
    } catch (error: unknown) {
      const constraintName = readUniqueConstraintName(error);
      if (constraintName === WORKSPACE_NAME_UNIQUE_CONSTRAINT) {
        throw new WorkspaceNameUnavailableError();
      }
      throw error;
    }
    return {
      id: workspaceId,
      name: input.name,
      role: "admin",
    };
  }

  public async renameWorkspace(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
    input: RenameWorkspaceInput,
  ): Promise<void> {
    requireGlobalAdministrator(principal);
    const now = this.now();
    try {
      await this.database.transaction(async (transaction) => {
        const workspaceRows = await transaction
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(and(
            eq(workspaces.id, workspaceId),
            eq(workspaces.state, "active"),
          ))
          .for("update")
          .limit(1);
        if (workspaceRows[0] === undefined) {
          throw new WorkspaceUnavailableError();
        }
        await transaction
          .update(workspaces)
          .set({ name: input.name, updatedAt: now })
          .where(eq(workspaces.id, workspaceId));
        await transaction.insert(workspaceAuditEvents).values({
          actorUserId: principal.userId,
          createdAt: now,
          eventType: "workspace.renamed",
          id: randomUUID(),
          workspaceId,
        });
      });
    } catch (error: unknown) {
      const constraintName = readUniqueConstraintName(error);
      if (constraintName === WORKSPACE_NAME_UNIQUE_CONSTRAINT) {
        throw new WorkspaceNameUnavailableError();
      }
      throw error;
    }
  }

  public async archiveWorkspace(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
  ): Promise<void> {
    requireGlobalAdministrator(principal);
    if (workspaceId === principal.workspaceId) {
      throw new WorkspaceArchiveConflictError();
    }
    const now = this.now();
    await this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(and(
          eq(workspaces.id, workspaceId),
          eq(workspaces.state, "active"),
        ))
        .for("update")
        .limit(1);
      if (rows[0] === undefined) {
        throw new WorkspaceUnavailableError();
      }
      await transaction.insert(workspaceAuditEvents).values({
        actorUserId: principal.userId,
        createdAt: now,
        eventType: "workspace.archived",
        id: randomUUID(),
        workspaceId,
      });
      await transaction
        .update(sourceLibraries)
        .set({ state: "archived", updatedAt: now })
        .where(and(
          eq(sourceLibraries.kind, "private"),
          eq(sourceLibraries.ownerWorkspaceId, workspaceId),
        ));
      await transaction
        .delete(userSessions)
        .where(eq(userSessions.activeWorkspaceId, workspaceId));
      await transaction
        .update(workspaces)
        .set({ state: "archived", updatedAt: now })
        .where(eq(workspaces.id, workspaceId));
    });
  }

  public async listWorkspaces(
    principal: AuthenticatedPrincipal,
  ): Promise<WorkspaceSummary[]> {
    return this.database
      .select({
        id: workspaces.id,
        name: workspaces.name,
        role: workspaceMemberships.role,
      })
      .from(workspaceMemberships)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
      .where(and(
        eq(workspaceMemberships.access, "enabled"),
        eq(workspaceMemberships.userId, principal.userId),
        eq(workspaces.state, "active"),
      ))
      .orderBy(asc(workspaces.name), asc(workspaces.id));
  }

  public async switchWorkspace(
    principal: AuthenticatedPrincipal,
    workspaceId: string,
  ): Promise<AuthenticatedPrincipal> {
    const rows = await this.database
      .select({
        displayName: users.displayName,
        globalRole: users.globalRole,
        role: workspaceMemberships.role,
        state: users.state,
        userId: users.id,
        username: users.username,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
      })
      .from(users)
      .innerJoin(
        workspaceMemberships,
        eq(workspaceMemberships.userId, users.id),
      )
      .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
      .where(and(
        eq(users.id, principal.userId),
        eq(users.state, "active"),
        eq(workspaceMemberships.access, "enabled"),
        eq(workspaces.id, workspaceId),
        eq(workspaces.state, "active"),
      ))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new WorkspaceUnavailableError();
    }
    const updated = await this.database
      .update(userSessions)
      .set({ activeWorkspaceId: workspaceId, lastSeenAt: this.now() })
      .where(and(
        eq(userSessions.tokenDigest, principal.sessionTokenDigest),
        eq(userSessions.userId, principal.userId),
      ))
      .returning({ tokenDigest: userSessions.tokenDigest });
    if (updated[0] === undefined) {
      throw new WorkspaceUnavailableError();
    }
    return buildPrincipal(row, principal.sessionTokenDigest);
  }

  public async changePassword(
    principal: AuthenticatedPrincipal,
    currentPassword: string,
    newPassword: PasswordInput,
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
    const securityPolicy = new WorkspaceSecurityPolicyStore(
      this.database,
      this.now,
    );
    const passwordRequirements = await securityPolicy
      .readEffectivePasswordPolicy(principal.userId);
    const validatedPassword = validatePassword(newPassword, passwordRequirements);
    const passwordHash = await hashValidatedPassword(validatedPassword);
    const now = this.now();
    await this.database.transaction(async (transaction) => {
      const currentSecurityPolicy = new WorkspaceSecurityPolicyStore(
        transaction,
        this.now,
      );
      const currentPasswordRequirements = await currentSecurityPolicy
        .readEffectivePasswordPolicy(principal.userId);
      validatePassword(newPassword, currentPasswordRequirements);
      const updatedCredentials = await transaction
        .update(userPasswordCredentials)
        .set({ passwordHash, updatedAt: now })
        .where(and(
          eq(userPasswordCredentials.userId, principal.userId),
          eq(userPasswordCredentials.passwordHash, credential.passwordHash),
        ))
        .returning({ userId: userPasswordCredentials.userId });
      if (updatedCredentials[0] === undefined) {
        throw new AuthenticationRejectedError();
      }
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
    try {
      const addition = await this.database.transaction(async (transaction) => {
        const resetLinkLifetimeSeconds = await readResetLinkLifetimeSecondsForIssue(
          transaction,
          principal.workspaceId,
        );
        const expiresAt = new Date(
          now.getTime() + resetLinkLifetimeSeconds * 1_000,
        );
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
            access: "enabled",
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
          access: "enabled",
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
          workspaceId: principal.workspaceId,
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
        access: workspaceMemberships.access,
        displayName: users.displayName,
        globalRole: users.globalRole,
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
    const expiresAt = await this.database.transaction(async (transaction) => {
      const resetLinkLifetimeSeconds = await readResetLinkLifetimeSecondsForIssue(
        transaction,
        principal.workspaceId,
      );
      const resetExpiresAt = new Date(
        now.getTime() + resetLinkLifetimeSeconds * 1_000,
      );
      const membershipRows = await transaction
        .select({ state: users.state })
        .from(workspaceMemberships)
        .innerJoin(users, eq(users.id, workspaceMemberships.userId))
        .where(and(
          eq(workspaceMemberships.access, "enabled"),
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
        expiresAt: resetExpiresAt,
        tokenDigest,
        userId,
        workspaceId: principal.workspaceId,
      });
      return resetExpiresAt;
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
        .select({
          access: workspaceMemberships.access,
          globalRole: users.globalRole,
          role: workspaceMemberships.role,
          state: users.state,
        })
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
      if (membership.globalRole === "global_admin") {
        throw new ProtectedGlobalAdministratorError();
      }
      if (membership.access === "enabled" && membership.role === "admin") {
        await requireAnotherAdministrator(transaction, principal.workspaceId, userId);
      }
      await transaction.delete(userSessions).where(and(
        eq(userSessions.activeWorkspaceId, principal.workspaceId),
        eq(userSessions.userId, userId),
      ));
      await transaction.delete(userSetupTokens).where(and(
        eq(userSetupTokens.workspaceId, principal.workspaceId),
        eq(userSetupTokens.userId, userId),
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
        .select({
          access: workspaceMemberships.access,
          globalRole: users.globalRole,
          role: workspaceMemberships.role,
        })
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
      if (membership.globalRole === "global_admin" && role !== "admin") {
        throw new ProtectedGlobalAdministratorError();
      }
      if (
        membership.access === "enabled"
        && membership.role === "admin"
        && role === "member"
      ) {
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

  public async changeWorkspaceMemberAccess(
    principal: AuthenticatedPrincipal,
    userId: string,
    access: WorkspaceMembershipAccess,
  ): Promise<void> {
    requireAdministrator(principal);
    if (userId === principal.userId && access === "disabled") {
      throw new WorkspaceMemberAccessConflictError();
    }
    await this.database.transaction(async (transaction) => {
      const membershipRows = await transaction
        .select({
          access: workspaceMemberships.access,
          globalRole: users.globalRole,
          role: workspaceMemberships.role,
          state: users.state,
        })
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
      if (membership.access === access) {
        return;
      }
      if (
        membership.globalRole === "global_admin"
        && access === "disabled"
      ) {
        throw new ProtectedGlobalAdministratorError();
      }
      if (
        access === "disabled"
        && membership.access === "enabled"
        && membership.role === "admin"
        && membership.state === "active"
      ) {
        await requireAnotherAdministrator(
          transaction,
          principal.workspaceId,
          userId,
        );
      }
      await transaction
        .update(workspaceMemberships)
        .set({ access, updatedAt: this.now() })
        .where(and(
          eq(workspaceMemberships.workspaceId, principal.workspaceId),
          eq(workspaceMemberships.userId, userId),
        ));
      if (access === "disabled") {
        await transaction.delete(userSessions).where(and(
          eq(userSessions.activeWorkspaceId, principal.workspaceId),
          eq(userSessions.userId, userId),
        ));
      }
    });
  }
}

async function readResetLinkLifetimeSecondsForIssue(
  database: CiteLoomDatabaseExecutor,
  workspaceId: string,
): Promise<number> {
  const rows = await database
    .select({
      resetLinkLifetimeSeconds: workspaceSecurityPolicies.resetLinkLifetimeSeconds,
    })
    .from(workspaceSecurityPolicies)
    .where(eq(workspaceSecurityPolicies.workspaceId, workspaceId))
    .for("share")
    .limit(1);
  return rows[0]?.resetLinkLifetimeSeconds
    ?? DEFAULT_WORKSPACE_SECURITY_POLICY.resetLinkLifetimeSeconds;
}

async function readInitialWorkspaceSettings(
  transaction: Parameters<Parameters<CiteLoomDatabase["transaction"]>[0]>[0],
  principal: AuthenticatedPrincipal,
  input: CreateWorkspaceInput,
): Promise<StoredWorkspaceSettings> {
  if (input.configuration.kind === "organization-defaults") {
    return structuredClone(EMPTY_WORKSPACE_SETTINGS);
  }
  const applicationRows = await transaction
    .select({ id: applicationSettings.id })
    .from(applicationSettings)
    .limit(1)
    .for("share");
  if (applicationRows[0] === undefined) {
    throw new Error("The database does not contain application settings.");
  }
  const rows = await transaction
    .select({ settings: workspaceSettings.settings })
    .from(workspaceSettings)
    .innerJoin(
      workspaceMemberships,
      and(
        eq(workspaceMemberships.access, "enabled"),
        eq(workspaceMemberships.workspaceId, workspaceSettings.workspaceId),
        eq(workspaceMemberships.userId, principal.userId),
      ),
    )
    .innerJoin(
      workspaces,
      and(
        eq(workspaces.id, workspaceSettings.workspaceId),
        eq(workspaces.state, "active"),
      ),
    )
    .where(eq(workspaceSettings.workspaceId, input.configuration.workspaceId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new WorkspaceConfigurationSourceUnavailableError();
  }
  return parseStoredWorkspaceSettings(row.settings);
}

function requireAdministrator(principal: AuthenticatedPrincipal): void {
  requireWorkspaceOrGlobalAdministrator(principal);
}

function buildPrincipal(row: {
  displayName: string;
  globalRole: AuthenticatedPrincipal["globalRole"];
  role: WorkspaceRole;
  userId: string;
  username: string;
  workspaceId: string;
  workspaceName: string;
}, sessionTokenDigest: string): AuthenticatedPrincipal {
  return {
    dataScope: "workspace",
    displayName: row.displayName,
    globalRole: row.globalRole,
    role: row.role,
    sessionTokenDigest,
    userId: row.userId,
    username: row.username,
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
  };
}

function readUniqueConstraintName(error: unknown): string | null {
  const databaseError = decodeDatabaseConstraintError(error);
  if (databaseError?.code !== POSTGRES_UNIQUE_VIOLATION_CODE) {
    return null;
  }
  return databaseError.constraint;
}

function decodeDatabaseConstraintError(
  error: unknown,
): z.output<typeof postgresConstraintErrorSchema> | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const decoded = postgresConstraintErrorSchema.safeParse(error.cause);
  return decoded.success ? decoded.data : null;
}

function isUniqueConstraintError(error: unknown): boolean {
  return readUniqueConstraintName(error) !== null;
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
      eq(workspaceMemberships.access, "enabled"),
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
