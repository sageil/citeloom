import {
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join, resolve } from "node:path";

import {
  and,
  count,
  eq,
  inArray,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type { ApplicationRuntime } from "../app/runtime.js";
import type { SourceContentConfig } from "../config/index.js";
import type { CiteLoomDatabase } from "../database/client.js";
import {
  citationRecords,
  doclingTaskCheckpoints,
  documentVersions,
  indexedDocuments,
  indexedDocumentSpaces,
  ingestionJobs,
  researchThreads,
  researchTurns,
} from "../database/schema.js";
import {
  deletePermanentDocumentIngestionArtifacts,
  deleteTemporaryRetrievalDescriptionGeneration,
  deleteTemporaryDocumentIngestionArtifacts,
} from "./artifact-store.js";
import { deleteStoredDocumentEvidence } from "../documents/storage/source-document-store.js";
import { SourceContentStore } from "../documents/storage/source-content-store.js";
import { deleteDocumentRetrievalRows } from "../retrieval/indexing/index.js";
import type { ReindexDocumentRequest } from "./service.js";

export type DeleteIndexedDocumentResult =
  | { kind: "active" }
  | { kind: "not-found" }
  | {
      kind: "deleted";
      sourceFile: string;
    };

export type FinalizeIngestionCancellationResult =
  | { kind: "not-found" }
  | { kind: "pending" }
  | { error: string; kind: "cleanup-failed" }
  | { kind: "canceled" };

const ABANDONED_UPLOAD_AGE_MS = 24 * 60 * 60 * 1_000;
const uploadGroupNamePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export async function finalizeIngestionCancellation(
  database: CiteLoomDatabase,
  sourceFile: string,
  sourceContent: SourceContentConfig,
): Promise<FinalizeIngestionCancellationResult> {
  const jobs = await database
    .select({
      controlState: ingestionJobs.controlState,
      documentId: ingestionJobs.documentId,
      generationId: ingestionJobs.generationId,
      state: ingestionJobs.state,
    })
    .from(ingestionJobs)
    .where(eq(ingestionJobs.sourceFile, sourceFile))
    .limit(1);
  const job = jobs[0];
  if (job === undefined) {
    return { kind: "not-found" };
  }
  if (job.state === "running") {
    return { kind: "pending" };
  }
  if (await hasDoclingTaskCheckpoint(database, sourceFile)) {
    return { kind: "pending" };
  }
  if (job.controlState !== "cancel_requested" && job.controlState !== "cleanup_failed") {
    return { kind: "pending" };
  }

  const result = await database.transaction(async (transaction) => {
    const lockedJobs = await transaction
      .select({
        controlState: ingestionJobs.controlState,
        documentId: ingestionJobs.documentId,
        generationId: ingestionJobs.generationId,
        state: ingestionJobs.state,
      })
      .from(ingestionJobs)
      .where(eq(ingestionJobs.sourceFile, sourceFile))
      .for("update")
      .limit(1);
    const lockedJob = lockedJobs[0];
    if (lockedJob === undefined) {
      return { documentId: job.documentId, kind: "canceled" as const };
    }
    if (lockedJob.state === "running") {
      return { kind: "pending" as const };
    }
    if (await hasDoclingTaskCheckpoint(transaction, sourceFile)) {
      return { kind: "pending" as const };
    }
    if (
      lockedJob.controlState !== "cancel_requested"
      && lockedJob.controlState !== "cleanup_failed"
    ) {
      return { kind: "pending" as const };
    }
    await transaction.delete(ingestionJobs).where(eq(ingestionJobs.sourceFile, sourceFile));
    await deleteTemporaryRetrievalDescriptionGeneration(
      transaction,
      lockedJob.generationId,
    );
    await deleteDocumentDataWithoutReferences(transaction, lockedJob.documentId);
    return { documentId: lockedJob.documentId, kind: "canceled" as const };
  });
  if (result.kind !== "canceled") {
    return result;
  }
  const contentStore = new SourceContentStore(database, sourceContent);
  try {
    await contentStore.reconcileDocumentDeletion(result.documentId);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message, kind: "cleanup-failed" };
  }
  return { kind: "canceled" };
}

