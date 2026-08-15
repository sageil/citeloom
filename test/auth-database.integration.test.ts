import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  decodeLoginInput,
  normalizeUserIdentity,
} from "../src/auth/boundary.js";
import {
  AuthenticationRejectedError,
  AuthenticationStore,
  FinalWorkspaceAdministratorError,
  GlobalAuthorizationError,
  ProtectedGlobalAdministratorError,
  SetupTokenRejectedError,
  WorkspaceAuthorizationError,
  WorkspaceArchiveConflictError,
  WorkspaceMemberAccessConflictError,
  WorkspaceMemberAlreadyExistsError,
  WorkspaceNameUnavailableError,
  WorkspaceUnavailableError,
  WorkspaceUserUnavailableError,
} from "../src/auth/store.js";
import {
  OrganizationUsernameUnavailableError,
  OrganizationUserWorkspaceRequiredError,
  UserAccountStore,
} from "../src/auth/user-account-store.js";
import { hashPassword } from "../src/auth/password.js";
import {
  type DatabaseSession,
  migrateDatabase,
  openDatabase,
} from "../src/database/client.js";
import { applyDatabaseBootstrap } from "../src/database/administrator-bootstrap.js";
import { ApplicationSettingsRepository } from "../src/app/settings.js";
import {
  parseStoredApplicationSettings,
  type StoredApplicationSettings,
} from "../src/providers/settings-persistence.js";
import { readProviderFeatureConfiguration } from "../src/providers/profiles.js";
import {
  applicationSettings,
  authenticationConfigurationEvents,
  authenticationSettings,
  ingestionJobs,
  mcpApiKeys,
  sourceDocuments,
  sourceLibraries,
  sourceLibraryDeletionSources,
  userPasswordCredentials,
  userSessions,
  userSetupTokens,
  users,
  workspaceMemberships,
  workspaceAuditEvents,
  workspaceLibraryGrants,
  workspaceSecurityPolicies,
  workspaceSettings,
  workspaces,
} from "../src/database/schema.js";
import {
  authorizeSourceLibraryForPrincipal,
  canAccessSourceLibrary,
} from "../src/workspaces/source-library-access.js";
import {
  SourceLibraryArchiveConflictError,
  SourceLibraryStore,
} from "../src/workspaces/source-library-store.js";
import {
  reconcileNextSharedSourceLibraryDeletion,
  requestSharedSourceLibraryDeletion,
} from "../src/workspaces/source-library-deletion.js";
import { WorkspaceSettingsRepository } from "../src/workspaces/settings-store.js";
import { ResearchStore } from "../src/research/store.js";
import { DocumentCatalog } from "../src/documents/catalog/index.js";
import { SourceLibraryIngestionUnavailableError } from "../src/documents/catalog/ingestion-lifecycle.js";
import { readDocumentFormat } from "../src/documents/format.js";
import { SourceContentStore } from "../src/documents/storage/source-content-store.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";
import {
  parseOAuthApplicationConfiguration,
} from "../src/oauth/application-configuration.js";
import {
  HostRecoveryConfigurationRejectedError,
  HostRecoveryDisabledError,
  OAuthActivationRejectedError,
  OAuthApplicationStore,
} from "../src/oauth/application-store.js";
import { OAuthPrincipalStore } from "../src/oauth/principal-store.js";
import {
  OAuthIdentityLinkRemovalRejectedError,
  OAuthIdentityLinkStore,
} from "../src/oauth/identity-link-store.js";
import { McpTaskStore } from "../src/mcp/tasks/store.js";
import {
  McpApiKeyInsufficientScopeError,
  McpApiKeyRejectedError,
  McpApiKeyStore,
  McpApiKeyTargetUnavailableError,
} from "../src/mcp/api-key-store.js";

const databaseUrl = process.env.CITELOOM_TEST_DATABASE_URL
  ?? "postgresql://citeloom:citeloom@127.0.0.1:5433/citeloom_test";
const administratorPassword = "correct horse battery staple";
const administratorUsername = "Admin";
let session: DatabaseSession;
let sourceContentDirectory: string;

beforeAll(async () => {
  sourceContentDirectory = await mkdtemp(
    join(tmpdir(), "citeloom-auth-source-content-"),
  );
  session = await openDatabase({ poolMax: 2, url: databaseUrl });
  await migrateDatabase(session.database);
  await session.database.delete(sourceDocuments);
});

beforeEach(async () => {
  await session.database.delete(authenticationConfigurationEvents);
  await session.database
    .update(authenticationSettings)
    .set({
      activeOAuthConfiguration: null,
      activatedAt: null,
      activatedByUserId: null,
      hostRecoveryEnabled: false,
      mode: "local",
      stagedOAuthConfiguration: null,
      updatedByUserId: null,
      version: 1,
    });
  await session.database.delete(userSessions);
  await session.database.delete(userSetupTokens);
  await session.database.delete(userPasswordCredentials);
  await session.database.delete(workspaceAuditEvents);
  await session.database.delete(workspaceLibraryGrants);
  await session.database.delete(sourceLibraryDeletionSources);
  await session.database.delete(workspaceMemberships);
  await session.database.delete(users);
  await session.database.delete(sourceLibraries);
  await session.database.delete(workspaces);
});

afterAll(async () => {
  await session.close();
  await rm(sourceContentDirectory, { force: true, recursive: true });
});

