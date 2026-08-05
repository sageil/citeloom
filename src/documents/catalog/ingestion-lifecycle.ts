import { randomUUID } from "node:crypto";
import { basename } from "node:path";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
  like,
  ne,
  notExists,
  sql,
} from "drizzle-orm";

import type { CatalogDocumentStore } from "./document-store.js";
import {
  buildAvailableJobCondition,
  buildOwnedRunningJobCondition,
  type CatalogJobStore,
  requireSingleJobTransition,
} from "./job-store.js";
import {
  chooseCatalogTags,
  decodeIndexedDocument,
  decodeIngestionJob,
  decodePublishedDocument,
  normalizeCatalogTags,
} from "./records.js";
import type {
  Clock,
  IndexedDocument,
  IngestionJob,
  PrepareIngestionResult,
  PromotionResult,
  PublishedDocument,
} from "./model.js";
import type { CiteLoomDatabase } from "../../database/client.js";
import {
  doclingTaskCheckpoints,
  documentElementSetMembers,
  documentElementSets,
  documentVersions,
  indexedDocuments,
  indexedDocumentSpaces,
  ingestionEmbeddingManifests,
  ingestionJobs,
  retrievalLexicalChunks,
  retrievalDescriptionArtifacts,
  retrievalTocArtifacts,
  sourceElements,
} from "../../database/schema.js";
import { RETRIEVAL_VECTOR_TABLES } from "../../embedding/storage-tables.js";
import {
  deleteRetrievalGenerationRows,
  validateEmbeddingGenerationForPublication,
} from "../../retrieval/indexing/index-store.js";
import type { DocumentFormat } from "../format.js";
import { validateDocumentTocForPublication } from "../../retrieval/toc/store.js";

export interface PrepareIngestionRequest {
  documentId: string;
  duplicateSourceRoot: string | null;
  embeddingSpaceId: string;
  format: DocumentFormat;
  force: boolean;
  maxAttempts: number;
  requestedTags: string[];
  sourceFile: string;
  uploadedByUserId: string | null;
}

