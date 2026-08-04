import { and, asc, cosineDistance, eq, inArray, or } from "drizzle-orm";
import { z } from "zod";

import type { CiteLoomDatabase } from "../../database/client.js";
import {
  documentVersions,
  indexedDocumentSpaces,
  retrievalChunks384,
  retrievalChunks768,
  retrievalChunks1024,
  retrievalLexicalChunks,
  retrievalTocArtifacts,
} from "../../database/schema.js";
import {
  decodeDocumentTocArtifact,
  documentTocArtifactSchema,
  type DocumentTocArtifact,
} from "../../domain/document-toc.js";
import { contentIdSchema } from "../../domain/validation.js";

const storedTocRowSchema = z.object({
  artifact: documentTocArtifactSchema,
  documentId: contentIdSchema,
  elementSetId: contentIdSchema,
  generationId: z.uuid(),
  sourceFile: z.string().min(1),
});

const routedRetrievalRowSchema = z.object({
  distance: z.number().nonnegative(),
  documentId: contentIdSchema,
  evidenceContent: z.string().min(1),
  id: contentIdSchema,
  parentId: contentIdSchema,
  sourceFile: z.string().min(1),
});

const activeDocumentTocRowSchema = z.object({
  artifact: documentTocArtifactSchema,
  documentId: contentIdSchema,
  generationId: z.uuid(),
  sourceFile: z.string().min(1),
});

export interface DocumentTocGenerationIdentity {
  documentId: string;
  elementSetId: string;
  generationId: string;
  sourceFile: string;
}

export interface ActiveDocumentToc {
  artifact: DocumentTocArtifact;
  documentId: string;
  generationId: string;
  sourceFile: string;
}

export interface DocumentTocTarget {
  documentId: string;
  sourceFile: string;
}

export interface RoutedRetrievalRow {
  distance: number;
  documentId: string;
  evidenceContent: string;
  id: string;
  parentId: string;
  sourceFile: string;
}

export type PublishBackfilledDocumentTocResult =
  | "already-published"
  | "published"
  | "stale";

export async function stageDocumentTocArtifact(
  database: CiteLoomDatabase,
  identity: DocumentTocGenerationIdentity,
  artifact: DocumentTocArtifact,
): Promise<void> {
  const normalized = decodeDocumentTocArtifact(artifact);
  await database.transaction(async (transaction) => {
    const existingRows = await transaction
      .select({
        documentId: retrievalTocArtifacts.documentId,
        elementSetId: retrievalTocArtifacts.elementSetId,
        sourceFile: retrievalTocArtifacts.sourceFile,
      })
      .from(retrievalTocArtifacts)
      .where(eq(retrievalTocArtifacts.generationId, identity.generationId))
      .limit(1)
      .for("update");
    const existing = existingRows[0];
    if (existing !== undefined) {
      assertTocIdentityMatches(existing, identity);
      await transaction
        .update(retrievalTocArtifacts)
        .set({ artifact: normalized })
        .where(eq(retrievalTocArtifacts.generationId, identity.generationId));
      return;
    }
    await transaction.insert(retrievalTocArtifacts).values({
      artifact: normalized,
      documentId: identity.documentId,
      elementSetId: identity.elementSetId,
      generationId: identity.generationId,
      sourceFile: identity.sourceFile,
    });
  });
}

