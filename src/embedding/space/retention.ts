import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import type { CiteLoomDatabase } from "../../database/client.js";
import {
  embeddingSpaceGcRuns,
  embeddingSpaceGcSpaces,
  embeddingSpacePins,
  embeddingSpaces,
  indexedDocumentSpaces,
  ingestionJobs,
  retrievalLexicalChunks,
  retrievalTocArtifacts,
} from "../../database/schema.js";
import {
  embeddingDimensionsSchema,
  type EmbeddingDimensions,
} from "../dimensions.js";
import { RETRIEVAL_VECTOR_TABLES } from "../storage-tables.js";
import type {
  EmbeddingSpaceGcReport,
  EmbeddingSpaceGcSpaceRecord,
  EmbeddingSpaceProtectionKind,
  EmbeddingSpaceRowCounts,
} from "./types.js";

const protectionKindSchema = z.enum([
  "active",
  "job-reference",
  "pinned",
  "retention-window",
]);
const gcModeSchema = z.enum(["apply", "dry-run"]);
const gcRunStatusSchema = z.enum(["completed", "failed", "running"]);
const gcSpaceStateSchema = z.enum([
  "deleted",
  "failed",
  "planned",
  "protected",
]);
const rowCountsSchema = z.object({
  indexedDocuments: z.number().int().nonnegative(),
  lexicalChunks: z.number().int().nonnegative(),
  vectorChunks1024: z.number().int().nonnegative(),
  vectorChunks1536: z.number().int().nonnegative(),
  vectorChunks2048: z.number().int().nonnegative(),
  vectorChunks384: z.number().int().nonnegative(),
  vectorChunks768: z.number().int().nonnegative(),
});
const bigintBoundarySchema = z.union([
  z.bigint().nonnegative(),
  z.string().regex(/^(0|[1-9][0-9]*)$/).transform((value) => BigInt(value)),
]);
const dateBoundarySchema = z.union([
  z.date(),
  z.string().min(1).transform((value, context) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      context.addIssue({ code: "custom", message: "Invalid database timestamp." });
      return z.NEVER;
    }
    return date;
  }),
]);
const spaceStatisticsRowSchema = z.object({
  createdAt: dateBoundarySchema,
  dimensions: embeddingDimensionsSchema,
  estimatedBytes: bigintBoundarySchema,
  hasJobReference: z.boolean(),
  indexedDocuments: bigintBoundarySchema,
  inputFormatHash: z.string().regex(/^[a-f0-9]{64}$/u),
  inputFormatName: z.string().trim().min(1),
  lexicalChunks: bigintBoundarySchema,
  model: z.string().min(1),
  pinReason: z.string().min(1).nullable(),
  spaceId: z.string().min(1),
  vectorChunks1024: bigintBoundarySchema,
  vectorChunks1536: bigintBoundarySchema,
  vectorChunks2048: bigintBoundarySchema,
  vectorChunks384: bigintBoundarySchema,
  vectorChunks768: bigintBoundarySchema,
});
const gcRunRowSchema = z.object({
  activeSpaceId: z.string().min(1),
  completedAt: z.date().nullable(),
  errorMessage: z.string().nullable(),
  id: z.uuid(),
  mode: gcModeSchema,
  retentionCutoff: z.date(),
  startedAt: z.date(),
  status: gcRunStatusSchema,
});
const gcSpaceRowSchema = z.object({
  createdAt: z.date(),
  dimensions: embeddingDimensionsSchema,
  disposition: z.enum(["deletable", "protected"]),
  errorMessage: z.string().nullable(),
  estimatedBytes: bigintBoundarySchema,
  inputFormatHash: z.string().regex(/^[a-f0-9]{64}$/u),
  inputFormatName: z.string().trim().min(1),
  model: z.string().min(1),
  protectionDetail: z.string().nullable(),
  protectionKind: protectionKindSchema.nullable(),
  rowCounts: rowCountsSchema,
  spaceId: z.string().min(1),
  state: gcSpaceStateSchema,
});

export type EmbeddingSpaceGcRequest =
  | {
    activeSpaceId: string;
    mode: "apply" | "dry-run";
    retentionDays: number;
  }
  | {
    activeSpaceId: string;
    mode: "resume";
    runId: string;
  };