export class CatalogIngestionLifecycle {
  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly jobs: CatalogJobStore,
    private readonly documents: CatalogDocumentStore,
    private readonly clock: Clock,
  ) {}

  public async prepareIngestion(
    request: PrepareIngestionRequest,
  ): Promise<PrepareIngestionResult> {
    const duplicateSourceRoot = request.duplicateSourceRoot;
    if (duplicateSourceRoot !== null) {
      return this.prepareUploadedIngestion(request, duplicateSourceRoot);
    }
    return this.prepareSourceIngestion(request);
  }

  private async prepareSourceIngestion(
    request: PrepareIngestionRequest,
  ): Promise<PrepareIngestionResult> {
    const indexed = await this.documents.findIndexedBySourceFile(
      request.sourceFile,
    );
    const indexedSpaceDocumentId = await this.documents.findIndexedSpaceDocumentId(
      request.sourceFile,
      request.embeddingSpaceId,
    );
    const existingJob = await this.jobs.getJob(request.sourceFile);
    const tags = chooseCatalogTags(
      request.requestedTags,
      existingJob?.tags ?? indexed?.tags ?? [],
    );
    const currentTime = this.clock.now();

    if (
      !request.force &&
      indexed?.documentId === request.documentId &&
      haveSameDocumentFormat(indexed.format, request.format) &&
      indexedSpaceDocumentId === request.documentId
    ) {
      if (existingJob !== null) {
        const canceledJob = await this.jobs.cancelAvailableJob(request.sourceFile);
        if (canceledJob === null) {
          throw new Error(`Another ingestion worker claimed ${request.sourceFile}.`);
        }
      }
      await this.documents.updateIndexedTags(request.sourceFile, tags);
      return {
        abandonedJob: existingJob,
        document: { ...indexed, tags },
        kind: "skipped",
      };
    }

    if (
      !request.force &&
      existingJob?.documentId === request.documentId &&
      existingJob.embeddingSpaceId === request.embeddingSpaceId &&
      haveSameDocumentFormat(existingJob.format, request.format)
    ) {
      return this.resumeIngestion(request, tags, currentTime);
    }

    return this.resetIngestion(request, existingJob, tags, currentTime);
  }

  private async prepareUploadedIngestion(
    request: PrepareIngestionRequest,
    duplicateSourceRoot: string,
  ): Promise<PrepareIngestionResult> {
    return this.database.transaction(async (transaction) => {
      await lockUploadedDocumentIdentity(transaction, request);
      let candidates = await readUploadedDocumentCandidates(
        transaction,
        request,
        duplicateSourceRoot,
      );
      const reconciledSourceFiles = await reconcileUploadedContentDuplicates(
        transaction,
        candidates,
        request.documentId,
      );
      if (reconciledSourceFiles.length > 0) {
        candidates = await readUploadedDocumentCandidates(
          transaction,
          request,
          duplicateSourceRoot,
        );
      }
      const candidate = chooseUploadedDocumentCandidate(candidates, request);
      if (candidate === null) {
        return insertUploadedIngestionJob(
          transaction,
          request,
          null,
          chooseCatalogTags(request.requestedTags, []),
          this.clock.now(),
        );
      }

      const existingJob = candidate.job;
      if (existingJob !== null && existingJob.state !== "failed") {
        if (!isSameIngestionRequest(existingJob, request)) {
          return {
            abandonedJob: null,
            existing: existingJob,
            kind: "busy",
          };
        }
        const tags = chooseCatalogTags(request.requestedTags, existingJob.tags);
        const updatedAt = this.clock.now();
        await transaction
          .update(ingestionJobs)
          .set({ tags, updatedAt })
          .where(eq(ingestionJobs.sourceFile, existingJob.sourceFile));
        return {
          abandonedJob: null,
          existing: { ...existingJob, tags, updatedAt: updatedAt.toISOString() },
          kind: "already-processing",
        };
      }

      const indexed = candidate.indexed;
      const tags = chooseCatalogTags(
        request.requestedTags,
        existingJob?.tags ?? indexed?.tags ?? [],
      );
      const contentIsCurrent = indexed?.documentId === request.documentId
        && haveSameDocumentFormat(indexed.format, request.format)
        && candidate.currentEmbeddingDocumentId === request.documentId;
      if (contentIsCurrent && !request.force && existingJob === null) {
        await transaction
          .update(indexedDocuments)
          .set({ tags })
          .where(eq(indexedDocuments.sourceFile, indexed.sourceFile));
        return {
          abandonedJob: null,
          existing: { ...indexed, tags },
          kind: "duplicate",
        };
      }

      const canonicalRequest: PrepareIngestionRequest = {
        ...request,
        sourceFile: candidate.sourceFile,
      };
      return insertUploadedIngestionJob(
        transaction,
        canonicalRequest,
        existingJob,
        tags,
        this.clock.now(),
      );
    });
  }

  public async reconcileUploadedDuplicates(
    duplicateSourceRoot: string,
  ): Promise<string[]> {
    return this.database.transaction(async (transaction) => {
      const sourcePattern = buildSourceRootPattern(duplicateSourceRoot);
      const indexedRows = await transaction
        .select({
          document: indexedDocuments,
          fileExtension: documentVersions.fileExtension,
          mediaType: documentVersions.mediaType,
          versionDocumentId: documentVersions.documentId,
          versionSourceFile: documentVersions.sourceFile,
        })
        .from(indexedDocuments)
        .innerJoin(
          documentVersions,
          eq(indexedDocuments.versionId, documentVersions.id),
        )
        .where(like(indexedDocuments.sourceFile, sourcePattern))
        .orderBy(asc(indexedDocuments.indexedAt));
      const jobRows = await transaction
        .select()
        .from(ingestionJobs)
        .where(like(ingestionJobs.sourceFile, sourcePattern));
      const jobsBySource = new Map<string, IngestionJob>();
      for (const row of jobRows) {
        const job = decodeIngestionJob(row);
        jobsBySource.set(job.sourceFile, job);
      }

      const candidatesByDocument = new Map<string, UploadedDocumentCandidate[]>();
      for (const row of indexedRows) {
        const indexed = decodePublishedDocument(row);
        const candidates = candidatesByDocument.get(indexed.documentId) ?? [];
        candidates.push({
          currentEmbeddingDocumentId: null,
          indexed,
          job: jobsBySource.get(indexed.sourceFile) ?? null,
          sourceFile: indexed.sourceFile,
        });
        candidatesByDocument.set(indexed.documentId, candidates);
      }

      const reconciledSourceFiles: string[] = [];
      for (const [documentId, candidates] of candidatesByDocument) {
        if (candidates.length < 2) {
          continue;
        }
        await lockUploadedContentIdentity(transaction, documentId);
        const reconciled = await reconcileUploadedContentDuplicates(
          transaction,
          candidates,
          documentId,
        );
        reconciledSourceFiles.push(...reconciled);
      }
      return reconciledSourceFiles;
    });
  }

  public async promoteJob(
    sourceFile: string,
    ownerId: string,
  ): Promise<PromotionResult> {
    const promotion = await this.database.transaction(async (transaction) => {
      const job = await readPromotableJob(
        transaction,
        sourceFile,
        ownerId,
      );
      await validatePublicationArtifacts(transaction, job);
      const previous = await readPreviousIndexedDocument(transaction, sourceFile);
      const obsoleteGenerationIds = await readObsoleteRetrievalGenerations(
        transaction,
        job,
      );
      const indexedAt = this.clock.now();
      const versionId = await persistDocumentVersion(transaction, job, indexedAt);
      const indexed = await persistIndexedDocument(
        transaction,
        job,
        indexedAt,
        versionId,
      );
      await synchronizeIndexedDocumentSpace(transaction, job, indexedAt);
      await deleteOrphanedTemporaryArtifacts(
        transaction,
        job.documentId,
      );
      for (const generationId of obsoleteGenerationIds) {
        await deleteRetrievalGenerationRows(transaction, generationId);
        await deleteRetrievalDescriptionArtifacts(transaction, generationId);
      }

      const deletedRows = await transaction
        .delete(ingestionJobs)
        .where(buildOwnedRunningJobCondition(ownerId, sourceFile))
        .returning({ sourceFile: ingestionJobs.sourceFile });
      requireSingleJobTransition(deletedRows, sourceFile, "indexed");
      return { indexed, previous };
    });
    return promotion;
  }

  private async resumeIngestion(
    request: PrepareIngestionRequest,
    tags: string[],
    currentTime: Date,
  ): Promise<PrepareIngestionResult> {
    const resumedRows = await this.database
      .update(ingestionJobs)
      .set({
        attemptCount: 0,
        errorMessage: null,
        leaseExpiresAt: null,
        maxAttempts: request.maxAttempts,
        nextAttemptAt: currentTime,
        ownerId: null,
        controlError: null,
        controlState: "active",
        state: "pending",
        tags,
        updatedAt: currentTime,
      })
      .where(
        and(
          eq(ingestionJobs.sourceFile, request.sourceFile),
          buildAvailableJobCondition(),
        ),
      )
      .returning();
    const resumedRow = resumedRows[0];
    if (resumedRow === undefined) {
      throw new Error(`Another ingestion worker claimed ${request.sourceFile}.`);
    }
    return {
      abandonedJob: null,
      job: decodeIngestionJob(resumedRow),
      kind: "process",
    };
  }

  private async resetIngestion(
    request: PrepareIngestionRequest,
    existingJob: IngestionJob | null,
    tags: string[],
    currentTime: Date,
  ): Promise<PrepareIngestionResult> {
    const resetJob = buildResetJob(request, tags, currentTime);
    return this.database.transaction(async (transaction) => {
      const currentJob = await readResettableJob(
        transaction,
        request.sourceFile,
      );
      if (currentJob !== null) {
        await discardIngestionGeneration(
          transaction,
          currentJob.generationId,
          currentJob.documentId === request.documentId,
        );
      }
      const jobRows = await transaction
        .insert(ingestionJobs)
        .values(resetJob)
        .onConflictDoUpdate({
          set: resetJob,
          setWhere: buildAvailableJobCondition(),
          target: ingestionJobs.sourceFile,
        })
        .returning();
      const jobRow = jobRows[0];
      if (jobRow === undefined) {
        throw new Error(`Another ingestion worker claimed ${request.sourceFile}.`);
      }

      const priorJob = currentJob ?? existingJob;
      const abandonedJob = priorJob?.documentId === request.documentId
        ? null
        : priorJob;
      return {
        abandonedJob,
        job: decodeIngestionJob(jobRow),
        kind: "process",
      };
    });
  }

}

