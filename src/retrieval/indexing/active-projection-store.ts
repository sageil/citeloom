import { and, count, eq, notExists, or, sql } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import {
  activeRetrievalEvidence,
  activeRetrievalLexicalChunks,
  activeRetrievalRoutes,
  embeddingSpaces,
  retrievalLexicalChunks,
} from "../../database/schema.js";
import {
  readEmbeddingDimensions,
  type EmbeddingDimensions,
} from "../../embedding/dimensions.js";
import {
  ACTIVE_RETRIEVAL_VECTOR_TABLES,
  readActiveRetrievalVectorTable,
  readRetrievalVectorTable,
} from "../../embedding/storage-tables.js";
import type {
  PublishableEmbeddingGeneration,
  RetrievalTransaction,
} from "./index-store.js";

interface ActiveProjectionInput extends PublishableEmbeddingGeneration {
  sourceFile: string;
}

export interface ActiveProjectionIdentity {
  documentId: string;
  embeddingSpaceId: string;
  sourceFile: string;
}

export async function synchronizeActiveRetrievalProjection(
  transaction: RetrievalTransaction,
  input: ActiveProjectionInput,
): Promise<void> {
  const dimensions = await readProjectionDimensions(
    transaction,
    input.embeddingSpaceId,
  );
  await deleteReplacedProjectionRows(transaction, input);
  await insertActiveVectorRows(transaction, dimensions, input);
  await insertActiveLexicalRows(transaction, input);
  await insertActiveRouteRows(transaction, input);
  await insertActiveEvidenceRows(transaction, input);
  await validateActiveProjection(transaction, dimensions, input);
}

export async function deleteActiveRetrievalProjection(
  transaction: RetrievalTransaction,
  identity: ActiveProjectionIdentity,
): Promise<void> {
  await deleteActiveProjectionRows(transaction, sql`
    "document_id" = ${identity.documentId}
    AND "embedding_space_id" = ${identity.embeddingSpaceId}
    AND "source_file" = ${identity.sourceFile}
  `);
}

async function readProjectionDimensions(
  transaction: RetrievalTransaction,
  embeddingSpaceId: string,
): Promise<EmbeddingDimensions> {
  const rows = await transaction
    .select({ dimensions: embeddingSpaces.dimensions })
    .from(embeddingSpaces)
    .where(eq(embeddingSpaces.id, embeddingSpaceId))
    .limit(1);
  return readEmbeddingDimensions(
    rows[0]?.dimensions,
    `Embedding space ${embeddingSpaceId} has invalid dimensions.`,
  );
}

async function deleteReplacedProjectionRows(
  transaction: RetrievalTransaction,
  input: ActiveProjectionInput,
): Promise<void> {
  await deleteActiveProjectionRows(transaction, sql`
    "source_file" = ${input.sourceFile}
    AND (
      "document_id" <> ${input.documentId}
      OR "embedding_space_id" = ${input.embeddingSpaceId}
    )
  `);
}

async function deleteActiveProjectionRows(
  transaction: RetrievalTransaction,
  condition: ReturnType<typeof sql>,
): Promise<void> {
  const tables: AnyPgTable[] = [
    activeRetrievalRoutes,
    activeRetrievalEvidence,
    activeRetrievalLexicalChunks,
    ...ACTIVE_RETRIEVAL_VECTOR_TABLES,
  ];
  for (const table of tables) {
    await transaction.execute(sql`DELETE FROM ${table} WHERE ${condition}`);
  }
}

async function insertActiveVectorRows(
  transaction: RetrievalTransaction,
  dimensions: EmbeddingDimensions,
  input: ActiveProjectionInput,
): Promise<void> {
  const activeTable = readActiveRetrievalVectorTable(dimensions);
  const canonicalTable = readRetrievalVectorTable(dimensions);
  await transaction.execute(sql`
    INSERT INTO ${activeTable} (
      "document_id",
      "embedding_space_id",
      "generation_id",
      "representation_id",
      "source_file",
      "embedding"
    )
    SELECT
      "document_id",
      "embedding_space_id",
      "generation_id",
      "id",
      "source_file",
      "embedding"
    FROM ${canonicalTable}
    WHERE "embedding_space_id" = ${input.embeddingSpaceId}
      AND "generation_id" = ${input.generationId}
      AND "document_id" = ${input.documentId}
      AND "source_file" = ${input.sourceFile}
  `);
}

async function insertActiveLexicalRows(
  transaction: RetrievalTransaction,
  input: ActiveProjectionInput,
): Promise<void> {
  await transaction.execute(sql`
    INSERT INTO ${activeRetrievalLexicalChunks} (
      "content",
      "document_id",
      "embedding_space_id",
      "generation_id",
      "representation_id",
      "source_file"
    )
    SELECT
      "content",
      "document_id",
      "embedding_space_id",
      "generation_id",
      "id",
      "source_file"
    FROM ${retrievalLexicalChunks}
    WHERE "embedding_space_id" = ${input.embeddingSpaceId}
      AND "generation_id" = ${input.generationId}
      AND "document_id" = ${input.documentId}
      AND "source_file" = ${input.sourceFile}
  `);
}

