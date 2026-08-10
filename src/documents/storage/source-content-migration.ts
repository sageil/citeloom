import { isDeepStrictEqual } from "node:util";

import { and, asc, eq, gt, gte, sql } from "drizzle-orm";
import { z } from "zod";

import type { SourceContentConfig } from "../../config/index.js";
import type { CiteLoomDatabase } from "../../database/client.js";
import {
  applicationSettings,
  sourceDocuments,
} from "../../database/schema.js";
import { contentIdSchema } from "../../domain/validation.js";
import {
  parseStoredApplicationSettings,
} from "../../providers/settings-persistence.js";
import { createSourceContentBackend } from "./source-content-backend.js";
import type {
  SourceContentBackend,
  SourceContentMetadata,
} from "./source-content-backend-contract.js";

export const SOURCE_CONTENT_MIGRATION_BATCH_SIZE = 100;

const sourceDocumentRowSchema = z.object({
  byteLength: z.number().int().positive(),
  documentId: contentIdSchema,
});

const applicationSettingsRowSchema = z.object({
  defaults: z.unknown(),
  settings: z.unknown(),
  version: z.number().int().positive(),
});

export interface SourceContentMigrationReport {
  copied: number;
  source: SourceContentConfig;
  target: SourceContentConfig;
  verifiedAtCutover: number;
}

export interface SourceContentMigrationOptions {
  abortSignal?: AbortSignal;
  reportProgress?: (message: string) => void;
}

export interface SourceContentCopyOptions {
  abortSignal?: AbortSignal;
  reportProgress?: (message: string) => void;
}

export type SourceContentMigrationDocument = SourceContentMetadata;

export async function copySourceContentObjects(
  database: CiteLoomDatabase,
  sourceConfig: SourceContentConfig,
  targetConfig: SourceContentConfig,
  options: SourceContentCopyOptions = {},
): Promise<number> {
  const result = await copyAndVerifySourceContent(
    database,
    sourceConfig,
    targetConfig,
    options,
  );
  return result.copied;
}

export async function migrateSourceContentBackend(
  database: CiteLoomDatabase,
  targetConfig: SourceContentConfig,
  options: SourceContentMigrationOptions = {},
): Promise<SourceContentMigrationReport> {
  const initialSettings = await readCurrentApplicationSettings(database);
  const sourceConfig = initialSettings.settings.sourceContent;
  if (isDeepStrictEqual(sourceConfig, targetConfig)) {
    throw new Error("Source-content storage already uses the requested backend.");
  }

  const copy = await copyAndVerifySourceContent(
    database,
    sourceConfig,
    targetConfig,
    options,
  );

  let verifiedAtCutover = 0;
  await database.transaction(async (transaction) => {
    await transaction.execute(
      sql`LOCK TABLE ${sourceDocuments} IN SHARE MODE`,
    );
    const lockedSettings = await readCurrentApplicationSettings(
      transaction as unknown as CiteLoomDatabase,
      true,
    );
    if (
      lockedSettings.version !== initialSettings.version
      || !isDeepStrictEqual(
        lockedSettings.settings.sourceContent,
        sourceConfig,
      )
    ) {
      throw new Error(
        "Application settings changed while source content was being copied.",
      );
    }

    await visitSourceContentDocuments(
      transaction as unknown as CiteLoomDatabase,
      options.abortSignal,
      async (document) => {
        await copy.target.verify(document, options.abortSignal);
        verifiedAtCutover += 1;
      },
    );
    options.abortSignal?.throwIfAborted();

    const defaults = {
      ...lockedSettings.defaults,
      sourceContent: targetConfig,
    };
    const settings = {
      ...lockedSettings.settings,
      sourceContent: targetConfig,
    };
    await transaction
      .update(applicationSettings)
      .set({
        defaults,
        settings,
        updatedAt: new Date(),
        version: lockedSettings.version + 1,
      })
      .where(eq(applicationSettings.id, "runtime"));
  });

  return {
    copied: copy.copied,
    source: sourceConfig,
    target: targetConfig,
    verifiedAtCutover,
  };
}

async function copyAndVerifySourceContent(
  database: CiteLoomDatabase,
  sourceConfig: SourceContentConfig,
  targetConfig: SourceContentConfig,
  options: SourceContentCopyOptions,
): Promise<{ copied: number; target: SourceContentBackend }> {
  const source = createSourceContentBackend(sourceConfig);
  const target = createSourceContentBackend(targetConfig);
  await source.initialize("read");
  await target.initialize();

  let copied = 0;
  await visitSourceContentDocuments(database, options.abortSignal, async (document) => {
    await copyAndVerifySourceContentDocument(
      source,
      target,
      document,
      options.abortSignal,
    );
    copied += 1;
    options.reportProgress?.(
      `Copied and verified ${copied} source-content objects.`,
    );
  });
  return { copied, target };
}

