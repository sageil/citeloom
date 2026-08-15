import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { requireGlobalAdministrator } from "../auth/authorization.js";
import type { AuthorizationPrincipal } from "../auth/model.js";
import type {
  CiteLoomDatabase,
  CiteLoomDatabaseExecutor,
} from "../database/client.js";
import {
  authenticationConfigurationEvents,
  authenticationSettings,
  oauthUserIdentityLinks,
  userSessions,
  users,
  workspaceMemberships,
  workspaces,
} from "../database/schema.js";
import {
  buildEffectiveOAuthApplicationConfiguration,
  readStoredOAuthApplicationConfiguration,
  type EffectiveOAuthApplicationConfiguration,
  type StoredOAuthApplicationConfiguration,
} from "./application-configuration.js";

const AUTHENTICATION_SETTINGS_ID = "application";

const storedAuthenticationSettingsSchema = z.object({
  activeOAuthConfiguration: z.unknown().nullable(),
  activatedAt: z.date().nullable(),
  hostRecoveryEnabled: z.boolean(),
  mode: z.enum(["local", "oauth"]),
  stagedOAuthConfiguration: z.unknown().nullable(),
  updatedAt: z.date(),
  version: z.number().int().positive(),
}).strict();

export type AuthenticationMode = "local" | "oauth";

export interface AuthenticationSettings {
  activeOAuthConfiguration: EffectiveOAuthApplicationConfiguration | null;
  activatedAt: string | null;
  hostRecoveryEnabled: boolean;
  mode: AuthenticationMode;
  stagedOAuthConfiguration: EffectiveOAuthApplicationConfiguration | null;
  updatedAt: string | null;
  version: number;
}

export interface AuthenticationBootstrap {
  mode: AuthenticationMode;
  oauth: {
    apiResource: string;
    apiScopes: string[];
    browserCallbackUri: string;
    browserClientId: string;
    browserPostLogoutRedirectUri: string;
    browserScopes: string[];
    issuer: string;
  } | null;
}

export interface OAuthActivationProof {
  issuer: string;
  subject: string;
}

export interface HostAuthenticationRecoveryStatus {
  changed: boolean;
  hostRecoveryEnabled: boolean;
  mode: AuthenticationMode;
  version: number;
}

export class AuthenticationSettingsVersionConflictError extends Error {
  public constructor() {
    super(
      "The authentication settings changed after they were loaded. Refresh and try again.",
    );
    this.name = "AuthenticationSettingsVersionConflictError";
  }
}

export class OAuthActivationRejectedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OAuthActivationRejectedError";
  }
}

export class OAuthApplicationUnconfiguredError extends Error {
  public constructor() {
    super("A staged or active OAuth configuration is required.");
    this.name = "OAuthApplicationUnconfiguredError";
  }
}

export class HostRecoveryConfigurationRejectedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "HostRecoveryConfigurationRejectedError";
  }
}

export class HostRecoveryDisabledError extends Error {
  public constructor() {
    super("Host authentication recovery is disabled.");
    this.name = "HostRecoveryDisabledError";
  }
}

export function requireManagedOAuthConfiguration(
  settings: AuthenticationSettings,
): EffectiveOAuthApplicationConfiguration {
  const configuration = settings.stagedOAuthConfiguration
    ?? settings.activeOAuthConfiguration;
  if (configuration === null) {
    throw new OAuthApplicationUnconfiguredError();
  }
  return configuration;
}

export class OAuthApplicationStore {
  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async read(publicOrigin: string): Promise<AuthenticationSettings> {
    const rows = await this.database
      .select(readAuthenticationSettingsSelection)
      .from(authenticationSettings)
      .where(eq(authenticationSettings.id, AUTHENTICATION_SETTINGS_ID))
      .limit(1);
    return readAuthenticationSettings(rows[0], publicOrigin);
  }

  public async readBootstrap(
    publicOrigin: string,
  ): Promise<AuthenticationBootstrap> {
    const settings = await this.read(publicOrigin);
    const active = settings.activeOAuthConfiguration;
    if (settings.mode === "local" || active === null) {
      return { mode: "local", oauth: null };
    }
    return {
      mode: "oauth",
      oauth: {
        apiResource: active.apiResource,
        apiScopes: [...active.apiScopes],
        browserCallbackUri: active.browserCallbackUri,
        browserClientId: active.browserClientId,
        browserPostLogoutRedirectUri: active.browserPostLogoutRedirectUri,
        browserScopes: [...active.browserScopes],
        issuer: active.issuer,
      },
    };
  }

