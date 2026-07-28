import { and, asc, count, eq } from "drizzle-orm";

import { resolveDocumentQueryScope } from "./query-scope.js";
import {
  buildCatalogEntries,
  decodeIndexedDocument,
  decodeIndexedDocumentSpace,
  decodeIngestionJob,
  decodePublishedDocument,
} from "./records.js";
import type {
  CatalogEntry,
  IndexedDocument,
  PublishedDocument,
} from "./model.js";
import type { CiteLoomDatabase } from "../../database/client.js";
import {
  indexedDocuments,
  documentVersions,
  indexedDocumentSpaces,
  ingestionJobs,
} from "../../database/schema.js";
import type {
  QueryScope,
  ResolvedQueryScopeTarget,
} from "../../domain/query-scope.js";
import { contentIdSchema } from "../../domain/validation.js";

export class CatalogDocumentStore {
  public constructor(private readonly database: CiteLoomDatabase) {}

  public async countDocumentReferences(documentId: string): Promise<number> {
    const indexedRows = await this.database
      .select({ value: count() })
      .from(indexedDocuments)
      .where(eq(indexedDocuments.documentId, documentId));
    const jobRows = await this.database
      .select({ value: count() })
      .from(ingestionJobs)
      .where(eq(ingestionJobs.documentId, documentId));
    const versionRows = await this.database
      .select({ value: count() })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, documentId));
    return readCount(indexedRows) + readCount(jobRows) + readCount(versionRows);
  }

  public async listEntries(): Promise<CatalogEntry[]> {
    const [indexedRows, jobRows, spaceRows] = await Promise.all([
      this.database
        .select()
        .from(indexedDocuments)
        .orderBy(asc(indexedDocuments.sourceFile)),
      this.database
        .select()
        .from(ingestionJobs)
        .orderBy(asc(ingestionJobs.sourceFile)),
      this.database
        .select()
        .from(indexedDocumentSpaces)
        .orderBy(
          asc(indexedDocumentSpaces.sourceFile),
          asc(indexedDocumentSpaces.embeddingSpaceId),
        ),
    ]);
    const indexed = indexedRows.map(decodeIndexedDocument);
    const jobs = jobRows.map(decodeIngestionJob);
    const spaces = spaceRows.map(decodeIndexedDocumentSpace);
    return buildCatalogEntries(indexed, jobs, spaces);
  }

  public async listAvailableDocuments(
    embeddingSpaceId: string,
  ): Promise<IndexedDocument[]> {
    const rows = await this.database
      .select({ document: indexedDocuments })
      .from(indexedDocuments)
      .innerJoin(
        indexedDocumentSpaces,
        and(
          eq(indexedDocumentSpaces.sourceFile, indexedDocuments.sourceFile),
          eq(indexedDocumentSpaces.documentId, indexedDocuments.documentId),
        ),
      )
      .where(eq(indexedDocumentSpaces.embeddingSpaceId, embeddingSpaceId));
    const documents: IndexedDocument[] = [];
    for (const row of rows) {
      documents.push(decodeIndexedDocument(row.document));
    }
    return documents;
  }

  public async findIndexedDocument(
    documentId: string,
    sourceFile: string,
  ): Promise<PublishedDocument | null> {
    const rows = await this.database
      .select({
        document: indexedDocuments,
        fileExtension: documentVersions.fileExtension,
        mediaType: documentVersions.mediaType,
        versionDocumentId: documentVersions.documentId,
        versionSourceFile: documentVersions.sourceFile,
      })
      .from(indexedDocuments)
      .innerJoin(
        documentVersions,
        eq(indexedDocuments.versionId, documentVersions.id),
      )
      .where(
        and(
          eq(indexedDocuments.documentId, documentId),
          eq(indexedDocuments.sourceFile, sourceFile),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : decodePublishedDocument(row);
  }

  public async resolveQueryScope(
    scope: QueryScope,
    embeddingSpaceId: string,
  ): Promise<ResolvedQueryScopeTarget[]> {
    const availableDocuments = await this.listAvailableDocuments(embeddingSpaceId);
    return resolveDocumentQueryScope(scope, embeddingSpaceId, availableDocuments);
  }

  public async updateIndexedTags(
    sourceFile: string,
    tags: string[],
  ): Promise<void> {
    await this.database
      .update(indexedDocuments)
      .set({ tags })
      .where(eq(indexedDocuments.sourceFile, sourceFile));
  }

  public async findIndexedBySourceFile(
    sourceFile: string,
  ): Promise<PublishedDocument | null> {
    const rows = await this.database
      .select({
        document: indexedDocuments,
        fileExtension: documentVersions.fileExtension,
        mediaType: documentVersions.mediaType,
        versionDocumentId: documentVersions.documentId,
        versionSourceFile: documentVersions.sourceFile,
      })
      .from(indexedDocuments)
      .innerJoin(
        documentVersions,
        eq(indexedDocuments.versionId, documentVersions.id),
      )
      .where(eq(indexedDocuments.sourceFile, sourceFile))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : decodePublishedDocument(row);
  }

  public async findIndexedSpaceDocumentId(
    sourceFile: string,
    embeddingSpaceId: string,
  ): Promise<string | null> {
    const rows = await this.database
      .select({ documentId: indexedDocumentSpaces.documentId })
      .from(indexedDocumentSpaces)
      .where(
        and(
          eq(indexedDocumentSpaces.sourceFile, sourceFile),
          eq(indexedDocumentSpaces.embeddingSpaceId, embeddingSpaceId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    return contentIdSchema.parse(row.documentId);
  }
}

function readCount(rows: Array<{ value: number }>): number {
  const row = rows[0];
  if (row === undefined || !Number.isInteger(row.value) || row.value < 0) {
    throw new Error("Database returned an invalid document reference count.");
  }
  return row.value;
}
