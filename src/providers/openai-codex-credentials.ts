import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { CiteLoomDatabase } from "../database/client.js";
import {
  applicationSettings,
  providerOAuthCredentials,
} from "../database/schema.js";
import { parseStoredApplicationSettings } from "./settings-persistence.js";
import {
  OPENAI_CODEX_PROVIDER_ID,
  OpenAICodexOAuthError,
  refreshOpenAICodexCredentials,
  type OpenAICodexOAuthCredentials,
  type OpenAICodexOAuthRequestOptions,
} from "./openai-codex-oauth.js";
import {
  PROVIDER_CAPABILITIES,
  type ProviderCapability,
} from "./profiles.js";

const REFRESH_ADVANCE_MS = 5 * 60 * 1_000;
const REFRESH_LOCK_IDENTITY = "provider-oauth:openai-codex";

const credentialRowSchema = z.object({
  accessToken: z.string().trim().min(1),
  accountId: z.string().trim().min(1),
  expiresAt: z.date(),
  providerId: z.literal(OPENAI_CODEX_PROVIDER_ID),
  refreshToken: z.string().trim().min(1),
  status: z.enum(["connected", "reauth-required"]),
  updatedAt: z.date(),
  version: z.number().int().positive(),
});

const applicationSettingsRowSchema = z.object({
  settings: z.unknown(),
});

export interface StoredOpenAICodexCredentials
  extends OpenAICodexOAuthCredentials {
  status: "connected" | "reauth-required";
  updatedAt: Date;
  version: number;
}

export type OpenAICodexConnectionState =
  | {
    expiresAt: null;
    state: "disconnected";
    updatedAt: null;
  }
  | {
    expiresAt: string;
    state: "connected" | "reauth-required";
    updatedAt: string;
  };

export class OpenAICodexAuthenticationRequiredError extends Error {
  public constructor(
    message = "OpenAI Codex device sign-in is required.",
  ) {
    super(message);
    this.name = "OpenAICodexAuthenticationRequiredError";
  }
}

export class OpenAICodexProviderInUseError extends Error {
  public constructor(
    public readonly capabilities: readonly ProviderCapability[],
  ) {
    super(
      `OpenAI Codex cannot be disconnected while routed to: ${capabilities.join(", ")}.`,
    );
    this.name = "OpenAICodexProviderInUseError";
  }
}

export interface OpenAICodexCredentialStoreOptions
  extends OpenAICodexOAuthRequestOptions {}

type CredentialReadResult =
  | { credential: StoredOpenAICodexCredentials; kind: "credential" }
  | { kind: "reauth-required" };

export class OpenAICodexCredentialStore {
  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly options: OpenAICodexCredentialStoreOptions = {},
  ) {}

  public async disconnect(): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const settingsRows = await transaction
        .select({ settings: applicationSettings.settings })
        .from(applicationSettings)
        .where(eq(applicationSettings.id, "runtime"))
        .limit(1)
        .for("update");
      const decodedSettings = applicationSettingsRowSchema.safeParse(
        settingsRows[0],
      );
      if (!decodedSettings.success) {
        throw new Error(
          "The database does not contain valid application settings.",
        );
      }
      const settings = parseStoredApplicationSettings(
        decodedSettings.data.settings,
      );
      const activeCapabilities = readActiveOpenAICodexCapabilities(
        settings.providers.routing,
      );
      if (activeCapabilities.length > 0) {
        throw new OpenAICodexProviderInUseError(activeCapabilities);
      }
      await transaction
        .delete(providerOAuthCredentials)
        .where(eq(
          providerOAuthCredentials.providerId,
          OPENAI_CODEX_PROVIDER_ID,
        ));
    });
  }

  public async readConnectionState(): Promise<OpenAICodexConnectionState> {
    const credential = await readCredential(this.database);
    if (credential === null) {
      return {
        expiresAt: null,
        state: "disconnected",
        updatedAt: null,
      };
    }
    return {
      expiresAt: credential.expiresAt.toISOString(),
      state: credential.status,
      updatedAt: credential.updatedAt.toISOString(),
    };
  }

  public async readForRequest(
    request: {
      forceRefresh: boolean;
      staleVersion: number | null;
    },
  ): Promise<StoredOpenAICodexCredentials> {
    const result: CredentialReadResult = await this.database.transaction(
      async (transaction) => {
        await acquireRefreshLock(transaction);
        const current = await readCredential(transaction);
        if (current === null) {
          throw new OpenAICodexAuthenticationRequiredError();
        }
        if (current.status === "reauth-required") {
          throw new OpenAICodexAuthenticationRequiredError(
            "OpenAI Codex sign-in must be renewed.",
          );
        }
        if (!shouldRefreshCredential(current, request, readNow(this.options))) {
          return { credential: current, kind: "credential" };
        }
        try {
          const refreshed = await refreshOpenAICodexCredentials(
            current,
            this.options,
          );
          const credential = await replaceCredential(
            transaction,
            refreshed,
            current.version + 1,
            readNow(this.options),
          );
          return { credential, kind: "credential" };
        } catch (error: unknown) {
          if (requiresReauthentication(error)) {
            await markCredentialReauthenticationRequired(
              transaction,
              current.version + 1,
              readNow(this.options),
            );
            return { kind: "reauth-required" };
          }
          throw error;
        }
      },
    );
    if (result.kind === "reauth-required") {
      throw new OpenAICodexAuthenticationRequiredError(
        "OpenAI Codex rejected the saved sign-in. Sign in again.",
      );
    }
    return result.credential;
  }

  public async replace(
    credentials: OpenAICodexOAuthCredentials,
  ): Promise<void> {
    const now = readNow(this.options);
    await this.database.transaction(async (transaction) => {
      await acquireRefreshLock(transaction);
      const current = await readCredential(transaction);
      const version = current === null ? 1 : current.version + 1;
      await replaceCredential(transaction, credentials, version, now);
    });
  }
}

