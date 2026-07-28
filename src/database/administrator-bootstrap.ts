import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  decodeBootstrapAdministratorInput,
  type BootstrapAdministratorInput,
} from "../auth/boundary.js";
import { hashPassword, readPassword } from "../auth/password.js";
import type { SourceContentConfig } from "../config/index.js";
import { SourceContentStore } from "../documents/storage/source-content-store.js";
import type { CiteLoomDatabase } from "./client.js";
import { applicationSettings } from "./schema.js";

const administratorBootstrapEnvironmentSchema = z.object({
  CITELOOM_ADMIN_PASSWORD: z.string().min(1),
  CITELOOM_ADMIN_USERNAME: z.string().min(1),
});
const sourceContentBootstrapEnvironmentSchema = z.object({
  CITELOOM_SOURCE_CONTENT_DIRECTORY: z.string()
    .trim()
    .min(1)
    .default("documents/blobs"),
});
const storedSourceContentSchema = z.object({
  sourceContent: z.object({
    directory: z.string().trim().min(1),
  }).strict(),
}).loose();
const bootstrapSqlUrl = new URL("../../drizzle/bootstrap.sql", import.meta.url);
const bootstrapSql = readFileSync(bootstrapSqlUrl, "utf8").trim();

export interface AdministratorBootstrapConfig {
  administrator: BootstrapAdministratorInput;
  password: string;
}

export function readAdministratorBootstrapConfig(
  environment: NodeJS.ProcessEnv,
): AdministratorBootstrapConfig {
  const result = administratorBootstrapEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const details = result.error.issues.map((issue) => {
      const path = issue.path.join(".");
      return `${path}: ${issue.message}`;
    }).join("\n");
    throw new Error(`Invalid administrator bootstrap configuration:\n${details}`);
  }

  const administrator = decodeBootstrapAdministratorInput({
    displayName: result.data.CITELOOM_ADMIN_USERNAME,
    username: result.data.CITELOOM_ADMIN_USERNAME,
    workspaceName: "CiteLoom",
    workspaceSlug: "citeloom",
  });
  return {
    administrator,
    password: readPassword(result.data.CITELOOM_ADMIN_PASSWORD),
  };
}

export function readSourceContentBootstrapConfig(
  environment: NodeJS.ProcessEnv,
): SourceContentConfig {
  const result = sourceContentBootstrapEnvironmentSchema.safeParse(environment);
  if (!result.success) {
    const details = result.error.issues.map((issue) => {
      const path = issue.path.join(".");
      return `${path}: ${issue.message}`;
    }).join("\n");
    throw new Error(`Invalid source content bootstrap configuration:\n${details}`);
  }
  return {
    directory: resolve(result.data.CITELOOM_SOURCE_CONTENT_DIRECTORY),
  };
}

export async function applyDatabaseBootstrap(
  database: CiteLoomDatabase,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (bootstrapSql.length === 0) {
    throw new Error("Database bootstrap SQL is empty.");
  }
  const config = readAdministratorBootstrapConfig(environment);
  const sourceContent = readSourceContentBootstrapConfig(environment);
  await prepareSourceContentDirectory(database, sourceContent);
  const passwordHash = await hashPassword(config.password);

  await database.transaction(async (transaction) => {
    await transaction.execute(sql`
      SELECT
        set_config(
          'citeloom.bootstrap_administrator_display_name',
          ${config.administrator.displayName},
          true
        ),
        set_config(
          'citeloom.bootstrap_administrator_password_hash',
          ${passwordHash},
          true
        ),
        set_config(
          'citeloom.bootstrap_administrator_username',
          ${config.administrator.username},
          true
        ),
        set_config(
          'citeloom.bootstrap_administrator_username_normalized',
          ${config.administrator.usernameNormalized},
          true
        ),
        set_config(
          'citeloom.source_content_directory',
          ${sourceContent.directory},
          true
        )
    `);
    await transaction.execute(sql.raw(bootstrapSql));
  });
}

async function prepareSourceContentDirectory(
  database: CiteLoomDatabase,
  sourceContent: SourceContentConfig,
): Promise<void> {
  const currentDirectory = await readStoredSourceContentDirectory(database);
  const store = new SourceContentStore(database, sourceContent);
  await store.initialize();
  if (currentDirectory === sourceContent.directory) {
    await store.assertStoredDocumentsPresent();
    return;
  }
  await store.verifyStoredDocuments();
}

async function readStoredSourceContentDirectory(
  database: CiteLoomDatabase,
): Promise<string | null> {
  const rows = await database
    .select({ settings: applicationSettings.settings })
    .from(applicationSettings)
    .where(eq(applicationSettings.id, "runtime"))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const result = storedSourceContentSchema.safeParse(row.settings);
  if (!result.success) {
    throw new Error(
      `Invalid stored source-content configuration: ${result.error.message}`,
    );
  }
  return result.data.sourceContent.directory;
}
