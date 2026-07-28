import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it, vi } from "vitest";

import type { CiteLoomDatabase } from "../src/database/client.js";
import { readDatabaseReadiness } from "../src/database/readiness.js";

vi.mock("drizzle-orm/migrator", () => {
  return {
    readMigrationFiles: vi.fn(),
  };
});

const migrationHashA = "a".repeat(64);
const migrationHashB = "b".repeat(64);

describe("database readiness", () => {
  it("accepts the exact packaged migration history and required extensions", async () => {
    mockPackagedMigrations();
    const database = buildDatabase([
      {
        rows: [
          { createdAt: "1000", hash: migrationHashA },
          { createdAt: "2000", hash: migrationHashB },
        ],
      },
      {
        rows: [{ name: "pg_textsearch" }, { name: "vector" }],
      },
    ]);

    await expect(readDatabaseReadiness(database)).resolves.toEqual({
      appliedMigrationCount: 2,
      requiredExtensions: ["pg_textsearch", "vector"],
    });
  });

  it("rejects pending packaged migrations", async () => {
    mockPackagedMigrations();
    const database = buildDatabase([
      {
        rows: [{ createdAt: "1000", hash: migrationHashA }],
      },
    ]);

    await expect(readDatabaseReadiness(database)).rejects.toThrow(
      "1 packaged database migration is pending",
    );
  });

  it("rejects altered migration history", async () => {
    mockPackagedMigrations();
    const database = buildDatabase([
      {
        rows: [
          { createdAt: "1000", hash: migrationHashA },
          { createdAt: "2000", hash: "c".repeat(64) },
        ],
      },
    ]);

    await expect(readDatabaseReadiness(database)).rejects.toThrow(
      "Database migration history differs from this build at position 2",
    );
  });

  it("rejects a database newer than the packaged build", async () => {
    mockPackagedMigrations();
    const database = buildDatabase([
      {
        rows: [
          { createdAt: "1000", hash: migrationHashA },
          { createdAt: "2000", hash: migrationHashB },
          { createdAt: "3000", hash: "c".repeat(64) },
        ],
      },
    ]);

    await expect(readDatabaseReadiness(database)).rejects.toThrow(
      "The database contains migrations newer than this build",
    );
  });

  it("rejects missing required extensions", async () => {
    mockPackagedMigrations();
    const database = buildDatabase([
      {
        rows: [
          { createdAt: "1000", hash: migrationHashA },
          { createdAt: "2000", hash: migrationHashB },
        ],
      },
      {
        rows: [{ name: "vector" }],
      },
    ]);

    await expect(readDatabaseReadiness(database)).rejects.toThrow(
      "Required PostgreSQL extensions are missing: pg_textsearch",
    );
  });
});

function mockPackagedMigrations(): void {
  vi.mocked(readMigrationFiles).mockReturnValue([
    {
      bps: true,
      folderMillis: 1_000,
      hash: migrationHashA,
      sql: [],
    },
    {
      bps: true,
      folderMillis: 2_000,
      hash: migrationHashB,
      sql: [],
    },
  ]);
}

function buildDatabase(
  results: Array<{ rows: unknown[] }>,
): CiteLoomDatabase {
  let resultIndex = 0;
  const database = {
    execute: vi.fn(async () => {
      const result = results[resultIndex];
      resultIndex += 1;
      if (result === undefined) {
        throw new Error("Unexpected database query.");
      }
      return result;
    }),
  };
  return database as unknown as CiteLoomDatabase;
}