describe("database administrator bootstrap", () => {
  it("creates one active administrator and is idempotent", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    await applyDatabaseBootstrap(session.database, {
      CITELOOM_ADMIN_PASSWORD: "a different secure passphrase",
      CITELOOM_ADMIN_USERNAME: "DifferentAdmin",
      CITELOOM_SOURCE_CONTENT_DIRECTORY: sourceContentDirectory,
    });

    const store = new AuthenticationStore(session.database);
    await expect(store.authenticate(decodeLoginInput({
      password: administratorPassword,
      username: administratorUsername,
    }))).resolves.toMatchObject({
      principal: {
        globalRole: "global_admin",
        role: "admin",
        username: administratorUsername,
        workspaceName: "DefaultSpace",
      },
    });
    await expect(store.authenticate(decodeLoginInput({
      password: "a different secure passphrase",
      username: "DifferentAdmin",
    }))).rejects.toBeInstanceOf(AuthenticationRejectedError);
    await expect(session.database.select().from(users)).resolves.toHaveLength(1);
    await expect(
      session.database.select().from(userPasswordCredentials),
    ).resolves.toHaveLength(1);
    await expect(
      session.database.select().from(workspaceMemberships),
    ).resolves.toHaveLength(1);
    await expect(session.database.select().from(workspaces)).resolves.toEqual([
      expect.objectContaining({ name: "DefaultSpace" }),
    ]);
    await expect(session.database.select().from(sourceLibraries)).resolves.toEqual([
      expect.objectContaining({ kind: "private", name: null }),
    ]);
  });

  it("rejects missing administrator credentials without creating auth data", async () => {
    await expect(
      applyDatabaseBootstrap(session.database, {}),
    ).rejects.toThrow("Invalid administrator bootstrap configuration");
    await expect(session.database.select().from(users)).resolves.toHaveLength(0);
    await expect(session.database.select().from(workspaces)).resolves.toHaveLength(0);
  });

  it("stores provider model context defaults in application settings", async () => {
    await session.database.delete(applicationSettings);
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const rows = await session.database
      .select()
      .from(applicationSettings);
    const stored = rows[0];
    if (stored === undefined) {
      throw new Error("Expected stored application settings.");
    }

    for (const document of [stored.defaults, stored.settings]) {
      expect(document.providers.catalog.map((profile) => profile.id)).toEqual([
        "omlx",
        "ollama",
        "lmstudio",
        "openai",
        "openrouter",
        "openai-codex",
        "deepseek",
        "groq",
        "mistral",
        "together",
        "cohere",
        "jina",
        "custom",
      ]);
      expect(document.providers.connections.deepseek).toMatchObject({
        answer: {
          contextCapacityTokens: 1_000_000,
          model: "deepseek-v4-flash",
        },
        indexing: {
          contextCapacityTokens: 1_000_000,
          model: "deepseek-v4-flash",
        },
      });
      expect(document.providers.connections.lmstudio).toMatchObject({
        answer: {
          contextCapacityTokens: 131_072,
          model: "google/gemma-4-e4b",
        },
        embedding: {
          contextCapacityTokens: 2_048,
          model: "text-embedding-embeddinggemma-300m-qat",
        },
        indexing: {
          contextCapacityTokens: 131_072,
          model: "google/gemma-4-e4b",
        },
      });
      expect(document.providers.connections.mistral).toMatchObject({
        answer: {
          contextCapacityTokens: 256_000,
          model: "mistral-large-2512",
        },
        baseUrl: "https://api.mistral.ai/v1",
        embedding: {
          contextCapacityTokens: 8_192,
          model: "mistral-embed",
        },
        indexing: {
          contextCapacityTokens: 256_000,
          model: "mistral-large-2512",
        },
        sendReasoningOptions: false,
        speechToText: {
          model: "voxtral-mini-latest",
        },
        textToSpeech: {
          model: "voxtral-mini-tts-2603",
          voice: null,
        },
      });
      expect(document.providers.catalog.find((profile) => {
        return profile.id === "mistral";
      })?.capabilities).toEqual(expect.arrayContaining([
        { adapter: "mistral-transcription", capability: "speechToText" },
        { adapter: "mistral-speech", capability: "textToSpeech" },
      ]));
      expect(document.providers.connections.ollama).toMatchObject({
        answer: {
          contextCapacityTokens: 131_072,
          model: "qwen3.5:9b-mlx",
        },
        embedding: {
          contextCapacityTokens: 2_048,
          model: "snowflake-arctic-embed:137m",
        },
        queryExpansion: {
          contextCapacityTokens: 131_072,
          model: "qwen3.5:9b-mlx",
        },
        indexing: {
          contextCapacityTokens: 131_072,
          model: "qwen3.5:9b",
        },
      });
      expect(document.providers.connections.openrouter).toMatchObject({
        answer: {
          contextCapacityTokens: 200_000,
          model: "openrouter/free",
        },
        baseUrl: "https://openrouter.ai/api/v1",
        embedding: {
          contextCapacityTokens: 32_768,
          model: "nvidia/nemotron-3-embed-1b:free",
        },
        reranking: {
          model: "nvidia/llama-nemotron-rerank-vl-1b-v2:free",
        },
        speechToText: {
          model: "openai/gpt-4o-mini-transcribe",
        },
        textToSpeech: {
          model: "fish-audio/s2.1-pro-free:free",
          voice: "alloy",
        },
      });
      expect(document.providers.connections.together).toMatchObject({
        answer: {
          contextCapacityTokens: 262_144,
          model: "moonshotai/Kimi-K2.6",
        },
        baseUrl: "https://api.together.xyz/v1",
        embedding: {
          contextCapacityTokens: 514,
          model: "intfloat/multilingual-e5-large-instruct",
        },
        indexing: {
          contextCapacityTokens: 262_144,
          model: "moonshotai/Kimi-K2.6",
        },
        speechToText: {
          model: "openai/whisper-large-v3",
        },
        textToSpeech: {
          model: "hexgrad/Kokoro-82M",
          voice: "af_heart",
        },
      });
      expect(document.providers.catalog.find((profile) => {
        return profile.id === "together";
      })?.capabilities).toEqual(expect.arrayContaining([
        { adapter: "openai-transcription", capability: "speechToText" },
        { adapter: "openai-speech", capability: "textToSpeech" },
      ]));
    }
  });

  it("upgrades provider defaults without overwriting live configuration", async () => {
    await session.database.delete(applicationSettings);
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const seededRows = await session.database
      .select({
        defaults: applicationSettings.defaults,
        settings: applicationSettings.settings,
      })
      .from(applicationSettings)
      .where(eq(applicationSettings.id, "runtime"));
    const seededRow = seededRows[0];
    if (seededRow === undefined) {
      throw new Error("Expected seeded application settings.");
    }
    const legacyDefaults = parseStoredApplicationSettings(seededRow.defaults);
    const seeded = parseStoredApplicationSettings(seededRow.settings);
    const lmStudioProfile = seeded.providers.catalog.find((profile) => {
      return profile.id === "lmstudio";
    });
    const groqConnection = seeded.providers.connections.groq;
    if (lmStudioProfile === undefined || groqConnection === undefined) {
      throw new Error("Expected LM Studio and Groq defaults.");
    }
    removeProviderSpeechDefaults(legacyDefaults, "mistral");
    removeProviderSpeechDefaults(legacyDefaults, "together");
    removeProviderSpeechDefaults(seeded, "mistral");
    removeProviderSpeechDefaults(seeded, "together");
    const liveMistralConnection = seeded.providers.connections.mistral;
    const liveTogetherConnection = seeded.providers.connections.together;
    if (liveMistralConnection === undefined || liveTogetherConnection === undefined) {
      throw new Error("Expected live Mistral and Together connections.");
    }
    liveMistralConnection.apiToken = "live-mistral-token";
    liveTogetherConnection.maximumParallelRequests = 4;
    seeded.providers.catalog = [
      ...seeded.providers.catalog.filter((profile) => {
        return profile.id !== "openrouter";
      }),
      {
        ...structuredClone(lmStudioProfile),
        displayName: "Database Provider",
        id: "database-provider",
      },
    ];
    delete seeded.providers.connections.openrouter;
    groqConnection.maximumParallelRequests = 7;
    await session.database
      .update(applicationSettings)
      .set({
        defaults: legacyDefaults,
        settings: seeded,
      })
      .where(eq(applicationSettings.id, "runtime"));

    await applyDatabaseBootstrap(session.database, administratorEnvironment());

    const rows = await session.database
      .select({
        defaults: applicationSettings.defaults,
        settings: applicationSettings.settings,
      })
      .from(applicationSettings)
      .where(eq(applicationSettings.id, "runtime"));
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Expected bootstrapped application settings.");
    }
    const defaults = parseStoredApplicationSettings(row.defaults);
    const settings = parseStoredApplicationSettings(row.settings);
    expect(defaults.providers.catalog).toHaveLength(13);
    expect(settings.providers.catalog).toHaveLength(14);
    expect(settings.providers.catalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "database-provider" }),
      expect.objectContaining({ id: "openrouter" }),
    ]));
    expect(settings.providers.connections.openrouter).toBeDefined();
    expect(
      settings.providers.connections.groq?.maximumParallelRequests,
    ).toBe(7);
    expect(settings.providers.catalog.find((profile) => {
      return profile.id === "mistral";
    })?.capabilities).toEqual(expect.arrayContaining([
      { adapter: "mistral-transcription", capability: "speechToText" },
      { adapter: "mistral-speech", capability: "textToSpeech" },
    ]));
    expect(settings.providers.connections.mistral).toMatchObject({
      apiToken: "live-mistral-token",
      customAdapters: {
        speechToText: "mistral-transcription",
        textToSpeech: "mistral-speech",
      },
      speechToText: { model: "voxtral-mini-latest" },
      textToSpeech: { model: "voxtral-mini-tts-2603" },
    });
    expect(settings.providers.catalog.find((profile) => {
      return profile.id === "together";
    })?.capabilities).toEqual(expect.arrayContaining([
      { adapter: "openai-transcription", capability: "speechToText" },
      { adapter: "openai-speech", capability: "textToSpeech" },
    ]));
    expect(settings.providers.connections.together).toMatchObject({
      maximumParallelRequests: 4,
      speechToText: { model: "openai/whisper-large-v3" },
      textToSpeech: {
        model: "hexgrad/Kokoro-82M",
        voice: "af_heart",
      },
    });
  });

});

