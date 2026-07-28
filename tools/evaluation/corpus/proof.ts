import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { discoverDocumentFiles } from "../../../src/documents/input.js";
import { corpusDocumentFileNameSchema } from "../../../src/domain/validation.js";
import { evaluationSplitSchema } from "../dataset.js";
import { belongsToEvaluationSplit } from "../generator.js";

const proofDomainSchema = z.enum(["legal", "veterinary"]);
const proofDocumentSchema = z.object({
  domain: proofDomainSchema,
  fileName: corpusDocumentFileNameSchema,
  modality: z.enum(["document", "image"]),
  split: evaluationSplitSchema,
}).strict();
const proofCorpusManifestSchema = z.object({
  caseCountPerSplit: z.number().int().min(1).max(1_000),
  documents: z.array(proofDocumentSchema).min(1),
  seed: z.string().trim().min(1).max(120),
  version: z.literal(2),
}).strict().superRefine((manifest, context) => {
  const destinations = new Set<string>();
  const coveredSplits = new Set<string>();
  for (let index = 0; index < manifest.documents.length; index += 1) {
    const document = manifest.documents[index];
    if (document === undefined) {
      continue;
    }
    const destination = `${document.domain}/${document.fileName}`;
    if (destinations.has(destination)) {
      context.addIssue({
        code: "custom",
        message: `duplicates document ${destination}`,
        path: ["documents", index, "fileName"],
      });
    }
    destinations.add(destination);
    coveredSplits.add(`${document.domain}:${document.split}`);
  }
  for (const domain of proofDomainSchema.options) {
    for (const split of evaluationSplitSchema.options) {
      if (!coveredSplits.has(`${domain}:${split}`)) {
        context.addIssue({
          code: "custom",
          message: `must include at least one ${domain} ${split} document`,
          path: ["documents"],
        });
      }
    }
  }
});

export type ProofCorpusDomain = z.output<typeof proofDomainSchema>;
export type ProofCorpusSplit = z.output<typeof evaluationSplitSchema>;

export interface ProofCorpusDocument {
  documentId: string;
  domain: ProofCorpusDomain;
  fileName: string;
  modality: "document" | "image";
  sourceFile: string;
  split: ProofCorpusSplit;
}

export interface ProofCorpus {
  caseCountPerSplit: number;
  corpusRoot: string;
  documents: ProofCorpusDocument[];
  seed: string;
}

type ProofCorpusManifest = z.output<typeof proofCorpusManifestSchema>;

export function decodeProofCorpusManifest(
  value: unknown,
  sourceLabel: string,
): ProofCorpusManifest {
  const result = proofCorpusManifestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid proof corpus manifest ${sourceLabel}: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export async function readProofCorpus(
  manifestPath: string,
  corpusRootPath: string,
): Promise<ProofCorpus> {
  const manifest = await readProofCorpusManifest(manifestPath);
  const corpusRoot = await realpath(resolve(corpusRootPath));
  const documents: ProofCorpusDocument[] = [];
  for (const selected of manifest.documents) {
    const expectedPath = join(corpusRoot, selected.domain, selected.fileName);
    const discoveredFiles = await discoverDocumentFiles([expectedPath], false);
    const sourceFile = discoveredFiles[0];
    if (sourceFile === undefined) {
      throw new Error(`Proof corpus document is missing: ${expectedPath}`);
    }
    const content = await readFile(sourceFile);
    const documentId = createHash("sha256").update(content).digest("hex");
    if (!belongsToEvaluationSplit(documentId, selected.split, manifest.seed)) {
      throw new Error(
        `${selected.domain}/${selected.fileName} does not belong to the declared ${selected.split} split for seed ${manifest.seed}.`,
      );
    }
    documents.push({
      documentId,
      domain: selected.domain,
      fileName: selected.fileName,
      modality: selected.modality,
      sourceFile,
      split: selected.split,
    });
  }
  return {
    caseCountPerSplit: manifest.caseCountPerSplit,
    corpusRoot,
    documents,
    seed: manifest.seed,
  };
}

async function readProofCorpusManifest(
  manifestPath: string,
): Promise<ProofCorpusManifest> {
  const absolutePath = resolve(manifestPath);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot read proof corpus manifest ${absolutePath}: ${message}`,
    );
  }
  return decodeProofCorpusManifest(parsedJson, absolutePath);
}
