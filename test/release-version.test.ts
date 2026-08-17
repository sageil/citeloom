import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const releaseVersionScript = fileURLToPath(
  new URL("../scripts/release-version.mjs", import.meta.url),
);

describe("release version synchronization", () => {
  it("updates every derived release value from one version input", async () => {
    const repositoryRoot = await createReleaseFixture();
    try {
      const update = runReleaseVersion(repositoryRoot, "1.2.3");
      expect(update.status, update.stderr).toBe(0);

      const paths = releaseFixturePaths();
      for (const path of paths) {
        const contents = await readFile(join(repositoryRoot, path), "utf8");
        expect(contents).not.toContain("1.1.0");
        expect(contents).toContain("1.2.3");
      }

      const check = runReleaseVersion(repositoryRoot, "--check");
      expect(check.status, check.stderr).toBe(0);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  it("detects a derived value that differs from package.json", async () => {
    const repositoryRoot = await createReleaseFixture();
    try {
      const docsitePackagePath = join(repositoryRoot, "docsite/package.json");
      await writeFile(
        docsitePackagePath,
        '{\n  "name": "citeloom-docs",\n  "version": "1.1.9"\n}\n',
        "utf8",
      );

      const check = runReleaseVersion(repositoryRoot, "--check");
      expect(check.status).not.toBe(0);
      expect(check.stderr).toContain(
        "contains release version 1.1.9; expected 1.1.0",
      );
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  it("rejects an invalid version before it writes files", async () => {
    const repositoryRoot = await createReleaseFixture();
    try {
      const packagePath = join(repositoryRoot, "package.json");
      const originalPackage = await readFile(packagePath, "utf8");

      const update = runReleaseVersion(repositoryRoot, "v1.2.3");
      expect(update.status).not.toBe(0);
      expect(update.stderr).toContain("Invalid release version: v1.2.3");
      await expect(readFile(packagePath, "utf8")).resolves.toBe(originalPackage);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  it("does not write a partial update when a derived file is invalid", async () => {
    const repositoryRoot = await createReleaseFixture();
    try {
      const packagePath = join(repositoryRoot, "package.json");
      const originalPackage = await readFile(packagePath, "utf8");
      const composePath = join(repositoryRoot, "compose.yml");
      await writeFile(
        composePath,
        "CITELOOM_RELEASE: ${CITELOOM_RELEASE:-1.1.0}\n",
        "utf8",
      );

      const update = runReleaseVersion(repositoryRoot, "1.2.3");
      expect(update.status).not.toBe(0);
      expect(update.stderr).toContain(
        "contains 1 matching release-version values; expected 2",
      );
      await expect(readFile(packagePath, "utf8")).resolves.toBe(originalPackage);
    } finally {
      await rm(repositoryRoot, { force: true, recursive: true });
    }
  });
});

function runReleaseVersion(repositoryRoot: string, argument: string) {
  return spawnSync(
    process.execPath,
    [releaseVersionScript, argument, "--root", repositoryRoot],
    { encoding: "utf8" },
  );
}

async function createReleaseFixture(): Promise<string> {
  const repositoryRoot = await mkdtemp(join(tmpdir(), "citeloom-release-version-"));
  const files = releaseFixtureFiles();
  for (const file of files) {
    const path = join(repositoryRoot, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.contents, "utf8");
  }
  return repositoryRoot;
}

function releaseFixturePaths(): string[] {
  const paths: string[] = [];
  const files = releaseFixtureFiles();
  for (const file of files) {
    paths.push(file.path);
  }
  return paths;
}

function releaseFixtureFiles(): Array<{ contents: string; path: string }> {
  return [
    {
      contents: '{\n  "name": "citeloom",\n  "version": "1.1.0"\n}\n',
      path: "package.json",
    },
    {
      contents: "CITELOOM_RELEASE=1.1.0\nCITELOOM_IMAGE_TAG=1.1.0\n",
      path: ".env.example",
    },
    {
      contents: [
        "image: sageil/citeloom:${CITELOOM_IMAGE_TAG:-1.1.0}",
        "image: sageil/citeloom:${CITELOOM_IMAGE_TAG:-1.1.0}",
        "image: sageil/citeloom:${CITELOOM_IMAGE_TAG:-1.1.0}",
        "image: sageil/citeloom:${CITELOOM_IMAGE_TAG:-1.1.0}",
        "image: sageil/citeloom:${CITELOOM_IMAGE_TAG:-1.1.0}",
        "CITELOOM_RELEASE: ${CITELOOM_RELEASE:-1.1.0}",
        "CITELOOM_RELEASE: ${CITELOOM_RELEASE:-1.1.0}",
        "",
      ].join("\n"),
      path: "compose.dockerhub.yml",
    },
    {
      contents: [
        "CITELOOM_RELEASE: ${CITELOOM_RELEASE:-1.1.0}",
        "CITELOOM_RELEASE: ${CITELOOM_RELEASE:-1.1.0}",
        "",
      ].join("\n"),
      path: "compose.yml",
    },
    {
      contents: "CITELOOM_IMAGE_TAG=1.1.0\nCITELOOM_RELEASE=1.1.0\n",
      path: "docs/deployment.md",
    },
    {
      contents:
        '{\n  "name": "citeloom-docs",\n  "version": "1.1.0"\n}\n',
      path: "docsite/package.json",
    },
  ];
}