async function insertActiveRouteRows(
  transaction: RetrievalTransaction,
  input: ActiveProjectionInput,
): Promise<void> {
  await transaction.execute(sql`
    INSERT INTO ${activeRetrievalRoutes} (
      "document_id",
      "embedding_space_id",
      "generation_id",
      "representation_id",
      "source_file",
      "evidence_id",
      "evidence_mode",
      "kind",
      "parent_id",
      "representation_content",
      "representation_type"
    )
    SELECT
      "document_id",
      "embedding_space_id",
      "generation_id",
      "id",
      "source_file",
      CASE
        WHEN "representation_type" = 'exact-window' THEN "id"
        WHEN "representation_type" = 'image-description' THEN "parent_id"
        ELSE NULL
      END,
      CASE
        WHEN "representation_type" = 'table-description'
          THEN 'parent-exact'
        ELSE 'direct'
      END,
      "kind",
      "parent_id",
      "evidence_content",
      "representation_type"
    FROM ${retrievalLexicalChunks}
    WHERE "embedding_space_id" = ${input.embeddingSpaceId}
      AND "generation_id" = ${input.generationId}
      AND "document_id" = ${input.documentId}
      AND "source_file" = ${input.sourceFile}
  `);
}

async function insertActiveEvidenceRows(
  transaction: RetrievalTransaction,
  input: ActiveProjectionInput,
): Promise<void> {
  const conflictingRows = await transaction
    .select({ parentId: retrievalLexicalChunks.parentId })
    .from(retrievalLexicalChunks)
    .where(and(
      eq(retrievalLexicalChunks.embeddingSpaceId, input.embeddingSpaceId),
      eq(retrievalLexicalChunks.generationId, input.generationId),
      eq(retrievalLexicalChunks.documentId, input.documentId),
      eq(retrievalLexicalChunks.sourceFile, input.sourceFile),
      eq(retrievalLexicalChunks.representationType, "image-description"),
    ))
    .groupBy(retrievalLexicalChunks.parentId)
    .having(sql`count(DISTINCT ${retrievalLexicalChunks.evidenceContent}) > 1`)
    .limit(1);
  if (conflictingRows.length > 0) {
    throw new Error(
      `Image evidence differs within generation ${input.generationId}.`,
    );
  }
  await transaction.execute(sql`
    INSERT INTO ${activeRetrievalEvidence} (
      "document_id",
      "embedding_space_id",
      "evidence_content",
      "evidence_id",
      "generation_id",
      "kind",
      "next_retrieval_id",
      "page_number",
      "parent_id",
      "previous_retrieval_id",
      "source_file"
    )
    SELECT DISTINCT ON (
      "embedding_space_id",
      "generation_id",
      CASE
        WHEN "representation_type" = 'exact-window' THEN "id"
        ELSE "parent_id"
      END
    )
      "document_id",
      "embedding_space_id",
      "evidence_content",
      CASE
        WHEN "representation_type" = 'exact-window' THEN "id"
        ELSE "parent_id"
      END,
      "generation_id",
      "kind",
      "next_retrieval_id",
      "page_number",
      "parent_id",
      "previous_retrieval_id",
      "source_file"
    FROM ${retrievalLexicalChunks}
    WHERE "embedding_space_id" = ${input.embeddingSpaceId}
      AND "generation_id" = ${input.generationId}
      AND "document_id" = ${input.documentId}
      AND "source_file" = ${input.sourceFile}
      AND "representation_type" IN ('exact-window', 'image-description')
    ORDER BY
      "embedding_space_id",
      "generation_id",
      CASE
        WHEN "representation_type" = 'exact-window' THEN "id"
        ELSE "parent_id"
      END,
      "id"
  `);
}

