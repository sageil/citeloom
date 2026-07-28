import type { Stats } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  isSupportedDocumentPath,
  SUPPORTED_DOCUMENT_EXTENSIONS,
} from "./format.js";

export async function discoverDocumentFiles(
  inputPaths: string[],
  recursive: boolean,
): Promise<string[]> {
  if (inputPaths.length === 0) {
    throw new Error("At least one document file or directory is required.");
  }

  const discovered = new Set<string>();
  for (const inputPath of inputPaths) {
    const absolutePath = resolve(inputPath);
    const metadata = await readInputMetadata(absolutePath);
    if (metadata.isFile()) {
      if (!isSupportedDocumentPath(absolutePath)) {
        throw new Error(
          `Document filename extension is invalid for ${absolutePath}.`,
        );
      }
      discovered.add(await realpath(absolutePath));
      continue;
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Input is not a regular file or directory: ${absolutePath}`);
    }

    const directory = await realpath(absolutePath);
    await discoverDirectoryDocuments(directory, recursive, discovered);
  }

  const files = [...discovered].sort();
  if (files.length === 0) {
    throw new Error(
      `No document candidates were found. Known formats are ${SUPPORTED_DOCUMENT_EXTENSIONS.join(", ")}; other files must contain readable UTF-8 text.`,
    );
  }
  return files;
}

async function discoverDirectoryDocuments(
  directory: string,
  recursive: boolean,
  discovered: Set<string>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isFile() && isSupportedDocumentPath(entry.name)) {
      discovered.add(await realpath(entryPath));
      continue;
    }
    if (recursive && entry.isDirectory()) {
      await discoverDirectoryDocuments(entryPath, true, discovered);
    }
  }
}

async function readInputMetadata(path: string): Promise<Stats> {
  try {
    return await stat(path);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read input path ${path}: ${message}`);
  }
}
