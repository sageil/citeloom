import { and, count, eq, inArray } from "drizzle-orm";
import { z } from "zod";

import type {
  EmbeddingDimensions,
  EmbeddingSpaceConfig,
} from "../../config/index.js";
import type { CiteLoomDatabase } from "../../database/client.js";
import {
  embeddingSpaces,
  ingestionEmbeddingManifests,
  retrievalChunks384,
  retrievalChunks768,
  retrievalChunks1024,
  retrievalLexicalChunks,
  retrievalTocArtifacts,
} from "../../database/schema.js";
import type {
  RetrievalRepresentation,
} from "../representations.js";
import {
  readEmbeddingInputFormatContract,
  type EmbeddingInputFormatContract,
} from "../../embedding/input-format-model.js";
import {
  createStoredRetrievalWindowPolicyFingerprint,
  storedRetrievalWindowPolicySchema,
} from "../window-policy.js";

export const RETRIEVAL_WRITE_BATCH_SIZE = 500;

const embeddingSpaceRowSchema = z.object({
  dimensions: z.union([z.literal(384), z.literal(768), z.literal(1024)]),
  id: z.string().min(1),
  inputFormatDocumentTemplate: z.string(),
  inputFormatHash: z.string().regex(/^[a-f0-9]{64}$/u),
  inputFormatId: z.uuid(),
  inputFormatQueryTemplate: z.string(),
  inputFormatSchemaVersion: z.number().int().positive(),
  inputFormatName: z.string().trim().min(1),
  model: z.string().min(1),
  retrievalWindowPolicy: storedRetrievalWindowPolicySchema,
  retrievalWindowPolicyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});
const embeddingManifestRowSchema = z.object({
  completed: z.boolean(),
  documentId: z.string().regex(/^[a-f0-9]{64}$/u),
  elementSetId: z.string().regex(/^[a-f0-9]{64}$/u),
  embeddingSpaceId: z.string().min(1),
  exactRepresentationCount: z.number().int().nonnegative(),
  generationId: z.uuid(),
  nextElementPosition: z.number().int().nonnegative(),
  retrievalPolicyFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  descriptionRepresentationCount: z.number().int().nonnegative(),
});

interface RetrievalMetadataInsertRow {
  documentId: string;
  embeddingSpaceId: string;
  evidenceContent: string;
  generationId: string;
  id: string;
  kind: "image" | "table" | "text";
  nextRetrievalId: string | null;
  pageNumber: number | null;
  parentId: string;
  previousRetrievalId: string | null;
  representationType: RetrievalRepresentation["type"];
  sourceFile: string;
}

interface RetrievalInsertRow extends RetrievalMetadataInsertRow {
  content: string;
  embedding: number[];
}

interface RetrievalLexicalInsertRow extends RetrievalMetadataInsertRow {
  content: string;
}

interface RetrievalVectorInsertRow extends RetrievalMetadataInsertRow {
  embedding: number[];
}

interface BuiltRetrievalRows {
  descriptionCount: number;
  exactCount: number;
  rows: RetrievalInsertRow[];
}

export interface EmbeddingGenerationInput {
  documentId: string;
  elementSetId: string;
  generationId: string;
  totalElements: number;
}

export interface EmbeddingGenerationManifest {
  completed: boolean;
  documentId: string;
  elementSetId: string;
  embeddingSpaceId: string;
  exactRepresentationCount: number;
  generationId: string;
  nextElementPosition: number;
  retrievalPolicyFingerprint: string;
  descriptionRepresentationCount: number;
}

export interface PublishableEmbeddingGeneration {
  documentId: string;
  elementSetId: string;
  embeddingSpaceId: string;
  generationId: string;
  totalElements: number;
}

