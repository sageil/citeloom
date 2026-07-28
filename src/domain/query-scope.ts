import { z } from "zod";

import { contentIdSchema, tagSchema } from "./validation.js";

export type QueryScope =
  | { kind: "all" }
  | { documentIds: string[]; kind: "documentIds" }
  | { kind: "sourceFiles"; sourceFiles: string[] }
  | { kind: "tags"; tags: string[] };

export interface ResolvedQueryScopeTarget {
  documentId: string;
  sourceFile: string;
}

export interface ResolvedQueryScopeColumns {
  documentIds: string[];
  sourceFiles: string[];
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
  const sourceFiles: string[] = [];
  const sourceFilesByDocument = new Map<string, Set<string>>();
  for (const target of targets) {
    let documentSourceFiles = sourceFilesByDocument.get(target.documentId);
    if (documentSourceFiles === undefined) {
      documentSourceFiles = new Set<string>();
      sourceFilesByDocument.set(target.documentId, documentSourceFiles);
    }
    if (documentSourceFiles.has(target.sourceFile)) {
      continue;
    }
    documentSourceFiles.add(target.sourceFile);
    documentIds.push(target.documentId);
    sourceFiles.push(target.sourceFile);
  }
  return { documentIds, sourceFiles };
}

export const queryScopeSchema: z.ZodType<QueryScope> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("all") }).strict(),
    z.object({
      documentIds: z.array(contentIdSchema).min(1),
      kind: z.literal("documentIds"),
    }).strict(),
    z.object({
      kind: z.literal("sourceFiles"),
      sourceFiles: z.array(z.string().trim().min(1)).min(1),
    }).strict(),
    z.object({
      kind: z.literal("tags"),
      tags: z.array(tagSchema).min(1),
    }).strict(),
  ],
);
