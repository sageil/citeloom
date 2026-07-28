import { fileURLToPath } from "node:url";

import { sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { z } from "zod";

import type { CiteLoomDatabase } from "./client.js";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);
const requiredExtensionNames = ["pg_textsearch", "vector"] as const;

const appliedMigrationRowsSchema = z.array(z.object({
  createdAt: z.coerce.number().int().nonnegative(),
  hash: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict());

const installedExtensionRowsSchema = z.array(z.object({
  name: z.string().min(1),
}).strict());

interface MigrationIdentity {
  createdAt: number;
  hash: string;
}

export interface DatabaseReadiness {
  appliedMigrationCount: number;
  requiredExtensions: readonly string[];
}

export async function readDatabaseReadiness(
  database: CiteLoomDatabase,
): Promise<DatabaseReadiness> {
  const packagedMigrations = readPackagedMigrationIdentities();
  const appliedMigrations = await readAppliedMigrationIdentities(database);
  assertCurrentMigrationHistory(packagedMigrations, appliedMigrations);

  const installedExtensions = await readInstalledExtensionNames(database);
  assertRequiredExtensionsInstalled(installedExtensions);

  return {
    appliedMigrationCount: appliedMigrations.length,
    requiredExtensions: requiredExtensionNames,
  };
}

function readPackagedMigrationIdentities(): MigrationIdentity[] {
  const migrations = readMigrationFiles({ migrationsFolder });
  const identities: MigrationIdentity[] = [];
  for (const migration of migrations) {
    identities.push({
      createdAt: migration.folderMillis,
      hash: migration.hash,
    });
  }
  if (identities.length === 0) {
    throw new Error("No packaged database migrations were found.");
  }
  return identities;
}

async function readAppliedMigrationIdentities(
  database: CiteLoomDatabase,
): Promise<MigrationIdentity[]> {
  const result = await database.execute(sql`
    SELECT
      "created_at" AS "createdAt",
      "hash"
    FROM "drizzle"."__drizzle_migrations"
    ORDER BY "created_at" ASC
  `);
  return decodeAppliedMigrationRows(result.rows);
}

function decodeAppliedMigrationRows(value: unknown): MigrationIdentity[] {
  const parsed = appliedMigrationRowsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `The applied database migration history is invalid: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function assertCurrentMigrationHistory(
  packaged: readonly MigrationIdentity[],
  applied: readonly MigrationIdentity[],
): void {
  const sharedLength = Math.min(packaged.length, applied.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const packagedMigration = packaged[index];
    const appliedMigration = applied[index];
    if (
      packagedMigration === undefined
      || appliedMigration === undefined
      || packagedMigration.createdAt !== appliedMigration.createdAt
      || packagedMigration.hash !== appliedMigration.hash
    ) {
      throw new Error(
        `Database migration history differs from this build at position ${index + 1}.`,
      );
    }
  }

  if (applied.length < packaged.length) {
    const pendingCount = packaged.length - applied.length;
    const noun = pendingCount === 1 ? "migration is" : "migrations are";
    throw new Error(
      `${pendingCount} packaged database ${noun} pending. Run the database migration before starting this build.`,
    );
  }
  if (applied.length > packaged.length) {
    throw new Error(
      "The database contains migrations newer than this build. Deploy a compatible application build.",
    );
  }
}

async function readInstalledExtensionNames(
  database: CiteLoomDatabase,
): Promise<Set<string>> {
  const result = await database.execute(sql`
    SELECT "extname" AS "name"
    FROM "pg_extension"
    WHERE "extname" IN ('pg_textsearch', 'vector')
    ORDER BY "extname" ASC
  `);
  const rows = decodeInstalledExtensionRows(result.rows);
  const names = new Set<string>();
  for (const row of rows) {
    names.add(row.name);
  }
  return names;
}

function decodeInstalledExtensionRows(
  value: unknown,
): Array<{ name: string }> {
  const parsed = installedExtensionRowsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `The PostgreSQL extension response is invalid: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function assertRequiredExtensionsInstalled(installed: ReadonlySet<string>): void {
  const missing: string[] = [];
  for (const extensionName of requiredExtensionNames) {
    if (!installed.has(extensionName)) {
      missing.push(extensionName);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Required PostgreSQL extensions are missing: ${missing.join(", ")}.`,
    );
  }
}