export async function ensureEmbeddingSpace(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
): Promise<void> {
  const existingRows = await database
    .select({
      dimensions: embeddingSpaces.dimensions,
      id: embeddingSpaces.id,
      inputFormatDocumentTemplate:
        embeddingSpaces.inputFormatDocumentTemplate,
      inputFormatHash: embeddingSpaces.inputFormatHash,
      inputFormatId: embeddingSpaces.inputFormatId,
      inputFormatQueryTemplate: embeddingSpaces.inputFormatQueryTemplate,
      inputFormatSchemaVersion: embeddingSpaces.inputFormatSchemaVersion,
      inputFormatName: embeddingSpaces.inputFormatName,
      model: embeddingSpaces.model,
      retrievalWindowPolicy: embeddingSpaces.retrievalWindowPolicy,
      retrievalWindowPolicyFingerprint:
        embeddingSpaces.retrievalWindowPolicyFingerprint,
    })
    .from(embeddingSpaces)
    .where(eq(embeddingSpaces.id, space.id))
    .limit(1);
  const existing = existingRows[0];
  if (existing !== undefined) {
    const result = embeddingSpaceRowSchema.safeParse(existing);
    if (!result.success) {
      throw new Error(`Invalid embedding space row: ${result.error.message}`);
    }
    const storedPolicyFingerprint = createStoredRetrievalWindowPolicyFingerprint(
      result.data.retrievalWindowPolicy,
    );
    if (
      storedPolicyFingerprint
      !== result.data.retrievalWindowPolicyFingerprint
    ) {
      throw new Error(
        `Embedding space ${space.id} has an invalid retrieval-window fingerprint.`,
      );
    }
    const storedInputFormat = readEmbeddingInputFormatContract({
      documentTemplate: result.data.inputFormatDocumentTemplate,
      id: result.data.inputFormatId,
      inputFormatHash: result.data.inputFormatHash,
      name: result.data.inputFormatName,
      queryTemplate: result.data.inputFormatQueryTemplate,
      schemaVersion: result.data.inputFormatSchemaVersion,
    });
    if (
      result.data.dimensions !== space.dimensions
      || result.data.model !== space.model
      || !embeddingInputFormatsMatch(storedInputFormat, space.inputFormat)
      || storedPolicyFingerprint !== space.retrievalWindow.fingerprint
    ) {
      throw new Error(
        `Embedding space ${space.id} is already registered with different settings.`,
      );
    }
    return;
  }

  await database
    .insert(embeddingSpaces)
    .values({
      dimensions: space.dimensions,
      id: space.id,
      inputFormatDocumentTemplate: space.inputFormat.documentTemplate,
      inputFormatHash: space.inputFormat.inputFormatHash,
      inputFormatId: space.inputFormat.id,
      inputFormatQueryTemplate: space.inputFormat.queryTemplate,
      inputFormatSchemaVersion: space.inputFormat.schemaVersion,
      inputFormatName: space.inputFormat.name,
      model: space.model,
      retrievalWindowPolicy: space.retrievalWindow.policy,
      retrievalWindowPolicyFingerprint: space.retrievalWindow.fingerprint,
    })
    .onConflictDoNothing({ target: embeddingSpaces.id });
  await ensureEmbeddingSpace(database, space);
}

function embeddingInputFormatsMatch(
  stored: EmbeddingInputFormatContract,
  selected: EmbeddingInputFormatContract,
): boolean {
  return stored.id === selected.id
    && stored.inputFormatHash === selected.inputFormatHash
    && stored.schemaVersion === selected.schemaVersion
    && stored.documentTemplate === selected.documentTemplate
    && stored.queryTemplate === selected.queryTemplate;
}

export async function beginEmbeddingGeneration(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
  input: EmbeddingGenerationInput,
): Promise<EmbeddingGenerationManifest> {
  if (!Number.isInteger(input.totalElements) || input.totalElements < 1) {
    throw new Error("Embedding generation requires at least one element.");
  }
  const values: typeof ingestionEmbeddingManifests.$inferInsert = {
    completed: false,
    documentId: input.documentId,
    elementSetId: input.elementSetId,
    embeddingSpaceId: space.id,
    exactRepresentationCount: 0,
    generationId: input.generationId,
    nextElementPosition: 0,
    retrievalPolicyFingerprint: space.retrievalWindow.fingerprint,
    descriptionRepresentationCount: 0,
  };
  await database
    .insert(ingestionEmbeddingManifests)
    .values(values)
    .onConflictDoNothing({ target: ingestionEmbeddingManifests.generationId });
  const manifest = await readEmbeddingGenerationManifest(
    database,
    input.generationId,
  );
  assertManifestMatches(manifest, space, input);
  if (manifest.nextElementPosition > input.totalElements) {
    throw new Error(
      `Embedding generation ${input.generationId} advanced beyond its element set.`,
    );
  }
  return manifest;
}

