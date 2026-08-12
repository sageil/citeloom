import { randomUUID } from "node:crypto";

import { and, asc, count, desc, eq, gt } from "drizzle-orm";

import type { CiteLoomDatabaseExecutor } from "../database/client.js";
import { DEFAULT_WORKSPACE_SECURITY_POLICY } from "../domain/security-policy-defaults.js";
import {
  userSetupTokens,
  users,
  workspaceMemberships,
  workspaceSecurityPolicies,
  workspaceSecurityPolicyChanges,
  workspaces,
} from "../database/schema.js";
import type { UpdateWorkspaceSecurityPolicyInput } from "./boundary.js";
import type {
  AuthenticatedPrincipal,
  WorkspacePasswordPolicy,
  WorkspaceSecurityAdministrator,
  WorkspaceSecurityOverview,
  WorkspaceSecurityPolicy,
} from "./model.js";
import { requireWorkspaceAdministrator } from "./authorization.js";

const recentPolicyChangeLimit = 10;

export { DEFAULT_WORKSPACE_SECURITY_POLICY } from "../domain/security-policy-defaults.js";

export class SecurityPolicyVersionConflictError extends Error {
  public constructor() {
    super("The security policy changed after this page was loaded. Refresh and try again.");
    this.name = "SecurityPolicyVersionConflictError";
  }
}

