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
import { parseSourceContentConfig } from "../providers/settings-persistence.js";
import type { CiteLoomDatabase } from "./client.js";
import { applicationSettings } from "./schema.js";

const administratorBootstrapEnvironmentSchema = z.object({
  CITELOOM_ADMIN_PASSWORD: z.string().min(1),
  CITELOOM_ADMIN_USERNAME: z.string().min(1),
});
const sourceContentBootstrapEnvironmentSchema = z.object({
  CITELOOM_SOURCE_CONTENT_BACKEND: z.enum(["filesystem", "s3"])
    .default("filesystem"),
  CITELOOM_SOURCE_CONTENT_DIRECTORY: z.string()
    .trim()
    .min(1)
    .default("documents/blobs"),
  CITELOOM_SOURCE_CONTENT_S3_BUCKET: z.string().trim().min(1).max(63)
    .default("citeloom"),
  CITELOOM_SOURCE_CONTENT_S3_ENDPOINT: z.url().default("http://127.0.0.1:8333"),
  CITELOOM_SOURCE_CONTENT_S3_FORCE_PATH_STYLE: z.enum(["true", "false"])
    .default("true"),
  CITELOOM_SOURCE_CONTENT_S3_PREFIX: z.string().trim().min(1).max(512)
    .default("sources"),
  CITELOOM_SOURCE_CONTENT_S3_REGION: z.string().trim().min(1).max(100)
    .default("us-east-1"),
});
const storedSourceContentSchema = z.object({
  sourceContent: z.unknown(),
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
    workspaceName: "DefaultSpace",
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
  if (result.data.CITELOOM_SOURCE_CONTENT_BACKEND === "s3") {
    const config = {
      bucket: result.data.CITELOOM_SOURCE_CONTENT_S3_BUCKET,
      credentials: { kind: "environment" as const },
      endpointUrl: result.data.CITELOOM_SOURCE_CONTENT_S3_ENDPOINT,
      forcePathStyle:
        result.data.CITELOOM_SOURCE_CONTENT_S3_FORCE_PATH_STYLE === "true",
      kind: "s3" as const,
      prefix: result.data.CITELOOM_SOURCE_CONTENT_S3_PREFIX,
      region: result.data.CITELOOM_SOURCE_CONTENT_S3_REGION,
    };
    return parseSourceContentConfig(config);
  }
  const config = {
    directory: resolve(result.data.CITELOOM_SOURCE_CONTENT_DIRECTORY),
    kind: "filesystem" as const,
  };
  return parseSourceContentConfig(config);
}

export async function applyDatabaseBootstrap(
  database: CiteLoomDatabase,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (bootstrapSql.length === 0) {
    throw new Error("Database bootstrap SQL is empty.");
  }
  const config = readAdministratorBootstrapConfig(environment);
  const bootstrapSourceContent = readSourceContentBootstrapConfig(environment);
  const sourceContent = await prepareSourceContentBackend(
    database,
    bootstrapSourceContent,
  );
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
          'citeloom.source_content_config',
          ${JSON.stringify(sourceContent)},
          true
        )
    `);
    await transaction.execute(sql.raw(bootstrapSql));
  });
}

async function prepareSourceContentBackend(
  database: CiteLoomDatabase,
  bootstrapSourceContent: SourceContentConfig,
): Promise<SourceContentConfig> {
  const currentConfig = await readStoredSourceContentConfig(database);
  if (currentConfig === null) {
    const store = new SourceContentStore(database, bootstrapSourceContent);
    await store.initialize();
    return bootstrapSourceContent;
  }
  const store = new SourceContentStore(database, currentConfig);
  await store.assertStoredDocumentsPresent();
  return currentConfig;
}

async function readStoredSourceContentConfig(
  database: CiteLoomDatabase,
): Promise<SourceContentConfig | null> {
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
  return parseSourceContentConfig(result.data.sourceContent);
}
