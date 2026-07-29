import { basename } from "node:path";

import type { ApplicationRuntime } from "../app/runtime.js";
import {
  type DocumentStatistics,
  type IndexedDocument,
  type IngestionControlActor,
  type IngestionJob,
  type IngestionPhase,
  type PrepareIngestionResult,
  type PublishedDocument,
  type RetryFailedJobResult,
  type RequestIngestionControlResult,
  type ResumeIngestionResult,
  DocumentCatalog,
} from "../documents/catalog/index.js";
import { mapWithConcurrency } from "../shared/concurrency.js";
import type { AppConfig } from "../config/index.js";
import { openDatabase, type CiteLoomDatabase } from "../database/client.js";
import { discoverDocumentFiles } from "../documents/input.js";
import type {
  BufferedDocumentSource,
  DocumentFormat,
  FileDocumentSource,
} from "../documents/format.js";
import { readDocumentSource } from "../docling/index.js";
import { IngestionProcessor } from "./processor.js";
import { finalizeIngestionCancellation } from "./deletion.js";
import { reconcileIngestionControlExecutions } from "./control.js";
import {
  SourceContentStore,
  type StoredSourceDocumentReference,
} from "../documents/storage/source-content-store.js";

export interface IngestOptions {
  enqueue: boolean;
  force: boolean;
  recursive: boolean;
  tags: string[];
}

interface IngestResultBase extends DocumentStatistics {
  documentId: string;
  sourceFile: string;
  stagedSourceFile: string | null;
}

export type IngestResult =
  | (IngestResultBase & { status: "indexed" | "queued" | "skipped" })
  | (IngestResultBase & {
    status: "already-exists" | "already-processing" | "upload-blocked";
  });

export interface IngestFailure {
  error: string;
  sourceFile: string;
}

export interface BulkIngestResult {
  documents: IngestResult[];
  failures: IngestFailure[];
}

export interface ReindexDocumentRequest {
  documentId: string;
  sourceFile: string;
}

export type ReindexDocumentResult =
  | { kind: "not-found" }
  | { error: string; kind: "rejected" }
  | {
      documentId: string;
      kind: "queued";
      sourceFile: string;
    };

export type RetryFailedIngestionResult =
  | RetryFailedJobResult
  | {
      error: string;
      kind: "restart-rejected";
    };

export async function requestIngestionControlWithRuntime(
  runtime: ApplicationRuntime,
  sourceFile: string,
  action: "pause" | "cancel",
  actor: IngestionControlActor,
): Promise<RequestIngestionControlResult> {
  const catalog = new DocumentCatalog(runtime.database);
  const result = await catalog.requestIngestionControl(sourceFile, action, actor);
  if (result.kind === "accepted") {
    await reconcileIngestionControlExecutions(
      runtime.database,
      runtime.config,
      sourceFile,
    );
  }
  if (action === "cancel" && result.kind === "accepted") {
    const finalization = await finalizeIngestionCancellation(
      runtime.database,
      sourceFile,
      runtime.config.sourceContent,
    );
    if (finalization.kind === "canceled") {
      return { kind: "canceled", sourceFile };
    }
    if (finalization.kind === "cleanup-failed") {
      return finalization;
    }
  }
  return result;
}

export async function resumeIngestionWithRuntime(
  runtime: ApplicationRuntime,
  sourceFile: string,
  actor: IngestionControlActor,
): Promise<ResumeIngestionResult> {
  const catalog = new DocumentCatalog(runtime.database);
  return catalog.resumePausedIngestion(sourceFile, actor);
}

interface StageOptions {
  concurrency: number;
  phase: IngestionPhase;
  processor: IngestionProcessor;
  results: Map<string, IngestResult>;
  sourceFiles: string[];
}

interface DocumentSourceProcessingInput {
  config: AppConfig;
  duplicateSourceRoot: string | null;
  uploadedByUserId: string | null;
  failures: Map<string, string>;
  options: IngestOptions;
  processor: IngestionProcessor;
  reportProgress: (message: string) => void;
  sourceFiles: string[];
  sources: IngestionDocument[];
}