function buildSourceRootPattern(sourceRoot: string): string {
  const escapedRoot = sourceRoot.replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
  return `${escapedRoot}/%`;
}

type CatalogIngestionTransaction = Parameters<
  Parameters<CiteLoomDatabase["transaction"]>[0]
>[0];

async function readResettableJob(
  transaction: CatalogIngestionTransaction,
  sourceFile: string,
): Promise<IngestionJob | null> {
  const rows = await transaction
    .select()
    .from(ingestionJobs)
    .where(eq(ingestionJobs.sourceFile, sourceFile))
    .limit(1)
    .for("update");
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return decodeIngestionJob(row);
}

async function discardIngestionGeneration(
  transaction: CatalogIngestionTransaction,
  generationId: string,
  preserveRetrievalDescriptions: boolean,
): Promise<void> {
  await transaction
    .delete(ingestionEmbeddingManifests)
    .where(eq(ingestionEmbeddingManifests.generationId, generationId));
  await deleteRetrievalGenerationRows(transaction, generationId);
  if (!preserveRetrievalDescriptions) {
    await deleteRetrievalDescriptionArtifacts(transaction, generationId);
  }
}

interface UploadedDocumentCandidate {
  currentEmbeddingDocumentId: string | null;
  indexed: PublishedDocument | null;
  job: IngestionJob | null;
  sourceFile: string;
}

