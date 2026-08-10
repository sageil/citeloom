import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { isDeepStrictEqual } from "node:util";

import {
  and,
  asc,
  eq,
  gt,
  inArray,
  lte,
  notExists,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type { SourceContentConfig } from "../../config/index.js";
import type { CiteLoomDatabase } from "../../database/client.js";
import {
  applicationSettings,
  chatCitationRecords,
  chatEvidenceDocuments,
  documentVersions,
  indexedDocuments,
  ingestionJobs,
  sourceContentDeletions,
  sourceDocuments,
} from "../../database/schema.js";
import { contentIdSchema } from "../../domain/validation.js";
import { sanitizeDiagnosticMessage } from "../../observability/application-errors.js";
import { parseStoredApplicationSettings } from "../../providers/settings-persistence.js";
import {
  createSourceContentBackend,
} from "./source-content-backend.js";
import {
  type SourceContentBackend,
  SourceContentMissingError,
} from "./source-content-backend-contract.js";

const sourceDocumentMetadataSchema = z.object({
  byteLength: z.number().int().positive(),
  documentId: contentIdSchema,
  lastPublishedAt: z.date(),
});

const sourceContentDeletionSchema = z.object({
  documentId: contentIdSchema,
});
const applicationSettingsSourceContentRowSchema = z.object({
  settings: z.unknown(),
});

const SOURCE_CONTENT_ALGORITHM = "sha256";
const RECONCILIATION_BATCH_SIZE = 100;
const UNREFERENCED_CONTENT_GRACE_MS = 60 * 60 * 1_000;
const orphanScanAtByBackend = new Map<string, number>();

export interface StoredSourceDocument {
  content: Buffer;
  documentId: string;
}

export interface StoredSourceDocumentReference {
  byteLength: number;
  documentId: string;
  openContent: (abortSignal?: AbortSignal) => Promise<Readable>;
}

export interface StagedSourceContent {
  byteLength: number;
  documentId: string;
  sourceFile: string;
}

export interface SourceContentDeletionReport {
  deleted: number;
  failed: number;
  retained: number;
}

export type SourceContentDeletionErrorReporter = (
  error: unknown,
  documentId: string,
) => Promise<void>;

type SourceContentTransaction = Parameters<
  Parameters<CiteLoomDatabase["transaction"]>[0]
>[0];

export class SourceContentStore {
  private initialized = false;
  private readonly backend: SourceContentBackend;

  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly config: SourceContentConfig,
    private readonly reportDeletionError: SourceContentDeletionErrorReporter
      | null = null,
    backend?: SourceContentBackend,
  ) {
    this.backend = backend ?? createSourceContentBackend(config);
  }

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.backend.initialize();
    this.initialized = true;
  }

  public async writeDocument(document: StoredSourceDocument): Promise<void> {
    const normalized = readStoredSourceDocument(document);
    await this.publishSourceContent({
      byteLength: normalized.content.byteLength,
      content: normalized.content,
      documentId: normalized.documentId,
      kind: "buffer",
    });
  }

  public async publishStagedDocument(
    document: StagedSourceContent,
  ): Promise<void> {
    const normalized = readStagedSourceContent(document);
    await this.publishSourceContent({
      ...normalized,
      kind: "file",
    });
  }

  public async assertStoredDocumentsPresent(): Promise<number> {
    return this.inspectStoredDocuments();
  }

  public async readDocument(documentId: string): Promise<StoredSourceDocument> {
    const metadata = await this.readDocumentMetadata(documentId);
    const content = await this.backend.read(metadata);
    const actualDocumentId = createHash(SOURCE_CONTENT_ALGORITHM)
      .update(content)
      .digest("hex");
    if (actualDocumentId !== metadata.documentId) {
      throw new Error(
        `Stored source document hash does not match: ${metadata.documentId}`,
      );
    }
    return {
      content,
      documentId: metadata.documentId,
    };
  }

  public async readDocumentReference(
    documentId: string,
  ): Promise<StoredSourceDocumentReference> {
    const metadata = await this.readDocumentMetadata(documentId);
    await this.backend.assertPresent(metadata);
    return {
      byteLength: metadata.byteLength,
      documentId: metadata.documentId,
      openContent: async (abortSignal?: AbortSignal) => {
        return this.backend.openRead(metadata, abortSignal);
      },
    };
  }

  public async reconcilePendingDeletions(): Promise<SourceContentDeletionReport> {
    await this.reconcileOrphanedContent();
    await this.queueAbandonedContent();
    const rows = await this.database
      .select({ documentId: sourceContentDeletions.documentId })
      .from(sourceContentDeletions)
      .orderBy(asc(sourceContentDeletions.requestedAt))
      .limit(RECONCILIATION_BATCH_SIZE);
    const report: SourceContentDeletionReport = {
      deleted: 0,
      failed: 0,
      retained: 0,
    };
    for (const row of rows) {
      const deletion = sourceContentDeletionSchema.parse(row);
      try {
        const result = await this.reconcileDeletion(deletion.documentId);
        if (result === "deleted") {
          report.deleted += 1;
        } else {
          report.retained += 1;
        }
      } catch (error: unknown) {
        report.failed += 1;
        await this.recordDeletionFailure(deletion.documentId, error);
      }
    }
    return report;
  }

  public async reconcileDocumentDeletion(documentId: string): Promise<void> {
    const normalizedDocumentId = readDocumentId(documentId);
    try {
      await this.reconcileDeletion(normalizedDocumentId);
    } catch (error: unknown) {
      await this.recordDeletionFailure(normalizedDocumentId, error);
      throw error;
    }
  }

  private async inspectStoredDocuments(): Promise<number> {
    await this.initialize();
    let afterDocumentId: string | null = null;
    let verifiedDocumentCount = 0;
    while (true) {
      const rows = await this.readVerificationBatch(afterDocumentId);
      if (rows.length === 0) {
        return verifiedDocumentCount;
      }
      for (const metadata of rows) {
        await this.backend.assertPresent(metadata);
        afterDocumentId = metadata.documentId;
        verifiedDocumentCount += 1;
      }
    }
  }

  private async publishSourceContent(
    document:
      | {
          byteLength: number;
          content: Buffer;
          documentId: string;
          kind: "buffer";
        }
      | {
          byteLength: number;
          documentId: string;
          kind: "file";
          sourceFile: string;
        },
  ): Promise<void> {
    await this.initialize();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await this.backend.publish(document);
      try {
        await this.backend.verify(document);
      } catch (error: unknown) {
        try {
          await this.removeUnpublishedContent(document.documentId);
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            `Source content verification and cleanup failed: ${document.documentId}`,
          );
        }
        throw error;
      }
      try {
        await this.database.transaction(async (transaction) => {
          await lockSourceContentWrites(transaction);
          await assertActiveSourceContentBackend(transaction, this.config);
          await lockSourceContent(transaction, document.documentId);
          await this.backend.assertPresent(document);
          const existing = await readSourceDocumentMetadataIfPresent(
            transaction,
            document.documentId,
          );
          if (existing !== null && existing.byteLength !== document.byteLength) {
            throw new Error(
              `Source content metadata conflicts for ${document.documentId}.`,
            );
          }
          if (existing === null) {
            await transaction.insert(sourceDocuments).values({
              byteLength: document.byteLength,
              documentId: document.documentId,
              lastPublishedAt: sql`clock_timestamp()`,
            });
          } else {
            await transaction
              .update(sourceDocuments)
              .set({ lastPublishedAt: sql`clock_timestamp()` })
              .where(eq(sourceDocuments.documentId, document.documentId));
          }
          await transaction
            .delete(sourceContentDeletions)
            .where(eq(sourceContentDeletions.documentId, document.documentId));
        });
        return;
      } catch (error: unknown) {
        if (error instanceof SourceContentBackendChangedError) {
          await this.removeUnpublishedContent(document.documentId);
          throw error;
        }
        if (!(error instanceof SourceContentMissingError) || attempt > 0) {
          throw error;
        }
      }
    }
  }

  private async removeUnpublishedContent(documentId: string): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await lockSourceContent(transaction, documentId);
      const existing = await readSourceDocumentMetadataIfPresent(
        transaction,
        documentId,
      );
      if (existing === null) {
        await this.backend.remove(documentId);
      }
    });
  }

  private async readDocumentMetadata(
    documentId: string,
  ): Promise<z.output<typeof sourceDocumentMetadataSchema>> {
    const normalizedDocumentId = readDocumentId(documentId);
    const rows = await this.database
      .select({
        byteLength: sourceDocuments.byteLength,
        documentId: sourceDocuments.documentId,
        lastPublishedAt: sourceDocuments.lastPublishedAt,
      })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.documentId, normalizedDocumentId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new SourceContentMissingError(normalizedDocumentId);
    }
    return readSourceDocumentMetadata(row, normalizedDocumentId);
  }

  private async readVerificationBatch(
    afterDocumentId: string | null,
  ): Promise<z.output<typeof sourceDocumentMetadataSchema>[]> {
    const selection = {
      byteLength: sourceDocuments.byteLength,
      documentId: sourceDocuments.documentId,
      lastPublishedAt: sourceDocuments.lastPublishedAt,
    };
    if (afterDocumentId === null) {
      const rows = await this.database
        .select(selection)
        .from(sourceDocuments)
        .orderBy(asc(sourceDocuments.documentId))
        .limit(RECONCILIATION_BATCH_SIZE);
      return readSourceDocumentMetadataRows(rows);
    }
    const rows = await this.database
      .select(selection)
      .from(sourceDocuments)
      .where(gt(sourceDocuments.documentId, afterDocumentId))
      .orderBy(asc(sourceDocuments.documentId))
      .limit(RECONCILIATION_BATCH_SIZE);
    return readSourceDocumentMetadataRows(rows);
  }

  private async reconcileDeletion(
    documentId: string,
  ): Promise<"deleted" | "retained"> {
    const prepared = await this.database.transaction(async (transaction) => {
      await lockSourceContentWrites(transaction);
      await assertActiveSourceContentBackend(transaction, this.config);
      await lockSourceContent(transaction, documentId);
      const existing = await readSourceDocumentMetadataIfPresent(
        transaction,
        documentId,
      );
      if (
        existing !== null
        && await hasSourceContentReferences(transaction, documentId)
      ) {
        await transaction
          .delete(sourceContentDeletions)
          .where(eq(sourceContentDeletions.documentId, documentId));
        return "retained";
      }
      if (
        existing !== null
        && !isOlderThanContentGracePeriod(existing.lastPublishedAt)
      ) {
        return "retained";
      }
      await transaction
        .delete(sourceDocuments)
        .where(eq(sourceDocuments.documentId, documentId));
      return "delete";
    });
    if (prepared === "retained") {
      return "retained";
    }

    return this.database.transaction(async (transaction) => {
      await lockSourceContentWrites(transaction);
      await assertActiveSourceContentBackend(transaction, this.config);
      await lockSourceContent(transaction, documentId);
      const existing = await readSourceDocumentMetadataIfPresent(
        transaction,
        documentId,
      );
      if (existing !== null) {
        await transaction
          .delete(sourceContentDeletions)
          .where(eq(sourceContentDeletions.documentId, documentId));
        return "retained";
      }
      await this.backend.remove(documentId);
      await transaction
        .delete(sourceContentDeletions)
        .where(eq(sourceContentDeletions.documentId, documentId));
      return "deleted";
    });
  }

  private async queueAbandonedContent(): Promise<void> {
    const cutoff = new Date(Date.now() - UNREFERENCED_CONTENT_GRACE_MS);
    await this.database.transaction(async (transaction) => {
      const orphanedChatEvidence = await transaction
        .select({
          documentId: chatEvidenceDocuments.documentId,
          documentVersionId: chatEvidenceDocuments.documentVersionId,
        })
        .from(chatEvidenceDocuments)
        .where(notExists(
          transaction
            .select({ id: chatCitationRecords.id })
            .from(chatCitationRecords)
            .where(eq(
              chatCitationRecords.documentVersionId,
              chatEvidenceDocuments.documentVersionId,
            )),
        ))
        .orderBy(asc(chatEvidenceDocuments.createdAt))
        .limit(RECONCILIATION_BATCH_SIZE);
      const orphanedDocumentIds = [
        ...new Set(orphanedChatEvidence.map((row) => row.documentId)),
      ].sort();
      for (const documentId of orphanedDocumentIds) {
        await lockSourceContent(transaction, documentId);
      }
      const orphanedVersionIds = orphanedChatEvidence.map((row) => {
        return row.documentVersionId;
      });
      if (orphanedVersionIds.length > 0) {
        await transaction
          .delete(chatEvidenceDocuments)
          .where(and(
            inArray(chatEvidenceDocuments.documentVersionId, orphanedVersionIds),
            notExists(
              transaction
                .select({ id: chatCitationRecords.id })
                .from(chatCitationRecords)
                .where(eq(
                  chatCitationRecords.documentVersionId,
                  chatEvidenceDocuments.documentVersionId,
                )),
            ),
          ));
      }
      const rows = await transaction
        .select({ documentId: sourceDocuments.documentId })
        .from(sourceDocuments)
        .where(and(
          lte(sourceDocuments.lastPublishedAt, cutoff),
          notExists(
            transaction
              .select({ documentId: ingestionJobs.documentId })
              .from(ingestionJobs)
              .where(eq(ingestionJobs.documentId, sourceDocuments.documentId)),
          ),
          notExists(
            transaction
              .select({ documentId: indexedDocuments.documentId })
              .from(indexedDocuments)
              .where(eq(indexedDocuments.documentId, sourceDocuments.documentId)),
          ),
          notExists(
            transaction
              .select({ documentId: documentVersions.documentId })
              .from(documentVersions)
              .where(eq(documentVersions.documentId, sourceDocuments.documentId)),
          ),
          notExists(
            transaction
              .select({ documentId: chatEvidenceDocuments.documentId })
              .from(chatEvidenceDocuments)
              .where(eq(
                chatEvidenceDocuments.documentId,
                sourceDocuments.documentId,
              )),
          ),
        ))
        .orderBy(asc(sourceDocuments.lastPublishedAt))
        .limit(RECONCILIATION_BATCH_SIZE);
      for (const row of rows) {
        await queueSourceContentDeletion(transaction, row.documentId);
      }
    });
  }

  private async reconcileOrphanedContent(): Promise<void> {
    const nowMs = Date.now();
    const lastScanAtMs = orphanScanAtByBackend.get(this.backend.identity) ?? 0;
    if (nowMs - lastScanAtMs < UNREFERENCED_CONTENT_GRACE_MS) {
      return;
    }
    orphanScanAtByBackend.set(this.backend.identity, nowMs);
    await this.backend.reconcileOrphans({
      graceMs: UNREFERENCED_CONTENT_GRACE_MS,
      limit: RECONCILIATION_BATCH_SIZE,
      nowMs,
      removeIfOrphan: async (documentId, remove) => {
        return this.database.transaction(async (transaction) => {
          await lockSourceContentWrites(transaction);
          await assertActiveSourceContentBackend(transaction, this.config);
          await lockSourceContent(transaction, documentId);
          const metadata = await readSourceDocumentMetadataIfPresent(
            transaction,
            documentId,
          );
          if (metadata !== null) {
            return false;
          }
          await remove();
          return true;
        });
      },
    });
  }

  private async recordDeletionFailure(
    documentId: string,
    error: unknown,
  ): Promise<void> {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = sanitizeDiagnosticMessage(rawMessage);
    await this.database
      .update(sourceContentDeletions)
      .set({
        attemptCount: sql`${sourceContentDeletions.attemptCount} + 1`,
        lastAttemptAt: new Date(),
        lastError: message,
      })
      .where(eq(sourceContentDeletions.documentId, documentId));
    await this.reportDeletionError?.(error, documentId);
  }
}

