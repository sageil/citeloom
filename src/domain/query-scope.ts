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
