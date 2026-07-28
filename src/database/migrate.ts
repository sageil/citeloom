import { hostname } from "node:os";

import { readDatabaseConfig } from "../config/index.js";
import { reportEntryPointFailure } from "../observability/entrypoint-errors.js";
import { setupDatabase } from "./setup.js";

try {
  await setupDatabase(readDatabaseConfig());
  console.log("Database schema and bootstrap data are current.");
} catch (error: unknown) {
  const errorId = await reportEntryPointFailure(error, {
    category: "database-operation",
    code: "database_migration_failed",
    instance: hostname(),
    operation: "migrate-production-database",
    origin: "startup",
    retryable: true,
    service: "database-migrate",
    severity: "critical",
  }, readDatabaseConfig);
  console.error(`CiteLoom database migration failed. Error ID: ${errorId}.`);
  process.exitCode = 1;
}
