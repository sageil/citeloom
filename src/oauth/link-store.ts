import { and, asc, eq, or } from "drizzle-orm";

import { requireGlobalAdministrator } from "../auth/authorization.js";
import type { AuthenticatedPrincipal } from "../auth/model.js";
import type { CiteLoomDatabase } from "../database/client.js";
import { readUniqueConstraintName } from "../database/errors.js";
import {
  oauthUserIdentityLinks,
  oauthWorkspaceLinks,
  users,
  workspaceMemberships,
  workspaces,
} from "../database/schema.js";
import type {
  OAuthPrincipal,
  OAuthSecurityOverview,
  VerifiedOAuthAccessToken,
} from "./model.js";
import {
  OAuthConfigurationStore,
  readConfiguredOAuthIssuerForUpdate,
  readEnabledOAuthConfigForUpdate,
} from "./configuration-store.js";

const USER_IDENTITY_PRIMARY_KEY =
  "oauth_user_identity_links_issuer_subject_pk";
const USER_IDENTITY_USER_UNIQUE_KEY =
  "oauth_user_identity_links_issuer_user_idx";
const WORKSPACE_PRIMARY_KEY =
  "oauth_workspace_links_issuer_external_workspace_id_pk";
const WORKSPACE_UNIQUE_KEY = "oauth_workspace_links_issuer_workspace_idx";

export class OAuthLinkConflictError extends Error {
  public constructor() {
    super("That OAuth identity or workspace is already linked.");
    this.name = "OAuthLinkConflictError";
  }
}

export class OAuthLinkTargetUnavailableError extends Error {
  public constructor(target: "user" | "workspace") {
    super(`The OAuth ${target} link target is unavailable.`);
    this.name = "OAuthLinkTargetUnavailableError";
  }
}

export class OAuthPrincipalUnavailableError extends Error {
  public constructor() {
    super("The OAuth identity is not authorized for this CiteLoom workspace.");
    this.name = "OAuthPrincipalUnavailableError";
  }
}

export class OAuthLinkStore {
  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async readOverview(
    principal: AuthenticatedPrincipal,
    publicOrigin: string,
  ): Promise<OAuthSecurityOverview> {
    requireGlobalAdministrator(principal);
    const configuration = await new OAuthConfigurationStore(
      this.database,
      this.now,
    ).read(publicOrigin);
    if (configuration.issuer === null) {
      return {
        configuration,
        userIdentityLinks: [],
        workspaceLinks: [],
      };
    }
    const issuer = configuration.issuer;
    const [identityRows, workspaceRows] = await Promise.all([
      this.database
        .select({
          createdAt: oauthUserIdentityLinks.createdAt,
          displayName: users.displayName,
          subject: oauthUserIdentityLinks.subject,
          userState: users.state,
          userId: users.id,
          username: users.username,
        })
        .from(oauthUserIdentityLinks)
        .innerJoin(users, eq(users.id, oauthUserIdentityLinks.userId))
        .where(eq(oauthUserIdentityLinks.issuer, issuer))
        .orderBy(asc(users.usernameNormalized), asc(users.id)),
      this.database
        .select({
          createdAt: oauthWorkspaceLinks.createdAt,
          externalWorkspaceId: oauthWorkspaceLinks.externalWorkspaceId,
          workspaceId: workspaces.id,
          workspaceName: workspaces.name,
          workspaceState: workspaces.state,
        })
        .from(oauthWorkspaceLinks)
        .innerJoin(workspaces, eq(workspaces.id, oauthWorkspaceLinks.workspaceId))
        .where(eq(oauthWorkspaceLinks.issuer, issuer))
        .orderBy(asc(workspaces.name), asc(workspaces.id)),
    ]);
    const userIdentityLinks: OAuthSecurityOverview["userIdentityLinks"] = [];
    for (const row of identityRows) {
      userIdentityLinks.push({
        ...row,
        createdAt: row.createdAt.toISOString(),
      });
    }
    const workspaceLinks: OAuthSecurityOverview["workspaceLinks"] = [];
    for (const row of workspaceRows) {
      workspaceLinks.push({
        ...row,
        createdAt: row.createdAt.toISOString(),
      });
    }
    return { configuration, userIdentityLinks, workspaceLinks };
  }

  public async linkUserIdentity(
    principal: AuthenticatedPrincipal,
    publicOrigin: string,
    userId: string,
    subject: string,
  ): Promise<void> {
    requireGlobalAdministrator(principal);
    const now = this.now();
    try {
      await this.database.transaction(async (transaction) => {
        const config = await readEnabledOAuthConfigForUpdate(
          transaction,
          publicOrigin,
        );
        const userRows = await transaction
          .select({ state: users.state })
          .from(users)
          .where(eq(users.id, userId))
          .for("update")
          .limit(1);
        const user = userRows[0];
        if (user === undefined || user.state === "suspended") {
          throw new OAuthLinkTargetUnavailableError("user");
        }
        const insertedRows = await transaction
          .insert(oauthUserIdentityLinks)
          .values({
            createdAt: now,
            createdByUserId: principal.userId,
            issuer: config.issuer,
            subject,
            userId,
          })
          .onConflictDoNothing()
          .returning({ userId: oauthUserIdentityLinks.userId });
        if (insertedRows[0] === undefined) {
          const existingRows = await transaction
            .select({
              subject: oauthUserIdentityLinks.subject,
              userId: oauthUserIdentityLinks.userId,
            })
            .from(oauthUserIdentityLinks)
            .where(and(
              eq(oauthUserIdentityLinks.issuer, config.issuer),
              or(
                eq(oauthUserIdentityLinks.subject, subject),
                eq(oauthUserIdentityLinks.userId, userId),
              ),
            ));
          const exactLinkExists = existingRows.some((row) => {
            return row.subject === subject && row.userId === userId;
          });
          if (!exactLinkExists) {
            throw new OAuthLinkConflictError();
          }
        }
        if (user.state === "pending") {
          await transaction
            .update(users)
            .set({ state: "active", updatedAt: now })
            .where(eq(users.id, userId));
        }
      });
    } catch (error: unknown) {
      throw mapOAuthLinkConflict(error);
    }
  }

