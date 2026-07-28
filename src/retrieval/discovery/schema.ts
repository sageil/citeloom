import { z } from "zod";

import { queryScopeSchema } from "../../domain/query-scope.js";
import {
  contentIdSchema,
  sourceRegionSchema,
} from "../../domain/validation.js";

export const discoveryMatchKindSchema = z.enum(["keyword", "semantic"]);
export const discoverySearchStatusSchema = z.enum([
  "complete",
  "degraded",
  "disabled",
  "unavailable",
]);

export const sourceDiscoveryRequestSchema = z.object({
  includeRelated: z.boolean(),
  keywordPage: z.number().int().positive(),
  keywordPageSize: z.number().int().min(1).max(50),
  query: z.string().trim().min(1).max(500),
  relatedLimit: z.number().int().min(1).max(50),
  scope: queryScopeSchema,
}).strict();

const sourceDiscoveryPassageSchema = z.object({
  excerpt: z.string().min(1),
  id: contentIdSchema,
  kind: z.enum(["image", "table", "text"]),
  matchKinds: z.array(discoveryMatchKindSchema).min(1),
  pageNumbers: z.array(z.number().int().positive()),
  regions: z.array(sourceRegionSchema),
  sectionPath: z.array(z.string().min(1)),
}).strict();

const sourceDiscoveryDocumentSchema = z.object({
  documentId: contentIdSchema,
  matchKinds: z.array(discoveryMatchKindSchema).min(1),
  matchingPassageCount: z.number().int().positive(),
  passages: z.array(sourceDiscoveryPassageSchema).min(1),
  sourceFile: z.string().min(1),
}).strict();

const sourceDiscoverySectionShape = {
  documents: z.array(sourceDiscoveryDocumentSchema),
  status: discoverySearchStatusSchema,
  warning: z.string().min(1).nullable(),
};

const keywordDiscoverySectionSchema = z.object({
  ...sourceDiscoverySectionShape,
  page: z.number().int().positive(),
  pageSize: z.number().int().min(1).max(50),
  totalDocuments: z.number().int().nonnegative(),
}).strict();

const relatedDiscoverySectionSchema = z.object({
  ...sourceDiscoverySectionShape,
  limit: z.number().int().min(1).max(50),
}).strict();

export const sourceDiscoveryResponseSchema = z.object({
  keyword: keywordDiscoverySectionSchema,
  query: z.string().min(1),
  related: relatedDiscoverySectionSchema,
}).strict();

export type DiscoveryMatchKind = z.output<typeof discoveryMatchKindSchema>;
export type DiscoverySearchStatus = z.output<typeof discoverySearchStatusSchema>;
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