interface IngestionDocument extends DocumentFormat {
  documentId: string;
  sourceFile: string;
}

export interface StagedIngestionDocument extends IngestionDocument {
  byteLength: number;
}

interface StoredSourceDocumentReader {
  readDocumentReference(
    documentId: string,
  ): Promise<StoredSourceDocumentReference>;
}

const DEFAULT_INGEST_OPTIONS: IngestOptions = {
  enqueue: false,
  force: false,
  recursive: false,
  tags: [],
};

export async function ingestDocument(
  config: AppConfig,
  documentPath: string,
  reportProgress: (message: string) => void,
): Promise<IngestResult> {
  const result = await ingestDocuments(
    config,
    [documentPath],
    DEFAULT_INGEST_OPTIONS,
    reportProgress,
  );
  const failure = result.failures[0];
  if (failure !== undefined) {
    throw new Error(failure.error);
  }
  const document = result.documents[0];
  if (document === undefined) {
    throw new Error(`Ingestion produced no result for ${documentPath}.`);
  }
  return document;
}

export async function ingestDocuments(
  config: AppConfig,
  inputPaths: string[],
  options: IngestOptions,
  reportProgress: (message: string) => void,
): Promise<BulkIngestResult> {
  const sourceFiles = await discoverDocumentFiles(inputPaths, options.recursive);
  const databaseSession = await openDatabase(config.database);
  try {
    return await ingestDiscoveredDocuments(
      config,
      sourceFiles,
      options,
      reportProgress,
      databaseSession.database,
    );
  } finally {
    await databaseSession.close();
  }
}

export async function ingestDocumentsWithRuntime(
  runtime: ApplicationRuntime,
  inputPaths: string[],
  options: IngestOptions,
  reportProgress: (message: string) => void,
  duplicateSourceRoot: string | null = null,
  uploadedByUserId: string | null = null,
): Promise<BulkIngestResult> {
  const sourceFiles = await discoverDocumentFiles(inputPaths, options.recursive);
  return ingestDiscoveredDocuments(
    runtime.config,
    sourceFiles,
    options,
    reportProgress,
    runtime.database,
    runtime,
    duplicateSourceRoot,
    uploadedByUserId,
  );
}

async function ingestDiscoveredDocuments(
  config: AppConfig,
  sourceFiles: string[],
  options: IngestOptions,
  reportProgress: (message: string) => void,
  database: CiteLoomDatabase,
  runtime?: ApplicationRuntime,
  duplicateSourceRoot: string | null = null,
  uploadedByUserId: string | null = null,
): Promise<BulkIngestResult> {
  const processor = createIngestionProcessor(
    config,
    database,
    reportProgress,
    runtime ?? null,
  );
  await processor.initialize();
  const result: BulkIngestResult = { documents: [], failures: [] };
  for (const sourceFile of sourceFiles) {
    let source: BufferedDocumentSource;
    try {
      source = await readDocumentSource(sourceFile, config.maxDocumentBytes);
      await processor.sourceContentStore.writeDocument(source);
    } catch (error: unknown) {
      result.failures.push({
        error: readErrorMessage(error),
        sourceFile,
      });
      continue;
    }
    const sourceResult = await processDocumentSources({
      config,
      duplicateSourceRoot,
      uploadedByUserId,
      failures: new Map<string, string>(),
      options,
      processor,
      reportProgress,
      sourceFiles: [sourceFile],
      sources: [source],
    });
    result.documents.push(...sourceResult.documents);
    result.failures.push(...sourceResult.failures);
  }
  return result;
}