async function lockUploadedDocumentIdentity(
  transaction: CatalogIngestionTransaction,
  request: PrepareIngestionRequest,
): Promise<void> {
  const normalizedFilename = normalizeUploadedFilename(request.sourceFile);
  const lockKeys = [
    `upload-content:${request.documentId}`,
    `upload-filename:${normalizedFilename}`,
  ].sort();
  for (const lockKey of lockKeys) {
    await transaction.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
    );
  }
}

async function lockUploadedContentIdentity(
  transaction: CatalogIngestionTransaction,
  documentId: string,
): Promise<void> {
  const lockKey = `upload-content:${documentId}`;
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
  );
}

async function readUploadedDocumentCandidates(
  transaction: CatalogIngestionTransaction,
  request: PrepareIngestionRequest,
  duplicateSourceRoot: string,
): Promise<UploadedDocumentCandidate[]> {
  const sourcePattern = buildSourceRootPattern(duplicateSourceRoot);
  const indexedRows = await transaction
    .select({
      document: indexedDocuments,
      fileExtension: documentVersions.fileExtension,
      mediaType: documentVersions.mediaType,
      versionDocumentId: documentVersions.documentId,
      versionSourceFile: documentVersions.sourceFile,
    })
    .from(indexedDocuments)
    .innerJoin(
      documentVersions,
      eq(indexedDocuments.versionId, documentVersions.id),
    )
    .where(like(indexedDocuments.sourceFile, sourcePattern))
    .orderBy(asc(indexedDocuments.indexedAt));
  const jobRows = await transaction
    .select()
    .from(ingestionJobs)
    .where(like(ingestionJobs.sourceFile, sourcePattern))
    .orderBy(asc(ingestionJobs.updatedAt));
  const spaceRows = await transaction
    .select()
    .from(indexedDocumentSpaces)
    .where(and(
      like(indexedDocumentSpaces.sourceFile, sourcePattern),
      eq(indexedDocumentSpaces.embeddingSpaceId, request.embeddingSpaceId),
    ));

  const candidates = new Map<string, UploadedDocumentCandidate>();
  for (const row of indexedRows) {
    const indexed = decodePublishedDocument(row);
    candidates.set(indexed.sourceFile, {
      currentEmbeddingDocumentId: null,
      indexed,
      job: null,
      sourceFile: indexed.sourceFile,
    });
  }
  for (const row of jobRows) {
    const job = decodeIngestionJob(row);
    const candidate = candidates.get(job.sourceFile);
    if (candidate === undefined) {
      candidates.set(job.sourceFile, {
        currentEmbeddingDocumentId: null,
        indexed: null,
        job,
        sourceFile: job.sourceFile,
      });
      continue;
    }
    candidate.job = job;
  }
  for (const row of spaceRows) {
    const candidate = candidates.get(row.sourceFile);
    if (candidate !== undefined) {
      candidate.currentEmbeddingDocumentId = row.documentId;
    }
  }
  return [...candidates.values()];
}

function chooseUploadedDocumentCandidate(
  candidates: readonly UploadedDocumentCandidate[],
  request: PrepareIngestionRequest,
): UploadedDocumentCandidate | null {
  for (const candidate of candidates) {
    if (
      candidate.indexed?.documentId === request.documentId
      && haveSameDocumentFormat(candidate.indexed.format, request.format)
      && candidate.currentEmbeddingDocumentId === request.documentId
    ) {
      return candidate;
    }
  }
  for (const candidate of candidates) {
    if (
      candidate.job?.documentId === request.documentId
      && candidate.job.embeddingSpaceId === request.embeddingSpaceId
      && haveSameDocumentFormat(candidate.job.format, request.format)
    ) {
      return candidate;
    }
  }
  const normalizedFilename = normalizeUploadedFilename(request.sourceFile);
  for (const candidate of candidates) {
    if (normalizeUploadedFilename(candidate.sourceFile) === normalizedFilename) {
      return candidate;
    }
  }
  for (const candidate of candidates) {
    if (
      candidate.indexed?.documentId === request.documentId
      || candidate.job?.documentId === request.documentId
    ) {
      return candidate;
    }
  }
  return null;
}

function normalizeUploadedFilename(sourceFile: string): string {
  return basename(sourceFile).normalize("NFC").toLowerCase();
}

