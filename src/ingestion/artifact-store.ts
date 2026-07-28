import { and, asc, eq, gte, inArray, lt, ne } from "drizzle-orm";
import { z } from "zod";

import type { CiteLoomDatabase } from "../database/client.js";
import {
  doclingArtifacts,
  retrievalDescriptionArtifacts,
} from "../database/schema.js";
import type { StoredDoclingArtifact } from "../docling/protocol/index.js";
import {
  imageRetrievalDescriptionResultSchema,
  tableRetrievalDescriptionResultSchema,
  type RetrievalDescriptionRecord,
} from "../domain/retrieval-descriptions.js";
import {
  contentIdSchema,
  sourceRegionSchema,
} from "../domain/validation.js";

const retrievalDescriptionBaseShape = {
  documentId: contentIdSchema,
  id: z.string().regex(/^[a-f0-9]{64}-description$/u),
  inputFingerprint: contentIdSchema,
  pageNumber: z.number().int().positive().nullable(),
  pageNumbers: z.array(z.number().int().positive()),
  parentId: contentIdSchema,
  regions: z.array(sourceRegionSchema),
  sectionPath: z.array(z.string().trim().min(1)),
  sourceFile: z.string().trim().min(1),
  sourceRefs: z.array(z.string().trim().min(1)).min(1),
};

const retrievalDescriptionRecordSchema = z.discriminatedUnion("kind", [
  z.object({
    ...retrievalDescriptionBaseShape,
    kind: z.literal("table"),
    result: tableRetrievalDescriptionResultSchema,
  }).strict(),
  z.object({
    ...retrievalDescriptionBaseShape,
    kind: z.literal("image"),
    result: imageRetrievalDescriptionResultSchema,
  }).strict(),
]);

const retrievalDescriptionRowSchema = z.object({
  description: retrievalDescriptionRecordSchema,
  position: z.number().int().nonnegative(),
}).strict();

export interface RetrievalDescriptionCheckpoint {
  description: RetrievalDescriptionRecord;
  position: number;
}

export class IngestionArtifactStore {
  public constructor(private readonly database: CiteLoomDatabase) {}

  public async writeDoclingArtifact(
    artifact: StoredDoclingArtifact,
  ): Promise<void> {
    const documentId = readDocumentId(artifact.documentId);
    if (
      artifact.processingTimeMs < 0
      || !Number.isInteger(artifact.processingTimeMs)
    ) {
      throw new Error("Invalid Docling artifact processing time.");
    }
    const row: typeof doclingArtifacts.$inferInsert = {
      artifact,
      documentId,
      processingTimeMs: artifact.processingTimeMs,
    };
    await this.database.insert(doclingArtifacts).values(row).onConflictDoUpdate({
      set: row,
      target: doclingArtifacts.documentId,
    });
  }

  public async writeRetrievalDescription(
    generationId: string,
    documentId: string,
    position: number,
    description: RetrievalDescriptionRecord,
  ): Promise<void> {
    const normalizedDocumentId = readDocumentId(documentId);
    const normalizedGenerationId = readGenerationId(generationId);
    const normalizedPosition = readPosition(position);
    const normalizedDescription = decodeRetrievalDescriptionRecord(description);
    if (normalizedDescription.documentId !== normalizedDocumentId) {
      throw new Error(
        `Retrieval description at position ${position} belongs to another document.`,
      );
    }
    const row: typeof retrievalDescriptionArtifacts.$inferInsert = {
      description: normalizedDescription,
      documentId: normalizedDocumentId,
      generationId: normalizedGenerationId,
      id: normalizedDescription.id,
      position: normalizedPosition,
    };
    await this.database
      .insert(retrievalDescriptionArtifacts)
      .values(row)
      .onConflictDoUpdate({
        set: row,
        target: [
          retrievalDescriptionArtifacts.generationId,
          retrievalDescriptionArtifacts.id,
        ],
      });
  }

  public async readRetrievalDescriptionCheckpoints(
    generationId: string,
    startPosition: number,
    limit: number,
  ): Promise<RetrievalDescriptionCheckpoint[]> {
    const normalizedGenerationId = readGenerationId(generationId);
    const normalizedStart = readPosition(startPosition);
    const normalizedLimit = readLimit(limit);
    const rows = await this.database
      .select({
        description: retrievalDescriptionArtifacts.description,
        position: retrievalDescriptionArtifacts.position,
      })
      .from(retrievalDescriptionArtifacts)
      .where(and(
        eq(
          retrievalDescriptionArtifacts.generationId,
          normalizedGenerationId,
        ),
        gte(retrievalDescriptionArtifacts.position, normalizedStart),
        lt(
          retrievalDescriptionArtifacts.position,
          normalizedStart + normalizedLimit,
        ),
      ))
      .orderBy(asc(retrievalDescriptionArtifacts.position))
      .limit(normalizedLimit);
    return decodeRetrievalDescriptionRows(rows, "retrieval description");
  }