describe("application authentication mode", () => {
  it("stages OAuth without changing local auth and activates it atomically", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const authentication = new AuthenticationStore(session.database);
    const sessionResult = await authentication.authenticate(decodeLoginInput({
      password: administratorPassword,
      username: administratorUsername,
    }));
    const principal = sessionResult.principal;
    const issuer = "https://identity.example.com/oidc";
    const subject = "external-admin-subject";
    const identityLinks = new OAuthIdentityLinkStore(session.database);
    await identityLinks.link(
      principal,
      issuer,
      principal.userId,
      subject,
    );
    const configuration = parseOAuthApplicationConfiguration({
      apiScopes: ["citeloom.app"],
      browserClientId: "citeloom-browser",
      browserScopes: ["citeloom.app", "openid"],
      issuer,
      mcpScopes: ["citeloom.answer", "citeloom.search"],
    });
    const store = new OAuthApplicationStore(session.database);

    const staged = await store.stage(
      principal,
      configuration,
      1,
      "https://citeloom.example.com",
    );

    expect(staged).toMatchObject({
      activeOAuthConfiguration: null,
      mode: "local",
      stagedOAuthConfiguration: {
        apiResource: "https://citeloom.example.com/api",
        mcpResource: "https://citeloom.example.com/mcp",
      },
      version: 2,
    });
    await expect(
      session.database.select().from(userSessions),
    ).resolves.toHaveLength(1);
    await expect(store.recoverLocalAuthentication()).rejects.toBeInstanceOf(
      HostRecoveryDisabledError,
    );
    await expect(store.activate(
      principal,
      { issuer, subject },
      staged.version,
      "https://citeloom.example.com",
    )).rejects.toBeInstanceOf(OAuthActivationRejectedError);

    const recoveryEnabled = await store.configureHostRecovery(
      principal,
      true,
      staged.version,
      "https://citeloom.example.com",
    );

    const activated = await store.activate(
      principal,
      { issuer, subject },
      recoveryEnabled.version,
      "https://citeloom.example.com",
    );

    expect(activated).toMatchObject({
      activeOAuthConfiguration: {
        browserClientId: "citeloom-browser",
      },
      mode: "oauth",
      stagedOAuthConfiguration: null,
      version: 4,
    });
    await expect(identityLinks.unlink(
      principal,
      issuer,
      principal.userId,
    )).rejects.toBeInstanceOf(OAuthIdentityLinkRemovalRejectedError);
    await expect(store.configureHostRecovery(
      principal,
      false,
      activated.version,
      "https://citeloom.example.com",
    )).rejects.toBeInstanceOf(HostRecoveryConfigurationRejectedError);
    await expect(
      session.database.select().from(userSessions),
    ).resolves.toHaveLength(0);
    const principalStore = new OAuthPrincipalStore(session.database);
    const token = {
      clientId: "mcp-client",
      expiresAt: 1_800_000_000,
      issuer,
      scopes: ["citeloom.app"],
      subject,
    };
    const oauthPrincipal = await principalStore.resolvePrincipal(
      token,
      principal.workspaceId,
    );
    expect(oauthPrincipal).toMatchObject({
      globalRole: "global_admin",
      issuer,
      userId: principal.userId,
      workspaceId: principal.workspaceId,
    });
    await expect(principalStore.resolvePrincipalByWorkspaceName(
      token,
      `  ${principal.workspaceName.toUpperCase()}  `,
    )).resolves.toMatchObject({
      userId: principal.userId,
      workspaceId: principal.workspaceId,
      workspaceName: principal.workspaceName,
    });
    const disabled = await store.disable(
      oauthPrincipal,
      activated.version,
      "https://citeloom.example.com",
    );
    expect(disabled).toMatchObject({
      activeOAuthConfiguration: null,
      mode: "local",
      stagedOAuthConfiguration: {
        browserClientId: "citeloom-browser",
      },
      version: 5,
    });
    await expect(store.configureHostRecovery(
      oauthPrincipal,
      false,
      disabled.version,
      "https://citeloom.example.com",
    )).resolves.toMatchObject({
      hostRecoveryEnabled: false,
      mode: "local",
      version: 6,
    });
    await expect(
      session.database
        .select()
        .from(authenticationConfigurationEvents)
        .orderBy(authenticationConfigurationEvents.settingsVersion),
    ).resolves.toEqual([
      expect.objectContaining({
        eventType: "staged",
        fromMode: "local",
        settingsVersion: 2,
        toMode: "local",
      }),
      expect.objectContaining({
        eventType: "host_recovery_enabled",
        fromMode: "local",
        settingsVersion: 3,
        toMode: "local",
      }),
      expect.objectContaining({
        eventType: "activated",
        fromMode: "local",
        settingsVersion: 4,
        toMode: "oauth",
      }),
      expect.objectContaining({
        eventType: "disabled",
        fromMode: "oauth",
        settingsVersion: 5,
        toMode: "local",
      }),
      expect.objectContaining({
        eventType: "host_recovery_disabled",
        fromMode: "local",
        settingsVersion: 6,
        toMode: "local",
      }),
    ]);
  });

  it("recovers OAuth to local auth without changing passwords or restoring sessions", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const authentication = new AuthenticationStore(session.database);
    const initialSession = await authentication.authenticate(decodeLoginInput({
      password: administratorPassword,
      username: administratorUsername,
    }));
    const principal = initialSession.principal;
    const issuer = "https://identity.example.com/oidc";
    const subject = "external-recovery-admin";
    await new OAuthIdentityLinkStore(session.database).link(
      principal,
      issuer,
      principal.userId,
      subject,
    );
    const configuration = parseOAuthApplicationConfiguration({
      apiScopes: ["citeloom.app"],
      browserClientId: "citeloom-browser",
      browserScopes: ["citeloom.app", "openid"],
      issuer,
      mcpScopes: ["citeloom.answer", "citeloom.search"],
    });
    const store = new OAuthApplicationStore(session.database);
    const staged = await store.stage(
      principal,
      configuration,
      1,
      "https://citeloom.example.com",
    );
    const enabled = await store.configureHostRecovery(
      principal,
      true,
      staged.version,
      "https://citeloom.example.com",
    );
    await store.activate(
      principal,
      { issuer, subject },
      enabled.version,
      "https://citeloom.example.com",
    );
    await authentication.authenticate(decodeLoginInput({
      password: administratorPassword,
      username: administratorUsername,
    }));
    const credentialsBefore = await session.database
      .select()
      .from(userPasswordCredentials);

    await expect(store.readHostRecoveryStatus()).resolves.toMatchObject({
      changed: false,
      hostRecoveryEnabled: true,
      mode: "oauth",
      version: 4,
    });
    await expect(store.recoverLocalAuthentication()).resolves.toMatchObject({
      changed: true,
      hostRecoveryEnabled: true,
      mode: "local",
      version: 5,
    });
    await expect(store.recoverLocalAuthentication()).resolves.toMatchObject({
      changed: false,
      mode: "local",
      version: 5,
    });
    await expect(session.database.select().from(userSessions)).resolves.toHaveLength(0);
    await expect(session.database.select().from(userPasswordCredentials))
      .resolves.toEqual(credentialsBefore);
    await expect(session.database
      .select({
        actorUserId: authenticationConfigurationEvents.actorUserId,
        eventType: authenticationConfigurationEvents.eventType,
      })
      .from(authenticationConfigurationEvents)
      .where(eq(authenticationConfigurationEvents.eventType, "recovered")))
      .resolves.toEqual([{ actorUserId: null, eventType: "recovered" }]);

    await expect(authentication.authenticate(decodeLoginInput({
      password: administratorPassword,
      username: administratorUsername,
    }))).resolves.toMatchObject({
      principal: { userId: principal.userId },
    });
    await expect(session.database.select().from(userSessions)).resolves.toHaveLength(1);
  });
});

function removeProviderSpeechDefaults(
  document: StoredApplicationSettings,
  providerId: "mistral" | "together",
): void {
  const profile = document.providers.catalog.find((candidate) => {
    return candidate.id === providerId;
  });
  const connection = document.providers.connections[providerId];
  if (profile === undefined || connection === undefined) {
    throw new Error(`Expected ${providerId} provider defaults.`);
  }
  profile.capabilities = profile.capabilities.filter((capability) => {
    return capability.capability !== "speechToText"
      && capability.capability !== "textToSpeech";
  });
  connection.speechToText.model = null;
  connection.textToSpeech.model = null;
  connection.textToSpeech.voice = null;
  if (providerId === "mistral") {
    connection.customAdapters.speechToText = "openai-transcription";
    connection.customAdapters.textToSpeech = "openai-speech";
  }
}