async function insertUploadedIngestionJob(
  transaction: CatalogIngestionTransaction,
  request: PrepareIngestionRequest,
  existingJob: IngestionJob | null,
  tags: string[],
  currentTime: Date,
): Promise<PrepareIngestionResult> {
  if (existingJob !== null) {
    const currentJob = await readResettableJob(
      transaction,
      existingJob.sourceFile,
    );
    if (currentJob !== null) {
      await discardIngestionGeneration(
        transaction,
        currentJob.generationId,
        currentJob.documentId === request.documentId,
      );
    }
    await transaction
      .delete(doclingTaskCheckpoints)
      .where(eq(doclingTaskCheckpoints.sourceFile, existingJob.sourceFile));
  }
  const resetJob = buildDoclingPartialsResetJob(
    buildResetJob(request, tags, currentTime),
  );
  const rows = await transaction
    .insert(ingestionJobs)
    .values(resetJob)
    .onConflictDoUpdate({
      set: resetJob,
      setWhere: buildAvailableJobCondition(),
      target: ingestionJobs.sourceFile,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Failed to prepare uploaded document: ${request.sourceFile}.`);
  }
  const abandonedJob = existingJob?.documentId === request.documentId
    ? null
    : existingJob;
  return {
    abandonedJob,
    job: decodeIngestionJob(row),
    kind: "process",
  };
}

async function reconcileUploadedContentDuplicates(
  transaction: CatalogIngestionTransaction,
  candidates: readonly UploadedDocumentCandidate[],
  documentId: string,
): Promise<string[]> {
  const duplicates: UploadedDocumentCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.indexed?.documentId === documentId && candidate.job === null) {
      duplicates.push(candidate);
    }
  }
  const canonical = duplicates[0];
  if (canonical === undefined || canonical.indexed === null) {
    return [];
  }
  if (duplicates.length < 2) {
    return [];
  }

  const mergedTags = [...canonical.indexed.tags];
  for (let index = 1; index < duplicates.length; index += 1) {
    const duplicate = duplicates[index];
    if (duplicate?.indexed !== null && duplicate?.indexed !== undefined) {
      mergedTags.push(...duplicate.indexed.tags);
    }
  }
  const normalizedTags = normalizeCatalogTags(mergedTags);
  await transaction
    .update(indexedDocuments)
    .set({ tags: normalizedTags })
    .where(eq(indexedDocuments.sourceFile, canonical.sourceFile));

  let nextVersion = await readLatestDocumentVersion(
    transaction,
    canonical.sourceFile,
  );
  const reconciledSourceFiles: string[] = [];
  for (let index = 1; index < duplicates.length; index += 1) {
    const duplicate = duplicates[index];
    if (duplicate?.indexed === null || duplicate?.indexed === undefined) {
      continue;
    }
    const versions = await transaction
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .where(eq(documentVersions.sourceFile, duplicate.sourceFile))
      .orderBy(asc(documentVersions.version));
    for (const version of versions) {
      nextVersion += 1;
      await transaction
        .update(documentVersions)
        .set({ sourceFile: canonical.sourceFile, version: nextVersion })
        .where(eq(documentVersions.id, version.id));
    }

    await synchronizeRetrievalSourceFile(
      transaction,
      documentId,
      duplicate.sourceFile,
      canonical.sourceFile,
    );

    const spaces = await transaction
      .select()
      .from(indexedDocumentSpaces)
      .where(eq(indexedDocumentSpaces.sourceFile, duplicate.sourceFile));
    for (const space of spaces) {
      await transaction
        .insert(indexedDocumentSpaces)
        .values({
          documentId: space.documentId,
          embeddingSpaceId: space.embeddingSpaceId,
          generationId: space.generationId,
          indexedAt: space.indexedAt,
          sourceFile: canonical.sourceFile,
        })
        .onConflictDoNothing();
    }
    await transaction
      .delete(indexedDocumentSpaces)
      .where(eq(indexedDocumentSpaces.sourceFile, duplicate.sourceFile));
    await transaction
      .delete(indexedDocuments)
      .where(eq(indexedDocuments.sourceFile, duplicate.sourceFile));
    reconciledSourceFiles.push(duplicate.sourceFile);
  }
  return reconciledSourceFiles;
}

async function synchronizeRetrievalSourceFile(
  transaction: CatalogIngestionTransaction,
  documentId: string,
  previousSourceFile: string,
  canonicalSourceFile: string,
): Promise<void> {
  for (const table of RETRIEVAL_VECTOR_TABLES) {
    const condition = and(
      eq(table.documentId, documentId),
      eq(table.sourceFile, previousSourceFile),
    );
    await transaction
      .update(table)
      .set({ sourceFile: canonicalSourceFile })
      .where(condition);
  }

  const lexicalCondition = and(
    eq(retrievalLexicalChunks.documentId, documentId),
    eq(retrievalLexicalChunks.sourceFile, previousSourceFile),
  );
  await transaction
    .update(retrievalLexicalChunks)
    .set({ sourceFile: canonicalSourceFile })
    .where(lexicalCondition);

  const tocCondition = and(
    eq(retrievalTocArtifacts.documentId, documentId),
    eq(retrievalTocArtifacts.sourceFile, previousSourceFile),
  );
  await transaction
    .update(retrievalTocArtifacts)
    .set({ sourceFile: canonicalSourceFile })
    .where(tocCondition);
}

async function readLatestDocumentVersion(
  transaction: CatalogIngestionTransaction,
  sourceFile: string,
): Promise<number> {
  const rows = await transaction
    .select({ version: documentVersions.version })
    .from(documentVersions)
    .where(eq(documentVersions.sourceFile, sourceFile))
    .orderBy(desc(documentVersions.version))
    .limit(1);
  return rows[0]?.version ?? 0;
}

const PUBLICATION_CLEANUP_BATCH_SIZE = 500;

async function validatePublicationArtifacts(
  transaction: CatalogIngestionTransaction,
  job: IngestionJob,
): Promise<void> {
  const elementSetId = requireElementSetId(job);
  const elementSetRows = await transaction
    .select({
      complete: documentElementSets.complete,
      documentId: documentElementSets.documentId,
      elementCount: documentElementSets.elementCount,
    })
    .from(documentElementSets)
    .where(eq(documentElementSets.id, elementSetId))
    .limit(1);
  const elementSet = elementSetRows[0];
  if (
    elementSet === undefined
    || !elementSet.complete
    || elementSet.documentId !== job.documentId
    || elementSet.elementCount !== job.totalElements
  ) {
    throw new Error(
      `Element set ${elementSetId} is not complete for publication.`,
    );
  }

  const mediaRows = await transaction
    .select({
      descriptionId: retrievalDescriptionArtifacts.id,
      elementId: sourceElements.id,
      kind: sql<string>`${sourceElements.element}->>'kind'`,
      position: documentElementSetMembers.position,
    })
    .from(documentElementSetMembers)
    .innerJoin(
      sourceElements,
      eq(sourceElements.id, documentElementSetMembers.elementId),
    )
    .leftJoin(
      retrievalDescriptionArtifacts,
      and(
        eq(retrievalDescriptionArtifacts.generationId, job.generationId),
        eq(retrievalDescriptionArtifacts.documentId, job.documentId),
        eq(
          retrievalDescriptionArtifacts.position,
          documentElementSetMembers.position,
        ),
        sql`${retrievalDescriptionArtifacts.id} = ${sourceElements.id} || '-description'`,
        sql`${retrievalDescriptionArtifacts.description}->>'kind' = ${sourceElements.element}->>'kind'`,
        sql`${retrievalDescriptionArtifacts.description}->>'parentId' = ${sourceElements.id}`,
      ),
    )
    .where(and(
      eq(documentElementSetMembers.setId, elementSetId),
      sql`${sourceElements.element}->>'kind' IN ('table', 'image')`,
    ))
    .orderBy(asc(documentElementSetMembers.position));
  const descriptionRows = await transaction
    .select({ id: retrievalDescriptionArtifacts.id })
    .from(retrievalDescriptionArtifacts)
    .where(and(
      eq(retrievalDescriptionArtifacts.generationId, job.generationId),
      eq(retrievalDescriptionArtifacts.documentId, job.documentId),
    ));
  if (
    mediaRows.length !== job.tables + job.images
    || descriptionRows.length !== mediaRows.length
  ) {
    throw new Error(
      `Retrieval descriptions are incomplete for generation ${job.generationId}.`,
    );
  }
  for (const row of mediaRows) {
    if (
      (row.kind !== "table" && row.kind !== "image")
      || row.descriptionId === null
    ) {
      throw new Error(
        `Retrieval description does not match media element ${row.elementId} at position ${row.position}.`,
      );
    }
  }

  await validateEmbeddingGenerationForPublication(transaction, {
    documentId: job.documentId,
    elementSetId,
    embeddingSpaceId: job.embeddingSpaceId,
    generationId: job.generationId,
    totalElements: job.totalElements,
  });
  await validateDocumentTocForPublication(transaction, {
    documentId: job.documentId,
    elementSetId,
    generationId: job.generationId,
    sourceFile: job.sourceFile,
  });
}

async function readObsoleteRetrievalGenerations(
  transaction: CatalogIngestionTransaction,
  job: IngestionJob,
): Promise<string[]> {
  const rows = await transaction
    .select({
      documentId: indexedDocumentSpaces.documentId,
      embeddingSpaceId: indexedDocumentSpaces.embeddingSpaceId,
      generationId: indexedDocumentSpaces.generationId,
    })
    .from(indexedDocumentSpaces)
    .where(eq(indexedDocumentSpaces.sourceFile, job.sourceFile));
  const generationIds = new Set<string>();
  for (const row of rows) {
    if (
      row.embeddingSpaceId === job.embeddingSpaceId
      || row.documentId !== job.documentId
    ) {
      generationIds.add(row.generationId);
    }
  }
  generationIds.delete(job.generationId);
  return [...generationIds].sort();
}

async function deleteRetrievalDescriptionArtifacts(
  transaction: CatalogIngestionTransaction,
  generationId: string,
): Promise<void> {
  while (true) {
    const rows = await transaction
      .select({ id: retrievalDescriptionArtifacts.id })
      .from(retrievalDescriptionArtifacts)
      .where(eq(retrievalDescriptionArtifacts.generationId, generationId))
      .limit(PUBLICATION_CLEANUP_BATCH_SIZE);
    const ids: string[] = [];
    for (const row of rows) {
      ids.push(row.id);
    }
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

async function deleteOrphanedTemporaryArtifacts(
  transaction: CatalogIngestionTransaction,
  documentId: string,
): Promise<void> {
  await deleteOrphanedRetrievalDescriptionArtifacts(transaction, documentId);
}

async function deleteOrphanedRetrievalDescriptionArtifacts(
  transaction: CatalogIngestionTransaction,
  documentId: string,
): Promise<void> {
  while (true) {
    const protectedIngestionGeneration = transaction
      .select({ generationId: ingestionJobs.generationId })
      .from(ingestionJobs)
      .where(and(
        eq(ingestionJobs.documentId, documentId),
        eq(
          ingestionJobs.generationId,
          retrievalDescriptionArtifacts.generationId,
        ),
      ));
    const protectedIndexedGeneration = transaction
      .select({ generationId: indexedDocumentSpaces.generationId })
      .from(indexedDocumentSpaces)
      .where(and(
        eq(indexedDocumentSpaces.documentId, documentId),
        eq(
          indexedDocumentSpaces.generationId,
          retrievalDescriptionArtifacts.generationId,
        ),
      ));
    const condition = and(
      eq(retrievalDescriptionArtifacts.documentId, documentId),
      notExists(protectedIngestionGeneration),
      notExists(protectedIndexedGeneration),
    );
    const rows = await transaction
      .select({ generationId: retrievalDescriptionArtifacts.generationId })
      .from(retrievalDescriptionArtifacts)
      .where(condition)
      .limit(1);
    const generationId = rows[0]?.generationId;
    if (generationId === undefined) {
      return;
    }
    await deleteRetrievalDescriptionArtifacts(transaction, generationId);
  }
}

async function readPromotableJob(
  transaction: CatalogIngestionTransaction,
  sourceFile: string,
  ownerId: string,
): Promise<IngestionJob> {
  const rows = await transaction
    .select()
    .from(ingestionJobs)
    .where(eq(ingestionJobs.sourceFile, sourceFile))
    .limit(1)
    .for("update");
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Ingestion job does not exist: ${sourceFile}`);
  }
  const job = decodeIngestionJob(row);
  if (
    job.phase !== "indexed"
    || job.state !== "running"
    || job.ownerId !== ownerId
    || job.controlState !== "active"
  ) {
    throw new Error(
      `Cannot promote an unclaimed ${job.phase} job for ${sourceFile}.`,
    );
  }
  return job;
}