export class WorkspaceSecurityPolicyStore {
  public constructor(
    private readonly database: CiteLoomDatabaseExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async readEffectivePasswordPolicy(
    userId: string,
  ): Promise<WorkspacePasswordPolicy> {
    const rows = await this.database
      .select({
        minimumPasswordLength: workspaceSecurityPolicies.minimumPasswordLength,
        requireLetterAndNumber: workspaceSecurityPolicies.requireLetterAndNumber,
        requireSpecialCharacter: workspaceSecurityPolicies.requireSpecialCharacter,
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
      ));

    const effectivePolicy: WorkspacePasswordPolicy = {
      minimumPasswordLength: 0,
      requireLetterAndNumber: false,
      requireSpecialCharacter: false,
    };
    for (const row of rows) {
      const minimumPasswordLength = row.minimumPasswordLength
        ?? DEFAULT_WORKSPACE_SECURITY_POLICY.minimumPasswordLength;
      effectivePolicy.minimumPasswordLength = Math.max(
        effectivePolicy.minimumPasswordLength,
        minimumPasswordLength,
      );
      effectivePolicy.requireLetterAndNumber ||= row.requireLetterAndNumber
        ?? DEFAULT_WORKSPACE_SECURITY_POLICY.requireLetterAndNumber;
      effectivePolicy.requireSpecialCharacter ||= row.requireSpecialCharacter
        ?? DEFAULT_WORKSPACE_SECURITY_POLICY.requireSpecialCharacter;
    }
    if (effectivePolicy.minimumPasswordLength === 0) {
      effectivePolicy.minimumPasswordLength = DEFAULT_WORKSPACE_SECURITY_POLICY
        .minimumPasswordLength;
    }
    return effectivePolicy;
  }

  public async readOverview(
    principal: AuthenticatedPrincipal,
  ): Promise<WorkspaceSecurityOverview> {
    requireWorkspaceAdministrator(principal, principal.workspaceId);
    return this.readOverviewForWorkspace(principal.workspaceId);
  }

  public async readPasswordPolicy(
    principal: AuthenticatedPrincipal,
  ): Promise<WorkspacePasswordPolicy> {
    return this.readEffectivePasswordPolicy(principal.userId);
  }

  public async update(
    principal: AuthenticatedPrincipal,
    input: UpdateWorkspaceSecurityPolicyInput,
  ): Promise<WorkspaceSecurityOverview> {
    requireWorkspaceAdministrator(principal, principal.workspaceId);
    const now = this.now();
    await this.database.transaction(async (transaction) => {
      await transaction.insert(workspaceSecurityPolicies).values({
        minimumPasswordLength: DEFAULT_WORKSPACE_SECURITY_POLICY.minimumPasswordLength,
        requireLetterAndNumber: DEFAULT_WORKSPACE_SECURITY_POLICY.requireLetterAndNumber,
        requireSpecialCharacter: DEFAULT_WORKSPACE_SECURITY_POLICY.requireSpecialCharacter,
        resetLinkLifetimeSeconds: DEFAULT_WORKSPACE_SECURITY_POLICY.resetLinkLifetimeSeconds,
        updatedAt: now,
        version: DEFAULT_WORKSPACE_SECURITY_POLICY.version,
        workspaceId: principal.workspaceId,
      }).onConflictDoNothing();

      const policyRows = await transaction
        .select()
        .from(workspaceSecurityPolicies)
        .where(eq(workspaceSecurityPolicies.workspaceId, principal.workspaceId))
        .for("update")
        .limit(1);
      const current = policyRows[0];
      if (current === undefined) {
        throw new Error("The workspace security policy could not be initialized.");
      }
      if (current.version !== input.expectedVersion) {
        throw new SecurityPolicyVersionConflictError();
      }

      let revokedResetLinkCount = 0;
      if (input.invalidateOutstandingResetLinks) {
        const revoked = await transaction
          .delete(userSetupTokens)
          .where(and(
            eq(userSetupTokens.workspaceId, principal.workspaceId),
            gt(userSetupTokens.expiresAt, now),
          ))
          .returning({ tokenDigest: userSetupTokens.tokenDigest });
        revokedResetLinkCount = revoked.length;
      }

      const policyChanged = current.minimumPasswordLength !== input.minimumPasswordLength
        || current.requireLetterAndNumber !== input.requireLetterAndNumber
        || current.requireSpecialCharacter !== input.requireSpecialCharacter
        || current.resetLinkLifetimeSeconds !== input.resetLinkLifetimeSeconds;
      if (!policyChanged && revokedResetLinkCount === 0) {
        return;
      }

      await transaction
        .update(workspaceSecurityPolicies)
        .set({
          minimumPasswordLength: input.minimumPasswordLength,
          requireLetterAndNumber: input.requireLetterAndNumber,
          requireSpecialCharacter: input.requireSpecialCharacter,
          resetLinkLifetimeSeconds: input.resetLinkLifetimeSeconds,
          updatedAt: now,
          updatedByUserId: principal.userId,
          version: current.version + 1,
        })
        .where(eq(workspaceSecurityPolicies.workspaceId, principal.workspaceId));

      await transaction.insert(workspaceSecurityPolicyChanges).values({
        changedAt: now,
        changedByUserId: principal.userId,
        id: randomUUID(),
        minimumPasswordLength: input.minimumPasswordLength,
        previousMinimumPasswordLength: current.minimumPasswordLength,
        previousRequireLetterAndNumber: current.requireLetterAndNumber,
        previousRequireSpecialCharacter: current.requireSpecialCharacter,
        previousResetLinkLifetimeSeconds: current.resetLinkLifetimeSeconds,
        requireLetterAndNumber: input.requireLetterAndNumber,
        requireSpecialCharacter: input.requireSpecialCharacter,
        resetLinkLifetimeSeconds: input.resetLinkLifetimeSeconds,
        revokedResetLinkCount,
        workspaceId: principal.workspaceId,
      });
    });
    return this.readOverviewForWorkspace(principal.workspaceId);
  }

  private async readOverviewForWorkspace(
    workspaceId: string,
  ): Promise<WorkspaceSecurityOverview> {
    const now = this.now();
    const [policy, administrators, resetLinkCounts, recentChanges] = await Promise.all([
      readWorkspaceSecurityPolicy(this.database, workspaceId),
      this.database
        .select({
          displayName: users.displayName,
          role: workspaceMemberships.role,
          state: users.state,
          userId: users.id,
          username: users.username,
        })
        .from(workspaceMemberships)
        .innerJoin(users, eq(users.id, workspaceMemberships.userId))
        .where(and(
          eq(workspaceMemberships.access, "enabled"),
          eq(workspaceMemberships.workspaceId, workspaceId),
          eq(workspaceMemberships.role, "admin"),
        ))
        .orderBy(asc(users.usernameNormalized), asc(users.id)),
      this.database
        .select({ value: count(userSetupTokens.tokenDigest) })
        .from(userSetupTokens)
        .where(and(
          eq(userSetupTokens.workspaceId, workspaceId),
          gt(userSetupTokens.expiresAt, now),
        )),
      this.database
        .select({
          changedAt: workspaceSecurityPolicyChanges.changedAt,
          changedByDisplayName: users.displayName,
          changedByUsername: users.username,
          id: workspaceSecurityPolicyChanges.id,
          minimumPasswordLength: workspaceSecurityPolicyChanges.minimumPasswordLength,
          requireLetterAndNumber: workspaceSecurityPolicyChanges.requireLetterAndNumber,
          requireSpecialCharacter: workspaceSecurityPolicyChanges.requireSpecialCharacter,
          resetLinkLifetimeSeconds: workspaceSecurityPolicyChanges.resetLinkLifetimeSeconds,
          revokedResetLinkCount: workspaceSecurityPolicyChanges.revokedResetLinkCount,
        })
        .from(workspaceSecurityPolicyChanges)
        .leftJoin(users, eq(users.id, workspaceSecurityPolicyChanges.changedByUserId))
        .where(eq(workspaceSecurityPolicyChanges.workspaceId, workspaceId))
        .orderBy(desc(workspaceSecurityPolicyChanges.changedAt))
        .limit(recentPolicyChangeLimit),
    ]);

    const normalizedAdministrators: WorkspaceSecurityAdministrator[] = [];
    for (const administrator of administrators) {
      normalizedAdministrators.push({
        displayName: administrator.displayName,
        role: "admin",
        state: administrator.state,
        userId: administrator.userId,
        username: administrator.username,
      });
    }

    return {
      activeResetLinkCount: resetLinkCounts[0]?.value ?? 0,
      administrators: normalizedAdministrators,
      policy,
      recentChanges: recentChanges.map((change) => ({
        ...change,
        changedAt: change.changedAt.toISOString(),
      })),
    };
  }
}

async function readWorkspaceSecurityPolicy(
  database: CiteLoomDatabaseExecutor,
  workspaceId: string,
): Promise<WorkspaceSecurityPolicy> {
  const rows = await database
    .select({
      minimumPasswordLength: workspaceSecurityPolicies.minimumPasswordLength,
      requireLetterAndNumber: workspaceSecurityPolicies.requireLetterAndNumber,
      requireSpecialCharacter: workspaceSecurityPolicies.requireSpecialCharacter,
      resetLinkLifetimeSeconds: workspaceSecurityPolicies.resetLinkLifetimeSeconds,
      updatedAt: workspaceSecurityPolicies.updatedAt,
      version: workspaceSecurityPolicies.version,
    })
    .from(workspaceSecurityPolicies)
    .where(eq(workspaceSecurityPolicies.workspaceId, workspaceId))
    .limit(1);
  const row = rows[0];
  if (row !== undefined) {
    return {
      ...row,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  return {
    ...DEFAULT_WORKSPACE_SECURITY_POLICY,
    updatedAt: new Date(0).toISOString(),
  };
}
