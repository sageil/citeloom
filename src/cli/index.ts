import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

import { readDatabaseConfig } from "../config/index.js";
import { sanitizeDiagnosticMessage } from "../observability/application-errors.js";
import { reportEntryPointFailure } from "../observability/entrypoint-errors.js";
import { main } from "./command-runner.js";
import { CliUsageError } from "./command-parser.js";

export { main } from "./command-runner.js";
export { parseCliCommand, type CliCommand } from "./command-parser.js";

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch(async (error: unknown) => {
    if (error instanceof CliUsageError) {
      console.error(`Error: ${sanitizeDiagnosticMessage(error.message)}`);
      process.exitCode = 1;
      return;
    }
    const errorId = await reportEntryPointFailure(error, {
      category: "cli",
      code: "cli_command_failed",
      instance: hostname(),
      operation: "execute-cli-command",
      origin: "cli",
      retryable: null,
      service: "cli",
      severity: "error",
    }, readDatabaseConfig);
    console.error(`CiteLoom command failed. Error ID: ${errorId}.`);
    process.exitCode = 1;
  });
}