export async function ingestStagedDocumentsWithRuntime(
  runtime: ApplicationRuntime,
  documents: readonly StagedIngestionDocument[],
  options: IngestOptions,
  reportProgress: (message: string) => void,
  duplicateSourceRoot: string,
  uploadedByUserId: string,
): Promise<BulkIngestResult> {
  if (!options.enqueue) {
    throw new Error("Web uploads must be queued for worker ingestion.");
  }
  const processor = createIngestionProcessor(
    runtime.config,
    runtime.database,
    reportProgress,
    runtime,
  );
  await processor.initialize();
  const result: BulkIngestResult = { documents: [], failures: [] };
  for (const document of documents) {
    try {
      await processor.sourceContentStore.publishStagedDocument(document);
    } catch (error: unknown) {
      result.failures.push({
        error: readErrorMessage(error),
        sourceFile: document.sourceFile,
      });
      continue;
    }
    const sourceResult = await processDocumentSources({
      config: runtime.config,
      duplicateSourceRoot,
      uploadedByUserId,
      failures: new Map<string, string>(),
      options,
      processor,
      reportProgress,
      sourceFiles: [document.sourceFile],
      sources: [document],
    });
    result.documents.push(...sourceResult.documents);
    result.failures.push(...sourceResult.failures);
  }
  return result;
}

async function processDocumentSources(
  input: DocumentSourceProcessingInput,
): Promise<BulkIngestResult> {
  const results = new Map<string, IngestResult>();
  const processSources: string[] = [];
  const canonicalSources = new Map<string, string>();
  for (const source of input.sources) {
    let preparation: PrepareIngestionResult;
    try {
      preparation = await input.processor.catalog.prepareIngestion({
        documentId: source.documentId,
        duplicateSourceRoot: input.duplicateSourceRoot,
        embeddingSpaceId: input.config.embeddingSpace.id,
        force: input.options.force,
        format: {
          extension: source.extension,
          mediaType: source.mediaType,
        },
        maxAttempts: input.config.retry.maxAttempts,
        requestedTags: input.options.tags,
        sourceFile: source.sourceFile,
        uploadedByUserId: input.uploadedByUserId,
      });
    } catch (error: unknown) {
      input.failures.set(source.sourceFile, readErrorMessage(error));
      continue;
    }

    if (preparation.kind === "duplicate") {
      results.set(
        source.sourceFile,
        createDuplicateIngestResult(preparation.existing, source.sourceFile),
      );
      input.reportProgress(
        `${basename(source.sourceFile)} is already in the document library`,
      );
      continue;
    }
    if (preparation.kind === "already-processing") {
      results.set(
        source.sourceFile,
        createAlreadyProcessingIngestResult(
          preparation.existing,
          source.sourceFile,
        ),
      );
      input.reportProgress(
        `${basename(source.sourceFile)} is already being processed`,
      );
      continue;
    }
    if (preparation.kind === "busy") {
      results.set(
        source.sourceFile,
        createBusyIngestResult(preparation.existing, source.sourceFile),
      );
      input.reportProgress(
        `${basename(source.sourceFile)} was not accepted because an earlier version is processing`,
      );
      continue;
    }
    if (preparation.abandonedJob !== null) {
      await input.processor.cleanAbandonedJob(preparation.abandonedJob);
    }
    if (preparation.kind === "skipped") {
      results.set(
        source.sourceFile,
        createIngestResult(preparation.document, "skipped"),
      );
      input.reportProgress(`${basename(source.sourceFile)} is already indexed`);
      continue;
    }

    const jobSourceFile = preparation.job.sourceFile;
    processSources.push(jobSourceFile);
    canonicalSources.set(source.sourceFile, jobSourceFile);
    if (input.options.enqueue) {
      const stagedSourceFile = jobSourceFile === source.sourceFile
        ? null
        : source.sourceFile;
      results.set(
        source.sourceFile,
        createQueuedResult(preparation.job, stagedSourceFile),
      );
      input.reportProgress(`${basename(source.sourceFile)} was queued for ingestion`);
    }
  }

  if (!input.options.enqueue) {
    await runSynchronousStages(
      input.processor,
      processSources,
      results,
      input.config,
    );
    await collectUnfinishedJobs(
      input.processor.catalog,
      processSources,
      input.failures,
    );
    remapCanonicalIngestionResults(
      canonicalSources,
      results,
      input.failures,
    );
  }

  return orderBulkResult(input.sourceFiles, results, input.failures);
}

