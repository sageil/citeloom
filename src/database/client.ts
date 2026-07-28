import { fileURLToPath } from "node:url";

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

import type { DatabaseConfig } from "../config/index.js";
import * as schema from "./schema.js";
import { readSqlQuery, type SqlQueryName } from "./sql-queries.js";

export type CiteLoomDatabase = NodePgDatabase<typeof schema>;

export interface DatabaseSession {
  close: () => Promise<void>;
  database: CiteLoomDatabase;
  query: SqlQueryExecutor;
}

export type SqlQueryValue = number | string | string[];

export interface SqlQueryExecutor {
  execute: (
    name: SqlQueryName,
    values: SqlQueryValue[],
  ) => Promise<unknown[]>;
}

const defaultMigrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

export const HNSW_QUERY_SETTINGS = {
  efSearch: 100,
  iterativeScan: "strict_order",
} as const;

export async function openDatabase(
  config: DatabaseConfig,
): Promise<DatabaseSession> {
  const pool = new Pool({
    connectionString: config.url,
    max: config.poolMax,
    options: `-c hnsw.iterative_scan=${HNSW_QUERY_SETTINGS.iterativeScan} -c hnsw.ef_search=${HNSW_QUERY_SETTINGS.efSearch}`,
  });
  const database = drizzle(pool, { schema });

  return {
    close: async (): Promise<void> => pool.end(),
    database,
    query: {
      execute: async (
        name: SqlQueryName,
        values: SqlQueryValue[],
      ): Promise<unknown[]> => {
        const result = await pool.query({
          name,
          text: readSqlQuery(name),
          values,
        });
        return result.rows;
      },
    },
  };
}

export async function migrateDatabase(
  database: CiteLoomDatabase,
  migrationsFolder: string = defaultMigrationsFolder,
): Promise<void> {
  await migrate(database, { migrationsFolder });
}