describe("authentication persistence", () => {
  it("authenticates case-insensitively and persists only a session digest", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);

    const authenticated = await store.authenticate(decodeLoginInput({
      password: administratorPassword,
      remember: false,
      username: "ADMIN",
    }));

    expect(await store.readSession(authenticated.token)).toMatchObject({
      role: "admin",
      username: administratorUsername,
    });
    const rows = await session.database.select().from(userSessions);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenDigest).not.toBe(authenticated.token);
  });

  it("changes a user's password and revokes their other sessions", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const current = await authenticateAdministrator(store);
    const other = await authenticateAdministrator(store);

    await store.changePassword(
      current.principal,
      administratorPassword,
      "a newer secure passphrase",
    );

    await expect(store.readSession(current.token)).resolves.not.toBeNull();
    await expect(store.readSession(other.token)).resolves.toBeNull();
    await expect(store.authenticate(decodeLoginInput({
      password: "a newer secure passphrase",
      username: administratorUsername,
    }))).resolves.toMatchObject({
      principal: { username: administratorUsername },
    });
  });

  it("expires idle sessions and removes their stored token digest", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    let now = new Date("2026-07-20T12:00:00.000Z");
    const store = new AuthenticationStore(session.database, () => now);
    const authenticated = await authenticateAdministrator(store);

    now = new Date("2026-07-20T14:00:00.001Z");

    await expect(store.readSession(authenticated.token)).resolves.toBeNull();
    await expect(session.database.select().from(userSessions)).resolves.toHaveLength(0);
  });

  it("returns the same rejection for unknown users and wrong passwords", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);

    await expect(store.authenticate(decodeLoginInput({
      password: "any attempted password",
      username: "missing",
    }))).rejects.toBeInstanceOf(AuthenticationRejectedError);
    await expect(store.authenticate(decodeLoginInput({
      password: "wrong password",
      username: administratorUsername,
    }))).rejects.toBeInstanceOf(AuthenticationRejectedError);
  });

  it("separates organization accounts, workspace membership, and password links", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const authentication = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(authentication);
    const accounts = new UserAccountStore(session.database);
    const identity = normalizeUserIdentity({
      displayName: "Pending User",
      username: "pending-user",
    });

    const account = await accounts.create(administrator.principal, identity);

    expect(account).toMatchObject({
      currentWorkspaceAccess: false,
      displayName: identity.displayName,
      state: "pending",
      username: identity.username,
      workspaceCount: 0,
    });
    await expect(session.database
      .select({ userId: workspaceMemberships.userId })
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.userId, account.userId)))
      .resolves.toEqual([]);
    await expect(accounts.createPasswordLink(
      administrator.principal,
      account.userId,
    )).rejects.toBeInstanceOf(OrganizationUserWorkspaceRequiredError);
    await expect(authentication.listWorkspaceMemberCandidates(
      administrator.principal,
      administrator.principal.workspaceId,
    )).resolves.toContainEqual(expect.objectContaining({
      state: "pending",
      userId: account.userId,
    }));

    await authentication.addWorkspaceMember(
      administrator.principal,
      administrator.principal.workspaceId,
      account.userId,
      "member",
    );
    await authentication.removeWorkspaceMember(
      administrator.principal,
      administrator.principal.workspaceId,
      account.userId,
    );
    await expect(accounts.list(administrator.principal)).resolves.toContainEqual(
      expect.objectContaining({
        currentWorkspaceAccess: false,
        state: "pending",
        userId: account.userId,
        workspaceCount: 0,
      }),
    );
    await authentication.addWorkspaceMember(
      administrator.principal,
      administrator.principal.workspaceId,
      account.userId,
      "member",
    );
    const replacedSetupLink = await accounts.createPasswordLink(
      administrator.principal,
      account.userId,
    );
    const setupLink = await accounts.createPasswordLink(
      administrator.principal,
      account.userId,
    );
    expect(setupLink.purpose).toBe("setup");
    await expect(authentication.completePasswordSetup(
      replacedSetupLink.setupToken,
      "a secure password 123",
    )).rejects.toBeInstanceOf(SetupTokenRejectedError);

    const activated = await authentication.completePasswordSetup(
      setupLink.setupToken,
      "a secure password 123",
    );
    expect(activated.principal).toMatchObject({
      role: "member",
      userId: account.userId,
      workspaceId: administrator.principal.workspaceId,
    });
    await expect(accounts.list(administrator.principal)).resolves.toContainEqual(
      expect.objectContaining({
        currentWorkspaceAccess: true,
        state: "active",
        userId: account.userId,
        workspaceCount: 1,
      }),
    );
    await expect(accounts.create(activated.principal, normalizeUserIdentity({
      displayName: "Unauthorized User",
      username: "unauthorized-user",
    }))).rejects.toBeInstanceOf(GlobalAuthorizationError);
    await expect(accounts.create(administrator.principal, identity))
      .rejects.toBeInstanceOf(OrganizationUsernameUnavailableError);

    const replacedResetLink = await accounts.createPasswordLink(
      administrator.principal,
      account.userId,
    );
    const resetLink = await accounts.createPasswordLink(
      administrator.principal,
      account.userId,
    );
    expect(resetLink.purpose).toBe("reset");
    await expect(authentication.completePasswordSetup(
      replacedResetLink.setupToken,
      "a newer secure password 456",
    )).rejects.toBeInstanceOf(SetupTokenRejectedError);
    await expect(authentication.completePasswordSetup(
      resetLink.setupToken,
      "a newer secure password 456",
    )).resolves.toMatchObject({
      principal: { userId: account.userId },
    });

    await authentication.removeWorkspaceMember(
      administrator.principal,
      administrator.principal.workspaceId,
      account.userId,
    );
    await expect(accounts.list(administrator.principal)).resolves.toContainEqual(
      expect.objectContaining({
        currentWorkspaceAccess: false,
        state: "active",
        userId: account.userId,
        workspaceCount: 0,
      }),
    );
    await expect(accounts.createPasswordLink(
      administrator.principal,
      account.userId,
    )).rejects.toBeInstanceOf(OrganizationUserWorkspaceRequiredError);
    await expect(session.database
      .select({ userId: userPasswordCredentials.userId })
      .from(userPasswordCredentials)
      .where(eq(userPasswordCredentials.userId, account.userId)))
      .resolves.toEqual([{ userId: account.userId }]);
  });

  it("binds MCP API keys to a user and resolves each selected workspace", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const authentication = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(authentication);
    const accounts = new UserAccountStore(session.database);
    const account = await accounts.create(
      administrator.principal,
      normalizeUserIdentity({
        displayName: "MCP User",
        username: "mcp-user",
      }),
    );
    await authentication.addWorkspaceMember(
      administrator.principal,
      administrator.principal.workspaceId,
      account.userId,
      "member",
    );
    await session.database
      .update(users)
      .set({ state: "active" })
      .where(eq(users.id, account.userId));
    const secondWorkspace = await authentication.createWorkspace(
      administrator.principal,
      {
        configuration: { kind: "organization-defaults" },
        name: "MCP Secondary",
      },
    );
    await authentication.addWorkspaceMember(
      administrator.principal,
      secondWorkspace.id,
      account.userId,
      "member",
    );
    const now = new Date("2026-08-13T19:00:00.000Z");
    const apiKeys = new McpApiKeyStore(session.database, () => now);

    const created = await apiKeys.create(
      administrator.principal,
      account.userId,
      {
        expiresAt: new Date("2026-11-13T19:00:00.000Z"),
        label: "Codex",
        scopes: ["citeloom.search"],
      },
    );

    expect(created).toMatchObject({
      label: "Codex",
      scopes: ["citeloom.search"],
      userId: account.userId,
    });
    expect(created.apiKey).toMatch(/^clm_mcp_/u);
    await expect(session.database
      .select({
        createdByUserId: mcpApiKeys.createdByUserId,
        tokenDigest: mcpApiKeys.tokenDigest,
        userId: mcpApiKeys.userId,
      })
      .from(mcpApiKeys)
      .where(eq(mcpApiKeys.id, created.id)))
      .resolves.toEqual([{
        createdByUserId: administrator.principal.userId,
        tokenDigest: expect.not.stringContaining(created.apiKey),
        userId: account.userId,
      }]);
    const access = await apiKeys.authenticate(
      `bEaReR ${created.apiKey}`,
      administrator.principal.workspaceName,
      ["citeloom.search"],
    );
    expect(access.principal).toMatchObject({
      userId: account.userId,
      workspaceId: administrator.principal.workspaceId,
    });
    await expect(apiKeys.authenticate(
      `Bearer ${created.apiKey}`,
      secondWorkspace.name,
      ["citeloom.search"],
    )).resolves.toMatchObject({
      principal: {
        userId: account.userId,
        workspaceId: secondWorkspace.id,
      },
    });
    await authentication.changeWorkspaceMemberAccess(
      administrator.principal,
      secondWorkspace.id,
      account.userId,
      "disabled",
    );
    await expect(apiKeys.authenticate(
      `Bearer ${created.apiKey}`,
      secondWorkspace.name,
      ["citeloom.search"],
    )).rejects.toBeInstanceOf(McpApiKeyRejectedError);
    await expect(apiKeys.authenticate(
      `Bearer ${created.apiKey}`,
      administrator.principal.workspaceName,
      ["citeloom.answer"],
    )).rejects.toBeInstanceOf(McpApiKeyInsufficientScopeError);
    await expect(apiKeys.list(
      administrator.principal,
      account.userId,
    )).resolves.toEqual([
      expect.objectContaining({ id: created.id, userId: account.userId }),
    ]);

    await apiKeys.revoke(
      administrator.principal,
      account.userId,
      created.id,
    );
    await expect(apiKeys.authenticate(
      `Bearer ${created.apiKey}`,
      administrator.principal.workspaceName,
      ["citeloom.search"],
    )).rejects.toBeInstanceOf(McpApiKeyRejectedError);
  });

  it("allows workspace administrators to manage keys for their workspace users", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const authentication = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(authentication);
    const workspaceAdministratorAccount = await createActiveUser({
      displayName: "Workspace Administrator",
      username: "workspace-api-key-admin",
    });
    await authentication.addWorkspaceMember(
      administrator.principal,
      administrator.principal.workspaceId,
      workspaceAdministratorAccount.userId,
      "admin",
    );
    const workspaceAdministrator = await authenticateTestUser(
      authentication,
      workspaceAdministratorAccount,
    );
    const otherAccount = await createActiveUser({
      displayName: "Other MCP User",
      username: "other-mcp-user",
    });
    await authentication.addWorkspaceMember(
      administrator.principal,
      administrator.principal.workspaceId,
      otherAccount.userId,
      "member",
    );
    const apiKeys = new McpApiKeyStore(session.database);
    const input = {
      expiresAt: new Date(Date.now() + 86_400_000),
      label: null,
      scopes: ["citeloom.search" as const],
    };

    await expect(apiKeys.create(
      workspaceAdministrator.principal,
      workspaceAdministrator.principal.userId,
      input,
    )).resolves.toMatchObject({
      userId: workspaceAdministrator.principal.userId,
    });
    await expect(apiKeys.create(
      workspaceAdministrator.principal,
      otherAccount.userId,
      input,
    )).resolves.toMatchObject({
      userId: otherAccount.userId,
    });
    const outsideAccount = await createActiveUser({
      displayName: "Outside MCP User",
      username: "outside-mcp-user",
    });
    await expect(apiKeys.create(
      workspaceAdministrator.principal,
      outsideAccount.userId,
      input,
    )).rejects.toBeInstanceOf(McpApiKeyTargetUnavailableError);
  });

  it("allows only administrators to add existing users to a workspace", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(store);
    const memberAccount = await createActiveUser({
      displayName: "Member",
      username: "member",
    });
    await store.addWorkspaceMember(
      administrator.principal,
      administrator.principal.workspaceId,
      memberAccount.userId,
    );
    const member = await authenticateTestUser(store, memberAccount);
    const otherAccount = await createActiveUser({
      displayName: "Other",
      username: "other",
    });

    await expect(store.addWorkspaceMember(
      member.principal,
      member.principal.workspaceId,
      otherAccount.userId,
    )).rejects.toBeInstanceOf(WorkspaceAuthorizationError);
  });

  it("lists only eligible existing users and preserves accounts when membership is removed", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(store);
    const candidate = await createActiveUser({
      displayName: "Available User",
      username: "available-user",
    });
    const suspended = await createActiveUser({
      displayName: "Suspended User",
      username: "suspended-user",
    });
    await session.database
      .update(users)
      .set({ state: "suspended" })
      .where(eq(users.id, suspended.userId));

    await expect(store.listWorkspaceMemberCandidates(
      administrator.principal,
      administrator.principal.workspaceId,
    )).resolves.toEqual([{
      displayName: candidate.displayName,
      globalRole: "standard",
      state: "active",
      userId: candidate.userId,
      username: candidate.username,
    }]);

    await store.addWorkspaceMember(
      administrator.principal,
      administrator.principal.workspaceId,
      candidate.userId,
      "member",
    );
    await expect(store.listWorkspaceMemberCandidates(
      administrator.principal,
      administrator.principal.workspaceId,
    )).resolves.toEqual([]);
    await expect(store.addWorkspaceMember(
      administrator.principal,
      administrator.principal.workspaceId,
      candidate.userId,
    )).rejects.toBeInstanceOf(WorkspaceMemberAlreadyExistsError);
    await expect(store.addWorkspaceMember(
      administrator.principal,
      administrator.principal.workspaceId,
      suspended.userId,
    )).rejects.toBeInstanceOf(WorkspaceUserUnavailableError);

    await store.removeWorkspaceMember(
      administrator.principal,
      administrator.principal.workspaceId,
      candidate.userId,
    );

    await expect(session.database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, candidate.userId)))
      .resolves.toEqual([{ id: candidate.userId }]);
    await expect(session.database
      .select({ userId: userPasswordCredentials.userId })
      .from(userPasswordCredentials)
      .where(eq(userPasswordCredentials.userId, candidate.userId)))
      .resolves.toEqual([{ userId: candidate.userId }]);
    await expect(store.listWorkspaceMemberCandidates(
      administrator.principal,
      administrator.principal.workspaceId,
    )).resolves.toEqual([expect.objectContaining({ userId: candidate.userId })]);
  });

  it("protects global administrators and the final active administrator", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(store);

    await expect(store.removeWorkspaceMember(
      administrator.principal,
      administrator.principal.workspaceId,
      administrator.principal.userId,
    )).rejects.toBeInstanceOf(ProtectedGlobalAdministratorError);
    await expect(store.changeWorkspaceMemberRole(
      administrator.principal,
      administrator.principal.workspaceId,
      administrator.principal.userId,
      "member",
    )).rejects.toBeInstanceOf(ProtectedGlobalAdministratorError);

    const secondAccount = await createActiveUser({
      displayName: "Second Administrator",
      username: "second-admin",
    });
    await store.addWorkspaceMember(
      administrator.principal,
      administrator.principal.workspaceId,
      secondAccount.userId,
      "admin",
    );
    const secondAdministrator = await authenticateTestUser(store, secondAccount);
    await session.database
      .update(users)
      .set({ globalRole: "standard" })
      .where(eq(users.id, administrator.principal.userId));
    await store.changeWorkspaceMemberRole(
      secondAdministrator.principal,
      secondAdministrator.principal.workspaceId,
      administrator.principal.userId,
      "member",
    );
    await store.removeWorkspaceMember(
      secondAdministrator.principal,
      secondAdministrator.principal.workspaceId,
      administrator.principal.userId,
    );
    await expect(store.removeWorkspaceMember(
      secondAdministrator.principal,
      secondAdministrator.principal.workspaceId,
      secondAdministrator.principal.userId,
    )).rejects.toBeInstanceOf(FinalWorkspaceAdministratorError);
    await expect(store.changeWorkspaceMemberRole(
      secondAdministrator.principal,
      secondAdministrator.principal.workspaceId,
      secondAdministrator.principal.userId,
      "member",
    )).rejects.toBeInstanceOf(FinalWorkspaceAdministratorError);
    await expect(store.addWorkspaceMember(
      secondAdministrator.principal,
      secondAdministrator.principal.workspaceId,
      administrator.principal.userId,
    )).resolves.toBeUndefined();
  });

  it("disables and restores workspace access without losing membership", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(store);
    const memberAccount = await createActiveUser({
      displayName: "Workspace Member",
      username: "workspace-member",
    });
    await store.addWorkspaceMember(
      administrator.principal,
      administrator.principal.workspaceId,
      memberAccount.userId,
      "member",
    );
    const member = await authenticateTestUser(store, memberAccount);

    await store.changeWorkspaceMemberAccess(
      administrator.principal,
      administrator.principal.workspaceId,
      member.principal.userId,
      "disabled",
    );

    await expect(store.readSession(member.token)).resolves.toBeNull();
    await expect(store.listWorkspaces(member.principal)).resolves.toEqual([]);
    await expect(store.switchWorkspace(
      member.principal,
      administrator.principal.workspaceId,
    )).rejects.toBeInstanceOf(WorkspaceUnavailableError);
    await expect(store.listWorkspaceMembers(
      administrator.principal,
      administrator.principal.workspaceId,
    ))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          access: "disabled",
          role: "member",
          userId: member.principal.userId,
        }),
      ]));

    await store.changeWorkspaceMemberAccess(
      administrator.principal,
      administrator.principal.workspaceId,
      member.principal.userId,
      "enabled",
    );

    await expect(store.listWorkspaces(member.principal)).resolves.toEqual([
      expect.objectContaining({
        id: administrator.principal.workspaceId,
        role: "member",
      }),
    ]);
    await expect(store.authenticate(decodeLoginInput({
      password: "another correct horse battery staple",
      username: "workspace-member",
    }))).resolves.toMatchObject({
      principal: {
        role: "member",
        workspaceId: administrator.principal.workspaceId,
      },
    });
  });

  it("prevents self-disable and disabling a global administrator", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(store);

    await expect(store.changeWorkspaceMemberAccess(
      administrator.principal,
      administrator.principal.workspaceId,
      administrator.principal.userId,
      "disabled",
    )).rejects.toBeInstanceOf(WorkspaceMemberAccessConflictError);

    const otherGlobalAdministratorId = "00000000-0000-4000-8000-000000000902";
    await session.database.insert(users).values({
      displayName: "Other Global Administrator",
      globalRole: "global_admin",
      id: otherGlobalAdministratorId,
      state: "active",
      username: "other-global-admin",
      usernameNormalized: "other-global-admin",
    });
    await session.database.insert(workspaceMemberships).values({
      access: "enabled",
      role: "admin",
      userId: otherGlobalAdministratorId,
      workspaceId: administrator.principal.workspaceId,
    });

    await expect(store.changeWorkspaceMemberAccess(
      administrator.principal,
      administrator.principal.workspaceId,
      otherGlobalAdministratorId,
      "disabled",
    )).rejects.toBeInstanceOf(ProtectedGlobalAdministratorError);
  });
});

