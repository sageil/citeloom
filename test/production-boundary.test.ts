import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const executeFile = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("production boundary", () => {
  it("builds without including evaluation tooling", async () => {
    const executableName = process.platform === "win32" ? "tsc.cmd" : "tsc";
    const compiler = resolve(
      repositoryRoot,
      "node_modules",
      ".bin",
      executableName,
    );
    const result = await executeFile(
      compiler,
      [
        "--listFilesOnly",
        "--noEmit",
        "--project",
        "tsconfig.build.json",
      ],
      {
        cwd: repositoryRoot,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const productionFiles = result.stdout.split("\n");
    const includesEvaluationTool = productionFiles.some((path) => {
      return path.includes("/tools/evaluation/");
    });
    expect(includesEvaluationTool).toBe(false);
  });

  it("keeps evaluation files outside production source and container inputs", async () => {
    const productionEvaluationPaths = [
      "src/app/evaluation-code-identity.ts",
      "src/documents/corpus",
      "src/evaluation",
    ];
    for (const relativePath of productionEvaluationPaths) {
      await expect(pathExists(resolve(repositoryRoot, relativePath)))
        .resolves.toBe(false);
    }

    const dockerfile = await readFile(
      resolve(repositoryRoot, "infra/Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain("COPY src ./src");
    expect(dockerfile).not.toMatch(/^COPY tools(?:\/|\s)/mu);
  });
});

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
