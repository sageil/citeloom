import { z } from "zod";

import {
  ingestionPhaseSchema,
  ingestionControlStateSchema,
  ingestionStateSchema,
  type CatalogEntry,
  type IndexedDocument,
  type IngestionJob,
  type IngestionJobBase,
  type PendingIngestionJob,
  type PublishedDocument,
} from "./model.js";
import { contentIdSchema } from "../../domain/validation.js";
import { decodeDoclingAttemptConfigSnapshot } from "../../docling/protocol/run-metadata.js";
import { decodeDocumentFormat } from "../format.js";

const elementCountsSchema = z.object({
  images: z.number().int().nonnegative(),
  tables: z.number().int().nonnegative(),
  textChunks: z.number().int().nonnegative(),
  totalElements: z.number().int().nonnegative(),
});
const documentStatisticsSchema = elementCountsSchema.extend({
  pageCount: z.number().int().positive().nullable(),
});
const indexedDocumentRowSchema = documentStatisticsSchema.extend({
  documentId: contentIdSchema,
  elementSetId: contentIdSchema,
  generationId: z.uuid(),
  indexedAt: z.date(),
  sourceFile: z.string().min(1),
  tags: z.array(z.string().min(1)),
  versionId: z.uuid(),
});
const publishedDocumentRowSchema = z.object({
  document: indexedDocumentRowSchema,
  fileExtension: z.string(),
  mediaType: z.string(),
  versionDocumentId: contentIdSchema,
  versionSourceFile: z.string().min(1),
});
const indexedDocumentSpaceRowSchema = z.object({
  documentId: contentIdSchema,
  embeddingSpaceId: z.string().min(1),
  generationId: z.uuid(),
  indexedAt: z.date(),
  sourceFile: z.string().min(1),
});
const ingestionJobRowSchema = documentStatisticsSchema.extend({
  attemptCount: z.number().int().nonnegative(),
  controlError: z.string().nullable(),
  controlState: ingestionControlStateSchema,
  documentId: contentIdSchema,
  doclingAttemptConfig: z.unknown().nullable(),
  doclingRunId: z.uuid().nullable(),
  elementSetId: contentIdSchema.nullable(),
  embeddingSpaceId: z.string().min(1),
  errorMessage: z.string().nullable(),
  fileExtension: z.string(),
  generationId: z.uuid(),
  leaseExpiresAt: z.date().nullable(),
  maxAttempts: z.number().int().positive(),
  mediaType: z.string(),
  nextAttemptAt: z.date(),
  ownerId: z.uuid().nullable(),
  phase: ingestionPhaseSchema,
  sourceFile: z.string().min(1),
  state: ingestionStateSchema,
  tags: z.array(z.string().min(1)),
  updatedAt: z.date(),
  uploadedByUserId: z.uuid().nullable(),
});

export interface IndexedDocumentSpace {
  documentId: string;
  embeddingSpaceId: string;
  generationId: string;
  indexedAt: string;
  sourceFile: string;
}

export function decodeIndexedDocument(row: unknown): IndexedDocument {
  const result = indexedDocumentRowSchema.safeParse(row);
  if (!result.success) {
    throw new Error(`Invalid indexed document row: ${result.error.message}`);
  }
  return buildIndexedDocument(result.data);
}

function buildIndexedDocument(
  data: z.output<typeof indexedDocumentRowSchema>,
): IndexedDocument {
  return {
    documentId: data.documentId,
    elementSetId: data.elementSetId,
    generationId: data.generationId,
    images: data.images,
    indexedAt: data.indexedAt.toISOString(),
    pageCount: data.pageCount,
    sourceFile: data.sourceFile,
    tables: data.tables,
    tags: data.tags,
    textChunks: data.textChunks,
    totalElements: data.totalElements,
    versionId: data.versionId,
  };
}

export function decodePublishedDocument(row: unknown): PublishedDocument {
  const result = publishedDocumentRowSchema.safeParse(row);
  if (!result.success) {
    throw new Error(`Invalid published document row: ${result.error.message}`);
  }
  if (
    result.data.document.documentId !== result.data.versionDocumentId
    || result.data.document.sourceFile !== result.data.versionSourceFile
  ) {
    throw new Error(
      `Published document version does not match ${result.data.document.sourceFile}.`,
    );
  }
  const format = decodeDocumentFormat({
    extension: result.data.fileExtension,
    mediaType: result.data.mediaType,
  });
  return {
    ...buildIndexedDocument(result.data.document),
    format,
  };
}

export function decodeIndexedDocumentSpace(row: unknown): IndexedDocumentSpace {
  const result = indexedDocumentSpaceRowSchema.safeParse(row);
  if (!result.success) {
    throw new Error(`Invalid indexed document space row: ${result.error.message}`);
  }
  return {
    documentId: result.data.documentId,
    embeddingSpaceId: result.data.embeddingSpaceId,
    generationId: result.data.generationId,
    indexedAt: result.data.indexedAt.toISOString(),
    sourceFile: result.data.sourceFile,
  };
}

