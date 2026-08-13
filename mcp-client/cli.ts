import { pathToFileURL } from "node:url";

import { runMcpSmokeTest } from "./client.js";
import { mcpClientUsage, readMcpClientCommand } from "./config.js";

export async function main(argv: readonly string[] = process.argv.slice(2)) {
  const command = readMcpClientCommand(argv);
  if (command.kind === "help") {
    console.log(mcpClientUsage());
    return;
  }
  const abortController = new AbortController();
  const interrupt = () => {
    abortController.abort(new Error("MCP client interrupted."));
  };
  process.once("SIGINT", interrupt);
  try {
    const report = await runMcpSmokeTest(command.config, {
      log: (message) => console.log(message),
      signal: abortController.signal,
    });
    console.log("MCP smoke test passed.");
    console.log(JSON.stringify(report, null, 2));
  } finally {
    process.off("SIGINT", interrupt);
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`MCP smoke test failed: ${message}`);
    process.exitCode = 1;
  });
}