export async function readEmbeddingGenerationManifest(
  database: CiteLoomDatabase,
  generationId: string,
): Promise<EmbeddingGenerationManifest> {
  const rows = await database
    .select({
      completed: ingestionEmbeddingManifests.completed,
      documentId: ingestionEmbeddingManifests.documentId,
      elementSetId: ingestionEmbeddingManifests.elementSetId,
      embeddingSpaceId: ingestionEmbeddingManifests.embeddingSpaceId,
      exactRepresentationCount:
        ingestionEmbeddingManifests.exactRepresentationCount,
      generationId: ingestionEmbeddingManifests.generationId,
      nextElementPosition: ingestionEmbeddingManifests.nextElementPosition,
      retrievalPolicyFingerprint:
        ingestionEmbeddingManifests.retrievalPolicyFingerprint,
      descriptionRepresentationCount:
        ingestionEmbeddingManifests.descriptionRepresentationCount,
    })
    .from(ingestionEmbeddingManifests)
    .where(eq(ingestionEmbeddingManifests.generationId, generationId))
    .limit(1);
  return decodeEmbeddingManifest(rows[0]);
}

export async function stageRetrievalRepresentationBatch(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
  input: EmbeddingGenerationInput,
  expectedStartPosition: number,
  nextElementPosition: number,
  representations: readonly RetrievalRepresentation[],
  embeddings: readonly number[][],
): Promise<EmbeddingGenerationManifest> {
  assertBatchPositions(
    input.totalElements,
    expectedStartPosition,
    nextElementPosition,
  );
  const rows = buildRetrievalRows(
    space,
    input,
    representations,
    embeddings,
  );
  return database.transaction(async (transaction) => {
    const manifestRows = await transaction
      .select()
      .from(ingestionEmbeddingManifests)
      .where(eq(
        ingestionEmbeddingManifests.generationId,
        input.generationId,
      ))
      .limit(1)
      .for("update");
    const manifest = decodeEmbeddingManifest(manifestRows[0]);
    assertManifestMatches(manifest, space, input);
    if (manifest.completed) {
      throw new Error(
        `Embedding generation ${input.generationId} is already complete.`,
      );
    }
    if (manifest.nextElementPosition !== expectedStartPosition) {
      throw new Error(
        `Embedding generation ${input.generationId} expected element ${manifest.nextElementPosition}, not ${expectedStartPosition}.`,
      );
    }

    const vectorTable = readVectorTable(space.dimensions);
    await insertVectorRows(transaction, vectorTable, rows.rows);
    await insertLexicalRows(transaction, rows.rows);

    const completed = nextElementPosition === input.totalElements;
    const updatedRows = await transaction
      .update(ingestionEmbeddingManifests)
      .set({
        completed,
        exactRepresentationCount:
          manifest.exactRepresentationCount + rows.exactCount,
        nextElementPosition,
        descriptionRepresentationCount:
          manifest.descriptionRepresentationCount + rows.descriptionCount,
        updatedAt: new Date(),
      })
      .where(and(
        eq(
          ingestionEmbeddingManifests.generationId,
          input.generationId,
        ),
        eq(
          ingestionEmbeddingManifests.nextElementPosition,
          expectedStartPosition,
        ),
      ))
      .returning();
    return decodeEmbeddingManifest(updatedRows[0]);
  });
}