export async function readStagedDocumentTocArtifact(
  database: CiteLoomDatabase,
  identity: DocumentTocGenerationIdentity,
): Promise<DocumentTocArtifact | null> {
  const rows = await database
    .select({
      artifact: retrievalTocArtifacts.artifact,
      documentId: retrievalTocArtifacts.documentId,
      elementSetId: retrievalTocArtifacts.elementSetId,
      generationId: retrievalTocArtifacts.generationId,
      sourceFile: retrievalTocArtifacts.sourceFile,
    })
    .from(retrievalTocArtifacts)
    .where(eq(retrievalTocArtifacts.generationId, identity.generationId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const stored = decodeStoredTocRow(row);
  assertTocIdentityMatches(stored, identity);
  return stored.artifact;
}

export async function validateDocumentTocForPublication(
  database: CiteLoomDatabase,
  identity: DocumentTocGenerationIdentity,
): Promise<DocumentTocArtifact> {
  const artifact = await readStagedDocumentTocArtifact(database, identity);
  if (artifact === null) {
    throw new Error(
      `Document TOC artifact is missing for generation ${identity.generationId}.`,
    );
  }
  await validateDocumentTocRetrievalReferences(database, identity, artifact);
  return artifact;
}

export async function publishBackfilledDocumentTocArtifact(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  identity: DocumentTocGenerationIdentity,
  artifact: DocumentTocArtifact,
): Promise<PublishBackfilledDocumentTocResult> {
  const normalized = decodeDocumentTocArtifact(artifact);
  return database.transaction(async (transaction) => {
    const activeRows = await transaction
      .select({ elementSetId: documentVersions.elementSetId })
      .from(indexedDocumentSpaces)
      .innerJoin(
        documentVersions,
        and(
          eq(documentVersions.documentId, indexedDocumentSpaces.documentId),
          eq(documentVersions.generationId, indexedDocumentSpaces.generationId),
          eq(documentVersions.sourceFile, indexedDocumentSpaces.sourceFile),
        ),
      )
      .where(and(
        eq(indexedDocumentSpaces.documentId, identity.documentId),
        eq(indexedDocumentSpaces.embeddingSpaceId, embeddingSpaceId),
        eq(indexedDocumentSpaces.generationId, identity.generationId),
        eq(indexedDocumentSpaces.sourceFile, identity.sourceFile),
      ))
      .limit(1)
      .for("update");
    const active = activeRows[0];
    if (active === undefined || active.elementSetId !== identity.elementSetId) {
      return "stale";
    }
    const existingRows = await transaction
      .select({
        artifact: retrievalTocArtifacts.artifact,
        documentId: retrievalTocArtifacts.documentId,
        elementSetId: retrievalTocArtifacts.elementSetId,
        sourceFile: retrievalTocArtifacts.sourceFile,
      })
      .from(retrievalTocArtifacts)
      .where(eq(retrievalTocArtifacts.generationId, identity.generationId))
      .limit(1)
      .for("update");
    const existing = existingRows[0];
    if (existing !== undefined) {
      assertTocIdentityMatches(existing, identity);
      const existingArtifact = decodeDocumentTocArtifact(existing.artifact);
      if (existingArtifact.mode === "generated") {
        return "already-published";
      }
    }
    await validateDocumentTocRetrievalReferences(
      transaction,
      identity,
      normalized,
    );
    if (existing === undefined) {
      await transaction.insert(retrievalTocArtifacts).values({
        artifact: normalized,
        documentId: identity.documentId,
        elementSetId: identity.elementSetId,
        generationId: identity.generationId,
        sourceFile: identity.sourceFile,
      });
    } else {
      await transaction
        .update(retrievalTocArtifacts)
        .set({ artifact: normalized, createdAt: new Date() })
        .where(eq(retrievalTocArtifacts.generationId, identity.generationId));
    }
    return "published";
  });
}

async function validateDocumentTocRetrievalReferences(
  database: CiteLoomDatabase,
  identity: DocumentTocGenerationIdentity,
  artifact: DocumentTocArtifact,
): Promise<void> {
  const referencedIds = new Set<string>();
  for (const entry of artifact.entries) {
    for (const retrievalId of entry.retrievalWindowIds) {
      referencedIds.add(retrievalId);
    }
  }
  if (referencedIds.size === 0) {
    return;
  }
  const rows = await database
    .select({ id: retrievalLexicalChunks.id })
    .from(retrievalLexicalChunks)
    .where(and(
      eq(retrievalLexicalChunks.documentId, identity.documentId),
      eq(retrievalLexicalChunks.generationId, identity.generationId),
      eq(retrievalLexicalChunks.sourceFile, identity.sourceFile),
      eq(retrievalLexicalChunks.representationType, "exact-window"),
      inArray(retrievalLexicalChunks.id, [...referencedIds]),
    ));
  const persistedIds = new Set(rows.map((row) => row.id));
  for (const retrievalId of referencedIds) {
    if (!persistedIds.has(retrievalId)) {
      throw new Error(
        `Document TOC references missing retrieval window ${retrievalId}.`,
      );
    }
  }
}

export async function readActiveDocumentTocs(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  targets: readonly DocumentTocTarget[],
): Promise<ActiveDocumentToc[]> {
  const uniqueTargets = new Map<string, DocumentTocTarget>();
  for (const target of targets) {
    const key = `${target.documentId}\u0000${target.sourceFile}`;
    uniqueTargets.set(key, target);
  }
  if (uniqueTargets.size === 0) {
    return [];
  }
  const targetConditions = [...uniqueTargets.values()].map((target) => and(
    eq(retrievalTocArtifacts.documentId, target.documentId),
    eq(retrievalTocArtifacts.sourceFile, target.sourceFile),
  ));
  const targetCondition = or(...targetConditions);
  if (targetCondition === undefined) {
    return [];
  }
  const rows = await database
    .select({
      artifact: retrievalTocArtifacts.artifact,
      documentId: retrievalTocArtifacts.documentId,
      generationId: retrievalTocArtifacts.generationId,
      sourceFile: retrievalTocArtifacts.sourceFile,
    })
    .from(retrievalTocArtifacts)
    .innerJoin(
      indexedDocumentSpaces,
      and(
        eq(indexedDocumentSpaces.documentId, retrievalTocArtifacts.documentId),
        eq(indexedDocumentSpaces.sourceFile, retrievalTocArtifacts.sourceFile),
        eq(indexedDocumentSpaces.generationId, retrievalTocArtifacts.generationId),
      ),
    )
    .where(and(
      eq(indexedDocumentSpaces.embeddingSpaceId, embeddingSpaceId),
      targetCondition,
    ));
  const activeTocs: ActiveDocumentToc[] = [];
  for (const row of rows) {
    const decoded = activeDocumentTocRowSchema.parse(row);
    activeTocs.push({
      artifact: decoded.artifact,
      documentId: decoded.documentId,
      generationId: decoded.generationId,
      sourceFile: decoded.sourceFile,
    });
  }
  activeTocs.sort((left, right) => {
    const documentDifference = left.documentId.localeCompare(right.documentId);
    if (documentDifference !== 0) {
      return documentDifference;
    }
    return left.sourceFile.localeCompare(right.sourceFile);
  });
  return activeTocs;
}

export function queryActiveTocRetrievalRows(
  database: CiteLoomDatabase,
  space: { dimensions: 384 | 768 | 1024; id: string },
  embedding: number[],
  documentId: string,
  sourceFile: string,
  retrievalIds: string[],
  limit: number,
): Promise<RoutedRetrievalRow[]> {
  if (retrievalIds.length === 0) {
    return Promise.resolve([]);
  }
  if (space.dimensions === 384) {
    return queryTocRows384(
      database,
      space.id,
      embedding,
      documentId,
      sourceFile,
      retrievalIds,
      limit,
    );
  }
  if (space.dimensions === 768) {
    return queryTocRows768(
      database,
      space.id,
      embedding,
      documentId,
      sourceFile,
      retrievalIds,
      limit,
    );
  }
  return queryTocRows1024(
    database,
    space.id,
    embedding,
    documentId,
    sourceFile,
    retrievalIds,
    limit,
  );
}

async function queryTocRows384(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  embedding: number[],
  documentId: string,
  sourceFile: string,
  retrievalIds: string[],
  limit: number,
): Promise<RoutedRetrievalRow[]> {
  const distance = cosineDistance(retrievalChunks384.embedding, embedding);
  const rows = await database
    .select({
      distance,
      documentId: retrievalChunks384.documentId,
      evidenceContent: retrievalChunks384.evidenceContent,
      id: retrievalChunks384.id,
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
    .where(and(
      eq(retrievalChunks384.embeddingSpaceId, embeddingSpaceId),
      eq(retrievalChunks384.documentId, documentId),
      eq(retrievalChunks384.sourceFile, sourceFile),
      eq(retrievalChunks384.representationType, "exact-window"),
      inArray(retrievalChunks384.id, retrievalIds),
    ))
    .orderBy(distance, asc(retrievalChunks384.id))
    .limit(limit);
  return decodeRoutedRows(rows);
}

async function queryTocRows768(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  embedding: number[],
  documentId: string,
  sourceFile: string,
  retrievalIds: string[],
  limit: number,
): Promise<RoutedRetrievalRow[]> {
  const distance = cosineDistance(retrievalChunks768.embedding, embedding);
  const rows = await database
    .select({
      distance,
      documentId: retrievalChunks768.documentId,
      evidenceContent: retrievalChunks768.evidenceContent,
      id: retrievalChunks768.id,
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
    .where(and(
      eq(retrievalChunks768.embeddingSpaceId, embeddingSpaceId),
      eq(retrievalChunks768.documentId, documentId),
      eq(retrievalChunks768.sourceFile, sourceFile),
      eq(retrievalChunks768.representationType, "exact-window"),
      inArray(retrievalChunks768.id, retrievalIds),
    ))
    .orderBy(distance, asc(retrievalChunks768.id))
    .limit(limit);
  return decodeRoutedRows(rows);
}

async function queryTocRows1024(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  embedding: number[],
  documentId: string,
  sourceFile: string,
  retrievalIds: string[],
  limit: number,
): Promise<RoutedRetrievalRow[]> {
  const distance = cosineDistance(retrievalChunks1024.embedding, embedding);
  const rows = await database
    .select({
      distance,
      documentId: retrievalChunks1024.documentId,
      evidenceContent: retrievalChunks1024.evidenceContent,
      id: retrievalChunks1024.id,
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
        eq(indexedDocumentSpaces.generationId, retrievalChunks1024.generationId),
      ),
    )
    .where(and(
      eq(retrievalChunks1024.embeddingSpaceId, embeddingSpaceId),
      eq(retrievalChunks1024.documentId, documentId),
      eq(retrievalChunks1024.sourceFile, sourceFile),
      eq(retrievalChunks1024.representationType, "exact-window"),
      inArray(retrievalChunks1024.id, retrievalIds),
    ))
    .orderBy(distance, asc(retrievalChunks1024.id))
    .limit(limit);
  return decodeRoutedRows(rows);
}

function decodeRoutedRows(rows: unknown[]): RoutedRetrievalRow[] {
  const decoded: RoutedRetrievalRow[] = [];
  for (const row of rows) {
    decoded.push(routedRetrievalRowSchema.parse(row));
  }
  return decoded;
}

function decodeStoredTocRow(value: unknown) {
  const result = storedTocRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid stored document TOC row: ${result.error.message}`);
  }
  return result.data;
}

function assertTocIdentityMatches(
  stored: {
    documentId: string;
    elementSetId: string;
    sourceFile: string;
  },
  expected: DocumentTocGenerationIdentity,
): void {
  if (
    stored.documentId !== expected.documentId
    || stored.elementSetId !== expected.elementSetId
    || stored.sourceFile !== expected.sourceFile
  ) {
    throw new Error(
      `Document TOC generation identity does not match ${expected.generationId}.`,
    );
  }
}