describe("workspace provisioning and switching", () => {
  it("provisions a complete workspace and adds the creator as administrator", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(store);

    const workspace = await store.createWorkspace(administrator.principal, {
      configuration: { kind: "organization-defaults" },
      name: "Legal Research",
    });

    expect(workspace).toMatchObject({
      name: "Legal Research",
      role: "admin",
    });
    await expect(session.database
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id)))
      .resolves.toEqual([
        expect.objectContaining({
          role: "admin",
          userId: administrator.principal.userId,
        }),
      ]);
    await expect(session.database
      .select()
      .from(workspaceSecurityPolicies)
      .where(eq(workspaceSecurityPolicies.workspaceId, workspace.id)))
      .resolves.toHaveLength(1);
    await expect(session.database
      .select()
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspace.id)))
      .resolves.toEqual([
        expect.objectContaining({
          settings: {
            providerFeatures: [],
            runtime: {},
            schemaVersion: 1,
          },
          version: 1,
        }),
      ]);
    await expect(session.database
      .select()
      .from(sourceLibraries)
      .where(eq(sourceLibraries.ownerWorkspaceId, workspace.id)))
      .resolves.toEqual([
        expect.objectContaining({ kind: "private", state: "active" }),
      ]);
    await expect(session.database
      .select()
      .from(workspaceAuditEvents)
      .where(eq(workspaceAuditEvents.workspaceId, workspace.id)))
      .resolves.toEqual([
        expect.objectContaining({
          actorUserId: administrator.principal.userId,
          eventType: "workspace.created",
        }),
      ]);
    await expect(store.readSession(administrator.token)).resolves.toMatchObject({
      workspaceId: administrator.principal.workspaceId,
      workspaceName: administrator.principal.workspaceName,
    });
  });

  it("lets global administrators copy explicit overrides without relying on membership", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(store);
    const sourceWorkspaceId = administrator.principal.workspaceId;
    const config = readEqualWeightTestConfig({
      database: { poolMax: 2, url: databaseUrl },
      sourceContent: { directory: sourceContentDirectory, kind: "filesystem" },
    });
    const organization = await new ApplicationSettingsRepository(
      session.database,
    ).read(config.database);
    const answer = readProviderFeatureConfiguration(
      organization.providerSettings,
      "answer",
    );
    if (answer.capability !== "answer") {
      throw new Error("Expected answer provider settings.");
    }
    const sourceSettings = {
      providerFeatures: [{
        ...answer,
        modelOverride: "copied-answer-model",
      }],
      runtime: { retrievalCandidates: 24, topK: 12 },
      schemaVersion: 1 as const,
    };
    await session.database
      .update(workspaceSettings)
      .set({ settings: sourceSettings })
      .where(eq(workspaceSettings.workspaceId, sourceWorkspaceId));
    await session.database
      .delete(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, sourceWorkspaceId));

    await expect(store.listWorkspaces(administrator.principal)).resolves.toContainEqual({
      id: sourceWorkspaceId,
      name: administrator.principal.workspaceName,
      role: "admin",
    });

    const workspace = await store.createWorkspace(administrator.principal, {
      configuration: {
        kind: "workspace-copy",
        workspaceId: sourceWorkspaceId,
      },
      name: "Copied Settings",
    });

    await expect(session.database
      .select({ settings: workspaceSettings.settings })
      .from(workspaceSettings)
      .where(eq(workspaceSettings.workspaceId, workspace.id)))
      .resolves.toEqual([{ settings: sourceSettings }]);
  });

  it("adds every active global administrator to a new workspace", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const creator = await authenticateAdministrator(store);
    const additionalAdministratorId = "00000000-0000-4000-8000-000000000901";
    await session.database.insert(users).values({
      displayName: "Second Global Administrator",
      globalRole: "global_admin",
      id: additionalAdministratorId,
      state: "active",
      username: "second-global-admin",
      usernameNormalized: "second-global-admin",
    });

    const workspace = await store.createWorkspace(creator.principal, {
      configuration: { kind: "organization-defaults" },
      name: "Shared Administration",
    });
    const memberships = await session.database
      .select({ role: workspaceMemberships.role, userId: workspaceMemberships.userId })
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id));

    expect(memberships).toEqual(expect.arrayContaining([
      { role: "admin", userId: creator.principal.userId },
      { role: "admin", userId: additionalAdministratorId },
    ]));
    expect(memberships).toHaveLength(2);
  });

  it("renames workspace metadata without changing its private sources", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(store);
    const originalLibraryRows = await session.database
      .select({
        id: sourceLibraries.id,
        name: sourceLibraries.name,
        ownerWorkspaceId: sourceLibraries.ownerWorkspaceId,
      })
      .from(sourceLibraries)
      .where(eq(
        sourceLibraries.ownerWorkspaceId,
        administrator.principal.workspaceId,
      ));
    const originalLibrary = originalLibraryRows[0];
    if (originalLibrary === undefined) {
      throw new Error("Expected the default private source library.");
    }
    expect(originalLibrary.name).toBeNull();
    const secondWorkspace = await store.createWorkspace(
      administrator.principal,
      {
        configuration: { kind: "organization-defaults" },
        name: "Legal Research",
      },
    );
    await store.switchWorkspace(
      administrator.principal,
      administrator.principal.workspaceId,
    );

    await store.renameWorkspace(
      administrator.principal,
      administrator.principal.workspaceId,
      { name: "Knowledge Operations" },
    );

    await expect(store.readSession(administrator.token)).resolves.toMatchObject({
      workspaceId: administrator.principal.workspaceId,
      workspaceName: "Knowledge Operations",
    });
    await expect(session.database
      .select({
        id: sourceLibraries.id,
        name: sourceLibraries.name,
        ownerWorkspaceId: sourceLibraries.ownerWorkspaceId,
      })
      .from(sourceLibraries)
      .where(eq(sourceLibraries.id, originalLibrary.id)))
      .resolves.toEqual([originalLibrary]);
    const renamedPrivateLibrary = (await new SourceLibraryStore(
      session.database,
    ).listAccessible(administrator.principal)).find((library) => {
      return library.kind === "private";
    });
    expect(renamedPrivateLibrary?.name).toBe("Knowledge Operations");
    await expect(session.database
      .select({ eventType: workspaceAuditEvents.eventType })
      .from(workspaceAuditEvents)
      .where(eq(
        workspaceAuditEvents.workspaceId,
        administrator.principal.workspaceId,
      )))
      .resolves.toContainEqual({ eventType: "workspace.renamed" });
    await expect(store.renameWorkspace(
      administrator.principal,
      secondWorkspace.id,
      { name: "knowledge operations" },
    )).rejects.toBeInstanceOf(WorkspaceNameUnavailableError);
  });

  it("rejects duplicate workspace names during creation", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(store);

    await expect(store.createWorkspace(administrator.principal, {
      configuration: { kind: "organization-defaults" },
      name: "defaultspace",
    })).rejects.toBeInstanceOf(WorkspaceNameUnavailableError);
  });

  it("resolves and updates workspace overrides without changing organization settings", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const authentication = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(authentication);
    const config = readEqualWeightTestConfig({
      database: { poolMax: 2, url: databaseUrl },
      sourceContent: { directory: sourceContentDirectory, kind: "filesystem" },
    });
    const repository = new WorkspaceSettingsRepository(session.database);
    const inherited = await repository.read(
      administrator.principal.workspaceId,
      config.database,
    );
    const answer = readProviderFeatureConfiguration(
      inherited.providerSettings,
      "answer",
    );
    if (answer.capability !== "answer") {
      throw new Error("Expected answer provider settings.");
    }
    const updated = await repository.update(
      administrator.principal.workspaceId,
      administrator.principal.userId,
      config.database,
      inherited.version,
      [
        { key: "retrievalCandidates", value: 24 },
        { key: "topK", value: 12 },
      ],
      [{
        action: "feature",
        configuration: {
          ...answer,
          modelOverride: "workspace-answer-model",
        },
      }],
    );
    const organization = await new ApplicationSettingsRepository(
      session.database,
    ).read(config.database);

    expect(updated.runtimeSettings).toMatchObject({
      retrievalCandidates: 24,
      topK: 12,
    });
    expect(updated.providerSettings.featureOverrides.answer.modelOverride)
      .toBe("workspace-answer-model");
    expect(updated.providerOverrideCapabilities).toEqual(["answer"]);
    expect(organization.runtimeSettings.topK)
      .toBe(inherited.runtimeSettings.topK);
    expect(organization.providerSettings.featureOverrides.answer.modelOverride)
      .toBe(inherited.providerSettings.featureOverrides.answer.modelOverride);

    const reset = await repository.update(
      administrator.principal.workspaceId,
      administrator.principal.userId,
      config.database,
      updated.version,
      [
        { key: "retrievalCandidates", reset: true },
        { key: "topK", reset: true },
      ],
      [{ action: "reset-feature", capability: "answer" }],
    );
    expect(reset.overrides).toEqual({});
    expect(reset.providerOverrideCapabilities).toEqual([]);
    expect(reset.runtimeSettings.topK).toBe(organization.runtimeSettings.topK);
    expect(reset.providerSettings.featureOverrides.answer.modelOverride)
      .toBe(organization.providerSettings.featureOverrides.answer.modelOverride);
  });

  it("does not grant workspace creation to a workspace-only administrator", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(store);
    const workspaceAdministratorAccount = await createActiveUser({
      displayName: "Workspace Administrator",
      username: "workspace-admin",
    });
    await store.addWorkspaceMember(
      administrator.principal,
      administrator.principal.workspaceId,
      workspaceAdministratorAccount.userId,
      "admin",
    );
    const workspaceAdministrator = await authenticateTestUser(
      store,
      workspaceAdministratorAccount,
    );

    expect(workspaceAdministrator.principal.globalRole).toBe("standard");
    await expect(store.createWorkspace(workspaceAdministrator.principal, {
      configuration: { kind: "organization-defaults" },
      name: "Forbidden Workspace",
    })).rejects.toBeInstanceOf(GlobalAuthorizationError);
    await expect(store.renameWorkspace(
      workspaceAdministrator.principal,
      workspaceAdministrator.principal.workspaceId,
      { name: "Forbidden Rename" },
    )).rejects.toBeInstanceOf(GlobalAuthorizationError);
  });

  it("switches only to active workspaces where the user is a member", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(store);
    const memberAccount = await createActiveUser({
      displayName: "Member",
      username: "member",
    });
    await store.addWorkspaceMember(
      administrator.principal,
      administrator.principal.workspaceId,
      memberAccount.userId,
    );
    const member = await authenticateTestUser(store, memberAccount);
    const secondWorkspace = await store.createWorkspace(administrator.principal, {
      configuration: { kind: "organization-defaults" },
      name: "Second Workspace",
    });

    await expect(store.switchWorkspace(
      administrator.principal,
      secondWorkspace.id,
    )).resolves.toMatchObject({
      role: "admin",
      workspaceId: secondWorkspace.id,
      workspaceName: "Second Workspace",
    });
    await expect(store.switchWorkspace(
      member.principal,
      secondWorkspace.id,
    )).rejects.toBeInstanceOf(WorkspaceUnavailableError);
  });

  it("keeps research threads inside their owning workspace", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const authentication = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(authentication);
    const secondWorkspace = await authentication.createWorkspace(
      administrator.principal,
      {
        configuration: { kind: "organization-defaults" },
        name: "Second Workspace",
      },
    );
    const config = readEqualWeightTestConfig({
      database: { poolMax: 2, url: databaseUrl },
      sourceContent: { directory: sourceContentDirectory, kind: "filesystem" },
    });
    const originalResearch = new ResearchStore(
      session.database,
      config,
      administrator.principal.workspaceId,
    );
    const secondResearch = new ResearchStore(
      session.database,
      config,
      secondWorkspace.id,
    );

    const originalThread = await originalResearch.createThread("Quarterly review");
    const secondThread = await secondResearch.createThread("Quarterly review");

    expect(originalThread.id).not.toBe(secondThread.id);
    await expect(originalResearch.listThreads()).resolves.toEqual([
      expect.objectContaining({ id: originalThread.id }),
    ]);
    await expect(secondResearch.listThreads()).resolves.toEqual([
      expect.objectContaining({ id: secondThread.id }),
    ]);
    await expect(originalResearch.readThread(secondThread.id)).resolves.toBe(null);
    await expect(secondResearch.readThread(originalThread.id)).resolves.toBe(null);
  });

  it("shares sources only with explicitly granted workspaces", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const authentication = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(authentication);
    const secondWorkspace = await authentication.createWorkspace(
      administrator.principal,
      {
        configuration: { kind: "organization-defaults" },
        name: "Second Workspace",
      },
    );
    const libraries = new SourceLibraryStore(session.database);
    const shared = await libraries.createShared(administrator.principal, {
      name: "Common Sources",
    });
    const secondWorkspacePrincipal = {
      ...administrator.principal,
      globalRole: "standard" as const,
      workspaceId: secondWorkspace.id,
      workspaceName: secondWorkspace.name,
    };
    await expect(libraries.readAdministration(administrator.principal))
      .resolves.toEqual({
        libraries: [{
          grants: [{
            access: "manage",
            workspaceId: administrator.principal.workspaceId,
          }],
          id: shared.id,
          name: "Common Sources",
          state: "active",
        }],
        workspaces: expect.arrayContaining([
          {
            id: administrator.principal.workspaceId,
            name: administrator.principal.workspaceName,
          },
          { id: secondWorkspace.id, name: secondWorkspace.name },
        ]),
      });
    const originalPrivateLibrary = (await libraries.listAccessible(
      administrator.principal,
    )).find((library) => library.kind === "private");
    if (originalPrivateLibrary === undefined) {
      throw new Error("Expected the original workspace private library.");
    }
    await session.database.insert(workspaceLibraryGrants).values({
      access: "manage",
      libraryId: originalPrivateLibrary.id,
      workspaceId: secondWorkspace.id,
    });

    const secondWorkspaceLibraries = await libraries.listAccessible(
      secondWorkspacePrincipal,
    );
    expect(secondWorkspaceLibraries).toEqual([
      expect.objectContaining({
        access: "manage",
        kind: "private",
        name: "Second Workspace",
      }),
    ]);
    const secondPrivateLibrary = secondWorkspaceLibraries[0];
    if (secondPrivateLibrary === undefined) {
      throw new Error("Expected the second workspace private library.");
    }
    await expect(canAccessSourceLibrary(
      session.database,
      secondWorkspace.id,
      originalPrivateLibrary.id,
      "use",
    )).resolves.toBe(false);
    await expect(canAccessSourceLibrary(
      session.database,
      secondWorkspace.id,
      shared.id,
      "use",
    )).resolves.toBe(false);
    await expect(authorizeSourceLibraryForPrincipal(
      session.database,
      administrator.principal,
      shared.id,
      "manage",
    )).resolves.toEqual({ kind: "global" });
    await expect(authorizeSourceLibraryForPrincipal(
      session.database,
      secondWorkspacePrincipal,
      shared.id,
      "use",
    )).resolves.toEqual({ kind: "unavailable" });
    await expect(authorizeSourceLibraryForPrincipal(
      session.database,
      administrator.principal,
      secondPrivateLibrary.id,
      "manage",
    )).resolves.toEqual({ kind: "unavailable" });

    await libraries.setGrant(
      administrator.principal,
      shared.id,
      secondWorkspace.id,
      "use",
    );

    await expect(libraries.readAdministration(administrator.principal))
      .resolves.toMatchObject({
        libraries: [{
          grants: expect.arrayContaining([
            {
              access: "manage",
              workspaceId: administrator.principal.workspaceId,
            },
            { access: "use", workspaceId: secondWorkspace.id },
          ]),
          id: shared.id,
        }],
      });

    await expect(libraries.listAccessible(secondWorkspacePrincipal)).resolves.toEqual([
      expect.objectContaining({ kind: "private" }),
      expect.objectContaining({
        access: "use",
        id: shared.id,
        kind: "shared",
      }),
    ]);
    await expect(canAccessSourceLibrary(
      session.database,
      secondWorkspace.id,
      shared.id,
      "use",
    )).resolves.toBe(true);
    await expect(canAccessSourceLibrary(
      session.database,
      secondWorkspace.id,
      shared.id,
      "manage",
    )).resolves.toBe(false);

    await libraries.setGrant(
      administrator.principal,
      shared.id,
      secondWorkspace.id,
      "manage",
    );
    await expect(canAccessSourceLibrary(
      session.database,
      secondWorkspace.id,
      shared.id,
      "manage",
    )).resolves.toBe(true);

    await libraries.revokeGrant(
      administrator.principal,
      shared.id,
      secondWorkspace.id,
    );
    await expect(libraries.readAdministration(administrator.principal))
      .resolves.toMatchObject({
        libraries: [{
          grants: [{
            access: "manage",
            workspaceId: administrator.principal.workspaceId,
          }],
          id: shared.id,
        }],
      });
    await expect(canAccessSourceLibrary(
      session.database,
      secondWorkspace.id,
      shared.id,
      "use",
    )).resolves.toBe(false);
  });

  it("renames, archives, and restores shared libraries without losing grants or failed jobs", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const authentication = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(authentication);
    const libraries = new SourceLibraryStore(session.database);
    const shared = await libraries.createShared(administrator.principal, {
      name: "Common Sources",
    });
    const documentId = "a".repeat(64);
    const archivedUploadDocumentId = "b".repeat(64);
    const archivedUploadSourceFile = "/uploads/common/blocked.txt";
    const sourceFile = "/uploads/common/retained.txt";
    await session.database.insert(sourceDocuments).values({
      byteLength: 8,
      documentId,
    });
    await session.database.insert(ingestionJobs).values({
      documentId,
      embeddingSpaceId: "test-space",
      fileExtension: ".txt",
      generationId: "00000000-0000-4000-8000-000000000711",
      mediaType: "text/plain",
      sourceFile,
      sourceLibraryId: shared.id,
      state: "pending",
    });

    try {
      await libraries.renameShared(
        administrator.principal,
        shared.id,
        { name: "Organization Handbook" },
      );
      await expect(libraries.archiveShared(
        administrator.principal,
        shared.id,
      )).rejects.toBeInstanceOf(SourceLibraryArchiveConflictError);

      await session.database
        .update(ingestionJobs)
        .set({ state: "failed" })
        .where(eq(ingestionJobs.sourceFile, sourceFile));
      await libraries.archiveShared(administrator.principal, shared.id);

      await session.database.insert(sourceDocuments).values({
        byteLength: 7,
        documentId: archivedUploadDocumentId,
      });
      const catalog = new DocumentCatalog(session.database);
      await expect(catalog.prepareIngestion({
        documentId: archivedUploadDocumentId,
        duplicateSourceRoot: "/uploads/common",
        embeddingSpaceId: "test-space",
        force: false,
        format: readDocumentFormat(archivedUploadSourceFile),
        maxAttempts: 3,
        requestedTags: [],
        sourceFile: archivedUploadSourceFile,
        sourceLibraryId: shared.id,
        uploadedByUserId: null,
      })).rejects.toBeInstanceOf(SourceLibraryIngestionUnavailableError);

      await expect(libraries.listAccessible(administrator.principal))
        .resolves.not.toEqual(expect.arrayContaining([
          expect.objectContaining({ id: shared.id }),
        ]));
      await expect(libraries.readAdministration(administrator.principal))
        .resolves.toMatchObject({
          libraries: [expect.objectContaining({
            grants: [expect.objectContaining({
              workspaceId: administrator.principal.workspaceId,
            })],
            id: shared.id,
            name: "Organization Handbook",
            state: "archived",
          })],
        });
      await expect(session.database
        .select({ sourceFile: ingestionJobs.sourceFile })
        .from(ingestionJobs)
        .where(eq(ingestionJobs.sourceLibraryId, shared.id)))
        .resolves.toEqual([{ sourceFile }]);

      await libraries.restoreShared(administrator.principal, shared.id);
      await expect(libraries.listAccessible(administrator.principal))
        .resolves.toEqual(expect.arrayContaining([
          expect.objectContaining({
            access: "manage",
            id: shared.id,
            name: "Organization Handbook",
          }),
        ]));
    } finally {
      await session.database
        .delete(ingestionJobs)
        .where(eq(ingestionJobs.sourceFile, sourceFile));
      await session.database
        .delete(sourceDocuments)
        .where(eq(sourceDocuments.documentId, documentId));
      await session.database
        .delete(sourceDocuments)
        .where(eq(sourceDocuments.documentId, archivedUploadDocumentId));
    }
  });

  it("permanently deletes an active shared library and its documents through retryable cleanup", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const authentication = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(authentication);
    const libraries = new SourceLibraryStore(session.database);
    const shared = await libraries.createShared(administrator.principal, {
      name: "Delete Me",
    });
    const content = Buffer.from("permanent shared library deletion");
    const documentId = createHash("sha256").update(content).digest("hex");
    const sourceFile = "/uploads/shared/delete-me.txt";
    const config = readEqualWeightTestConfig({
      database: { poolMax: 2, url: databaseUrl },
      sourceContent: { directory: sourceContentDirectory, kind: "filesystem" },
    });
    const sourceContent = new SourceContentStore(
      session.database,
      config.sourceContent,
    );
    await sourceContent.writeDocument({ content, documentId });
    await session.database
      .update(sourceDocuments)
      .set({ lastPublishedAt: new Date(0) })
      .where(eq(sourceDocuments.documentId, documentId));
    await session.database.insert(ingestionJobs).values({
      documentId,
      embeddingSpaceId: "test-space",
      fileExtension: ".txt",
      generationId: "00000000-0000-4000-8000-000000000712",
      mediaType: "text/plain",
      sourceFile,
      sourceLibraryId: shared.id,
      state: "pending",
    });

    try {
      await expect(requestSharedSourceLibraryDeletion(
        session.database,
        administrator.principal,
        shared.id,
      )).rejects.toThrow(
        "The shared library cannot be deleted while documents are processing.",
      );

      await session.database
        .update(ingestionJobs)
        .set({ state: "failed" })
        .where(eq(ingestionJobs.sourceFile, sourceFile));
      await requestSharedSourceLibraryDeletion(
        session.database,
        administrator.principal,
        shared.id,
      );
      await requestSharedSourceLibraryDeletion(
        session.database,
        administrator.principal,
        shared.id,
      );
      await expect(libraries.readAdministration(administrator.principal))
        .resolves.toMatchObject({
          libraries: [expect.objectContaining({
            id: shared.id,
            state: "deleting",
          })],
        });
      await expect(session.database
        .select()
        .from(sourceLibraryDeletionSources)
        .where(eq(sourceLibraryDeletionSources.libraryId, shared.id)))
        .resolves.toEqual([expect.objectContaining({
          documentId,
          sourceFile,
        })]);

      await expect(reconcileNextSharedSourceLibraryDeletion({
        config,
        database: session.database,
      })).resolves.toBe(true);
      await expect(reconcileNextSharedSourceLibraryDeletion({
        config,
        database: session.database,
      })).resolves.toBe(true);
      await expect(reconcileNextSharedSourceLibraryDeletion({
        config,
        database: session.database,
      })).resolves.toBe(false);

      await expect(session.database
        .select()
        .from(sourceLibraries)
        .where(eq(sourceLibraries.id, shared.id)))
        .resolves.toEqual([]);
      await expect(session.database
        .select()
        .from(ingestionJobs)
        .where(eq(ingestionJobs.sourceFile, sourceFile)))
        .resolves.toEqual([]);
      await expect(session.database
        .select()
        .from(workspaceLibraryGrants)
        .where(eq(workspaceLibraryGrants.libraryId, shared.id)))
        .resolves.toEqual([]);
      await expect(session.database
        .select()
        .from(sourceDocuments)
        .where(eq(sourceDocuments.documentId, documentId)))
        .resolves.toEqual([]);
    } finally {
      await session.database
        .delete(ingestionJobs)
        .where(eq(ingestionJobs.sourceFile, sourceFile));
      await session.database
        .delete(sourceLibraryDeletionSources)
        .where(eq(sourceLibraryDeletionSources.libraryId, shared.id));
      await session.database
        .delete(workspaceLibraryGrants)
        .where(eq(workspaceLibraryGrants.libraryId, shared.id));
      await session.database
        .delete(sourceLibraries)
        .where(eq(sourceLibraries.id, shared.id));
      await session.database
        .delete(sourceDocuments)
        .where(eq(sourceDocuments.documentId, documentId));
    }
  });

  it("archives a workspace without deleting its records and revokes active sessions", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const creator = await authenticateAdministrator(store);
    const workspace = await store.createWorkspace(
      creator.principal,
      {
        configuration: { kind: "organization-defaults" },
        name: "Archive Me",
      },
    );
    await store.switchWorkspace(creator.principal, workspace.id);
    const creatorInWorkspace = await store.readSession(creator.token);
    if (creatorInWorkspace === null) {
      throw new Error("Expected the creator session to remain active.");
    }

    await expect(store.archiveWorkspace(creatorInWorkspace, workspace.id))
      .rejects.toBeInstanceOf(WorkspaceArchiveConflictError);
    const archivingAdministrator = await authenticateAdministrator(store);
    await store.archiveWorkspace(archivingAdministrator.principal, workspace.id);

    await expect(session.database
      .select({ state: workspaces.state })
      .from(workspaces)
      .where(eq(workspaces.id, workspace.id)))
      .resolves.toEqual([{ state: "archived" }]);
    await expect(session.database
      .select({ state: sourceLibraries.state })
      .from(sourceLibraries)
      .where(eq(sourceLibraries.ownerWorkspaceId, workspace.id)))
      .resolves.toEqual([{ state: "archived" }]);
    await expect(session.database
      .select()
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspace.id)))
      .resolves.toHaveLength(1);
    await expect(session.database
      .select()
      .from(userSessions)
      .where(eq(userSessions.activeWorkspaceId, workspace.id)))
      .resolves.toHaveLength(0);
    await expect(session.database
      .select()
      .from(workspaceAuditEvents)
      .where(eq(workspaceAuditEvents.workspaceId, workspace.id)))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: "workspace.created" }),
        expect.objectContaining({ eventType: "workspace.archived" }),
      ]));
    await expect(store.switchWorkspace(
      archivingAdministrator.principal,
      workspace.id,
    )).rejects.toBeInstanceOf(WorkspaceUnavailableError);
  });
});