function buildRetrievalRows(
  space: EmbeddingSpaceConfig,
  input: EmbeddingGenerationInput,
  representations: readonly RetrievalRepresentation[],
  embeddings: readonly number[][],
): BuiltRetrievalRows {
  if (representations.length !== embeddings.length) {
    throw new Error(
      "Retrieval representation and embedding counts differ: "
      + `${representations.length} and ${embeddings.length}.`,
    );
  }
  const rows: RetrievalInsertRow[] = [];
  let descriptionCount = 0;
  let exactCount = 0;
  for (let index = 0; index < representations.length; index += 1) {
    const representation = representations[index];
    const embedding = embeddings[index];
    if (representation === undefined || embedding === undefined) {
      throw new Error(`Missing retrieval data at index ${index}.`);
    }
    if (representation.documentId !== input.documentId) {
      throw new Error("A retrieval batch cannot contain multiple documents.");
    }
    if (
      representation.policyFingerprint !== space.retrievalWindow.fingerprint
      || representation.policyId !== space.retrievalWindow.policy.id
    ) {
      throw new Error(
        `Retrieval representation ${representation.id} is incompatible with embedding space ${space.id}.`,
      );
    }
    assertRepresentationKind(representation);
    const normalizedEmbedding = readEmbedding(
      embedding,
      space.dimensions,
      `embedding ${index + 1}`,
    );
    if (representation.type === "exact-window") {
      exactCount += 1;
    } else {
      descriptionCount += 1;
    }
    rows.push(
      buildRetrievalRow(
        space.id,
        input.generationId,
        representation,
        normalizedEmbedding,
      ),
    );
  }
  return { descriptionCount, exactCount, rows };
}

function assertManifestMatches(
  manifest: EmbeddingGenerationManifest,
  space: EmbeddingSpaceConfig,
  input: EmbeddingGenerationInput,
): void {
  if (
    manifest.documentId !== input.documentId
    || manifest.elementSetId !== input.elementSetId
    || manifest.embeddingSpaceId !== space.id
    || manifest.generationId !== input.generationId
    || manifest.retrievalPolicyFingerprint
      !== space.retrievalWindow.fingerprint
  ) {
    throw new Error(
      `Embedding manifest ${input.generationId} does not match its ingestion job.`,
    );
  }
}

function assertBatchPositions(
  totalElements: number,
  startPosition: number,
  nextPosition: number,
): void {
  if (
    !Number.isInteger(startPosition)
    || !Number.isInteger(nextPosition)
    || startPosition < 0
    || nextPosition <= startPosition
    || nextPosition > totalElements
  ) {
    throw new Error(
      `Invalid embedding element range ${startPosition} to ${nextPosition} of ${totalElements}.`,
    );
  }
}

export function decodeEmbeddingManifest(
  value: unknown,
): EmbeddingGenerationManifest {
  const result = embeddingManifestRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Embedding generation manifest is missing or invalid: ${result.error.message}`,
    );
  }
  return result.data;
}

function assertRepresentationKind(
  representation: RetrievalRepresentation,
): void {
  if (
    representation.type === "exact-window"
    && representation.kind !== "image"
  ) {
    return;
  }
  if (
    representation.type === "table-description"
    && representation.kind === "table"
  ) {
    return;
  }
  if (
    representation.type === "image-description"
    && representation.kind === "image"
  ) {
    return;
  }
  throw new Error(
    `Retrieval representation ${representation.id} has an invalid type or kind.`,
  );
}

export async function deleteDocumentRetrievalRepresentations(
  database: CiteLoomDatabase,
  documentId: string,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await deleteDocumentRetrievalRows(transaction, documentId);
  });
}

export function readEmbedding(
  value: unknown,
  dimensions: EmbeddingDimensions,
  label: string,
): number[] {
  const schema = z
    .array(z.number())
    .length(dimensions)
    .refine((values) => values.some((entry) => entry !== 0));
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid ${label}: expected ${dimensions} finite numbers with at least one nonzero value.`,
    );
  }
  return result.data;
}

export type RetrievalTransaction = Parameters<
  Parameters<CiteLoomDatabase["transaction"]>[0]
>[0];
type RetrievalVectorTable =
  | typeof retrievalChunks384
  | typeof retrievalChunks768
  | typeof retrievalChunks1024;