async function validateActiveProjection(
  transaction: RetrievalTransaction,
  dimensions: EmbeddingDimensions,
  input: ActiveProjectionInput,
): Promise<void> {
  const routeConditions = and(
    eq(activeRetrievalRoutes.embeddingSpaceId, input.embeddingSpaceId),
    eq(activeRetrievalRoutes.generationId, input.generationId),
    eq(activeRetrievalRoutes.documentId, input.documentId),
    eq(activeRetrievalRoutes.sourceFile, input.sourceFile),
  );
  const routeRows = await transaction
    .select({ value: count() })
    .from(activeRetrievalRoutes)
    .where(routeConditions);
  const routeCount = Number(routeRows[0]?.value ?? 0);
  const activeVectorTable = readActiveRetrievalVectorTable(dimensions);
  const vectorRows = await transaction
    .select({ value: count() })
    .from(activeVectorTable)
    .where(and(
      eq(activeVectorTable.embeddingSpaceId, input.embeddingSpaceId),
      eq(activeVectorTable.generationId, input.generationId),
      eq(activeVectorTable.documentId, input.documentId),
      eq(activeVectorTable.sourceFile, input.sourceFile),
    ));
  const vectorCount = Number(vectorRows[0]?.value ?? 0);
  const lexicalRows = await transaction
    .select({ value: count() })
    .from(activeRetrievalLexicalChunks)
    .where(and(
      eq(activeRetrievalLexicalChunks.embeddingSpaceId, input.embeddingSpaceId),
      eq(activeRetrievalLexicalChunks.generationId, input.generationId),
      eq(activeRetrievalLexicalChunks.documentId, input.documentId),
      eq(activeRetrievalLexicalChunks.sourceFile, input.sourceFile),
    ));
  const lexicalCount = Number(lexicalRows[0]?.value ?? 0);
  const expectedCountRows = await transaction
    .select({ value: count() })
    .from(retrievalLexicalChunks)
    .where(and(
      eq(retrievalLexicalChunks.embeddingSpaceId, input.embeddingSpaceId),
      eq(retrievalLexicalChunks.generationId, input.generationId),
      eq(retrievalLexicalChunks.documentId, input.documentId),
      eq(retrievalLexicalChunks.sourceFile, input.sourceFile),
    ));
  const expectedCount = Number(expectedCountRows[0]?.value ?? 0);
  if (
    expectedCount === 0
    || routeCount !== expectedCount
    || vectorCount !== expectedCount
    || lexicalCount !== expectedCount
  ) {
    throw new Error(
      `Active retrieval projection ${input.generationId} has ${vectorCount} vector, ${lexicalCount} lexical, and ${routeCount} route rows for ${expectedCount} canonical representations.`,
    );
  }
  const expectedEvidenceRows = await transaction
    .select({
      value: sql<number>`count(DISTINCT CASE
        WHEN ${retrievalLexicalChunks.representationType} = 'exact-window'
          THEN ${retrievalLexicalChunks.id}
        WHEN ${retrievalLexicalChunks.representationType} = 'image-description'
          THEN ${retrievalLexicalChunks.parentId}
        ELSE NULL
      END)::integer`,
    })
    .from(retrievalLexicalChunks)
    .where(and(
      eq(retrievalLexicalChunks.embeddingSpaceId, input.embeddingSpaceId),
      eq(retrievalLexicalChunks.generationId, input.generationId),
      eq(retrievalLexicalChunks.documentId, input.documentId),
      eq(retrievalLexicalChunks.sourceFile, input.sourceFile),
    ));
  const evidenceRows = await transaction
    .select({ value: count() })
    .from(activeRetrievalEvidence)
    .where(and(
      eq(activeRetrievalEvidence.embeddingSpaceId, input.embeddingSpaceId),
      eq(activeRetrievalEvidence.generationId, input.generationId),
      eq(activeRetrievalEvidence.documentId, input.documentId),
      eq(activeRetrievalEvidence.sourceFile, input.sourceFile),
    ));
  const expectedEvidenceCount = Number(expectedEvidenceRows[0]?.value ?? 0);
  const evidenceCount = Number(evidenceRows[0]?.value ?? 0);
  if (evidenceCount !== expectedEvidenceCount) {
    throw new Error(
      `Active retrieval projection ${input.generationId} has ${evidenceCount} evidence rows for ${expectedEvidenceCount} citable records.`,
    );
  }
  const unresolvedRouteRows = await transaction
    .select({ value: count() })
    .from(activeRetrievalRoutes)
    .where(and(
      routeConditions,
      notExists(transaction
        .select({ evidenceId: activeRetrievalEvidence.evidenceId })
        .from(activeRetrievalEvidence)
        .where(and(
          eq(
            activeRetrievalEvidence.embeddingSpaceId,
            activeRetrievalRoutes.embeddingSpaceId,
          ),
          eq(
            activeRetrievalEvidence.generationId,
            activeRetrievalRoutes.generationId,
          ),
          eq(
            activeRetrievalEvidence.documentId,
            activeRetrievalRoutes.documentId,
          ),
          eq(
            activeRetrievalEvidence.sourceFile,
            activeRetrievalRoutes.sourceFile,
          ),
          or(
            and(
              eq(activeRetrievalRoutes.evidenceMode, "direct"),
              eq(
                activeRetrievalEvidence.evidenceId,
                activeRetrievalRoutes.evidenceId,
              ),
            ),
            and(
              eq(activeRetrievalRoutes.evidenceMode, "parent-exact"),
              eq(
                activeRetrievalEvidence.parentId,
                activeRetrievalRoutes.parentId,
              ),
            ),
          ),
        ))),
    ));
  const unresolvedRouteCount = Number(unresolvedRouteRows[0]?.value ?? 0);
  if (unresolvedRouteCount !== 0) {
    throw new Error(
      `Active retrieval projection ${input.generationId} has ${unresolvedRouteCount} routes without citable evidence.`,
    );
  }
}