  public async readHostRecoveryStatus(): Promise<HostAuthenticationRecoveryStatus> {
    const rows = await this.database
      .select(readHostRecoverySelection)
      .from(authenticationSettings)
      .where(eq(authenticationSettings.id, AUTHENTICATION_SETTINGS_ID))
      .limit(1);
    return readHostRecoveryStatus(rows[0], false);
  }

  public async configureHostRecovery(
    principal: AuthorizationPrincipal,
    enabled: boolean,
    expectedVersion: number,
    publicOrigin: string,
  ): Promise<AuthenticationSettings> {
    requireGlobalAdministrator(principal);
    const now = this.now();
    return this.database.transaction(async (transaction) => {
      await initializeAuthenticationSettings(transaction, now);
      const current = await readAuthenticationSettingsForUpdate(
        transaction,
        publicOrigin,
      );
      if (current.version !== expectedVersion) {
        throw new AuthenticationSettingsVersionConflictError();
      }
      if (current.mode === "oauth" && !enabled) {
        throw new HostRecoveryConfigurationRejectedError(
          "Host authentication recovery cannot be disabled while OAuth is active.",
        );
      }
      if (current.hostRecoveryEnabled === enabled) {
        return current;
      }
      const nextVersion = current.version + 1;
      const updatedRows = await transaction
        .update(authenticationSettings)
        .set({
          hostRecoveryEnabled: enabled,
          updatedAt: now,
          updatedByUserId: principal.userId,
          version: nextVersion,
        })
        .where(eq(authenticationSettings.id, AUTHENTICATION_SETTINGS_ID))
        .returning(readAuthenticationSettingsSelection);
      await transaction.insert(authenticationConfigurationEvents).values({
        actorUserId: principal.userId,
        createdAt: now,
        eventType: enabled
          ? "host_recovery_enabled"
          : "host_recovery_disabled",
        fromMode: current.mode,
        id: randomUUID(),
        settingsVersion: nextVersion,
        toMode: current.mode,
      });
      return readAuthenticationSettings(updatedRows[0], publicOrigin);
    });
  }

  public async stage(
    principal: AuthorizationPrincipal,
    configuration: StoredOAuthApplicationConfiguration,
    expectedVersion: number,
    publicOrigin: string,
  ): Promise<AuthenticationSettings> {
    requireGlobalAdministrator(principal);
    const now = this.now();
    return this.database.transaction(async (transaction) => {
      await initializeAuthenticationSettings(transaction, now);
      const current = await readAuthenticationSettingsForUpdate(
        transaction,
        publicOrigin,
      );
      if (current.version !== expectedVersion) {
        throw new AuthenticationSettingsVersionConflictError();
      }
      const currentStaged = current.stagedOAuthConfiguration;
      if (
        currentStaged !== null
        && configurationsMatch(currentStaged, configuration, publicOrigin)
      ) {
        return current;
      }
      const nextVersion = current.version + 1;
      const updatedRows = await transaction
        .update(authenticationSettings)
        .set({
          stagedOAuthConfiguration: configuration,
          updatedAt: now,
          updatedByUserId: principal.userId,
          version: nextVersion,
        })
        .where(eq(authenticationSettings.id, AUTHENTICATION_SETTINGS_ID))
        .returning(readAuthenticationSettingsSelection);
      await transaction.insert(authenticationConfigurationEvents).values({
        actorUserId: principal.userId,
        createdAt: now,
        eventType: "staged",
        fromMode: current.mode,
        id: randomUUID(),
        settingsVersion: nextVersion,
        toMode: current.mode,
      });
      return readAuthenticationSettings(updatedRows[0], publicOrigin);
    });
  }