export async function validateEmbeddingGenerationForPublication(
  transaction: RetrievalTransaction,
  input: PublishableEmbeddingGeneration,
): Promise<EmbeddingGenerationManifest> {
  const manifestRows = await transaction
    .select()
    .from(ingestionEmbeddingManifests)
    .where(eq(
      ingestionEmbeddingManifests.generationId,
      input.generationId,
    ))
    .limit(1)
    .for("update");
  const manifest = decodeEmbeddingManifest(manifestRows[0]);
  if (
    !manifest.completed
    || manifest.documentId !== input.documentId
    || manifest.elementSetId !== input.elementSetId
    || manifest.embeddingSpaceId !== input.embeddingSpaceId
    || manifest.nextElementPosition !== input.totalElements
  ) {
    throw new Error(
      `Embedding generation ${input.generationId} is not complete for publication.`,
    );
  }
  const spaceRows = await transaction
    .select({ dimensions: embeddingSpaces.dimensions })
    .from(embeddingSpaces)
    .where(eq(embeddingSpaces.id, input.embeddingSpaceId))
    .limit(1);
  const dimensions = readEmbeddingDimensions(spaceRows[0]?.dimensions);
  const vectorTable = readVectorTable(dimensions);
  const vectorCount = await countGenerationRows(
    transaction,
    vectorTable,
    input,
  );
  const lexicalCount = await countGenerationRows(
    transaction,
    retrievalLexicalChunks,
    input,
  );
  const expectedRepresentationCount = manifest.exactRepresentationCount
    + manifest.descriptionRepresentationCount;
  if (
    vectorCount !== expectedRepresentationCount
    || lexicalCount !== expectedRepresentationCount
  ) {
    throw new Error(
      `Embedding generation ${input.generationId} has incomplete vector or lexical rows.`,
    );
  }
  return manifest;
}

export async function deleteRetrievalGenerationRows(
  transaction: RetrievalTransaction,
  generationId: string,
): Promise<void> {
  await deleteGenerationRows(
    transaction,
    retrievalChunks384,
    generationId,
  );
  await deleteGenerationRows(
    transaction,
    retrievalChunks768,
    generationId,
  );
  await deleteGenerationRows(
    transaction,
    retrievalChunks1024,
    generationId,
  );
  await deleteGenerationRows(
    transaction,
    retrievalLexicalChunks,
    generationId,
  );
  await transaction
    .delete(retrievalTocArtifacts)
    .where(eq(retrievalTocArtifacts.generationId, generationId));
}

export async function deleteDocumentRetrievalRows(
  transaction: RetrievalTransaction,
  documentId: string,
): Promise<void> {
  while (true) {
    const generationId = await readDocumentRetrievalGeneration(
      transaction,
      documentId,
    );
    if (generationId === null) {
      return;
    }
    await deleteRetrievalGenerationRows(transaction, generationId);
  }
}

async function readDocumentRetrievalGeneration(
  transaction: RetrievalTransaction,
  documentId: string,
): Promise<string | null> {
  const tables: RetrievalTable[] = [
    retrievalChunks384,
    retrievalChunks768,
    retrievalChunks1024,
    retrievalLexicalChunks,
  ];
  for (const table of tables) {
    const rows = await transaction
      .select({ generationId: table.generationId })
      .from(table)
      .where(eq(table.documentId, documentId))
      .limit(1);
    const generationId = rows[0]?.generationId;
    if (generationId !== undefined) {
      return generationId;
    }
  }
  return null;
}

type RetrievalTable =
  | RetrievalVectorTable
  | typeof retrievalLexicalChunks;

async function countGenerationRows(
  transaction: RetrievalTransaction,
  table: RetrievalTable,
  input: PublishableEmbeddingGeneration,
): Promise<number> {
  const rows = await transaction
    .select({ count: count() })
    .from(table)
    .where(and(
      eq(table.embeddingSpaceId, input.embeddingSpaceId),
      eq(table.generationId, input.generationId),
      eq(table.documentId, input.documentId),
    ));
  return rows[0]?.count ?? 0;
}

async function deleteGenerationRows(
  transaction: RetrievalTransaction,
  table: RetrievalTable,
  generationId: string,
): Promise<void> {
  while (true) {
    const rows = await transaction
      .select({ id: table.id })
      .from(table)
      .where(eq(table.generationId, generationId))
      .limit(RETRIEVAL_WRITE_BATCH_SIZE);
    const ids: string[] = [];
    for (const row of rows) {
      ids.push(row.id);
    }
    if (ids.length === 0) {
      return;
    }
    await transaction
      .delete(table)
      .where(and(
        eq(table.generationId, generationId),
        inArray(table.id, ids),
      ));
  }
}