interface SpaceStatistics {
  createdAt: Date;
  dimensions: EmbeddingDimensions;
  estimatedBytes: bigint;
  hasJobReference: boolean;
  inputFormatHash: string;
  inputFormatName: string;
  model: string;
  pinReason: string | null;
  rowCounts: EmbeddingSpaceRowCounts;
  spaceId: string;
}

interface SpaceProtection {
  detail: string;
  kind: EmbeddingSpaceProtectionKind;
}

interface StoredGcRun {
  activeSpaceId: string;
  id: string;
  mode: "apply" | "dry-run";
  retentionCutoff: Date;
  status: "completed" | "failed" | "running";
}

export async function pinEmbeddingSpace(
  database: CiteLoomDatabase,
  spaceId: string,
  reason: string,
): Promise<void> {
  await database.transaction(async (transaction) => {
    const rows = await transaction
      .select({ id: embeddingSpaces.id })
      .from(embeddingSpaces)
      .where(eq(embeddingSpaces.id, spaceId))
      .limit(1)
      .for("update");
    if (rows.length !== 1) {
      throw new Error(`Embedding space does not exist: ${spaceId}.`);
    }
    await transaction.insert(embeddingSpacePins).values({
      reason,
      spaceId,
    }).onConflictDoUpdate({
      set: { createdAt: new Date(), reason },
      target: embeddingSpacePins.spaceId,
    });
  });
}

export async function unpinEmbeddingSpace(
  database: CiteLoomDatabase,
  spaceId: string,
): Promise<boolean> {
  return database.transaction(async (transaction) => {
    await transaction
      .select({ id: embeddingSpaces.id })
      .from(embeddingSpaces)
      .where(eq(embeddingSpaces.id, spaceId))
      .limit(1)
      .for("update");
    const deleted = await transaction
      .delete(embeddingSpacePins)
      .where(eq(embeddingSpacePins.spaceId, spaceId))
      .returning({ spaceId: embeddingSpacePins.spaceId });
    return deleted.length === 1;
  });
}

export async function runEmbeddingSpaceGarbageCollection(
  database: CiteLoomDatabase,
  request: EmbeddingSpaceGcRequest,
  currentTime: Date = new Date(),
): Promise<EmbeddingSpaceGcReport> {
  if (request.mode === "resume") {
    const run = await readStoredGcRun(database, request.runId);
    if (run.mode !== "apply") {
      throw new Error("Only an apply garbage-collection run can be resumed.");
    }
    if (run.status === "completed") {
      return readEmbeddingSpaceGcReport(database, run.id);
    }
    await database
      .update(embeddingSpaceGcRuns)
      .set({ completedAt: null, errorMessage: null, status: "running" })
      .where(eq(embeddingSpaceGcRuns.id, run.id));
    await database
      .update(embeddingSpaceGcSpaces)
      .set({ completedAt: null, errorMessage: null, state: "planned" })
      .where(and(
        eq(embeddingSpaceGcSpaces.runId, run.id),
        eq(embeddingSpaceGcSpaces.state, "failed"),
      ));
    await applyGarbageCollectionRun(
      database,
      run,
      request.activeSpaceId,
      currentTime,
    );
    return readEmbeddingSpaceGcReport(database, run.id);
  }

  if (!Number.isInteger(request.retentionDays) || request.retentionDays < 0) {
    throw new Error("Embedding-space retention days must be a nonnegative integer.");
  }
  const retentionCutoff = new Date(
    currentTime.getTime() - request.retentionDays * 24 * 60 * 60 * 1_000,
  );
  const run = await createGarbageCollectionRun(
    database,
    request.activeSpaceId,
    request.mode,
    retentionCutoff,
    currentTime,
  );
  if (request.mode === "apply") {
    await applyGarbageCollectionRun(
      database,
      run,
      request.activeSpaceId,
      currentTime,
    );
  }
  return readEmbeddingSpaceGcReport(database, run.id);
}

