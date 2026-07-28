import { hostname } from "node:os";
import { pathToFileURL } from "node:url";

import { startWebServer } from "./api/server.js";
import { readStartupConfig } from "./config/index.js";
import { reportEntryPointFailure } from "./observability/entrypoint-errors.js";

export * from "./api/server.js";

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  startWebServer().catch(async (error: unknown) => {
    const errorId = await reportEntryPointFailure(error, {
      category: "startup",
      code: "web_startup_failed",
      instance: hostname(),
      operation: "start-web-server",
      origin: "startup",
      retryable: true,
      service: "web",
      severity: "critical",
    }, () => readStartupConfig().database);
    console.error(`CiteLoom web startup failed. Error ID: ${errorId}.`);
    process.exitCode = 1;
  });
}
