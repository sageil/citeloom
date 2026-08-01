import {
  and,
  asc,
  cosineDistance,
  eq,
  inArray,
} from "drizzle-orm";

import type { EmbeddingSpaceConfig } from "../../config/index.js";
import type { CiteLoomDatabase } from "../../database/client.js";
import type { ResolvedQueryScopeTarget } from "../../domain/query-scope.js";
import {
  retrievalChunks384,
  retrievalChunks768,
  retrievalChunks1024,
  indexedDocumentSpaces,
} from "../../database/schema.js";
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
  if (space.dimensions === 384) {
    return readActiveRetrievalWindows384(database, space.id, retrievalIds);
  }
  if (space.dimensions === 768) {
    return readActiveRetrievalWindows768(database, space.id, retrievalIds);
  }
  return readActiveRetrievalWindows1024(database, space.id, retrievalIds);
}

export function queryDenseCandidates(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
  embedding: number[],
  candidateK: number,
  scopeTargets: ResolvedQueryScopeTarget[],
): Promise<unknown[]> {
  if (space.dimensions === 384) {
    return query384(database, space.id, embedding, candidateK, scopeTargets);
  }
  if (space.dimensions === 768) {
    return query768(database, space.id, embedding, candidateK, scopeTargets);
  }
  return query1024(database, space.id, embedding, candidateK, scopeTargets);
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
  if (space.dimensions === 384) {
    return queryEvidence384(
      database,
      space.id,
      embedding,
      scopeTargets,
      parentIds,
    );
  }
  if (space.dimensions === 768) {
    return queryEvidence768(
      database,
      space.id,
      embedding,
      scopeTargets,
      parentIds,
    );
  }
  return queryEvidence1024(
    database,
    space.id,
    embedding,
    scopeTargets,
    parentIds,
  );
}

async function query384(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  embedding: number[],
  topK: number,
  scopeTargets: ResolvedQueryScopeTarget[],
) {
  const distance = cosineDistance(retrievalChunks384.embedding, embedding);
  return database
    .select({
      distance,
      documentId: retrievalChunks384.documentId,
      evidenceContent: retrievalChunks384.evidenceContent,
      evidenceRetrievalId: retrievalChunks384.id,
      kind: retrievalChunks384.kind,
      parentId: retrievalChunks384.parentId,
      representationContent: retrievalChunks384.evidenceContent,
      representationId: retrievalChunks384.id,
      representationType: retrievalChunks384.representationType,
      sourceFile: retrievalChunks384.sourceFile,
    })
    .from(retrievalChunks384)
    .innerJoin(
      indexedDocumentSpaces,
      and(
        eq(indexedDocumentSpaces.documentId, retrievalChunks384.documentId),
        eq(indexedDocumentSpaces.sourceFile, retrievalChunks384.sourceFile),
        eq(
          indexedDocumentSpaces.embeddingSpaceId,
          retrievalChunks384.embeddingSpaceId,
        ),
        eq(indexedDocumentSpaces.generationId, retrievalChunks384.generationId),
      ),
    )
    .where(
      and(
        eq(retrievalChunks384.embeddingSpaceId, embeddingSpaceId),
        matchesResolvedQueryScope(
          retrievalChunks384.documentId,
          retrievalChunks384.sourceFile,
          scopeTargets,
        ),
      ),
    )
    .orderBy(distance, asc(retrievalChunks384.id))
    .limit(topK);
}

async function query768(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  embedding: number[],
  topK: number,
  scopeTargets: ResolvedQueryScopeTarget[],
) {
  const distance = cosineDistance(retrievalChunks768.embedding, embedding);
  return database
    .select({
      distance,
      documentId: retrievalChunks768.documentId,
      evidenceContent: retrievalChunks768.evidenceContent,
      evidenceRetrievalId: retrievalChunks768.id,
      kind: retrievalChunks768.kind,
      parentId: retrievalChunks768.parentId,
      representationContent: retrievalChunks768.evidenceContent,
      representationId: retrievalChunks768.id,
      representationType: retrievalChunks768.representationType,
      sourceFile: retrievalChunks768.sourceFile,
    })
    .from(retrievalChunks768)
    .innerJoin(
      indexedDocumentSpaces,
      and(
        eq(indexedDocumentSpaces.documentId, retrievalChunks768.documentId),
        eq(indexedDocumentSpaces.sourceFile, retrievalChunks768.sourceFile),
        eq(
          indexedDocumentSpaces.embeddingSpaceId,
          retrievalChunks768.embeddingSpaceId,
        ),
        eq(indexedDocumentSpaces.generationId, retrievalChunks768.generationId),
      ),
    )
    .where(
      and(
        eq(retrievalChunks768.embeddingSpaceId, embeddingSpaceId),
        matchesResolvedQueryScope(
          retrievalChunks768.documentId,
          retrievalChunks768.sourceFile,
          scopeTargets,
        ),
      ),
    )
    .orderBy(distance, asc(retrievalChunks768.id))
    .limit(topK);
}