type CredentialTransaction = Parameters<
  Parameters<CiteLoomDatabase["transaction"]>[0]
>[0];

type CredentialReader = CiteLoomDatabase | CredentialTransaction;

async function readCredential(
  reader: CredentialReader,
): Promise<StoredOpenAICodexCredentials | null> {
  const rows = await reader
    .select()
    .from(providerOAuthCredentials)
    .where(eq(
      providerOAuthCredentials.providerId,
      OPENAI_CODEX_PROVIDER_ID,
    ))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const decoded = credentialRowSchema.safeParse(row);
  if (!decoded.success) {
    throw new Error(
      `Invalid OpenAI Codex credential row: ${decoded.error.message}`,
    );
  }
  return {
    accessToken: decoded.data.accessToken,
    accountId: decoded.data.accountId,
    expiresAt: decoded.data.expiresAt,
    refreshToken: decoded.data.refreshToken,
    status: decoded.data.status,
    updatedAt: decoded.data.updatedAt,
    version: decoded.data.version,
  };
}

async function acquireRefreshLock(
  transaction: CredentialTransaction,
): Promise<void> {
  await transaction.execute(
    sql`select pg_advisory_xact_lock(
      hashtextextended(${REFRESH_LOCK_IDENTITY}, 0)
    )`,
  );
}

function shouldRefreshCredential(
  current: StoredOpenAICodexCredentials,
  request: {
    forceRefresh: boolean;
    staleVersion: number | null;
  },
  now: Date,
): boolean {
  if (request.forceRefresh) {
    if (
      request.staleVersion !== null
      && current.version > request.staleVersion
    ) {
      return false;
    }
    return true;
  }
  return current.expiresAt.getTime() <= now.getTime() + REFRESH_ADVANCE_MS;
}

async function replaceCredential(
  transaction: CredentialTransaction,
  credentials: OpenAICodexOAuthCredentials,
  version: number,
  updatedAt: Date,
): Promise<StoredOpenAICodexCredentials> {
  const normalized = readCredentialInput(credentials);
  await transaction
    .insert(providerOAuthCredentials)
    .values({
      accessToken: normalized.accessToken,
      accountId: normalized.accountId,
      expiresAt: normalized.expiresAt,
      providerId: OPENAI_CODEX_PROVIDER_ID,
      refreshToken: normalized.refreshToken,
      status: "connected",
      updatedAt,
      version,
    })
    .onConflictDoUpdate({
      set: {
        accessToken: normalized.accessToken,
        accountId: normalized.accountId,
        expiresAt: normalized.expiresAt,
        refreshToken: normalized.refreshToken,
        status: "connected",
        updatedAt,
        version,
      },
      target: providerOAuthCredentials.providerId,
    });
  return {
    ...normalized,
    status: "connected",
    updatedAt,
    version,
  };
}

function readCredentialInput(
  credentials: OpenAICodexOAuthCredentials,
): OpenAICodexOAuthCredentials {
  const decoded = credentialRowSchema.pick({
    accessToken: true,
    accountId: true,
    expiresAt: true,
    refreshToken: true,
  }).safeParse(credentials);
  if (!decoded.success) {
    throw new Error(
      `Invalid OpenAI Codex credentials: ${decoded.error.message}`,
    );
  }
  return decoded.data;
}

async function markCredentialReauthenticationRequired(
  transaction: CredentialTransaction,
  version: number,
  updatedAt: Date,
): Promise<void> {
  await transaction
    .update(providerOAuthCredentials)
    .set({
      status: "reauth-required",
      updatedAt,
      version,
    })
    .where(eq(
      providerOAuthCredentials.providerId,
      OPENAI_CODEX_PROVIDER_ID,
    ));
}

function requiresReauthentication(error: unknown): boolean {
  if (!(error instanceof OpenAICodexOAuthError)) {
    return false;
  }
  return error.reauthenticationRequired
    || error.statusCode === 400
    || error.statusCode === 401
    || error.statusCode === 403;
}

function readActiveOpenAICodexCapabilities(
  routing: Record<ProviderCapability, string | null>,
): ProviderCapability[] {
  const active: ProviderCapability[] = [];
  for (const capability of PROVIDER_CAPABILITIES) {
    if (routing[capability] === OPENAI_CODEX_PROVIDER_ID) {
      active.push(capability);
    }
  }
  return active;
}

function readNow(options: OpenAICodexCredentialStoreOptions): Date {
  return options.now?.() ?? new Date();
}