  public async activate(
    principal: AuthorizationPrincipal,
    proof: OAuthActivationProof,
    expectedVersion: number,
    publicOrigin: string,
  ): Promise<AuthenticationSettings> {
    requireGlobalAdministrator(principal);
    const now = this.now();
    return this.database.transaction(async (transaction) => {
      await initializeAuthenticationSettings(transaction, now);
      const current = await readAuthenticationSettingsForUpdate(
        transaction,
        publicOrigin,
      );
      if (current.version !== expectedVersion) {
        throw new AuthenticationSettingsVersionConflictError();
      }
      if (!current.hostRecoveryEnabled) {
        throw new OAuthActivationRejectedError(
          "Enable host authentication recovery before activating OAuth.",
        );
      }
      const staged = current.stagedOAuthConfiguration;
      if (staged === null) {
        throw new OAuthActivationRejectedError(
          "A verified staged OAuth configuration is required.",
        );
      }
      if (staged.issuer !== proof.issuer) {
        throw new OAuthActivationRejectedError(
          "The verified OAuth identity does not use the staged issuer.",
        );
      }
      await requireActivatingAdministrator(
        transaction,
        principal.userId,
        proof,
      );
      const nextVersion = current.version + 1;
      const updatedRows = await transaction
        .update(authenticationSettings)
        .set({
          activeOAuthConfiguration: toStoredConfiguration(staged),
          activatedAt: now,
          activatedByUserId: principal.userId,
          mode: "oauth",
          stagedOAuthConfiguration: null,
          updatedAt: now,
          updatedByUserId: principal.userId,
          version: nextVersion,
        })
        .where(eq(authenticationSettings.id, AUTHENTICATION_SETTINGS_ID))
        .returning(readAuthenticationSettingsSelection);
      await transaction.delete(userSessions);
      await transaction.insert(authenticationConfigurationEvents).values({
        actorUserId: principal.userId,
        createdAt: now,
        eventType: "activated",
        fromMode: current.mode,
        id: randomUUID(),
        settingsVersion: nextVersion,
        toMode: "oauth",
      });
      return readAuthenticationSettings(updatedRows[0], publicOrigin);
    });
  }

  public async disable(
    principal: AuthorizationPrincipal,
    expectedVersion: number,
    publicOrigin: string,
  ): Promise<AuthenticationSettings> {
    requireGlobalAdministrator(principal);
    const now = this.now();
    return this.database.transaction(async (transaction) => {
      await initializeAuthenticationSettings(transaction, now);
      const current = await readAuthenticationSettingsForUpdate(
        transaction,
        publicOrigin,
      );
      if (current.version !== expectedVersion) {
        throw new AuthenticationSettingsVersionConflictError();
      }
      const active = current.activeOAuthConfiguration;
      if (current.mode === "local" || active === null) {
        return current;
      }
      const updatedRows = await transitionOAuthToLocal(transaction, {
        activeConfiguration: toStoredConfiguration(active),
        actorUserId: principal.userId,
        currentVersion: current.version,
        eventType: "disabled",
        now,
      });
      return readAuthenticationSettings(updatedRows[0], publicOrigin);
    });
  }

  public async recoverLocalAuthentication(): Promise<HostAuthenticationRecoveryStatus> {
    const now = this.now();
    return this.database.transaction(async (transaction) => {
      await initializeAuthenticationSettings(transaction, now);
      const rows = await transaction
        .select({
          ...readHostRecoverySelection,
          activeOAuthConfiguration: authenticationSettings.activeOAuthConfiguration,
        })
        .from(authenticationSettings)
        .where(eq(authenticationSettings.id, AUTHENTICATION_SETTINGS_ID))
        .for("update")
        .limit(1);
      const current = readHostRecoveryRow(rows[0]);
      if (!current.hostRecoveryEnabled) {
        throw new HostRecoveryDisabledError();
      }
      if (current.mode === "local") {
        return readHostRecoveryStatus(current, false);
      }
      if (current.activeOAuthConfiguration === null) {
        throw new OAuthActivationRejectedError(
          "OAuth mode has no active OAuth configuration.",
        );
      }
      const updatedRows = await transitionOAuthToLocal(transaction, {
        activeConfiguration: current.activeOAuthConfiguration,
        actorUserId: null,
        currentVersion: current.version,
        eventType: "recovered",
        now,
      });
      return readHostRecoveryStatus(updatedRows[0], true);
    });
  }
}

