import { eq } from "drizzle-orm";

import { requireGlobalAdministrator } from "../auth/authorization.js";
import type { AuthenticatedPrincipal } from "../auth/model.js";
import type {
  CiteLoomDatabase,
  CiteLoomDatabaseExecutor,
} from "../database/client.js";
import { oauthResourceSettings } from "../database/schema.js";
import type { OAuthConfigurationUpdateInput } from "./boundary.js";
import {
  readEnabledOAuthConfig,
  readStoredOAuthResourceSettings,
  type EnabledOAuthConfig,
  type OAuthResourceSettings,
} from "./config.js";

const OAUTH_RESOURCE_SETTINGS_ID = "resource";

export class OAuthConfigurationVersionConflictError extends Error {
  public constructor() {
    super(
      "The OAuth configuration changed after this page was loaded. Refresh and try again.",
    );
    this.name = "OAuthConfigurationVersionConflictError";
  }
}

export class OAuthResourceDisabledError extends Error {
  public constructor() {
    super("OAuth resource access is not enabled for CiteLoom.");
    this.name = "OAuthResourceDisabledError";
  }
}

export class OAuthResourceUnconfiguredError extends Error {
  public constructor() {
    super("OAuth resource access has not been configured for CiteLoom.");
    this.name = "OAuthResourceUnconfiguredError";
  }
}

export class OAuthConfigurationStore {
  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async read(publicOrigin: string): Promise<OAuthResourceSettings> {
    return readOAuthResourceSettings(this.database, publicOrigin);
  }

  public async update(
    principal: AuthenticatedPrincipal,
    input: OAuthConfigurationUpdateInput,
    publicOrigin: string,
  ): Promise<OAuthResourceSettings> {
    requireGlobalAdministrator(principal);
    const now = this.now();
    return this.database.transaction(async (transaction) => {
      await initializeOAuthResourceSettings(transaction, now);
      const current = await readOAuthResourceSettingsForUpdate(
        transaction,
        publicOrigin,
      );
      if (oauthConfigurationMatches(current, input)) {
        return current;
      }
      if (current.version !== input.expectedVersion) {
        throw new OAuthConfigurationVersionConflictError();
      }
      const updatedRows = await transaction
        .update(oauthResourceSettings)
        .set({
          enabled: true,
          issuer: input.issuer,
          resource: input.resource,
          scopes: input.scopes,
          updatedAt: now,
          updatedByUserId: principal.userId,
          version: current.version + 1,
          workspaceClaim: input.workspaceClaim,
        })
        .where(eq(oauthResourceSettings.id, OAUTH_RESOURCE_SETTINGS_ID))
        .returning(readOAuthResourceSettingsSelection);
      return readStoredOAuthResourceSettings(updatedRows[0], publicOrigin);
    });
  }

  public async disable(
    principal: AuthenticatedPrincipal,
    expectedVersion: number,
    publicOrigin: string,
  ): Promise<OAuthResourceSettings> {
    requireGlobalAdministrator(principal);
    const now = this.now();
    return this.database.transaction(async (transaction) => {
      await initializeOAuthResourceSettings(transaction, now);
      const current = await readOAuthResourceSettingsForUpdate(
        transaction,
        publicOrigin,
      );
      if (!current.enabled) {
        return current;
      }
      if (current.version !== expectedVersion) {
        throw new OAuthConfigurationVersionConflictError();
      }
      const updatedRows = await transaction
        .update(oauthResourceSettings)
        .set({
          enabled: false,
          updatedAt: now,
          updatedByUserId: principal.userId,
          version: current.version + 1,
        })
        .where(eq(oauthResourceSettings.id, OAUTH_RESOURCE_SETTINGS_ID))
        .returning(readOAuthResourceSettingsSelection);
      return readStoredOAuthResourceSettings(updatedRows[0], publicOrigin);
    });
  }
}

export async function readEnabledOAuthConfigForUpdate(
  database: CiteLoomDatabaseExecutor,
  publicOrigin: string,
): Promise<EnabledOAuthConfig> {
  const settings = await readOAuthResourceSettingsForUpdate(
    database,
    publicOrigin,
  );
  const config = readEnabledOAuthConfig(settings);
  if (!config.enabled) {
    throw new OAuthResourceDisabledError();
  }
  return config;
}

export async function readConfiguredOAuthIssuerForUpdate(
  database: CiteLoomDatabaseExecutor,
  publicOrigin: string,
): Promise<string> {
  const settings = await readOAuthResourceSettingsForUpdate(
    database,
    publicOrigin,
  );
  if (settings.issuer === null) {
    throw new OAuthResourceUnconfiguredError();
  }
  return settings.issuer;
}

const readOAuthResourceSettingsSelection = {
  enabled: oauthResourceSettings.enabled,
  issuer: oauthResourceSettings.issuer,
  resource: oauthResourceSettings.resource,
  scopes: oauthResourceSettings.scopes,
  updatedAt: oauthResourceSettings.updatedAt,
  version: oauthResourceSettings.version,
  workspaceClaim: oauthResourceSettings.workspaceClaim,
};

async function readOAuthResourceSettings(
  database: CiteLoomDatabaseExecutor,
  publicOrigin: string,
): Promise<OAuthResourceSettings> {
  const rows = await database
    .select(readOAuthResourceSettingsSelection)
    .from(oauthResourceSettings)
    .where(eq(oauthResourceSettings.id, OAUTH_RESOURCE_SETTINGS_ID))
    .limit(1);
  return readStoredOAuthResourceSettings(rows[0], publicOrigin);
}

async function readOAuthResourceSettingsForUpdate(
  database: CiteLoomDatabaseExecutor,
  publicOrigin: string,
): Promise<OAuthResourceSettings> {
  const rows = await database
    .select(readOAuthResourceSettingsSelection)
    .from(oauthResourceSettings)
    .where(eq(oauthResourceSettings.id, OAUTH_RESOURCE_SETTINGS_ID))
    .for("update")
    .limit(1);
  return readStoredOAuthResourceSettings(rows[0], publicOrigin);
}

async function initializeOAuthResourceSettings(
  database: CiteLoomDatabaseExecutor,
  now: Date,
): Promise<void> {
  await database.insert(oauthResourceSettings).values({
    enabled: false,
    id: OAUTH_RESOURCE_SETTINGS_ID,
    issuer: null,
    resource: null,
    scopes: [],
    updatedAt: now,
    updatedByUserId: null,
    version: 1,
    workspaceClaim: null,
  }).onConflictDoNothing();
}

function oauthConfigurationMatches(
  current: OAuthResourceSettings,
  input: OAuthConfigurationUpdateInput,
): boolean {
  if (!current.enabled || current.issuer === null) {
    return false;
  }
  return current.issuer === input.issuer
    && current.resource === input.resource
    && current.workspaceClaim === input.workspaceClaim
    && current.scopes.length === input.scopes.length
    && current.scopes.every((scope, index) => scope === input.scopes[index]);
}