  public async readReusableRetrievalDescriptions(
    documentId: string,
    generationId: string,
    elementId: string,
  ): Promise<RetrievalDescriptionCheckpoint[]> {
    const normalizedDocumentId = readDocumentId(documentId);
    const normalizedGenerationId = readGenerationId(generationId);
    const normalizedElementId = readDocumentId(elementId);
    const rows = await this.database
      .select({
        description: retrievalDescriptionArtifacts.description,
        position: retrievalDescriptionArtifacts.position,
      })
      .from(retrievalDescriptionArtifacts)
      .where(and(
        eq(retrievalDescriptionArtifacts.documentId, normalizedDocumentId),
        eq(
          retrievalDescriptionArtifacts.id,
          `${normalizedElementId}-description`,
        ),
        ne(
          retrievalDescriptionArtifacts.generationId,
          normalizedGenerationId,
        ),
      ))
      .orderBy(asc(retrievalDescriptionArtifacts.generationId))
      .limit(500);
    return decodeRetrievalDescriptionRows(
      rows,
      "reusable retrieval description",
    );
  }

  public async deleteTemporaryGeneration(
    generationId: string,
  ): Promise<void> {
    const normalizedGenerationId = readGenerationId(generationId);
    await this.database.transaction(async (transaction) => {
      await deleteRetrievalDescriptionGenerationRows(
        transaction,
        normalizedGenerationId,
      );
    });
  }

  public async deleteDocument(documentId: string): Promise<void> {
    const normalizedDocumentId = readDocumentId(documentId);
    await this.database.transaction(async (transaction) => {
      await deleteTemporaryDocumentIngestionArtifacts(
        transaction,
        normalizedDocumentId,
      );
      await deletePermanentDocumentIngestionArtifacts(
        transaction,
        normalizedDocumentId,
      );
    });
  }
}

export type IngestionArtifactTransaction = Parameters<
  Parameters<CiteLoomDatabase["transaction"]>[0]
>[0];

const ARTIFACT_DELETE_BATCH_SIZE = 500;

export async function deleteTemporaryRetrievalDescriptionGeneration(
  transaction: IngestionArtifactTransaction,
  generationId: string,
): Promise<void> {
  await deleteRetrievalDescriptionGenerationRows(transaction, generationId);
}

export async function deleteTemporaryDocumentIngestionArtifacts(
  transaction: IngestionArtifactTransaction,
  documentId: string,
): Promise<void> {
  while (true) {
    const rows = await transaction
      .select({ generationId: retrievalDescriptionArtifacts.generationId })
      .from(retrievalDescriptionArtifacts)
      .where(eq(retrievalDescriptionArtifacts.documentId, documentId))
      .limit(1);
    const generationId = rows[0]?.generationId;
    if (generationId === undefined) {
      return;
    }
    await deleteRetrievalDescriptionGenerationRows(transaction, generationId);
  }
}

export async function deletePermanentDocumentIngestionArtifacts(
  transaction: IngestionArtifactTransaction,
  documentId: string,
): Promise<void> {
  await transaction
    .delete(doclingArtifacts)
    .where(eq(doclingArtifacts.documentId, documentId));
}

export function decodeRetrievalDescriptionRecord(
  value: unknown,
): RetrievalDescriptionRecord {
  const result = retrievalDescriptionRecordSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid retrieval description row: ${result.error.message}`,
    );
  }
  return result.data;
}

async function deleteRetrievalDescriptionGenerationRows(
  transaction: IngestionArtifactTransaction,
  generationId: string,
): Promise<void> {
  while (true) {
    const rows = await transaction
      .select({ id: retrievalDescriptionArtifacts.id })
      .from(retrievalDescriptionArtifacts)
      .where(eq(retrievalDescriptionArtifacts.generationId, generationId))
      .limit(ARTIFACT_DELETE_BATCH_SIZE);
    const ids = rows.map((row) => row.id);
    if (ids.length === 0) {
      return;
    }
    await transaction
      .delete(retrievalDescriptionArtifacts)
      .where(and(
        eq(retrievalDescriptionArtifacts.generationId, generationId),
        inArray(retrievalDescriptionArtifacts.id, ids),
      ));
  }
}

function decodeRetrievalDescriptionRows(
  rows: unknown[],
  label: string,
): RetrievalDescriptionCheckpoint[] {
  const checkpoints: RetrievalDescriptionCheckpoint[] = [];
  for (const row of rows) {
    const result = retrievalDescriptionRowSchema.safeParse(row);
    if (!result.success) {
      throw new Error(`Invalid ${label} row: ${result.error.message}`);
    }
    checkpoints.push(result.data);
  }
  return checkpoints;
}

function readDocumentId(value: string): string {
  const result = contentIdSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid document id: ${value}`);
  }
  return result.data;
}

function readGenerationId(value: string): string {
  const result = z.uuid().safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid ingestion generation id: ${value}`);
  }
  return result.data;
}

function readPosition(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ingestion artifact position: ${value}.`);
  }
  return value;
}

function readLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 500) {
    throw new Error(`Invalid ingestion artifact limit: ${value}.`);
  }
  return value;
}
