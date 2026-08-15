import { z } from "zod";

import { contentIdSchema, tagSchema } from "./validation.js";

export type QueryScope =
  | { kind: "all" }
  | { documentIds: string[]; kind: "documentIds" }
  | { kind: "sourceFiles"; sourceFiles: string[] }
  | { kind: "tags"; tags: string[] };

export interface ResolvedQueryScopeTarget {
  documentId: string;
  generationId: string;
  sourceFile: string;
}

export interface ResolvedQueryScopeColumns {
  documentIds: string[];
  generationIds: string[];
  sourceFiles: string[];
}

export function createResolvedQueryScopeTargetKey(
  target: ResolvedQueryScopeTarget,
): string {
  return [
    target.documentId,
    target.generationId,
    target.sourceFile,
  ].join("\0");
}

export function listResolvedQueryDocumentIds(
  targets: readonly ResolvedQueryScopeTarget[],
): string[] {
  const documentIds = new Set<string>();
  for (const target of targets) {
    documentIds.add(target.documentId);
  }
  return [...documentIds];
}

export function splitResolvedQueryScopeTargets(
  targets: readonly ResolvedQueryScopeTarget[],
): ResolvedQueryScopeColumns {
  const documentIds: string[] = [];
  const generationIds: string[] = [];
  const sourceFiles: string[] = [];
  const targetKeys = new Set<string>();
  for (const target of targets) {
    const targetKey = createResolvedQueryScopeTargetKey(target);
    if (targetKeys.has(targetKey)) {
      continue;
    }
    targetKeys.add(targetKey);
    documentIds.push(target.documentId);
    generationIds.push(target.generationId);
    sourceFiles.push(target.sourceFile);
  }
  return { documentIds, generationIds, sourceFiles };
}

export const queryScopeSchema: z.ZodType<QueryScope> = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("all").describe(
        "Search every document authorized for the current user in the selected workspace.",
      ),
    }).strict().describe("Search all authorized workspace documents."),
    z.object({
      documentIds: z.array(contentIdSchema).min(1).describe(
        "Content-addressed document identifiers to search.",
      ),
      kind: z.literal("documentIds").describe(
        "Restrict the operation to explicit document identifiers.",
      ),
    }).strict().describe("Search only the listed document identifiers."),
    z.object({
      kind: z.literal("sourceFiles").describe(
        "Restrict the operation to explicit source-file names.",
      ),
      sourceFiles: z.array(z.string().trim().min(1)).min(1).describe(
        "Source-file names exactly as returned by CiteLoom discovery results.",
      ),
    }).strict().describe("Search only the listed source files."),
    z.object({
      kind: z.literal("tags").describe(
        "Restrict the operation to documents matching explicit tags.",
      ),
      tags: z.array(tagSchema).min(1).describe(
        "Workspace document tags to match.",
      ),
    }).strict().describe("Search only documents matching the listed tags."),
  ],
).describe("The authorized document set CiteLoom should search.");