  public async unlinkUserIdentity(
    principal: AuthenticatedPrincipal,
    publicOrigin: string,
    userId: string,
  ): Promise<void> {
    requireGlobalAdministrator(principal);
    await this.database.transaction(async (transaction) => {
      const issuer = await readConfiguredOAuthIssuerForUpdate(
        transaction,
        publicOrigin,
      );
      await transaction
        .delete(oauthUserIdentityLinks)
        .where(and(
          eq(oauthUserIdentityLinks.issuer, issuer),
          eq(oauthUserIdentityLinks.userId, userId),
        ));
    });
  }

  public async linkWorkspace(
    principal: AuthenticatedPrincipal,
    publicOrigin: string,
    workspaceId: string,
    externalWorkspaceId: string,
  ): Promise<void> {
    requireGlobalAdministrator(principal);
    try {
      await this.database.transaction(async (transaction) => {
        const config = await readEnabledOAuthConfigForUpdate(
          transaction,
          publicOrigin,
        );
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
          throw new OAuthLinkTargetUnavailableError("workspace");
        }
        const insertedRows = await transaction
          .insert(oauthWorkspaceLinks)
          .values({
            createdAt: this.now(),
            createdByUserId: principal.userId,
            externalWorkspaceId,
            issuer: config.issuer,
            workspaceId,
          })
          .onConflictDoNothing()
          .returning({ workspaceId: oauthWorkspaceLinks.workspaceId });
        if (insertedRows[0] === undefined) {
          const existingRows = await transaction
            .select({
              externalWorkspaceId: oauthWorkspaceLinks.externalWorkspaceId,
              workspaceId: oauthWorkspaceLinks.workspaceId,
            })
            .from(oauthWorkspaceLinks)
            .where(and(
              eq(oauthWorkspaceLinks.issuer, config.issuer),
              or(
                eq(
                  oauthWorkspaceLinks.externalWorkspaceId,
                  externalWorkspaceId,
                ),
                eq(oauthWorkspaceLinks.workspaceId, workspaceId),
              ),
            ));
          const exactLinkExists = existingRows.some((row) => {
            return row.externalWorkspaceId === externalWorkspaceId
              && row.workspaceId === workspaceId;
          });
          if (!exactLinkExists) {
            throw new OAuthLinkConflictError();
          }
        }
      });
    } catch (error: unknown) {
      throw mapOAuthLinkConflict(error);
    }
  }

  public async unlinkWorkspace(
    principal: AuthenticatedPrincipal,
    publicOrigin: string,
    workspaceId: string,
  ): Promise<void> {
    requireGlobalAdministrator(principal);
    await this.database.transaction(async (transaction) => {
      const issuer = await readConfiguredOAuthIssuerForUpdate(
        transaction,
        publicOrigin,
      );
      await transaction
        .delete(oauthWorkspaceLinks)
        .where(and(
          eq(oauthWorkspaceLinks.issuer, issuer),
          eq(oauthWorkspaceLinks.workspaceId, workspaceId),
        ));
    });
  }

  public async resolvePrincipal(
    token: VerifiedOAuthAccessToken,
  ): Promise<OAuthPrincipal> {
    const rows = await this.database
      .select({
        displayName: users.displayName,
        role: workspaceMemberships.role,
        userId: users.id,
        username: users.username,
        workspaceId: workspaces.id,
        workspaceName: workspaces.name,
      })
      .from(oauthUserIdentityLinks)
      .innerJoin(users, eq(users.id, oauthUserIdentityLinks.userId))
      .innerJoin(
        oauthWorkspaceLinks,
        and(
          eq(oauthWorkspaceLinks.issuer, oauthUserIdentityLinks.issuer),
          eq(
            oauthWorkspaceLinks.externalWorkspaceId,
            token.workspaceExternalId,
          ),
        ),
      )
      .innerJoin(workspaces, eq(workspaces.id, oauthWorkspaceLinks.workspaceId))
      .innerJoin(
        workspaceMemberships,
        and(
          eq(workspaceMemberships.userId, users.id),
          eq(workspaceMemberships.workspaceId, workspaces.id),
        ),
      )
      .where(and(
        eq(oauthUserIdentityLinks.issuer, token.issuer),
        eq(oauthUserIdentityLinks.subject, token.subject),
        eq(users.state, "active"),
        eq(workspaceMemberships.access, "enabled"),
        eq(workspaces.state, "active"),
      ))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new OAuthPrincipalUnavailableError();
    }
    return {
      dataScope: "workspace",
      ...row,
      globalRole: "standard",
      issuer: token.issuer,
      scopes: [...token.scopes],
      subject: token.subject,
      workspaceExternalId: token.workspaceExternalId,
    };
  }
}

function mapOAuthLinkConflict(error: unknown): unknown {
  const constraint = readUniqueConstraintName(error);
  if (
    constraint === USER_IDENTITY_PRIMARY_KEY
    || constraint === USER_IDENTITY_USER_UNIQUE_KEY
    || constraint === WORKSPACE_PRIMARY_KEY
    || constraint === WORKSPACE_UNIQUE_KEY
  ) {
    return new OAuthLinkConflictError();
  }
  return error;
}