export async function readEmbeddingSpaceGcReport(
  database: CiteLoomDatabase,
  runId: string,
): Promise<EmbeddingSpaceGcReport> {
  const runRows = await database
    .select()
    .from(embeddingSpaceGcRuns)
    .where(eq(embeddingSpaceGcRuns.id, runId))
    .limit(1);
  const run = decodeGcRunRow(runRows[0]);
  const spaceRows = await database
    .select({
      createdAt: embeddingSpaceGcSpaces.createdAt,
      dimensions: embeddingSpaceGcSpaces.dimensions,
      disposition: embeddingSpaceGcSpaces.disposition,
      errorMessage: embeddingSpaceGcSpaces.errorMessage,
      estimatedBytes: embeddingSpaceGcSpaces.estimatedBytes,
      inputFormatHash: embeddingSpaceGcSpaces.inputFormatHash,
      inputFormatName: embeddingSpaceGcSpaces.inputFormatName,
      model: embeddingSpaceGcSpaces.model,
      protectionDetail: embeddingSpaceGcSpaces.protectionDetail,
      protectionKind: embeddingSpaceGcSpaces.protectionKind,
      rowCounts: embeddingSpaceGcSpaces.rowCounts,
      spaceId: embeddingSpaceGcSpaces.spaceId,
      state: embeddingSpaceGcSpaces.state,
    })
    .from(embeddingSpaceGcSpaces)
    .where(eq(embeddingSpaceGcSpaces.runId, runId))
    .orderBy(asc(embeddingSpaceGcSpaces.spaceId));
  const spaces: EmbeddingSpaceGcSpaceRecord[] = [];
  for (const row of spaceRows) {
    spaces.push(decodeGcSpaceRecord(row));
  }
  return {
    activeSpaceId: run.activeSpaceId,
    completedAt: run.completedAt?.toISOString() ?? null,
    errorMessage: run.errorMessage,
    id: run.id,
    mode: run.mode,
    retentionCutoff: run.retentionCutoff.toISOString(),
    spaces,
    startedAt: run.startedAt.toISOString(),
    status: run.status,
  };
}

async function createGarbageCollectionRun(
  database: CiteLoomDatabase,
  activeSpaceId: string,
  mode: "apply" | "dry-run",
  retentionCutoff: Date,
  currentTime: Date,
): Promise<StoredGcRun> {
  const statistics = await readSpaceStatistics(database);
  if (!statistics.some((space) => space.spaceId === activeSpaceId)) {
    throw new Error(
      `The active embedding space is not registered: ${activeSpaceId}.`,
    );
  }
  const runId = randomUUID();
  const completedAt = mode === "dry-run" ? currentTime : null;
  const status = mode === "dry-run" ? "completed" : "running";
  await database.transaction(async (transaction) => {
    await transaction.insert(embeddingSpaceGcRuns).values({
      activeSpaceId,
      completedAt,
      errorMessage: null,
      id: runId,
      mode,
      retentionCutoff,
      startedAt: currentTime,
      status,
    });
    const spaceRows: Array<typeof embeddingSpaceGcSpaces.$inferInsert> = [];
    for (const space of statistics) {
      const protection = readSpaceProtection(
        space,
        activeSpaceId,
        retentionCutoff,
      );
      spaceRows.push({
        completedAt,
        createdAt: space.createdAt,
        dimensions: space.dimensions,
        disposition: protection === null ? "deletable" : "protected",
        errorMessage: null,
        estimatedBytes: space.estimatedBytes,
        inputFormatHash: space.inputFormatHash,
        inputFormatName: space.inputFormatName,
        legacyProfile: space.inputFormatName,
        model: space.model,
        protectionDetail: protection?.detail ?? null,
        protectionKind: protection?.kind ?? null,
        rowCounts: space.rowCounts,
        runId,
        spaceId: space.spaceId,
        state: protection === null ? "planned" : "protected",
      });
    }
    if (spaceRows.length > 0) {
      await transaction.insert(embeddingSpaceGcSpaces).values(spaceRows);
    }
  });
  return { activeSpaceId, id: runId, mode, retentionCutoff, status };
}