interface CurrentApplicationSettings {
  defaults: ReturnType<typeof parseStoredApplicationSettings>;
  settings: ReturnType<typeof parseStoredApplicationSettings>;
  version: number;
}

async function readCurrentApplicationSettings(
  database: CiteLoomDatabase,
  forUpdate: boolean = false,
): Promise<CurrentApplicationSettings> {
  const query = database
    .select({
      defaults: applicationSettings.defaults,
      settings: applicationSettings.settings,
      version: applicationSettings.version,
    })
    .from(applicationSettings)
    .where(eq(applicationSettings.id, "runtime"))
    .limit(1);
  const rows = forUpdate ? await query.for("update") : await query;
  const row = rows[0];
  if (row === undefined) {
    throw new Error("Application settings are not initialized.");
  }
  const decoded = applicationSettingsRowSchema.parse(row);
  const defaults = parseStoredApplicationSettings(decoded.defaults);
  const settings = parseStoredApplicationSettings(decoded.settings);
  return { defaults, settings, version: decoded.version };
}

export async function copyAndVerifySourceContentDocument(
  source: SourceContentBackend,
  target: SourceContentBackend,
  document: SourceContentMigrationDocument,
  abortSignal?: AbortSignal,
): Promise<void> {
  await source.verify(document, abortSignal);
  await target.publish({
    ...document,
    kind: "stream",
    open: async (streamAbortSignal?: AbortSignal) => {
      return source.openRead(document, streamAbortSignal);
    },
  }, abortSignal);
  await target.verify(document, abortSignal);
}

export async function visitSourceContentDocuments(
  database: CiteLoomDatabase,
  abortSignal: AbortSignal | undefined,
  visit: (document: SourceContentMetadata) => Promise<void>,
): Promise<void> {
  let afterDocumentId: string | null = null;
  while (true) {
    abortSignal?.throwIfAborted();
    const documents = await readSourceContentMigrationBatch(
      database,
      afterDocumentId,
    );
    if (documents.length === 0) {
      return;
    }
    for (const document of documents) {
      abortSignal?.throwIfAborted();
      await visit(document);
      afterDocumentId = document.documentId;
    }
  }
}

export async function visitSourceContentDocumentsPublishedSince(
  database: CiteLoomDatabase,
  publishedSince: Date,
  abortSignal: AbortSignal | undefined,
  visit: (document: SourceContentMetadata) => Promise<void>,
): Promise<void> {
  let afterDocumentId: string | null = null;
  while (true) {
    abortSignal?.throwIfAborted();
    const documents = await readSourceContentMigrationBatchPublishedSince(
      database,
      afterDocumentId,
      publishedSince,
    );
    if (documents.length === 0) {
      return;
    }
    for (const document of documents) {
      abortSignal?.throwIfAborted();
      await visit(document);
      afterDocumentId = document.documentId;
    }
  }
}

export async function readSourceContentMigrationBatch(
  database: CiteLoomDatabase,
  afterDocumentId: string | null,
  limit: number = SOURCE_CONTENT_MIGRATION_BATCH_SIZE,
): Promise<SourceContentMigrationDocument[]> {
  const selection = {
    byteLength: sourceDocuments.byteLength,
    documentId: sourceDocuments.documentId,
  };
  const rows = afterDocumentId === null
    ? await database
      .select(selection)
      .from(sourceDocuments)
      .orderBy(asc(sourceDocuments.documentId))
      .limit(limit)
    : await database
      .select(selection)
      .from(sourceDocuments)
      .where(gt(sourceDocuments.documentId, afterDocumentId))
      .orderBy(asc(sourceDocuments.documentId))
      .limit(limit);
  return rows.map((row) => sourceDocumentRowSchema.parse(row));
}

async function readSourceContentMigrationBatchPublishedSince(
  database: CiteLoomDatabase,
  afterDocumentId: string | null,
  publishedSince: Date,
): Promise<SourceContentMigrationDocument[]> {
  const selection = {
    byteLength: sourceDocuments.byteLength,
    documentId: sourceDocuments.documentId,
  };
  const cursor = afterDocumentId === null
    ? gte(sourceDocuments.lastPublishedAt, publishedSince)
    : and(
        gt(sourceDocuments.documentId, afterDocumentId),
        gte(sourceDocuments.lastPublishedAt, publishedSince),
      );
  const rows = await database
    .select(selection)
    .from(sourceDocuments)
    .where(cursor)
    .orderBy(asc(sourceDocuments.documentId))
    .limit(SOURCE_CONTENT_MIGRATION_BATCH_SIZE);
  return rows.map((row) => sourceDocumentRowSchema.parse(row));
}