async function hasDoclingTaskCheckpoint(
  database: CiteLoomDatabase,
  sourceFile: string,
): Promise<boolean> {
  const checkpoints = await database
    .select({ taskId: doclingTaskCheckpoints.taskId })
    .from(doclingTaskCheckpoints)
    .where(eq(doclingTaskCheckpoints.sourceFile, sourceFile))
    .limit(1);
  return checkpoints.length > 0;
}

export async function reconcileIngestionCancellations(
  database: CiteLoomDatabase,
  sourceContent: SourceContentConfig,
): Promise<void> {
  const jobs = await database
    .select({ sourceFile: ingestionJobs.sourceFile })
    .from(ingestionJobs)
    .where(and(
      ne(ingestionJobs.state, "running"),
      eq(ingestionJobs.controlState, "cancel_requested"),
    ));
  for (const job of jobs) {
    await finalizeIngestionCancellation(
      database,
      job.sourceFile,
      sourceContent,
    );
  }
}

export async function deleteIndexedDocumentWithRuntime(
  runtime: ApplicationRuntime,
  request: ReindexDocumentRequest,
): Promise<DeleteIndexedDocumentResult> {
  const result = await runtime.database.transaction(async (transaction) => {
    const indexedRows = await transaction
      .select({ documentId: indexedDocuments.documentId })
      .from(indexedDocuments)
      .where(and(
        eq(indexedDocuments.documentId, request.documentId),
        eq(indexedDocuments.sourceFile, request.sourceFile),
      ))
      .for("update")
      .limit(1);
    const jobRows = await transaction
      .select({
        documentId: ingestionJobs.documentId,
        state: ingestionJobs.state,
      })
      .from(ingestionJobs)
      .where(eq(ingestionJobs.sourceFile, request.sourceFile))
      .for("update")
      .limit(1);
    const indexed = indexedRows[0];
    const job = jobRows[0];
    const documentExists = indexed !== undefined
      || job?.documentId === request.documentId;
    if (!documentExists) {
      return { kind: "not-found" as const };
    }
    if (job !== undefined && job.state !== "failed") {
      return { kind: "active" as const };
    }

    await transaction
      .delete(ingestionJobs)
      .where(eq(ingestionJobs.sourceFile, request.sourceFile));
    await transaction
      .delete(indexedDocumentSpaces)
      .where(eq(indexedDocumentSpaces.sourceFile, request.sourceFile));
    await transaction
      .delete(indexedDocuments)
      .where(eq(indexedDocuments.sourceFile, request.sourceFile));

    const versionDocumentIds = await readDocumentIdsForSource(
      transaction,
      request.sourceFile,
    );
    const affectedDocumentIds = new Set(versionDocumentIds);
    affectedDocumentIds.add(request.documentId);
    await deleteResearchQuestionsForSource(
      transaction,
      request.sourceFile,
      [...affectedDocumentIds],
    );
    await deleteDocumentVersionsForSource(transaction, request.sourceFile);
    for (const documentId of affectedDocumentIds) {
      await deleteDocumentDataWithoutReferences(transaction, documentId);
    }
    return {
      affectedDocumentIds: [...affectedDocumentIds],
      kind: "deleted" as const,
    };
  });
  if (result.kind !== "deleted") {
    return result;
  }
  const contentStore = new SourceContentStore(
    runtime.database,
    runtime.config.sourceContent,
  );
  for (const documentId of result.affectedDocumentIds) {
    await contentStore.reconcileDocumentDeletion(documentId);
  }
  return { kind: "deleted", sourceFile: request.sourceFile };
}

