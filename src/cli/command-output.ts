import type { CatalogEntry } from "../documents/catalog/index.js";
import type { EmbeddingSpaceGcReport } from "../embedding/space/types.js";
import { SUPPORTED_DOCUMENT_EXTENSIONS } from "../documents/format.js";
import type { SystemStatus } from "../ingestion/worker.js";

export function printCatalog(entries: CatalogEntry[]): void {
  if (entries.length === 0) {
    console.log("No documents or ingestion jobs are registered.");
    return;
  }

  for (const entry of entries) {
    const phase = entry.phase === null ? "" : ` (${entry.phase})`;
    console.log(`${entry.status.toUpperCase()}${phase}  ${entry.sourceFile}`);
    console.log(`  document: ${entry.documentId}`);
    if (
      entry.activeDocumentId !== null
      && entry.activeDocumentId !== entry.documentId
    ) {
      console.log(`  active:   ${entry.activeDocumentId}`);
    }
    if (entry.tags.length > 0) {
      console.log(`  tags:     ${entry.tags.join(", ")}`);
    }
    if (entry.embeddingSpaceIds.length > 0) {
      console.log(`  spaces:   ${entry.embeddingSpaceIds.join(", ")}`);
    }
    console.log(
      `  elements: ${entry.textChunks} text, ${entry.tables} tables, ${entry.images} images`,
    );
    if (entry.errorMessage !== null) {
      console.log(`  error:    ${entry.errorMessage}`);
    }
  }
}

export function printEmbeddingSpaceGcReport(
  report: EmbeddingSpaceGcReport,
): void {
  console.log(
    `Embedding-space GC ${report.id}: ${report.mode}, ${report.status}`,
  );
  console.log(`Active space: ${report.activeSpaceId}`);
  console.log(`Retention cutoff: ${report.retentionCutoff}`);
  for (const space of report.spaces) {
    const protection = space.protectionKind === null
      ? "deletable"
      : `${space.protectionKind}: ${space.protectionDetail}`;
    const rows = space.rowCounts;
    console.log(
      `  ${space.spaceId}: ${space.state}, ${protection}, estimated ${space.estimatedBytes} bytes`,
    );
    console.log(
      `    input format: ${space.inputFormatName} (${space.inputFormatHash})`,
    );
    console.log(
      `    rows: ${rows.vectorChunks384} vector-384, ${rows.vectorChunks768} vector-768, ${rows.vectorChunks1024} vector-1024, ${rows.lexicalChunks} lexical, ${rows.indexedDocuments} document links`,
    );
    if (space.errorMessage !== null) {
      console.log(`    error: ${space.errorMessage}`);
    }
  }
}

export function printSystemStatus(status: SystemStatus): void {
  console.log(`Workers: ${status.workers.length}`);
  for (const worker of status.workers) {
    console.log(
      `  ${worker.state.toUpperCase()} ${worker.hostname}:${worker.processId} heartbeat ${worker.heartbeatAt}`,
    );
  }
  console.log(`Queue: ${status.queue.length}`);
  for (const job of status.queue) {
    console.log(
      `  ${job.state.toUpperCase()} (${job.phase}) ${job.sourceFile} attempts ${job.attemptCount}/${job.maxAttempts}`,
    );
    if (job.errorMessage !== null) {
      console.log(`    error: ${job.errorMessage}`);
    }
  }
  console.log("Inference:");
  for (const resource of status.inference) {
    console.log(
      `  ${resource.name}: ${resource.activeSlots}/${resource.capacity} active requests`,
    );
  }
}

export function readIngestVerb(
  status: "already-exists" | "already-processing" | "indexed" | "queued" | "skipped" | "upload-blocked",
): string {
  if (status === "upload-blocked") {
    return "Not accepted";
  }
  if (status === "already-processing") {
    return "Already processing";
  }
  if (status === "already-exists") {
    return "Already indexed";
  }
  if (status === "skipped") {
    return "Skipped";
  }
  if (status === "queued") {
    return "Queued";
  }
  return "Indexed";
}

export function printProgress(message: string): void {
  console.error(`- ${message}`);
}

export function printHelp(): void {
  const knownDocumentExtensions = SUPPORTED_DOCUMENT_EXTENSIONS.join(", ");
  console.log(`citeloom - Private documents, woven into cited answers.

Get started:
  pnpm db:setup
  pnpm run doctor:docker
  pnpm run doctor:source

Ingest and search:
  pnpm ingest [--enqueue] [--recursive] [--force] [--tag <tag>] <path> [...paths]
  pnpm worker [--once]
  pnpm status
  pnpm documents list
  pnpm ask [--all | --document <id> | --file <path> | --tag <tag>] -- <question>

Manage stored data:
  pnpm dev document-toc backfill
  pnpm dev embedding-spaces pin --space <id> --reason <reason>
  pnpm dev embedding-spaces unpin --space <id>
  pnpm dev embedding-spaces gc --retention-days <days> <--dry-run|--apply>
  pnpm dev embedding-spaces gc --resume <run-id> --apply
  pnpm jobs retry --file <stored-source-file>

Notes:
  - Add --enqueue to process ingestion in the background with a running worker.
  - Document TOC backfill uses stored document elements and does not rerun Docling or embeddings.
  - Run an interrupted ingest command again to resume it. Add --force only to rebuild it.
  - Repeat a scope flag to select multiple document IDs, files, or tags.
  - Supported document extensions: ${knownDocumentExtensions}.
  - Other readable UTF-8 files are ingested as plain text.
  - Development commands load .env.development. Production commands load .env.
  - Copy the appropriate file from .env.example and use the exact model names shown by your model server.`);
}
