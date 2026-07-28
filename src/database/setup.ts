import type { DatabaseConfig } from "../config/index.js";
import { applyDatabaseBootstrap } from "./administrator-bootstrap.js";
import { migrateDatabase, openDatabase } from "./client.js";

export async function setupDatabase(
  config: DatabaseConfig,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const session = await openDatabase(config);
  try {
    await migrateDatabase(session.database);
    await applyDatabaseBootstrap(session.database, environment);
  } finally {
    await session.close();
  }
}
