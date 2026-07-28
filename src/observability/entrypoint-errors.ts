import type { DatabaseConfig } from "../config/index.js";
import { openDatabase, type DatabaseSession } from "../database/client.js";
import {
  ApplicationErrorReporter,
  reportApplicationErrorToContainerLog,
  type ApplicationErrorContext,
} from "./application-errors.js";

export async function reportEntryPointFailure(
  error: unknown,
  context: ApplicationErrorContext,
  readDatabaseConfig: () => DatabaseConfig,
): Promise<string> {
  let session: DatabaseSession | null = null;
  try {
    const databaseConfig = readDatabaseConfig();
    session = await openDatabase(databaseConfig);
    const reporter = new ApplicationErrorReporter(session.database);
    const result = await reporter.report(error, context);
    return result.event.id;
  } catch (persistenceError: unknown) {
    const event = reportApplicationErrorToContainerLog(
      error,
      context,
      persistenceError,
    );
    return event.id;
  } finally {
    if (session !== null) {
      await closeEntryPointDatabaseSession(session, context);
    }
  }
}

async function closeEntryPointDatabaseSession(
  session: DatabaseSession,
  context: ApplicationErrorContext,
): Promise<void> {
  try {
    await session.close();
  } catch (error: unknown) {
    reportApplicationErrorToContainerLog(error, {
      category: "database-operation",
      code: "entrypoint_database_close_failed",
      instance: context.instance ?? null,
      operation: "close-entrypoint-error-reporter",
      origin: "database-operation",
      retryable: true,
      service: context.service,
      severity: "error",
    }, error);
  }
}
