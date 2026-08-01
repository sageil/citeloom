import { z } from "zod";

import { contentIdSchema } from "./validation.js";

export const DOCUMENT_TOC_MAXIMUM_ENTRIES = 512;

export const documentTocEntrySchema = z.object({
  id: contentIdSchema,
  level: z.number().int().min(1).max(32),
  retrievalWindowIds: z.array(contentIdSchema).min(1),
  title: z.string().trim().min(1).max(500),
}).strict();

export const documentTocArtifactSchema = z.object({
  entries: z.array(documentTocEntrySchema).max(DOCUMENT_TOC_MAXIMUM_ENTRIES),
  mode: z.enum(["disabled", "generated"]),
  version: z.literal(1),
}).strict().superRefine((artifact, context) => {
  if (artifact.mode === "disabled" && artifact.entries.length > 0) {
    context.addIssue({
      code: "custom",
      message: "A disabled document TOC cannot contain entries.",
      path: ["entries"],
    });
  }
  const entryIds = new Set<string>();
  for (let index = 0; index < artifact.entries.length; index += 1) {
    const entry = artifact.entries[index];
    if (entry === undefined) {
      continue;
    }
    if (entryIds.has(entry.id)) {
      context.addIssue({
        code: "custom",
        message: `Document TOC entry ${entry.id} is duplicated.`,
        path: ["entries", index, "id"],
      });
    }
    entryIds.add(entry.id);
    const retrievalIds = new Set(entry.retrievalWindowIds);
    if (retrievalIds.size !== entry.retrievalWindowIds.length) {
      context.addIssue({
        code: "custom",
        message: `Document TOC entry ${entry.id} contains duplicate retrieval windows.`,
        path: ["entries", index, "retrievalWindowIds"],
      });
    }
  }
});

export type DocumentTocArtifact = z.output<typeof documentTocArtifactSchema>;
export type DocumentTocEntry = z.output<typeof documentTocEntrySchema>;

export function decodeDocumentTocArtifact(value: unknown): DocumentTocArtifact {
  const result = documentTocArtifactSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid document TOC artifact: ${result.error.message}`);
  }
  return result.data;
}
