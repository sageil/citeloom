import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverDocumentFiles } from "../src/documents/input.js";
import { calculateDocumentId, readDocumentSource } from "../src/docling/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("document input discovery", () => {
  it("discovers direct and recursive supported inputs without duplicates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "citeloom-input-"));
    temporaryDirectories.push(directory);
    const nestedDirectory = join(directory, "nested");
    const directPdf = join(directory, "report.PDF");
    const directHtml = join(directory, "report.HTML");
    const directDocx = join(directory, "report.DOCX");
    const nestedHtml = join(nestedDirectory, "appendix.htm");
    await mkdir(nestedDirectory);
    await writeFile(directPdf, "%PDF-direct");
    await writeFile(directHtml, "<html>direct</html>");
    await writeFile(directDocx, "docx fixture");
    await writeFile(nestedHtml, "<html>nested</html>");
    const directText = join(directory, "notes.txt");
    await writeFile(directText, "include me");
    const expectedDirect = await Promise.all([
      realpath(directPdf),
      realpath(directHtml),
      realpath(directDocx),
      realpath(directText),
    ]);
    const canonicalNestedHtml = await realpath(nestedHtml);

    await expect(discoverDocumentFiles([directory], false)).resolves.toEqual(
      expectedDirect.sort(),
    );
    await expect(
      discoverDocumentFiles([directory, directPdf], true),
    ).resolves.toEqual([...expectedDirect, canonicalNestedHtml].sort());
  });

  it("accepts an explicitly supplied plain-text file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "citeloom-input-"));
    temporaryDirectories.push(directory);
    const textPath = join(directory, "notes.txt");
    await writeFile(textPath, "supported plain text");

    await expect(discoverDocumentFiles([textPath], false)).resolves.toEqual([
      await realpath(textPath),
    ]);
  });

  it("reads format metadata and calculates a deterministic document hash", async () => {
    const directory = await mkdtemp(join(tmpdir(), "citeloom-input-"));
    temporaryDirectories.push(directory);
    const htmlPath = join(directory, "hash.html");
    await writeFile(htmlPath, "%PDF-known-content");

    await expect(calculateDocumentId(htmlPath)).resolves.toBe(
      "29c271ad2a4c64d15bb732e8a0e19e2fb41ab1328320996ace48e2d7861a0527",
    );
    await expect(readDocumentSource(htmlPath, 1_024)).resolves.toMatchObject({
      extension: ".html",
      mediaType: "text/html",
    });
  });
});