async function readPreviousIndexedDocument(
  transaction: CatalogIngestionTransaction,
  sourceFile: string,
): Promise<IndexedDocument | null> {
  const rows = await transaction
    .select()
    .from(indexedDocuments)
    .where(eq(indexedDocuments.sourceFile, sourceFile))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return decodeIndexedDocument(row);
}

async function persistDocumentVersion(
  transaction: CatalogIngestionTransaction,
  job: IngestionJob,
  indexedAt: Date,
): Promise<string> {
  const versionRows = await transaction
    .select({ version: documentVersions.version })
    .from(documentVersions)
    .where(eq(documentVersions.sourceFile, job.sourceFile))
    .orderBy(desc(documentVersions.version))
    .limit(1);
  const version = (versionRows[0]?.version ?? 0) + 1;
  const versionId = randomUUID();
  await transaction.insert(documentVersions).values({
    createdAt: indexedAt,
    documentId: job.documentId,
    elementSetId: requireElementSetId(job),
    fileExtension: job.format.extension,
    generationId: job.generationId,
    id: versionId,
    images: job.images,
    mediaType: job.format.mediaType,
    pageCount: job.pageCount,
    sourceFile: job.sourceFile,
    tables: job.tables,
    textChunks: job.textChunks,
    totalElements: job.totalElements,
    version,
  });
  return versionId;
}