async function query1024(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  embedding: number[],
  topK: number,
  scopeTargets: ResolvedQueryScopeTarget[],
) {
  const distance = cosineDistance(retrievalChunks1024.embedding, embedding);
  return database
    .select({
      distance,
      documentId: retrievalChunks1024.documentId,
      evidenceContent: retrievalChunks1024.evidenceContent,
      evidenceRetrievalId: retrievalChunks1024.id,
      kind: retrievalChunks1024.kind,
      parentId: retrievalChunks1024.parentId,
      representationContent: retrievalChunks1024.evidenceContent,
      representationId: retrievalChunks1024.id,
      representationType: retrievalChunks1024.representationType,
      sourceFile: retrievalChunks1024.sourceFile,
    })
    .from(retrievalChunks1024)
    .innerJoin(
      indexedDocumentSpaces,
      and(
        eq(indexedDocumentSpaces.documentId, retrievalChunks1024.documentId),
        eq(indexedDocumentSpaces.sourceFile, retrievalChunks1024.sourceFile),
        eq(
          indexedDocumentSpaces.embeddingSpaceId,
          retrievalChunks1024.embeddingSpaceId,
        ),
        eq(
          indexedDocumentSpaces.generationId,
          retrievalChunks1024.generationId,
        ),
      ),
    )
    .where(
      and(
        eq(retrievalChunks1024.embeddingSpaceId, embeddingSpaceId),
        matchesResolvedQueryScope(
          retrievalChunks1024.documentId,
          retrievalChunks1024.sourceFile,
          scopeTargets,
        ),
      ),
    )
    .orderBy(distance, asc(retrievalChunks1024.id))
    .limit(topK);
}

async function queryEvidence384(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  embedding: number[],
  scopeTargets: ResolvedQueryScopeTarget[],
  parentIds: string[],
) {
  const distance = cosineDistance(retrievalChunks384.embedding, embedding);
  const rows = await database
    .select({
      distance,
      documentId: retrievalChunks384.documentId,
      evidenceContent: retrievalChunks384.evidenceContent,
      evidenceRetrievalId: retrievalChunks384.id,
      parentId: retrievalChunks384.parentId,
      sourceFile: retrievalChunks384.sourceFile,
    })
    .from(retrievalChunks384)
    .innerJoin(
      indexedDocumentSpaces,
      and(
        eq(indexedDocumentSpaces.documentId, retrievalChunks384.documentId),
        eq(indexedDocumentSpaces.sourceFile, retrievalChunks384.sourceFile),
        eq(
          indexedDocumentSpaces.embeddingSpaceId,
          retrievalChunks384.embeddingSpaceId,
        ),
        eq(indexedDocumentSpaces.generationId, retrievalChunks384.generationId),
      ),
    )
    .where(
      and(
        eq(retrievalChunks384.embeddingSpaceId, embeddingSpaceId),
        matchesResolvedQueryScope(
          retrievalChunks384.documentId,
          retrievalChunks384.sourceFile,
          scopeTargets,
        ),
        inArray(retrievalChunks384.parentId, parentIds),
        eq(retrievalChunks384.representationType, "exact-window"),
      ),
    )
    .orderBy(distance, asc(retrievalChunks384.id));
  return rows;
}

async function queryEvidence768(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  embedding: number[],
  scopeTargets: ResolvedQueryScopeTarget[],
  parentIds: string[],
) {
  const distance = cosineDistance(retrievalChunks768.embedding, embedding);
  const rows = await database
    .select({
      distance,
      documentId: retrievalChunks768.documentId,
      evidenceContent: retrievalChunks768.evidenceContent,
      evidenceRetrievalId: retrievalChunks768.id,
      parentId: retrievalChunks768.parentId,
      sourceFile: retrievalChunks768.sourceFile,
    })
    .from(retrievalChunks768)
    .innerJoin(
      indexedDocumentSpaces,
      and(
        eq(indexedDocumentSpaces.documentId, retrievalChunks768.documentId),
        eq(indexedDocumentSpaces.sourceFile, retrievalChunks768.sourceFile),
        eq(
          indexedDocumentSpaces.embeddingSpaceId,
          retrievalChunks768.embeddingSpaceId,
        ),
        eq(indexedDocumentSpaces.generationId, retrievalChunks768.generationId),
      ),
    )
    .where(
      and(
        eq(retrievalChunks768.embeddingSpaceId, embeddingSpaceId),
        matchesResolvedQueryScope(
          retrievalChunks768.documentId,
          retrievalChunks768.sourceFile,
          scopeTargets,
        ),
        inArray(retrievalChunks768.parentId, parentIds),
        eq(retrievalChunks768.representationType, "exact-window"),
      ),
    )
    .orderBy(distance, asc(retrievalChunks768.id));
  return rows;
}