function readEmbeddingDimensions(value: unknown): EmbeddingDimensions {
  const result = z.union([
    z.literal(384),
    z.literal(768),
    z.literal(1024),
  ]).safeParse(value);
  if (!result.success) {
    throw new Error("Embedding generation has an invalid embedding space.");
  }
  return result.data;
}

function readVectorTable(dimensions: EmbeddingDimensions): RetrievalVectorTable {
  if (dimensions === 384) {
    return retrievalChunks384;
  }
  if (dimensions === 768) {
    return retrievalChunks768;
  }
  return retrievalChunks1024;
}

async function insertVectorRows(
  transaction: RetrievalTransaction,
  table: RetrievalVectorTable,
  rows: RetrievalInsertRow[],
): Promise<void> {
  const vectorRows = buildVectorInsertRows(rows);
  for (
    let start = 0;
    start < vectorRows.length;
    start += RETRIEVAL_WRITE_BATCH_SIZE
  ) {
    await transaction
      .insert(table)
      .values(vectorRows.slice(start, start + RETRIEVAL_WRITE_BATCH_SIZE));
  }
}

async function insertLexicalRows(
  transaction: RetrievalTransaction,
  rows: RetrievalInsertRow[],
): Promise<void> {
  const lexicalRows = buildLexicalInsertRows(rows);
  for (
    let start = 0;
    start < lexicalRows.length;
    start += RETRIEVAL_WRITE_BATCH_SIZE
  ) {
    await transaction
      .insert(retrievalLexicalChunks)
      .values(lexicalRows.slice(start, start + RETRIEVAL_WRITE_BATCH_SIZE));
  }
}

function buildRetrievalRow(
  embeddingSpaceId: string,
  generationId: string,
  representation: RetrievalRepresentation,
  embedding: number[],
): RetrievalInsertRow {
  if (
    representation.type === "exact-window"
    && representation.parentOrdinal === null
  ) {
    throw new Error(
      `Exact retrieval representation ${representation.id} has no parent ordinal.`,
    );
  }
  return {
    content: representation.embeddingText,
    documentId: representation.documentId,
    embedding,
    embeddingSpaceId,
    evidenceContent: representation.content,
    generationId,
    id: representation.id,
    kind: representation.kind,
    nextRetrievalId: representation.nextRetrievalId,
    pageNumber: representation.pageNumber,
    parentId: representation.parentId,
    previousRetrievalId: representation.previousRetrievalId,
    representationType: representation.type,
    sourceFile: representation.sourceFile,
  };
}

function buildVectorInsertRows(
  rows: RetrievalInsertRow[],
): RetrievalVectorInsertRow[] {
  const vectorRows: RetrievalVectorInsertRow[] = [];
  for (const row of rows) {
    const metadata = buildRetrievalMetadataInsertRow(row);
    vectorRows.push({ ...metadata, embedding: row.embedding });
  }
  return vectorRows;
}

function buildLexicalInsertRows(
  rows: RetrievalInsertRow[],
): RetrievalLexicalInsertRow[] {
  const lexicalRows: RetrievalLexicalInsertRow[] = [];
  for (const row of rows) {
    const metadata = buildRetrievalMetadataInsertRow(row);
    lexicalRows.push({ ...metadata, content: row.content });
  }
  return lexicalRows;
}

function buildRetrievalMetadataInsertRow(
  row: RetrievalInsertRow,
): RetrievalMetadataInsertRow {
  return {
    documentId: row.documentId,
    embeddingSpaceId: row.embeddingSpaceId,
    evidenceContent: row.evidenceContent,
    generationId: row.generationId,
    id: row.id,
    kind: row.kind,
    nextRetrievalId: row.nextRetrievalId,
    pageNumber: row.pageNumber,
    parentId: row.parentId,
    previousRetrievalId: row.previousRetrievalId,
    representationType: row.representationType,
    sourceFile: row.sourceFile,
  };
}
