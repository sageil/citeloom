import { fileURLToPath } from "node:url";

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";

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
    options?: SqlQueryExecutionOptions,
  ) => Promise<unknown[]>;
  withDatabase?: <Result>(
    operation: (database: CiteLoomDatabase) => Promise<Result>,
    options?: SqlQueryExecutionOptions,
  ) => Promise<Result>;
}

export interface SqlQueryExecutionOptions {
  abortSignal?: AbortSignal;
  statementTimeoutMs?: number;
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
  const cancellationPool = new Pool({
    connectionString: config.url,
    max: Math.min(2, config.poolMax),
  });
  const database = drizzle(pool, { schema });

  return {
    close: async (): Promise<void> => {
      await Promise.all([pool.end(), cancellationPool.end()]);
    },
    database,
    query: {
      execute: async (
        name: SqlQueryName,
        values: SqlQueryValue[],
        options: SqlQueryExecutionOptions = {},
      ): Promise<unknown[]> => {
        return runCancelableDatabaseOperation(
          pool,
          cancellationPool,
          options,
          async (client) => {
            const result = await client.query({
              name,
              text: readSqlQuery(name),
              values,
            });
            return result.rows;
          },
        );
      },
      withDatabase: async <Result>(
        operation: (operationDatabase: CiteLoomDatabase) => Promise<Result>,
        options: SqlQueryExecutionOptions = {},
      ): Promise<Result> => {
        return runCancelableDatabaseOperation(
          pool,
          cancellationPool,
          options,
          async (client) => {
            const operationDatabase = drizzle(client, { schema });
            return operation(operationDatabase);
          },
        );
      },
    },
  };
}

async function runCancelableDatabaseOperation<Result>(
  pool: Pool,
  cancellationPool: Pool,
  options: SqlQueryExecutionOptions,
  operation: (client: PoolClient) => Promise<Result>,
): Promise<Result> {
  options.abortSignal?.throwIfAborted();
  const timeoutMs = readStatementTimeoutMs(options.statementTimeoutMs);
  const client = await pool.connect();
  let cancellation: Promise<unknown> | null = null;
  let backendPid: number | null = null;
  let destroyClient = false;
  const cancel = (): void => {
    if (backendPid === null || cancellation !== null) {
      return;
    }
    cancellation = cancellationPool.query(
      "SELECT pg_cancel_backend($1)",
      [backendPid],
    );
  };
  try {
    const pidResult = await client.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    const pid = pidResult.rows[0]?.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid)) {
      throw new Error("PostgreSQL did not return a valid backend PID.");
    }
    backendPid = pid;
    options.abortSignal?.addEventListener("abort", cancel, { once: true });
    let outcome: DatabaseOperationOutcome<Result>;
    try {
      options.abortSignal?.throwIfAborted();
      if (timeoutMs !== null) {
        await client.query(
          "SELECT set_config('statement_timeout', $1, false)",
          [`${timeoutMs}ms`],
        );
      }
      outcome = { kind: "success", value: await operation(client) };
    } catch (error: unknown) {
      try {
        options.abortSignal?.throwIfAborted();
        outcome = { error, kind: "error" };
      } catch (abortError: unknown) {
        outcome = { error: abortError, kind: "error" };
      }
    }
    options.abortSignal?.removeEventListener("abort", cancel);
    let cleanupError: unknown;
    let cleanupFailed = false;
    if (cancellation !== null) {
      try {
        await cancellation;
      } catch (error: unknown) {
        cleanupError = error;
        cleanupFailed = true;
      }
    }
    if (timeoutMs !== null) {
      try {
        await client.query(
          "SELECT set_config('statement_timeout', '0', false)",
        );
      } catch (error: unknown) {
        destroyClient = true;
        cleanupError = error;
        cleanupFailed = true;
      }
    }
    if (outcome.kind === "error") {
      throw outcome.error;
    }
    if (cleanupFailed) {
      throw cleanupError;
    }
    return outcome.value;
  } finally {
    options.abortSignal?.removeEventListener("abort", cancel);
    client.release(destroyClient);
  }
}

type DatabaseOperationOutcome<Result> =
  | { kind: "success"; value: Result }
  | { error: unknown; kind: "error" };

function readStatementTimeoutMs(value: number | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("PostgreSQL statement timeout must be positive.");
  }
  return value;
}

export async function migrateDatabase(
  database: CiteLoomDatabase,
  migrationsFolder: string = defaultMigrationsFolder,
): Promise<void> {
  await migrate(database, { migrationsFolder });
}
