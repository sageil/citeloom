import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import {
  buildCorpusInventoryDocument,
  decodeCorpusDocumentBytes,
  downloadCorpusDocument,
} from "./document-content.js";
import {
  readExistingCorpusDocument,
  writeCorpusFileAtomically,
} from "./file-store.js";
import {
  corpusInventorySchema,
  readCorpusManifest,
} from "./manifest.js";
import type {
  CorpusDocument,
  CorpusDomain,
  CorpusInventoryDocument,
  CorpusManifest,
} from "./manifest.js";

export {
  decodeCorpusManifest,
  readCorpusManifest,
} from "./manifest.js";
export type {
  CorpusDocument,
  CorpusDomain,
  CorpusInventoryDocument,
  CorpusManifest,
} from "./manifest.js";

const PMC_REQUEST_INTERVAL_MS = 350;

export interface CorpusDownloadOptions {
  domain: CorpusDomain | null;
  outputDirectory: string;
  overwrite: boolean;
}

export interface CorpusDownloadResult {
  downloaded: number;
  documents: CorpusInventoryDocument[];
  inventoryPath: string;
  skipped: number;
}

export async function downloadCorpus(
  manifestPath: string,
  options: CorpusDownloadOptions,
  reportProgress: (message: string) => void,
): Promise<CorpusDownloadResult> {
  const manifest = await readCorpusManifest(manifestPath);
  const selectedDocuments = selectCorpusDocuments(manifest, options.domain);
  if (selectedDocuments.length === 0) {
    throw new Error(`The corpus manifest contains no ${options.domain} documents.`);
  }

  await mkdir(options.outputDirectory, { recursive: true });
  const selectedInventoryDocuments: CorpusInventoryDocument[] = [];
  let downloaded = 0;
  let skipped = 0;
  for (let index = 0; index < selectedDocuments.length; index += 1) {
    const document = selectedDocuments[index];
    if (document === undefined) {
      throw new Error(`Corpus document ${index + 1} is missing.`);
    }
    const targetPath = join(
      options.outputDirectory,
      document.domain,
      document.fileName,
    );
    const existingBytes = options.overwrite
      ? null
      : await readExistingCorpusDocument(targetPath);
    let content: Buffer;
    if (existingBytes === null) {
      reportProgress(
        `Downloading ${index + 1}/${selectedDocuments.length}: ${document.title}`,
      );
      const downloadedContent = await downloadCorpusDocument(document);
      content = await decodeCorpusDocumentBytes(document, downloadedContent);
      await writeCorpusFileAtomically(targetPath, content);
      downloaded += 1;
      if (document.provider === "pmc-open-access") {
        await wait(PMC_REQUEST_INTERVAL_MS);
      }
    } else {
      reportProgress(
        `Keeping ${index + 1}/${selectedDocuments.length}: ${document.title}`,
      );
      content = await decodeCorpusDocumentBytes(document, existingBytes);
      skipped += 1;
    }
    selectedInventoryDocuments.push(
      buildCorpusInventoryDocument(document, content),
    );
  }

  const inventoryDocuments = await readCachedInventoryDocuments(
    manifest,
    selectedDocuments,
    selectedInventoryDocuments,
    options.outputDirectory,
  );
  inventoryDocuments.sort(compareInventoryDocuments);
  const inventory = corpusInventorySchema.parse({
    documents: inventoryDocuments,
    generatedAt: new Date().toISOString(),
    manifestVersion: manifest.version,
  });
  const inventoryPath = join(options.outputDirectory, "inventory.json");
  const inventoryBytes = Buffer.from(
    `${JSON.stringify(inventory, null, 2)}\n`,
    "utf8",
  );
  await writeCorpusFileAtomically(inventoryPath, inventoryBytes);
  return {
    downloaded,
    documents: selectedInventoryDocuments,
    inventoryPath,
    skipped,
  };
}

async function readCachedInventoryDocuments(
  manifest: CorpusManifest,
  selectedDocuments: CorpusDocument[],
  selectedInventoryDocuments: CorpusInventoryDocument[],
  outputDirectory: string,
): Promise<CorpusInventoryDocument[]> {
  const inventoryDocuments = [...selectedInventoryDocuments];
  const selectedDestinations = new Set<string>();
  for (const document of selectedDocuments) {
    selectedDestinations.add(readCorpusDestination(document));
  }

  for (const document of manifest.documents) {
    if (selectedDestinations.has(readCorpusDestination(document))) {
      continue;
    }
    const targetPath = join(outputDirectory, document.domain, document.fileName);
    const existingBytes = await readExistingCorpusDocument(targetPath);
    if (existingBytes === null) {
      continue;
    }
    const content = await decodeCorpusDocumentBytes(document, existingBytes);
    inventoryDocuments.push(buildCorpusInventoryDocument(document, content));
  }
  return inventoryDocuments;
}

function readCorpusDestination(document: CorpusDocument): string {
  return `${document.domain}/${document.fileName}`;
}

function selectCorpusDocuments(
  manifest: CorpusManifest,
  domain: CorpusDomain | null,
): CorpusDocument[] {
  const selected: CorpusDocument[] = [];
  for (const document of manifest.documents) {
    if (domain === null || document.domain === domain) {
      selected.push(document);
    }
  }
  selected.sort((left, right) => {
    const domainOrder = left.domain.localeCompare(right.domain);
    if (domainOrder !== 0) {
      return domainOrder;
    }
    return left.fileName.localeCompare(right.fileName);
  });
  return selected;
}

function compareInventoryDocuments(
  left: CorpusInventoryDocument,
  right: CorpusInventoryDocument,
): number {
  const domainOrder = left.domain.localeCompare(right.domain);
  if (domainOrder !== 0) {
    return domainOrder;
  }
  return left.fileName.localeCompare(right.fileName);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
