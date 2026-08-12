import { and, asc, eq, inArray } from "drizzle-orm";

import { requireGlobalAdministrator } from "../auth/authorization.js";
import type { AuthenticatedPrincipal } from "../auth/model.js";
import type { SourceContentConfig } from "../config/index.js";
import type { CiteLoomDatabase } from "../database/client.js";
import {
  documentVersions,
  indexedDocuments,
  ingestionJobs,
  sourceContentDeletions,
  sourceLibraries,
  sourceLibraryDeletionSources,
} from "../database/schema.js";
import { SourceContentStore } from "../documents/storage/source-content-store.js";
import { deleteIndexedDocumentWithRuntime } from "../ingestion/deletion.js";
import { SourceLibraryUnavailableError } from "./source-library-store.js";

export class SourceLibraryDeletionConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SourceLibraryDeletionConflictError";
  }
}

export interface SourceLibraryDeletionRuntime {
  config: { sourceContent: SourceContentConfig };
  database: CiteLoomDatabase;
}

export async function requestSharedSourceLibraryDeletion(
  database: CiteLoomDatabase,
  principal: AuthenticatedPrincipal,
  libraryId: string,
): Promise<void> {
  requireGlobalAdministrator(principal);
  await database.transaction(async (transaction) => {
    const libraries = await transaction
      .select({ state: sourceLibraries.state })
      .from(sourceLibraries)
      .where(and(
        eq(sourceLibraries.id, libraryId),
        eq(sourceLibraries.kind, "shared"),
      ))
      .for("update")
      .limit(1);
    const library = libraries[0];
    if (library === undefined) {
      throw new SourceLibraryUnavailableError();
    }
    if (library.state === "deleting") {
      return;
    }

    const activeJobs = await transaction
      .select({ sourceFile: ingestionJobs.sourceFile })
      .from(ingestionJobs)
      .where(and(
        eq(ingestionJobs.sourceLibraryId, libraryId),
        inArray(ingestionJobs.state, ["pending", "running"]),
      ))
      .limit(1);
    if (activeJobs[0] !== undefined) {
      throw new SourceLibraryDeletionConflictError(
        "The shared library cannot be deleted while documents are processing.",
      );
    }

    const indexedSources = await transaction
      .select({
        documentId: indexedDocuments.documentId,
        sourceFile: indexedDocuments.sourceFile,
      })
      .from(indexedDocuments)
      .where(eq(indexedDocuments.sourceLibraryId, libraryId));
    const ingestionSources = await transaction
      .select({
        documentId: ingestionJobs.documentId,
        sourceFile: ingestionJobs.sourceFile,
      })
      .from(ingestionJobs)
      .where(eq(ingestionJobs.sourceLibraryId, libraryId));
    const deletionSources = await buildSourceDeletionSources(
      transaction,
      libraryId,
      indexedSources,
      ingestionSources,
    );
    if (deletionSources.length > 0) {
      await transaction
        .insert(sourceLibraryDeletionSources)
        .values(deletionSources)
        .onConflictDoNothing();
    }
    await transaction
      .update(sourceLibraries)
      .set({ state: "deleting", updatedAt: new Date() })
      .where(eq(sourceLibraries.id, libraryId));
  });
}

