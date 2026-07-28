import { readFile } from "node:fs/promises";

import { z } from "zod";

import {
  contentIdSchema,
  corpusDocumentFileNameSchema,
} from "../../../src/domain/validation.js";

const httpsUrlSchema = z.url().refine(
  (value) => new URL(value).protocol === "https:",
  "must use https",
);
const corpusDomainSchema = z.enum(["legal", "veterinary"]);
const corpusDocumentBaseSchema = z.object({
  domain: corpusDomainSchema,
  downloadUrl: httpsUrlSchema,
  fileName: corpusDocumentFileNameSchema,
  modality: z.enum(["document", "image"]),
  sourcePageUrl: httpsUrlSchema,
  title: z.string().trim().min(1).max(500),
});
const justiceCorpusDocumentSchema = corpusDocumentBaseSchema.extend({
  license: z.literal("Government of Canada federal-law reproduction"),
  modality: z.literal("document"),
  provider: z.literal("justice-laws"),
}).strict();
const pmcCorpusDocumentSchema = corpusDocumentBaseSchema.extend({
  license: z.enum(["CC BY", "CC BY-NC"]),
  modality: z.literal("document"),
  pmcid: z.string().regex(/^PMC[0-9]+$/),
  provider: z.literal("pmc-open-access"),
}).strict();
const curatedImageCorpusDocumentSchema = corpusDocumentBaseSchema.extend({
  attribution: z.string().trim().min(1).max(1_000),
  license: z.enum(["CC0-1.0", "CC-BY-4.0", "Public Domain"]),
  modality: z.literal("image"),
  provider: z.literal("curated-image"),
}).strict();
const corpusDocumentSchema = z.discriminatedUnion("provider", [
  curatedImageCorpusDocumentSchema,
  justiceCorpusDocumentSchema,
  pmcCorpusDocumentSchema,
]);
const corpusManifestSchema = z.object({
  documents: z.array(corpusDocumentSchema).min(1),
  version: z.literal(2),
}).strict().superRefine((manifest, context) => {
  const destinations = new Set<string>();
  const downloadUrls = new Set<string>();
  for (let index = 0; index < manifest.documents.length; index += 1) {
    const document = manifest.documents[index];
    if (document === undefined) {
      continue;
    }
    const destination = `${document.domain}/${document.fileName}`;
    if (destinations.has(destination)) {
      context.addIssue({
        code: "custom",
        message: `duplicates destination ${destination}`,
        path: ["documents", index, "fileName"],
      });
    }
    destinations.add(destination);
    if (downloadUrls.has(document.downloadUrl)) {
      context.addIssue({
        code: "custom",
        message: `duplicates download URL ${document.downloadUrl}`,
        path: ["documents", index, "downloadUrl"],
      });
    }
    downloadUrls.add(document.downloadUrl);
    if (
      document.provider === "justice-laws" &&
      !document.fileName.endsWith(".pdf")
    ) {
      context.addIssue({
        code: "custom",
        message: "Justice Laws documents must use PDF destinations",
        path: ["documents", index, "fileName"],
      });
    }
    if (
      document.provider === "pmc-open-access" &&
      !document.fileName.endsWith(".html")
    ) {
      context.addIssue({
        code: "custom",
        message: "PMC BioC documents must use HTML destinations",
        path: ["documents", index, "fileName"],
      });
    }
    if (
      document.provider === "curated-image" &&
      !/\.(?:jpe?g|png|webp)$/.test(document.fileName)
    ) {
      context.addIssue({
        code: "custom",
        message: "Curated image documents must use JPEG, PNG, or WebP destinations",
        path: ["documents", index, "fileName"],
      });
    }
  }
});
const corpusInventoryFields = {
  bytes: z.number().int().positive(),
  sha256: contentIdSchema,
};
const corpusInventoryDocumentSchema = z.discriminatedUnion("provider", [
  curatedImageCorpusDocumentSchema.extend(corpusInventoryFields),
  justiceCorpusDocumentSchema.extend(corpusInventoryFields),
  pmcCorpusDocumentSchema.extend(corpusInventoryFields),
]);

export const corpusInventorySchema = z.object({
  documents: z.array(corpusInventoryDocumentSchema),
  generatedAt: z.iso.datetime(),
  manifestVersion: z.literal(2),
}).strict();

export type CorpusDomain = z.output<typeof corpusDomainSchema>;
export type CorpusDocument = z.output<typeof corpusDocumentSchema>;
export type CorpusManifest = z.output<typeof corpusManifestSchema>;
export type CorpusInventoryDocument = z.output<
  typeof corpusInventoryDocumentSchema
>;

export function decodeCorpusManifest(
  value: unknown,
  sourceLabel: string,
): CorpusManifest {
  const result = corpusManifestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid corpus manifest ${sourceLabel}: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export async function readCorpusManifest(
  manifestPath: string,
): Promise<CorpusManifest> {
  const content = await readFile(manifestPath, "utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid corpus JSON in ${manifestPath}: ${message}`);
  }
  return decodeCorpusManifest(parsedJson, manifestPath);
}