const readAuthenticationSettingsSelection = {
  activeOAuthConfiguration: authenticationSettings.activeOAuthConfiguration,
  activatedAt: authenticationSettings.activatedAt,
  hostRecoveryEnabled: authenticationSettings.hostRecoveryEnabled,
  mode: authenticationSettings.mode,
  stagedOAuthConfiguration: authenticationSettings.stagedOAuthConfiguration,
  updatedAt: authenticationSettings.updatedAt,
  version: authenticationSettings.version,
};

const readHostRecoverySelection = {
  hostRecoveryEnabled: authenticationSettings.hostRecoveryEnabled,
  mode: authenticationSettings.mode,
  version: authenticationSettings.version,
};

async function initializeAuthenticationSettings(
  database: CiteLoomDatabaseExecutor,
  now: Date,
): Promise<void> {
  await database.insert(authenticationSettings).values({
    activeOAuthConfiguration: null,
    activatedAt: null,
    activatedByUserId: null,
    hostRecoveryEnabled: false,
    id: AUTHENTICATION_SETTINGS_ID,
    mode: "local",
    stagedOAuthConfiguration: null,
    updatedAt: now,
    updatedByUserId: null,
    version: 1,
  }).onConflictDoNothing();
}

async function readAuthenticationSettingsForUpdate(
  database: CiteLoomDatabaseExecutor,
  publicOrigin: string,
): Promise<AuthenticationSettings> {
  const rows = await database
    .select(readAuthenticationSettingsSelection)
    .from(authenticationSettings)
    .where(eq(authenticationSettings.id, AUTHENTICATION_SETTINGS_ID))
    .for("update")
    .limit(1);
  return readAuthenticationSettings(rows[0], publicOrigin);
}

function readAuthenticationSettings(
  row: unknown | undefined,
  publicOrigin: string,
): AuthenticationSettings {
  if (row === undefined) {
    return {
      activeOAuthConfiguration: null,
      activatedAt: null,
      hostRecoveryEnabled: false,
      mode: "local",
      stagedOAuthConfiguration: null,
      updatedAt: null,
      version: 1,
    };
  }
  const parsed = storedAuthenticationSettingsSchema.parse(row);
  const active = readConfigurationDocument(
    parsed.activeOAuthConfiguration,
    publicOrigin,
  );
  const staged = readConfigurationDocument(
    parsed.stagedOAuthConfiguration,
    publicOrigin,
  );
  if (parsed.mode === "oauth" && active === null) {
    throw new OAuthActivationRejectedError(
      "OAuth mode has no active OAuth configuration.",
    );
  }
  return {
    activeOAuthConfiguration: active,
    activatedAt: parsed.activatedAt?.toISOString() ?? null,
    hostRecoveryEnabled: parsed.hostRecoveryEnabled,
    mode: parsed.mode,
    stagedOAuthConfiguration: staged,
    updatedAt: parsed.updatedAt.toISOString(),
    version: parsed.version,
  };
}

const hostRecoveryRowSchema = z.object({
  activeOAuthConfiguration: z.unknown().nullable(),
  hostRecoveryEnabled: z.boolean(),
  mode: z.enum(["local", "oauth"]),
  version: z.number().int().positive(),
}).strict();

const hostRecoveryStatusSchema = z.object({
  hostRecoveryEnabled: z.boolean(),
  mode: z.enum(["local", "oauth"]),
  version: z.number().int().positive(),
}).passthrough();

function readHostRecoveryRow(row: unknown | undefined): {
  activeOAuthConfiguration: StoredOAuthApplicationConfiguration | null;
  hostRecoveryEnabled: boolean;
  mode: AuthenticationMode;
  version: number;
} {
  if (row === undefined) {
    throw new OAuthActivationRejectedError(
      "Authentication settings are unavailable.",
    );
  }
  const parsed = hostRecoveryRowSchema.parse(row);
  const activeOAuthConfiguration = parsed.activeOAuthConfiguration === null
    ? null
    : readStoredOAuthApplicationConfiguration(
      parsed.activeOAuthConfiguration,
    );
  return { ...parsed, activeOAuthConfiguration };
}

