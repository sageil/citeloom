import { z } from "zod";

import { queryScopeSchema } from "../../domain/query-scope.js";
import {
  contentIdSchema,
  sourceRegionSchema,
} from "../../domain/validation.js";

export const discoveryMatchKindSchema = z.enum(["keyword", "semantic"]);

export const sourceDiscoveryRequestSchema = z.object({
  includeRelated: z.boolean(),
  keywordPage: z.number().int().positive(),
  query: z.string().trim().min(1).max(500),
  scope: queryScopeSchema,
}).strict();

const sourceDiscoveryPassageSchema = z.object({
  excerpt: z.string().min(1),
  id: contentIdSchema,
  kind: z.enum(["image", "table", "text"]),
  matchKind: discoveryMatchKindSchema,
  pageNumbers: z.array(z.number().int().positive()),
  regions: z.array(sourceRegionSchema),
  sectionPath: z.array(z.string().min(1)),
}).strict();

const sourceDiscoveryDocumentSchema = z.object({
  documentId: contentIdSchema,
  matchingPassageCount: z.number().int().positive(),
  passages: z.array(sourceDiscoveryPassageSchema).min(1),
  sourceFile: z.string().min(1),
}).strict();

const exactDiscoveryPageSchema = z.object({
  documents: z.array(sourceDiscoveryDocumentSchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  totalDocuments: z.number().int().nonnegative(),
}).strict();

const exactDiscoveryResultSchema = exactDiscoveryPageSchema.extend({
  kind: z.literal("exact"),
}).strict();

const relatedDiscoveryResultSchema = z.object({
  documents: z.array(sourceDiscoveryDocumentSchema),
  limit: z.number().int().positive(),
  matchedPassageCount: z.number().int().nonnegative(),
  reviewedPassageCount: z.number().int().nonnegative(),
}).strict();

const exactAndRelatedDiscoveryResultSchema = z.object({
  exact: exactDiscoveryPageSchema,
  kind: z.literal("exact-and-related"),
  related: relatedDiscoveryResultSchema,
}).strict();

export const sourceDiscoveryResponseSchema = z.object({
  query: z.string().min(1),
  results: z.discriminatedUnion("kind", [
    exactDiscoveryResultSchema,
    exactAndRelatedDiscoveryResultSchema,
  ]),
}).strict();

export type DiscoveryMatchKind = z.output<typeof discoveryMatchKindSchema>;
export type SourceDiscoveryDocument = z.output<typeof sourceDiscoveryDocumentSchema>;
export type SourceDiscoveryPassage = z.output<typeof sourceDiscoveryPassageSchema>;
export type SourceDiscoveryRequest = z.output<typeof sourceDiscoveryRequestSchema>;
export type SourceDiscoveryResponse = z.output<typeof sourceDiscoveryResponseSchema>;

export function decodeSourceDiscoveryRequest(
  value: unknown,
): SourceDiscoveryRequest {
  const result = sourceDiscoveryRequestSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Source discovery request is invalid: ${result.error.message}`);
  }
  return result.data;
}
