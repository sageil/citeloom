import { createHash } from "node:crypto";
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
  WorkspaceAuthorizationError,
  WorkspaceArchiveConflictError,
  WorkspaceMemberAccessConflictError,
  WorkspaceNameUnavailableError,
  WorkspaceUnavailableError,
} from "../src/auth/store.js";
import {
  type DatabaseSession,
  migrateDatabase,
  openDatabase,
} from "../src/database/client.js";
import { applyDatabaseBootstrap } from "../src/database/administrator-bootstrap.js";
import { ApplicationSettingsRepository } from "../src/app/settings.js";
import { readDoclingServiceTopologyFromConfig } from "../src/config/index.js";
import {
  parseStoredApplicationSettings,
  type StoredApplicationSettings,
} from "../src/providers/settings-persistence.js";
import { readProviderFeatureConfiguration } from "../src/providers/profiles.js";
import {
  applicationSettings,
  ingestionJobs,
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
      expect.objectContaining({ name: "DefaultSpace sources" }),
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

  it("allows only administrators to create workspace members", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(store);
    const memberSetup = await store.createWorkspaceMember(
      administrator.principal,
      normalizeUserIdentity({ displayName: "Member", username: "member" }),
    );
    if (memberSetup.kind !== "setup") {
      throw new Error("Expected a setup token for a new workspace member.");
    }
    const member = await store.completePasswordSetup(
      memberSetup.setupToken,
      "another correct horse battery staple",
    );

    await expect(store.createWorkspaceMember(
      member.principal,
      normalizeUserIdentity({ displayName: "Other", username: "other" }),
    )).rejects.toBeInstanceOf(WorkspaceAuthorizationError);
  });

  it("protects global administrators and the final active administrator", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(store);

    await expect(store.removeWorkspaceMember(
      administrator.principal,
      administrator.principal.userId,
    )).rejects.toBeInstanceOf(ProtectedGlobalAdministratorError);
    await expect(store.changeWorkspaceMemberRole(
      administrator.principal,
      administrator.principal.userId,
      "member",
    )).rejects.toBeInstanceOf(ProtectedGlobalAdministratorError);

    const secondSetup = await store.createWorkspaceMember(
      administrator.principal,
      normalizeUserIdentity({
        displayName: "Second Administrator",
        username: "second-admin",
      }),
      "admin",
    );
    if (secondSetup.kind !== "setup") {
      throw new Error("Expected a setup token for a new workspace administrator.");
    }
    const secondAdministrator = await store.completePasswordSetup(
      secondSetup.setupToken,
      "another correct horse battery staple",
    );
    await session.database
      .update(users)
      .set({ globalRole: "standard" })
      .where(eq(users.id, administrator.principal.userId));
    await store.changeWorkspaceMemberRole(
      secondAdministrator.principal,
      administrator.principal.userId,
      "member",
    );
    await store.removeWorkspaceMember(
      secondAdministrator.principal,
      administrator.principal.userId,
    );
    await expect(store.removeWorkspaceMember(
      secondAdministrator.principal,
      secondAdministrator.principal.userId,
    )).rejects.toBeInstanceOf(FinalWorkspaceAdministratorError);
    await expect(store.changeWorkspaceMemberRole(
      secondAdministrator.principal,
      secondAdministrator.principal.userId,
      "member",
    )).rejects.toBeInstanceOf(FinalWorkspaceAdministratorError);
    await expect(store.createWorkspaceMember(
      secondAdministrator.principal,
      normalizeUserIdentity({
        displayName: "Initial Administrator",
        username: administratorUsername,
      }),
    )).resolves.toEqual({
      kind: "existing",
      userId: administrator.principal.userId,
    });
  });

  it("disables and restores workspace access without losing membership", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(store);
    const memberSetup = await store.createWorkspaceMember(
      administrator.principal,
      normalizeUserIdentity({
        displayName: "Workspace Member",
        username: "workspace-member",
      }),
      "member",
    );
    if (memberSetup.kind !== "setup") {
      throw new Error("Expected a setup token for a new workspace member.");
    }
    const member = await store.completePasswordSetup(
      memberSetup.setupToken,
      "another correct horse battery staple",
    );

    await store.changeWorkspaceMemberAccess(
      administrator.principal,
      member.principal.userId,
      "disabled",
    );

    await expect(store.readSession(member.token)).resolves.toBeNull();
    await expect(store.listWorkspaces(member.principal)).resolves.toEqual([]);
    await expect(store.switchWorkspace(
      member.principal,
      administrator.principal.workspaceId,
    )).rejects.toBeInstanceOf(WorkspaceUnavailableError);
    await expect(store.listWorkspaceMembers(administrator.principal))
      .resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          access: "disabled",
          role: "member",
          userId: member.principal.userId,
        }),
      ]));

    await store.changeWorkspaceMemberAccess(
      administrator.principal,
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
      workspaceId: workspace.id,
      workspaceName: "Legal Research",
    });
  });

  it("copies only explicit settings overrides from an accessible workspace", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(store);
    const sourceWorkspaceId = administrator.principal.workspaceId;
    const config = readEqualWeightTestConfig({
      database: { poolMax: 2, url: databaseUrl },
      sourceContent: { directory: sourceContentDirectory, kind: "filesystem" },
    });
    const topology = readDoclingServiceTopologyFromConfig(config);
    const organization = await new ApplicationSettingsRepository(
      session.database,
    ).read(config.database, topology);
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
    const topology = readDoclingServiceTopologyFromConfig(config);
    const repository = new WorkspaceSettingsRepository(session.database);
    const inherited = await repository.read(
      administrator.principal.workspaceId,
      config.database,
      topology,
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
      topology,
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
    ).read(config.database, topology);

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
      topology,
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
    const setup = await store.createWorkspaceMember(
      administrator.principal,
      normalizeUserIdentity({
        displayName: "Workspace Administrator",
        username: "workspace-admin",
      }),
      "admin",
    );
    if (setup.kind !== "setup") {
      throw new Error("Expected setup for workspace administrator.");
    }
    const workspaceAdministrator = await store.completePasswordSetup(
      setup.setupToken,
      "another correct horse battery staple",
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
    const memberSetup = await store.createWorkspaceMember(
      administrator.principal,
      normalizeUserIdentity({ displayName: "Member", username: "member" }),
    );
    if (memberSetup.kind !== "setup") {
      throw new Error("Expected setup for workspace member.");
    }
    const member = await store.completePasswordSetup(
      memberSetup.setupToken,
      "another correct horse battery staple",
    );
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
        name: "Second Workspace sources",
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