async function applyGarbageCollectionRun(
  database: CiteLoomDatabase,
  run: StoredGcRun,
  activeSpaceId: string,
  currentTime: Date,
): Promise<void> {
  const rows = await database
    .select({ spaceId: embeddingSpaceGcSpaces.spaceId })
    .from(embeddingSpaceGcSpaces)
    .where(and(
      eq(embeddingSpaceGcSpaces.runId, run.id),
      inArray(embeddingSpaceGcSpaces.state, ["planned", "failed"]),
    ))
    .orderBy(asc(embeddingSpaceGcSpaces.spaceId));
  try {
    for (const row of rows) {
      await collectEmbeddingSpace(
        database,
        run,
        activeSpaceId,
        row.spaceId,
        currentTime,
      );
    }
    await database
      .update(embeddingSpaceGcRuns)
      .set({ completedAt: currentTime, errorMessage: null, status: "completed" })
      .where(eq(embeddingSpaceGcRuns.id, run.id));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await database
      .update(embeddingSpaceGcRuns)
      .set({ completedAt: currentTime, errorMessage: message, status: "failed" })
      .where(eq(embeddingSpaceGcRuns.id, run.id));
    throw error;
  }
}

async function collectEmbeddingSpace(
  database: CiteLoomDatabase,
  run: StoredGcRun,
  activeSpaceId: string,
  spaceId: string,
  currentTime: Date,
): Promise<void> {
  try {
    await database.transaction(async (transaction) => {
      await transaction.execute(
        sql`LOCK TABLE "ingestion_jobs" IN SHARE ROW EXCLUSIVE MODE`,
      );
      const spaceRows = await transaction
        .select({
          createdAt: embeddingSpaces.createdAt,
          id: embeddingSpaces.id,
        })
        .from(embeddingSpaces)
        .where(eq(embeddingSpaces.id, spaceId))
        .limit(1)
        .for("update");
      const space = spaceRows[0];
      if (space !== undefined) {
        const protection = await readTransactionalProtection(
          transaction,
          space.id,
          space.createdAt,
          activeSpaceId,
          run.retentionCutoff,
        );
        if (protection !== null) {
          await transaction
            .update(embeddingSpaceGcSpaces)
            .set({
              completedAt: currentTime,
              disposition: "protected",
              errorMessage: null,
              protectionDetail: protection.detail,
              protectionKind: protection.kind,
              state: "protected",
            })
            .where(and(
              eq(embeddingSpaceGcSpaces.runId, run.id),
              eq(embeddingSpaceGcSpaces.spaceId, spaceId),
            ));
          return;
        }
      }
      for (const table of RETRIEVAL_VECTOR_TABLES) {
        await transaction
          .delete(table)
          .where(eq(table.embeddingSpaceId, spaceId));
      }
      await transaction
        .delete(retrievalLexicalChunks)
        .where(eq(retrievalLexicalChunks.embeddingSpaceId, spaceId));
      const retiredGenerations = transaction
        .select({ generationId: indexedDocumentSpaces.generationId })
        .from(indexedDocumentSpaces)
        .where(eq(indexedDocumentSpaces.embeddingSpaceId, spaceId));
      await transaction
        .delete(retrievalTocArtifacts)
        .where(inArray(retrievalTocArtifacts.generationId, retiredGenerations));
      await transaction
        .delete(indexedDocumentSpaces)
        .where(eq(indexedDocumentSpaces.embeddingSpaceId, spaceId));
      await transaction
        .delete(embeddingSpaces)
        .where(eq(embeddingSpaces.id, spaceId));
      await transaction
        .update(embeddingSpaceGcSpaces)
        .set({
          completedAt: currentTime,
          errorMessage: null,
          state: "deleted",
        })
        .where(and(
          eq(embeddingSpaceGcSpaces.runId, run.id),
          eq(embeddingSpaceGcSpaces.spaceId, spaceId),
        ));
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    await database
      .update(embeddingSpaceGcSpaces)
      .set({ completedAt: currentTime, errorMessage: message, state: "failed" })
      .where(and(
        eq(embeddingSpaceGcSpaces.runId, run.id),
        eq(embeddingSpaceGcSpaces.spaceId, spaceId),
      ));
    throw error;
  }
}

async function readTransactionalProtection(
  transaction: Parameters<Parameters<CiteLoomDatabase["transaction"]>[0]>[0],
  spaceId: string,
  createdAt: Date,
  activeSpaceId: string,
  retentionCutoff: Date,
): Promise<SpaceProtection | null> {
  if (spaceId === activeSpaceId) {
    return { detail: "Current effective application embedding space.", kind: "active" };
  }
  const pinRows = await transaction
    .select({ reason: embeddingSpacePins.reason })
    .from(embeddingSpacePins)
    .where(eq(embeddingSpacePins.spaceId, spaceId))
    .limit(1);
  const pin = pinRows[0];
  if (pin !== undefined) {
    return { detail: pin.reason, kind: "pinned" };
  }
  const jobRows = await transaction
    .select({ sourceFile: ingestionJobs.sourceFile })
    .from(ingestionJobs)
    .where(eq(ingestionJobs.embeddingSpaceId, spaceId))
    .limit(1);
  const job = jobRows[0];
  if (job !== undefined) {
    return { detail: job.sourceFile, kind: "job-reference" };
  }
  if (createdAt >= retentionCutoff) {
    return {
      detail: `Created at ${createdAt.toISOString()}.`,
      kind: "retention-window",
    };
  }
  return null;
}

async function readSpaceStatistics(
  database: CiteLoomDatabase,
): Promise<SpaceStatistics[]> {
  const result = await database.execute(sql`
    SELECT
      space."id" AS "spaceId",
      space."created_at" AS "createdAt",
      space."dimensions" AS "dimensions",
      space."input_format_hash" AS "inputFormatHash",
      input_format."name" AS "inputFormatName",
      space."model" AS "model",
      pin."reason" AS "pinReason",
      EXISTS (
        SELECT 1 FROM "ingestion_jobs" job
        WHERE job."embedding_space_id" = space."id"
      ) AS "hasJobReference",
      (SELECT count(*) FROM "retrieval_chunks_384" chunk WHERE chunk."embedding_space_id" = space."id") AS "vectorChunks384",
      (SELECT count(*) FROM "retrieval_chunks" chunk WHERE chunk."embedding_space_id" = space."id") AS "vectorChunks768",
      (SELECT count(*) FROM "retrieval_chunks_1024" chunk WHERE chunk."embedding_space_id" = space."id") AS "vectorChunks1024",
      (SELECT count(*) FROM "retrieval_chunks_1536" chunk WHERE chunk."embedding_space_id" = space."id") AS "vectorChunks1536",
      (SELECT count(*) FROM "retrieval_chunks_2048" chunk WHERE chunk."embedding_space_id" = space."id") AS "vectorChunks2048",
      (SELECT count(*) FROM "retrieval_lexical_chunks" chunk WHERE chunk."embedding_space_id" = space."id") AS "lexicalChunks",
      (SELECT count(*) FROM "indexed_document_spaces" document_space WHERE document_space."embedding_space_id" = space."id") AS "indexedDocuments",
      (
        pg_column_size(space)::bigint
        + COALESCE((SELECT sum(pg_column_size(chunk)) FROM "retrieval_chunks_384" chunk WHERE chunk."embedding_space_id" = space."id"), 0)
        + COALESCE((SELECT sum(pg_column_size(chunk)) FROM "retrieval_chunks" chunk WHERE chunk."embedding_space_id" = space."id"), 0)
        + COALESCE((SELECT sum(pg_column_size(chunk)) FROM "retrieval_chunks_1024" chunk WHERE chunk."embedding_space_id" = space."id"), 0)
        + COALESCE((SELECT sum(pg_column_size(chunk)) FROM "retrieval_chunks_1536" chunk WHERE chunk."embedding_space_id" = space."id"), 0)
        + COALESCE((SELECT sum(pg_column_size(chunk)) FROM "retrieval_chunks_2048" chunk WHERE chunk."embedding_space_id" = space."id"), 0)
        + COALESCE((SELECT sum(pg_column_size(chunk)) FROM "retrieval_lexical_chunks" chunk WHERE chunk."embedding_space_id" = space."id"), 0)
        + COALESCE((SELECT sum(pg_column_size(document_space)) FROM "indexed_document_spaces" document_space WHERE document_space."embedding_space_id" = space."id"), 0)
      )::bigint AS "estimatedBytes"
    FROM "embedding_spaces" space
    INNER JOIN "embedding_input_formats" input_format
      ON input_format."id" = space."input_format_id"
    LEFT JOIN "embedding_space_pins" pin ON pin."space_id" = space."id"
    ORDER BY space."id"
  `);
  const statistics: SpaceStatistics[] = [];
  for (const row of result.rows) {
    const decoded = decodeSpaceStatisticsRow(row);
    statistics.push(decoded);
  }
  return statistics;
}

function decodeSpaceStatisticsRow(row: unknown): SpaceStatistics {
  const result = spaceStatisticsRowSchema.safeParse(row);
  if (!result.success) {
    throw new Error(`Embedding-space statistics row is invalid: ${result.error.message}`);
  }
  return {
    createdAt: result.data.createdAt,
    dimensions: result.data.dimensions,
    estimatedBytes: result.data.estimatedBytes,
    hasJobReference: result.data.hasJobReference,
    inputFormatHash: result.data.inputFormatHash,
    inputFormatName: result.data.inputFormatName,
    model: result.data.model,
    pinReason: result.data.pinReason,
    rowCounts: {
      indexedDocuments: readSafeCount(result.data.indexedDocuments),
      lexicalChunks: readSafeCount(result.data.lexicalChunks),
      vectorChunks1024: readSafeCount(result.data.vectorChunks1024),
      vectorChunks1536: readSafeCount(result.data.vectorChunks1536),
      vectorChunks2048: readSafeCount(result.data.vectorChunks2048),
      vectorChunks384: readSafeCount(result.data.vectorChunks384),
      vectorChunks768: readSafeCount(result.data.vectorChunks768),
    },
    spaceId: result.data.spaceId,
  };
}

function readSpaceProtection(
  space: SpaceStatistics,
  activeSpaceId: string,
  retentionCutoff: Date,
): SpaceProtection | null {
  if (space.spaceId === activeSpaceId) {
    return { detail: "Current effective application embedding space.", kind: "active" };
  }
  if (space.pinReason !== null) {
    return { detail: space.pinReason, kind: "pinned" };
  }
  if (space.hasJobReference) {
    return {
      detail: "An ingestion job references this embedding space.",
      kind: "job-reference",
    };
  }
  if (space.createdAt >= retentionCutoff) {
    return {
      detail: `Created at ${space.createdAt.toISOString()}.`,
      kind: "retention-window",
    };
  }
  return null;
}

async function readStoredGcRun(
  database: CiteLoomDatabase,
  runId: string,
): Promise<StoredGcRun> {
  const rows = await database
    .select()
    .from(embeddingSpaceGcRuns)
    .where(eq(embeddingSpaceGcRuns.id, runId))
    .limit(1);
  const run = decodeGcRunRow(rows[0]);
  return {
    activeSpaceId: run.activeSpaceId,
    id: run.id,
    mode: run.mode,
    retentionCutoff: run.retentionCutoff,
    status: run.status,
  };
}

function decodeGcRunRow(row: unknown) {
  const result = gcRunRowSchema.safeParse(row);
  if (!result.success) {
    throw new Error(`Embedding-space GC run is invalid: ${result.error.message}`);
  }
  return result.data;
}

function decodeGcSpaceRecord(row: unknown): EmbeddingSpaceGcSpaceRecord {
  const result = gcSpaceRowSchema.safeParse(row);
  if (!result.success) {
    throw new Error(`Embedding-space GC space is invalid: ${result.error.message}`);
  }
  return {
    createdAt: result.data.createdAt.toISOString(),
    dimensions: result.data.dimensions,
    disposition: result.data.disposition,
    errorMessage: result.data.errorMessage,
    estimatedBytes: result.data.estimatedBytes.toString(),
    inputFormatHash: result.data.inputFormatHash,
    inputFormatName: result.data.inputFormatName,
    model: result.data.model,
    protectionDetail: result.data.protectionDetail,
    protectionKind: result.data.protectionKind,
    rowCounts: result.data.rowCounts,
    spaceId: result.data.spaceId,
    state: result.data.state,
  };
}

function readSafeCount(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Embedding-space row count exceeds the safe integer range.");
  }
  return Number(value);
}