describe("MCP task persistence", () => {
  it("persists ownership, claims once, and cooperatively cancels", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const authentication = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(authentication);
    const owner = {
      clientId: "mcp-client",
      issuer: "https://identity.example.com/oidc",
      subject: "mcp-task-user",
      userId: administrator.principal.userId,
      workspaceId: administrator.principal.workspaceId,
    };
    const tasks = new McpTaskStore(
      session.database,
      30 * 24 * 60 * 60 * 1_000,
    );
    const task = await tasks.create(owner, {
      question: "What is the retention period?",
      scope: { kind: "all" },
      threadTitle: "Retention research",
    });

    await expect(tasks.readForOwner(owner, task.id)).resolves.toMatchObject({
      id: task.id,
      status: "working",
    });
    await expect(tasks.readForOwner(
      { ...owner, subject: "another-user" },
      task.id,
    )).resolves.toBeNull();

    const leaseOwner = randomUUID();
    await expect(tasks.claim(
      task.id,
      leaseOwner,
      new Date(Date.now() + 30_000),
    )).resolves.toMatchObject({ leaseOwner, status: "working" });
    await expect(tasks.claim(
      task.id,
      randomUUID(),
      new Date(Date.now() + 30_000),
    )).resolves.toBeNull();
    await expect(tasks.requestCancellation(owner, task.id)).resolves.toBe(true);
    await expect(tasks.renewLease(
      task.id,
      leaseOwner,
      new Date(Date.now() + 30_000),
    )).resolves.toBe("cancel");
    await expect(tasks.cancelClaimed(task.id, leaseOwner)).resolves.toBe(true);
    await expect(tasks.readForOwner(owner, task.id)).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("marks an interrupted leased task as a JSON-RPC failure", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const authentication = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(authentication);
    const owner = {
      clientId: "mcp-client",
      issuer: "https://identity.example.com/oidc",
      subject: "mcp-task-user",
      userId: administrator.principal.userId,
      workspaceId: administrator.principal.workspaceId,
    };
    const tasks = new McpTaskStore(
      session.database,
      30 * 24 * 60 * 60 * 1_000,
    );
    const task = await tasks.create(owner, {
      question: "What is the retention period?",
      scope: { kind: "all" },
      threadTitle: "Retention research",
    });
    await tasks.claim(task.id, randomUUID(), new Date(0));

    await expect(tasks.failExpiredLeases(new Date())).resolves.toBe(1);
    await expect(tasks.readForOwner(owner, task.id)).resolves.toMatchObject({
      error: { code: -32_603 },
      status: "failed",
    });
  });

  it("deletes expired terminal tasks in a bounded batch but retains active work", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const authentication = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(authentication);
    const owner = {
      clientId: "mcp-client",
      issuer: "https://identity.example.com/oidc",
      subject: "mcp-task-user",
      userId: administrator.principal.userId,
      workspaceId: administrator.principal.workspaceId,
    };
    const tasks = new McpTaskStore(session.database, 60_000);
    const terminalTask = await tasks.create(owner, {
      question: "What is the retention period?",
      scope: { kind: "all" },
      threadTitle: "Terminal retention research",
    });
    const activeTask = await tasks.create(owner, {
      question: "What remains active?",
      scope: { kind: "all" },
      threadTitle: "Active retention research",
    });
    await expect(tasks.requestCancellation(owner, terminalTask.id)).resolves.toBe(true);
    const afterExpiry = new Date(Math.max(
      terminalTask.expiresAt.getTime(),
      activeTask.expiresAt.getTime(),
    ) + 1);

    await expect(tasks.deleteExpiredTerminalBatch(afterExpiry, 1)).resolves.toBe(1);
    await expect(tasks.readForOwner(owner, terminalTask.id)).resolves.toBeNull();
    await expect(tasks.readForOwner(owner, activeTask.id)).resolves.toMatchObject({
      status: "working",
    });
  });
});

