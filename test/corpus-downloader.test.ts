import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  decodeCorpusManifest,
  downloadCorpus,
} from "../tools/evaluation/corpus/downloader.js";
import { parseCorpusCommand } from "../tools/evaluation/corpus/download-cli.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("corpus manifest boundary", () => {
  it("rejects duplicate destinations", () => {
    const document = buildManifestDocument();
    expect(() => decodeCorpusManifest({
      documents: [document, { ...document, downloadUrl: "https://example.test/two.pdf" }],
      version: 2,
    }, "test manifest")).toThrow("duplicates destination");
  });

  it("rejects traversal in destination file names", () => {
    expect(() => decodeCorpusManifest({
      documents: [{ ...buildManifestDocument(), fileName: "../source.pdf" }],
      version: 2,
    }, "test manifest")).toThrow("Invalid corpus manifest");
  });
});

describe("corpus command boundary", () => {
  it("resolves default download paths", () => {
    expect(parseCorpusCommand(["download"], "/workspace")).toEqual({
      domain: null,
      manifestPath: "/workspace/corpora/manifest.json",
      outputDirectory: "/workspace/documents/evaluation-corpora",
      overwrite: false,
    });
  });

  it("rejects an unsupported domain", () => {
    expect(() => parseCorpusCommand([
      "download",
      "--domain",
      "finance",
    ])).toThrow("legal or veterinary");
  });
});

describe("downloadCorpus", () => {
  it("downloads, validates, inventories, and reuses a corpus document", async () => {
    const directory = await mkdtemp(join(tmpdir(), "citeloom-corpus-"));
    const manifestPath = join(directory, "manifest.json");
    const outputDirectory = join(directory, "documents");
    await writeManifest(manifestPath);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Buffer.from("%PDF-1.7\nfixture"), {
        headers: { "content-type": "application/pdf" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const first = await downloadCorpus(
        manifestPath,
        { domain: null, outputDirectory, overwrite: false },
        () => undefined,
      );
      const second = await downloadCorpus(
        manifestPath,
        { domain: null, outputDirectory, overwrite: false },
        () => undefined,
      );

      expect(first).toMatchObject({ downloaded: 1, skipped: 0 });
      expect(second).toMatchObject({ downloaded: 0, skipped: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const inventory = JSON.parse(await readFile(first.inventoryPath, "utf8"));
      expect(inventory.documents).toEqual([
        expect.objectContaining({
          bytes: 16,
          domain: "legal",
          fileName: "source.pdf",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects a response whose bytes do not match the extension", async () => {
    const directory = await mkdtemp(join(tmpdir(), "citeloom-corpus-"));
    const manifestPath = join(directory, "manifest.json");
    await writeManifest(manifestPath);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("not a PDF", { status: 200 }),
    ));

    try {
      await expect(downloadCorpus(
        manifestPath,
        { domain: null, outputDirectory: join(directory, "documents"), overwrite: false },
        () => undefined,
      )).rejects.toThrow("is not a PDF");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("decodes an authorized PMC BioC response into attributed HTML", async () => {
    const directory = await mkdtemp(join(tmpdir(), "citeloom-corpus-"));
    const manifestPath = join(directory, "manifest.json");
    const pmcDocument = buildPmcManifestDocument();
    const legalDocument = buildManifestDocument();
    await writeManifest(manifestPath, [legalDocument, pmcDocument]);
    const legalDirectory = join(directory, "documents", "legal");
    await mkdir(legalDirectory, { recursive: true });
    await writeFile(join(legalDirectory, legalDocument.fileName), "%PDF-1.7\nfixture");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json([{
        documents: [{
          id: "12345",
          infons: { license: "CC BY-NC" },
          passages: [
            { infons: { section_type: "TITLE" }, text: "Article title" },
            { infons: { section_type: "ABSTRACT" }, text: "Clinical content & details." },
          ],
        }],
      }]),
    ));

    try {
      const result = await downloadCorpus(
        manifestPath,
        {
          domain: "veterinary",
          outputDirectory: join(directory, "documents"),
          overwrite: false,
        },
        () => undefined,
      );
      const articlePath = join(
        directory,
        "documents",
        "veterinary",
        pmcDocument.fileName,
      );
      const article = await readFile(articlePath, "utf8");

      expect(result.documents).toHaveLength(1);
      expect(article).toContain("<h1>Test veterinary article</h1>");
      expect(article).toContain("<h2>abstract</h2>");
      expect(article).toContain("Clinical content &amp; details.");
      expect(article).toContain("PMC12345");
      const inventory = JSON.parse(await readFile(result.inventoryPath, "utf8"));
      expect(inventory.documents.map((document: { domain: string }) => document.domain)).toEqual([
        "legal",
        "veterinary",
      ]);

      await writeManifest(manifestPath, [
        legalDocument,
        { ...pmcDocument, license: "CC BY" },
      ]);
      await expect(downloadCorpus(
        manifestPath,
        {
          domain: "veterinary",
          outputDirectory: join(directory, "documents"),
          overwrite: false,
        },
        () => undefined,
      )).rejects.toThrow("metadata does not match the manifest");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("downloads and validates a curated image", async () => {
    const directory = await mkdtemp(join(tmpdir(), "citeloom-corpus-"));
    const manifestPath = join(directory, "manifest.json");
    const imageDocument = buildImageManifestDocument();
    await writeManifest(manifestPath, [imageDocument]);
    const onePixelPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(onePixelPng, { status: 200 }),
    ));

    try {
      const result = await downloadCorpus(
        manifestPath,
        { domain: null, outputDirectory: join(directory, "documents"), overwrite: false },
        () => undefined,
      );

      expect(result.documents).toEqual([expect.objectContaining({
        bytes: onePixelPng.byteLength,
        fileName: "source-image.png",
        modality: "image",
        provider: "curated-image",
      })]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function buildManifestDocument() {
  return {
    domain: "legal",
    downloadUrl: "https://example.test/source.pdf",
    fileName: "source.pdf",
    license: "Government of Canada federal-law reproduction",
    modality: "document",
    provider: "justice-laws",
    sourcePageUrl: "https://example.test/source",
    title: "Test source",
  };
}

function buildPmcManifestDocument() {
  return {
    domain: "veterinary",
    downloadUrl: "https://example.test/PMC12345.json",
    fileName: "test-veterinary-article.html",
    license: "CC BY-NC",
    modality: "document",
    pmcid: "PMC12345",
    provider: "pmc-open-access",
    sourcePageUrl: "https://example.test/PMC12345",
    title: "Test veterinary article",
  } as const;
}

function buildImageManifestDocument() {
  return {
    attribution: "Test image fixture",
    domain: "legal",
    downloadUrl: "https://example.test/source-image.png",
    fileName: "source-image.png",
    license: "CC0-1.0",
    modality: "image",
    provider: "curated-image",
    sourcePageUrl: "https://example.test/source-image",
    title: "Test source image",
  } as const;
}

async function writeManifest(
  filePath: string,
  documents: unknown[] = [buildManifestDocument()],
): Promise<void> {
  const manifest = {
    documents,
    version: 2,
  };
  await writeFile(filePath, JSON.stringify(manifest));
}
