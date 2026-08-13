import { and, asc, eq, ne, or } from "drizzle-orm";

import { requireGlobalAdministrator } from "../auth/authorization.js";
import type { AuthorizationPrincipal } from "../auth/model.js";
import type { CiteLoomDatabase } from "../database/client.js";
import { readUniqueConstraintName } from "../database/errors.js";
import {
  authenticationSettings,
  oauthUserIdentityLinks,
  users,
  workspaceMemberships,
  workspaces,
} from "../database/schema.js";
import { readStoredOAuthApplicationConfiguration } from "./application-configuration.js";

const AUTHENTICATION_SETTINGS_ID = "application";

const USER_IDENTITY_PRIMARY_KEY =
  "oauth_user_identity_links_issuer_subject_pk";
const USER_IDENTITY_USER_UNIQUE_KEY =
  "oauth_user_identity_links_issuer_user_idx";

export interface OAuthUserIdentityLink {
  createdAt: string;
  displayName: string;
  subject: string;
  userId: string;
  username: string;
  userState: "active" | "pending" | "suspended";
}

export class OAuthIdentityLinkConflictError extends Error {
  public constructor() {
    super("That OAuth identity or user is already linked.");
    this.name = "OAuthIdentityLinkConflictError";
  }
}

export class OAuthIdentityLinkTargetUnavailableError extends Error {
  public constructor() {
    super("The OAuth user link target is unavailable.");
    this.name = "OAuthIdentityLinkTargetUnavailableError";
  }
}

export class OAuthIdentityLinkRemovalRejectedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OAuthIdentityLinkRemovalRejectedError";
  }
}

export class OAuthIdentityLinkStore {
  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async list(
    principal: AuthorizationPrincipal,
    issuer: string,
  ): Promise<OAuthUserIdentityLink[]> {
    requireGlobalAdministrator(principal);
    const rows = await this.database
      .select({
        createdAt: oauthUserIdentityLinks.createdAt,
        displayName: users.displayName,
        subject: oauthUserIdentityLinks.subject,
        userId: users.id,
        username: users.username,
        userState: users.state,
      })
      .from(oauthUserIdentityLinks)
      .innerJoin(users, eq(users.id, oauthUserIdentityLinks.userId))
      .where(eq(oauthUserIdentityLinks.issuer, issuer))
      .orderBy(asc(users.usernameNormalized), asc(users.id));
    const links: OAuthUserIdentityLink[] = [];
    for (const row of rows) {
      links.push({ ...row, createdAt: row.createdAt.toISOString() });
    }
    return links;
  }

  public async link(
    principal: AuthorizationPrincipal,
    issuer: string,
    userId: string,
    subject: string,
  ): Promise<void> {
    requireGlobalAdministrator(principal);
    const now = this.now();
    try {
      await this.database.transaction(async (transaction) => {
        const userRows = await transaction
          .select({ state: users.state })
          .from(users)
          .where(eq(users.id, userId))
          .for("update")
          .limit(1);
        const user = userRows[0];
        if (user === undefined || user.state === "suspended") {
          throw new OAuthIdentityLinkTargetUnavailableError();
        }
        const insertedRows = await transaction
          .insert(oauthUserIdentityLinks)
          .values({
            createdAt: now,
            createdByUserId: principal.userId,
            issuer,
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
              eq(oauthUserIdentityLinks.issuer, issuer),
              or(
                eq(oauthUserIdentityLinks.subject, subject),
                eq(oauthUserIdentityLinks.userId, userId),
              ),
            ));
          const exactLinkExists = existingRows.some((row) => {
            return row.subject === subject && row.userId === userId;
          });
          if (!exactLinkExists) {
            throw new OAuthIdentityLinkConflictError();
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
      const constraint = readUniqueConstraintName(error);
      if (
        constraint === USER_IDENTITY_PRIMARY_KEY
        || constraint === USER_IDENTITY_USER_UNIQUE_KEY
      ) {
        throw new OAuthIdentityLinkConflictError();
      }
      throw error;
    }
  }

  public async unlink(
    principal: AuthorizationPrincipal,
    issuer: string,
    userId: string,
  ): Promise<void> {
    requireGlobalAdministrator(principal);
    await this.database.transaction(async (transaction) => {
      const settingsRows = await transaction
        .select({
          activeOAuthConfiguration:
            authenticationSettings.activeOAuthConfiguration,
          mode: authenticationSettings.mode,
        })
        .from(authenticationSettings)
        .where(eq(authenticationSettings.id, AUTHENTICATION_SETTINGS_ID))
        .for("update")
        .limit(1);
      const settings = settingsRows[0];
      if (settings === undefined) {
        throw new Error("The database does not contain authentication settings.");
      }
      const activeIssuer = settings.activeOAuthConfiguration === null
        ? null
        : readStoredOAuthApplicationConfiguration(
          settings.activeOAuthConfiguration,
        ).issuer;
      if (settings.mode === "oauth" && activeIssuer === issuer) {
        await requireSafeActiveOAuthRemoval(
          transaction,
          principal,
          issuer,
          userId,
        );
      }
      await transaction
        .delete(oauthUserIdentityLinks)
        .where(and(
          eq(oauthUserIdentityLinks.issuer, issuer),
          eq(oauthUserIdentityLinks.userId, userId),
        ));
    });
  }
}

type OAuthIdentityLinkTransaction = Parameters<
  Parameters<CiteLoomDatabase["transaction"]>[0]
>[0];

async function requireSafeActiveOAuthRemoval(
  transaction: OAuthIdentityLinkTransaction,
  principal: AuthorizationPrincipal,
  issuer: string,
  userId: string,
): Promise<void> {
  if (principal.userId === userId) {
    throw new OAuthIdentityLinkRemovalRejectedError(
      "You cannot remove your own identity mapping while OAuth is active.",
    );
  }
  const replacementRows = await transaction
    .select({ userId: users.id })
    .from(oauthUserIdentityLinks)
    .innerJoin(users, eq(users.id, oauthUserIdentityLinks.userId))
    .innerJoin(
      workspaceMemberships,
      eq(workspaceMemberships.userId, users.id),
    )
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(and(
      eq(oauthUserIdentityLinks.issuer, issuer),
      ne(oauthUserIdentityLinks.userId, userId),
      eq(users.globalRole, "global_admin"),
      eq(users.state, "active"),
      eq(workspaceMemberships.access, "enabled"),
      eq(workspaces.state, "active"),
    ))
    .limit(1);
  if (replacementRows[0] === undefined) {
    throw new OAuthIdentityLinkRemovalRejectedError(
      "At least one accessible global administrator must remain linked while OAuth is active.",
    );
  }
}