export async function reconcileNextSharedSourceLibraryDeletion(
  runtime: SourceLibraryDeletionRuntime,
): Promise<boolean> {
  const libraries = await runtime.database
    .select({ id: sourceLibraries.id })
    .from(sourceLibraries)
    .where(and(
      eq(sourceLibraries.kind, "shared"),
      eq(sourceLibraries.state, "deleting"),
    ))
    .orderBy(asc(sourceLibraries.updatedAt), asc(sourceLibraries.id))
    .limit(1);
  const library = libraries[0];
  if (library === undefined) {
    return false;
  }

  const sources = await runtime.database
    .select({
      documentId: sourceLibraryDeletionSources.documentId,
      sourceFile: sourceLibraryDeletionSources.sourceFile,
    })
    .from(sourceLibraryDeletionSources)
    .where(eq(sourceLibraryDeletionSources.libraryId, library.id))
    .orderBy(
      asc(sourceLibraryDeletionSources.sourceFile),
      asc(sourceLibraryDeletionSources.documentId),
    )
    .limit(1);
  const source = sources[0];
  if (source === undefined) {
    await runtime.database
      .delete(sourceLibraries)
      .where(and(
        eq(sourceLibraries.id, library.id),
        eq(sourceLibraries.kind, "shared"),
        eq(sourceLibraries.state, "deleting"),
      ));
    return true;
  }

  try {
    const result = await deleteIndexedDocumentWithRuntime(runtime, source);
    if (result.kind === "active") {
      throw new SourceLibraryDeletionConflictError(
        "The shared library cannot be deleted while documents are processing.",
      );
    }
    if (result.kind === "not-found") {
      const contentStore = new SourceContentStore(
        runtime.database,
        runtime.config.sourceContent,
      );
      await contentStore.reconcileDocumentDeletion(source.documentId);
    }
    const pendingContent = await runtime.database
      .select({ documentId: sourceContentDeletions.documentId })
      .from(sourceContentDeletions)
      .where(eq(sourceContentDeletions.documentId, source.documentId))
      .limit(1);
    if (pendingContent[0] === undefined) {
      await runtime.database
        .delete(sourceLibraryDeletionSources)
        .where(and(
          eq(sourceLibraryDeletionSources.libraryId, library.id),
          eq(sourceLibraryDeletionSources.sourceFile, source.sourceFile),
          eq(sourceLibraryDeletionSources.documentId, source.documentId),
        ));
    }
  } catch (error: unknown) {
    await postponeSharedSourceLibraryDeletion(runtime.database, library.id);
    throw error;
  }
  await postponeSharedSourceLibraryDeletion(runtime.database, library.id);
  return true;
}

type SourceLibraryDeletionTransaction = Parameters<
  Parameters<CiteLoomDatabase["transaction"]>[0]
>[0];

interface SourceIdentity {
  documentId: string;
  sourceFile: string;
}

async function buildSourceDeletionSources(
  transaction: SourceLibraryDeletionTransaction,
  libraryId: string,
  indexedSources: readonly SourceIdentity[],
  ingestionSources: readonly SourceIdentity[],
): Promise<Array<SourceIdentity & { libraryId: string }>> {
  const sourceFiles = new Set<string>();
  const currentDocumentIds = new Map<string, Set<string>>();
  for (const source of indexedSources) {
    addSourceIdentity(sourceFiles, currentDocumentIds, source);
  }
  for (const source of ingestionSources) {
    addSourceIdentity(sourceFiles, currentDocumentIds, source);
  }
  if (sourceFiles.size === 0) {
    return [];
  }
  const versionRows = await transaction
    .select({
      documentId: documentVersions.documentId,
      sourceFile: documentVersions.sourceFile,
    })
    .from(documentVersions)
    .where(inArray(documentVersions.sourceFile, [...sourceFiles]));
  for (const source of versionRows) {
    addSourceIdentity(sourceFiles, currentDocumentIds, source);
  }

  const rows: Array<SourceIdentity & { libraryId: string }> = [];
  for (const [sourceFile, documentIds] of currentDocumentIds) {
    for (const documentId of documentIds) {
      rows.push({ documentId, libraryId, sourceFile });
    }
  }
  return rows;
}

function addSourceIdentity(
  sourceFiles: Set<string>,
  documentIdsBySource: Map<string, Set<string>>,
  source: SourceIdentity,
): void {
  sourceFiles.add(source.sourceFile);
  const documentIds = documentIdsBySource.get(source.sourceFile) ?? new Set();
  documentIds.add(source.documentId);
  documentIdsBySource.set(source.sourceFile, documentIds);
}

async function postponeSharedSourceLibraryDeletion(
  database: CiteLoomDatabase,
  libraryId: string,
): Promise<void> {
  await database
    .update(sourceLibraries)
    .set({ updatedAt: new Date() })
    .where(and(
      eq(sourceLibraries.id, libraryId),
      eq(sourceLibraries.state, "deleting"),
    ));
}
