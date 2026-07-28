import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const codePaths = [
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package.json",
  "queries",
  "src",
  "tools/evaluation",
  "tsconfig.build.json",
  "tsconfig.json",
];

export async function readEvaluationCodeIdentity(
  workingDirectory: string = process.cwd(),
): Promise<string> {
  let commit: string;
  let fileList: string;
  try {
    const [commitResult, filesResult] = await Promise.all([
      executeFile("git", ["rev-parse", "HEAD"], { cwd: workingDirectory }),
      executeFile(
        "git",
        [
          "ls-files",
          "-z",
          "--cached",
          "--others",
          "--exclude-standard",
          "--",
          ...codePaths,
        ],
        { cwd: workingDirectory },
      ),
    ]);
    commit = commitResult.stdout.trim();
    fileList = filesResult.stdout;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot determine the evaluation code revision: ${message}`);
  }

  const paths = fileList.split("\0").filter((value) => value !== "");
  paths.sort();
  const digest = createHash("sha256");
  for (const path of paths) {
    const content = await readFile(resolve(workingDirectory, path));
    digest.update(path);
    digest.update("\0");
    digest.update(content);
    digest.update("\0");
  }
  return `${commit}:${digest.digest("hex")}`;
}