function administratorEnvironment(): NodeJS.ProcessEnv {
  return {
    CITELOOM_ADMIN_PASSWORD: administratorPassword,
    CITELOOM_ADMIN_USERNAME: administratorUsername,
    CITELOOM_SOURCE_CONTENT_DIRECTORY: sourceContentDirectory,
  };
}

async function authenticateAdministrator(store: AuthenticationStore) {
  return store.authenticate(decodeLoginInput({
    password: administratorPassword,
    username: administratorUsername,
  }));
}

interface TestActiveUser {
  displayName: string;
  password: string;
  userId: string;
  username: string;
}

async function createActiveUser(identity: {
  displayName: string;
  username: string;
}): Promise<TestActiveUser> {
  const normalized = normalizeUserIdentity(identity);
  const password = "another correct horse battery staple";
  const userId = randomUUID();
  await session.database.insert(users).values({
    displayName: normalized.displayName,
    globalRole: "standard",
    id: userId,
    state: "active",
    username: normalized.username,
    usernameNormalized: normalized.usernameNormalized,
  });
  await session.database.insert(userPasswordCredentials).values({
    passwordHash: await hashPassword(password),
    userId,
  });
  return {
    displayName: normalized.displayName,
    password,
    userId,
    username: normalized.username,
  };
}

async function authenticateTestUser(
  store: AuthenticationStore,
  user: TestActiveUser,
) {
  return store.authenticate(decodeLoginInput({
    password: user.password,
    username: user.username,
  }));
}