export class SourceContentBackendChangedError extends Error {
  public constructor() {
    super(
      "Source-content storage changed while the document was being published. Retry the upload.",
    );
    this.name = "SourceContentBackendChangedError";
  }
}

async function lockSourceContentWrites(
  transaction: SourceContentTransaction,
): Promise<void> {
  await transaction.execute(
    sql`LOCK TABLE ${sourceDocuments} IN ROW EXCLUSIVE MODE`,
  );
}

async function assertActiveSourceContentBackend(
  transaction: SourceContentTransaction,
  expectedConfig: SourceContentConfig,
): Promise<void> {
  const rows = await transaction
    .select({ settings: applicationSettings.settings })
    .from(applicationSettings)
    .where(eq(applicationSettings.id, "runtime"))
    .limit(1);
  const decoded = applicationSettingsSourceContentRowSchema.safeParse(rows[0]);
  if (!decoded.success) {
    throw new Error(
      `Invalid application settings while publishing source content: ${decoded.error.message}`,
    );
  }
  const stored = parseStoredApplicationSettings(decoded.data.settings);
  if (!isDeepStrictEqual(stored.sourceContent, expectedConfig)) {
    throw new SourceContentBackendChangedError();
  }
}

export async function queueSourceContentDeletion(
  transaction: SourceContentTransaction,
  documentId: string,
): Promise<void> {
  const normalizedDocumentId = readDocumentId(documentId);
  await lockSourceContent(transaction, normalizedDocumentId);
  await transaction
    .insert(sourceContentDeletions)
    .values({ documentId: normalizedDocumentId })
    .onConflictDoNothing({ target: sourceContentDeletions.documentId });
  const metadata = await readSourceDocumentMetadataIfPresent(
    transaction,
    normalizedDocumentId,
  );
  if (metadata === null) {
    return;
  }
  if (await hasSourceContentReferences(transaction, normalizedDocumentId)) {
    await transaction
      .delete(sourceContentDeletions)
      .where(eq(sourceContentDeletions.documentId, normalizedDocumentId));
    return;
  }
}