export async function deleteAbandonedUploadStaging(
  uploadDirectory: string,
  now: Date = new Date(),
): Promise<number> {
  const resolvedUploadDirectory = resolve(uploadDirectory);
  let entries: Dirent[];
  try {
    entries = await readdir(resolvedUploadDirectory, { withFileTypes: true });
  } catch (error: unknown) {
    if (isFileSystemError(error) && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  let deleted = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !uploadGroupNamePattern.test(entry.name)) {
      continue;
    }
    const groupDirectory = join(resolvedUploadDirectory, entry.name);
    let metadata: Awaited<ReturnType<typeof stat>>;
    try {
      metadata = await stat(groupDirectory);
    } catch (error: unknown) {
      if (isFileSystemError(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (now.getTime() - metadata.mtimeMs < ABANDONED_UPLOAD_AGE_MS) {
      continue;
    }
    await rm(groupDirectory, { force: true, recursive: true });
    deleted += 1;
  }
  return deleted;
}

type DeletionTransaction = Parameters<
  Parameters<ApplicationRuntime["database"]["transaction"]>[0]
>[0];

async function deleteResearchQuestionsForSource(
  transaction: DeletionTransaction,
  sourceFile: string,
  documentIds: readonly string[],
): Promise<void> {
  const citationRows = await transaction
    .selectDistinct({
      threadId: researchTurns.threadId,
      turnId: researchTurns.id,
    })
    .from(citationRecords)
    .innerJoin(
      documentVersions,
      eq(documentVersions.id, citationRecords.documentVersionId),
    )
    .innerJoin(researchTurns, eq(researchTurns.id, citationRecords.turnId))
    .where(eq(documentVersions.sourceFile, sourceFile));

  const associationConditions: SQL[] = [
    sql`${researchTurns.retrievedContext} @> ${
      JSON.stringify([{ sourceFile }])
    }::jsonb`,
    sql`${researchTurns.scope} @> ${
      JSON.stringify({ kind: "sourceFiles", sourceFiles: [sourceFile] })
    }::jsonb`,
  ];
  for (const documentId of documentIds) {
    associationConditions.push(
      sql`${researchTurns.scope} @> ${
        JSON.stringify({ documentIds: [documentId], kind: "documentIds" })
      }::jsonb`,
    );
  }
  const associatedRows = await transaction
    .select({
      threadId: researchTurns.threadId,
      turnId: researchTurns.id,
    })
    .from(researchTurns)
    .where(or(...associationConditions));

  const threadIds = new Set<string>();
  const turnIds = new Set<string>();
  for (const row of citationRows) {
    threadIds.add(row.threadId);
    turnIds.add(row.turnId);
  }
  for (const row of associatedRows) {
    threadIds.add(row.threadId);
    turnIds.add(row.turnId);
  }
  if (turnIds.size === 0) {
    return;
  }
  await transaction
    .delete(researchTurns)
    .where(inArray(researchTurns.id, [...turnIds]));

  const remainingTurn = transaction
    .select({ id: researchTurns.id })
    .from(researchTurns)
    .where(eq(researchTurns.threadId, researchThreads.id));
  await transaction
    .delete(researchThreads)
    .where(and(
      inArray(researchThreads.id, [...threadIds]),
      notExists(remainingTurn),
    ));
}

async function readDocumentIdsForSource(
  transaction: DeletionTransaction,
  sourceFile: string,
): Promise<string[]> {
  const rows = await transaction
    .selectDistinct({ documentId: documentVersions.documentId })
    .from(documentVersions)
    .where(eq(documentVersions.sourceFile, sourceFile));
  return rows.map((row) => row.documentId);
}

async function deleteDocumentVersionsForSource(
  transaction: DeletionTransaction,
  sourceFile: string,
): Promise<void> {
  await transaction
    .delete(documentVersions)
    .where(eq(documentVersions.sourceFile, sourceFile));
}

async function deleteDocumentDataWithoutReferences(
  transaction: DeletionTransaction,
  documentId: string,
): Promise<void> {
  const indexedReferences = await transaction
    .select({ value: count() })
    .from(indexedDocuments)
    .where(eq(indexedDocuments.documentId, documentId));
  const jobReferences = await transaction
    .select({ value: count() })
    .from(ingestionJobs)
    .where(eq(ingestionJobs.documentId, documentId));
  const remainingReferences = (indexedReferences[0]?.value ?? 0)
    + (jobReferences[0]?.value ?? 0);
  if (remainingReferences > 0) {
    return;
  }
  await deleteDocumentRetrievalRows(transaction, documentId);
  await deleteTemporaryDocumentIngestionArtifacts(transaction, documentId);
  const versionReferences = await transaction
    .select({ value: count() })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId));
  if ((versionReferences[0]?.value ?? 0) > 0) {
    return;
  }
  await deletePermanentDocumentIngestionArtifacts(transaction, documentId);
  await deleteStoredDocumentEvidence(transaction, documentId);
}

function isFileSystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
