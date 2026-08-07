import { z } from "zod";

import { indexingActivitySchema } from "./model.js";
import type { CatalogEntry, IngestionPhase } from "./index.js";
import type { SqlQueryExecutor } from "../../database/client.js";

const queryStatusSchema = z.enum([
  "failed",
  "pending",
  "ready",
  "reindex-required",
  "running",
]);
const displayStatusSchema = queryStatusSchema;
const embeddingProgressSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("not-started"),
  }),
  z.object({
    completedElements: z.number().int().nonnegative(),
    state: z.literal("in-progress"),
    totalElements: z.number().int().positive(),
  }),
  z.object({
    completedElements: z.number().int().nonnegative(),
    state: z.literal("complete"),
    totalElements: z.number().int().nonnegative(),
  }),
]).superRefine((progress, context) => {
  if (progress.state === "not-started") {
    return;
  }
  if (progress.completedElements > progress.totalElements) {
    context.addIssue({
      code: "custom",
      message: "completed embedding elements exceed the document total",
      path: ["completedElements"],
    });
  }
  if (
    progress.state === "in-progress"
    && progress.completedElements === progress.totalElements
  ) {
    context.addIssue({
      code: "custom",
      message: "in-progress embedding has no remaining elements",
      path: ["state"],
    });
  }
  if (
    progress.state === "complete"
    && progress.completedElements !== progress.totalElements
  ) {
    context.addIssue({
      code: "custom",
      message: "complete embedding does not cover every document element",
      path: ["completedElements"],
    });
  }
});
const mediaDescriptionProgressSchema = z.object({
  completedImages: z.number().int().nonnegative(),
  completedTables: z.number().int().nonnegative(),
});
const browserDocumentSchema = z.object({
  activeDocumentId: z.string().nullable(),
  activeVersionId: z.uuid().nullable(),
  attemptCount: z.number().int().nonnegative().nullable(),
  byteLength: z.number().int().nonnegative().nullable(),
  controlError: z.string().nullable(),
  controlState: z.enum([
    "active",
    "pause_requested",
    "paused",
    "cancel_requested",
    "cleanup_failed",
  ]),
  displayStatus: displayStatusSchema,
  documentId: z.string().min(1),
  embeddingSpaceIds: z.array(z.string()),
  embeddingProgress: embeddingProgressSchema,
  errorMessage: z.string().nullable(),
  images: z.number().int().nonnegative(),
  indexingActivity: indexingActivitySchema.nullable(),
  maxAttempts: z.number().int().positive().nullable(),
  mediaDescriptionProgress: mediaDescriptionProgressSchema,
  nextAttemptAt: z.string().min(1).nullable(),
  pageCount: z.number().int().positive().nullable(),
  phase: z.enum(["discovered", "normalized", "indexed"]).nullable(),
  queryStatus: queryStatusSchema,
  sourceFile: z.string().min(1),
  status: z.enum(["ready", "pending", "running", "failed"]),
  tables: z.number().int().nonnegative(),
  tags: z.array(z.string()),
  textChunks: z.number().int().nonnegative(),
  totalElements: z.number().int().nonnegative(),
  uploadedByUserId: z.uuid().nullable(),
  updatedAt: z.string().min(1),
}).superRefine((document, context) => {
  if (
    (document.phase === "normalized")
    !== (document.indexingActivity !== null)
  ) {
    context.addIssue({
      code: "custom",
      message: "indexing activity does not match the document phase",
      path: ["indexingActivity"],
    });
  }
  const progress = document.embeddingProgress;
  if (
    progress.state !== "not-started"
    && progress.totalElements !== document.totalElements
  ) {
    context.addIssue({
      code: "custom",
      message: "embedding progress total does not match the document total",
      path: ["embeddingProgress", "totalElements"],
    });
  }
  if (
    (document.status === "ready" || document.phase === "indexed")
    && progress.state !== "complete"
  ) {
    context.addIssue({
      code: "custom",
      message: "published or indexed documents require complete embedding progress",
      path: ["embeddingProgress", "state"],
    });
  }
  if (
    document.phase === "discovered"
    && progress.state !== "not-started"
  ) {
    context.addIssue({
      code: "custom",
      message: "discovered documents cannot have embedding progress",
      path: ["embeddingProgress", "state"],
    });
  }
  const descriptions = document.mediaDescriptionProgress;
  if (descriptions.completedImages > document.images) {
    context.addIssue({
      code: "custom",
      message: "completed image descriptions exceed the document image total",
      path: ["mediaDescriptionProgress", "completedImages"],
    });
  }
  if (descriptions.completedTables > document.tables) {
    context.addIssue({
      code: "custom",
      message: "completed table descriptions exceed the document table total",
      path: ["mediaDescriptionProgress", "completedTables"],
    });
  }
  if (
    document.phase === "discovered"
    && (
      descriptions.completedImages !== 0
      || descriptions.completedTables !== 0
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "discovered documents cannot have completed media descriptions",
      path: ["mediaDescriptionProgress"],
    });
  }
  if (
    (document.status === "ready" || document.phase === "indexed")
    && (
      descriptions.completedImages !== document.images
      || descriptions.completedTables !== document.tables
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "published or indexed documents require complete media processing",
      path: ["mediaDescriptionProgress"],
    });
  }
});
const tagFacetSchema = z.object({
  count: z.number().int().nonnegative(),
  tag: z.string().min(1),
});
const catalogFacetsSchema = z.object({
  failed: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  processing: z.number().int().nonnegative(),
  queryable: z.number().int().nonnegative(),
  queryableTags: z.array(tagFacetSchema),
  ready: z.number().int().nonnegative(),
  reindexRequired: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  tags: z.array(tagFacetSchema),
  total: z.number().int().nonnegative(),
  untagged: z.number().int().nonnegative(),
  uploads: z.number().int().nonnegative(),
});
const browserResultSchema = z.object({
  attention: z.object({
    documents: z.array(browserDocumentSchema),
    total: z.number().int().nonnegative(),
  }),
  documents: z.array(browserDocumentSchema),
  facets: catalogFacetsSchema,
  page: z.number().int().positive(),
  pageSize: z.union([z.literal(25), z.literal(50), z.literal(100)]),
  total: z.number().int().nonnegative(),
});
const browserRowSchema = z.object({ result: browserResultSchema });

