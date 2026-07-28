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
  retrievalDescriptionChunks384,
  retrievalDescriptionChunks768,
  retrievalDescriptionChunks1024,
  indexedDocumentSpaces,
} from "../../database/schema.js";
import { matchesResolvedQueryScope } from "./query-scope-filter.js";

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

export function queryDenseDescriptionCandidates(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
  embedding: number[],
  candidateK: number,
  scopeTargets: ResolvedQueryScopeTarget[],
): Promise<unknown[]> {
  if (space.dimensions === 384) {
    return queryDescription384(
      database,
      space.id,
      embedding,
      candidateK,
      scopeTargets,
    );
  }
  if (space.dimensions === 768) {
    return queryDescription768(
      database,
      space.id,
      embedding,
      candidateK,
      scopeTargets,
    );
  }
  return queryDescription1024(
    database,
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

async function queryDescription384(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  embedding: number[],
  topK: number,
  scopeTargets: ResolvedQueryScopeTarget[],
) {
  const distance = cosineDistance(
    retrievalDescriptionChunks384.embedding,
    embedding,
  );
  const rows = await database
    .select({
      distance,
      documentId: retrievalDescriptionChunks384.documentId,
      kind: retrievalDescriptionChunks384.kind,
      parentId: retrievalDescriptionChunks384.parentId,
      representationContent: retrievalDescriptionChunks384.description,
      representationId: retrievalDescriptionChunks384.id,
      sourceFile: retrievalDescriptionChunks384.sourceFile,
    })
    .from(retrievalDescriptionChunks384)
    .innerJoin(
      indexedDocumentSpaces,
      and(
        eq(
          indexedDocumentSpaces.documentId,
          retrievalDescriptionChunks384.documentId,
        ),
        eq(
          indexedDocumentSpaces.sourceFile,
          retrievalDescriptionChunks384.sourceFile,
        ),
        eq(
          indexedDocumentSpaces.embeddingSpaceId,
          retrievalDescriptionChunks384.embeddingSpaceId,
        ),
        eq(
          indexedDocumentSpaces.generationId,
          retrievalDescriptionChunks384.generationId,
        ),
      ),
    )
    .where(
      and(
        eq(retrievalDescriptionChunks384.embeddingSpaceId, embeddingSpaceId),
        matchesResolvedQueryScope(
          retrievalDescriptionChunks384.documentId,
          retrievalDescriptionChunks384.sourceFile,
          scopeTargets,
        ),
      ),
    )
    .orderBy(distance, asc(retrievalDescriptionChunks384.id))
    .limit(topK);
  return rows;
}

async function queryDescription768(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  embedding: number[],
  topK: number,
  scopeTargets: ResolvedQueryScopeTarget[],
) {
  const distance = cosineDistance(
    retrievalDescriptionChunks768.embedding,
    embedding,
  );
  const rows = await database
    .select({
      distance,
      documentId: retrievalDescriptionChunks768.documentId,
      kind: retrievalDescriptionChunks768.kind,
      parentId: retrievalDescriptionChunks768.parentId,
      representationContent: retrievalDescriptionChunks768.description,
      representationId: retrievalDescriptionChunks768.id,
      sourceFile: retrievalDescriptionChunks768.sourceFile,
    })
    .from(retrievalDescriptionChunks768)
    .innerJoin(
      indexedDocumentSpaces,
      and(
        eq(
          indexedDocumentSpaces.documentId,
          retrievalDescriptionChunks768.documentId,
        ),
        eq(
          indexedDocumentSpaces.sourceFile,
          retrievalDescriptionChunks768.sourceFile,
        ),
        eq(
          indexedDocumentSpaces.embeddingSpaceId,
          retrievalDescriptionChunks768.embeddingSpaceId,
        ),
        eq(
          indexedDocumentSpaces.generationId,
          retrievalDescriptionChunks768.generationId,
        ),
      ),
    )
    .where(
      and(
        eq(retrievalDescriptionChunks768.embeddingSpaceId, embeddingSpaceId),
        matchesResolvedQueryScope(
          retrievalDescriptionChunks768.documentId,
          retrievalDescriptionChunks768.sourceFile,
          scopeTargets,
        ),
      ),
    )
    .orderBy(distance, asc(retrievalDescriptionChunks768.id))
    .limit(topK);
  return rows;
}

async function queryDescription1024(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  embedding: number[],
  topK: number,
  scopeTargets: ResolvedQueryScopeTarget[],
) {
  const distance = cosineDistance(
    retrievalDescriptionChunks1024.embedding,
    embedding,
  );
  const rows = await database
    .select({
      distance,
      documentId: retrievalDescriptionChunks1024.documentId,
      kind: retrievalDescriptionChunks1024.kind,
      parentId: retrievalDescriptionChunks1024.parentId,
      representationContent: retrievalDescriptionChunks1024.description,
      representationId: retrievalDescriptionChunks1024.id,
      sourceFile: retrievalDescriptionChunks1024.sourceFile,
    })
    .from(retrievalDescriptionChunks1024)
    .innerJoin(
      indexedDocumentSpaces,
      and(
        eq(
          indexedDocumentSpaces.documentId,
          retrievalDescriptionChunks1024.documentId,
        ),
        eq(
          indexedDocumentSpaces.sourceFile,
          retrievalDescriptionChunks1024.sourceFile,
        ),
        eq(
          indexedDocumentSpaces.embeddingSpaceId,
          retrievalDescriptionChunks1024.embeddingSpaceId,
        ),
        eq(
          indexedDocumentSpaces.generationId,
          retrievalDescriptionChunks1024.generationId,
        ),
      ),
    )
    .where(
      and(
        eq(retrievalDescriptionChunks1024.embeddingSpaceId, embeddingSpaceId),
        matchesResolvedQueryScope(
          retrievalDescriptionChunks1024.documentId,
          retrievalDescriptionChunks1024.sourceFile,
          scopeTargets,
        ),
      ),
    )
    .orderBy(distance, asc(retrievalDescriptionChunks1024.id))
    .limit(topK);
  return rows;
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
      ),
    )
    .orderBy(distance, asc(retrievalChunks1024.id));
  return rows;
}
