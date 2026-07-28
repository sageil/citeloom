import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(repositoryRoot, "dist");

await rm(outputDirectory, { force: true, recursive: true });
await runTypeScriptCompiler(repositoryRoot);

async function runTypeScriptCompiler(workingDirectory: string): Promise<void> {
  const executableName = process.platform === "win32" ? "tsc.cmd" : "tsc";
  const compiler = resolve(
    workingDirectory,
    "node_modules",
    ".bin",
    executableName,
  );
  const child = spawn(
    compiler,
    ["--project", "tsconfig.build.json"],
    {
      cwd: workingDirectory,
      stdio: "inherit",
    },
  );
  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal !== null) {
        reject(new Error(`TypeScript compiler stopped after signal ${signal}.`));
        return;
      }
      resolveExit(code ?? 1);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`TypeScript compiler exited with code ${exitCode}.`);
  }
}