export type DocumentQueryStatus = z.output<typeof queryStatusSchema>;
export type DocumentDisplayStatus = z.output<typeof displayStatusSchema>;
export type DocumentEmbeddingProgress = z.output<typeof embeddingProgressSchema>;
export type DocumentMediaDescriptionProgress = z.output<
  typeof mediaDescriptionProgressSchema
>;

export interface BrowserDocument extends CatalogEntry {
  byteLength: number | null;
  displayStatus: DocumentDisplayStatus;
  embeddingProgress: DocumentEmbeddingProgress;
  mediaDescriptionProgress: DocumentMediaDescriptionProgress;
  phase: IngestionPhase | null;
  queryStatus: DocumentQueryStatus;
}

export interface DocumentTagFacet {
  count: number;
  tag: string;
}

export interface DocumentCatalogFacets {
  failed: number;
  pending: number;
  processing: number;
  queryable: number;
  queryableTags: DocumentTagFacet[];
  ready: number;
  reindexRequired: number;
  running: number;
  tags: DocumentTagFacet[];
  total: number;
  untagged: number;
  uploads: number;
}

export type DocumentCollection =
  | { kind: "all" }
  | { kind: "tag"; tag: string }
  | { kind: "tags"; tags: string[] }
  | { kind: "untagged" }
  | { kind: "uploads" };

export type DocumentStatusFilter =
  | "all"
  | "failed"
  | "processing"
  | "queryable"
  | "ready"
  | "reindex-required";

export type DocumentSort =
  | "name-asc"
  | "name-desc"
  | "updated-asc"
  | "updated-desc";

export interface BrowseDocumentCatalogRequest {
  collection: DocumentCollection;
  page: number;
  pageSize: 25 | 50 | 100;
  search: string;
  sort: DocumentSort;
  status: DocumentStatusFilter;
  tag: string | null;
}

export interface BrowseDocumentCatalogResult {
  attention: {
    documents: BrowserDocument[];
    total: number;
  };
  documents: BrowserDocument[];
  facets: DocumentCatalogFacets;
  page: number;
  pageSize: 25 | 50 | 100;
  total: number;
}

export const DEFAULT_DOCUMENT_CATALOG_REQUEST: BrowseDocumentCatalogRequest = {
  collection: { kind: "all" },
  page: 1,
  pageSize: 25,
  search: "",
  sort: "updated-desc",
  status: "all",
  tag: null,
};

export async function browseDocumentCatalog(
  query: SqlQueryExecutor,
  embeddingSpaceId: string,
  request: BrowseDocumentCatalogRequest,
): Promise<BrowseDocumentCatalogResult> {
  const offset = (request.page - 1) * request.pageSize;
  const rows = await query.execute("browse-document-catalog", [
    embeddingSpaceId,
    request.search,
    request.status,
    request.tag ?? "",
    encodeCollection(request.collection),
    request.sort,
    request.pageSize,
    offset,
  ]);
  const row = rows[0];
  const result = browserRowSchema.safeParse(row);
  if (!result.success) {
    throw new Error(`Invalid document catalog browser row: ${result.error.message}`);
  }
  return result.data.result;
}

function encodeCollection(collection: DocumentCollection): string {
  if (collection.kind === "tag") {
    return `tag:${collection.tag}`;
  }
  if (collection.kind === "tags") {
    return `tags:${collection.tags.join(",")}`;
  }
  return collection.kind;
}