async function queryEvidence1024(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  embedding: number[],
  scopeTargets: ResolvedQueryScopeTarget[],
  parentIds: string[],
) {
  const distance = cosineDistance(retrievalChunks1024.embedding, embedding);
  const rows = await database
    .select({
      distance,
      documentId: retrievalChunks1024.documentId,
      evidenceContent: retrievalChunks1024.evidenceContent,
      evidenceRetrievalId: retrievalChunks1024.id,
      parentId: retrievalChunks1024.parentId,
      sourceFile: retrievalChunks1024.sourceFile,
    })
    .from(retrievalChunks1024)
    .innerJoin(
      indexedDocumentSpaces,
      and(
        eq(indexedDocumentSpaces.documentId, retrievalChunks1024.documentId),
        eq(indexedDocumentSpaces.sourceFile, retrievalChunks1024.sourceFile),
        eq(
          indexedDocumentSpaces.embeddingSpaceId,
          retrievalChunks1024.embeddingSpaceId,
        ),
        eq(
          indexedDocumentSpaces.generationId,
          retrievalChunks1024.generationId,
        ),
      ),
    )
    .where(
      and(
        eq(retrievalChunks1024.embeddingSpaceId, embeddingSpaceId),
        matchesResolvedQueryScope(
          retrievalChunks1024.documentId,
          retrievalChunks1024.sourceFile,
          scopeTargets,
        ),
        inArray(retrievalChunks1024.parentId, parentIds),
        eq(retrievalChunks1024.representationType, "exact-window"),
      ),
    )
    .orderBy(distance, asc(retrievalChunks1024.id));
  return rows;
}

async function readActiveRetrievalWindows384(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  retrievalIds: string[],
): Promise<ActiveRetrievalWindowRow[]> {
  return database
    .select({
      evidenceContent: retrievalChunks384.evidenceContent,
      id: retrievalChunks384.id,
      nextRetrievalId: retrievalChunks384.nextRetrievalId,
      previousRetrievalId: retrievalChunks384.previousRetrievalId,
    })
    .from(retrievalChunks384)
    .innerJoin(
      indexedDocumentSpaces,
      and(
        eq(indexedDocumentSpaces.documentId, retrievalChunks384.documentId),
        eq(indexedDocumentSpaces.sourceFile, retrievalChunks384.sourceFile),
        eq(
          indexedDocumentSpaces.embeddingSpaceId,
          retrievalChunks384.embeddingSpaceId,
        ),
        eq(indexedDocumentSpaces.generationId, retrievalChunks384.generationId),
      ),
    )
    .where(and(
      eq(retrievalChunks384.embeddingSpaceId, embeddingSpaceId),
      inArray(retrievalChunks384.id, retrievalIds),
      eq(retrievalChunks384.representationType, "exact-window"),
    ));
}

async function readActiveRetrievalWindows768(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  retrievalIds: string[],
): Promise<ActiveRetrievalWindowRow[]> {
  return database
    .select({
      evidenceContent: retrievalChunks768.evidenceContent,
      id: retrievalChunks768.id,
      nextRetrievalId: retrievalChunks768.nextRetrievalId,
      previousRetrievalId: retrievalChunks768.previousRetrievalId,
    })
    .from(retrievalChunks768)
    .innerJoin(
      indexedDocumentSpaces,
      and(
        eq(indexedDocumentSpaces.documentId, retrievalChunks768.documentId),
        eq(indexedDocumentSpaces.sourceFile, retrievalChunks768.sourceFile),
        eq(
          indexedDocumentSpaces.embeddingSpaceId,
          retrievalChunks768.embeddingSpaceId,
        ),
        eq(indexedDocumentSpaces.generationId, retrievalChunks768.generationId),
      ),
    )
    .where(and(
      eq(retrievalChunks768.embeddingSpaceId, embeddingSpaceId),
      inArray(retrievalChunks768.id, retrievalIds),
      eq(retrievalChunks768.representationType, "exact-window"),
    ));
}

async function readActiveRetrievalWindows1024(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  retrievalIds: string[],
): Promise<ActiveRetrievalWindowRow[]> {
  return database
    .select({
      evidenceContent: retrievalChunks1024.evidenceContent,
      id: retrievalChunks1024.id,
      nextRetrievalId: retrievalChunks1024.nextRetrievalId,
      previousRetrievalId: retrievalChunks1024.previousRetrievalId,
    })
    .from(retrievalChunks1024)
    .innerJoin(
      indexedDocumentSpaces,
      and(
        eq(indexedDocumentSpaces.documentId, retrievalChunks1024.documentId),
        eq(indexedDocumentSpaces.sourceFile, retrievalChunks1024.sourceFile),
        eq(
          indexedDocumentSpaces.embeddingSpaceId,
          retrievalChunks1024.embeddingSpaceId,
        ),
        eq(indexedDocumentSpaces.generationId, retrievalChunks1024.generationId),
      ),
    )
    .where(and(
      eq(retrievalChunks1024.embeddingSpaceId, embeddingSpaceId),
      inArray(retrievalChunks1024.id, retrievalIds),
      eq(retrievalChunks1024.representationType, "exact-window"),
    ));
}
