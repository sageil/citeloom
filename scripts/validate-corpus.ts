import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";

import {
  decodeCorpusDocumentBytes,
} from "../tools/evaluation/corpus/document-content.js";
import {
  corpusInventorySchema,
  readCorpusManifest,
  type CorpusDocument,
  type CorpusInventoryDocument,
} from "../tools/evaluation/corpus/manifest.js";
import {
  decodeProofCorpusManifest,
  readProofCorpus,
} from "../tools/evaluation/corpus/proof.js";

const manifestPath = "corpora/manifest.json";
const proofPath = "corpora/proof.json";
const corpusRoot = "documents/evaluation-corpora";
const inventoryPath = join(corpusRoot, "inventory.json");

const manifest = await readCorpusManifest(manifestPath);
const inventoryValue = await readJsonFile(inventoryPath);
const inventory = corpusInventorySchema.parse(inventoryValue);
const proofValue = await readJsonFile(proofPath);
const proofManifest = decodeProofCorpusManifest(proofValue, proofPath);
const proofCorpus = await readProofCorpus(proofPath, corpusRoot);

const manifestByDestination = new Map<string, CorpusDocument>();
for (const document of manifest.documents) {
  manifestByDestination.set(readDestination(document), document);
}

const inventoryByDestination = new Map<string, CorpusInventoryDocument>();
for (const document of inventory.documents) {
  const destination = readDestination(document);
  if (inventoryByDestination.has(destination)) {
    throw new Error(`Corpus inventory repeats ${destination}.`);
  }
  inventoryByDestination.set(destination, document);
}

for (const document of manifest.documents) {
  const destination = readDestination(document);
  const inventoryDocument = inventoryByDestination.get(destination);
  if (inventoryDocument === undefined) {
    throw new Error(`Corpus inventory is missing ${destination}.`);
  }
  requireMatchingMetadata(document, inventoryDocument, destination);
  const content = await readFile(join(corpusRoot, destination));
  await decodeCorpusDocumentBytes(document, content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  if (inventoryDocument.sha256 !== sha256) {
    throw new Error(`Corpus inventory hash does not match ${destination}.`);
  }
  if (inventoryDocument.bytes !== content.byteLength) {
    throw new Error(`Corpus inventory byte count does not match ${destination}.`);
  }
}

for (const destination of inventoryByDestination.keys()) {
  if (!manifestByDestination.has(destination)) {
    throw new Error(`Corpus inventory contains unmanifested file ${destination}.`);
  }
}

for (const selected of proofManifest.documents) {
  const destination = `${selected.domain}/${selected.fileName}`;
  const document = manifestByDestination.get(destination);
  if (document === undefined) {
    throw new Error(`Proof corpus selects unmanifested file ${destination}.`);
  }
  if (document.modality !== selected.modality) {
    throw new Error(
      `Proof corpus modality for ${destination} is ${selected.modality}, expected ${document.modality}.`,
    );
  }
}

if (proofCorpus.documents.length !== proofManifest.documents.length) {
  throw new Error("Proof corpus discovery did not return every selected document.");
}

process.stdout.write(
  `Corpus manifest, ${inventory.documents.length} files, inventory, and ${proofCorpus.documents.length} proof selections are valid.\n`,
);

async function readJsonFile(filePath: string): Promise<unknown> {
  const content = await readFile(filePath, "utf8");
  try {
    return JSON.parse(content) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${filePath}: ${message}`);
  }
}

function readDestination(
  document: Pick<CorpusDocument, "domain" | "fileName">,
): string {
  return `${document.domain}/${document.fileName}`;
}

function requireMatchingMetadata(
  manifestDocument: CorpusDocument,
  inventoryDocument: CorpusInventoryDocument,
  destination: string,
): void {
  const {
    bytes: _bytes,
    sha256: _sha256,
    ...inventoryMetadata
  } = inventoryDocument;
  if (!isDeepStrictEqual(manifestDocument, inventoryMetadata)) {
    throw new Error(`Corpus inventory metadata does not match ${destination}.`);
  }
}