export async function queueDocumentReindex(
  config: AppConfig,
  request: ReindexDocumentRequest,
  reportProgress: (message: string) => void,
): Promise<ReindexDocumentResult> {
  const databaseSession = await openDatabase(config.database);
  try {
    const catalog = new DocumentCatalog(databaseSession.database);
    const indexedDocument = await catalog.findIndexedDocument(
      request.documentId,
      request.sourceFile,
    );
    if (indexedDocument === null) {
      return { kind: "not-found" };
    }
    return await queueStoredDocumentReindex(
      config,
      databaseSession.database,
      indexedDocument,
      null,
      reportProgress,
    );
  } finally {
    await databaseSession.close();
  }
}

export async function queueDocumentReindexWithRuntime(
  runtime: ApplicationRuntime,
  request: ReindexDocumentRequest,
  uploadedByUserId: string,
  reportProgress: (message: string) => void,
): Promise<ReindexDocumentResult> {
  const catalog = new DocumentCatalog(runtime.database);
  const indexedDocument = await catalog.findIndexedDocument(
    request.documentId,
    request.sourceFile,
  );
  if (indexedDocument === null) {
    return { kind: "not-found" };
  }
  return queueStoredDocumentReindex(
    runtime.config,
    runtime.database,
    indexedDocument,
    runtime,
    reportProgress,
    uploadedByUserId,
  );
}

export async function ingestPdf(
  config: AppConfig,
  pdfPath: string,
  reportProgress: (message: string) => void,
): Promise<IngestResult> {
  return ingestDocument(config, pdfPath, reportProgress);
}

export async function ingestPdfs(
  config: AppConfig,
  inputPaths: string[],
  options: IngestOptions,
  reportProgress: (message: string) => void,
): Promise<BulkIngestResult> {
  return ingestDocuments(config, inputPaths, options, reportProgress);
}

export async function retryFailedIngestion(
  config: AppConfig,
  sourceFile: string,
): Promise<RetryFailedIngestionResult> {
  const databaseSession = await openDatabase(config.database);
  try {
    return await retryFailedIngestionInDatabase(
      config,
      databaseSession.database,
      sourceFile,
    );
  } finally {
    await databaseSession.close();
  }
}

export async function retryFailedIngestionWithRuntime(
  runtime: ApplicationRuntime,
  sourceFile: string,
): Promise<RetryFailedIngestionResult> {
  return retryFailedIngestionInDatabase(
    runtime.config,
    runtime.database,
    sourceFile,
  );
}

async function retryFailedIngestionInDatabase(
  config: AppConfig,
  database: CiteLoomDatabase,
  sourceFile: string,
): Promise<RetryFailedIngestionResult> {
  const catalog = new DocumentCatalog(database);
  const job = await catalog.getJob(sourceFile);
  if (job === null) {
    return { kind: "not-found" };
  }
  if (job.state !== "failed") {
    return { kind: "not-failed", state: job.state };
  }

  if (job.embeddingSpaceId !== config.embeddingSpace.id) {
    return {
      error: "The embedding space changed. Start a new ingestion explicitly.",
      kind: "restart-rejected",
    };
  }
  return catalog.retryFailedJob(sourceFile);
}

function buildReindexResult(
  indexedDocument: IndexedDocument,
  result: BulkIngestResult,
): ReindexDocumentResult {
  const failure = result.failures[0];
  if (failure !== undefined) {
    return { error: failure.error, kind: "rejected" };
  }
  const queuedDocument = result.documents[0];
  if (queuedDocument === undefined || queuedDocument.status !== "queued") {
    return {
      error: `Reindexing did not queue ${indexedDocument.sourceFile}.`,
      kind: "rejected",
    };
  }
  return {
    documentId: queuedDocument.documentId,
    kind: "queued",
    sourceFile: queuedDocument.sourceFile,
  };
}

