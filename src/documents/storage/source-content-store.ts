import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  createReadStream,
  createWriteStream,
  type Stats,
} from "node:fs";
import {
  link,
  mkdir,
  open,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import {
  and,
  asc,
  eq,
  gt,
  inArray,
  like,
  lte,
  notExists,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type { SourceContentConfig } from "../../config/index.js";
import type { CiteLoomDatabase } from "../../database/client.js";
import {
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

const sourceDocumentMetadataSchema = z.object({
  byteLength: z.number().int().positive(),
  documentId: contentIdSchema,
  lastPublishedAt: z.date(),
});

const sourceContentDeletionSchema = z.object({
  documentId: contentIdSchema,
});

const SOURCE_CONTENT_ALGORITHM = "sha256";
const RECONCILIATION_BATCH_SIZE = 100;
const UNREFERENCED_CONTENT_GRACE_MS = 60 * 60 * 1_000;
const contentDirectoryPattern = /^[0-9a-f]{2}$/u;
const temporaryContentPattern =
  /^(?:\.write-probe-[0-9a-f-]+|(?:[0-9a-f]{64}\.)?[0-9a-f-]+\.(?:staged|tmp))$/u;
const orphanScanAtByDirectory = new Map<string, number>();

export interface StoredSourceDocument {
  content: Buffer;
  documentId: string;
}

export interface StoredSourceDocumentReference {
  byteLength: number;
  contentPath: string;
  documentId: string;
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

  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly config: SourceContentConfig,
    private readonly reportDeletionError: SourceContentDeletionErrorReporter
      | null = null,
  ) {}

  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    await mkdir(this.algorithmDirectory(), { recursive: true });
    const probePath = join(
      this.algorithmDirectory(),
      `.write-probe-${randomUUID()}`,
    );
    const handle = await open(
      probePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    try {
      await handle.writeFile("ready");
      await handle.sync();
    } finally {
      try {
        await handle.close();
      } finally {
        await removeFileIfPresent(probePath);
      }
    }
    this.initialized = true;
  }

  public async writeDocument(document: StoredSourceDocument): Promise<void> {
    const normalized = readStoredSourceDocument(document);
    const temporaryPath = await this.writeTemporaryContent(normalized.content);
    try {
      await this.publishSourceContent({
        byteLength: normalized.content.byteLength,
        documentId: normalized.documentId,
        sourceFile: temporaryPath,
      });
    } finally {
      await removeFileIfPresent(temporaryPath);
    }
  }

  public async verifyStoredDocuments(): Promise<number> {
    return this.inspectStoredDocuments(true);
  }

  public async assertStoredDocumentsPresent(): Promise<number> {
    return this.inspectStoredDocuments(false);
  }

  private async inspectStoredDocuments(
    verifyHashes: boolean,
  ): Promise<number> {
    await this.initialize();
    let afterDocumentId: string | null = null;
    let verifiedDocumentCount = 0;
    while (true) {
      const rows = await this.readVerificationBatch(afterDocumentId);
      if (rows.length === 0) {
        return verifiedDocumentCount;
      }
      for (const metadata of rows) {
        if (verifyHashes) {
          await this.verifyPublishedContent(metadata);
        } else {
          await this.assertPublishedContent(metadata);
        }
        afterDocumentId = metadata.documentId;
        verifiedDocumentCount += 1;
      }
    }
  }

  public async publishStagedDocument(
    document: StagedSourceContent,
  ): Promise<void> {
    const normalized = readStagedSourceContent(document);
    await this.publishSourceContent(normalized);
  }

  public async readDocument(documentId: string): Promise<StoredSourceDocument> {
    const metadata = await this.readDocumentMetadata(documentId);
    const contentPath = this.contentPath(metadata.documentId);
    let content: Buffer;
    try {
      content = await readFile(contentPath);
    } catch (error: unknown) {
      if (readFileSystemErrorCode(error) !== "ENOENT") {
        throw error;
      }
      throw new Error(
        `Stored source document is missing or invalid: ${metadata.documentId}`,
      );
    }
    if (content.byteLength !== metadata.byteLength) {
      throw new Error(
        `Stored source document length does not match: ${metadata.documentId}`,
      );
    }
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
    await this.assertPublishedContent(metadata);
    return {
      byteLength: metadata.byteLength,
      contentPath: this.contentPath(metadata.documentId),
      documentId: metadata.documentId,
    };
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
      throw new Error(
        `Stored source document is missing or invalid: ${normalizedDocumentId}`,
      );
    }
    return readSourceDocumentMetadata(row, normalizedDocumentId);
  }

  public async reconcilePendingDeletions(): Promise<SourceContentDeletionReport> {
    await this.reconcileOrphanedFiles();
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

  private algorithmDirectory(): string {
    return join(this.config.directory, SOURCE_CONTENT_ALGORITHM);
  }

  private contentPath(documentId: string): string {
    return join(
      this.algorithmDirectory(),
      documentId.slice(0, 2),
      documentId,
    );
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

  private async publishSourceContent(
    document: StagedSourceContent,
  ): Promise<void> {
    await this.syncFile(document.sourceFile);
    const stagedMetadata = await stat(document.sourceFile);
    if (!stagedMetadata.isFile()) {
      throw new Error(`Staged source content is not a file: ${document.sourceFile}`);
    }
    if (stagedMetadata.size !== document.byteLength) {
      throw new Error(`Staged source content changed: ${document.sourceFile}`);
    }

    await this.database.transaction(async (transaction) => {
      await lockSourceContent(transaction, document.documentId);
      const existing = await readSourceDocumentMetadataIfPresent(
        transaction,
        document.documentId,
      );
      if (existing !== null) {
        if (existing.byteLength !== document.byteLength) {
          throw new Error(
            `Source content metadata conflicts for ${document.documentId}.`,
          );
        }
        await this.verifyPublishedContent(existing);
        await transaction
          .update(sourceDocuments)
          .set({ lastPublishedAt: new Date() })
          .where(eq(sourceDocuments.documentId, document.documentId));
        await transaction
          .delete(sourceContentDeletions)
          .where(eq(sourceContentDeletions.documentId, document.documentId));
        return;
      }

      await this.publishFile(document);
      await transaction
        .insert(sourceDocuments)
        .values({
          byteLength: document.byteLength,
          documentId: document.documentId,
        });
      await transaction
        .delete(sourceContentDeletions)
        .where(eq(sourceContentDeletions.documentId, document.documentId));
    });
  }

  private async publishFile(document: StagedSourceContent): Promise<void> {
    const destination = this.contentPath(document.documentId);
    const destinationDirectory = join(
      this.algorithmDirectory(),
      document.documentId.slice(0, 2),
    );
    await mkdir(destinationDirectory, { recursive: true });
    try {
      await link(document.sourceFile, destination);
      await this.syncDirectory(destinationDirectory);
      return;
    } catch (error: unknown) {
      const code = readFileSystemErrorCode(error);
      if (code === "EEXIST") {
        await this.verifyPublishedContent(document);
        return;
      }
      if (code !== "EXDEV") {
        throw error;
      }
    }

    const temporaryPath = `${destination}.${randomUUID()}.tmp`;
    let published = false;
    try {
      await pipeline(
        createReadStream(document.sourceFile),
        createWriteStream(temporaryPath, {
          flags: "wx",
          mode: 0o600,
        }),
      );
      await this.syncFile(temporaryPath);
      try {
        await link(temporaryPath, destination);
        published = true;
      } catch (error: unknown) {
        if (readFileSystemErrorCode(error) !== "EEXIST") {
          throw error;
        }
      }
    } finally {
      await removeFileIfPresent(temporaryPath);
    }
    if (published) {
      await this.syncDirectory(destinationDirectory);
      return;
    }
    await this.verifyPublishedContent(document);
  }

  private async verifyPublishedContent(
    document: StagedSourceContent | z.output<typeof sourceDocumentMetadataSchema>,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const path = this.contentPath(document.documentId);
    await this.assertPublishedContent(document);
    const hash = createHash(SOURCE_CONTENT_ALGORITHM);
    await pipeline(createReadStream(path, { signal: abortSignal }), hash);
    const actualDocumentId = hash.digest("hex");
    if (actualDocumentId !== document.documentId) {
      throw new Error(
        `Published source content hash does not match: ${document.documentId}`,
      );
    }
  }

  private async assertPublishedContent(
    document: StagedSourceContent | z.output<typeof sourceDocumentMetadataSchema>,
  ): Promise<void> {
    const path = this.contentPath(document.documentId);
    let metadata: Stats;
    try {
      metadata = await stat(path);
    } catch (error: unknown) {
      if (readFileSystemErrorCode(error) !== "ENOENT") {
        throw error;
      }
      throw new Error(
        `Stored source document is missing or invalid: ${document.documentId}`,
      );
    }
    if (!metadata.isFile() || metadata.size !== document.byteLength) {
      throw new Error(
        `Published source content is missing or invalid: ${document.documentId}`,
      );
    }
  }

  private async writeTemporaryContent(content: Buffer): Promise<string> {
    await this.initialize();
    const path = join(
      this.algorithmDirectory(),
      `${randomUUID()}.staged`,
    );
    const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return path;
  }

  private async syncFile(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await open(path, constants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async syncDirectoryIfPresent(path: string): Promise<void> {
    try {
      await this.syncDirectory(path);
    } catch (error: unknown) {
      if (readFileSystemErrorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }

  private async reconcileDeletion(
    documentId: string,
  ): Promise<"deleted" | "retained"> {
    const prepared = await this.database.transaction(async (transaction) => {
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
      await removeFileIfPresent(this.contentPath(documentId));
      const contentDirectory = join(
        this.algorithmDirectory(),
        documentId.slice(0, 2),
      );
      await this.syncDirectoryIfPresent(contentDirectory);
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
            inArray(
              chatEvidenceDocuments.documentVersionId,
              orphanedVersionIds,
            ),
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

  private async reconcileOrphanedFiles(): Promise<void> {
    const nowMs = Date.now();
    const algorithmDirectory = this.algorithmDirectory();
    const lastScanAtMs = orphanScanAtByDirectory.get(algorithmDirectory) ?? 0;
    if (nowMs - lastScanAtMs < UNREFERENCED_CONTENT_GRACE_MS) {
      return;
    }
    orphanScanAtByDirectory.set(algorithmDirectory, nowMs);
    const rootEntries = await readdir(algorithmDirectory, {
      withFileTypes: true,
    });
    let reconciled = 0;
    for (const entry of rootEntries) {
      if (reconciled >= RECONCILIATION_BATCH_SIZE) {
        return;
      }
      const path = join(algorithmDirectory, entry.name);
      if (entry.isFile() && temporaryContentPattern.test(entry.name)) {
        if (await isOlderThanGracePeriod(path, nowMs)) {
          await removeFileIfPresent(path);
          reconciled += 1;
        }
        continue;
      }
      if (!entry.isDirectory() || !contentDirectoryPattern.test(entry.name)) {
        continue;
      }
      reconciled += await this.reconcileContentDirectory(
        path,
        entry.name,
        nowMs,
        RECONCILIATION_BATCH_SIZE - reconciled,
      );
    }
  }

  private async reconcileContentDirectory(
    directory: string,
    documentIdPrefix: string,
    nowMs: number,
    limit: number,
  ): Promise<number> {
    const entries = await readdir(directory, { withFileTypes: true });
    const metadataRows = await this.database
      .select({ documentId: sourceDocuments.documentId })
      .from(sourceDocuments)
      .where(like(sourceDocuments.documentId, `${documentIdPrefix}%`));
    const publishedDocumentIds = new Set(
      metadataRows.map((row) => row.documentId),
    );
    let reconciled = 0;
    for (const entry of entries) {
      if (reconciled >= limit) {
        return reconciled;
      }
      if (!entry.isFile()) {
        continue;
      }
      const path = join(directory, entry.name);
      if (temporaryContentPattern.test(entry.name)) {
        if (await isOlderThanGracePeriod(path, nowMs)) {
          await removeFileIfPresent(path);
          reconciled += 1;
        }
        continue;
      }
      const documentId = contentIdSchema.safeParse(entry.name);
      if (!documentId.success) {
        continue;
      }
      if (publishedDocumentIds.has(documentId.data)) {
        continue;
      }
      if (!await isOlderThanGracePeriod(path, nowMs)) {
        continue;
      }
      const removed = await this.removeOrphanedPublishedFile(
        documentId.data,
        path,
      );
      if (removed) {
        reconciled += 1;
      }
    }
    return reconciled;
  }

  private async removeOrphanedPublishedFile(
    documentId: string,
    path: string,
  ): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      await lockSourceContent(transaction, documentId);
      const metadata = await readSourceDocumentMetadataIfPresent(
        transaction,
        documentId,
      );
      if (metadata !== null) {
        return false;
      }
      await removeFileIfPresent(path);
      return true;
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
  if (!isOlderThanContentGracePeriod(metadata.lastPublishedAt)) {
    return;
  }
  await transaction
    .delete(sourceDocuments)
    .where(eq(sourceDocuments.documentId, normalizedDocumentId));
}

export async function lockSourceContentReference(
  transaction: SourceContentTransaction,
  documentId: string,
): Promise<void> {
  const normalizedDocumentId = readDocumentId(documentId);
  await lockSourceContent(transaction, normalizedDocumentId);
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
  return {
    content: value.content,
    documentId,
  };
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

async function removeFileIfPresent(path: string): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (error: unknown) {
    if (readFileSystemErrorCode(error) !== "ENOENT") {
      throw error;
    }
    return false;
  }
}

function readFileSystemErrorCode(error: unknown): string | null {
  const result = z.object({ code: z.string() }).safeParse(error);
  return result.success ? result.data.code : null;
}

async function isOlderThanGracePeriod(
  path: string,
  nowMs: number,
): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return nowMs - metadata.mtimeMs >= UNREFERENCED_CONTENT_GRACE_MS;
  } catch (error: unknown) {
    if (readFileSystemErrorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function isOlderThanContentGracePeriod(lastPublishedAt: Date): boolean {
  return Date.now() - lastPublishedAt.getTime()
    >= UNREFERENCED_CONTENT_GRACE_MS;
}