async function persistIndexedDocument(
  transaction: CatalogIngestionTransaction,
  job: IngestionJob,
  indexedAt: Date,
  versionId: string,
): Promise<IndexedDocument> {
  const values = buildIndexedValues(job, indexedAt, versionId);
  const rows = await transaction
    .insert(indexedDocuments)
    .values(values)
    .onConflictDoUpdate({
      set: values,
      target: indexedDocuments.sourceFile,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`Indexed document was not persisted: ${job.sourceFile}`);
  }
  return decodeIndexedDocument(row);
}

async function synchronizeIndexedDocumentSpace(
  transaction: CatalogIngestionTransaction,
  job: IngestionJob,
  indexedAt: Date,
): Promise<void> {
  await transaction
    .delete(indexedDocumentSpaces)
    .where(
      and(
        eq(indexedDocumentSpaces.sourceFile, job.sourceFile),
        ne(indexedDocumentSpaces.documentId, job.documentId),
      ),
    );
  const values: typeof indexedDocumentSpaces.$inferInsert = {
    documentId: job.documentId,
    embeddingSpaceId: job.embeddingSpaceId,
    generationId: job.generationId,
    indexedAt,
    sourceFile: job.sourceFile,
  };
  await transaction
    .insert(indexedDocumentSpaces)
    .values(values)
    .onConflictDoUpdate({
      set: values,
      target: [
        indexedDocumentSpaces.sourceFile,
        indexedDocumentSpaces.embeddingSpaceId,
      ],
    });
}