async function queueStoredDocumentReindex(
  config: AppConfig,
  database: CiteLoomDatabase,
  indexedDocument: PublishedDocument,
  runtime: ApplicationRuntime | null,
  reportProgress: (message: string) => void,
  uploadedByUserId: string | null = null,
): Promise<ReindexDocumentResult> {
  const documentStore = new SourceContentStore(database, config.sourceContent);
  let source: FileDocumentSource;
  try {
    source = await readStoredReindexSource(
      documentStore,
      indexedDocument,
      config.maxDocumentBytes,
    );
  } catch (error: unknown) {
    return { error: readErrorMessage(error), kind: "rejected" };
  }

  const processor = createIngestionProcessor(
    config,
    database,
    reportProgress,
    runtime,
  );
  const result = await processDocumentSources({
    config,
    duplicateSourceRoot: null,
    failures: new Map<string, string>(),
    options: {
      enqueue: true,
      force: true,
      recursive: false,
      tags: indexedDocument.tags,
    },
    uploadedByUserId,
    processor,
    reportProgress,
    sourceFiles: [indexedDocument.sourceFile],
    sources: [source],
  });
  return buildReindexResult(indexedDocument, result);
}

export async function readStoredReindexSource(
  documentStore: StoredSourceDocumentReader,
  indexedDocument: PublishedDocument,
  maximumBytes: number,
): Promise<FileDocumentSource> {
  return readStoredDocumentSource(documentStore, indexedDocument, maximumBytes);
}

async function readStoredDocumentSource(
  documentStore: StoredSourceDocumentReader,
  document: {
    documentId: string;
    format: DocumentFormat;
    sourceFile: string;
  },
  maximumBytes: number,
): Promise<FileDocumentSource> {
  const storedDocument = await documentStore.readDocumentReference(
    document.documentId,
  );
  if (storedDocument.byteLength > maximumBytes) {
    throw new Error(
      `Document exceeds the configured ${maximumBytes} byte limit: ${document.sourceFile}`,
    );
  }
  const source: FileDocumentSource = {
    byteLength: storedDocument.byteLength,
    contentPath: storedDocument.contentPath,
    documentId: storedDocument.documentId,
    extension: document.format.extension,
    kind: "file",
    mediaType: document.format.mediaType,
    sourceFile: document.sourceFile,
  };
  return source;
}

function createIngestionProcessor(
  config: AppConfig,
  database: CiteLoomDatabase,
  reportProgress: (message: string) => void,
  runtime: ApplicationRuntime | null,
): IngestionProcessor {
  if (runtime === null) {
    return new IngestionProcessor(config, database, reportProgress);
  }
  return new IngestionProcessor(config, database, reportProgress, runtime);
}

async function runSynchronousStages(
  processor: IngestionProcessor,
  sourceFiles: string[],
  results: Map<string, IngestResult>,
  config: AppConfig,
): Promise<void> {
  const stages: Array<{ concurrency: number; phase: IngestionPhase }> = [
    { concurrency: config.worker.concurrency, phase: "discovered" },
  ];
  for (const stage of stages) {
    await runStage({
      concurrency: stage.concurrency,
      phase: stage.phase,
      processor,
      results,
      sourceFiles,
    });
  }
}

async function runStage(options: StageOptions): Promise<void> {
  await mapWithConcurrency(
    options.sourceFiles,
    options.concurrency,
    async (sourceFile) => {
      const job = await options.processor.catalog.getJob(sourceFile);
      if (job === null || job.phase !== options.phase || job.state !== "pending") {
        return;
      }
      const claim = await options.processor.claimJob(
        sourceFile,
        options.phase,
      );
      if (claim.kind !== "claimed") {
        return;
      }
      const result = await options.processor.processClaimedJob(claim.job);
      if (result.kind === "indexed") {
        options.results.set(
          sourceFile,
          createIngestResult(result.promotion.indexed, "indexed"),
        );
      }
    },
  );
}