export async function lockSourceContentReference(
  transaction: SourceContentTransaction,
  documentId: string,
): Promise<void> {
  await lockSourceContent(transaction, readDocumentId(documentId));
}

async function hasSourceContentReferences(
  transaction: SourceContentTransaction,
  documentId: string,
): Promise<boolean> {
  const job = await transaction
    .select({ documentId: ingestionJobs.documentId })
    .from(ingestionJobs)
    .where(eq(ingestionJobs.documentId, documentId))
    .limit(1);
  if (job.length > 0) {
    return true;
  }
  const indexed = await transaction
    .select({ documentId: indexedDocuments.documentId })
    .from(indexedDocuments)
    .where(eq(indexedDocuments.documentId, documentId))
    .limit(1);
  if (indexed.length > 0) {
    return true;
  }
  const version = await transaction
    .select({ documentId: documentVersions.documentId })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, documentId))
    .limit(1);
  if (version.length > 0) {
    return true;
  }
  const chatEvidence = await transaction
    .select({ documentId: chatEvidenceDocuments.documentId })
    .from(chatEvidenceDocuments)
    .where(eq(chatEvidenceDocuments.documentId, documentId))
    .limit(1);
  return chatEvidence.length > 0;
}

async function lockSourceContent(
  transaction: SourceContentTransaction,
  documentId: string,
): Promise<void> {
  const lockIdentity = `source-content:${documentId}`;
  await transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${lockIdentity}, 0))`,
  );
}

async function readSourceDocumentMetadataIfPresent(
  transaction: SourceContentTransaction,
  documentId: string,
): Promise<z.output<typeof sourceDocumentMetadataSchema> | null> {
  const rows = await transaction
    .select({
      byteLength: sourceDocuments.byteLength,
      documentId: sourceDocuments.documentId,
      lastPublishedAt: sourceDocuments.lastPublishedAt,
    })
    .from(sourceDocuments)
    .where(eq(sourceDocuments.documentId, documentId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return readSourceDocumentMetadata(row, documentId);
}

function readSourceDocumentMetadata(
  value: unknown,
  documentId: string,
): z.output<typeof sourceDocumentMetadataSchema> {
  const result = sourceDocumentMetadataSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Stored source document metadata is invalid: ${documentId}`);
  }
  return result.data;
}

