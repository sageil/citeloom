import { pathToFileURL } from "node:url";

import { main } from "./command-runner.js";

export { main } from "./command-runner.js";
export {
  parseEvaluationCommand,
  type EvaluationCommand,
} from "./command-parser.js";

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}
