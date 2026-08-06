import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import {
  decodeLoginInput,
  normalizeUserIdentity,
} from "../src/auth/boundary.js";
import {
  AuthenticationRejectedError,
  AuthenticationStore,
  FinalWorkspaceAdministratorError,
  WorkspaceAuthorizationError,
} from "../src/auth/store.js";
import {
  type DatabaseSession,
  migrateDatabase,
  openDatabase,
} from "../src/database/client.js";
import { applyDatabaseBootstrap } from "../src/database/administrator-bootstrap.js";
import { parseStoredApplicationSettings } from "../src/providers/settings-persistence.js";
import {
  applicationSettings,
  sourceDocuments,
  userPasswordCredentials,
  userSessions,
  userSetupTokens,
  users,
  workspaceMemberships,
  workspaces,
} from "../src/database/schema.js";

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
  await session.database.delete(workspaceMemberships);
  await session.database.delete(users);
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
        role: "admin",
        username: administratorUsername,
        workspaceName: "CiteLoom",
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
    await expect(session.database.select().from(workspaces)).resolves.toHaveLength(1);
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
    }
  });

  it("adds missing defaults without overwriting live providers", async () => {
    await session.database.delete(applicationSettings);
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const seededRows = await session.database
      .select({ settings: applicationSettings.settings })
      .from(applicationSettings)
      .where(eq(applicationSettings.id, "runtime"));
    const seededRow = seededRows[0];
    if (seededRow === undefined) {
      throw new Error("Expected seeded application settings.");
    }
    const seeded = parseStoredApplicationSettings(seededRow.settings);
    const lmStudioProfile = seeded.providers.catalog.find((profile) => {
      return profile.id === "lmstudio";
    });
    const groqConnection = seeded.providers.connections.groq;
    if (lmStudioProfile === undefined || groqConnection === undefined) {
      throw new Error("Expected LM Studio and Groq defaults.");
    }
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
        defaults: sql`${applicationSettings.defaults} #- '{providers,catalog}'`,
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
    expect(defaults.providers.catalog).toHaveLength(11);
    expect(settings.providers.catalog).toHaveLength(12);
    expect(settings.providers.catalog).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "database-provider" }),
      expect.objectContaining({ id: "openrouter" }),
    ]));
    expect(settings.providers.connections.openrouter).toBeDefined();
    expect(
      settings.providers.connections.groq?.maximumParallelRequests,
    ).toBe(7);
  });

});

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

  it("prevents removal or demotion of the final active administrator", async () => {
    await applyDatabaseBootstrap(session.database, administratorEnvironment());
    const store = new AuthenticationStore(session.database);
    const administrator = await authenticateAdministrator(store);

    await expect(store.removeWorkspaceMember(
      administrator.principal,
      administrator.principal.userId,
    )).rejects.toBeInstanceOf(FinalWorkspaceAdministratorError);
    await expect(store.changeWorkspaceMemberRole(
      administrator.principal,
      administrator.principal.userId,
      "member",
    )).rejects.toBeInstanceOf(FinalWorkspaceAdministratorError);

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
    await expect(store.changeWorkspaceMemberRole(
      administrator.principal,
      administrator.principal.userId,
      "member",
    )).resolves.toBeUndefined();
    await store.removeWorkspaceMember(
      secondAdministrator.principal,
      administrator.principal.userId,
    );
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
