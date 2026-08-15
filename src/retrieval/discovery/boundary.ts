import { z } from "zod";

import { queryScopeSchema } from "../../domain/query-scope.js";
import {
  contentIdSchema,
  sourceRegionSchema,
} from "../../domain/validation.js";

export const discoveryMatchKindSchema = z.enum(["keyword", "semantic"]);

export const sourceDiscoveryRequestSchema = z.object({
  includeRelated: z.boolean().describe(
    "When true, also run semantic retrieval for passages related to the query.",
  ),
  keywordPage: z.number().int().positive().describe(
    "One-based page of exact keyword-matching documents to return.",
  ),
  query: z.string().trim().min(1).max(500).describe(
    "Natural-language or keyword query to find in the selected documents.",
  ),
  scope: queryScopeSchema,
}).strict().describe(
  "A source search within one authorized CiteLoom document set.",
);

const sourceDiscoveryPassageSchema = z.object({
  excerpt: z.string().min(1).describe("Source text relevant to the query."),
  id: contentIdSchema.describe("Stable content identifier for this passage."),
  kind: z.enum(["image", "table", "text"]).describe(
    "The source element type represented by this passage.",
  ),
  matchKind: discoveryMatchKindSchema.describe(
    "Whether exact keyword or semantic retrieval selected this passage.",
  ),
  pageNumbers: z.array(z.number().int().positive()).describe(
    "One-based source page numbers containing the passage.",
  ),
  regions: z.array(sourceRegionSchema).describe(
    "Source-page regions containing the evidence when location data is available.",
  ),
  sectionPath: z.array(z.string().min(1)).describe(
    "Ordered source headings that contain the passage.",
  ),
}).strict().describe("A matching source passage and its evidence metadata.");

const sourceDiscoveryDocumentSchema = z.object({
  documentId: contentIdSchema.describe(
    "Stable content identifier for the matching document.",
  ),
  matchingPassageCount: z.number().int().positive().describe(
    "Total passages in this document that matched the retrieval stage.",
  ),
  passages: z.array(sourceDiscoveryPassageSchema).min(1).describe(
    "Matching passages returned for this result page.",
  ),
  sourceFile: z.string().min(1).describe(
    "Workspace source-file name for the document.",
  ),
}).strict().describe("A matching document and its returned passages.");

const exactDiscoveryPageSchema = z.object({
  documents: z.array(sourceDiscoveryDocumentSchema).describe(
    "Exact keyword-matching documents on this result page.",
  ),
  page: z.number().int().positive().describe("One-based result page."),
  pageSize: z.number().int().positive().describe(
    "Maximum exact-match documents returned per page.",
  ),
  totalDocuments: z.number().int().nonnegative().describe(
    "Total documents with an exact keyword match.",
  ),
}).strict().describe("A page of exact keyword matches.");

const exactDiscoveryResultSchema = exactDiscoveryPageSchema.extend({
  kind: z.literal("exact"),
}).strict();

const relatedDiscoveryResultSchema = z.object({
  documents: z.array(sourceDiscoveryDocumentSchema).describe(
    "Documents containing related semantic passages.",
  ),
  limit: z.number().int().positive().describe(
    "Maximum semantic passages selected for the response.",
  ),
  matchedPassageCount: z.number().int().nonnegative().describe(
    "Semantic passages that met the relevance threshold.",
  ),
  reviewedPassageCount: z.number().int().nonnegative().describe(
    "Candidate passages evaluated by semantic retrieval.",
  ),
}).strict().describe("Semantic passages related to the query.");

const exactAndRelatedDiscoveryResultSchema = z.object({
  exact: exactDiscoveryPageSchema,
  kind: z.literal("exact-and-related"),
  related: relatedDiscoveryResultSchema,
}).strict();

export const sourceDiscoveryResponseSchema = z.object({
  query: z.string().min(1).describe("The normalized query that was executed."),
  results: z.discriminatedUnion("kind", [
    exactDiscoveryResultSchema,
    exactAndRelatedDiscoveryResultSchema,
  ]).describe("Exact results and optional related semantic results."),
}).strict().describe(
  "Documents and evidence passages retrieved from one authorized document set.",
);

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