function readHostRecoveryStatus(
  row: unknown | undefined,
  changed: boolean,
): HostAuthenticationRecoveryStatus {
  if (row === undefined) {
    return {
      changed,
      hostRecoveryEnabled: false,
      mode: "local",
      version: 1,
    };
  }
  const parsed = hostRecoveryStatusSchema.parse(row);
  return {
    changed,
    hostRecoveryEnabled: parsed.hostRecoveryEnabled,
    mode: parsed.mode,
    version: parsed.version,
  };
}

async function transitionOAuthToLocal(
  database: CiteLoomDatabaseExecutor,
  input: {
    activeConfiguration: StoredOAuthApplicationConfiguration;
    actorUserId: string | null;
    currentVersion: number;
    eventType: "disabled" | "recovered";
    now: Date;
  },
) {
  const nextVersion = input.currentVersion + 1;
  const updatedRows = await database
    .update(authenticationSettings)
    .set({
      activeOAuthConfiguration: null,
      activatedAt: null,
      activatedByUserId: null,
      mode: "local",
      stagedOAuthConfiguration: input.activeConfiguration,
      updatedAt: input.now,
      updatedByUserId: input.actorUserId,
      version: nextVersion,
    })
    .where(eq(authenticationSettings.id, AUTHENTICATION_SETTINGS_ID))
    .returning(readAuthenticationSettingsSelection);
  await database.delete(userSessions);
  await database.insert(authenticationConfigurationEvents).values({
    actorUserId: input.actorUserId,
    createdAt: input.now,
    eventType: input.eventType,
    fromMode: "oauth",
    id: randomUUID(),
    settingsVersion: nextVersion,
    toMode: "local",
  });
  return updatedRows;
}

function readConfigurationDocument(
  value: unknown | null,
  publicOrigin: string,
): EffectiveOAuthApplicationConfiguration | null {
  if (value === null) {
    return null;
  }
  const stored = readStoredOAuthApplicationConfiguration(value);
  return buildEffectiveOAuthApplicationConfiguration(stored, publicOrigin);
}

function configurationsMatch(
  effective: EffectiveOAuthApplicationConfiguration,
  stored: StoredOAuthApplicationConfiguration,
  publicOrigin: string,
): boolean {
  const candidate = buildEffectiveOAuthApplicationConfiguration(
    stored,
    publicOrigin,
  );
  return effective.issuer === candidate.issuer
    && arraysMatch(effective.apiScopes, candidate.apiScopes)
    && effective.browserClientId === candidate.browserClientId
    && arraysMatch(effective.browserScopes, candidate.browserScopes)
    && arraysMatch(effective.mcpScopes, candidate.mcpScopes);
}

function arraysMatch(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function toStoredConfiguration(
  effective: EffectiveOAuthApplicationConfiguration,
): StoredOAuthApplicationConfiguration {
  return {
    apiScopes: [...effective.apiScopes],
    browserClientId: effective.browserClientId,
    browserScopes: [...effective.browserScopes],
    issuer: effective.issuer,
    mcpScopes: [...effective.mcpScopes],
    schemaVersion: 1,
  };
}

async function requireActivatingAdministrator(
  database: CiteLoomDatabaseExecutor,
  userId: string,
  proof: OAuthActivationProof,
): Promise<void> {
  const rows = await database
    .select({ userId: users.id })
    .from(oauthUserIdentityLinks)
    .innerJoin(users, eq(users.id, oauthUserIdentityLinks.userId))
    .innerJoin(
      workspaceMemberships,
      eq(workspaceMemberships.userId, users.id),
    )
    .innerJoin(workspaces, eq(workspaces.id, workspaceMemberships.workspaceId))
    .where(and(
      eq(oauthUserIdentityLinks.issuer, proof.issuer),
      eq(oauthUserIdentityLinks.subject, proof.subject),
      eq(oauthUserIdentityLinks.userId, userId),
      eq(users.globalRole, "global_admin"),
      eq(users.state, "active"),
      eq(workspaceMemberships.access, "enabled"),
      eq(workspaces.state, "active"),
    ))
    .limit(1);
  if (rows[0] === undefined) {
    throw new OAuthActivationRejectedError(
      "The verified OAuth identity is not linked to an active global administrator with workspace access.",
    );
  }
}