export function decodeIngestionJob(row: unknown): IngestionJob {
  const result = ingestionJobRowSchema.safeParse(row);
  if (!result.success) {
    throw new Error(`Invalid ingestion job row: ${result.error.message}`);
  }
  const data = result.data;
  const doclingAttemptConfig = data.doclingAttemptConfig === null
    ? null
    : decodeDoclingAttemptConfigSnapshot(data.doclingAttemptConfig);
  const format = decodeDocumentFormat({
    extension: data.fileExtension,
    mediaType: data.mediaType,
  });
  if (data.doclingRunId !== null && doclingAttemptConfig === null) {
    throw new Error(
      `Invalid ingestion job row: Docling metrics run has no attempt configuration for ${data.sourceFile}.`,
    );
  }
  const base: IngestionJobBase = {
    attemptCount: data.attemptCount,
    controlError: data.controlError,
    controlState: data.controlState,
    documentId: data.documentId,
    doclingAttemptConfig,
    doclingRunId: data.doclingRunId,
    elementSetId: data.elementSetId,
    embeddingSpaceId: data.embeddingSpaceId,
    errorMessage: data.errorMessage,
    format,
    generationId: data.generationId,
    images: data.images,
    maxAttempts: data.maxAttempts,
    nextAttemptAt: data.nextAttemptAt.toISOString(),
    pageCount: data.pageCount,
    phase: data.phase,
    sourceFile: data.sourceFile,
    tables: data.tables,
    tags: data.tags,
    textChunks: data.textChunks,
    totalElements: data.totalElements,
    updatedAt: data.updatedAt.toISOString(),
    uploadedByUserId: data.uploadedByUserId,
  };
  if (data.state === "running") {
    if (data.ownerId === null || data.leaseExpiresAt === null) {
      throw new Error(
        `Invalid ingestion job row: running job ${data.sourceFile} has no lease.`,
      );
    }
    return {
      ...base,
      leaseExpiresAt: data.leaseExpiresAt.toISOString(),
      ownerId: data.ownerId,
      state: "running",
    };
  }
  if (data.ownerId !== null || data.leaseExpiresAt !== null) {
    throw new Error(
      `Invalid ingestion job row: idle job ${data.sourceFile} has an active lease.`,
    );
  }
  if (data.state === "failed") {
    return {
      ...base,
      leaseExpiresAt: null,
      ownerId: null,
      state: "failed",
    };
  }
  return {
    ...base,
    leaseExpiresAt: null,
    ownerId: null,
    state: "pending",
  };
}

export function decodePendingIngestionJob(row: unknown): PendingIngestionJob {
  const job = decodeIngestionJob(row);
  if (job.state !== "pending") {
    throw new Error(`Invalid retried ingestion job state: ${job.state}`);
  }
  return job;
}

export function buildCatalogEntries(
  indexedDocuments: IndexedDocument[],
  jobs: IngestionJob[],
  spaces: IndexedDocumentSpace[],
): CatalogEntry[] {
  const indexedBySource = new Map<string, IndexedDocument>();
  const spaceIdsBySource = new Map<string, string[]>();
  const jobSources = new Set<string>();
  const entries: CatalogEntry[] = [];

  for (const document of indexedDocuments) {
    indexedBySource.set(document.sourceFile, document);
  }
  for (const space of spaces) {
    const activeDocument = indexedBySource.get(space.sourceFile);
    if (activeDocument?.documentId !== space.documentId) {
      continue;
    }
    const spaceIds = spaceIdsBySource.get(space.sourceFile) ?? [];
    spaceIds.push(space.embeddingSpaceId);
    spaceIdsBySource.set(space.sourceFile, spaceIds);
  }
  for (const job of jobs) {
    const activeDocument = indexedBySource.get(job.sourceFile) ?? null;
    jobSources.add(job.sourceFile);
    entries.push({
      activeDocumentId: activeDocument?.documentId ?? null,
      activeVersionId: activeDocument?.versionId ?? null,
      attemptCount: job.attemptCount,
      controlError: job.controlError,
      controlState: job.controlState,
      documentId: job.documentId,
      embeddingSpaceIds: spaceIdsBySource.get(job.sourceFile) ?? [],
      errorMessage: job.errorMessage,
      images: job.images,
      maxAttempts: job.maxAttempts,
      nextAttemptAt: job.nextAttemptAt,
      pageCount: job.pageCount,
      phase: job.phase,
      sourceFile: job.sourceFile,
      status: job.state,
      tables: job.tables,
      tags: job.tags,
      textChunks: job.textChunks,
      totalElements: job.totalElements,
      updatedAt: job.updatedAt,
      uploadedByUserId: job.uploadedByUserId,
    });
  }
  for (const document of indexedDocuments) {
    if (jobSources.has(document.sourceFile)) {
      continue;
    }
    entries.push({
      activeDocumentId: document.documentId,
      activeVersionId: document.versionId,
      attemptCount: null,
      controlError: null,
      controlState: "active",
      documentId: document.documentId,
      embeddingSpaceIds: spaceIdsBySource.get(document.sourceFile) ?? [],
      errorMessage: null,
      images: document.images,
      maxAttempts: null,
      nextAttemptAt: null,
      pageCount: document.pageCount,
      phase: null,
      sourceFile: document.sourceFile,
      status: "ready",
      tables: document.tables,
      tags: document.tags,
      textChunks: document.textChunks,
      totalElements: document.totalElements,
      updatedAt: document.indexedAt,
      uploadedByUserId: null,
    });
  }
  entries.sort((left, right) => left.sourceFile.localeCompare(right.sourceFile));
  return entries;
}

export function chooseCatalogTags(requested: string[], existing: string[]): string[] {
  const normalizedRequested = normalizeCatalogTags(requested);
  if (normalizedRequested.length > 0) {
    return normalizedRequested;
  }
  return normalizeCatalogTags(existing);
}

export function normalizeCatalogTags(tags: string[]): string[] {
  const normalized = new Set<string>();
  for (const tag of tags) {
    const value = tag.trim().toLowerCase();
    if (value !== "") {
      normalized.add(value);
    }
  }
  return [...normalized].sort();
}

export function uniqueCatalogStrings(values: string[]): string[] {
  return [...new Set(values)];
}
