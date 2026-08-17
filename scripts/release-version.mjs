import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const semanticVersionPattern = /^\d+\.\d+\.\d+$/u;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRoot = resolve(scriptDirectory, "..");

const derivedFileSpecifications = [
  {
    path: ".env.example",
    occurrences: [
      versionOccurrence("^(?<prefix>CITELOOM_RELEASE=)(?<version>\\d+\\.\\d+\\.\\d+)$", "gmu", 1),
      versionOccurrence("^(?<prefix>CITELOOM_IMAGE_TAG=)(?<version>\\d+\\.\\d+\\.\\d+)$", "gmu", 1),
    ],
  },
  {
    path: "compose.dockerhub.yml",
    occurrences: [
      versionOccurrence("(?<prefix>CITELOOM_IMAGE_TAG:-)(?<version>\\d+\\.\\d+\\.\\d+)", "gu", 5),
      versionOccurrence("(?<prefix>CITELOOM_RELEASE:-)(?<version>\\d+\\.\\d+\\.\\d+)", "gu", 2),
    ],
  },
  {
    path: "compose.yml",
    occurrences: [
      versionOccurrence("(?<prefix>CITELOOM_RELEASE:-)(?<version>\\d+\\.\\d+\\.\\d+)", "gu", 2),
    ],
  },
  {
    path: "docs/deployment.md",
    occurrences: [
      versionOccurrence("^(?<prefix>CITELOOM_IMAGE_TAG=)(?<version>\\d+\\.\\d+\\.\\d+)$", "gmu", 1),
      versionOccurrence("^(?<prefix>CITELOOM_RELEASE=)(?<version>\\d+\\.\\d+\\.\\d+)$", "gmu", 1),
    ],
  },
  {
    path: "docsite/package.json",
    occurrences: [
      versionOccurrence(
        '(?<prefix>"version": ")(?<version>\\d+\\.\\d+\\.\\d+)(?<suffix>")',
        "gu",
        1,
      ),
    ],
  },
];

const command = readReleaseVersionCommand(process.argv.slice(2));
if (command.kind === "set") {
  await setReleaseVersion(command.repositoryRoot, command.version);
  process.stdout.write(`Release version synchronized to ${command.version}.\n`);
} else {
  const version = await checkReleaseVersion(command.repositoryRoot);
  process.stdout.write(`Release version ${version} is synchronized.\n`);
}

function versionOccurrence(source, flags, expectedCount) {
  return { expectedCount, flags, source };
}

function readReleaseVersionCommand(arguments_) {
  let check = false;
  let repositoryRoot = defaultRepositoryRoot;
  let version = null;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--root") {
      const root = arguments_[index + 1];
      if (root === undefined || root.trim() === "") {
        throw new Error("--root requires a repository directory.");
      }
      repositoryRoot = resolve(root);
      index += 1;
      continue;
    }
    if (version !== null) {
      throw new Error(`Unexpected release-version argument: ${argument}`);
    }
    version = readSemanticVersion(argument);
  }

  if (check) {
    if (version !== null) {
      throw new Error("--check does not accept a version argument.");
    }
    return { kind: "check", repositoryRoot };
  }
  if (version === null) {
    throw new Error("Provide a semantic version such as 1.1.1, or use --check.");
  }
  return { kind: "set", repositoryRoot, version };
}

function readSemanticVersion(value) {
  const normalized = value.trim();
  if (!semanticVersionPattern.test(normalized)) {
    throw new Error(`Invalid release version: ${value}`);
  }
  return normalized;
}

async function setReleaseVersion(repositoryRoot, version) {
  const pendingWrites = [];
  const packagePath = resolve(repositoryRoot, "package.json");
  const packageContents = await readFile(packagePath, "utf8");
  readPackageVersion(packageContents, packagePath);
  const packageSpecification = versionOccurrence(
    '(?<prefix>"version": ")(?<version>\\d+\\.\\d+\\.\\d+)(?<suffix>")',
    "gu",
    1,
  );
  const updatedPackage = replaceOccurrenceVersions(
    packageContents,
    packageSpecification,
    packagePath,
    version,
  );
  pendingWrites.push({ contents: updatedPackage, path: packagePath });

  for (const fileSpecification of derivedFileSpecifications) {
    const path = resolve(repositoryRoot, fileSpecification.path);
    const contents = await readFile(path, "utf8");
    let updated = contents;
    for (const occurrence of fileSpecification.occurrences) {
      updated = replaceOccurrenceVersions(updated, occurrence, path, version);
    }
    pendingWrites.push({ contents: updated, path });
  }

  for (const pendingWrite of pendingWrites) {
    await writeFile(pendingWrite.path, pendingWrite.contents, "utf8");
  }
  await checkReleaseVersion(repositoryRoot);
}

async function checkReleaseVersion(repositoryRoot) {
  const packagePath = resolve(repositoryRoot, "package.json");
  const packageContents = await readFile(packagePath, "utf8");
  const version = readPackageVersion(packageContents, packagePath);

  for (const fileSpecification of derivedFileSpecifications) {
    const path = resolve(repositoryRoot, fileSpecification.path);
    const contents = await readFile(path, "utf8");
    for (const occurrence of fileSpecification.occurrences) {
      checkOccurrenceVersions(contents, occurrence, path, version);
    }
  }
  return version;
}

function readPackageVersion(contents, path) {
  let value;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`${path} is not valid JSON.`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  const version = value.version;
  if (typeof version !== "string") {
    throw new Error(`${path} must contain a string version.`);
  }
  return readSemanticVersion(version);
}

function checkOccurrenceVersions(contents, occurrence, path, expectedVersion) {
  const matches = readOccurrenceMatches(contents, occurrence, path);
  for (const match of matches) {
    if (match.version !== expectedVersion) {
      throw new Error(
        `${path} contains release version ${match.version}; expected ${expectedVersion}.`,
      );
    }
  }
}

function replaceOccurrenceVersions(contents, occurrence, path, version) {
  const matches = readOccurrenceMatches(contents, occurrence, path);
  let updated = contents;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    updated = `${updated.slice(0, match.start)}${version}${updated.slice(match.end)}`;
  }
  return updated;
}

function readOccurrenceMatches(contents, occurrence, path) {
  const expression = new RegExp(occurrence.source, occurrence.flags);
  const matches = [];
  for (const match of contents.matchAll(expression)) {
    const version = match.groups?.version;
    if (version === undefined || match.index === undefined) {
      throw new Error(`${path} has an invalid release-version pattern.`);
    }
    const versionOffset = match[0].indexOf(version);
    if (versionOffset < 0) {
      throw new Error(`${path} has an invalid release-version match.`);
    }
    const start = match.index + versionOffset;
    matches.push({ end: start + version.length, start, version });
  }
  if (matches.length !== occurrence.expectedCount) {
    throw new Error(
      `${path} contains ${matches.length} matching release-version values; expected ${occurrence.expectedCount}.`,
    );
  }
  return matches;
}