function buildResetJob(
  request: PrepareIngestionRequest,
  tags: string[],
  updatedAt: Date,
): typeof ingestionJobs.$inferInsert {
  return {
    attemptCount: 0,
    documentId: request.documentId,
    elementSetId: null,
    embeddingSpaceId: request.embeddingSpaceId,
    errorMessage: null,
    fileExtension: request.format.extension,
    generationId: randomUUID(),
    images: 0,
    leaseExpiresAt: null,
    maxAttempts: request.maxAttempts,
    mediaType: request.format.mediaType,
    nextAttemptAt: updatedAt,
    ownerId: null,
    pageCount: null,
    phase: "discovered",
    controlError: null,
    controlState: "active",
    uploadedByUserId: request.uploadedByUserId,
    sourceFile: request.sourceFile,
    state: "pending",
    tables: 0,
    tags,
    textChunks: 0,
    totalElements: 0,
    updatedAt,
  };
}

function haveSameDocumentFormat(
  left: DocumentFormat,
  right: DocumentFormat,
): boolean {
  return left.extension === right.extension
    && left.mediaType === right.mediaType;
}

function isSameIngestionRequest(
  job: IngestionJob,
  request: PrepareIngestionRequest,
): boolean {
  return job.documentId === request.documentId
    && job.embeddingSpaceId === request.embeddingSpaceId
    && haveSameDocumentFormat(job.format, request.format);
}

function buildDoclingPartialsResetJob(
  resetJob: typeof ingestionJobs.$inferInsert,
): typeof ingestionJobs.$inferInsert {
  return {
    ...resetJob,
    doclingAttemptConfig: null,
    doclingRunId: null,
    doclingServiceInstanceId: null,
    doclingServiceSlot: null,
  };
}

function buildIndexedValues(
  job: IngestionJob,
  indexedAt: Date,
  versionId: string,
): typeof indexedDocuments.$inferInsert {
  return {
    documentId: job.documentId,
    elementSetId: requireElementSetId(job),
    generationId: job.generationId,
    images: job.images,
    indexedAt,
    pageCount: job.pageCount,
    sourceFile: job.sourceFile,
    tables: job.tables,
    tags: job.tags,
    textChunks: job.textChunks,
    totalElements: job.totalElements,
    versionId,
  };
}

function requireElementSetId(job: IngestionJob): string {
  if (job.elementSetId === null) {
    throw new Error(`Ingestion job has no completed element set: ${job.sourceFile}.`);
  }
  return job.elementSetId;
}