function readSourceDocumentMetadataRows(
  rows: readonly unknown[],
): z.output<typeof sourceDocumentMetadataSchema>[] {
  const documents: z.output<typeof sourceDocumentMetadataSchema>[] = [];
  for (const row of rows) {
    documents.push(
      readSourceDocumentMetadata(row, "source content verification"),
    );
  }
  return documents;
}

function readStoredSourceDocument(
  value: StoredSourceDocument,
): StoredSourceDocument {
  const documentId = readDocumentId(value.documentId);
  if (value.content.byteLength <= 0) {
    throw new Error("Source content must not be empty.");
  }
  const actualDocumentId = createHash(SOURCE_CONTENT_ALGORITHM)
    .update(value.content)
    .digest("hex");
  if (actualDocumentId !== documentId) {
    throw new Error(`Source content hash does not match: ${documentId}`);
  }
  return { content: value.content, documentId };
}

function readStagedSourceContent(
  value: StagedSourceContent,
): StagedSourceContent {
  const result = z.object({
    byteLength: z.number().int().positive(),
    documentId: contentIdSchema,
    sourceFile: z.string().min(1),
  }).safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid staged source content: ${result.error.message}`);
  }
  return result.data;
}

function readDocumentId(value: string): string {
  return contentIdSchema.parse(value);
}

function isOlderThanContentGracePeriod(lastPublishedAt: Date): boolean {
  return Date.now() - lastPublishedAt.getTime()
    >= UNREFERENCED_CONTENT_GRACE_MS;
}
