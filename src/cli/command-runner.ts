import { basename } from "node:path";

import {
  ApplicationSettingsRepository,
  type EffectiveApplicationSettings,
} from "../app/settings.js";
import {
  readDatabaseConfig,
  readStartupConfig,
  type AppConfig,
} from "../config/index.js";
import { openDatabase } from "../database/client.js";
import type { EmbeddingSpaceGcReport } from "../embedding/space/types.js";
import { runDoctor } from "../observability/doctor.js";
import {
  printCatalog,
  printEmbeddingSpaceGcReport,
  printHelp,
  printHostAuthenticationRecovery,
  printProgress,
  printSystemStatus,
  readIngestVerb,
} from "./command-output.js";
import { parseCliCommand } from "./command-parser.js";

export async function main(arguments_: string[] = process.argv.slice(2)): Promise<void> {
  const command = parseCliCommand(arguments_);
  if (command.name === "help") {
    printHelp();
    return;
  }

  if (command.name === "auth-recover-local") {
    await runHostAuthenticationRecovery(readDatabaseConfig(), command.apply);
    return;
  }
  const startup = readStartupConfig();
  const effectiveSettings = await readEffectiveCliConfig(startup.database);
  const config = effectiveSettings.config;

  if (command.name === "source-content-migrate") {
    const { readSourceContentBootstrapConfig } = await import(
      "../database/administrator-bootstrap.js"
    );
    const { migrateSourceContentBackend } = await import(
      "../documents/storage/source-content-migration.js"
    );
    const session = await openDatabase(config.database);
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      if (process.env.CITELOOM_SOURCE_CONTENT_BACKEND === undefined) {
        throw new Error(
          "Set CITELOOM_SOURCE_CONTENT_BACKEND explicitly before migrating source content.",
        );
      }
      const target = readSourceContentBootstrapConfig(process.env);
      const report = await migrateSourceContentBackend(
        session.database,
        target,
        {
          abortSignal: controller.signal,
          reportProgress: printProgress,
        },
      );
      console.log(
        `Source-content migration complete: ${report.copied} copied, ${report.verifiedAtCutover} verified at cutover.`,
      );
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await session.close();
    }
    return;
  }

  if (
    command.name === "source-content-export"
    || command.name === "source-content-import"
  ) {
    const { copySourceContentObjects } = await import(
      "../documents/storage/source-content-migration.js"
    );
    const session = await openDatabase(config.database);
    const archiveConfig = {
      directory: command.directory,
      kind: "filesystem" as const,
    };
    const source = command.name === "source-content-export"
      ? config.sourceContent
      : archiveConfig;
    const target = command.name === "source-content-export"
      ? archiveConfig
      : config.sourceContent;
    try {
      const copied = await copySourceContentObjects(
        session.database,
        source,
        target,
        { reportProgress: printProgress },
      );
      const operation = command.name === "source-content-export"
        ? "exported"
        : "imported";
      console.log(`Source content ${operation}: ${copied} verified objects.`);
    } finally {
      await session.close();
    }
    return;
  }

  if (command.name === "document-toc-backfill") {
    const { backfillDocumentTocs } = await import(
      "../retrieval/toc/backfill.js"
    );
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const report = await backfillDocumentTocs(
        config,
        printProgress,
        controller.signal,
      );
      console.log(
        `Document TOC backfill: ${report.published} built, ${report.alreadyPublished} already present, ${report.stale} replaced during processing, ${report.scanned} total.`,
      );
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return;
  }

  if (
    command.name === "embedding-space-gc"
    || command.name === "embedding-space-pin"
    || command.name === "embedding-space-unpin"
  ) {
    const {
      pinEmbeddingSpace,
      runEmbeddingSpaceGarbageCollection,
      unpinEmbeddingSpace,
    } = await import("../embedding/space/retention.js");
    const session = await openDatabase(config.database);
    try {
      if (command.name === "embedding-space-pin") {
        await pinEmbeddingSpace(session.database, command.spaceId, command.reason);
        console.log(`Pinned embedding space ${command.spaceId}.`);
        return;
      }
      if (command.name === "embedding-space-unpin") {
        const removed = await unpinEmbeddingSpace(
          session.database,
          command.spaceId,
        );
        if (!removed) {
          throw new Error(`Embedding space is not pinned: ${command.spaceId}.`);
        }
        console.log(`Unpinned embedding space ${command.spaceId}.`);
        return;
      }
      let report: EmbeddingSpaceGcReport;
      if (command.action === "resume") {
        if (command.runId === null) {
          throw new Error("A resumed garbage-collection run requires a run ID.");
        }
        report = await runEmbeddingSpaceGarbageCollection(session.database, {
          activeSpaceId: config.embeddingSpace.id,
          mode: "resume",
          runId: command.runId,
        });
      } else {
        if (command.retentionDays === null) {
          throw new Error("A new garbage-collection run requires retention days.");
        }
        report = await runEmbeddingSpaceGarbageCollection(session.database, {
          activeSpaceId: config.embeddingSpace.id,
          mode: command.action,
          retentionDays: command.retentionDays,
        });
      }
      printEmbeddingSpaceGcReport(report);
      return;
    } finally {
      await session.close();
    }
  }

  if (command.name === "doctor") {
    const checks = await runDoctor(config);
    let hasFailure = false;
    for (const check of checks) {
      const marker = check.ok ? "OK" : "FAIL";
      console.log(`${marker}  ${check.name}: ${check.detail}`);
      hasFailure ||= !check.ok;
    }
    if (hasFailure) {
      process.exitCode = 1;
    }
    return;
  }

  if (command.name === "documents") {
    const { listCatalogEntries } = await import(
      "../documents/catalog/service.js"
    );
    printCatalog(await listCatalogEntries(config));
    return;
  }

  if (command.name === "retry-job") {
    const { retryFailedIngestion } = await import("../ingestion/service.js");
    const result = await retryFailedIngestion(config, command.sourceFile);
    if (result.kind === "not-found") {
      throw new Error(`No ingestion job is registered for ${command.sourceFile}.`);
    }
    if (result.kind === "not-failed") {
      throw new Error(
        `Ingestion job is ${result.state}, not failed: ${command.sourceFile}.`,
      );
    }
    if (result.kind === "restart-rejected") {
      throw new Error(result.error);
    }
    console.log(
      `Queued ${result.job.sourceFile} from the ${result.job.phase} phase.`,
    );
    return;
  }

  if (command.name === "status") {
    const { readSystemStatus } = await import("../ingestion/worker.js");
    printSystemStatus(await readSystemStatus(config));
    return;
  }

  if (command.name === "worker") {
    const { runIngestionWorker } = await import("../ingestion/worker.js");
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await runIngestionWorker(config, {
        once: command.once,
        signal: controller.signal,
      });
    } finally {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
    return;
  }

  if (command.name === "ingest") {
    const { ingestDocuments } = await import("../ingestion/service.js");
    const result = await ingestDocuments(
      config,
      command.inputPaths,
      {
        enqueue: command.enqueue,
        force: command.force,
        recursive: command.recursive,
        tags: command.tags,
      },
      printProgress,
    );
    for (const document of result.documents) {
      const verb = readIngestVerb(document.status);
      console.log("");
      console.log(`${verb} ${basename(document.sourceFile)}`);
      console.log(`Document id: ${document.documentId}`);
      console.log(
        `Elements: ${document.textChunks} text, ${document.tables} tables, ${document.images} images`,
      );
    }
    for (const failure of result.failures) {
      console.error(`\nFailed ${failure.sourceFile}: ${failure.error}`);
    }
    if (result.failures.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  const { askIndexedDocuments } = await import("../retrieval/pipeline.js");
  const result = await askIndexedDocuments(
    config,
    command.question,
    printProgress,
    command.scope,
  );
  console.log("");
  console.log(result.answer);
  if (result.matchedDocuments.length > 0) {
    console.log("\nMatched documents:");
    for (const document of result.matchedDocuments) {
      console.log(
        `${document.sourceFile} (${document.retrievedElementCount} retrieved elements)`,
      );
    }
  }
  if (result.sources.length > 0) {
    console.log("\nSources:");
    for (let index = 0; index < result.sources.length; index += 1) {
      const source = result.sources[index];
      if (source === undefined) {
        continue;
      }
      const pages = source.pageNumbers.length === 0
        ? "unknown"
        : source.pageNumbers.join(", ");
      console.log(
        `[${source.citationNumber}] ${source.kind}, pages ${pages}, ${source.sourceFile} (${source.documentId})`,
      );
    }
  }
}

async function runHostAuthenticationRecovery(
  database: AppConfig["database"],
  apply: boolean,
): Promise<void> {
  const { OAuthApplicationStore } = await import(
    "../oauth/application-store.js"
  );
  const session = await openDatabase(database);
  try {
    const authentication = new OAuthApplicationStore(session.database);
    const status = apply
      ? await authentication.recoverLocalAuthentication()
      : await authentication.readHostRecoveryStatus();
    printHostAuthenticationRecovery(status, apply);
  } finally {
    await session.close();
  }
}

async function readEffectiveCliConfig(
  database: AppConfig["database"],
): Promise<EffectiveApplicationSettings> {
  const session = await openDatabase(database);
  try {
    const repository = new ApplicationSettingsRepository(session.database);
    return await repository.read(database);
  } finally {
    await session.close();
  }
}