async function collectUnfinishedJobs(
  catalog: DocumentCatalog,
  sourceFiles: string[],
  failures: Map<string, string>,
): Promise<void> {
  for (const sourceFile of sourceFiles) {
    const job = await catalog.getJob(sourceFile);
    if (job === null) {
      continue;
    }
    if (job.state === "running") {
      failures.set(
        sourceFile,
        `Another ingestion worker (${job.ownerId}) is working on this document.`,
      );
      continue;
    }
    const error = job.errorMessage ?? `Ingestion stopped in phase ${job.phase}.`;
    failures.set(sourceFile, error);
  }
}

function createIngestResult(
  document: IndexedDocument,
  status: "indexed" | "skipped",
): IngestResult {
  return {
    documentId: document.documentId,
    images: document.images,
    pageCount: document.pageCount,
    sourceFile: document.sourceFile,
    stagedSourceFile: null,
    status,
    tables: document.tables,
    textChunks: document.textChunks,
    totalElements: document.totalElements,
  };
}

function createQueuedResult(
  job: IngestionJob,
  stagedSourceFile: string | null = null,
): IngestResult {
  return {
    documentId: job.documentId,
    images: job.images,
    pageCount: job.pageCount,
    sourceFile: job.sourceFile,
    stagedSourceFile,
    status: "queued",
    tables: job.tables,
    textChunks: job.textChunks,
    totalElements: job.totalElements,
  };
}

function createDuplicateIngestResult(
  existing: IndexedDocument | IngestionJob,
  stagedSourceFile: string,
): IngestResult {
  return {
    documentId: existing.documentId,
    images: existing.images,
    pageCount: existing.pageCount,
    sourceFile: existing.sourceFile,
    stagedSourceFile,
    status: "already-exists",
    tables: existing.tables,
    textChunks: existing.textChunks,
    totalElements: existing.totalElements,
  };
}

function createAlreadyProcessingIngestResult(
  existing: IngestionJob,
  stagedSourceFile: string,
): IngestResult {
  return {
    documentId: existing.documentId,
    images: existing.images,
    pageCount: existing.pageCount,
    sourceFile: existing.sourceFile,
    stagedSourceFile,
    status: "already-processing",
    tables: existing.tables,
    textChunks: existing.textChunks,
    totalElements: existing.totalElements,
  };
}

function createBusyIngestResult(
  existing: IngestionJob,
  stagedSourceFile: string,
): IngestResult {
  return {
    documentId: existing.documentId,
    images: existing.images,
    pageCount: existing.pageCount,
    sourceFile: existing.sourceFile,
    stagedSourceFile,
    status: "upload-blocked",
    tables: existing.tables,
    textChunks: existing.textChunks,
    totalElements: existing.totalElements,
  };
}

function remapCanonicalIngestionResults(
  canonicalSources: ReadonlyMap<string, string>,
  results: Map<string, IngestResult>,
  failures: Map<string, string>,
): void {
  for (const [inputSourceFile, jobSourceFile] of canonicalSources) {
    if (jobSourceFile === inputSourceFile) {
      continue;
    }
    const result = results.get(jobSourceFile);
    if (result !== undefined) {
      results.delete(jobSourceFile);
      results.set(inputSourceFile, {
        ...result,
        stagedSourceFile: inputSourceFile,
      });
    }
    const failure = failures.get(jobSourceFile);
    if (failure !== undefined) {
      failures.delete(jobSourceFile);
      failures.set(inputSourceFile, failure);
    }
  }
}

function orderBulkResult(
  sourceFiles: string[],
  results: Map<string, IngestResult>,
  failures: Map<string, string>,
): BulkIngestResult {
  const documents: IngestResult[] = [];
  const failedDocuments: IngestFailure[] = [];
  for (const sourceFile of sourceFiles) {
    const result = results.get(sourceFile);
    if (result !== undefined) {
      documents.push(result);
      continue;
    }
    const error = failures.get(sourceFile);
    if (error !== undefined) {
      failedDocuments.push({ error, sourceFile });
    }
  }
  return { documents, failures: failedDocuments };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
