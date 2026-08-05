import {
  and,
  asc,
  cosineDistance,
  eq,
  inArray,
} from "drizzle-orm";

import type { EmbeddingSpaceConfig } from "../../config/index.js";
import type { CiteLoomDatabase } from "../../database/client.js";
import { indexedDocumentSpaces } from "../../database/schema.js";
import type { ResolvedQueryScopeTarget } from "../../domain/query-scope.js";
import {
  readRetrievalVectorTable,
  type RetrievalVectorTable,
} from "../../embedding/storage-tables.js";
import { matchesResolvedQueryScope } from "./query-scope-filter.js";

export interface ActiveRetrievalWindowRow {
  evidenceContent: string;
  id: string;
  nextRetrievalId: string | null;
  previousRetrievalId: string | null;
}

export function readActiveRetrievalWindows(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
  retrievalIds: string[],
): Promise<ActiveRetrievalWindowRow[]> {
  if (retrievalIds.length === 0) {
    return Promise.resolve([]);
  }
  const table = readRetrievalVectorTable(space.dimensions);
  return readActiveRetrievalWindowsFromTable(
    database,
    table,
    space.id,
    retrievalIds,
  );
}

export function queryDenseCandidates(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
  embedding: number[],
  candidateK: number,
  scopeTargets: ResolvedQueryScopeTarget[],
): Promise<unknown[]> {
  const table = readRetrievalVectorTable(space.dimensions);
  return queryDenseCandidatesFromTable(
    database,
    table,
    space.id,
    embedding,
    candidateK,
    scopeTargets,
  );
}

export function queryDenseEvidenceCandidates(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
  embedding: number[],
  scopeTargets: ResolvedQueryScopeTarget[],
  parentIds: string[],
): Promise<unknown[]> {
  if (parentIds.length === 0) {
    return Promise.resolve([]);
  }
  const table = readRetrievalVectorTable(space.dimensions);
  return queryDenseEvidenceCandidatesFromTable(
    database,
    table,
    space.id,
    embedding,
    scopeTargets,
    parentIds,
  );
}

async function queryDenseCandidatesFromTable(
  database: CiteLoomDatabase,
  table: RetrievalVectorTable,
  embeddingSpaceId: string,
  embedding: number[],
  topK: number,
  scopeTargets: ResolvedQueryScopeTarget[],
): Promise<unknown[]> {
  const distance = cosineDistance(table.embedding, embedding);
  return database
    .select({
      distance,
      documentId: table.documentId,
      evidenceContent: table.evidenceContent,
      evidenceRetrievalId: table.id,
      kind: table.kind,
      parentId: table.parentId,
      representationContent: table.evidenceContent,
      representationId: table.id,
      representationType: table.representationType,
      sourceFile: table.sourceFile,
    })
    .from(table)
    .innerJoin(
      indexedDocumentSpaces,
      and(
        eq(indexedDocumentSpaces.documentId, table.documentId),
        eq(indexedDocumentSpaces.sourceFile, table.sourceFile),
        eq(indexedDocumentSpaces.embeddingSpaceId, table.embeddingSpaceId),
        eq(indexedDocumentSpaces.generationId, table.generationId),
      ),
    )
    .where(
      and(
        eq(table.embeddingSpaceId, embeddingSpaceId),
        matchesResolvedQueryScope(
          table.documentId,
          table.sourceFile,
          scopeTargets,
        ),
      ),
    )
    .orderBy(distance, asc(table.id))
    .limit(topK);
}

async function queryDenseEvidenceCandidatesFromTable(
  database: CiteLoomDatabase,
  table: RetrievalVectorTable,
  embeddingSpaceId: string,
  embedding: number[],
  scopeTargets: ResolvedQueryScopeTarget[],
  parentIds: string[],
): Promise<unknown[]> {
  const distance = cosineDistance(table.embedding, embedding);
  return database
    .select({
      distance,
      documentId: table.documentId,
      evidenceContent: table.evidenceContent,
      evidenceRetrievalId: table.id,
      parentId: table.parentId,
      sourceFile: table.sourceFile,
    })
    .from(table)
    .innerJoin(
      indexedDocumentSpaces,
      and(
        eq(indexedDocumentSpaces.documentId, table.documentId),
        eq(indexedDocumentSpaces.sourceFile, table.sourceFile),
        eq(indexedDocumentSpaces.embeddingSpaceId, table.embeddingSpaceId),
        eq(indexedDocumentSpaces.generationId, table.generationId),
      ),
    )
    .where(
      and(
        eq(table.embeddingSpaceId, embeddingSpaceId),
        matchesResolvedQueryScope(
          table.documentId,
          table.sourceFile,
          scopeTargets,
        ),
        inArray(table.parentId, parentIds),
        eq(table.representationType, "exact-window"),
      ),
    )
    .orderBy(distance, asc(table.id));
}

async function readActiveRetrievalWindowsFromTable(
  database: CiteLoomDatabase,
  table: RetrievalVectorTable,
  embeddingSpaceId: string,
  retrievalIds: string[],
): Promise<ActiveRetrievalWindowRow[]> {
  return database
    .select({
      evidenceContent: table.evidenceContent,
      id: table.id,
      nextRetrievalId: table.nextRetrievalId,
      previousRetrievalId: table.previousRetrievalId,
    })
    .from(table)
    .innerJoin(
      indexedDocumentSpaces,
      and(
        eq(indexedDocumentSpaces.documentId, table.documentId),
        eq(indexedDocumentSpaces.sourceFile, table.sourceFile),
        eq(indexedDocumentSpaces.embeddingSpaceId, table.embeddingSpaceId),
        eq(indexedDocumentSpaces.generationId, table.generationId),
      ),
    )
    .where(and(
      eq(table.embeddingSpaceId, embeddingSpaceId),
      inArray(table.id, retrievalIds),
      eq(table.representationType, "exact-window"),
    ));
}
