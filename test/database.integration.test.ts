import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";

import {
  and,
  asc,
  cosineDistance,
  desc,
  eq,
  inArray,
  isNotNull,
  ne,
  sql,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRerankingModelV4 } from "ai/test";

import { IngestionArtifactStore } from "../src/ingestion/artifact-store.js";
import { reconcileIngestionControlExecutions } from "../src/ingestion/control.js";
import {
  deleteIndexedDocumentWithRuntime,
  finalizeIngestionCancellation,
} from "../src/ingestion/deletion.js";
import {
  PostgresApplicationStateRevisionSource,
  readApplicationStateRevisions,
  type ApplicationStateRevisionSignal,
} from "../src/app/application-state-revisions.js";
import {
  ApplicationSettingsRepository,
  SettingsVersionConflictError,
} from "../src/app/settings.js";
import {
  pinEmbeddingSpace,
  readEmbeddingSpaceGcReport,
  runEmbeddingSpaceGarbageCollection,
} from "../src/embedding/space/retention.js";
import { DoclingBenchmarkStore } from "../scripts/docling-benchmark/store.js";
import {
  doclingBenchmarkProfilingStages,
  doclingBenchmarkResults,
  doclingBenchmarkRuns,
} from "../scripts/docling-benchmark/schema.js";
import {
  initializeDoclingBenchmarkSchema,
} from "../scripts/docling-benchmark/setup.js";
import {
  DoclingTaskDeadlineError,
  type DoclingJsonRequester,
} from "../src/docling/client/index.js";
import {
  DoclingMetricsStore,
  type DoclingMetricsRecorder,
} from "../src/docling/observability/metrics-store.js";
import type { DoclingRequestObserver } from "../src/docling/client/observer.js";
import { ApplicationErrorReporter } from "../src/observability/application-errors.js";
import {
  purgeApplicationErrors,
  readApplicationErrorPage,
} from "../src/observability/application-error-store.js";
import {
  deleteApplicationErrorRetentionBatch,
  enforceApplicationErrorRetention,
} from "../src/observability/application-error-retention.js";
import {
  DoclingServiceStore,
  type DoclingServiceVerification,
} from "../src/docling/service-store.js";
import {
  type DoclingBenchmarkCandidate,
  type DoclingBenchmarkEnvironment,
  type DoclingBenchmarkProcessConfiguration,
} from "../scripts/docling-benchmark/model.js";
import { createDoclingAttemptConfigSnapshot } from "../src/docling/protocol/run-metadata.js";
import {
  buildDoclingConversionOptions,
  readDoclingEffectiveRequestOptions,
  readDoclingRequestConfiguration,
} from "../src/docling/client/conversion-request.js";
import {
  DocumentCatalog,
  QueryScopeNotResolvedError,
  type Clock,
  type RunningIngestionJob,
} from "../src/documents/catalog/index.js";
import { readDocumentFormat } from "../src/documents/format.js";
import type {
  ResolvedQueryScopeTarget,
} from "../src/domain/query-scope.js";
import {
  queueDocumentReindex,
} from "../src/ingestion/service.js";
import {
  browseDocumentCatalog,
  type BrowseDocumentCatalogRequest,
} from "../src/documents/catalog/browser.js";
import {
  type AppConfig,
  type DoclingServiceInstanceConfig,
  type EmbeddingSpaceConfig,
  type FilesystemSourceContentConfig,
  type S3SourceContentConfig,
} from "../src/config/index.js";
import {
  type CiteLoomDatabase,
  type DatabaseSession,
  migrateDatabase,
  openDatabase,
} from "../src/database/client.js";
import { applyDatabaseBootstrap } from "../src/database/administrator-bootstrap.js";
import {
  applicationSettings,
  activeRetrievalChunks384,
  activeRetrievalEvidence,
  activeRetrievalLexicalChunks,
  activeRetrievalRoutes,
  applicationRevisions,
  applicationErrorEvents,
  citationRecords,
  embeddingSpaces,
  embeddingSpaceGcRuns,
  embeddingSpaceGcSpaces,
  embeddingSpacePins,
  documentVersions,
  doclingArtifacts,
  doclingErrorDetails,
  doclingConversionRequests,
  doclingConversionRuns,
  doclingProfilingStages,
  doclingServiceInstances,
  doclingTaskCheckpoints,
  documentElementSets,
  inferenceLimits,
  inferenceQueue,
  inferenceSchedulingEvents,
  inferenceSlots,
  indexedDocuments,
  indexedDocumentSpaces,
  ingestionEmbeddingManifests,
  ingestionJobs,
  providerOAuthCredentials,
  researchClaimChecks,
  researchClaimEvidenceUnits,
  researchStatementCitations,
  retrievalChunks384,
  retrievalChunks768,
  retrievalChunks1024,
  retrievalChunks1536,
  retrievalChunks2048,
  retrievalLexicalChunks,
  retrievalDescriptionArtifacts,
  retrievalTocArtifacts,
  researchFeedback,
  researchStatements,
  researchThreads,
  researchTurns,
  sourceElements,
  sourceContentDeletions,
  sourceContentMigrations,
  sourceDocuments,
  sourceLibraries,
  users,
  workspaceLibraryGrants,
  workspaces,
  workerHeartbeats,
} from "../src/database/schema.js";
import {
  readActiveRetrievalVectorTableName,
  readActiveRetrievalVectorTable,
} from "../src/embedding/storage-tables.js";
import {
  OpenAICodexCredentialStore,
  OpenAICodexProviderInUseError,
} from "../src/providers/openai-codex-credentials.js";
import type {
  RetrievalDescriptionRecord,
} from "../src/domain/retrieval-descriptions.js";
import {
  parseStoredApplicationSettings,
  type StoredApplicationSettings,
} from "../src/providers/settings-persistence.js";
import type {
  ImageElement,
  SourceElement,
  TableElement,
} from "../src/domain/source-elements.js";
import { InferenceCoordinator } from "../src/inference/coordinator.js";
import { InferenceMetricsReporter } from "../src/inference/metrics.js";
import { IngestionProcessor } from "../src/ingestion/processor.js";
import {
  beginEmbeddingGeneration,
  deleteRetrievalGenerationRows,
  ensureEmbeddingSpace,
  readKeywordMatchingDocumentKeys,
  retrieveKeywordDiscoveryPage,
  retrieveRelevantElements,
  stageRetrievalRepresentationBatch,
} from "../src/retrieval/indexing/index.js";
import {
  createRetrievalRepresentations,
  type RetrievalRepresentation,
} from "../src/retrieval/representations.js";
import {
  loadRetrievalCandidates,
  queryRetrievalCandidateRankings,
  rankRetrievalCandidates,
  RetrievalScopeChangedError,
} from "../src/retrieval/indexing/query-store.js";
import { queryDenseEvidenceCandidates } from "../src/retrieval/indexing/vector-query-store.js";
import {
  synchronizeActiveRetrievalProjection,
} from "../src/retrieval/indexing/active-projection-store.js";
import {
  createActiveRetrievalPartitionName,
  ensureActiveRetrievalSpacePartitions,
} from "../src/retrieval/indexing/active-projection-partitions.js";
import {
  createRetrievalWindows,
} from "../src/retrieval/windows.js";
import {
  SourceDocumentStore,
} from "../src/documents/storage/source-document-store.js";
import {
  SourceContentBackendChangedError,
  SourceContentStore,
  type StoredSourceDocument,
} from "../src/documents/storage/source-content-store.js";
import {
  copyAndVerifySourceContentDocument,
  migrateSourceContentBackend,
} from "../src/documents/storage/source-content-migration.js";
import {
  runSourceContentMigrationWorker,
} from "../src/documents/storage/source-content-migration-runner.js";
import {
  SourceContentMigrationConflictError,
  SourceContentMigrationRepository,
} from "../src/documents/storage/source-content-migration-store.js";
import {
  createSourceContentBackend,
} from "../src/documents/storage/source-content-backend.js";
import { S3SourceContentBackend } from "../src/documents/storage/s3-source-content-backend.js";
import {
  createRetrievalWindowPolicy,
  createRetrievalWindowPolicyContract,
} from "../src/retrieval/window-policy.js";
import {
  readActiveDocumentTocs,
  stageDocumentTocArtifact,
} from "../src/retrieval/toc/store.js";
import { runIngestionWorker } from "../src/ingestion/worker.js";
import {
  buildResearchRunConfiguration,
  ResearchStore,
} from "../src/research/store.js";
import type { ResearchRetrievalTrace } from "../src/research/types.js";
import {
  createTestRuntimeSettings,
  EQUAL_WEIGHT_FUSION_CONFIG,
  readEqualWeightTestConfig,
  TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
} from "./config-fixture.js";
import { createTestProviderSettings } from "./provider-settings-fixture.js";
import {
  buildRetrievalDescriptionRecord,
  buildSourceLocation,
  buildTableStructure,
} from "./source-element-fixture.js";
import { createDeferred } from "./deferred-fixture.js";
import { TaskLimiter } from "../src/shared/concurrency.js";

const databaseUrl = process.env.CITELOOM_TEST_DATABASE_URL
  ?? "postgresql://citeloom:citeloom@127.0.0.1:5433/citeloom_test";
const testRetrievalWindow = createRetrievalWindowPolicyContract(
  createRetrievalWindowPolicy("structured-token-v3", 512, 2_048),
);
const testRetrievalWindowIdentity =
  `window-${testRetrievalWindow.fingerprint.slice(0, 16)}`;
const space768: EmbeddingSpaceConfig = {
  dimensions: 768,
  id: `test-embedding:plain:768:${testRetrievalWindowIdentity}:representations-v2`,
  inputFormat: TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
  model: "test-embedding",
  retrievalWindow: testRetrievalWindow,
};

async function prepareTestIngestion(
  catalog: DocumentCatalog,
  sourceFile: string,
  documentId: string,
  embeddingSpaceId: string,
  requestedTags: string[],
  force: boolean,
  maxAttempts: number = 3,
  duplicateSourceRoot: string | null = null,
  uploadedByUserId: string | null = null,
  sourceLibraryId: string | null = null,
) {
  await ensureTestSourceMetadata(documentId);
  return catalog.prepareIngestion({
    documentId,
    duplicateSourceRoot,
    embeddingSpaceId,
    force,
    format: readDocumentFormat(sourceFile),
    maxAttempts,
    requestedTags,
    sourceFile,
    sourceLibraryId,
    uploadedByUserId,
  });
}

async function ensureTestSourceMetadata(documentId: string): Promise<void> {
  await session.database
    .insert(sourceDocuments)
    .values({
      byteLength: 1,
      documentId,
    })
    .onConflictDoNothing({ target: sourceDocuments.documentId });
}

async function claimTestJob(
  catalog: DocumentCatalog,
  sourceFile: string,
  phase: RunningIngestionJob["phase"],
): Promise<RunningIngestionJob> {
  const job = await catalog.claimJob(sourceFile, phase);
  expect(job).not.toBeNull();
  if (job === null) {
    throw new Error(`Could not claim test ingestion ${sourceFile}.`);
  }
  return job;
}

async function readTestLeaseOwner(
  catalog: DocumentCatalog,
  sourceFile: string,
): Promise<string> {
  const job = await catalog.getJob(sourceFile);
  if (job === null || job.state !== "running") {
    throw new Error(`Test ingestion has no active lease: ${sourceFile}.`);
  }
  return job.ownerId;
}

async function expireTestIngestionLease(sourceFile: string): Promise<void> {
  await session.database
    .update(ingestionJobs)
    .set({
      leaseExpiresAt: sql`clock_timestamp() - interval '1 millisecond'`,
    })
    .where(eq(ingestionJobs.sourceFile, sourceFile));
}

interface PrepareVlmControlMetricsFixtureInput {
  documentId: string;
  ownerId: string;
  settingsVersion: number;
  sourceFile: string;
  taskId: string;
  username: string;
}

interface VlmControlMetricsFixture {
  catalog: DocumentCatalog;
  config: AppConfig;
  metrics: DoclingMetricsStore;
  recorder: DoclingMetricsRecorder;
  requestObserver: DoclingRequestObserver;
  warnings: string[];
}

async function prepareVlmControlMetricsFixture(
  input: PrepareVlmControlMetricsFixtureInput,
): Promise<VlmControlMetricsFixture> {
  const config = buildTestConfig();
  config.docling.performanceMetricsEnabled = true;
  config.docling.pipeline = "vlm";
  config.docling.vlm = {
    apiToken: "vlm-secret",
    endpointUrl: "http://vlm.test/v1/chat/completions",
    engineType: "api_openai",
    maxOutputTokens: 8_192,
    model: "vlm-model",
    prompt: "Convert this page.",
    providerId: "openai",
    runtimeName: "Test VLM",
  };
  const service = config.doclingServices[0];
  if (service === undefined) {
    throw new Error("Missing default Docling test service.");
  }
  await session.database.insert(users).values({
    displayName: "VLM Control Uploader",
    id: input.ownerId,
    state: "active",
    username: input.username,
    usernameNormalized: input.username,
  });
  const catalog = new DocumentCatalog(session.database, {
    newLeaseOwnerId: () => input.ownerId,
  });
  await prepareTestIngestion(
    catalog,
    input.sourceFile,
    input.documentId,
    space768.id,
    [],
    false,
    3,
    null,
    input.ownerId,
  );
  await claimTestJob(catalog, input.sourceFile, "discovered");
  const services = new DoclingServiceStore(session.database);
  await services.synchronize([
    buildAvailableDoclingServiceVerification(service),
  ]);
  await services.ensureAssignment(input.ownerId, input.sourceFile);
  const attemptConfig = createDoclingAttemptConfigSnapshot(
    config.docling,
    input.settingsVersion,
  );
  await catalog.ensureDoclingAttemptConfig(
    input.sourceFile,
    input.ownerId,
    attemptConfig,
  );
  const metrics = new DoclingMetricsStore(session.database);
  const warnings: string[] = [];
  const recorder = await metrics.startOrResumeRun({
    attemptConfig,
    byteLength: 1,
    documentId: input.documentId,
    fileExtension: ".pdf",
    ingestionAttempt: 1,
    processConfig: {
      numThreads: 4,
      pageBatchSize: 4,
      profilePipelineTimings: false,
    },
    serviceIdentity: buildDoclingServiceIdentity(),
    sourceFile: input.sourceFile,
    startedAt: new Date("2020-01-01T00:00:00.000Z"),
  }, (warning) => warnings.push(warning));
  if (recorder === null) {
    throw new Error("Expected enabled Docling metrics recorder.");
  }
  const metricsSource = {
    byteLength: 1,
    documentId: input.documentId,
    extension: ".pdf",
    kind: "file",
    mediaType: "application/pdf",
    openContent: async () => {
      throw new Error("Control metrics tests do not open source content.");
    },
    sourceFile: input.sourceFile,
  } as const;
  const requestObserver = await recorder.openRequest({
    kind: "content",
    options: readDoclingEffectiveRequestOptions(
      metricsSource,
      buildDoclingConversionOptions(config.docling, metricsSource),
    ),
    requestKey: "structure",
  });
  await requestObserver.observe({
    at: new Date("2020-01-02T00:00:00.000Z"),
    kind: "submitted",
    task: {
      deadlineAt: "2020-01-04T00:00:00.000Z",
      id: input.taskId,
      submittedAt: "2020-01-02T00:00:00.000Z",
    },
    uploadMs: 100,
  });
  expect(await catalog.recordDoclingTaskCheckpoint(
    input.sourceFile,
    input.ownerId,
    "structure",
    {
      deadlineAt: "2020-01-04T00:00:00.000Z",
      id: input.taskId,
      submittedAt: "2020-01-02T00:00:00.000Z",
    },
    service.id,
  )).toBe(true);
  return {
    catalog,
    config,
    metrics,
    recorder,
    requestObserver,
    warnings,
  };
}

function buildTestDocumentFormatRow(sourceFile: string) {
  const format = readDocumentFormat(sourceFile);
  return {
    fileExtension: format.extension,
    mediaType: format.mediaType,
  };
}

const space384: EmbeddingSpaceConfig = {
  dimensions: 384,
  id: `test-embedding:plain:384:${testRetrievalWindowIdentity}:representations-v2`,
  inputFormat: TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
  model: "test-embedding",
  retrievalWindow: testRetrievalWindow,
};
const space1024: EmbeddingSpaceConfig = {
  dimensions: 1024,
  id: `test-embedding:plain:1024:${testRetrievalWindowIdentity}:representations-v2`,
  inputFormat: TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
  model: "test-embedding",
  retrievalWindow: testRetrievalWindow,
};
const space1536: EmbeddingSpaceConfig = {
  dimensions: 1536,
  id: `test-embedding:plain:1536:${testRetrievalWindowIdentity}:representations-v2`,
  inputFormat: TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
  model: "test-embedding",
  retrievalWindow: testRetrievalWindow,
};
const space2048: EmbeddingSpaceConfig = {
  dimensions: 2048,
  id: `test-embedding:plain:2048:${testRetrievalWindowIdentity}:representations-v2`,
  inputFormat: TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
  model: "test-embedding",
  retrievalWindow: testRetrievalWindow,
};
let session: DatabaseSession;
let sourceContentConfig: FilesystemSourceContentConfig;

beforeAll(async () => {
  sourceContentConfig = {
    directory: await mkdtemp(join(tmpdir(), "citeloom-source-content-")),
    kind: "filesystem",
  };
  session = await openDatabase({ poolMax: 4, url: databaseUrl });
  await migrateDatabase(session.database);
  await applyDatabaseBootstrap(session.database, {
    CITELOOM_ADMIN_PASSWORD: "integration test administrator password",
    CITELOOM_ADMIN_USERNAME: "IntegrationAdmin",
    CITELOOM_SOURCE_CONTENT_DIRECTORY: sourceContentConfig.directory,
  });
  await initializeDoclingBenchmarkSchema(session.database);
});

beforeEach(async () => {
  await session.database.delete(doclingErrorDetails);
  await session.database.delete(applicationErrorEvents);
  await session.database.delete(providerOAuthCredentials);
  await session.database.delete(sourceContentMigrations);
  await session.database.delete(applicationSettings);
  const storedSettings = buildDatabaseOwnedSettings();
  await session.database.insert(applicationSettings).values({
    defaults: storedSettings,
    id: "runtime",
    settings: structuredClone(storedSettings),
    version: 1,
  });
  await session.database.delete(researchFeedback);
  await session.database.delete(researchThreads);
  await session.database.delete(embeddingSpaceGcSpaces);
  await session.database.delete(embeddingSpaceGcRuns);
  await session.database.delete(embeddingSpacePins);
  await session.database.delete(retrievalLexicalChunks);
  await session.database.delete(retrievalChunks384);
  await session.database.delete(retrievalChunks768);
  await session.database.delete(retrievalChunks1024);
  await session.database.delete(retrievalChunks1536);
  await session.database.delete(retrievalChunks2048);
  await session.database.delete(ingestionEmbeddingManifests);
  await session.database.delete(retrievalDescriptionArtifacts);
  await session.database.delete(retrievalTocArtifacts);
  await session.database.delete(doclingArtifacts);
  await session.database.delete(doclingBenchmarkRuns);
  await session.database.delete(doclingConversionRuns);
  await session.database.delete(indexedDocumentSpaces);
  await session.database.delete(ingestionJobs);
  await session.database.delete(doclingServiceInstances);
  await session.database.delete(indexedDocuments);
  await session.database.delete(documentVersions);
  await session.database.delete(documentElementSets);
  await session.database.delete(sourceElements);
  await session.database.delete(sourceContentDeletions);
  await session.database.delete(sourceDocuments);
  await session.database.delete(embeddingSpaces);
  await session.database.delete(inferenceSchedulingEvents);
  await session.database.delete(inferenceQueue);
  await session.database.delete(inferenceSlots);
  await session.database.delete(inferenceLimits);
  await session.database.delete(workerHeartbeats);
  await session.database.update(applicationRevisions).set({ revision: 0n });
});

describe("PostgreSQL query execution", () => {
  it("aborts promptly while waiting for a saturated connection pool", async () => {
    const constrainedSession = await openDatabase({ poolMax: 1, url: databaseUrl });
    const withDatabase = constrainedSession.query.withDatabase;
    if (withDatabase === undefined) {
      throw new Error("The PostgreSQL query executor cannot run database operations.");
    }
    const acquired = createDeferred<void>();
    const release = createDeferred<void>();
    const holder = withDatabase(async () => {
      acquired.resolve();
      await release.promise;
    });
    await acquired.promise;
    const abortController = new AbortController();
    const startedAt = performance.now();
    const waiting = withDatabase(async () => "unexpected", {
      abortSignal: abortController.signal,
    });
    abortController.abort();
    try {
      await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
      expect(performance.now() - startedAt).toBeLessThan(500);
    } finally {
      release.resolve();
      await holder;
    }
    await expect(withDatabase(async () => "recovered"))
      .resolves.toBe("recovered");
    await constrainedSession.close();
  });

  it("cancels, rolls back, and recovers an in-flight PostgreSQL query", async () => {
    const withDatabase = session.query.withDatabase;
    if (withDatabase === undefined) {
      throw new Error("The PostgreSQL query executor cannot run database operations.");
    }
    const abortController = new AbortController();
    const startedAt = performance.now();
    const pendingQuery = withDatabase(
      async (database) => {
        await database.transaction(async (transaction) => {
          await transaction
            .update(applicationRevisions)
            .set({ revision: 99n })
            .where(eq(applicationRevisions.channel, "catalog"));
          await transaction.execute(sql`SELECT pg_sleep(10)`);
        });
      },
      {
        abortSignal: abortController.signal,
        statementTimeoutMs: 5_000,
      },
    );
    const abortTimer = setTimeout(() => {
      abortController.abort();
    }, 50);

    try {
      await expect(pendingQuery).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clearTimeout(abortTimer);
    }

    expect(performance.now() - startedAt).toBeLessThan(3_000);
    await expect(session.database
      .select({ revision: applicationRevisions.revision })
      .from(applicationRevisions)
      .where(eq(applicationRevisions.channel, "catalog")))
      .resolves.toEqual([{ revision: 0n }]);
    await expect(
      session.database.execute(sql`SELECT 1 AS value`),
    ).resolves.toBeDefined();
  });
});

describe("PostgreSQL ingestion controls", () => {
  it("removes a canceled job and its unreferenced source content", async () => {
    const sourceFile = "/documents/canceled.pdf";
    const content = Buffer.from("canceled source content");
    const documentId = createHash("sha256").update(content).digest("hex");
    const sourceContentStore = new SourceContentStore(
      session.database,
      sourceContentConfig,
    );
    await sourceContentStore.writeDocument({ content, documentId });
    await session.database.insert(ingestionJobs).values({
      controlState: "cancel_requested",
      documentId,
      embeddingSpaceId: "test:plain:768",
      fileExtension: ".pdf",
      generationId: randomUUID(),
      mediaType: "application/pdf",
      sourceFile,
    });

    await expect(finalizeIngestionCancellation(
      session.database,
      sourceFile,
      sourceContentConfig,
    )).resolves.toEqual({ kind: "canceled" });
    await expect(session.database
      .select({ documentId: sourceContentDeletions.documentId })
      .from(sourceContentDeletions)
      .where(eq(sourceContentDeletions.documentId, documentId)))
      .resolves.toEqual([{ documentId }]);
    await session.database
      .update(sourceDocuments)
      .set({ lastPublishedAt: new Date("2026-07-24T00:00:00.000Z") })
      .where(eq(sourceDocuments.documentId, documentId));
    await sourceContentStore.reconcilePendingDeletions();
    await expect(access(join(
      sourceContentConfig.directory,
      "sha256",
      documentId.slice(0, 2),
      documentId,
    ))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(session.database
      .select({ sourceFile: ingestionJobs.sourceFile })
      .from(ingestionJobs)
      .where(eq(ingestionJobs.sourceFile, sourceFile)))
      .resolves.toEqual([]);
    await expect(session.database
      .select({ documentId: sourceDocuments.documentId })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.documentId, documentId)))
      .resolves.toEqual([]);
    await expect(session.database
      .select({ documentId: sourceContentDeletions.documentId })
      .from(sourceContentDeletions)
      .where(eq(sourceContentDeletions.documentId, documentId)))
      .resolves.toEqual([]);
  });

  it("removes active retrieval projections through document deletion", async () => {
    const sourceFile = "/documents/delete-active-projection.pdf";
    const content = Buffer.from("x");
    const documentId = createHash("sha256").update(content).digest("hex");
    const generationId = randomUUID();
    const element = buildTextElement(documentId, "9".repeat(64));
    element.sourceFile = sourceFile;
    const sourceContentStore = new SourceContentStore(
      session.database,
      sourceContentConfig,
    );
    await sourceContentStore.writeDocument({ content, documentId });
    await ensureEmbeddingSpace(session.database, space384);
    await indexTestElements(
      session.database,
      space384,
      documentId,
      generationId,
      [],
      [buildEmbedding(space384.dimensions, 1)],
      [element],
    );
    await writeIndexedDocument(documentId, sourceFile, randomUUID());
    expect(await readActiveProjectionCounts384(space384.id, sourceFile))
      .toEqual({ evidence: 1, lexical: 1, pointers: 1, routes: 1, vectors: 1 });

    await expect(deleteIndexedDocumentWithRuntime({
      config: { sourceContent: sourceContentConfig },
      database: session.database,
    }, {
      documentId,
      sourceFile,
    })).resolves.toEqual({ kind: "deleted", sourceFile });

    expect(await readActiveProjectionCounts384(space384.id, sourceFile))
      .toEqual({ evidence: 0, lexical: 0, pointers: 0, routes: 0, vectors: 0 });
  });

  it("settles a running pause request and resumes it as pending work", async () => {
    const uploaderId = "00000000-0000-4000-8000-000000000293";
    await session.database.insert(users).values({
      displayName: "Running Ingestion Uploader",
      id: uploaderId,
      state: "active",
      username: "running-ingestion-uploader",
      usernameNormalized: "running-ingestion-uploader",
    }).onConflictDoNothing();
    const sourceFile = "/app/documents/uploads/control-test/running.pdf";
    await ensureTestSourceMetadata("8".repeat(64));
    await session.database.insert(ingestionJobs).values({
      documentId: "8".repeat(64),
      embeddingSpaceId: "test:plain:768",
      fileExtension: ".pdf",
      generationId: randomUUID(),
      mediaType: "application/pdf",
      nextAttemptAt: new Date(0),
      sourceFile,
      uploadedByUserId: uploaderId,
    });
    const catalog = new DocumentCatalog(session.database);
    await claimTestJob(catalog, sourceFile, "discovered");
    const paused = await catalog.requestIngestionControl(sourceFile, "pause", {
      isAdministrator: true,
      userId: uploaderId,
    });
    expect(paused.kind).toBe("accepted");
    if (paused.kind !== "accepted") {
      throw new Error("The running ingestion could not be paused.");
    }
    expect(paused.job.controlState).toBe("pause_requested");

    const settled = await catalog.settleOwnedIngestionControl(
      sourceFile,
      await readTestLeaseOwner(catalog, sourceFile),
    );
    expect(settled?.controlState).toBe("paused");
    expect(settled?.state).toBe("pending");
    const resumed = await catalog.resumePausedIngestion(sourceFile, {
      isAdministrator: true,
      userId: uploaderId,
    });
    expect(resumed.kind).toBe("resumed");
    if (resumed.kind !== "resumed") {
      throw new Error("The paused ingestion could not be resumed.");
    }
    expect(resumed.job.controlState).toBe("active");
  });

  it("retains the Docling checkpoint while pausing and resumes on the same service", async () => {
    const ownerId = randomUUID();
    const taskId = randomUUID();
    const username = `pause-control-${ownerId.slice(0, 8)}`;
    const sourceFile = "/documents/control-docling-pause.pdf";
    const config = buildTestConfig();
    const service = config.doclingServices[0];
    if (service === undefined) {
      throw new Error("Missing default Docling test service.");
    }
    await session.database.insert(users).values({
      displayName: "Pause Control Uploader",
      id: ownerId,
      state: "active",
      username,
      usernameNormalized: username,
    });
    const catalog = new DocumentCatalog(session.database, {
      newLeaseOwnerId: () => ownerId,
    });
    await prepareTestIngestion(
      catalog,
      sourceFile,
      "7".repeat(64),
      space768.id,
      [],
      false,
      3,
      null,
      ownerId,
    );
    await claimTestJob(catalog, sourceFile, "discovered");
    const services = new DoclingServiceStore(session.database);
    await services.synchronize([
      buildAvailableDoclingServiceVerification(service),
    ]);
    await services.ensureAssignment(ownerId, sourceFile);
    const attemptConfig = createDoclingAttemptConfigSnapshot(config.docling, 21);
    await catalog.ensureDoclingAttemptConfig(sourceFile, ownerId, attemptConfig);
    expect(await catalog.recordDoclingTaskCheckpoint(
      sourceFile,
      ownerId,
      "structure",
      {
        deadlineAt: "2026-07-27T01:00:00.000Z",
        id: taskId,
        submittedAt: "2026-07-26T19:00:00.000Z",
      },
      service.id,
    )).toBe(true);
    const control = await catalog.requestIngestionControl(
      sourceFile,
      "pause",
      { isAdministrator: true, userId: ownerId },
    );
    expect(control.kind).toBe("accepted");

    await expect(catalog.settleOwnedIngestionControl(
      sourceFile,
      ownerId,
    )).resolves.toBeNull();
    await expect(catalog.readRequestedControlDoclingTasks(sourceFile))
      .resolves.toEqual(expect.arrayContaining([{
        controlState: "pause_requested",
        serviceInstanceId: service.id,
        sourceFile,
        taskId,
      }]));
    expect(await catalog.recordIngestionControlError(
      sourceFile,
      "termination unavailable",
    )).toBe(true);
    await expect(catalog.getJob(sourceFile)).resolves.toMatchObject({
      controlError: "termination unavailable",
      controlState: "pause_requested",
      state: "running",
    });

    const pauseTask = vi.fn(async () => ({ kind: "paused" as const }));
    await expect(reconcileIngestionControlExecutions(
      session.database,
      config,
      sourceFile,
      { pauseTask },
    )).resolves.toEqual({ failed: 0, terminated: 1 });
    expect(pauseTask).toHaveBeenCalledExactlyOnceWith({
      apiKey: config.docling.apiKey,
      baseUrl: service.baseUrl,
      requestTimeoutMs: config.docling.requestTimeoutMs,
      taskId,
    });
    await expect(catalog.getJob(sourceFile)).resolves.toMatchObject({
      controlError: null,
      controlState: "paused",
      doclingAttemptConfig: attemptConfig,
      state: "pending",
    });
    const pausedJobRows = await session.database
      .select({
        serviceId: ingestionJobs.doclingServiceInstanceId,
        slot: ingestionJobs.doclingServiceSlot,
      })
      .from(ingestionJobs)
      .where(eq(ingestionJobs.sourceFile, sourceFile));
    expect(pausedJobRows).toEqual([{ serviceId: null, slot: null }]);
    const checkpointRows = await session.database
      .select()
      .from(doclingTaskCheckpoints)
      .where(eq(doclingTaskCheckpoints.sourceFile, sourceFile));
    expect(checkpointRows).toHaveLength(1);
    expect(checkpointRows[0]?.taskId).toBe(taskId);

    const resumed = await catalog.resumePausedIngestion(sourceFile, {
      isAdministrator: true,
      userId: ownerId,
    });
    expect(resumed.kind).toBe("resumed");
    const claimed = await catalog.claimDoclingJob(
      sourceFile,
      [service.id],
      false,
    );
    expect(claimed?.state).toBe("running");
    if (claimed === null) {
      throw new Error("The resumed Docling job was not claimed.");
    }
    if (claimed.ownerId === null) {
      throw new Error("The resumed Docling job has no lease owner.");
    }
    const resumedOwnerId = claimed.ownerId;
    const resumedAssignment = await services.ensureAssignment(
      resumedOwnerId,
      sourceFile,
    );
    expect(resumedAssignment.id).toBe(service.id);
    await expect(catalog.readDoclingTaskCheckpoint(
      sourceFile,
      resumedOwnerId,
      "structure",
      service.id,
    )).resolves.toMatchObject({ id: taskId });
  });

  it("closes VLM metrics when a lost worker task is terminated", async () => {
    const ownerId = "00000000-0000-4000-8000-000000000294";
    const taskId = "00000000-0000-4000-8000-000000000295";
    const sourceFile = "/documents/control-docling-vlm-pause.pdf";
    const {
      catalog,
      config,
      metrics,
      recorder,
      warnings,
    } = await prepareVlmControlMetricsFixture({
      documentId: "5".repeat(64),
      ownerId,
      settingsVersion: 22,
      sourceFile,
      taskId,
      username: "vlm-pause-control-uploader",
    });
    const control = await catalog.requestIngestionControl(
      sourceFile,
      "pause",
      { isAdministrator: true, userId: ownerId },
    );
    expect(control.kind).toBe("accepted");
    await expireTestIngestionLease(sourceFile);

    const pauseTask = vi.fn(async () => ({ kind: "terminated" as const }));
    await expect(reconcileIngestionControlExecutions(
      session.database,
      config,
      sourceFile,
      { pauseTask },
    )).resolves.toEqual({ failed: 0, terminated: 1 });
    await expect(catalog.getJob(sourceFile)).resolves.toMatchObject({
      controlState: "paused",
      doclingAttemptConfig: null,
      doclingRunId: null,
      state: "pending",
    });
    const checkpoints = await session.database
      .select({ taskId: doclingTaskCheckpoints.taskId })
      .from(doclingTaskCheckpoints)
      .where(eq(doclingTaskCheckpoints.sourceFile, sourceFile));
    expect(checkpoints).toEqual([]);
    const runRows = await session.database
      .select({
        completedAt: doclingConversionRuns.completedAt,
        errorCategory: doclingConversionRuns.errorCategory,
        outcome: doclingConversionRuns.outcome,
      })
      .from(doclingConversionRuns)
      .where(eq(doclingConversionRuns.id, recorder.runId));
    expect(runRows).toEqual([{
      completedAt: expect.any(Date),
      errorCategory: "IngestionControlInterruption",
      outcome: "abort",
    }]);
    const abortedAt = runRows[0]?.completedAt;
    if (abortedAt === null || abortedAt === undefined) {
      throw new Error("The controlled Docling run has no completion time.");
    }
    const requestRows = await session.database
      .select({
        completedAt: doclingConversionRequests.completedAt,
        errorCategory: doclingConversionRequests.errorCategory,
        outcome: doclingConversionRequests.outcome,
      })
      .from(doclingConversionRequests)
      .where(eq(doclingConversionRequests.runId, recorder.runId));
    expect(requestRows).toEqual([{
      completedAt: abortedAt,
      errorCategory: "abort",
      outcome: "abort",
    }]);
    expect(warnings).toEqual([]);
    await session.database
      .update(doclingConversionRuns)
      .set({ completedAt: new Date("2020-01-03T00:00:00.000Z") })
      .where(eq(doclingConversionRuns.id, recorder.runId));
    expect(await metrics.deleteExpiredRuns(1, 1)).toBe(1);
    expect(await session.database
      .select({ id: doclingConversionRuns.id })
      .from(doclingConversionRuns)
      .where(eq(doclingConversionRuns.id, recorder.runId)))
      .toEqual([]);
    expect(await session.database
      .select({ id: doclingConversionRequests.id })
      .from(doclingConversionRequests)
      .where(eq(doclingConversionRequests.runId, recorder.runId)))
      .toEqual([]);
  });

  it("serializes VLM control settlement with metrics completion", async () => {
    const ownerId = "00000000-0000-4000-8000-000000000298";
    const taskId = "00000000-0000-4000-8000-000000000299";
    const sourceFile = "/documents/control-docling-vlm-concurrent-pause.pdf";
    const {
      catalog,
      config,
      recorder,
      requestObserver,
      warnings,
    } = await prepareVlmControlMetricsFixture({
      documentId: "6".repeat(64),
      ownerId,
      settingsVersion: 23,
      sourceFile,
      taskId,
      username: "vlm-concurrent-pause-control-uploader",
    });
    await requestObserver.observe({
      at: new Date("2020-01-02T00:00:01.000Z"),
      kind: "transport-failed",
      outcome: "abort",
      totalMs: 1_000,
    });
    const control = await catalog.requestIngestionControl(
      sourceFile,
      "pause",
      { isAdministrator: true, userId: ownerId },
    );
    expect(control.kind).toBe("accepted");

    const withDatabase = session.query.withDatabase;
    if (withDatabase === undefined) {
      throw new Error("The PostgreSQL query executor cannot run database operations.");
    }
    const gateLocked = createDeferred<void>();
    const releaseGate = createDeferred<void>();
    let gateHolder: Promise<void> | null = null;
    let metricsCompletion: Promise<void> | null = null;
    let controlCompletion: Promise<{
      failed: number;
      terminated: number;
    }> | null = null;

    try {
      await session.database.execute(sql`
        CREATE TABLE test_docling_metrics_lock_gate (
          id integer PRIMARY KEY
        )
      `);
      await session.database.execute(sql`
        CREATE FUNCTION test_wait_for_docling_metrics_gate() RETURNS trigger AS $$
        BEGIN
          PERFORM count(*) FROM test_docling_metrics_lock_gate;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
      `);
      await session.database.execute(sql`
        CREATE TRIGGER test_wait_for_docling_metrics_gate
        BEFORE UPDATE ON docling_conversion_runs
        FOR EACH ROW EXECUTE FUNCTION test_wait_for_docling_metrics_gate()
      `);
      gateHolder = withDatabase(async (database) => {
        await database.transaction(async (transaction) => {
          await transaction.execute(sql`
            LOCK TABLE test_docling_metrics_lock_gate IN ACCESS EXCLUSIVE MODE
          `);
          gateLocked.resolve();
          await releaseGate.promise;
        });
      });
      await gateLocked.promise;

      metricsCompletion = recorder.completeFailure(
        "abort",
        "IngestionControlInterruption",
        1_000,
      );
      await waitForTableLockWaiters("test_docling_metrics_lock_gate", 1);
      const pauseTask = vi.fn(async () => ({ kind: "terminated" as const }));
      controlCompletion = reconcileIngestionControlExecutions(
        session.database,
        config,
        sourceFile,
        { pauseTask },
      );
      await waitForDatabaseLockWaiters(2);
      releaseGate.resolve();

      await gateHolder;
      await metricsCompletion;
      await expect(controlCompletion).resolves.toEqual({
        failed: 0,
        terminated: 1,
      });
      expect(warnings).toEqual([]);
      await expect(catalog.settleOwnedIngestionControl(
        sourceFile,
        ownerId,
      )).resolves.toMatchObject({
        controlState: "paused",
        state: "pending",
      });
      await expect(catalog.getJob(sourceFile)).resolves.toMatchObject({
        controlError: null,
        controlState: "paused",
        doclingAttemptConfig: null,
        doclingRunId: null,
        state: "pending",
      });
    } finally {
      releaseGate.resolve();
      const pendingOperations: Promise<unknown>[] = [];
      if (gateHolder !== null) {
        pendingOperations.push(gateHolder);
      }
      if (metricsCompletion !== null) {
        pendingOperations.push(metricsCompletion);
      }
      if (controlCompletion !== null) {
        pendingOperations.push(controlCompletion);
      }
      await Promise.allSettled(pendingOperations);
      await session.database.execute(sql`
        DROP TRIGGER IF EXISTS test_wait_for_docling_metrics_gate
        ON docling_conversion_runs
      `);
      await session.database.execute(sql`
        DROP FUNCTION IF EXISTS test_wait_for_docling_metrics_gate()
      `);
      await session.database.execute(sql`
        DROP TABLE IF EXISTS test_docling_metrics_lock_gate
      `);
    }
  });

  it("does not delete a cancellation while a Docling checkpoint remains", async () => {
    const ownerId = "00000000-0000-4000-8000-000000000296";
    const taskId = "00000000-0000-4000-8000-000000000297";
    const sourceFile = "/documents/control-docling-cancel.pdf";
    const config = buildTestConfig();
    const service = config.doclingServices[0];
    if (service === undefined) {
      throw new Error("Missing default Docling test service.");
    }
    await session.database.insert(users).values({
      displayName: "Cancel Control Uploader",
      id: ownerId,
      state: "active",
      username: "cancel-control-uploader",
      usernameNormalized: "cancel-control-uploader",
    });
    const catalog = new DocumentCatalog(session.database, {
      newLeaseOwnerId: () => ownerId,
    });
    await prepareTestIngestion(
      catalog,
      sourceFile,
      "6".repeat(64),
      space768.id,
      [],
      false,
      3,
      null,
      ownerId,
    );
    await claimTestJob(catalog, sourceFile, "discovered");
    const services = new DoclingServiceStore(session.database);
    await services.synchronize([
      buildAvailableDoclingServiceVerification(service),
    ]);
    await services.ensureAssignment(ownerId, sourceFile);
    expect(await catalog.recordDoclingTaskCheckpoint(
      sourceFile,
      ownerId,
      "structure",
      {
        deadlineAt: "2026-07-27T01:00:00.000Z",
        id: taskId,
        submittedAt: "2026-07-26T19:00:00.000Z",
      },
      service.id,
    )).toBe(true);
    const control = await catalog.requestIngestionControl(
      sourceFile,
      "cancel",
      { isAdministrator: true, userId: ownerId },
    );
    expect(control.kind).toBe("accepted");
    await expireTestIngestionLease(sourceFile);

    await catalog.settleExpiredIngestionControls();
    await expect(catalog.getJob(sourceFile)).resolves.toMatchObject({
      controlState: "cancel_requested",
      state: "running",
    });
    await expect(finalizeIngestionCancellation(
      session.database,
      sourceFile,
      sourceContentConfig,
    )).resolves.toEqual({ kind: "pending" });

    const failedTerminateTask = vi.fn(async () => {
      throw new Error("termination endpoint unavailable");
    });
    await expect(reconcileIngestionControlExecutions(
      session.database,
      config,
      sourceFile,
      { terminateTask: failedTerminateTask },
    )).resolves.toEqual({ failed: 1, terminated: 0 });
    await expect(catalog.getJob(sourceFile)).resolves.toMatchObject({
      controlError: "termination endpoint unavailable",
      controlState: "cancel_requested",
      state: "running",
    });

    const terminateTask = vi.fn(async () => undefined);
    await expect(reconcileIngestionControlExecutions(
      session.database,
      config,
      sourceFile,
      { terminateTask },
    )).resolves.toEqual({ failed: 0, terminated: 1 });
    expect(terminateTask).toHaveBeenCalledExactlyOnceWith({
      apiKey: config.docling.apiKey,
      baseUrl: service.baseUrl,
      requestTimeoutMs: config.docling.requestTimeoutMs,
      taskId,
    });
    await expect(catalog.getJob(sourceFile)).resolves.toMatchObject({
      controlState: "cancel_requested",
      state: "pending",
    });
    await expect(finalizeIngestionCancellation(
      session.database,
      sourceFile,
      sourceContentConfig,
    )).resolves.toEqual({ kind: "canceled" });
    await expect(catalog.getJob(sourceFile)).resolves.toBeNull();
  });

  it("enforces ownership and gives cancellation precedence over pause", async () => {
    const uploaderId = "00000000-0000-4000-8000-000000000291";
    await session.database.insert(users).values({
      displayName: "Ingestion Uploader",
      id: uploaderId,
      state: "active",
      username: "ingestion-uploader",
      usernameNormalized: "ingestion-uploader",
    }).onConflictDoNothing();
    const sourceFile = "/app/documents/uploads/control-test/document.pdf";
    await ensureTestSourceMetadata("9".repeat(64));
    await session.database.insert(ingestionJobs).values({
      documentId: "9".repeat(64),
      embeddingSpaceId: "test:plain:768",
      fileExtension: ".pdf",
      generationId: randomUUID(),
      mediaType: "application/pdf",
      sourceFile,
      uploadedByUserId: uploaderId,
    });
    const catalog = new DocumentCatalog(session.database);

    await expect(catalog.requestIngestionControl(sourceFile, "pause", {
      isAdministrator: false,
      userId: "00000000-0000-4000-8000-000000000292",
    })).resolves.toEqual({ kind: "forbidden" });

    const paused = await catalog.requestIngestionControl(sourceFile, "pause", {
      isAdministrator: false,
      userId: uploaderId,
    });
    expect(paused.kind).toBe("accepted");
    if (paused.kind !== "accepted") {
      throw new Error("The uploader could not pause the ingestion.");
    }
    expect(paused.job.controlState).toBe("paused");

    const canceled = await catalog.requestIngestionControl(sourceFile, "cancel", {
      isAdministrator: false,
      userId: uploaderId,
    });
    expect(canceled.kind).toBe("accepted");
    if (canceled.kind !== "accepted") {
      throw new Error("The uploader could not cancel the ingestion.");
    }
    expect(canceled.job.controlState).toBe("cancel_requested");
    await expect(catalog.resumePausedIngestion(sourceFile, {
      isAdministrator: false,
      userId: uploaderId,
    })).resolves.toEqual({ kind: "not-paused" });
  });

  it("allows administrators to control ownerless ingestion jobs", async () => {
    const content = Buffer.from("ownerless reindex control");
    const documentId = createHash("sha256").update(content).digest("hex");
    const sourceFile = "/app/documents/uploads/control-test/reindex.pdf";
    const sourceContentStore = new SourceContentStore(
      session.database,
      sourceContentConfig,
    );
    await sourceContentStore.writeDocument({ content, documentId });
    await session.database.insert(ingestionJobs).values({
      documentId,
      embeddingSpaceId: "test:plain:768",
      fileExtension: ".pdf",
      generationId: randomUUID(),
      mediaType: "application/pdf",
      sourceFile,
      uploadedByUserId: null,
    });
    const catalog = new DocumentCatalog(session.database);

    await expect(catalog.requestIngestionControl(sourceFile, "pause", {
      isAdministrator: false,
      userId: "00000000-0000-4000-8000-000000000292",
    })).resolves.toEqual({ kind: "forbidden" });

    await expect(catalog.requestIngestionControl(sourceFile, "pause", {
      isAdministrator: true,
      userId: "00000000-0000-4000-8000-000000000293",
    })).resolves.toMatchObject({
      job: { controlState: "paused" },
      kind: "accepted",
    });
  });

  it("cancels a reindex without deleting the current version", async () => {
    const content = Buffer.from("published document under reindex");
    const documentId = createHash("sha256").update(content).digest("hex");
    const sourceFile = "/app/documents/uploads/control-test/published.pdf";
    const versionId = "00000000-0000-4000-8000-000000000294";
    const sourceContentStore = new SourceContentStore(
      session.database,
      sourceContentConfig,
    );
    await sourceContentStore.writeDocument({ content, documentId });
    await writeIndexedDocument(documentId, sourceFile, versionId);
    const generationId = randomUUID();
    await session.database.insert(ingestionJobs).values({
      controlState: "cancel_requested",
      documentId,
      embeddingSpaceId: "test:plain:768",
      fileExtension: ".pdf",
      generationId,
      mediaType: "application/pdf",
      sourceFile,
      uploadedByUserId: null,
    });
    const element = buildTableElement(documentId, "7".repeat(64), sourceFile);
    const description = buildRetrievalDescriptionRecord(
      element,
      "Temporary description from the canceled reindex.",
    );
    const artifactStore = new IngestionArtifactStore(session.database);
    await artifactStore.writeRetrievalDescription(
      generationId,
      documentId,
      0,
      description,
    );

    await expect(finalizeIngestionCancellation(
      session.database,
      sourceFile,
      sourceContentConfig,
    )).resolves.toEqual({ kind: "canceled" });

    const catalog = new DocumentCatalog(session.database);
    await expect(catalog.getJob(sourceFile)).resolves.toBeNull();
    await expect(session.database
      .select({ versionId: indexedDocuments.versionId })
      .from(indexedDocuments)
      .where(eq(indexedDocuments.sourceFile, sourceFile)))
      .resolves.toEqual([{ versionId }]);
    await expect(session.database
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .where(eq(documentVersions.sourceFile, sourceFile)))
      .resolves.toEqual([{ id: versionId }]);
    await expect(sourceContentStore.readDocument(documentId)).resolves.toEqual({
      content,
      documentId,
    });
    await expect(artifactStore.readRetrievalDescriptionCheckpoints(
      generationId,
      0,
      10,
    )).resolves.toEqual([]);
  });
});

describe("PostgreSQL source-content migration", () => {
  it("keeps the stored backend when bootstrap environment values differ", async () => {
    const targetDirectory = await mkdtemp(
      join(tmpdir(), "citeloom-bootstrap-target-"),
    );

    await expect(applyDatabaseBootstrap(session.database, {
      CITELOOM_ADMIN_PASSWORD: "integration test administrator password",
      CITELOOM_ADMIN_USERNAME: "IntegrationAdmin",
      CITELOOM_SOURCE_CONTENT_BACKEND: "filesystem",
      CITELOOM_SOURCE_CONTENT_DIRECTORY: targetDirectory,
    })).resolves.toBeUndefined();

    const rows = await session.database
      .select({ settings: applicationSettings.settings })
      .from(applicationSettings)
      .where(eq(applicationSettings.id, "runtime"));
    expect(parseStoredApplicationSettings(rows[0]?.settings).sourceContent)
      .toEqual(sourceContentConfig);
  });

  it("copies and verifies all objects before changing the active backend", async () => {
    const content = Buffer.from("source-content migration payload");
    const documentId = createHash("sha256").update(content).digest("hex");
    const source = new SourceContentStore(
      session.database,
      sourceContentConfig,
    );
    await source.writeDocument({ content, documentId });
    const targetConfig: FilesystemSourceContentConfig = {
      directory: await mkdtemp(join(tmpdir(), "citeloom-migration-target-")),
      kind: "filesystem",
    };

    const report = await migrateSourceContentBackend(
      session.database,
      targetConfig,
    );

    expect(report).toMatchObject({ copied: 1, verifiedAtCutover: 1 });
    const target = new SourceContentStore(session.database, targetConfig);
    await expect(target.readDocument(documentId)).resolves.toEqual({
      content,
      documentId,
    });
    const rows = await session.database
      .select({ settings: applicationSettings.settings })
      .from(applicationSettings)
      .where(eq(applicationSettings.id, "runtime"));
    expect(parseStoredApplicationSettings(rows[0]?.settings).sourceContent)
      .toEqual(targetConfig);
  });

  it("leaves the active backend unchanged when verification fails", async () => {
    const content = Buffer.from("content that becomes corrupt");
    const documentId = createHash("sha256").update(content).digest("hex");
    const source = new SourceContentStore(
      session.database,
      sourceContentConfig,
    );
    await source.writeDocument({ content, documentId });
    await writeFile(
      join(
        sourceContentConfig.directory,
        "sha256",
        documentId.slice(0, 2),
        documentId,
      ),
      Buffer.alloc(content.byteLength, 0),
    );
    const targetConfig: FilesystemSourceContentConfig = {
      directory: await mkdtemp(join(tmpdir(), "citeloom-failed-target-")),
      kind: "filesystem",
    };

    await expect(migrateSourceContentBackend(
      session.database,
      targetConfig,
    )).rejects.toThrow("hash does not match");

    const rows = await session.database
      .select({ settings: applicationSettings.settings })
      .from(applicationSettings)
      .where(eq(applicationSettings.id, "runtime"));
    expect(parseStoredApplicationSettings(rows[0]?.settings).sourceContent)
      .toEqual(sourceContentConfig);
  });

  it("resumes from a checkpoint and includes a late document at cutover", async () => {
    const initialContent = Buffer.from("durable migration checkpoint");
    const initialDocumentId = createHash("sha256")
      .update(initialContent)
      .digest("hex");
    const source = new SourceContentStore(
      session.database,
      sourceContentConfig,
    );
    await source.writeDocument({
      content: initialContent,
      documentId: initialDocumentId,
    });
    const targetConfig: FilesystemSourceContentConfig = {
      directory: await mkdtemp(join(tmpdir(), "citeloom-durable-target-")),
      kind: "filesystem",
    };
    const repository = new SourceContentMigrationRepository(session.database);
    const migration = await repository.queue({
      expectedSettingsVersion: 1,
      requestedByUserId: "00000000-0000-4000-8000-000000000301",
      targetConfig,
    });
    const firstOwnerId = randomUUID();
    const claimed = await repository.claim(firstOwnerId);
    expect(claimed?.id).toBe(migration.id);
    await repository.markValidated(migration.id, firstOwnerId);
    const sourceBackend = createSourceContentBackend(sourceContentConfig);
    const targetBackend = createSourceContentBackend(targetConfig);
    await sourceBackend.initialize("read");
    await targetBackend.initialize();
    await copyAndVerifySourceContentDocument(
      sourceBackend,
      targetBackend,
      {
        byteLength: initialContent.byteLength,
        documentId: initialDocumentId,
      },
    );
    await repository.saveCopyProgress(
      migration.id,
      firstOwnerId,
      1,
      initialDocumentId,
      1,
    );
    await repository.releaseLease(migration.id, firstOwnerId);

    let lateContent = Buffer.from("late migration document:0");
    let lateDocumentId = createHash("sha256").update(lateContent).digest("hex");
    let sequence = 0;
    while (lateDocumentId >= initialDocumentId) {
      sequence += 1;
      lateContent = Buffer.from(`late migration document:${sequence}`);
      lateDocumentId = createHash("sha256").update(lateContent).digest("hex");
    }
    await source.writeDocument({ content: lateContent, documentId: lateDocumentId });

    await runSourceContentMigrationWorker(session.database, { once: true });

    const overview = await repository.readOverview();
    expect(overview.activeConfig).toEqual(targetConfig);
    expect(overview.migration).toMatchObject({
      attemptCount: 2,
      copiedDocuments: 2,
      id: migration.id,
      state: "completed",
      totalDocuments: 2,
      verifiedDocuments: 2,
    });
    const target = new SourceContentStore(session.database, targetConfig);
    await expect(target.readDocument(initialDocumentId)).resolves.toEqual({
      content: initialContent,
      documentId: initialDocumentId,
    });
    await expect(target.readDocument(lateDocumentId)).resolves.toEqual({
      content: lateContent,
      documentId: lateDocumentId,
    });
    await expect(source.reconcileDocumentDeletion(initialDocumentId))
      .rejects.toBeInstanceOf(SourceContentBackendChangedError);
    await expect(target.readDocument(initialDocumentId)).resolves.toEqual({
      content: initialContent,
      documentId: initialDocumentId,
    });

    const staleContent = Buffer.from("write through stale source backend");
    const staleDocumentId = createHash("sha256")
      .update(staleContent)
      .digest("hex");
    await expect(source.writeDocument({
      content: staleContent,
      documentId: staleDocumentId,
    })).rejects.toBeInstanceOf(SourceContentBackendChangedError);
    await expect(session.database
      .select({ documentId: sourceDocuments.documentId })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.documentId, staleDocumentId)))
      .resolves.toEqual([]);
    await expect(access(join(
      sourceContentConfig.directory,
      "sha256",
      staleDocumentId.slice(0, 2),
      staleDocumentId,
    ))).rejects.toThrow();
  });

  it("cancels a queued migration without changing active storage", async () => {
    const targetConfig: FilesystemSourceContentConfig = {
      directory: await mkdtemp(join(tmpdir(), "citeloom-cancelled-target-")),
      kind: "filesystem",
    };
    const repository = new SourceContentMigrationRepository(session.database);
    const migration = await repository.queue({
      expectedSettingsVersion: 1,
      requestedByUserId: "00000000-0000-4000-8000-000000000301",
      targetConfig,
    });

    const cancelled = await repository.requestCancellation(migration.id);
    await runSourceContentMigrationWorker(session.database, { once: true });

    expect(cancelled).toMatchObject({
      activeSlot: null,
      state: "cancelled",
    });
    const overview = await repository.readOverview();
    expect(overview.activeConfig).toEqual(sourceContentConfig);
    expect(overview.migration?.state).toBe("cancelled");
  });

  it("allows only one concurrent migration request", async () => {
    const firstTarget: FilesystemSourceContentConfig = {
      directory: await mkdtemp(join(tmpdir(), "citeloom-first-target-")),
      kind: "filesystem",
    };
    const secondTarget: FilesystemSourceContentConfig = {
      directory: await mkdtemp(join(tmpdir(), "citeloom-second-target-")),
      kind: "filesystem",
    };
    const repository = new SourceContentMigrationRepository(session.database);

    const results = await Promise.allSettled([
      repository.queue({
        expectedSettingsVersion: 1,
        requestedByUserId: "00000000-0000-4000-8000-000000000301",
        targetConfig: firstTarget,
      }),
      repository.queue({
        expectedSettingsVersion: 1,
        requestedByUserId: "00000000-0000-4000-8000-000000000302",
        targetConfig: secondTarget,
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled"))
      .toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      reason: expect.any(SourceContentMigrationConflictError),
      status: "rejected",
    });
    const rows = await session.database
      .select({ id: sourceContentMigrations.id })
      .from(sourceContentMigrations);
    expect(rows).toHaveLength(1);
  });

  it("records target validation failure and leaves active storage unchanged", async () => {
    const targetConfig: FilesystemSourceContentConfig = {
      directory: join("/dev/null", `citeloom-${randomUUID()}`),
      kind: "filesystem",
    };
    const repository = new SourceContentMigrationRepository(session.database);
    const migration = await repository.queue({
      expectedSettingsVersion: 1,
      requestedByUserId: "00000000-0000-4000-8000-000000000301",
      targetConfig,
    });

    await runSourceContentMigrationWorker(session.database, { once: true });

    const overview = await repository.readOverview();
    expect(overview.activeConfig).toEqual(sourceContentConfig);
    expect(overview.migration).toMatchObject({
      activeSlot: null,
      id: migration.id,
      state: "failed",
    });
    expect(overview.migration?.errorMessage).not.toBeNull();
  });

  it("settles an owned cutover conflict as failed", async () => {
    const targetConfig: FilesystemSourceContentConfig = {
      directory: await mkdtemp(join(tmpdir(), "citeloom-conflict-target-")),
      kind: "filesystem",
    };
    const changedConfig: FilesystemSourceContentConfig = {
      directory: await mkdtemp(join(tmpdir(), "citeloom-changed-source-")),
      kind: "filesystem",
    };
    const repository = new SourceContentMigrationRepository(session.database);
    const migration = await repository.queue({
      expectedSettingsVersion: 1,
      requestedByUserId: "00000000-0000-4000-8000-000000000301",
      targetConfig,
    });
    const ownerId = randomUUID();
    await repository.claim(ownerId);
    await repository.markValidated(migration.id, ownerId);
    await repository.beginCutover(migration.id, ownerId);
    await repository.releaseLease(migration.id, ownerId);
    const settingsRows = await session.database
      .select({
        defaults: applicationSettings.defaults,
        settings: applicationSettings.settings,
      })
      .from(applicationSettings)
      .where(eq(applicationSettings.id, "runtime"));
    const currentDefaults = parseStoredApplicationSettings(
      settingsRows[0]?.defaults,
    );
    const currentSettings = parseStoredApplicationSettings(
      settingsRows[0]?.settings,
    );
    await session.database
      .update(applicationSettings)
      .set({
        defaults: { ...currentDefaults, sourceContent: changedConfig },
        settings: { ...currentSettings, sourceContent: changedConfig },
        version: 2,
      })
      .where(eq(applicationSettings.id, "runtime"));

    await runSourceContentMigrationWorker(session.database, { once: true });

    const overview = await repository.readOverview();
    expect(overview.activeConfig).toEqual(changedConfig);
    expect(overview.migration).toMatchObject({
      activeSlot: null,
      id: migration.id,
      state: "failed",
    });
    expect(overview.migration?.errorMessage).toContain(
      "active source-content backend changed",
    );
  });

  it.runIf(process.env.CITELOOM_SEAWEEDFS_LIVE_TEST === "true")(
    "cuts over from filesystem storage to a live SeaweedFS backend",
    async () => {
      const content = Buffer.from("live SeaweedFS migration payload");
      const documentId = createHash("sha256").update(content).digest("hex");
      const source = new SourceContentStore(
        session.database,
        sourceContentConfig,
      );
      await source.writeDocument({ content, documentId });
      const targetConfig: S3SourceContentConfig = {
        bucket: process.env.CITELOOM_SOURCE_CONTENT_S3_BUCKET ?? "citeloom",
        credentials: { kind: "environment" },
        endpointUrl: process.env.CITELOOM_SOURCE_CONTENT_S3_ENDPOINT
          ?? "http://127.0.0.1:8333",
        forcePathStyle: true,
        kind: "s3",
        prefix: `live-migration/${randomUUID()}`,
        region: "us-east-1",
      };
      const targetBackend = new S3SourceContentBackend(targetConfig);

      try {
        await expect(migrateSourceContentBackend(
          session.database,
          targetConfig,
        )).resolves.toMatchObject({ copied: 1, verifiedAtCutover: 1 });
        const target = new SourceContentStore(session.database, targetConfig);
        await expect(target.readDocument(documentId)).resolves.toEqual({
          content,
          documentId,
        });
      } finally {
        await targetBackend.remove(documentId);
      }
    },
  );
});

describe("PostgreSQL stored-source reindex", () => {
  it("queues more than two documents whose historical paths are unavailable", async () => {
    const config = buildTestConfig();
    const sourceContentStore = new SourceContentStore(
      session.database,
      config.sourceContent,
    );
    await ensureEmbeddingSpace(session.database, config.embeddingSpace);
    const documents = [
      {
        content: Buffer.from("%PDF-1.7\ninterpretation act"),
        documentId: createHash("sha256")
          .update("%PDF-1.7\ninterpretation act")
          .digest("hex"),
        sourceFile: "/outside-container/legal/interpretation-act.pdf",
        versionId: "00000000-0000-4000-8000-000000000041",
      },
      {
        content: Buffer.from("%PDF-1.7\nprivacy act"),
        documentId: createHash("sha256")
          .update("%PDF-1.7\nprivacy act")
          .digest("hex"),
        sourceFile: "/outside-container/legal/privacy-act.pdf",
        versionId: "00000000-0000-4000-8000-000000000043",
      },
      {
        content: Buffer.from("%PDF-1.7\nevidence act"),
        documentId: createHash("sha256")
          .update("%PDF-1.7\nevidence act")
          .digest("hex"),
        sourceFile: "/outside-container/legal/evidence-act.pdf",
        versionId: "00000000-0000-4000-8000-000000000044",
      },
    ];
    for (const document of documents) {
      await sourceContentStore.writeDocument({
        content: document.content,
        documentId: document.documentId,
      });
      await writeIndexedDocument(
        document.documentId,
        document.sourceFile,
        document.versionId,
      );
    }
    const progress: string[] = [];

    for (const document of documents) {
      await expect(queueDocumentReindex(
        config,
        {
          documentId: document.documentId,
          sourceFile: document.sourceFile,
        },
        (message) => progress.push(message),
      )).resolves.toEqual({
        documentId: document.documentId,
        kind: "queued",
        sourceFile: document.sourceFile,
      });
    }

    const catalog = new DocumentCatalog(session.database);
    for (const document of documents) {
      expect(await catalog.getJob(document.sourceFile)).toMatchObject({
        documentId: document.documentId,
        phase: "discovered",
        sourceFile: document.sourceFile,
        state: "pending",
      });
    }
    expect(progress).toEqual([
      "interpretation-act.pdf was queued for ingestion",
      "privacy-act.pdf was queued for ingestion",
      "evidence-act.pdf was queued for ingestion",
    ]);
  });

  it("rejects reindexing when the persisted source document is missing", async () => {
    const config = buildTestConfig();
    const documentId = "b".repeat(64);
    const sourceFile = "/outside-container/legal/missing.pdf";
    const versionId = "00000000-0000-4000-8000-000000000042";
    await ensureEmbeddingSpace(session.database, config.embeddingSpace);
    await writeIndexedDocument(documentId, sourceFile, versionId);

    await expect(queueDocumentReindex(
      config,
      { documentId, sourceFile },
      () => undefined,
    )).resolves.toEqual({
      error: `Stored source document is missing or invalid: ${documentId}`,
      kind: "rejected",
    });

    const catalog = new DocumentCatalog(session.database);
    expect(await catalog.getJob(sourceFile)).toBeNull();
  });
});

async function writeIndexedDocument(
  documentId: string,
  sourceFile: string,
  versionId: string,
): Promise<void> {
  const generationId = randomUUID();
  const elementSetId = await writeTestElementSet(
    documentId,
    sourceFile,
  );
  await session.database.insert(documentVersions).values({
    ...buildTestDocumentFormatRow(sourceFile),
    documentId,
    elementSetId,
    generationId,
    id: versionId,
    images: 0,
    pageCount: 1,
    sourceFile,
    tables: 0,
    textChunks: 0,
    totalElements: 0,
    version: 1,
  });
  await session.database.insert(indexedDocuments).values({
    documentId,
    elementSetId,
    generationId,
    images: 0,
    pageCount: 1,
    sourceFile,
    tables: 0,
    tags: ["legal"],
    textChunks: 0,
    totalElements: 0,
    versionId,
  });
}

async function writeTestElementSet(
  documentId: string,
  sourceFile: string,
  requestedElementIds: readonly string[] = [],
): Promise<string> {
  await ensureTestSourceMetadata(documentId);
  let elementIds = [...requestedElementIds];
  if (elementIds.length === 0) {
    const elementId = createHash("sha256")
      .update(`test-element:${documentId}:${sourceFile}`)
      .digest("hex");
    elementIds = [elementId];
  }
  const elements: SourceElement[] = [];
  for (const elementId of elementIds) {
    const element = buildTextElement(documentId, elementId);
    elements.push({ ...element, sourceFile });
  }
  const store = new SourceDocumentStore(session.database);
  await store.writeMany(elements);
  const elementSet = await store.writeElementSet(
    documentId,
    elements,
  );
  return elementSet.id;
}

interface TestRetrievalGenerationInput {
  documentId: string;
  elementSetId: string;
  generationId: string;
  sourceFile: string;
  space: EmbeddingSpaceConfig;
  totalElements: number;
}

async function withOpenTestRetrievalGeneration<Result>(
  database: typeof session.database,
  input: TestRetrievalGenerationInput,
  operation: () => Promise<Result>,
): Promise<Result> {
  const format = readDocumentFormat(input.sourceFile);
  await database.insert(ingestionJobs).values({
    documentId: input.documentId,
    elementSetId: input.elementSetId,
    embeddingSpaceId: input.space.id,
    fileExtension: format.extension,
    generationId: input.generationId,
    indexingActivity: "embedding",
    mediaType: format.mediaType,
    phase: "normalized",
    sourceFile: input.sourceFile,
    textChunks: input.totalElements,
    totalElements: input.totalElements,
  });
  await beginEmbeddingGeneration(database, input.space, {
    documentId: input.documentId,
    elementSetId: input.elementSetId,
    generationId: input.generationId,
    totalElements: input.totalElements,
  });
  try {
    return await operation();
  } finally {
    await database
      .delete(ingestionJobs)
      .where(eq(ingestionJobs.generationId, input.generationId));
  }
}

async function writeTestPublicationArtifacts(
  sourceFile: string,
  space: EmbeddingSpaceConfig,
): Promise<void> {
  const catalog = new DocumentCatalog(session.database);
  const job = await catalog.getJob(sourceFile);
  if (
    job === null
    || job.state !== "running"
    || job.phase !== "normalized"
    || job.elementSetId === null
  ) {
    throw new Error(
      `Test publication job is not running in normalized phase: ${sourceFile}.`,
    );
  }
  await ensureEmbeddingSpace(session.database, space);
  const input = {
    documentId: job.documentId,
    elementSetId: job.elementSetId,
    generationId: job.generationId,
    totalElements: job.totalElements,
  };
  const documentStore = new SourceDocumentStore(session.database);
  const batch = await documentStore.readElementBatch(
    job.elementSetId,
    0,
    job.totalElements,
    sourceFile,
  );
  const representations = buildTestRepresentations(batch.elements, [], space);
  const embeddings = representations.map((_, index) => {
    return buildEmbedding(space.dimensions, index + 1);
  });
  await beginEmbeddingGeneration(session.database, space, input);
  await stageRetrievalRepresentationBatch(
    session.database,
    space,
    input,
    0,
    job.totalElements,
    representations,
    embeddings,
  );
  await stageDocumentTocArtifact(session.database, {
    documentId: job.documentId,
    elementSetId: job.elementSetId,
    generationId: job.generationId,
    sourceFile,
  }, {
    entries: [],
    mode: "generated",
    version: 1,
  });
}

describe("PostgreSQL Docling service coordination", () => {
  it("serializes concurrent assignment attempts without overbooking a service", async () => {
    const defaultService = buildTestConfig().doclingServices[0];
    if (defaultService === undefined) {
      throw new Error("Missing default Docling test service.");
    }
    const store = new DoclingServiceStore(session.database);
    await store.synchronize([
      buildAvailableDoclingServiceVerification(defaultService),
    ]);
    const firstOwner = "00000000-0000-4000-8000-000000000161";
    const secondOwner = "00000000-0000-4000-8000-000000000162";
    const firstSourceFile = "/documents/concurrent-docling-a.pdf";
    const secondSourceFile = "/documents/concurrent-docling-b.pdf";
    const owners = [firstOwner, secondOwner];
    const sourceFiles = [firstSourceFile, secondSourceFile];
    for (let index = 0; index < owners.length; index += 1) {
      const ownerId = owners[index];
      const sourceFile = sourceFiles[index];
      if (ownerId === undefined || sourceFile === undefined) {
        throw new Error("Incomplete concurrent assignment fixture.");
      }
      const catalog = new DocumentCatalog(session.database, {
        newLeaseOwnerId: () => ownerId,
      });
      await prepareTestIngestion(catalog,
        sourceFile,
        String(index + 4).repeat(64),
        space768.id,
        [],
        false,
      );
      await claimTestJob(catalog, sourceFile, "discovered");
    }
    const assignments = await Promise.allSettled([
      store.ensureAssignment(firstOwner, firstSourceFile),
      store.ensureAssignment(secondOwner, secondSourceFile),
    ]);
    expect(assignments.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejectedAssignments = assignments.filter((result) => {
      return result.status === "rejected";
    });
    expect(rejectedAssignments).toHaveLength(1);
    const rejectedAssignment = rejectedAssignments[0];
    if (rejectedAssignment?.status !== "rejected") {
      throw new Error("Expected one rejected concurrent assignment.");
    }
    expect(String(rejectedAssignment.reason)).toContain(
      "All verified Docling service slots are occupied",
    );
    const assignedRows = await session.database
      .select({ serviceId: ingestionJobs.doclingServiceInstanceId })
      .from(ingestionJobs)
      .where(isNotNull(ingestionJobs.doclingServiceInstanceId));
    expect(assignedRows).toHaveLength(1);
  });

  it("allocates bounded slots, preserves affinity, drains safely, and releases on completion", async () => {
    const store = new DoclingServiceStore(session.database);
    const serviceIdentity = buildDoclingServiceIdentity();
    const defaultService = buildTestConfig().doclingServices[0];
    if (defaultService === undefined) {
      throw new Error("Missing default Docling test service.");
    }
    const replicaService = {
      baseUrl: "http://127.0.0.1:5002",
      capacity: 1,
      id: "replica-b",
      process: { ...defaultService.process },
    };
    await store.synchronize([
      buildAvailableDoclingServiceVerification(defaultService, serviceIdentity),
      buildAvailableDoclingServiceVerification(replicaService, serviceIdentity),
    ], new Date("2026-07-15T12:00:00.000Z"));

    const firstOwner = "00000000-0000-4000-8000-000000000101";
    const secondOwner = "00000000-0000-4000-8000-000000000102";
    const thirdOwner = "00000000-0000-4000-8000-000000000103";
    const firstCatalog = new DocumentCatalog(session.database, {
      newLeaseOwnerId: () => firstOwner,
    });
    const secondCatalog = new DocumentCatalog(session.database, {
      newLeaseOwnerId: () => secondOwner,
    });
    const thirdCatalog = new DocumentCatalog(session.database, {
      newLeaseOwnerId: () => thirdOwner,
    });
    const firstSourceFile = "/documents/service-slot-a.pdf";
    const secondSourceFile = "/documents/service-slot-b.pdf";
    const thirdSourceFile = "/documents/service-slot-c.pdf";
    const sourceFiles = [firstSourceFile, secondSourceFile, thirdSourceFile];
    const catalogs = [firstCatalog, secondCatalog, thirdCatalog];
    for (let index = 0; index < catalogs.length; index += 1) {
      const catalog = catalogs[index];
      const sourceFile = sourceFiles[index];
      if (catalog === undefined || sourceFile === undefined) {
        throw new Error("Incomplete Docling service allocation fixture.");
      }
      await prepareTestIngestion(catalog,
        sourceFile,
        String(index + 1).repeat(64),
        space768.id,
        [],
        false,
      );
      await claimTestJob(catalog, sourceFile, "discovered");
    }

    const firstAssignment = await store.ensureAssignment(
      firstOwner,
      firstSourceFile,
    );
    const secondAssignment = await store.ensureAssignment(
      secondOwner,
      secondSourceFile,
    );
    expect(firstAssignment).toMatchObject({ id: "default", slot: 1 });
    expect(secondAssignment).toMatchObject({ id: "replica-b", slot: 1 });
    await expect(store.ensureAssignment(
      thirdOwner,
      thirdSourceFile,
    )).rejects.toThrow("All verified Docling service slots are occupied");
    await expect(store.synchronize([
      buildAvailableDoclingServiceVerification(
        { ...replicaService, baseUrl: "http://127.0.0.1:5999" },
        serviceIdentity,
      ),
      buildAvailableDoclingServiceVerification(defaultService, serviceIdentity),
    ])).rejects.toThrow("Cannot change Docling service replica-b base URL");
    await expect(store.synchronize([
      buildAvailableDoclingServiceVerification(defaultService, serviceIdentity),
      buildAvailableDoclingServiceVerification(
        replicaService,
        { ...serviceIdentity, coreVersion: "2.86.0" },
      ),
    ])).resolves.toEqual({
      activeServiceCount: 2,
      unavailableServiceCount: 0,
    });

    await store.synchronize([
      buildAvailableDoclingServiceVerification(defaultService, serviceIdentity),
      buildUnavailableDoclingServiceVerification(
        replicaService,
        "ConnectionError",
      ),
    ], new Date("2026-07-15T12:05:00.000Z"));
    await expect(store.ensureAssignment(
      secondOwner,
      secondSourceFile,
    )).rejects.toThrow(
      "Assigned Docling service replica-b is not currently available and compatible",
    );
    await store.synchronize([
      buildAvailableDoclingServiceVerification(defaultService, serviceIdentity),
    ], new Date("2026-07-15T12:06:00.000Z"));
    await expect(store.ensureAssignment(
      secondOwner,
      secondSourceFile,
    )).rejects.toThrow(
      "Assigned Docling service replica-b is not currently available and compatible",
    );
    const affinityRows = await session.database
      .select({
        serviceId: ingestionJobs.doclingServiceInstanceId,
        slot: ingestionJobs.doclingServiceSlot,
      })
      .from(ingestionJobs)
      .where(eq(ingestionJobs.sourceFile, secondSourceFile));
    expect(affinityRows[0]).toEqual({ serviceId: "replica-b", slot: 1 });

    const firstElementSetId = await writeTestElementSet(
      "1".repeat(64),
      firstSourceFile,
    );
    await firstCatalog.completeNormalization(
      firstSourceFile,
      firstOwner,
      firstElementSetId,
      {
      images: 0,
      pageCount: null,
      tables: 0,
      textChunks: 1,
      totalElements: 1,
      },
    );
    expect(await store.ensureAssignment(
      thirdOwner,
      thirdSourceFile,
    )).toMatchObject({ id: "default", slot: 1, state: "active" });
    expect(await thirdCatalog.markJobFailed(
      thirdSourceFile,
      thirdOwner,
      "conversion failed before task submission",
      buildTestApplicationError(
        thirdSourceFile,
        "conversion failed before task submission",
      ),
    )).toMatchObject({ retryScheduled: true });
    const releasedJobs = await session.database
      .select({
        serviceId: ingestionJobs.doclingServiceInstanceId,
        slot: ingestionJobs.doclingServiceSlot,
      })
      .from(ingestionJobs)
      .where(eq(ingestionJobs.sourceFile, thirdSourceFile));
    expect(releasedJobs[0]).toEqual({ serviceId: null, slot: null });
  });
});

describe("PostgreSQL demand-driven Docling verification", () => {
  it("does not request Docling during initialization or repeated idle claims", async () => {
    const config = buildTestConfig();
    const requester = vi.fn<DoclingJsonRequester>();
    const processor = new IngestionProcessor(
      config,
      session.database,
      () => undefined,
      undefined,
      { doclingRequester: requester },
    );

    await processor.initialize();
    await expect(processor.claimNextJob()).resolves.toEqual({ kind: "idle" });
    await expect(processor.claimNextJob()).resolves.toEqual({ kind: "idle" });

    expect(requester).not.toHaveBeenCalled();
  });

  it("claims normalized work without checking an unavailable Docling service", async () => {
    const config = buildTestConfig();
    const catalog = new DocumentCatalog(session.database);
    const discoveredSourceFile = "/documents/discovered-with-docling-down.pdf";
    await prepareTestIngestion(
      catalog,
      discoveredSourceFile,
      "b".repeat(64),
      config.embeddingSpace.id,
      [],
      false,
    );
    const requester = vi.fn<DoclingJsonRequester>(async () => {
      throw new Error("Docling is unavailable.");
    });
    const processor = new IngestionProcessor(
      config,
      session.database,
      () => undefined,
      undefined,
      { doclingRequester: requester },
    );
    await processor.initialize();
    await expect(processor.claimNextJob()).resolves.toMatchObject({
      kind: "docling-unavailable",
    });

    const sourceFile = "/documents/normalized-with-docling-down.pdf";
    const documentId = "c".repeat(64);
    await prepareTestIngestion(
      catalog,
      sourceFile,
      documentId,
      config.embeddingSpace.id,
      [],
      false,
    );
    await claimTestJob(catalog, sourceFile, "discovered");
    const elementSetId = await writeTestElementSet(documentId, sourceFile);
    const ownerId = await readTestLeaseOwner(catalog, sourceFile);
    await catalog.completeNormalization(
      sourceFile,
      ownerId,
      elementSetId,
      {
        images: 0,
        pageCount: null,
        tables: 0,
        textChunks: 1,
        totalElements: 1,
      },
    );
    await catalog.releaseJob(sourceFile, ownerId);
    const requestCountAfterFailure = requester.mock.calls.length;
    const claim = await processor.claimNextJob(false);

    expect(claim).toMatchObject({
      job: { phase: "normalized", sourceFile },
      kind: "claimed",
      requiresDocling: false,
    });
    expect(requester).toHaveBeenCalledTimes(requestCountAfterFailure);
  });

  it("keeps discovered work pending during outage and claims it after recovery", async () => {
    const config = buildTestConfig();
    const catalog = new DocumentCatalog(session.database);
    const sourceFile = "/documents/docling-recovery.pdf";
    await prepareTestIngestion(
      catalog,
      sourceFile,
      "d".repeat(64),
      config.embeddingSpace.id,
      [],
      false,
    );
    let available = false;
    const requester = vi.fn<DoclingJsonRequester>(async (request) => {
      const path = new URL(request.url).pathname;
      if (!available) {
        throw new Error("connection refused");
      }
      if (path === "/ready") {
        return { status: "ok" };
      }
      if (path === "/version") {
        return buildDoclingVersionResponse();
      }
      if (path === "/openapi.json") {
        return buildDoclingOpenApi();
      }
      throw new Error(`Unexpected Docling request: ${request.url}`);
    });
    const processor = new IngestionProcessor(
      config,
      session.database,
      () => undefined,
      undefined,
      { doclingRequester: requester },
    );
    await processor.initialize();

    await expect(processor.claimNextJob()).resolves.toMatchObject({
      kind: "docling-unavailable",
    });
    expect(await catalog.getJob(sourceFile)).toMatchObject({
      state: "pending",
    });

    available = true;
    await expect(processor.claimNextJob()).resolves.toMatchObject({
      job: { sourceFile, state: "running" },
      kind: "claimed",
      requiresDocling: true,
    });
  });

  it("does not use another service to reclaim work with an unavailable assignment", async () => {
    const config = buildTestConfig();
    const defaultService = config.doclingServices[0];
    if (defaultService === undefined) {
      throw new Error("Missing default Docling test service.");
    }
    const replicaService: DoclingServiceInstanceConfig = {
      baseUrl: "http://127.0.0.1:5002",
      capacity: 1,
      id: "replica-b",
      process: { ...defaultService.process },
    };
    config.doclingServices.push(replicaService);
    const ownerId = "00000000-0000-4000-8000-000000000175";
    const catalog = new DocumentCatalog(session.database, {
      newLeaseOwnerId: () => ownerId,
    });
    const sourceFile = "/documents/assigned-service-down.pdf";
    await prepareTestIngestion(
      catalog,
      sourceFile,
      "e".repeat(64),
      config.embeddingSpace.id,
      [],
      false,
    );
    await claimTestJob(catalog, sourceFile, "discovered");
    const services = new DoclingServiceStore(session.database);
    await services.synchronize([
      buildAvailableDoclingServiceVerification(defaultService),
      buildAvailableDoclingServiceVerification(replicaService),
    ]);
    await expect(services.ensureAssignment(ownerId, sourceFile)).resolves.toMatchObject({
      id: "default",
    });
    await expireTestIngestionLease(sourceFile);
    const requester = vi.fn<DoclingJsonRequester>(async (request) => {
      expect(request.url).toBe(`${defaultService.baseUrl}/ready`);
      throw new Error("default service unavailable");
    });
    const processor = new IngestionProcessor(
      config,
      session.database,
      () => undefined,
      undefined,
      { doclingRequester: requester },
    );
    await processor.initialize();

    await expect(processor.claimNextJob()).resolves.toMatchObject({
      kind: "docling-unavailable",
    });

    expect(requester).toHaveBeenCalledOnce();
    expect(await catalog.getJob(sourceFile)).toMatchObject({
      ownerId,
      state: "running",
    });
  });
});

describe("PostgreSQL Docling observability", () => {
  it("honors metrics toggles, completes idempotently, retains privacy, and expires in bounded batches", async () => {
    const config = buildTestConfig();
    config.docling.performanceMetricsEnabled = true;
    config.settingsVersion = 9;
    const sourceFile = "/documents/docling-metrics.pdf";
    const content = Buffer.from("metrics source bytes");
    const documentId = createHash("sha256").update(content).digest("hex");
    const sourceContentStore = new SourceContentStore(
      session.database,
      config.sourceContent,
    );
    await sourceContentStore.writeDocument({
      content,
      documentId,
    });
    const catalog = new DocumentCatalog(session.database);
    await prepareTestIngestion(catalog,
      sourceFile,
      documentId,
      space768.id,
      [],
      false,
    );
    await claimTestJob(catalog, sourceFile, "discovered");
    const metrics = new DoclingMetricsStore(session.database);
    const warnings: string[] = [];
    const recorder = await metrics.startOrResumeRun({
      attemptConfig: createDoclingAttemptConfigSnapshot(
        config.docling,
        config.settingsVersion,
      ),
      byteLength: content.byteLength,
      documentId,
      fileExtension: ".pdf",
      ingestionAttempt: 1,
      processConfig: {
        numThreads: 4,
        pageBatchSize: 4,
        profilePipelineTimings: false,
      },
      serviceIdentity: buildDoclingServiceIdentity(),
      sourceFile,
      startedAt: new Date("2026-07-15T12:00:00.000Z"),
    }, (warning) => warnings.push(warning));
    if (recorder === null) {
      throw new Error("Expected enabled Docling metrics recorder.");
    }
    const metricsSource = {
      byteLength: content.byteLength,
      documentId,
      extension: ".pdf",
      kind: "file",
      mediaType: "application/pdf",
      openContent: async () => {
        throw new Error("Metrics tests do not open source content.");
      },
      sourceFile,
    } as const;
    const request = await recorder.openRequest({
      kind: "content",
      options: readDoclingEffectiveRequestOptions(
        metricsSource,
        buildDoclingConversionOptions(config.docling, metricsSource),
      ),
      requestKey: "content",
    });
    const submittedAt = new Date("2026-07-15T12:00:01.000Z");
    await request.observe({
      at: submittedAt,
      kind: "submitted",
      task: {
        deadlineAt: "2026-07-15T12:30:01.000Z",
        id: "metrics-task",
        submittedAt: submittedAt.toISOString(),
      },
      uploadMs: 100,
    });
    await request.observe({ at: submittedAt, kind: "first-started" });
    await request.observe({
      at: new Date("2026-07-15T12:00:03.000Z"),
      kind: "transport-succeeded",
      resultRetrievalMs: 50,
      taskWaitMs: 1_900,
      totalMs: 2_000,
    });
    await request.observe({
      at: new Date("2026-07-15T12:00:03.000Z"),
      kind: "conversion-decoded",
      processingMs: 1_500,
      profiling: [{
        count: 2,
        maximumDurationMs: 900,
        medianDurationMs: 750,
        minimumDurationMs: 600,
        p95DurationMs: 900,
        scope: "page",
        stage: "pipeline",
        totalDurationMs: 1_500,
      }],
    });
    config.docling.performanceMetricsEnabled = false;
    const element = buildTextElement(documentId, "8".repeat(64));
    await recorder.completeSuccess({
      elements: [element],
      pageCount: 2,
      totalWallMs: 2_100,
    });
    await recorder.completeSuccess({
      elements: [element],
      pageCount: 2,
      totalWallMs: 2_100,
    });

    const runRows = await session.database.select().from(doclingConversionRuns);
    expect(runRows).toHaveLength(1);
    expect(runRows[0]).toMatchObject({
      documentId,
      outcome: "success",
      pageCount: 2,
      providerProcessingMs: 1_500,
      resultRetrievalMs: 50,
      settingsVersion: 9,
      taskWaitMs: 1_900,
      textCount: 1,
      totalWallMs: 2_100,
      uploadMs: 100,
    });
    expect(await session.database.select().from(doclingConversionRequests)).toHaveLength(1);
    expect(await session.database.select().from(doclingProfilingStages)).toHaveLength(1);
    expect(warnings).toEqual([]);

    const disabled = await metrics.startOrResumeRun({
      attemptConfig: createDoclingAttemptConfigSnapshot(config.docling, 10),
      byteLength: content.byteLength,
      documentId,
      fileExtension: ".pdf",
      ingestionAttempt: 2,
      processConfig: {
        numThreads: 4,
        pageBatchSize: 4,
        profilePipelineTimings: false,
      },
      serviceIdentity: buildDoclingServiceIdentity(),
      sourceFile,
      startedAt: new Date("2026-07-15T12:01:00.000Z"),
    }, (warning) => warnings.push(warning));
    expect(disabled).toBeNull();
    expect(await session.database.select().from(doclingConversionRuns)).toHaveLength(1);
    const errorReporter = new ApplicationErrorReporter(session.database);
    const errorResult = await errorReporter.report(
      new Error("conversion failed while metrics were disabled"),
      {
        attemptNumber: 2,
        category: "docling-conversion",
        code: "conversion_failed",
        documentId,
        jobId: "metrics-disabled-job",
        operation: "convert-document",
        origin: "docling-conversion",
        service: "worker",
        sourceFile,
      },
    );
    expect(errorResult.persisted).toBe(true);
    expect(await session.database
      .select({ id: applicationErrorEvents.id })
      .from(applicationErrorEvents)
      .where(eq(applicationErrorEvents.id, errorResult.event.id)))
      .toEqual([{ id: errorResult.event.id }]);

    await session.database.delete(ingestionJobs).where(
      eq(ingestionJobs.sourceFile, sourceFile),
    );
    await session.database.delete(sourceDocuments).where(
      eq(sourceDocuments.documentId, documentId),
    );
    expect(await session.database.select().from(doclingConversionRuns)).toHaveLength(1);
    await session.database
      .update(doclingConversionRuns)
      .set({ completedAt: new Date("2020-01-01T00:00:00.000Z") });
    expect(await metrics.deleteExpiredRuns(30, 1)).toBe(1);
    expect(await session.database.select().from(doclingConversionRuns)).toHaveLength(0);
  });

  it("resumes benchmark rows, preserves terminal failures, and stores a reproducible assessment", async () => {
    const store = new DoclingBenchmarkStore(session.database);
    const candidate = buildBenchmarkCandidate();
    const environment = buildBenchmarkEnvironment();
    const runId = "00000000-0000-4000-8000-000000000901";
    const startInput = {
      candidates: [candidate],
      corpusDocumentCount: 2,
      environment,
      orderSeed: 20_260_715,
      p95LatencyRegressionLimit: 0.1,
      peakMemoryRegressionLimit: 0.1,
      performanceThreshold: 0.1,
      repetitions: 3,
      runId,
    };
    expect(await store.startOrResumeRun(startInput)).toBe(runId);
    const failed = await store.beginResult(runId, {
      candidateId: candidate.id,
      documentId: "1".repeat(64),
      processConfig: candidate.process,
      repetition: 1,
      requestConfig: candidate.request,
      runOrder: 0,
    });
    await store.failResult(failed.id, new Error("wrapped timeout", {
      cause: new DoclingTaskDeadlineError("hard deadline"),
    }));
    const failedRows = await session.database
      .select({ outcome: doclingBenchmarkResults.outcome })
      .from(doclingBenchmarkResults)
      .where(eq(doclingBenchmarkResults.id, failed.id));
    expect(failedRows[0]?.outcome).toBe("timeout");
    expect((await store.beginResult(runId, {
      candidateId: candidate.id,
      documentId: "1".repeat(64),
      processConfig: candidate.process,
      repetition: 1,
      requestConfig: candidate.request,
      runOrder: 1,
    })).complete).toBe(true);
    const partial = await store.beginResult(runId, {
      candidateId: candidate.id,
      documentId: "2".repeat(64),
      processConfig: candidate.process,
      repetition: 1,
      requestConfig: candidate.request,
      runOrder: 2,
    });
    expect(partial.complete).toBe(false);
    expect(await store.startOrResumeRun(startInput)).toBe(runId);
    expect((await store.beginResult(runId, {
      candidateId: candidate.id,
      documentId: "2".repeat(64),
      processConfig: candidate.process,
      repetition: 1,
      requestConfig: candidate.request,
      runOrder: 3,
    })).id).toBe(partial.id);
    await store.completeResult(partial.id, {
      comparison: { differences: [], passed: true },
      cpuTimeMs: 900,
      httpRequestCount: 2,
      httpRequestDurationMs: 800,
      imageCount: 0,
      outputFingerprint: "a".repeat(64),
      pageCount: 1,
      pagesPerSecond: 1,
      peakResidentBytes: 1_000,
      processingMs: 800,
      profiling: [{
        count: 1,
        maximumDurationMs: 800,
        medianDurationMs: 800,
        minimumDurationMs: 800,
        p95DurationMs: 800,
        scope: "document",
        stage: "structure:pipeline",
        totalDurationMs: 800,
      }],
      resultRetrievalMs: 50,
      schedulerWaitMs: 0,
      tableCount: 0,
      taskWaitMs: 700,
      textCount: 1,
      totalElementCount: 1,
      totalWallMs: 1_000,
      uploadMs: 50,
    });
    const assessment = {
      baselineCandidateId: candidate.id,
      baselineMedianWallMs: 1_000,
      baselineP95WallMs: 1_000,
      candidateMedianWallMs: 800,
      candidateP95WallMs: 900,
      eligible: false,
      evaluatedDocumentCount: 1,
      expectedDocumentCount: 2,
      latencyP95Regression: -0.1,
      memoryRegression: 0,
      performanceImprovement: 0.2,
      promotionCandidateId: candidate.id,
      reasons: ["A terminal result failed."],
    };
    await store.completeRun(runId, assessment);

    expect(await store.listResults(runId)).toHaveLength(2);
    expect(await session.database.select().from(doclingBenchmarkResults)).toHaveLength(2);
    expect(
      await session.database.select().from(doclingBenchmarkProfilingStages),
    ).toHaveLength(1);
    expect((await session.database.select().from(doclingBenchmarkRuns))[0]).toMatchObject({
      assessment,
      status: "completed",
    });
    await expect(store.startOrResumeRun(startInput)).rejects.toThrow(
      "already complete",
    );
  });

  it("closes every incomplete benchmark result when a promotion decision becomes conclusive", async () => {
    const store = new DoclingBenchmarkStore(session.database);
    const candidate = buildBenchmarkCandidate();
    const runId = "00000000-0000-4000-8000-000000000902";
    await store.startOrResumeRun({
      candidates: [candidate],
      corpusDocumentCount: 2,
      environment: buildBenchmarkEnvironment(),
      orderSeed: 20_260_715,
      p95LatencyRegressionLimit: 0.1,
      peakMemoryRegressionLimit: 0.1,
      performanceThreshold: 0.1,
      repetitions: 3,
      runId,
    });
    await store.beginResult(runId, {
      candidateId: candidate.id,
      documentId: "3".repeat(64),
      processConfig: candidate.process,
      repetition: 1,
      requestConfig: candidate.request,
      runOrder: 0,
    });
    await store.beginResult(runId, {
      candidateId: candidate.id,
      documentId: "4".repeat(64),
      processConfig: candidate.process,
      repetition: 1,
      requestConfig: candidate.request,
      runOrder: 1,
    });

    const error = new Error("Promotion decision is conclusive.");
    error.name = "BenchmarkPromotionConcluded";
    expect(await store.failIncompleteResults(runId, error)).toBe(2);
    expect(await store.failIncompleteResults(runId, error)).toBe(0);

    const rows = await session.database
      .select({
        errorCategory: doclingBenchmarkResults.errorCategory,
        outcome: doclingBenchmarkResults.outcome,
        qualityPassed: doclingBenchmarkResults.qualityPassed,
      })
      .from(doclingBenchmarkResults)
      .where(eq(doclingBenchmarkResults.runId, runId));
    expect(rows).toEqual([
      {
        errorCategory: "BenchmarkPromotionConcluded",
        outcome: "error",
        qualityPassed: false,
      },
      {
        errorCategory: "BenchmarkPromotionConcluded",
        outcome: "error",
        qualityPassed: false,
      },
    ]);
  });

  it("repairs the bounded crash window after partition persistence", async () => {
    const config = buildTestConfig();
    config.docling.performanceMetricsEnabled = true;
    const documentId = "7".repeat(64);
    const sourceFile = "/documents/docling-metrics-repair.pdf";
    const catalog = new DocumentCatalog(session.database);
    await prepareTestIngestion(catalog,
      sourceFile,
      documentId,
      space768.id,
      [],
      false,
    );
    await claimTestJob(catalog, sourceFile, "discovered");
    const metrics = new DoclingMetricsStore(session.database);
    const recorder = await metrics.startOrResumeRun({
      attemptConfig: createDoclingAttemptConfigSnapshot(config.docling, 1),
      byteLength: 100,
      documentId,
      fileExtension: ".pdf",
      ingestionAttempt: 1,
      processConfig: {
        numThreads: 4,
        pageBatchSize: 4,
        profilePipelineTimings: false,
      },
      serviceIdentity: buildDoclingServiceIdentity(),
      sourceFile,
      startedAt: new Date("2026-07-15T12:00:00.000Z"),
    }, () => undefined);
    if (recorder === null) {
      throw new Error("Expected crash-repair metrics recorder.");
    }
    const elementSetId = await writeTestElementSet(
      documentId,
      sourceFile,
      Array.from({ length: 7 }, (_, index) => (
        (index + 1).toString(16).repeat(64)
      )),
    );
    await catalog.completeNormalization(
      sourceFile,
      await readTestLeaseOwner(catalog, sourceFile),
      elementSetId,
      {
      images: 2,
      pageCount: 3,
      tables: 1,
      textChunks: 4,
      totalElements: 7,
      },
    );
    expect(await catalog.getJob(sourceFile)).toMatchObject({
      doclingAttemptConfig: expect.any(Object),
      doclingRunId: recorder.runId,
      phase: "normalized",
    });

    expect(await metrics.repairCompletedPartitionRuns(1)).toBe(1);
    expect(await catalog.getJob(sourceFile)).toMatchObject({
      doclingAttemptConfig: null,
      doclingRunId: null,
      phase: "normalized",
    });
    expect((await session.database.select().from(doclingConversionRuns))[0]).toMatchObject({
      imageCount: 2,
      outcome: "success",
      pageCount: 3,
      tableCount: 1,
      textCount: 4,
      totalElementCount: 7,
    });
  });
});

describe("PostgreSQL application state revisions", () => {
  it("publishes one post-commit signal per changed domain in a transaction", async () => {
    const source = await PostgresApplicationStateRevisionSource.open({
      poolMax: 1,
      url: databaseUrl,
    });
    const signals: ApplicationStateRevisionSignal[] = [];
    const received = createDeferred();
    const unsubscribe = source.subscribe((signal) => {
      signals.push(signal);
      received.resolve();
    });
    try {
      await session.database.transaction(async (transaction) => {
        await transaction
          .update(applicationSettings)
          .set({ version: 2 })
          .where(eq(applicationSettings.id, "runtime"));
        await transaction
          .update(applicationSettings)
          .set({ version: 3 })
          .where(eq(applicationSettings.id, "runtime"));
        expect(signals).toEqual([]);
      });
      await received.promise;

      expect(signals).toEqual([{ channel: "settings", revision: "1" }]);
      expect(await readApplicationStateRevisions(session.database)).toEqual({
        catalog: "0",
        jobs: "0",
        settings: "1",
      });
    } finally {
      unsubscribe();
      await source.close();
    }
  });

  it("does not advance or publish a revision for a rolled-back change", async () => {
    const source = await PostgresApplicationStateRevisionSource.open({
      poolMax: 1,
      url: databaseUrl,
    });
    const signals: ApplicationStateRevisionSignal[] = [];
    const unsubscribe = source.subscribe((signal) => {
      signals.push(signal);
    });
    try {
      await expect(session.database.transaction(async (transaction) => {
        await transaction
          .update(applicationSettings)
          .set({ version: 2 })
          .where(eq(applicationSettings.id, "runtime"));
        throw new Error("rollback revision transaction");
      })).rejects.toThrow("rollback revision transaction");
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(signals).toEqual([]);
      expect(
        (await readApplicationStateRevisions(session.database)).settings,
      ).toBe("0");
    } finally {
      unsubscribe();
      await source.close();
    }
  });
});

function buildDatabaseOwnedSettings(): StoredApplicationSettings {
  const providers = createTestProviderSettings({
    answerModel: "test-vision",
    embeddingModel: space768.model,
    inferenceBaseUrl: "http://127.0.0.1:1234/v1",
    indexingModel: "test-description",
  });
  const runtime = createTestRuntimeSettings({
    claimVerifierRuntimeName: "test verifier runtime",
    doclingDefaultServiceCapacity: 1,
    embeddingDimensions: space768.dimensions,
    embeddingInputFormatId: space768.inputFormat.id,
    maxDocumentMegabytes: 1,
    workerFallbackPollMs: 1_000,
  });
  return {
    providers,
    runtime,
    schemaVersion: 1,
    sourceContent: sourceContentConfig,
  };
}

describe("PostgreSQL OpenAI Codex credentials", () => {
  it("serializes refresh across stores and atomically publishes one replacement", async () => {
    const now = new Date("2026-07-27T12:00:00.000Z");
    const requestFetch = vi.fn(async () => Response.json({
      access_token: buildOpenAICodexJwt({
        chatgpt_account_id: "account-123",
        exp: 1_785_155_400,
      }),
      expires_in: 3_600,
      refresh_token: "rotated-refresh",
    }));
    const first = new OpenAICodexCredentialStore(session.database, {
      fetch: requestFetch,
      now: () => now,
    });
    const second = new OpenAICodexCredentialStore(session.database, {
      fetch: requestFetch,
      now: () => now,
    });
    await first.replace({
      accessToken: "expired-access",
      accountId: "account-123",
      expiresAt: new Date("2026-07-27T11:59:00.000Z"),
      refreshToken: "original-refresh",
    });

    const [firstCredential, secondCredential] = await Promise.all([
      first.readForRequest({ forceRefresh: false, staleVersion: null }),
      second.readForRequest({ forceRefresh: false, staleVersion: null }),
    ]);

    expect(requestFetch).toHaveBeenCalledOnce();
    expect(firstCredential).toMatchObject({
      accessToken: buildOpenAICodexJwt({
        chatgpt_account_id: "account-123",
        exp: 1_785_155_400,
      }),
      refreshToken: "rotated-refresh",
      status: "connected",
      version: 2,
    });
    expect(secondCredential).toEqual(firstCredential);
    await expect(first.readConnectionState()).resolves.toMatchObject({
      state: "connected",
      updatedAt: now.toISOString(),
    });
  });

  it("blocks disconnect while an application feature is routed to Codex", async () => {
    const store = new OpenAICodexCredentialStore(session.database);
    await store.replace({
      accessToken: "connected-access",
      accountId: "account-123",
      expiresAt: new Date(Date.now() + 3_600_000),
      refreshToken: "connected-refresh",
    });
    const routed = buildDatabaseOwnedSettings();
    routed.providers.routing.queryExpansion = "openai-codex";
    await session.database
      .update(applicationSettings)
      .set({ settings: routed })
      .where(eq(applicationSettings.id, "runtime"));

    const disconnect = store.disconnect();

    await expect(disconnect).rejects.toBeInstanceOf(
      OpenAICodexProviderInUseError,
    );
    await expect(store.readConnectionState()).resolves.toMatchObject({
      state: "connected",
    });
  });

  it("commits reauthentication-required state before returning refresh failure", async () => {
    const store = new OpenAICodexCredentialStore(session.database, {
      fetch: async () => Response.json(
        {
          error: "invalid_grant",
          error_description: "The refresh token is no longer valid.",
        },
        { status: 400 },
      ),
      now: () => new Date("2026-07-27T12:00:00.000Z"),
    });
    await store.replace({
      accessToken: "expired-access",
      accountId: "account-123",
      expiresAt: new Date("2026-07-27T11:59:00.000Z"),
      refreshToken: "rejected-refresh",
    });

    await expect(store.readForRequest({
      forceRefresh: false,
      staleVersion: null,
    })).rejects.toThrow("Sign in again");
    await expect(store.readConnectionState()).resolves.toMatchObject({
      state: "reauth-required",
      updatedAt: "2026-07-27T12:00:00.000Z",
    });
  });
});

function buildOpenAICodexJwt(claims: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" }))
    .toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${payload}.signature`;
}

describe("PostgreSQL research records", () => {
  it("persists finding verification claims by statement index", async () => {
    const config = buildTestConfig();
    const research = new ResearchStore(session.database, config);
    const sourceFile = "/documents/selected-verification-claims.pdf";
    const documentId = "9".repeat(64);
    const directElementId = "8".repeat(64);
    const findingElementId = "7".repeat(64);
    const findingCitationId = "00000000-0000-4000-8000-000000000122";
    const versionId = "00000000-0000-4000-8000-000000000123";
    await session.database
      .insert(embeddingSpaces)
      .values(buildEmbeddingSpaceRow(space768));
    const elementSetId = await writeTestElementSet(
      documentId,
      sourceFile,
      [directElementId, findingElementId],
    );
    const generationId = randomUUID();
    await session.database.insert(documentVersions).values({
      ...buildTestDocumentFormatRow(sourceFile),
      documentId,
      elementSetId,
      generationId,
      id: versionId,
      images: 0,
      pageCount: 1,
      sourceFile,
      tables: 0,
      textChunks: 2,
      totalElements: 2,
      version: 1,
    });
    await session.database.insert(indexedDocuments).values({
      documentId,
      elementSetId,
      generationId,
      images: 0,
      pageCount: 1,
      sourceFile,
      tables: 0,
      tags: [],
      textChunks: 2,
      totalElements: 2,
      versionId,
    });
    const thread = await research.createThread("Selected verification claims");
    const sourceLocation = buildSourceLocation(1);
    const citationEvidence = {
      excerpt: `content for ${documentId}`,
      kind: "text" as const,
    };
    const turn = await research.saveTurn({
      answerDocument: {
        citations: [{
          citationNumber: 1,
          documentId,
          documentVersionId: versionId,
          elementId: findingElementId,
          evidence: citationEvidence,
          id: findingCitationId,
          kind: "text",
          pageNumbers: [1],
          regions: sourceLocation.regions,
          sectionPath: sourceLocation.sectionPath,
          sourceFile,
        }],
        content: "The report contains diagnostic and treatment guidance.",
        schemaVersion: 2,
        statements: [{
          citationIds: [findingCitationId],
          content: "The report recommends a specific diagnostic test.",
          presentation: "bullet",
          section: "key-points",
        }],
      },
      claims: [{
        citationNumbers: [1],
        claim: "The report recommends a specific diagnostic test.",
        claimIndex: 0,
        evidenceUnits: [{
          citationNumber: 1,
          outcome: "not-evaluated",
          rationale: "Automated evidence verification is pending.",
          supportProbability: null,
          unitId: "claim-0-citation-1",
        }],
        rationale: "Automated evidence verification is pending.",
        status: "unverified",
        verifierModel: config.claimVerifier.model,
      }],
      completedAt: new Date("2026-08-07T01:51:50.000Z"),
      question: "What does the report recommend?",
      retrievedContext: [{
        documentId,
        retrievedElementCount: 2,
        sourceFile,
      }],
      retrievalTrace: buildTestRetrievalTrace(
        "What does the report recommend?",
      ),
      runConfiguration: buildResearchRunConfiguration(config),
      runId: "00000000-0000-4000-8000-000000000124",
      scope: { kind: "sourceFiles", sourceFiles: [sourceFile] },
      threadId: thread.id,
    });

    expect(turn.claims).toEqual([
      expect.objectContaining({
        claimIndex: 0,
        claim: "The report recommends a specific diagnostic test.",
      }),
    ]);
    expect(turn.verificationState).toBe("pending");
    const reopened = await research.readThread(thread.id);
    expect(reopened?.turns[0]?.answerDocument).toEqual(turn.answerDocument);
    expect(reopened?.turns[0]?.claims).toEqual(turn.claims);
    expect(reopened?.turns[0]?.verificationState).toBe("pending");
    expect(await session.database.select().from(researchStatements))
      .toHaveLength(1);
    expect(await session.database.select().from(researchStatementCitations))
      .toHaveLength(1);
    expect(await session.database.select().from(researchClaimChecks))
      .toHaveLength(1);
    expect(await session.database.select().from(researchClaimEvidenceUnits))
      .toHaveLength(1);
    const firstClaim = await research.claimNextVerificationJob(
      new Date(),
    );
    expect(firstClaim).toMatchObject({
      attemptCount: 1,
      claims: [{
        citationNumbers: [1],
        claim: "The report recommends a specific diagnostic test.",
        claimIndex: 0,
      }],
      id: turn.id,
      sources: [{ citationNumber: 1 }],
    });
    await expect(research.completeVerificationJob(
      turn.id,
      1,
      [{
        citationNumbers: [1],
        claim: "The report recommends a specific diagnostic test.",
        claimIndex: 0,
        evidenceUnits: [{
          citationNumber: 1,
          outcome: "supported",
          rationale: "The finding evidence directly supports the statement.",
          supportProbability: 0.98,
          unitId: "claim-0-citation-1",
        }],
        rationale: "The finding evidence directly supports the statement.",
        status: "supported",
        verifierModel: config.claimVerifier.model,
      }],
      new Date("2026-08-07T01:51:53.000Z"),
    )).resolves.toBe(true);
    expect((await research.readThread(thread.id))?.turns[0]).toMatchObject({
      claims: [{ status: "supported" }],
      verificationState: "completed",
    });
  });

  it("persists immutable evidence, versions, feedback, and reviewed development cases", async () => {
    const config = buildTestConfig();
    const workspaceRows = await session.database
      .select({
        libraryId: sourceLibraries.id,
        workspaceId: workspaces.id,
      })
      .from(sourceLibraries)
      .innerJoin(workspaces, eq(workspaces.id, sourceLibraries.ownerWorkspaceId))
      .where(and(
        eq(sourceLibraries.kind, "private"),
        eq(sourceLibraries.state, "active"),
        eq(workspaces.state, "active"),
      ))
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
      .limit(1);
    const workspace = workspaceRows[0];
    if (workspace === undefined) {
      throw new Error("Expected a workspace source library for research.");
    }
    const research = new ResearchStore(
      session.database,
      config,
      workspace.workspaceId,
    );
    const sourceStore = new SourceDocumentStore(session.database);
    const sourceContentStore = new SourceContentStore(
      session.database,
      config.sourceContent,
    );
    await expect(research.createThread("   ")).rejects.toThrow(
      "Invalid research thread title",
    );
    const sourceFile = "/documents/research.html";
    const oldContent = Buffer.from("Revenue increased by 12 percent.");
    const newContent = Buffer.from("Revenue increased by 18 percent.");
    const oldDocumentId = createHash("sha256").update(oldContent).digest("hex");
    const newDocumentId = createHash("sha256").update(newContent).digest("hex");
    const oldElementId = "b".repeat(64);
    const newElementId = "c".repeat(64);
    const oldVersionId = "00000000-0000-4000-8000-000000000101";
    const newVersionId = "00000000-0000-4000-8000-000000000102";
    const oldElement: SourceElement = {
      content: "Revenue increased by 12 percent.",
      documentId: oldDocumentId,
      id: oldElementId,
      detectedTypes: ["paragraph"],
      kind: "text",
      ...buildSourceLocation(1),
      sourceFile,
    };
    const newElement: SourceElement = {
      content: "Revenue increased by 18 percent.",
      documentId: newDocumentId,
      id: newElementId,
      detectedTypes: ["paragraph"],
      kind: "text",
      ...buildSourceLocation(1),
      sourceFile,
    };
    await session.database
      .insert(embeddingSpaces)
      .values(buildEmbeddingSpaceRow(space768));
    await sourceContentStore.writeDocument({
      content: oldContent,
      documentId: oldDocumentId,
    });
    await sourceStore.writeMany([oldElement]);
    const oldElementSet = await sourceStore.writeElementSet(
      oldDocumentId,
      [oldElement],
    );
    const oldGenerationId = randomUUID();
    await session.database.insert(documentVersions).values({
      ...buildTestDocumentFormatRow(sourceFile),
      documentId: oldDocumentId,
      elementSetId: oldElementSet.id,
      generationId: oldGenerationId,
      id: oldVersionId,
      images: 0,
      pageCount: 1,
      sourceFile,
      tables: 0,
      textChunks: 1,
      totalElements: 1,
      version: 1,
    });
    await session.database.insert(indexedDocuments).values({
      documentId: oldDocumentId,
      elementSetId: oldElementSet.id,
      generationId: oldGenerationId,
      images: 0,
      pageCount: 1,
      sourceFile,
      sourceLibraryId: workspace.libraryId,
      tables: 0,
      tags: ["finance"],
      textChunks: 1,
      totalElements: 1,
      versionId: oldVersionId,
    });
    const storedVersions = await research.listDocumentVersions(sourceFile);
    expect(storedVersions).toHaveLength(1);
    expect(storedVersions[0]).toMatchObject({
      documentId: oldDocumentId,
      elementCount: 1,
      elementSetId: oldElementSet.id,
      generationId: oldGenerationId,
      id: oldVersionId,
      pageCount: 1,
      sourceFile,
      version: 1,
    });
    expect(storedVersions[0]).not.toHaveProperty("elementIds");

    const thread = await research.createThread("Quarterly comparison");
    const citationId = "00000000-0000-4000-8000-000000000103";
    const turn = await research.saveTurn({
      answerDocument: {
        citations: [{
          citationNumber: 1,
          documentId: oldDocumentId,
          documentVersionId: oldVersionId,
          elementId: oldElementId,
          evidence: { excerpt: oldElement.content, kind: "text" },
          id: citationId,
          kind: "text",
          pageNumbers: [1],
          regions: oldElement.regions,
          sectionPath: oldElement.sectionPath,
          sourceFile,
        }],
        content: "Revenue increased according to the source.",
        schemaVersion: 2,
        statements: [{
          citationIds: [citationId],
          content: "The source reports a 12 percent revenue increase.",
          presentation: "paragraph",
          section: "answer",
        }],
      },
      claims: [{
        citationNumbers: [1],
        claim: "The source reports a 12 percent revenue increase.",
        claimIndex: 0,
        evidenceUnits: [{
          citationNumber: 1,
          outcome: "supported",
          rationale: "The exact excerpt directly supports the summary.",
          supportProbability: 0.98,
          unitId: "claim-0-citation-1",
        }],
        rationale: "The exact excerpt directly supports the summary.",
        status: "supported",
        verifierModel: config.claimVerifier.model,
      }],
      completedAt: new Date("2026-07-15T15:00:00.000Z"),
      question: "How much did revenue increase?",
      retrievedContext: [{
        documentId: oldDocumentId,
        retrievedElementCount: 1,
        sourceFile,
      }],
      retrievalTrace: buildTestRetrievalTrace("What changed?"),
      runConfiguration: buildResearchRunConfiguration(config),
      runId: "00000000-0000-4000-8000-000000000104",
      scope: { kind: "sourceFiles", sourceFiles: [sourceFile] },
      threadId: thread.id,
    });

    expect(turn.sequence).toBe(1);
    expect(turn.citations[0]).toMatchObject({
      documentVersionId: oldVersionId,
      elementId: oldElementId,
      id: citationId,
      stale: false,
    });
    expect(turn.retrievedContext).toEqual([{
      documentId: oldDocumentId,
      retrievedElementCount: 1,
      sourceFile,
    }]);
    expect(JSON.stringify(turn.runConfiguration)).not.toContain("apiToken");
    expect(turn.runConfiguration.models.verifier).toBe(
      config.claimVerifier.model,
    );
    expect(turn.retrievalTrace?.version).toBe(3);
    expect(turn.claims.map((claim) => claim.claimIndex)).toEqual([0]);
    expect((await research.readCitation(citationId))?.element).toEqual(oldElement);

    await sourceContentStore.writeDocument({
      content: newContent,
      documentId: newDocumentId,
    });
    await sourceStore.writeMany([newElement]);
    const newElementSet = await sourceStore.writeElementSet(
      newDocumentId,
      [newElement],
    );
    const newGenerationId = randomUUID();
    await session.database.insert(documentVersions).values({
      ...buildTestDocumentFormatRow(sourceFile),
      documentId: newDocumentId,
      elementSetId: newElementSet.id,
      generationId: newGenerationId,
      id: newVersionId,
      images: 0,
      pageCount: 1,
      sourceFile,
      tables: 0,
      textChunks: 1,
      totalElements: 1,
      version: 2,
    });
    await session.database
      .update(indexedDocuments)
      .set({
        documentId: newDocumentId,
        elementSetId: newElementSet.id,
        generationId: newGenerationId,
        versionId: newVersionId,
      })
      .where(eq(indexedDocuments.sourceFile, sourceFile));
    const reopened = await research.readThread(thread.id);
    expect(reopened?.turns[0]?.answerDocument).toEqual(turn.answerDocument);
    expect(reopened?.turns[0]?.claims).toEqual(turn.claims);
    expect(reopened?.turns[0]?.citations[0]?.stale).toBe(true);
    expect(reopened?.turns[0]?.reproducibility.available).toBe(true);
    expect(reopened?.turns[0]?.retrievalTrace?.version).toBe(3);
    const difference = await research.compareDocumentVersions(
      oldVersionId,
      newVersionId,
    );
    expect(difference).toEqual({
      addedElementIds: [],
      currentVersionId: newVersionId,
      modified: [{
        currentElementId: newElementId,
        previousElementId: oldElementId,
      }],
      previousVersionId: oldVersionId,
      removedElementIds: [],
    });
    const inaccessibleResearch = new ResearchStore(
      session.database,
      config,
      randomUUID(),
    );
    await expect(inaccessibleResearch.compareDocumentVersions(
      oldVersionId,
      newVersionId,
    )).resolves.toBeNull();

    const markdown = await research.exportThread(thread.id, "markdown");
    expect(markdown?.content).toContain(oldVersionId);
    expect(markdown?.content).toContain(oldElement.content);
    expect(markdown?.content).toContain("Stale: yes");

    const feedbackUserId = "00000000-0000-4000-8000-000000000199";
    await session.database.insert(users).values({
      displayName: "Feedback User",
      id: feedbackUserId,
      state: "active",
      username: "feedback-user",
      usernameNormalized: "feedback-user",
    }).onConflictDoNothing();
    await research.addFeedback({
      citationId,
      comment: null,
      dimension: "citation-correctness",
      rating: 1,
      turnId: turn.id,
    }, feedbackUserId);
    await research.addFeedback({
      citationId: null,
      comment: "The retrieval included the exact supporting evidence.",
      dimension: "retrieval-relevance",
      rating: 1,
      turnId: turn.id,
    }, feedbackUserId);
    await research.addFeedback({
      citationId: null,
      comment: null,
      dimension: "answer-usefulness",
      rating: 1,
      turnId: turn.id,
    }, feedbackUserId);
    expect(await session.database.select().from(researchFeedback)).toHaveLength(3);
    const changedSummary = await research.addFeedback({
      citationId: null,
      comment: null,
      dimension: "answer-usefulness",
      rating: -1,
      turnId: turn.id,
    }, feedbackUserId);
    expect(changedSummary).toEqual({
      negativeCount: 1,
      positiveCount: 0,
      rating: -1,
    });
    expect(await session.database.select().from(researchFeedback)).toHaveLength(3);

    const secondFeedbackUserId = "00000000-0000-4000-8000-000000000198";
    await session.database.insert(users).values({
      displayName: "Second Feedback User",
      id: secondFeedbackUserId,
      state: "active",
      username: "second-feedback-user",
      usernameNormalized: "second-feedback-user",
    }).onConflictDoNothing();
    const aggregate = await research.addFeedback({
      citationId: null,
      comment: null,
      dimension: "answer-usefulness",
      rating: 1,
      turnId: turn.id,
    }, secondFeedbackUserId);
    expect(aggregate).toEqual({
      negativeCount: 1,
      positiveCount: 1,
      rating: 1,
    });
    expect(await research.readFeedbackSummary(
      turn.id,
      "answer-usefulness",
      null,
      feedbackUserId,
    )).toEqual({
      negativeCount: 1,
      positiveCount: 1,
      rating: -1,
    });

  });

  it("rolls back a turn when a citation does not belong to its version", async () => {
    const config = buildTestConfig();
    const research = new ResearchStore(session.database, config);
    const thread = await research.createThread("Invalid evidence test");
    await session.database
      .insert(embeddingSpaces)
      .values(buildEmbeddingSpaceRow(space768));
    const elementSetId = await writeTestElementSet(
      "a".repeat(64),
      "/documents/invalid.txt",
      ["b".repeat(64)],
    );
    await session.database.insert(documentVersions).values({
      ...buildTestDocumentFormatRow("/documents/invalid.txt"),
      documentId: "a".repeat(64),
      elementSetId,
      generationId: randomUUID(),
      id: "00000000-0000-4000-8000-000000000111",
      images: 0,
      pageCount: 1,
      sourceFile: "/documents/invalid.txt",
      tables: 0,
      textChunks: 1,
      totalElements: 1,
      version: 1,
    });
    await expect(research.saveTurn({
      answerDocument: {
        citations: [{
          citationNumber: 1,
          documentId: "a".repeat(64),
          documentVersionId: "00000000-0000-4000-8000-000000000111",
          elementId: "c".repeat(64),
          evidence: { excerpt: "Invalid.", kind: "text" },
          id: "00000000-0000-4000-8000-000000000112",
          kind: "text",
          pageNumbers: [1],
          regions: buildSourceLocation(1).regions,
          sectionPath: ["Test section"],
          sourceFile: "/documents/invalid.txt",
        }],
        content: "The requested evidence is invalid.",
        schemaVersion: 2,
        statements: [{
          citationIds: ["00000000-0000-4000-8000-000000000112"],
          content: "Invalid.",
          presentation: "paragraph",
          section: "answer",
        }],
      },
      claims: [{
        citationNumbers: [1],
        claim: "Invalid.",
        claimIndex: 0,
        evidenceUnits: [{
          citationNumber: 1,
          outcome: "supported",
          rationale: "The invalid fixture should fail citation ownership first.",
          supportProbability: 0.99,
          unitId: "claim-0-citation-1",
        }],
        rationale: "The invalid fixture should fail citation ownership first.",
        status: "supported",
        verifierModel: config.claimVerifier.model,
      }],
      completedAt: new Date(),
      question: "Invalid?",
      retrievedContext: [],
      retrievalTrace: buildTestRetrievalTrace("Invalid evidence"),
      runConfiguration: buildResearchRunConfiguration(config),
      runId: "00000000-0000-4000-8000-000000000113",
      scope: { kind: "all" },
      threadId: thread.id,
    })).rejects.toThrow("does not belong to document version");
    expect(await session.database.select().from(researchTurns)).toHaveLength(0);

    const directTurnId = "00000000-0000-4000-8000-000000000119";
    await expect(session.database.transaction(async (transaction) => {
      await transaction.insert(researchTurns).values({
        answerContent: "This answer has incomplete cited output.",
        answerSchemaVersion: 2,
        completedAt: new Date("2026-07-25T15:10:00.000Z"),
        id: directTurnId,
        outputState: "building",
        question: "Can an invalid anchor bypass the store?",
        retrievedContext: [],
        retrievalTrace: buildTestRetrievalTrace("Invalid direct anchor"),
        runConfiguration: buildResearchRunConfiguration(config),
        runId: "00000000-0000-4000-8000-000000000120",
        scope: { kind: "all" },
        sequence: 1,
        threadId: thread.id,
      });
      await transaction.insert(citationRecords).values({
        citationNumber: 1,
        documentVersionId: "00000000-0000-4000-8000-000000000111",
        elementId: "c".repeat(64),
        elementSetId,
        evidence: { excerpt: "Invalid.", kind: "text" },
        id: "00000000-0000-4000-8000-000000000121",
        pageNumbers: [1],
        regions: buildSourceLocation(1).regions,
        sectionPath: ["Test section"],
        sourceFile: "/documents/invalid.txt",
        turnId: directTurnId,
      });
    })).rejects.toMatchObject({
      cause: expect.objectContaining({
        constraint: "citation_records_element_set_member_fk",
      }),
    });
    expect(await session.database.select().from(researchTurns)).toHaveLength(0);
  });

  it("publishes uncited turns atomically and keeps published output immutable", async () => {
    const config = buildTestConfig();
    const research = new ResearchStore(session.database, config);
    const uncitedAnswerContent = (
      "The supplied source material does not identify what is unavailable."
    );
    await session.database
      .insert(embeddingSpaces)
      .values(buildEmbeddingSpaceRow(space768));
    const thread = await research.createThread("Uncited answer persistence");
    const turn = await research.saveTurn({
      answerDocument: {
        citations: [],
        content: uncitedAnswerContent,
        schemaVersion: 2,
        statements: [],
      },
      claims: [],
      completedAt: new Date("2026-07-25T15:00:00.000Z"),
      question: "What is unavailable?",
      retrievedContext: [],
      retrievalTrace: buildTestRetrievalTrace("What is unavailable?"),
      runConfiguration: buildResearchRunConfiguration(config),
      runId: "00000000-0000-4000-8000-000000000114",
      scope: { kind: "all" },
      threadId: thread.id,
    });

    expect(turn.answerDocument).not.toHaveProperty("status");
    expect(turn.answerDocument).toMatchObject({
      citations: [],
      content: uncitedAnswerContent,
      statements: [],
    });
    expect(turn.citations).toEqual([]);
    expect(turn.claims).toEqual([]);
    expect(await research.readThread(thread.id)).toMatchObject({
      turns: [{
        answerDocument: {
          citations: [],
          content: uncitedAnswerContent,
          schemaVersion: 2,
          statements: [],
        },
      }],
    });
    const storedTurn = (await session.database.select().from(researchTurns))[0];
    expect(storedTurn).toMatchObject({
      answerContent: uncitedAnswerContent,
      outputState: "published",
    });
    expect(storedTurn?.retrievalTrace).toMatchObject({
      version: 3,
    });

    await expect(session.database
      .update(researchTurns)
      .set({ question: "Mutated question" })
      .where(eq(researchTurns.id, turn.id))).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining(
          "Published research turns are immutable",
        ),
      }),
    });
    await expect(session.database.insert(researchStatements).values({
      content: "This statement must not be added.",
      id: "00000000-0000-4000-8000-000000000115",
      presentation: "paragraph",
      section: "answer",
      statementIndex: 0,
      turnId: turn.id,
    })).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining(
          "Published research output is immutable",
        ),
      }),
    });

    await research.deleteThread(thread.id);
    expect(await session.database.select().from(researchTurns)).toEqual([]);
    expect(await session.database.select().from(researchStatements)).toEqual([]);
    expect(await session.database.select().from(citationRecords)).toEqual([]);
  });

  it("rolls back unpublished and incomplete research output", async () => {
    const config = buildTestConfig();
    const thread = await new ResearchStore(
      session.database,
      config,
    ).createThread("Incomplete output");
    const unpublishedTurnId = "00000000-0000-4000-8000-000000000122";
    await expect(session.database.transaction(async (transaction) => {
      await transaction.insert(researchTurns).values({
        answerContent: "Can a building turn be committed?",
        answerSchemaVersion: 2,
        completedAt: new Date("2026-07-25T15:04:00.000Z"),
        id: unpublishedTurnId,
        outputState: "building",
        question: "Can a building turn be committed?",
        retrievedContext: [],
        retrievalTrace: buildTestRetrievalTrace("Unpublished output"),
        runConfiguration: buildResearchRunConfiguration(config),
        runId: "00000000-0000-4000-8000-000000000123",
        scope: { kind: "all" },
        sequence: 1,
        threadId: thread.id,
      });
    })).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("was not published before commit"),
      }),
    });
    expect(
      await session.database
        .select()
        .from(researchTurns)
        .where(eq(researchTurns.id, unpublishedTurnId)),
    ).toEqual([]);

    const turnId = "00000000-0000-4000-8000-000000000116";

    await expect(session.database.transaction(async (transaction) => {
      await transaction.insert(researchTurns).values({
        answerContent: "This answer has incomplete cited output.",
        answerSchemaVersion: 2,
        completedAt: new Date("2026-07-25T15:05:00.000Z"),
        id: turnId,
        outputState: "building",
        question: "Can incomplete output be published?",
        retrievedContext: [],
        retrievalTrace: buildTestRetrievalTrace("Incomplete output"),
        runConfiguration: buildResearchRunConfiguration(config),
        runId: "00000000-0000-4000-8000-000000000117",
        scope: { kind: "all" },
        sequence: 1,
        threadId: thread.id,
      });
      await transaction.insert(researchStatements).values({
        content: "This statement has no citation.",
        id: "00000000-0000-4000-8000-000000000118",
        presentation: "paragraph",
        section: "answer",
        statementIndex: 0,
        turnId,
      });
      await transaction
        .update(researchTurns)
        .set({ outputState: "published" })
        .where(eq(researchTurns.id, turnId));
    })).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: expect.stringContaining("incomplete published output"),
      }),
    });

    expect(
      await session.database
        .select()
        .from(researchTurns)
        .where(eq(researchTurns.id, turnId)),
    ).toEqual([]);
    expect(await session.database.select().from(researchStatements)).toEqual([]);
  });
});

describe("PostgreSQL embedding-space retention", () => {
  it("reports every protection and atomically collects only eligible spaces", async () => {
    const currentTime = new Date("2026-07-15T12:00:00.000Z");
    const oldCreatedAt = new Date("2026-01-01T00:00:00.000Z");
    const activeId = "active:plain:384";
    const pinnedId = "pinned:plain:384";
    const jobId = "job:plain:384";
    const recentId = "recent:plain:384";
    const deletableId = "deletable:plain:384";
    await session.database.insert(embeddingSpaces).values([
      buildRetentionSpace(activeId, oldCreatedAt),
      buildRetentionSpace(pinnedId, oldCreatedAt),
      buildRetentionSpace(jobId, oldCreatedAt),
      buildRetentionSpace(recentId, new Date("2026-07-14T00:00:00.000Z")),
      buildRetentionSpace(deletableId, oldCreatedAt),
    ]);
    await pinEmbeddingSpace(session.database, pinnedId, "known-good rollback");
    const catalog = new DocumentCatalog(session.database);
    await prepareTestIngestion(catalog,
      "/documents/in-flight.pdf",
      "9".repeat(64),
      jobId,
      [],
      false,
    );
    await insertRetentionRows(deletableId);
    const deletableSpace: EmbeddingSpaceConfig = {
      ...space384,
      id: deletableId,
      model: "retention-test-model",
    };
    await ensureActiveRetrievalSpacePartitions(
      session.database,
      deletableSpace,
    );
    const activePartitionNames = [
      "active_retrieval_evidence",
      "active_retrieval_lexical_chunks",
      "active_retrieval_routes",
      readActiveRetrievalVectorTableName(deletableSpace.dimensions),
    ].map((tableName) => createActiveRetrievalPartitionName(
      tableName,
      deletableId,
    ));
    expect(await readExistingTableNames(activePartitionNames))
      .toEqual([...activePartitionNames].sort());

    const dryRun = await runEmbeddingSpaceGarbageCollection(
      session.database,
      { activeSpaceId: activeId, mode: "dry-run", retentionDays: 30 },
      currentTime,
    );
    const dryRunSpaces = new Map(
      dryRun.spaces.map((space) => [space.spaceId, space]),
    );
    expect(dryRun.status).toBe("completed");
    expect(dryRunSpaces.get(activeId)?.protectionKind).toBe("active");
    expect(dryRunSpaces.get(pinnedId)?.protectionKind).toBe("pinned");
    expect(dryRunSpaces.get(jobId)?.protectionKind).toBe("job-reference");
    expect(dryRunSpaces.get(recentId)?.protectionKind).toBe("retention-window");
    expect(dryRunSpaces.get(deletableId)).toMatchObject({
      disposition: "deletable",
      estimatedBytes: expect.stringMatching(/^[1-9][0-9]*$/),
      protectionKind: null,
      rowCounts: {
        indexedDocuments: 1,
        lexicalChunks: 1,
        vectorChunks1024: 0,
        vectorChunks1536: 0,
        vectorChunks2048: 0,
        vectorChunks384: 1,
        vectorChunks768: 0,
      },
      state: "planned",
    });

    const applied = await runEmbeddingSpaceGarbageCollection(
      session.database,
      { activeSpaceId: activeId, mode: "apply", retentionDays: 30 },
      currentTime,
    );
    expect(applied.status).toBe("completed");
    expect(applied.spaces.find((space) => space.spaceId === deletableId)?.state)
      .toBe("deleted");
    const remainingSpaces = await session.database
      .select({ id: embeddingSpaces.id })
      .from(embeddingSpaces);
    expect(remainingSpaces.map((space) => space.id).sort()).toEqual([
      activeId,
      jobId,
      pinnedId,
      recentId,
    ].sort());
    expect(await readRetentionRowCounts(deletableId)).toEqual({
      documentSpaces: 0,
      lexical: 0,
      vectors: 0,
    });
    expect(await readExistingTableNames(activePartitionNames)).toEqual([]);

    const resumedCompletedRun = await runEmbeddingSpaceGarbageCollection(
      session.database,
      { activeSpaceId: activeId, mode: "resume", runId: applied.id },
      currentTime,
    );
    expect(resumedCompletedRun).toEqual(applied);
  });

  it("rolls back partial deletion and resumes the audited run", async () => {
    const currentTime = new Date("2026-07-15T12:00:00.000Z");
    const activeId = "active-resume:plain:384";
    const candidateId = "interrupted:plain:384";
    await session.database.insert(embeddingSpaces).values([
      buildRetentionSpace(activeId, new Date("2026-01-01T00:00:00.000Z")),
      buildRetentionSpace(candidateId, new Date("2026-01-01T00:00:00.000Z")),
    ]);
    await insertRetentionRows(candidateId);
    await session.database.execute(sql`
      CREATE FUNCTION test_reject_embedding_space_delete() RETURNS trigger AS $$
      BEGIN
        IF OLD.id = 'interrupted:plain:384' THEN
          RAISE EXCEPTION 'simulated interrupted cleanup';
        END IF;
        RETURN OLD;
      END;
      $$ LANGUAGE plpgsql
    `);
    await session.database.execute(sql`
      CREATE TRIGGER test_reject_embedding_space_delete
      BEFORE DELETE ON embedding_spaces
      FOR EACH ROW EXECUTE FUNCTION test_reject_embedding_space_delete()
    `);
    try {
      await expect(runEmbeddingSpaceGarbageCollection(
        session.database,
        { activeSpaceId: activeId, mode: "apply", retentionDays: 30 },
        currentTime,
      )).rejects.toThrow("delete from \"embedding_spaces\"");
      expect(await readRetentionRowCounts(candidateId)).toEqual({
        documentSpaces: 1,
        lexical: 1,
        vectors: 1,
      });
      const runRows = await session.database
        .select({ id: embeddingSpaceGcRuns.id })
        .from(embeddingSpaceGcRuns)
        .orderBy(desc(embeddingSpaceGcRuns.startedAt))
        .limit(1);
      const runId = runRows[0]?.id;
      if (runId === undefined) {
        throw new Error("Failed GC run was not audited.");
      }
      const failedReport = await readEmbeddingSpaceGcReport(
        session.database,
        runId,
      );
      expect(failedReport.status).toBe("failed");
      expect(failedReport.spaces.find((space) => space.spaceId === candidateId))
        .toMatchObject({ state: "failed" });

      await session.database.execute(
        sql`DROP TRIGGER test_reject_embedding_space_delete ON embedding_spaces`,
      );
      await session.database.execute(
        sql`DROP FUNCTION test_reject_embedding_space_delete()`,
      );
      const resumed = await runEmbeddingSpaceGarbageCollection(
        session.database,
        { activeSpaceId: activeId, mode: "resume", runId },
        currentTime,
      );
      expect(resumed.status).toBe("completed");
      expect(resumed.spaces.find((space) => space.spaceId === candidateId)?.state)
        .toBe("deleted");
    } finally {
      await session.database.execute(
        sql`DROP TRIGGER IF EXISTS test_reject_embedding_space_delete ON embedding_spaces`,
      );
      await session.database.execute(
        sql`DROP FUNCTION IF EXISTS test_reject_embedding_space_delete()`,
      );
    }
  });
});

afterAll(async () => {
  await session?.close();
  await rm(sourceContentConfig.directory, { force: true, recursive: true });
});

describe("PostgreSQL document catalog", () => {
  it("returns only documents from source libraries available to the workspace", async () => {
    const originalRows = await session.database
      .select({
        libraryId: sourceLibraries.id,
        workspaceId: workspaces.id,
      })
      .from(sourceLibraries)
      .innerJoin(workspaces, eq(workspaces.id, sourceLibraries.ownerWorkspaceId))
      .where(and(
        eq(sourceLibraries.kind, "private"),
        eq(workspaces.state, "active"),
      ))
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
      .limit(1);
    const original = originalRows[0];
    if (original === undefined) {
      throw new Error("Expected the bootstrap workspace source library.");
    }
    const secondWorkspaceId = randomUUID();
    const secondLibraryId = randomUUID();
    const sharedLibraryId = randomUUID();
    const originalSourceFile = "/documents/original-workspace.pdf";
    const secondSourceFile = "/documents/second-workspace.pdf";
    const sharedSourceFile = "/documents/shared-workspace.pdf";
    const originalDocumentId = "7".repeat(64);
    const secondDocumentId = "8".repeat(64);
    const sharedDocumentId = "9".repeat(64);
    await session.database.insert(workspaces).values({
      id: secondWorkspaceId,
      name: "Second catalog workspace",
      state: "active",
    });
    await session.database.insert(sourceLibraries).values({
      id: secondLibraryId,
      kind: "private",
      name: null,
      ownerWorkspaceId: secondWorkspaceId,
      state: "active",
    });
    await session.database.insert(sourceLibraries).values({
      id: sharedLibraryId,
      kind: "shared",
      name: "Shared catalog sources",
      ownerWorkspaceId: null,
      state: "active",
    });

    try {
      const catalog = new DocumentCatalog(session.database);
      await prepareTestIngestion(
        catalog,
        originalSourceFile,
        originalDocumentId,
        space768.id,
        [],
        false,
        3,
        null,
        null,
        original.libraryId,
      );
      await prepareTestIngestion(
        catalog,
        secondSourceFile,
        secondDocumentId,
        space768.id,
        [],
        false,
        3,
        null,
        null,
        secondLibraryId,
      );
      await prepareTestIngestion(
        catalog,
        sharedSourceFile,
        sharedDocumentId,
        space768.id,
        [],
        false,
        3,
        null,
        null,
        sharedLibraryId,
      );
      const request: BrowseDocumentCatalogRequest = {
        collection: { kind: "all" },
        page: 1,
        pageSize: 25,
        search: "",
        sourceLibraryId: null,
        sort: "name-asc",
        status: "all",
        tag: null,
      };

      const originalCatalog = await browseDocumentCatalog(
        session.query,
        space768.id,
        request,
        original.workspaceId,
      );
      const secondCatalog = await browseDocumentCatalog(
        session.query,
        space768.id,
        request,
        secondWorkspaceId,
      );

      expect(originalCatalog.documents.map((document) => document.sourceFile))
        .toEqual([originalSourceFile]);
      expect(secondCatalog.documents.map((document) => document.sourceFile))
        .toEqual([secondSourceFile]);

      await session.database.insert(workspaceLibraryGrants).values([
        {
          access: "manage",
          libraryId: sharedLibraryId,
          workspaceId: original.workspaceId,
        },
        {
          access: "use",
          libraryId: sharedLibraryId,
          workspaceId: secondWorkspaceId,
        },
      ]);

      const originalCatalogWithSharedSources = await browseDocumentCatalog(
        session.query,
        space768.id,
        request,
        original.workspaceId,
      );
      const secondCatalogWithSharedSources = await browseDocumentCatalog(
        session.query,
        space768.id,
        request,
        secondWorkspaceId,
      );

      expect(originalCatalogWithSharedSources.documents.map((document) => {
        return document.sourceFile;
      })).toEqual([originalSourceFile, sharedSourceFile]);
      expect(secondCatalogWithSharedSources.documents.map((document) => {
        return document.sourceFile;
      })).toEqual([secondSourceFile, sharedSourceFile]);

      const combinedCatalog = new DocumentCatalog(session.database, {
        workspaceIds: [original.workspaceId, secondWorkspaceId],
      });
      const combinedDocuments = await combinedCatalog.listAvailableDocuments(
        space768.id,
      );
      expect(combinedDocuments.map((document) => {
        return document.sourceFile;
      }).sort()).toEqual([
        originalSourceFile,
        secondSourceFile,
        sharedSourceFile,
      ].sort());

      const sharedLibraryRequest: BrowseDocumentCatalogRequest = {
        ...request,
        sourceLibraryId: sharedLibraryId,
      };
      const scopedSharedCatalog = await browseDocumentCatalog(
        session.query,
        space768.id,
        sharedLibraryRequest,
        secondWorkspaceId,
      );
      expect(scopedSharedCatalog.documents.map((document) => {
        return document.sourceFile;
      })).toEqual([sharedSourceFile]);

      await session.database
        .update(sourceLibraries)
        .set({ state: "archived" })
        .where(eq(sourceLibraries.id, sharedLibraryId));
      const catalogWithArchivedLibrary = await browseDocumentCatalog(
        session.query,
        space768.id,
        request,
        secondWorkspaceId,
      );
      expect(catalogWithArchivedLibrary.documents.map((document) => {
        return document.sourceFile;
      })).toEqual([secondSourceFile]);
      await session.database
        .update(sourceLibraries)
        .set({ state: "active" })
        .where(eq(sourceLibraries.id, sharedLibraryId));
      const catalogAfterRestore = await browseDocumentCatalog(
        session.query,
        space768.id,
        sharedLibraryRequest,
        secondWorkspaceId,
      );
      expect(catalogAfterRestore.documents.map((document) => {
        return document.sourceFile;
      })).toEqual([sharedSourceFile]);

      await session.database
        .delete(workspaceLibraryGrants)
        .where(and(
          eq(workspaceLibraryGrants.libraryId, sharedLibraryId),
          eq(workspaceLibraryGrants.workspaceId, secondWorkspaceId),
        ));

      const secondCatalogAfterRevocation = await browseDocumentCatalog(
        session.query,
        space768.id,
        request,
        secondWorkspaceId,
      );
      expect(secondCatalogAfterRevocation.documents.map((document) => {
        return document.sourceFile;
      })).toEqual([secondSourceFile]);
    } finally {
      await session.database
        .delete(ingestionJobs)
        .where(inArray(ingestionJobs.sourceFile, [
          originalSourceFile,
          secondSourceFile,
          sharedSourceFile,
        ]));
      await session.database
        .delete(sourceDocuments)
        .where(inArray(sourceDocuments.documentId, [
          originalDocumentId,
          secondDocumentId,
          sharedDocumentId,
        ]));
      await session.database
        .delete(sourceLibraries)
        .where(inArray(sourceLibraries.id, [
          secondLibraryId,
          sharedLibraryId,
        ]));
      await session.database
        .delete(workspaces)
        .where(eq(workspaces.id, secondWorkspaceId));
    }
  });

  it("preserves immutable retrieval generations when duplicate uploads are reconciled", async () => {
    const documentId = "d".repeat(64);
    const elementId = "e".repeat(64);
    const canonicalSource = "/documents/uploads/first/document.pdf";
    const duplicateSource = "/documents/uploads/second/document.pdf";
    const canonicalVersionId = "00000000-0000-4000-8000-000000000201";
    const duplicateVersionId = "00000000-0000-4000-8000-000000000202";
    await ensureEmbeddingSpace(session.database, space768);
    const elementSetId = await writeTestElementSet(
      documentId,
      canonicalSource,
      [elementId],
    );
    const canonicalGenerationId = randomUUID();
    const duplicateGenerationId = randomUUID();
    await session.database.insert(documentVersions).values([
      {
        ...buildTestDocumentFormatRow(canonicalSource),
        documentId,
        elementSetId,
        generationId: canonicalGenerationId,
        id: canonicalVersionId,
        images: 0,
        pageCount: 1,
        sourceFile: canonicalSource,
        tables: 0,
        textChunks: 1,
        totalElements: 1,
        version: 1,
      },
      {
        ...buildTestDocumentFormatRow(duplicateSource),
        documentId,
        elementSetId,
        generationId: duplicateGenerationId,
        id: duplicateVersionId,
        images: 0,
        pageCount: 1,
        sourceFile: duplicateSource,
        tables: 0,
        textChunks: 1,
        totalElements: 1,
        version: 1,
      },
    ]);
    await session.database.insert(indexedDocuments).values([
      {
        documentId,
        elementSetId,
        generationId: canonicalGenerationId,
        indexedAt: new Date("2026-01-01T00:00:00.000Z"),
        sourceFile: canonicalSource,
        versionId: canonicalVersionId,
      },
      {
        documentId,
        elementSetId,
        generationId: duplicateGenerationId,
        indexedAt: new Date("2026-01-02T00:00:00.000Z"),
        sourceFile: duplicateSource,
        versionId: duplicateVersionId,
      },
    ]);
    await session.database.insert(indexedDocumentSpaces).values([
      {
        documentId,
        embeddingSpaceId: space768.id,
        generationId: canonicalGenerationId,
        representationCount: 1,
        sourceFile: canonicalSource,
      },
      {
        documentId,
        embeddingSpaceId: space768.id,
        generationId: duplicateGenerationId,
        representationCount: 1,
        sourceFile: duplicateSource,
      },
    ]);
    const retrievalMetadata = {
      documentId,
      embeddingSpaceId: space768.id,
      evidenceContent: "Robert is the subject.",
      generationId: duplicateGenerationId,
      id: elementId,
      kind: "text" as const,
      pageNumber: 1,
      parentId: elementId,
      representationType: "exact-window" as const,
      sourceFile: duplicateSource,
    };
    await withOpenTestRetrievalGeneration(session.database, {
      documentId,
      elementSetId,
      generationId: duplicateGenerationId,
      sourceFile: duplicateSource,
      space: space768,
      totalElements: 1,
    }, async () => {
      await session.database.insert(retrievalChunks768).values({
        ...retrievalMetadata,
        embedding: buildEmbedding(768, 1),
      });
      await session.database.insert(retrievalLexicalChunks).values({
        ...retrievalMetadata,
        content: "Robert is the subject.",
      });
      await session.database.transaction(async (transaction) => {
        await synchronizeActiveRetrievalProjection(transaction, {
          documentId,
          elementSetId,
          embeddingSpaceId: space768.id,
          generationId: duplicateGenerationId,
          indexedAt: new Date("2026-01-02T00:00:00.000Z"),
          sourceFile: duplicateSource,
          totalElements: 1,
        });
      });
    });

    const catalog = new DocumentCatalog(session.database);
    const reconciled = await catalog.reconcileUploadedDuplicates(
      "/documents/uploads",
    );

    expect(reconciled).toEqual([duplicateSource]);
    const vectorRows = await session.database
      .select({ sourceFile: retrievalChunks768.sourceFile })
      .from(retrievalChunks768);
    const lexicalRows = await session.database
      .select({ sourceFile: retrievalLexicalChunks.sourceFile })
      .from(retrievalLexicalChunks);
    const activeLexicalRows = await session.database
      .select({ sourceFile: activeRetrievalLexicalChunks.sourceFile })
      .from(activeRetrievalLexicalChunks)
      .where(eq(
        activeRetrievalLexicalChunks.generationId,
        duplicateGenerationId,
      ));
    expect(vectorRows).toEqual([{ sourceFile: duplicateSource }]);
    expect(lexicalRows).toEqual([{ sourceFile: duplicateSource }]);
    expect(activeLexicalRows).toEqual([]);
  });

  it("browses a bounded catalog with server-side filters and facets", async () => {
    await ensureEmbeddingSpace(session.database, space768);
    const indexedValues: Array<typeof indexedDocuments.$inferInsert> = [];
    const versionValues: Array<typeof documentVersions.$inferInsert> = [];
    const spaceValues: Array<typeof indexedDocumentSpaces.$inferInsert> = [];
    for (let index = 0; index < 27; index += 1) {
      const documentId = index.toString(16).padStart(64, "0");
      const sourceFile = `/documents/legal-${String(index).padStart(2, "0")}.pdf`;
      const versionId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const indexedAt = new Date(
        `2026-07-13T12:${String(index).padStart(2, "0")}:00.000Z`,
      );
      const images = index % 3;
      const tables = index % 2;
      const textChunks = index + 1;
      const generationId = randomUUID();
      const elementSetId = await writeTestElementSet(
        documentId,
        sourceFile,
      );
      versionValues.push({
        ...buildTestDocumentFormatRow(sourceFile),
        createdAt: indexedAt,
        documentId,
        elementSetId,
        generationId,
        id: versionId,
        images,
        pageCount: null,
        sourceFile,
        tables,
        textChunks,
        totalElements: textChunks + tables + images,
        version: 1,
      });
      indexedValues.push({
        documentId,
        elementSetId,
        generationId,
        images,
        indexedAt,
        sourceFile,
        tables,
        tags: ["legal"],
        textChunks,
        totalElements: textChunks + tables + images,
        versionId,
      });
      spaceValues.push({
        documentId,
        embeddingSpaceId: space768.id,
        generationId,
        indexedAt: new Date("2026-07-13T13:00:00.000Z"),
        representationCount: 1,
        sourceFile,
      });
    }
    await session.database.insert(documentVersions).values(versionValues);
    await session.database.insert(indexedDocuments).values(indexedValues);
    await session.database.insert(indexedDocumentSpaces).values(spaceValues);
    const failedDocumentId = "f".repeat(64);
    const failedGenerationId = randomUUID();
    const failedSourceFile = "/documents/uploads/failed.pdf";
    const tableElement = buildTableElement(
      failedDocumentId,
      "a".repeat(64),
      failedSourceFile,
    );
    const firstImageElement = buildImageElement(
      failedDocumentId,
      "b".repeat(64),
      failedSourceFile,
    );
    const secondImageElement = buildImageElement(
      failedDocumentId,
      "c".repeat(64),
      failedSourceFile,
    );
    const textElement = {
      ...buildTextElement(failedDocumentId, "d".repeat(64)),
      sourceFile: failedSourceFile,
    };
    const failedElements: SourceElement[] = [
      tableElement,
      firstImageElement,
      secondImageElement,
      textElement,
    ];
    const documentStore = new SourceDocumentStore(session.database);
    await documentStore.writeMany(failedElements);
    const failedElementSet = await documentStore.writeElementSet(
      failedDocumentId,
      failedElements,
    );
    await ensureTestSourceMetadata(failedDocumentId);
    await session.database.insert(ingestionJobs).values({
      documentId: failedDocumentId,
      elementSetId: failedElementSet.id,
      embeddingSpaceId: space768.id,
      errorMessage: "Embedding failed",
      fileExtension: ".pdf",
      generationId: failedGenerationId,
      images: 2,
      indexingActivity: "embedding",
      mediaType: "application/pdf",
      pageCount: 1,
      phase: "normalized",
      sourceFile: failedSourceFile,
      state: "failed",
      tables: 1,
      tags: ["veterinary"],
      textChunks: 1,
      totalElements: 4,
      updatedAt: new Date("2026-07-14T04:00:00.000Z"),
    });
    await session.database.insert(ingestionEmbeddingManifests).values({
      descriptionRepresentationCount: 2,
      documentId: failedDocumentId,
      elementSetId: failedElementSet.id,
      embeddingSpaceId: space768.id,
      generationId: failedGenerationId,
      nextElementPosition: 2,
      retrievalPolicyFingerprint: testRetrievalWindow.fingerprint,
    });
    const tableDescription = buildRetrievalDescriptionRecord(
      tableElement,
      "A table description.",
    );
    const imageDescription = buildRetrievalDescriptionRecord(
      firstImageElement,
      "An image description.",
    );
    await session.database.insert(retrievalDescriptionArtifacts).values([
      {
        description: tableDescription,
        documentId: failedDocumentId,
        generationId: failedGenerationId,
        id: tableDescription.id,
        position: 0,
      },
      {
        description: imageDescription,
        documentId: failedDocumentId,
        generationId: failedGenerationId,
        id: imageDescription.id,
        position: 1,
      },
    ]);

    const firstRequest: BrowseDocumentCatalogRequest = {
      collection: { kind: "all" },
      page: 1,
      pageSize: 25,
      search: "",
      sourceLibraryId: null,
      sort: "name-asc",
      status: "all",
      tag: null,
    };
    const firstPage = await browseDocumentCatalog(
      session.query,
      space768.id,
      firstRequest,
    );

    expect(firstPage.documents).toHaveLength(25);
    expect(firstPage.total).toBe(28);
    expect(firstPage.facets).toMatchObject({
      failed: 1,
      processing: 0,
      queryable: 27,
      ready: 27,
      total: 28,
      uploads: 1,
    });
    expect(firstPage.facets.tags).toEqual([
      { count: 27, tag: "legal" },
      { count: 1, tag: "veterinary" },
    ]);
    expect(firstPage.attention).toMatchObject({
      documents: [{
        displayStatus: "failed",
        embeddingProgress: {
          completedElements: 2,
          state: "in-progress",
          totalElements: 4,
        },
        mediaDescriptionProgress: {
          completedImages: 1,
          completedTables: 1,
        },
        indexingActivity: "embedding",
        phase: "normalized",
        sourceFile: failedSourceFile,
      }],
      total: 1,
    });

    const secondPage = await browseDocumentCatalog(
      session.query,
      space768.id,
      { ...firstRequest, page: 2 },
    );
    expect(secondPage.documents.map((document) => document.sourceFile)).toEqual([
      "/documents/legal-25.pdf",
      "/documents/legal-26.pdf",
      "/documents/uploads/failed.pdf",
    ]);

    const uploadFailure = await browseDocumentCatalog(
      session.query,
      space768.id,
      {
        ...firstRequest,
        collection: { kind: "uploads" },
        status: "failed",
      },
    );
    expect(uploadFailure.documents.map((document) => document.sourceFile)).toEqual([
      failedSourceFile,
    ]);
    expect(uploadFailure.documents[0]).toMatchObject({
      embeddingProgress: {
        completedElements: 2,
        state: "in-progress",
        totalElements: 4,
      },
      mediaDescriptionProgress: {
        completedImages: 1,
        completedTables: 1,
      },
    });

    const queryableSearch = await browseDocumentCatalog(
      session.query,
      space768.id,
      {
        ...firstRequest,
        search: "legal-26",
        status: "queryable",
      },
    );
    expect(queryableSearch.documents.map((document) => document.sourceFile)).toEqual([
      "/documents/legal-26.pdf",
    ]);
  });

  it("checkpoints an ingestion and resolves only its embedding space", async () => {
    await ensureEmbeddingSpace(session.database, space768);
    const catalog = new DocumentCatalog(session.database);
    const sourceFile = "/documents/report.pdf";
    const documentId = "a".repeat(64);
    const elementId = "b".repeat(64);

    const preparation = await prepareTestIngestion(catalog,
      sourceFile,
      documentId,
      space768.id,
      ["Finance", "2026"],
      false,
    );
    expect(preparation.kind).toBe("process");

    await claimTestJob(catalog, sourceFile, "discovered");
    const elementSetId = await writeTestElementSet(
      documentId,
      sourceFile,
      [elementId, "c".repeat(64), "d".repeat(64)],
    );
    const ownerId = await readTestLeaseOwner(catalog, sourceFile);
    await catalog.completeNormalization(sourceFile, ownerId, elementSetId, {
      images: 0,
      pageCount: 12,
      tables: 0,
      textChunks: 3,
      totalElements: 3,
    });
    expect(await catalog.getJob(sourceFile)).toMatchObject({
      indexingActivity: "preparing",
      phase: "normalized",
    });
    await catalog.recordIndexingActivity(
      sourceFile,
      ownerId,
      "building_outline",
    );
    expect(await catalog.getJob(sourceFile)).toMatchObject({
      indexingActivity: "building_outline",
      phase: "normalized",
    });
    await writeTestPublicationArtifacts(sourceFile, space768);
    await catalog.completeIndexing(sourceFile, ownerId);
    expect(await catalog.getJob(sourceFile)).toMatchObject({
      indexingActivity: null,
      phase: "indexed",
    });
    const promotion = await catalog.promoteJob(sourceFile, ownerId);

    expect(promotion.indexed.tags).toEqual(["2026", "finance"]);
    expect(promotion.indexed.pageCount).toBe(12);
    expect(
      await catalog.resolveQueryScope({ kind: "all" }, space768.id),
    ).toEqual([{
      documentId,
      generationId: promotion.indexed.generationId,
      sourceFile,
    }]);
    expect(
      await catalog.resolveQueryScope(
        { kind: "tags", tags: ["FINANCE"] },
        space768.id,
      ),
    ).toEqual([{
      documentId,
      generationId: promotion.indexed.generationId,
      sourceFile,
    }]);
    expect(
      await catalog.resolveQueryScope(
        { kind: "sourceFiles", sourceFiles: [sourceFile] },
        space768.id,
      ),
    ).toEqual([{
      documentId,
      generationId: promotion.indexed.generationId,
      sourceFile,
    }]);
    await expect(
      catalog.resolveQueryScope({ kind: "all" }, space384.id),
    ).rejects.toThrow(
      "The selected embedding configuration has no indexed documents. "
      + "Reindex documents before asking a question.",
    );
    await expect(catalog.resolveQueryScope(
      { documentIds: ["f".repeat(64)], kind: "documentIds" },
      space768.id,
    )).rejects.toBeInstanceOf(QueryScopeNotResolvedError);

    const repeated = await prepareTestIngestion(catalog,
      sourceFile,
      documentId,
      space768.id,
      [],
      false,
    );
    expect(repeated.kind).toBe("skipped");

    const newSpace = await prepareTestIngestion(catalog,
      sourceFile,
      documentId,
      space384.id,
      [],
      false,
    );
    expect(newSpace.kind).toBe("process");
  });

  it("protects a live lease and resumes it after expiry", async () => {
    let currentTime = new Date("2026-07-13T12:00:00.000Z");
    const clock: Clock = { now: () => currentTime };
    const sourceFile = "/documents/interrupted.pdf";
    const documentId = "c".repeat(64);
    const firstCatalog = new DocumentCatalog(
      session.database,
      {
        clock,
        leaseDurationMs: 120_000,
        newLeaseOwnerId: () => "00000000-0000-4000-8000-000000000001",
      },
    );
    const competingCatalog = new DocumentCatalog(
      session.database,
      {
        clock,
        leaseDurationMs: 120_000,
        newLeaseOwnerId: () => "00000000-0000-4000-8000-000000000002",
      },
    );

    await prepareTestIngestion(firstCatalog,
      sourceFile,
      documentId,
      space768.id,
      [],
      false,
    );
    await claimTestJob(firstCatalog, sourceFile, "discovered");
    await expect(
      prepareTestIngestion(competingCatalog,
        sourceFile,
        documentId,
        space768.id,
        [],
        false,
      ),
    ).rejects.toThrow("Another ingestion worker");

    currentTime = new Date(currentTime.getTime() + 120_001);
    await expireTestIngestionLease(sourceFile);
    const resumed = await prepareTestIngestion(competingCatalog,
      sourceFile,
      documentId,
      space768.id,
      [],
      false,
    );
    expect(resumed.kind).toBe("process");
    expect((await competingCatalog.getJob(sourceFile))?.state).toBe("pending");
  });

  it("renews a live lease without resetting its phase start time", async () => {
    let currentTime = new Date("2026-07-13T12:00:00.000Z");
    const clock: Clock = { now: () => currentTime };
    const sourceFile = "/documents/long-partition.pdf";
    const catalog = new DocumentCatalog(
      session.database,
      {
        clock,
        leaseDurationMs: 120_000,
        newLeaseOwnerId: () => "00000000-0000-4000-8000-000000000009",
      },
    );

    await prepareTestIngestion(catalog,
      sourceFile,
      "9".repeat(64),
      space768.id,
      [],
      false,
    );
    await claimTestJob(catalog, sourceFile, "discovered");
    const phaseStartedAt = (await catalog.getJob(sourceFile))?.updatedAt;

    currentTime = new Date("2026-07-13T12:01:00.000Z");
    const ownerId = await readTestLeaseOwner(catalog, sourceFile);
    const renewal = await catalog.renewJobLease(sourceFile, ownerId);
    expect(renewal).not.toBeNull();
    expect(renewal?.controlState).toBe("active");
    expect(
      new Date(renewal?.leaseExpiresAt ?? 0).getTime(),
    ).toBeGreaterThan(new Date(renewal?.databaseNow ?? 0).getTime());
    expect(await catalog.getJob(sourceFile)).toMatchObject({
      state: "running",
      updatedAt: phaseStartedAt,
    });
  });

  it("cancels available jobs while protecting active leases", async () => {
    let currentTime = new Date("2026-07-13T12:00:00.000Z");
    const clock: Clock = { now: () => currentTime };
    const catalog = new DocumentCatalog(
      session.database,
      {
        clock,
        leaseDurationMs: 120_000,
        newLeaseOwnerId: () => "00000000-0000-4000-8000-000000000003",
      },
    );
    const pendingSourceFile = "/documents/pending-cancel.pdf";
    const runningSourceFile = "/documents/running-cancel.pdf";
    await prepareTestIngestion(catalog,
      pendingSourceFile,
      "1".repeat(64),
      space768.id,
      [],
      false,
    );
    await prepareTestIngestion(catalog,
      runningSourceFile,
      "2".repeat(64),
      space768.id,
      [],
      false,
    );
    await claimTestJob(catalog, runningSourceFile, "discovered");

    expect(await catalog.cancelAvailableJob(pendingSourceFile)).toMatchObject({
      sourceFile: pendingSourceFile,
      state: "pending",
    });
    expect(await catalog.cancelAvailableJob(runningSourceFile)).toBeNull();
    expect(await catalog.getJob(pendingSourceFile)).toBeNull();

    currentTime = new Date(currentTime.getTime() + 120_001);
    await expireTestIngestionLease(runningSourceFile);
    expect(await catalog.cancelAvailableJob(runningSourceFile)).toMatchObject({
      sourceFile: runningSourceFile,
      state: "running",
    });
    expect(await catalog.getJob(runningSourceFile)).toBeNull();
  });

  it("cancels a queue selection atomically", async () => {
    let currentTime = new Date("2026-07-13T12:00:00.000Z");
    const clock: Clock = { now: () => currentTime };
    const catalog = new DocumentCatalog(
      session.database,
      {
        clock,
        leaseDurationMs: 120_000,
        newLeaseOwnerId: () => "00000000-0000-4000-8000-000000000004",
      },
    );
    const pendingSourceFile = "/documents/batch-pending.pdf";
    const runningSourceFile = "/documents/batch-running.pdf";
    await prepareTestIngestion(catalog,
      pendingSourceFile,
      "3".repeat(64),
      space768.id,
      [],
      false,
    );
    await prepareTestIngestion(catalog,
      runningSourceFile,
      "4".repeat(64),
      space768.id,
      [],
      false,
    );
    await claimTestJob(catalog, runningSourceFile, "discovered");

    await expect(catalog.cancelAvailableJobs([
      pendingSourceFile,
      runningSourceFile,
    ])).rejects.toThrow("no jobs were canceled");
    expect(await catalog.getJob(pendingSourceFile)).not.toBeNull();
    expect(await catalog.getJob(runningSourceFile)).not.toBeNull();

    currentTime = new Date(currentTime.getTime() + 120_001);
    await expireTestIngestionLease(runningSourceFile);
    const canceled = await catalog.cancelAvailableJobs([
      pendingSourceFile,
      runningSourceFile,
    ]);
    expect(canceled.map((job) => job.sourceFile)).toEqual([
      pendingSourceFile,
      runningSourceFile,
    ]);
    expect(await catalog.getJob(pendingSourceFile)).toBeNull();
    expect(await catalog.getJob(runningSourceFile)).toBeNull();
  });

  it("retries a failed phase with exponential scheduling", async () => {
    let currentTime = new Date("2026-07-13T12:00:00.000Z");
    const clock: Clock = { now: () => currentTime };
    const catalog = new DocumentCatalog(
      session.database,
      {
        clock,
        leaseDurationMs: 120_000,
        newLeaseOwnerId: () => "00000000-0000-4000-8000-000000000003",
      },
    );
    const sourceFile = "/documents/retry.pdf";
    await prepareTestIngestion(catalog,
      sourceFile,
      "d".repeat(64),
      space768.id,
      [],
      false,
      3,
    );
    await claimTestJob(catalog, sourceFile, "discovered");
    const firstFailure = await catalog.markJobFailed(
      sourceFile,
      await readTestLeaseOwner(catalog, sourceFile),
      "temporary outage",
      buildTestApplicationError(sourceFile, "temporary outage"),
      1_000,
    );
    expect(firstFailure).toEqual({
      attempts: 1,
      retryAt: "2026-07-13T12:00:01.000Z",
      retryScheduled: true,
    });
    expect(await catalog.claimJob(sourceFile, "discovered")).toBeNull();

    currentTime = new Date("2026-07-13T12:00:01.001Z");
    const retriedJob = await catalog.claimNextJob(
      space768.id,
    );
    expect(retriedJob).toMatchObject({
      attemptCount: 1,
      sourceFile,
      state: "running",
    });
    const secondFailure = await catalog.markJobFailed(
      sourceFile,
      await readTestLeaseOwner(catalog, sourceFile),
      "temporary outage again",
      buildTestApplicationError(sourceFile, "temporary outage again"),
      1_000,
    );
    expect(secondFailure).toMatchObject({
      attempts: 2,
      retryScheduled: true,
    });
    const failureHistory = await session.database
      .select({
        attemptNumber: applicationErrorEvents.attemptNumber,
        message: applicationErrorEvents.message,
      })
      .from(applicationErrorEvents)
      .where(eq(applicationErrorEvents.sourceFile, sourceFile))
      .orderBy(applicationErrorEvents.attemptNumber);
    expect(failureHistory).toEqual([
      { attemptNumber: 1, message: "temporary outage" },
      { attemptNumber: 2, message: "temporary outage again" },
    ]);
  });

  it("deduplicates one reported occurrence and retains every Docling detail", async () => {
    const reporter = new ApplicationErrorReporter(session.database);
    const context = {
      attemptNumber: 1,
      doclingErrors: [
        {
          category: "backend_failure",
          componentType: "document_backend",
          message: "first page failure",
          moduleName: "pdf_backend",
          pageNumber: 23,
        },
        {
          category: "inference_failure",
          componentType: "model",
          message: "document model failure",
          moduleName: "layout_model",
        },
      ],
      jobId: "00000000-0000-4000-8000-000000000021",
      operation: "convert-document",
      origin: "docling-task" as const,
      service: "worker",
      taskId: "00000000-0000-4000-8000-000000000022",
    };

    const first = await reporter.report(new Error("conversion failed"), context);
    const duplicate = await reporter.report(
      new Error("conversion failed during reconnect"),
      context,
    );

    expect(duplicate.event.id).toBe(first.event.id);
    const events = await session.database
      .select({ id: applicationErrorEvents.id })
      .from(applicationErrorEvents)
      .where(eq(applicationErrorEvents.id, first.event.id));
    const details = await session.database
      .select({
        pageNumber: doclingErrorDetails.pageNumber,
        sequence: doclingErrorDetails.sequence,
      })
      .from(doclingErrorDetails)
      .where(eq(doclingErrorDetails.applicationErrorId, first.event.id))
      .orderBy(doclingErrorDetails.sequence);
    expect(events).toEqual([{ id: first.event.id }]);
    expect(details).toEqual([
      { pageNumber: 23, sequence: 0 },
      { pageNumber: null, sequence: 1 },
    ]);
  });

  it("reads workspace-scoped error report areas with structured Docling details", async () => {
    const workspaceId = "00000000-0000-4000-8000-000000000401";
    const otherWorkspaceId = "00000000-0000-4000-8000-000000000402";
    const globalErrorId = "00000000-0000-4000-8000-000000000403";
    const ingestionErrorId = "00000000-0000-4000-8000-000000000404";
    const applicationErrorId = "00000000-0000-4000-8000-000000000405";
    const otherWorkspaceErrorId = "00000000-0000-4000-8000-000000000406";
    await session.database.insert(applicationErrorEvents).values([
      {
        category: "worker",
        code: "worker_failed",
        id: globalErrorId,
        message: "Global worker failure.",
        occurredAt: new Date("2026-07-27T10:00:00.000Z"),
        operation: "run-worker",
        origin: "worker",
        service: "worker",
        severity: "error",
      },
      {
        category: "dependency",
        code: "conversion_failed",
        id: ingestionErrorId,
        message: "Document conversion failed.",
        occurredAt: new Date("2026-07-27T11:00:00.000Z"),
        operation: "convert-document",
        origin: "docling-conversion",
        service: "worker",
        severity: "error",
        workspaceId,
      },
      {
        category: "internal",
        code: "request_failed",
        id: applicationErrorId,
        message: "Request failed.",
        occurredAt: new Date("2026-07-27T12:00:00.000Z"),
        operation: "dashboard",
        origin: "http-request",
        service: "web",
        severity: "error",
        workspaceId,
      },
      {
        category: "ingestion",
        code: "other_workspace_failure",
        id: otherWorkspaceErrorId,
        message: "Another workspace failure.",
        occurredAt: new Date("2026-07-27T13:00:00.000Z"),
        operation: "ingest",
        origin: "ingestion",
        service: "worker",
        severity: "error",
        workspaceId: otherWorkspaceId,
      },
    ]);
    await session.database.insert(doclingErrorDetails).values([
      {
        applicationErrorId: ingestionErrorId,
        category: "backend_failure",
        componentType: "document_backend",
        message: "Page decode failed.",
        moduleName: "pdf_backend",
        pageNumber: 17,
        sequence: 0,
      },
      {
        applicationErrorId: ingestionErrorId,
        category: "inference_failure",
        componentType: "model",
        doclingLabel: "table",
        elementKind: "table",
        message: "Table model failed.",
        moduleName: "table_structure",
        pageRangeEnd: 24,
        pageRangeStart: 18,
        sequence: 1,
      },
    ]);

    const allErrors = await readApplicationErrorPage(
      session.database,
      workspaceId,
      { area: "all", page: 1, pageSize: 25 },
    );
    const ingestionErrors = await readApplicationErrorPage(
      session.database,
      workspaceId,
      { area: "ingestion", page: 1, pageSize: 25 },
    );

    expect(allErrors.counts).toEqual({
      all: 3,
      application: 1,
      general: 1,
      ingestion: 1,
    });
    expect(allErrors.total).toBe(3);
    expect(allErrors.pageCount).toBe(1);
    expect(allErrors.errors.map((error) => error.id)).toEqual([
      applicationErrorId,
      ingestionErrorId,
      globalErrorId,
    ]);
    expect(allErrors.errors.map((error) => error.workspaceId)).not.toContain(
      otherWorkspaceId,
    );
    expect(ingestionErrors.total).toBe(1);
    expect(ingestionErrors.errors[0]).toMatchObject({
      area: "ingestion",
      id: ingestionErrorId,
    });
    expect(ingestionErrors.errors[0]?.doclingErrors).toEqual([
      expect.objectContaining({
        pageNumber: 17,
        pageRangeEnd: null,
        pageRangeStart: null,
      }),
      expect.objectContaining({
        doclingLabel: "table",
        elementKind: "table",
        pageNumber: null,
        pageRangeEnd: 24,
        pageRangeStart: 18,
      }),
    ]);
  });

  it("atomically purges visible application errors and their details", async () => {
    const workspaceId = "00000000-0000-4000-8000-000000000411";
    const otherWorkspaceId = "00000000-0000-4000-8000-000000000412";
    const globalErrorId = "00000000-0000-4000-8000-000000000413";
    const workspaceErrorId = "00000000-0000-4000-8000-000000000414";
    const otherWorkspaceErrorId = "00000000-0000-4000-8000-000000000415";
    await session.database.insert(applicationErrorEvents).values([
      buildStoredApplicationError(
        globalErrorId,
        new Date("2026-07-27T10:00:00.000Z"),
      ),
      {
        ...buildStoredApplicationError(
          workspaceErrorId,
          new Date("2026-07-27T11:00:00.000Z"),
        ),
        workspaceId,
      },
      {
        ...buildStoredApplicationError(
          otherWorkspaceErrorId,
          new Date("2026-07-27T12:00:00.000Z"),
        ),
        workspaceId: otherWorkspaceId,
      },
    ]);
    await session.database.insert(doclingErrorDetails).values([
      buildStoredDoclingError(globalErrorId),
      buildStoredDoclingError(workspaceErrorId),
      buildStoredDoclingError(otherWorkspaceErrorId),
    ]);

    await expect(
      purgeApplicationErrors(session.database, workspaceId),
    ).resolves.toEqual({ deleted: 2 });

    const remainingEvents = await session.database
      .select({ id: applicationErrorEvents.id })
      .from(applicationErrorEvents);
    const remainingDetails = await session.database
      .select({ applicationErrorId: doclingErrorDetails.applicationErrorId })
      .from(doclingErrorDetails);
    expect(remainingEvents).toEqual([{ id: otherWorkspaceErrorId }]);
    expect(remainingDetails).toEqual([{
      applicationErrorId: otherWorkspaceErrorId,
    }]);
    await expect(
      purgeApplicationErrors(session.database, workspaceId),
    ).resolves.toEqual({ deleted: 0 });
  });

  it("enforces application error age and row bounds in restartable batches", async () => {
    const oldFirstId = "00000000-0000-4000-8000-000000000501";
    const oldSecondId = "00000000-0000-4000-8000-000000000502";
    const recentIds = [
      "00000000-0000-4000-8000-000000000503",
      "00000000-0000-4000-8000-000000000504",
      "00000000-0000-4000-8000-000000000505",
      "00000000-0000-4000-8000-000000000506",
    ];
    const events: Array<typeof applicationErrorEvents.$inferInsert> = [];
    events.push(buildStoredApplicationError(
      oldFirstId,
      new Date("2000-01-01T00:00:00.000Z"),
    ));
    events.push(buildStoredApplicationError(
      oldSecondId,
      new Date("2000-01-02T00:00:00.000Z"),
    ));
    for (let index = 0; index < recentIds.length; index += 1) {
      const id = recentIds[index];
      if (id === undefined) {
        continue;
      }
      events.push(buildStoredApplicationError(
        id,
        new Date(Date.now() - ((recentIds.length - index) * 1_000)),
      ));
    }
    await session.database.insert(applicationErrorEvents).values(events);
    await session.database.insert(doclingErrorDetails).values([
      buildStoredDoclingError(oldFirstId),
      buildStoredDoclingError(recentIds[1] ?? ""),
    ]);

    const result = await enforceApplicationErrorRetention(
      session.database,
      { maximumRows: 3, retentionDays: 30 },
      2,
      5,
    );

    expect(result).toEqual({ batches: 2, deleted: 3, hasMore: false });
    const remainingEvents = await session.database
      .select({ id: applicationErrorEvents.id })
      .from(applicationErrorEvents)
      .orderBy(applicationErrorEvents.occurredAt);
    expect(remainingEvents.map((row) => row.id)).toEqual(recentIds.slice(1));
    const remainingDetails = await session.database
      .select({ applicationErrorId: doclingErrorDetails.applicationErrorId })
      .from(doclingErrorDetails);
    expect(remainingDetails).toEqual([{
      applicationErrorId: recentIds[1],
    }]);
  });

  it("rolls back interrupted error retention and succeeds on retry", async () => {
    const eventId = "00000000-0000-4000-8000-000000000507";
    await session.database.insert(applicationErrorEvents).values(
      buildStoredApplicationError(
        eventId,
        new Date("2000-01-01T00:00:00.000Z"),
      ),
    );
    await session.database.insert(doclingErrorDetails).values(
      buildStoredDoclingError(eventId),
    );
    await session.database.execute(sql`
      CREATE FUNCTION test_reject_application_error_delete() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'simulated interrupted application error cleanup';
      END;
      $$ LANGUAGE plpgsql
    `);
    await session.database.execute(sql`
      CREATE TRIGGER test_reject_application_error_delete
      BEFORE DELETE ON application_error_events
      FOR EACH ROW EXECUTE FUNCTION test_reject_application_error_delete()
    `);

    try {
      await expect(deleteApplicationErrorRetentionBatch(
        session.database,
        { maximumRows: 100, retentionDays: 30 },
      )).rejects.toThrow();
      expect(await session.database
        .select({ id: applicationErrorEvents.id })
        .from(applicationErrorEvents)).toEqual([{ id: eventId }]);
      expect(await session.database
        .select({ applicationErrorId: doclingErrorDetails.applicationErrorId })
        .from(doclingErrorDetails)).toEqual([{ applicationErrorId: eventId }]);
    } finally {
      await session.database.execute(sql`
        DROP TRIGGER IF EXISTS test_reject_application_error_delete
        ON application_error_events
      `);
      await session.database.execute(sql`
        DROP FUNCTION IF EXISTS test_reject_application_error_delete()
      `);
    }

    await expect(deleteApplicationErrorRetentionBatch(
      session.database,
      { maximumRows: 100, retentionDays: 30 },
    )).resolves.toEqual({ deleted: 1, hasMore: false });
    expect(await session.database
      .select({ id: applicationErrorEvents.id })
      .from(applicationErrorEvents)).toEqual([]);
    expect(await session.database
      .select({ applicationErrorId: doclingErrorDetails.applicationErrorId })
      .from(doclingErrorDetails)).toEqual([]);
  });

  it("defers error retention without waiting on another cleaner", async () => {
    const lockAcquired = createDeferred<void>();
    const releaseLock = createDeferred<void>();
    const lock = session.database.transaction(async (transaction) => {
      await transaction.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended('citeloom.application-error-retention', 0)
        )
      `);
      lockAcquired.resolve();
      await releaseLock.promise;
    });
    await lockAcquired.promise;

    try {
      await expect(enforceApplicationErrorRetention(
        session.database,
        { maximumRows: 100, retentionDays: 30 },
      )).resolves.toEqual({
        batches: 1,
        deleted: 0,
        hasMore: true,
      });
    } finally {
      releaseLock.resolve();
      await lock;
    }
  });

  it("rolls back a failed job transition when error persistence fails", async () => {
    const catalog = new DocumentCatalog(session.database);
    const sourceFile = "/documents/error-transaction.pdf";
    await prepareTestIngestion(
      catalog,
      sourceFile,
      "6".repeat(64),
      space768.id,
      [],
      false,
      3,
    );
    const job = await claimTestJob(catalog, sourceFile, "discovered");
    const invalidEvent = {
      ...buildTestApplicationError(sourceFile, "temporary failure"),
      message: "",
    };

    await expect(catalog.markJobFailed(
      sourceFile,
      job.ownerId,
      "temporary failure",
      invalidEvent,
    )).rejects.toThrow();
    expect(await catalog.getJob(sourceFile)).toMatchObject({
      attemptCount: 0,
      errorMessage: null,
      ownerId: job.ownerId,
      state: "running",
    });
  });

  it("releases an interrupted job without consuming a retry", async () => {
    const ownerId = "00000000-0000-4000-8000-000000000008";
    const catalog = new DocumentCatalog(session.database, {
      newLeaseOwnerId: () => ownerId,
    });
    const sourceFile = "/documents/interrupted.pdf";
    await prepareTestIngestion(catalog,
      sourceFile,
      "e".repeat(64),
      space768.id,
      [],
      false,
      3,
    );
    await claimTestJob(catalog, sourceFile, "discovered");

    expect(await catalog.releaseJob(sourceFile, ownerId)).toBe(true);
    expect(await catalog.getJob(sourceFile)).toMatchObject({
      attemptCount: 0,
      errorMessage: null,
      phase: "discovered",
      state: "pending",
    });
    const otherCatalog = new DocumentCatalog(session.database);
    expect(await otherCatalog.claimNextJob(
      space768.id,
    )).toMatchObject({
      sourceFile,
      state: "running",
    });
  });

  it("persists independent Docling request checkpoints and one attempt configuration across recovery", async () => {
    let currentTime = new Date("2026-07-15T12:00:00.000Z");
    const clock: Clock = { now: () => currentTime };
    const firstCatalog = new DocumentCatalog(
      session.database,
      {
        clock,
        leaseDurationMs: 120_000,
        newLeaseOwnerId: () => "00000000-0000-4000-8000-000000000012",
      },
    );
    const secondCatalog = new DocumentCatalog(
      session.database,
      {
        clock,
        leaseDurationMs: 120_000,
        newLeaseOwnerId: () => "00000000-0000-4000-8000-000000000013",
      },
    );
    const sourceFile = "/documents/durable-docling-requests.pdf";
    await prepareTestIngestion(firstCatalog,
      sourceFile,
      "2".repeat(64),
      space768.id,
      [],
      false,
    );
    await claimTestJob(firstCatalog, sourceFile, "discovered");
    const config = buildTestConfig();
    const defaultService = config.doclingServices[0];
    if (defaultService === undefined) {
      throw new Error("Missing default Docling test service.");
    }
    const serviceStore = new DoclingServiceStore(session.database);
    await serviceStore.synchronize([
      buildAvailableDoclingServiceVerification(defaultService),
    ]);
    await serviceStore.ensureAssignment(
      "00000000-0000-4000-8000-000000000012",
      sourceFile,
    );
    config.docling.pdfBackend = "threaded_docling_parse";
    const snapshot = createDoclingAttemptConfigSnapshot(config.docling, 11);
    expect(await firstCatalog.ensureDoclingAttemptConfig(
      sourceFile,
      "00000000-0000-4000-8000-000000000012",
      snapshot,
    )).toEqual(snapshot);
    const structure = {
      deadlineAt: "2026-07-15T22:00:00.000Z",
      id: "structure-task",
      submittedAt: "2026-07-15T12:00:00.000Z",
    };
    const pageImage = {
      deadlineAt: "2026-07-15T22:10:00.000Z",
      id: "page-image-task",
      submittedAt: "2026-07-15T12:10:00.000Z",
    };
    expect(await firstCatalog.recordDoclingTaskCheckpoint(
      sourceFile,
      "00000000-0000-4000-8000-000000000012",
      "structure",
      structure,
      "default",
    )).toBe(true);
    expect(await firstCatalog.recordDoclingTaskCheckpoint(
      sourceFile,
      "00000000-0000-4000-8000-000000000012",
      "page-image:pages:1",
      pageImage,
      "default",
    )).toBe(true);

    currentTime = new Date("2026-07-15T12:02:00.001Z");
    await expireTestIngestionLease(sourceFile);
    expect(await secondCatalog.claimNextJob(
      space768.id,
    )).toMatchObject({
      doclingAttemptConfig: snapshot,
      sourceFile,
      state: "running",
    });
    expect(await secondCatalog.readDoclingTaskCheckpoint(
      sourceFile,
      "00000000-0000-4000-8000-000000000013",
      "structure",
      "default",
    )).toEqual(structure);
    await expect(secondCatalog.readDoclingTaskCheckpoint(
      sourceFile,
      "00000000-0000-4000-8000-000000000013",
      "structure",
      "replica-b",
    )).rejects.toThrow("does not match assigned service replica-b");
    expect(await secondCatalog.readDoclingTaskCheckpoint(
      sourceFile,
      "00000000-0000-4000-8000-000000000013",
      "page-image:pages:1",
      "default",
    )).toEqual(pageImage);
    expect(await secondCatalog.clearDoclingTaskCheckpoint(
      sourceFile,
      "00000000-0000-4000-8000-000000000013",
      "page-image:pages:1",
      pageImage.id,
      "default",
    )).toBe(true);
    expect(await secondCatalog.readDoclingTaskCheckpoint(
      sourceFile,
      "00000000-0000-4000-8000-000000000013",
      "page-image:pages:1",
      "default",
    )).toBeNull();
    expect(await secondCatalog.readDoclingTaskCheckpoint(
      sourceFile,
      "00000000-0000-4000-8000-000000000013",
      "structure",
      "default",
    )).toEqual(structure);
    expect((await secondCatalog.getJob(sourceFile))?.doclingAttemptConfig).toEqual(
      snapshot,
    );
    const elementSetId = await writeTestElementSet(
      "2".repeat(64),
      sourceFile,
    );
    await secondCatalog.completeNormalization(
      sourceFile,
      "00000000-0000-4000-8000-000000000013",
      elementSetId,
      {
      images: 0,
      pageCount: null,
      tables: 0,
      textChunks: 1,
      totalElements: 1,
      },
    );
    expect(await secondCatalog.readDoclingTaskCheckpoint(
      sourceFile,
      "00000000-0000-4000-8000-000000000013",
      "structure",
      "default",
    )).toBeNull();
    expect(await secondCatalog.getJob(sourceFile)).toMatchObject({
      doclingAttemptConfig: null,
      phase: "normalized",
    });
  });

  it("returns an interrupted processor job to the queue without a retry", async () => {
    const config = buildTestConfig();
    const processor = new IngestionProcessor(
      config,
      session.database,
      () => undefined,
    );
    const sourceFile = "/documents/processor-interrupted.pdf";
    await prepareTestIngestion(processor.catalog,
      sourceFile,
      "f".repeat(64),
      config.embeddingSpace.id,
      [],
      false,
      3,
    );
    const claimedJob = await processor.catalog.claimNextJob(
      config.embeddingSpace.id,
    );
    if (claimedJob === null) {
      throw new Error("Expected the processor test job to be claimed.");
    }
    const controller = new AbortController();
    controller.abort(new Error("worker stopped"));

    await expect(
      processor.processClaimedJob(claimedJob, controller.signal),
    ).resolves.toEqual({ kind: "interrupted" });
    expect(await processor.catalog.getJob(sourceFile)).toMatchObject({
      attemptCount: 0,
      errorMessage: null,
      phase: "discovered",
      state: "pending",
    });
  });

  it("manually retries a terminal failure from its durable phase", async () => {
    const catalog = new DocumentCatalog(session.database);
    const sourceFile = "/documents/manual-retry.pdf";
    const documentId = "9".repeat(64);
    const elementId = "a".repeat(64);
    await prepareTestIngestion(catalog,
      sourceFile,
      documentId,
      space768.id,
      ["legal"],
      false,
      1,
    );
    await claimTestJob(catalog, sourceFile, "discovered");
    const elementSetId = await writeTestElementSet(
      documentId,
      sourceFile,
      [elementId],
    );
    const ownerId = await readTestLeaseOwner(catalog, sourceFile);
    await catalog.completeNormalization(sourceFile, ownerId, elementSetId, {
      images: 0,
      pageCount: null,
      tables: 0,
      textChunks: 1,
      totalElements: 1,
    });
    expect(await catalog.markJobFailed(
      sourceFile,
      ownerId,
      "model unavailable",
      buildTestApplicationError(sourceFile, "model unavailable"),
    )).toEqual({
      attempts: 1,
      retryAt: null,
      retryScheduled: false,
    });

    const result = await catalog.retryFailedJob(sourceFile);

    expect(result).toMatchObject({
      job: {
        attemptCount: 0,
        documentId,
        elementSetId,
        errorMessage: null,
        phase: "normalized",
        sourceFile,
        state: "pending",
        tags: ["legal"],
      },
      kind: "retried",
    });
    expect(await catalog.retryFailedJob(sourceFile)).toEqual({
      kind: "not-failed",
      state: "pending",
    });
    expect(await catalog.retryFailedJob("/documents/missing.pdf")).toEqual({
      kind: "not-found",
    });
    expect(await catalog.claimNextJob(
      space768.id,
    )).toMatchObject({
      phase: "normalized",
      sourceFile,
      state: "running",
    });
  });

  it("preserves durable Docling state for force, embedding, and content resets", async () => {
    const ownerId = "00000000-0000-4000-8000-000000000019";
    const catalog = new DocumentCatalog(session.database, {
      newLeaseOwnerId: () => ownerId,
    });
    const config = buildTestConfig();
    const sourceFile = "/documents/non-semantic-reset.pdf";
    const documentId = "5".repeat(64);
    const changedDocumentId = "6".repeat(64);
    await prepareTestIngestion(catalog,
      sourceFile,
      documentId,
      space768.id,
      [],
      false,
      1,
    );
    await claimTestJob(catalog, sourceFile, "discovered");

    const service = config.doclingServices[0];
    if (service === undefined) {
      throw new Error("Missing default Docling test service.");
    }
    const serviceStore = new DoclingServiceStore(session.database);
    await serviceStore.synchronize([
      buildAvailableDoclingServiceVerification(service),
    ]);
    await serviceStore.ensureAssignment(ownerId, sourceFile);
    const attemptConfig = createDoclingAttemptConfigSnapshot(config.docling, 18);
    await catalog.ensureDoclingAttemptConfig(sourceFile, ownerId, attemptConfig);
    expect(await catalog.recordDoclingTaskCheckpoint(
      sourceFile,
      ownerId,
      "structure",
      {
        deadlineAt: "2026-07-20T02:00:00.000Z",
        id: "non-semantic-reset-task",
        submittedAt: "2026-07-19T20:00:00.000Z",
      },
      service.id,
    )).toBe(true);
    expect(await catalog.markJobFailed(
      sourceFile,
      ownerId,
      "conversion failed",
      buildTestApplicationError(sourceFile, "conversion failed"),
    )).toEqual({
      attempts: 1,
      retryAt: null,
      retryScheduled: false,
    });

    const forced = await prepareTestIngestion(catalog,
      sourceFile,
      documentId,
      space768.id,
      [],
      true,
      1,
    );
    expect(forced.kind).toBe("process");

    const embeddingSpaceChanged = await prepareTestIngestion(catalog,
      sourceFile,
      documentId,
      space384.id,
      [],
      false,
      1,
    );
    expect(embeddingSpaceChanged.kind).toBe("process");

    const contentChanged = await prepareTestIngestion(catalog,
      sourceFile,
      changedDocumentId,
      space384.id,
      [],
      false,
      1,
    );
    expect(contentChanged.kind).toBe("process");

    expect(await catalog.getJob(sourceFile)).toMatchObject({
      doclingAttemptConfig: attemptConfig,
      doclingRunId: null,
      state: "pending",
    });
    expect(await session.database
      .select({
        serviceInstanceId: ingestionJobs.doclingServiceInstanceId,
        serviceSlot: ingestionJobs.doclingServiceSlot,
      })
      .from(ingestionJobs)
      .where(eq(ingestionJobs.sourceFile, sourceFile)))
      .toEqual([{
        serviceInstanceId: service.id,
        serviceSlot: 1,
      }]);
    expect(await session.database
      .select({
        requestKey: doclingTaskCheckpoints.requestKey,
        taskId: doclingTaskCheckpoints.taskId,
      })
      .from(doclingTaskCheckpoints)
      .where(eq(doclingTaskCheckpoints.sourceFile, sourceFile)))
      .toEqual([{
        requestKey: "structure",
        taskId: "non-semantic-reset-task",
      }]);
  });

  it("claims only jobs for the configured embedding space", async () => {
    const catalog = new DocumentCatalog(session.database);
    const previousSourceFile = "/documents/previous-space.pdf";
    const currentSourceFile = "/documents/current-space.pdf";
    await prepareTestIngestion(catalog,
      previousSourceFile,
      "4".repeat(64),
      space384.id,
      [],
      false,
    );
    await prepareTestIngestion(catalog,
      currentSourceFile,
      "5".repeat(64),
      space768.id,
      [],
      false,
    );

    const claimedJob = await catalog.claimNextJob(
      space768.id,
    );

    expect(claimedJob?.sourceFile).toBe(currentSourceFile);
    expect((await catalog.getJob(previousSourceFile))?.state).toBe("pending");
  });

  it("claims the most advanced due ingestion phase first", async () => {
    const catalog = new DocumentCatalog(session.database);
    const advancedSourceFile = "/documents/advanced.pdf";
    const discoveredSourceFile = "/documents/discovered.pdf";
    await prepareTestIngestion(catalog,
      advancedSourceFile,
      "6".repeat(64),
      space768.id,
      [],
      false,
    );
    await prepareTestIngestion(catalog,
      discoveredSourceFile,
      "7".repeat(64),
      space768.id,
      [],
      false,
    );
    await claimTestJob(catalog, advancedSourceFile, "discovered");
    const advancedElementSetId = await writeTestElementSet(
      "6".repeat(64),
      advancedSourceFile,
      ["8".repeat(64)],
    );
    const advancedOwnerId = await readTestLeaseOwner(
      catalog,
      advancedSourceFile,
    );
    await catalog.completeNormalization(
      advancedSourceFile,
      advancedOwnerId,
      advancedElementSetId,
      {
      images: 0,
      pageCount: null,
      tables: 0,
      textChunks: 1,
      totalElements: 1,
      },
    );
    expect(await catalog.releaseJob(
      advancedSourceFile,
      advancedOwnerId,
    )).toBe(true);

    const claimedJob = await catalog.claimNextJob(
      space768.id,
    );

    expect(claimedJob).toMatchObject({
      phase: "normalized",
      sourceFile: advancedSourceFile,
    });
    expect((await catalog.getJob(discoveredSourceFile))?.state).toBe("pending");
  });

  it("keeps the active document while a replacement job fails permanently", async () => {
    await ensureEmbeddingSpace(session.database, space768);
    const catalog = new DocumentCatalog(session.database);
    const sourceFile = "/documents/versioned.pdf";
    const activeDocumentId = "e".repeat(64);
    const replacementDocumentId = "f".repeat(64);

    await prepareTestIngestion(catalog,
      sourceFile,
      activeDocumentId,
      space768.id,
      [],
      false,
    );
    await claimTestJob(catalog, sourceFile, "discovered");
    const activeElementSetId = await writeTestElementSet(
      activeDocumentId,
      sourceFile,
      ["1".repeat(64)],
    );
    const activeOwnerId = await readTestLeaseOwner(catalog, sourceFile);
    await catalog.completeNormalization(sourceFile, activeOwnerId, activeElementSetId, {
      images: 0,
      pageCount: null,
      tables: 0,
      textChunks: 1,
      totalElements: 1,
    });
    await writeTestPublicationArtifacts(sourceFile, space768);
    await catalog.completeIndexing(sourceFile, activeOwnerId);
    const activePublication = await catalog.promoteJob(
      sourceFile,
      activeOwnerId,
    );

    await prepareTestIngestion(catalog,
      sourceFile,
      replacementDocumentId,
      space768.id,
      [],
      false,
      1,
    );
    await claimTestJob(catalog, sourceFile, "discovered");
    expect(await catalog.markJobFailed(
      sourceFile,
      await readTestLeaseOwner(catalog, sourceFile),
      "model unavailable",
      buildTestApplicationError(sourceFile, "model unavailable"),
    )).toEqual({
      attempts: 1,
      retryAt: null,
      retryScheduled: false,
    });

    expect(
      await catalog.resolveQueryScope({ kind: "all" }, space768.id),
    ).toEqual([{
      documentId: activeDocumentId,
      generationId: activePublication.indexed.generationId,
      sourceFile,
    }]);
    expect((await catalog.listEntries())[0]).toMatchObject({
      activeDocumentId,
      documentId: replacementDocumentId,
      embeddingSpaceIds: [space768.id],
      status: "failed",
    });
  });

  it("drains every immediately due phase in worker once mode", async () => {
    const catalog = new DocumentCatalog(session.database);
    const config = buildTestConfig();
    const sourceFile = "/documents/worker-once.pdf";
    const documentId = "8".repeat(64);
    await prepareTestIngestion(catalog,
      sourceFile,
      documentId,
      space768.id,
      [],
      false,
    );
    await claimTestJob(catalog, sourceFile, "discovered");
    const elementSetId = await writeTestElementSet(
      documentId,
      sourceFile,
    );
    const ownerId = await readTestLeaseOwner(catalog, sourceFile);
    await catalog.completeNormalization(sourceFile, ownerId, elementSetId, {
      images: 0,
      pageCount: null,
      tables: 0,
      textChunks: 1,
      totalElements: 1,
    });
    await writeTestPublicationArtifacts(sourceFile, space768);
    await catalog.completeIndexing(sourceFile, ownerId);
    const indexedJob = await catalog.getJob(sourceFile);
    if (indexedJob === null) {
      throw new Error("Worker-once fixture lost its indexed job.");
    }
    expect(await catalog.releaseJob(sourceFile, ownerId)).toBe(true);

    await runIngestionWorker(config, { once: true });

    expect(await catalog.getJob(sourceFile)).toBeNull();
    expect(
      await catalog.resolveQueryScope({ kind: "all" }, space768.id),
    ).toEqual([{
      documentId,
      generationId: indexedJob.generationId,
      sourceFile,
    }]);
  });
});

describe("PostgreSQL generation publication", () => {
  it("retains one lease from normalization through atomic publication", async () => {
    await ensureEmbeddingSpace(session.database, space384);
    const ownerId = "00000000-0000-4000-8000-000000000221";
    const catalog = new DocumentCatalog(session.database, {
      newLeaseOwnerId: () => ownerId,
    });
    const sourceFile = "/documents/table-publication.pdf";
    const documentId = "a".repeat(64);
    const table = buildTableElement(documentId, "b".repeat(64), sourceFile);
    const image = buildImageElement(documentId, "e".repeat(64), sourceFile);
    await prepareTestIngestion(catalog,
      sourceFile,
      documentId,
      space384.id,
      ["reports"],
      false,
    );
    await claimTestJob(catalog, sourceFile, "discovered");
    const documentStore = new SourceDocumentStore(session.database);
    await documentStore.writeMany([table, image]);
    const elementSet = await documentStore.writeElementSet(
      documentId,
      [table, image],
    );
    await catalog.completeNormalization(sourceFile, ownerId, elementSet.id, {
      images: 1,
      pageCount: 1,
      tables: 1,
      textChunks: 0,
      totalElements: 2,
    });
    const normalizedJob = await catalog.getJob(sourceFile);
    expect(normalizedJob).toMatchObject({
      ownerId,
      phase: "normalized",
      state: "running",
    });
    if (normalizedJob === null) {
      throw new Error("Missing normalized publication fixture.");
    }

    const description = buildRetrievalDescriptionRecord(
      table,
      "Complaints by province: Ontario recorded 120, Quebec recorded 85, and Alberta recorded 42.",
    );
    const imageDescription = buildRetrievalDescriptionRecord(
      image,
      "Architecture diagram showing documents entering a processing stage.",
    );
    const artifactStore = new IngestionArtifactStore(session.database);
    await artifactStore.writeRetrievalDescription(
      normalizedJob.generationId,
      documentId,
      0,
      description,
    );
    await artifactStore.writeRetrievalDescription(
      normalizedJob.generationId,
      documentId,
      1,
      imageDescription,
    );
    const representations = buildTestRepresentations(
      [table, image],
      [description, imageDescription],
      space384,
    );
    const input = {
      documentId,
      elementSetId: elementSet.id,
      generationId: normalizedJob.generationId,
      totalElements: 2,
    };
    await beginEmbeddingGeneration(session.database, space384, input);
    await stageRetrievalRepresentationBatch(
      session.database,
      space384,
      input,
      0,
      2,
      representations,
      representations.map((_, index) => buildEmbedding(384, index + 1)),
    );
    await stageDocumentTocArtifact(session.database, {
      documentId,
      elementSetId: elementSet.id,
      generationId: normalizedJob.generationId,
      sourceFile,
    }, {
      entries: [],
      mode: "generated",
      version: 1,
    });
    await catalog.completeIndexing(sourceFile, ownerId);
    expect(await catalog.getJob(sourceFile)).toMatchObject({
      ownerId,
      phase: "indexed",
      state: "running",
    });

    const publication = await catalog.promoteJob(sourceFile, ownerId);

    expect(publication.indexed).toMatchObject({
      documentId,
      images: 1,
      sourceFile,
      tables: 1,
    });
    await expect(readActiveDocumentTocs(
      session.database,
      space384.id,
      [{ documentId, sourceFile }],
    )).resolves.toEqual([
      expect.objectContaining({
        documentId,
        elementSetId: elementSet.id,
        generationId: normalizedJob.generationId,
        sourceFile,
      }),
    ]);
    await expect(session.database
      .select({ content: retrievalChunks384.evidenceContent })
      .from(retrievalChunks384)
      .where(and(
        eq(retrievalChunks384.generationId, normalizedJob.generationId),
        eq(retrievalChunks384.representationType, "exact-window"),
      )))
      .resolves.toEqual([{ content: table.content }]);
    const storedDescriptions = await session.database
      .select({ description: retrievalChunks384.evidenceContent })
      .from(retrievalChunks384)
      .where(and(
        eq(retrievalChunks384.generationId, normalizedJob.generationId),
        ne(retrievalChunks384.representationType, "exact-window"),
      ));
    expect(storedDescriptions).toHaveLength(2);
    expect(storedDescriptions).toEqual(expect.arrayContaining([
      {
        description:
          "Complaints by province: Ontario recorded 120, Quebec recorded 85, and Alberta recorded 42.",
      },
      {
        description:
          "Visual summary: Architecture diagram showing documents entering a processing stage.\nImage type: diagram",
      },
    ]));
    const rankings = await queryRetrievalCandidateRankings(
      session.database,
      session.query,
      space384,
      [{
        embedding: buildEmbedding(384, 3),
        text: "document processing architecture",
      }],
      {
        answerTemperature: 0,
        candidateK: 10,
        chatTemperature: 0,
        fusion: { ...EQUAL_WEIGHT_FUSION_CONFIG },
        mode: "dense",
        queryExpansions: 0,
        queryExpansionTemperature: 0,
        reranker: null,
        rrfK: 60,
        topK: 10,
      },
      [{ documentId, generationId: normalizedJob.generationId, sourceFile }],
      new AbortController().signal,
    );
    expect(rankings.dense[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidenceRetrievalId: image.id,
        parentId: image.id,
        representation: expect.objectContaining({
          id: imageDescription.id,
          type: "image-description",
        }),
      }),
    ]));
    const lexicalRankings = await queryRetrievalCandidateRankings(
      session.database,
      session.query,
      space384,
      [{ embedding: null, text: "recorded" }],
      {
        answerTemperature: 0,
        candidateK: 10,
        chatTemperature: 0,
        fusion: { ...EQUAL_WEIGHT_FUSION_CONFIG },
        mode: "bm25",
        queryExpansions: 0,
        queryExpansionTemperature: 0,
        reranker: null,
        rrfK: 60,
        topK: 10,
      },
      [{ documentId, generationId: normalizedJob.generationId, sourceFile }],
      new AbortController().signal,
    );
    expect(lexicalRankings.lexical[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidenceContent: table.content,
        parentId: table.id,
        representation: expect.objectContaining({
          id: description.id,
          type: "table-description",
        }),
      }),
    ]));
    const imageLexicalRankings = await queryRetrievalCandidateRankings(
      session.database,
      session.query,
      space384,
      [{ embedding: null, text: "architecture diagram" }],
      {
        answerTemperature: 0,
        candidateK: 10,
        chatTemperature: 0,
        fusion: { ...EQUAL_WEIGHT_FUSION_CONFIG },
        mode: "bm25",
        queryExpansions: 0,
        queryExpansionTemperature: 0,
        reranker: null,
        rrfK: 60,
        topK: 10,
      },
      [{ documentId, generationId: normalizedJob.generationId, sourceFile }],
      new AbortController().signal,
    );
    expect(imageLexicalRankings.lexical[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        evidenceRetrievalId: image.id,
        parentId: image.id,
        representation: expect.objectContaining({
          id: imageDescription.id,
          type: "image-description",
        }),
      }),
    ]));
    await expect(session.database
      .select({
        representationCount: indexedDocumentSpaces.representationCount,
      })
      .from(indexedDocumentSpaces)
      .where(and(
        eq(indexedDocumentSpaces.sourceFile, sourceFile),
        eq(indexedDocumentSpaces.embeddingSpaceId, space384.id),
      )))
      .resolves.toEqual([{ representationCount: representations.length }]);
    expect(await session.database.select().from(activeRetrievalChunks384))
      .not.toHaveLength(0);
    expect(await session.database.select().from(activeRetrievalLexicalChunks))
      .not.toHaveLength(0);
    expect(await session.database.select().from(activeRetrievalRoutes))
      .not.toHaveLength(0);
    expect(await session.database.select().from(activeRetrievalEvidence))
      .not.toHaveLength(0);

    await session.database
      .delete(indexedDocumentSpaces)
      .where(and(
        eq(indexedDocumentSpaces.sourceFile, sourceFile),
        eq(indexedDocumentSpaces.embeddingSpaceId, space384.id),
      ));

    expect(await session.database.select().from(activeRetrievalChunks384))
      .toEqual([]);
    expect(await session.database.select().from(activeRetrievalLexicalChunks))
      .toEqual([]);
    expect(await session.database.select().from(activeRetrievalRoutes))
      .toEqual([]);
    expect(await session.database.select().from(activeRetrievalEvidence))
      .toEqual([]);
  });

  it("retains completed media descriptions across a retry", async () => {
    const ownerId = "00000000-0000-4000-8000-000000000222";
    const catalog = new DocumentCatalog(session.database, {
      newLeaseOwnerId: () => ownerId,
    });
    const sourceFile = "/documents/table-retry.pdf";
    const documentId = "c".repeat(64);
    const table = buildTableElement(documentId, "d".repeat(64), sourceFile);
    await prepareTestIngestion(catalog,
      sourceFile,
      documentId,
      space384.id,
      [],
      false,
      1,
    );
    await claimTestJob(catalog, sourceFile, "discovered");
    const documentStore = new SourceDocumentStore(session.database);
    await documentStore.writeMany([table]);
    const elementSet = await documentStore.writeElementSet(
      documentId,
      [table],
    );
    await catalog.completeNormalization(sourceFile, ownerId, elementSet.id, {
      images: 0,
      pageCount: 1,
      tables: 1,
      textChunks: 0,
      totalElements: 1,
    });
    const job = await catalog.getJob(sourceFile);
    if (job === null) {
      throw new Error("Missing description retry fixture.");
    }
    const description = buildRetrievalDescriptionRecord(
      table,
      "Complaints by province with exact values for Ontario, Quebec, and Alberta.",
    );
    const artifactStore = new IngestionArtifactStore(session.database);
    await artifactStore.writeRetrievalDescription(
      job.generationId,
      documentId,
      0,
      description,
    );
    expect(await catalog.markJobFailed(
      sourceFile,
      ownerId,
      "description provider unavailable",
      buildTestApplicationError(
        sourceFile,
        "description provider unavailable",
      ),
    )).toEqual({
      attempts: 1,
      retryAt: null,
      retryScheduled: false,
    });

    expect(await catalog.retryFailedJob(sourceFile)).toMatchObject({
      job: { phase: "normalized", state: "pending" },
      kind: "retried",
    });
    await claimTestJob(catalog, sourceFile, "normalized");
    await expect(artifactStore.readRetrievalDescriptionCheckpoints(
      job.generationId,
      0,
      10,
    )).resolves.toEqual([{ description, position: 0 }]);
  });

  it("refuses publication after a control request wins the job lock", async () => {
    await ensureEmbeddingSpace(session.database, space384);
    const catalog = new DocumentCatalog(session.database);
    const sourceFile = "/documents/publication-pause.pdf";
    const documentId = "f".repeat(64);
    const uploaderId = "00000000-0000-4000-8000-000000000223";
    await session.database.insert(users).values({
      displayName: "Publication Pause Uploader",
      id: uploaderId,
      state: "active",
      username: "publication-pause-uploader",
      usernameNormalized: "publication-pause-uploader",
    }).onConflictDoNothing();
    await prepareTestIngestion(catalog,
      sourceFile,
      documentId,
      space384.id,
      [],
      false,
      3,
      null,
      uploaderId,
    );
    await claimTestJob(catalog, sourceFile, "discovered");
    const elementSetId = await writeTestElementSet(
      documentId,
      sourceFile,
    );
    const ownerId = await readTestLeaseOwner(catalog, sourceFile);
    await catalog.completeNormalization(sourceFile, ownerId, elementSetId, {
      images: 0,
      pageCount: 1,
      tables: 0,
      textChunks: 1,
      totalElements: 1,
    });
    await writeTestPublicationArtifacts(sourceFile, space384);
    await catalog.completeIndexing(sourceFile, ownerId);
    await expect(catalog.requestIngestionControl(sourceFile, "pause", {
      isAdministrator: true,
      userId: uploaderId,
    })).resolves.toMatchObject({
      job: { controlState: "pause_requested" },
      kind: "accepted",
    });

    await expect(catalog.promoteJob(sourceFile, ownerId))
      .rejects.toThrow("Cannot promote an unclaimed indexed job");
    expect(await catalog.settleOwnedIngestionControl(
      sourceFile,
      ownerId,
    )).toMatchObject({
      controlState: "paused",
      phase: "indexed",
      state: "pending",
    });
  });
});

describe("PostgreSQL artifact storage", () => {
  it("publishes metadata only after staged bytes pass hash verification", async () => {
    const sourceContentStore = new SourceContentStore(
      session.database,
      sourceContentConfig,
    );
    const expectedContent = Buffer.from("expected verified source");
    const stagedContent = Buffer.from("tampered staged source");
    const documentId = createHash("sha256")
      .update(expectedContent)
      .digest("hex");
    const stagedSourceFile = join(
      sourceContentConfig.directory,
      "tampered-source.pdf",
    );
    const publishedSourceFile = join(
      sourceContentConfig.directory,
      "sha256",
      documentId.slice(0, 2),
      documentId,
    );
    await writeFile(stagedSourceFile, stagedContent);

    try {
      await expect(sourceContentStore.publishStagedDocument({
        byteLength: stagedContent.byteLength,
        documentId,
        sourceFile: stagedSourceFile,
      })).rejects.toThrow("hash does not match");
      await expect(access(publishedSourceFile))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(stagedSourceFile, { force: true });
      await rm(publishedSourceFile, { force: true });
    }

    await expect(session.database
      .select({ documentId: sourceDocuments.documentId })
      .from(sourceDocuments)
      .where(eq(sourceDocuments.documentId, documentId)))
      .resolves.toEqual([]);
  });

  it("round trips canonical elements and typed retrieval descriptions", async () => {
    const documentStore = new SourceDocumentStore(session.database);
    const sourceContentStore = new SourceContentStore(
      session.database,
      sourceContentConfig,
    );
    const artifactStore = new IngestionArtifactStore(session.database);
    const content = Buffer.from("%PDF-1.7\nfixture");
    const documentId = createHash("sha256").update(content).digest("hex");
    const sourceFile = "/documents/artifact-table.pdf";
    const table = buildTableElement(documentId, "3".repeat(64), sourceFile);
    const description = buildRetrievalDescriptionRecord(
      table,
      "Complaints by province: Ontario 120, Quebec 85, Alberta 42.",
    );
    const generationId = randomUUID();
    const storedDocument: StoredSourceDocument = {
      content,
      documentId,
    };
    const stagedSourceFile = join(
      sourceContentConfig.directory,
      "artifact-source.pdf",
    );
    await writeFile(stagedSourceFile, content);

    await sourceContentStore.publishStagedDocument({
      byteLength: content.byteLength,
      documentId,
      sourceFile: stagedSourceFile,
    });
    await rm(stagedSourceFile, { force: true });
    await documentStore.writeMany([table]);
    await artifactStore.writeRetrievalDescription(
      generationId,
      documentId,
      0,
      description,
    );

    await expect(sourceContentStore.readDocument(documentId))
      .resolves.toEqual(storedDocument);
    await expect(documentStore.readMany([table.id])).resolves.toEqual([table]);
    await expect(artifactStore.readRetrievalDescriptionCheckpoints(
      generationId,
      0,
      10,
    )).resolves.toEqual([{ description, position: 0 }]);
  });

  it("streams a deterministic element set for a controlled 1,301-page document", async () => {
    const documentStore = new SourceDocumentStore(session.database);
    const documentId = "3".repeat(64);
    const sourceFile = "/documents/controlled-1301-page-report.pdf";
    const elements: SourceElement[] = [];
    for (let pageNumber = 1; pageNumber <= 1_301; pageNumber += 1) {
      elements.push({
        content: `Controlled exact evidence on page ${pageNumber}.`,
        documentId,
        id: pageNumber.toString(16).padStart(64, "0"),
        detectedTypes: ["paragraph"],
        kind: "text",
        ...buildSourceLocation(pageNumber),
        sourceFile,
      });
    }
    for (let start = 0; start < elements.length; start += 73) {
      await documentStore.writeMany(elements.slice(start, start + 73));
    }

    const firstSet = await documentStore.writeElementSet(
      documentId,
      elements,
    );
    const secondSet = await documentStore.writeElementSet(
      documentId,
      elements,
    );

    expect(secondSet.id).toBe(firstSet.id);
    expect(firstSet.elementCount).toBe(1_301);
    const observedIds: string[] = [];
    let position = 0;
    let readCount = 0;
    while (position < firstSet.elementCount) {
      const batch = await documentStore.readElementBatch(
        firstSet.id,
        position,
        127,
        sourceFile,
      );
      expect(batch.elements.length).toBeLessThanOrEqual(127);
      expect(batch.nextPosition).toBe(position + batch.elements.length);
      for (const element of batch.elements) {
        observedIds.push(element.id);
      }
      position = batch.nextPosition;
      readCount += 1;
    }
    expect(readCount).toBe(11);
    expect(observedIds).toEqual(elements.map((element) => element.id));
    await expect(
      documentStore.readElementBatch(firstSet.id, 0, 501),
    ).rejects.toThrow("between 1 and 500");
  });
});

describe("distributed inference capacity", () => {
  it("runs independent providers concurrently", async () => {
    const coordinator = new InferenceCoordinator(session.database);
    const scheduling = buildTestConfig().scheduling;
    scheduling.providers = [
      {
        maximumParallelRequests: 1,
        name: "Accelerator A",
        providerId: "accelerator-a",
      },
      {
        maximumParallelRequests: 1,
        name: "Accelerator B",
        providerId: "accelerator-b",
      },
    ];
    scheduling.targets = {
      answer: { providerId: "accelerator-b" },
      embedding: { providerId: "accelerator-a" },
      reranking: { providerId: "accelerator-b" },
      indexing: { providerId: "accelerator-b" },
    };
    await coordinator.configure(scheduling);
    const firstStarted = createDeferred();
    const firstGate = createDeferred();
    let activeTasks = 0;
    let maximumActiveTasks = 0;

    const firstTask = coordinator.run(
      "accelerator-a",
      "maintenance",
      async () => {
        activeTasks += 1;
        maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks);
        firstStarted.resolve();
        await firstGate.promise;
        activeTasks -= 1;
      },
    );
    await firstStarted.promise;
    const secondTask = coordinator.run(
      "accelerator-b",
      "maintenance",
      async () => {
        activeTasks += 1;
        maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks);
        activeTasks -= 1;
      },
    );

    await secondTask;
    expect(maximumActiveTasks).toBe(2);
    firstGate.resolve();
    await firstTask;
  });

  it("serializes model calls made by separate coordinators", async () => {
    const firstCoordinator = new InferenceCoordinator(session.database);
    const secondCoordinator = new InferenceCoordinator(session.database);
    await firstCoordinator.configure(buildTestConfig().scheduling);
    await secondCoordinator.configure(buildTestConfig().scheduling);
    const firstScheduler = firstCoordinator.createScheduler(
      "lmstudio",
      "maintenance",
      2,
    );
    const secondScheduler = secondCoordinator.createScheduler(
      "lmstudio",
      "maintenance",
      2,
    );
    let activeTasks = 0;
    let maximumActiveTasks = 0;
    let secondStarted = false;
    const firstStarted = createDeferred();
    const firstGate = createDeferred();

    const firstTask = firstScheduler.run(async () => {
      activeTasks += 1;
      maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks);
      firstStarted.resolve();
      await firstGate.promise;
      activeTasks -= 1;
    });
    await firstStarted.promise;
    const secondTask = secondScheduler.run(async () => {
      secondStarted = true;
      activeTasks += 1;
      maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks);
      activeTasks -= 1;
    });

    await wait(150);
    expect(secondStarted).toBe(false);
    firstGate.resolve();
    await Promise.all([firstTask, secondTask]);
    expect(maximumActiveTasks).toBe(1);
  });

  it("rejects a queued request when settings change before admission", async () => {
    const firstCoordinator = new InferenceCoordinator(session.database);
    const secondCoordinator = new InferenceCoordinator(session.database);
    const scheduling = buildTestConfig().scheduling;
    scheduling.settingsVersion = 1;
    await firstCoordinator.configure(scheduling);
    await secondCoordinator.configure(scheduling);
    const firstStarted = createDeferred();
    const firstGate = createDeferred();
    const firstTask = firstCoordinator.run(
      "lmstudio",
      "maintenance",
      async () => {
        firstStarted.resolve();
        await firstGate.promise;
      },
    );
    await firstStarted.promise;
    const queuedTask = secondCoordinator.run(
      "lmstudio",
      "ingestion",
      async () => {
        throw new Error("A stale queued task must not run.");
      },
    );
    await waitForInferenceQueueLength(1);

    await session.database
      .update(applicationSettings)
      .set({ version: 2 })
      .where(eq(applicationSettings.id, "runtime"));
    firstGate.resolve();

    await firstTask;
    await expect(queuedTask).rejects.toThrow(
      "Inference settings changed from version 1 to 2 before the task started",
    );
  });

  it("cancels a task while it is waiting for a shared slot", async () => {
    const firstCoordinator = new InferenceCoordinator(session.database);
    const secondCoordinator = new InferenceCoordinator(session.database);
    await firstCoordinator.configure(buildTestConfig().scheduling);
    await secondCoordinator.configure(buildTestConfig().scheduling);
    const firstStarted = createDeferred();
    const firstGate = createDeferred();
    const firstTask = firstCoordinator.run("lmstudio", "maintenance", async () => {
      firstStarted.resolve();
      await firstGate.promise;
    });
    await firstStarted.promise;

    const controller = new AbortController();
    const secondTask = secondCoordinator.run(
      "lmstudio",
      "maintenance",
      async () => undefined,
      controller.signal,
    );
    controller.abort(new Error("cancel waiting inference"));

    await expect(secondTask).rejects.toThrow("cancel waiting inference");
    firstGate.resolve();
    await firstTask;
  });

  it("admits interactive work before older background work", async () => {
    const blocker = new InferenceCoordinator(
      session.database,
      "10000000-0000-4000-8000-000000000001",
      120_000,
      5,
    );
    const background = new InferenceCoordinator(
      session.database,
      "10000000-0000-4000-8000-000000000002",
      120_000,
      5,
    );
    const interactive = new InferenceCoordinator(
      session.database,
      "10000000-0000-4000-8000-000000000003",
      120_000,
      5,
    );
    const scheduling = buildTestConfig().scheduling;
    scheduling.backgroundProgressIntervalMs = 3_600_000;
    await blocker.configure(scheduling);
    await background.configure(scheduling);
    await interactive.configure(scheduling);
    const blockerStarted = createDeferred();
    const blockerGate = createDeferred();
    const blockerTask = blocker.run("lmstudio", "maintenance", async () => {
      blockerStarted.resolve();
      await blockerGate.promise;
    });
    await blockerStarted.promise;
    const startOrder: string[] = [];
    const backgroundTask = background.run("lmstudio", "ingestion", async () => {
      startOrder.push("background");
    });
    const interactiveTask = interactive.run(
      "lmstudio",
      "interactive-answer",
      async () => {
        startOrder.push("interactive");
      },
    );
    await waitForInferenceQueueLength(2);

    blockerGate.resolve();
    await Promise.all([blockerTask, backgroundTask, interactiveTask]);

    expect(startOrder).toEqual(["interactive", "background"]);
  });

  it("admits due background work under sustained interactive demand", async () => {
    const blocker = new InferenceCoordinator(
      session.database,
      "20000000-0000-4000-8000-000000000001",
      120_000,
      5,
    );
    const background = new InferenceCoordinator(
      session.database,
      "20000000-0000-4000-8000-000000000002",
      120_000,
      5,
    );
    const interactive = new InferenceCoordinator(
      session.database,
      "20000000-0000-4000-8000-000000000003",
      120_000,
      5,
    );
    const scheduling = buildTestConfig().scheduling;
    scheduling.backgroundProgressIntervalMs = 100;
    await blocker.configure(scheduling);
    await background.configure(scheduling);
    await interactive.configure(scheduling);
    const blockerStarted = createDeferred();
    const blockerGate = createDeferred();
    const blockerTask = blocker.run("lmstudio", "maintenance", async () => {
      blockerStarted.resolve();
      await blockerGate.promise;
    });
    await blockerStarted.promise;
    const startOrder: string[] = [];
    const backgroundTask = background.run("lmstudio", "ingestion", async () => {
      startOrder.push("background");
    });
    const interactiveTask = interactive.run(
      "lmstudio",
      "interactive-answer",
      async () => {
        startOrder.push("interactive");
      },
    );
    await waitForInferenceQueueLength(2);
    await wait(125);

    blockerGate.resolve();
    await Promise.all([blockerTask, backgroundTask, interactiveTask]);

    expect(startOrder).toEqual(["background", "interactive"]);
  });

  it("bounds background delay under concurrent shared-provider load", async () => {
    const coordinator = new InferenceCoordinator(
      session.database,
      "25000000-0000-4000-8000-000000000001",
      120_000,
      5,
    );
    const scheduling = buildTestConfig().scheduling;
    scheduling.backgroundProgressIntervalMs = 100;
    await coordinator.configure(scheduling);
    const blockerStarted = createDeferred();
    const blockerGate = createDeferred();
    const blockerTask = coordinator.run("lmstudio", "maintenance", async () => {
      blockerStarted.resolve();
      await blockerGate.promise;
    });
    await blockerStarted.promise;

    let activeTasks = 0;
    let maximumActiveTasks = 0;
    const startOrder: string[] = [];
    const backgroundTasks: Array<Promise<void>> = [];
    for (let index = 0; index < 2; index += 1) {
      backgroundTasks.push(coordinator.run("lmstudio", "ingestion", async () => {
        activeTasks += 1;
        maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks);
        startOrder.push(`background-${index}`);
        await wait(20);
        activeTasks -= 1;
      }));
    }
    const interactiveTasks: Array<Promise<void>> = [];
    for (let index = 0; index < 12; index += 1) {
      interactiveTasks.push(coordinator.run(
        "lmstudio",
        "interactive-answer",
        async () => {
          activeTasks += 1;
          maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks);
          startOrder.push(`interactive-${index}`);
          await wait(20);
          activeTasks -= 1;
        },
      ));
    }
    await waitForInferenceQueueLength(14);
    await wait(125);

    blockerGate.resolve();
    await Promise.all([
      blockerTask,
      ...backgroundTasks,
      ...interactiveTasks,
    ]);

    const backgroundStarts: number[] = [];
    for (let index = 0; index < startOrder.length; index += 1) {
      if (startOrder[index]?.startsWith("background-") === true) {
        backgroundStarts.push(index);
      }
    }
    expect(maximumActiveTasks).toBe(1);
    expect(backgroundStarts).toHaveLength(2);
    expect(backgroundStarts[0]).toBe(0);
    expect(backgroundStarts[1]).toBeLessThan(9);
  });

  it("reclaims expired queue and slot leases after process failure", async () => {
    const coordinator = new InferenceCoordinator(
      session.database,
      "30000000-0000-4000-8000-000000000001",
      120_000,
      5,
    );
    await coordinator.configure(buildTestConfig().scheduling);
    const expiredAt = new Date(Date.now() - 1_000);
    await session.database
      .update(inferenceSlots)
      .set({
        leaseExpiresAt: expiredAt,
        ownerId: "30000000-0000-4000-8000-000000000002",
      })
      .where(eq(inferenceSlots.resourceGroup, "lmstudio"));
    await session.database.insert(inferenceQueue).values({
      expiresAt: expiredAt,
      id: "30000000-0000-4000-8000-000000000003",
      ownerId: "30000000-0000-4000-8000-000000000002",
      queuedAt: new Date(expiredAt.getTime() - 1_000),
      resourceGroup: "lmstudio",
      workload: "offline-tool",
    });

    await expect(
      coordinator.run("lmstudio", "interactive-search", async () => "recovered"),
    ).resolves.toBe("recovered");

    const queuedRows = await session.database.select().from(inferenceQueue);
    expect(queuedRows).toEqual([]);
    const slotRows = await session.database
      .select()
      .from(inferenceSlots)
      .where(eq(inferenceSlots.resourceGroup, "lmstudio"));
    const firstSlot = slotRows.find((row) => row.slotNumber === 1);
    expect(firstSlot).toMatchObject({ leaseExpiresAt: null, ownerId: null });
  });
});

describe("pgvector retrieval", () => {
  it("rejects policy reuse and mismatched retrieval windows", async () => {
    await ensureEmbeddingSpace(session.database, space768);
    const structuredPolicy = createRetrievalWindowPolicyContract(
      createRetrievalWindowPolicy("structured-token-v3", 512, 4_096),
    );
    const conflictingSpace: EmbeddingSpaceConfig = {
      ...space768,
      retrievalWindow: structuredPolicy,
    };
    await expect(ensureEmbeddingSpace(
      session.database,
      conflictingSpace,
    )).rejects.toThrow("different settings");

    const structuredSpace: EmbeddingSpaceConfig = {
      ...conflictingSpace,
      id: "test-embedding:plain:768:structured",
    };
    await ensureEmbeddingSpace(session.database, structuredSpace);
    const element = buildTextElement("1".repeat(64), "2".repeat(64));
    const windows = createRetrievalWindows([element], {
      embeddingInputFormat: space768.inputFormat,
      policy: space768.retrievalWindow,
    });
    const representations = createRetrievalRepresentations(
      [element],
      [],
      windows,
      space768.retrievalWindow,
    );
    const embeddings = representations.map((_, index) => {
      return buildEmbedding(768, index + 1);
    });
    const generationInput = {
      documentId: element.documentId,
      elementSetId: "3".repeat(64),
      generationId: randomUUID(),
      totalElements: 1,
    };
    await expect(stageRetrievalRepresentationBatch(
      session.database,
      structuredSpace,
      generationInput,
      0,
      1,
      representations,
      embeddings,
    )).rejects.toThrow("incompatible with embedding space");
  });

  it("hydrates every active exact-evidence alias and excludes prior versions", async () => {
    const space: EmbeddingSpaceConfig = {
      ...space768,
      id: `${space768.id}:evidence-aliases`,
    };
    await ensureEmbeddingSpace(session.database, space);
    const documentId = "a".repeat(64);
    const elementId = "b".repeat(64);
    const firstSourceFile = "/documents/evidence-alias-primary.pdf";
    const secondSourceFile = "/documents/evidence-alias-secondary.pdf";
    const baseElement = buildTextElement(documentId, elementId);
    baseElement.sourceFile = firstSourceFile;
    baseElement.content = "Exact evidence alias marker.";
    const documentStore = new SourceDocumentStore(session.database);
    await ensureTestSourceMetadata(documentId);
    await documentStore.writeMany([baseElement]);
    const elementSet = await documentStore.writeElementSet(
      documentId,
      [baseElement],
    );
    const priorGenerationId = randomUUID();
    const firstGenerationId = randomUUID();
    const secondGenerationId = randomUUID();
    const priorVersionId = "00000000-0000-4000-8000-000000000411";
    const firstVersionId = "00000000-0000-4000-8000-000000000412";
    const secondVersionId = "00000000-0000-4000-8000-000000000413";
    await session.database.insert(documentVersions).values([
      {
        ...buildTestDocumentFormatRow(firstSourceFile),
        documentId,
        elementSetId: elementSet.id,
        generationId: priorGenerationId,
        id: priorVersionId,
        images: 0,
        pageCount: 1,
        sourceFile: firstSourceFile,
        tables: 0,
        textChunks: 1,
        totalElements: 1,
        version: 1,
      },
      {
        ...buildTestDocumentFormatRow(firstSourceFile),
        documentId,
        elementSetId: elementSet.id,
        generationId: firstGenerationId,
        id: firstVersionId,
        images: 0,
        pageCount: 1,
        sourceFile: firstSourceFile,
        tables: 0,
        textChunks: 1,
        totalElements: 1,
        version: 2,
      },
      {
        ...buildTestDocumentFormatRow(secondSourceFile),
        documentId,
        elementSetId: elementSet.id,
        generationId: secondGenerationId,
        id: secondVersionId,
        images: 0,
        pageCount: 1,
        sourceFile: secondSourceFile,
        tables: 0,
        textChunks: 1,
        totalElements: 1,
        version: 1,
      },
    ]);
    await session.database.insert(indexedDocuments).values([
      {
        documentId,
        elementSetId: elementSet.id,
        generationId: firstGenerationId,
        images: 0,
        pageCount: 1,
        sourceFile: firstSourceFile,
        tables: 0,
        tags: [],
        textChunks: 1,
        totalElements: 1,
        versionId: firstVersionId,
      },
      {
        documentId,
        elementSetId: elementSet.id,
        generationId: secondGenerationId,
        images: 0,
        pageCount: 1,
        sourceFile: secondSourceFile,
        tables: 0,
        tags: [],
        textChunks: 1,
        totalElements: 1,
        versionId: secondVersionId,
      },
    ]);
    const stageAlias = async (
      sourceFile: string,
      generationId: string,
    ): Promise<void> => {
      const element = { ...baseElement, sourceFile };
      const representations = buildTestRepresentations([element], [], space);
      await withOpenTestRetrievalGeneration(session.database, {
        documentId,
        elementSetId: elementSet.id,
        generationId,
        sourceFile,
        space,
        totalElements: 1,
      }, async () => {
        await stageRetrievalRepresentationBatch(
          session.database,
          space,
          {
            documentId,
            elementSetId: elementSet.id,
            generationId,
            totalElements: 1,
          },
          0,
          1,
          representations,
          representations.map(() => buildEmbedding(space.dimensions, 1)),
        );
      });
    };
    await stageAlias(firstSourceFile, priorGenerationId);
    await stageAlias(firstSourceFile, firstGenerationId);
    await stageAlias(secondSourceFile, secondGenerationId);
    for (const target of [
      { generationId: firstGenerationId, sourceFile: firstSourceFile },
      { generationId: secondGenerationId, sourceFile: secondSourceFile },
    ]) {
      await session.database.transaction(async (transaction) => {
        await synchronizeActiveRetrievalProjection(transaction, {
          documentId,
          elementSetId: elementSet.id,
          embeddingSpaceId: space.id,
          generationId: target.generationId,
          indexedAt: new Date("2026-08-06T00:00:00.000Z"),
          sourceFile: target.sourceFile,
          totalElements: 1,
        });
      });
    }
    const scopeTargets = [
      {
        documentId,
        generationId: firstGenerationId,
        sourceFile: firstSourceFile,
      },
      {
        documentId,
        generationId: secondGenerationId,
        sourceFile: secondSourceFile,
      },
    ];
    const rankings = await queryRetrievalCandidateRankings(
      session.database,
      session.query,
      space,
      [{
        embedding: buildEmbedding(space.dimensions, 1),
        text: "evidence alias marker",
      }],
      {
        answerTemperature: 0,
        candidateK: 1,
        chatTemperature: 0,
        fusion: { ...EQUAL_WEIGHT_FUSION_CONFIG },
        mode: "dense",
        queryExpansions: 0,
        queryExpansionTemperature: 0,
        reranker: null,
        rrfK: 60,
        topK: 1,
      },
      scopeTargets,
      new AbortController().signal,
    );
    const candidates = rankRetrievalCandidates(
      "dense",
      rankings,
      60,
      EQUAL_WEIGHT_FUSION_CONFIG,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceAliases).toHaveLength(1);

    const retrieved = await loadRetrievalCandidates(
      session.database,
      documentStore,
      space,
      candidates,
      scopeTargets,
    );

    expect(retrieved).toHaveLength(1);
    expect(retrieved[0]?.provenance.sourceAliases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentVersionId: firstVersionId }),
        expect.objectContaining({ documentVersionId: secondVersionId }),
      ]),
    );
    expect(retrieved[0]?.provenance.sourceAliases).toHaveLength(2);
    expect(retrieved[0]?.provenance.sourceAliases).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ documentVersionId: priorVersionId }),
      ]),
    );
  });

  it("matches exact dense and lexical top-k across a broad filtered scope", async () => {
    const space: EmbeddingSpaceConfig = {
      ...space768,
      id: `${space768.id}:broad-quality`,
    };
    await ensureEmbeddingSpace(session.database, space);
    const scopeTargets: ResolvedQueryScopeTarget[] = [];
    for (let index = 0; index < 30; index += 1) {
      const documentId = (index + 1_000).toString(16).padStart(64, "0");
      const elementId = (index + 2_000).toString(16).padStart(64, "0");
      const element = buildTextElement(documentId, elementId);
      const outsideScope = index < 6;
      element.content = outsideScope
        ? "broadscopemarker ".repeat(8).trim()
        : `broadscopemarker scoped evidence ${index}`;
      const embedding = buildEmbedding(space.dimensions, 1);
      if (!outsideScope) {
        embedding[1] = (index - 5) / 100;
      }
      const generationId = randomUUID();
      const elementSetId = await writeTestElementSet(
        documentId,
        element.sourceFile,
        [elementId],
      );
      const versionId = randomUUID();
      await session.database.insert(documentVersions).values({
        ...buildTestDocumentFormatRow(element.sourceFile),
        documentId,
        elementSetId,
        generationId,
        id: versionId,
        images: 0,
        pageCount: 1,
        sourceFile: element.sourceFile,
        tables: 0,
        textChunks: 1,
        totalElements: 1,
        version: 1,
      });
      await session.database.insert(indexedDocuments).values({
        documentId,
        elementSetId,
        generationId,
        images: 0,
        pageCount: 1,
        sourceFile: element.sourceFile,
        tables: 0,
        tags: [],
        textChunks: 1,
        totalElements: 1,
        versionId,
      });
      await indexTestElements(
        session.database,
        space,
        documentId,
        generationId,
        [],
        [embedding],
        [element],
      );
      if (!outsideScope) {
        scopeTargets.push({
          documentId,
          generationId,
          sourceFile: element.sourceFile,
        });
      }
    }
    const queryEmbedding = buildEmbedding(space.dimensions, 1);
    const candidateK = 5;
    const rankings = await queryRetrievalCandidateRankings(
      session.database,
      session.query,
      space,
      [{ embedding: queryEmbedding, text: "broadscopemarker" }],
      {
        answerTemperature: 0,
        candidateK,
        chatTemperature: 0,
        fusion: { ...EQUAL_WEIGHT_FUSION_CONFIG },
        mode: "hybrid",
        queryExpansions: 0,
        queryExpansionTemperature: 0,
        reranker: null,
        rrfK: 60,
        topK: candidateK,
      },
      scopeTargets,
      new AbortController().signal,
    );
    const scopeDocumentIds = scopeTargets.map((target) => target.documentId);
    const denseDistance = cosineDistance(
      retrievalChunks768.embedding,
      queryEmbedding,
    );
    const exactDense = await session.database
      .select({ id: retrievalChunks768.id })
      .from(retrievalChunks768)
      .where(and(
        eq(retrievalChunks768.embeddingSpaceId, space.id),
        inArray(retrievalChunks768.documentId, scopeDocumentIds),
      ))
      .orderBy(denseDistance, asc(retrievalChunks768.id))
      .limit(candidateK);
    const exactLexical = await session.query.execute(
      "retrieve-lexical-candidates",
      [
        "broadscopemarker",
        space.id,
        scopeTargets.map((target) => target.documentId),
        scopeTargets.map((target) => target.generationId),
        scopeTargets.map((target) => target.sourceFile),
        candidateK,
      ],
    );
    expect(rankings.dense[0]?.map((candidate) => candidate.representation.id))
      .toEqual(exactDense.map((row) => row.id));
    expect(rankings.lexical[0]?.map((candidate) => candidate.representation.id))
      .toEqual(readTestRepresentationIds(exactLexical));
    expect(rankings.dense[0]).toHaveLength(candidateK);
    expect(rankings.lexical[0]).toHaveLength(candidateK);
  });

  it("keeps dense keys and projection hydration on one publication snapshot", async () => {
    const space: EmbeddingSpaceConfig = {
      ...space768,
      id: `${space768.id}:snapshot-consistency`,
    };
    await ensureEmbeddingSpace(session.database, space);
    const documentId = "d".repeat(64);
    const element = buildTextElement(documentId, "e".repeat(64));
    element.content = "snapshot consistency evidence";
    const generationId = randomUUID();
    const elementSetId = await writeTestElementSet(
      documentId,
      element.sourceFile,
      [element.id],
    );
    const versionId = randomUUID();
    await session.database.insert(documentVersions).values({
      ...buildTestDocumentFormatRow(element.sourceFile),
      documentId,
      elementSetId,
      generationId,
      id: versionId,
      images: 0,
      pageCount: 1,
      sourceFile: element.sourceFile,
      tables: 0,
      textChunks: 1,
      totalElements: 1,
      version: 1,
    });
    await session.database.insert(indexedDocuments).values({
      documentId,
      elementSetId,
      generationId,
      images: 0,
      pageCount: 1,
      sourceFile: element.sourceFile,
      tables: 0,
      tags: [],
      textChunks: 1,
      totalElements: 1,
      versionId,
    });
    await indexTestElements(
      session.database,
      space,
      documentId,
      generationId,
      [],
      [buildEmbedding(space.dimensions, 1)],
      [element],
    );
    const blockerSession = await openDatabase({ poolMax: 1, url: databaseUrl });
    const publisherSession = await openDatabase({ poolMax: 1, url: databaseUrl });
    const blockerWithDatabase = blockerSession.query.withDatabase;
    const publisherWithDatabase = publisherSession.query.withDatabase;
    if (
      blockerWithDatabase === undefined
      || publisherWithDatabase === undefined
    ) {
      throw new Error("The PostgreSQL query executor cannot run database operations.");
    }
    const blockerAcquired = createDeferred<void>();
    const releaseBlocker = createDeferred<void>();
    const blocker = blockerWithDatabase(async (database) => {
      await database.transaction(async (transaction) => {
        await transaction.execute(sql`
          LOCK TABLE "active_retrieval_routes" IN ACCESS EXCLUSIVE MODE
        `);
        blockerAcquired.resolve();
        await releaseBlocker.promise;
      });
    });
    await blockerAcquired.promise;
    const publication = publisherWithDatabase(async (database) => {
      await database
        .delete(indexedDocumentSpaces)
        .where(and(
          eq(indexedDocumentSpaces.sourceFile, element.sourceFile),
          eq(indexedDocumentSpaces.embeddingSpaceId, space.id),
        ));
    });
    try {
      await waitForTableLockWaiters("active_retrieval_routes", 1);
      const retrieval = queryRetrievalCandidateRankings(
        session.database,
        session.query,
        space,
        [{
          embedding: buildEmbedding(space.dimensions, 1),
          text: "snapshot consistency",
        }],
        {
          answerTemperature: 0,
          candidateK: 1,
          chatTemperature: 0,
          fusion: { ...EQUAL_WEIGHT_FUSION_CONFIG },
          mode: "dense",
          queryExpansions: 0,
          queryExpansionTemperature: 0,
          reranker: null,
          rrfK: 60,
          topK: 1,
        },
        [{ documentId, generationId, sourceFile: element.sourceFile }],
        new AbortController().signal,
      );
      await waitForTableLockWaiters("active_retrieval_routes", 2);
      releaseBlocker.resolve();
      await expect(publication).resolves.toBeUndefined();
      await expect(retrieval).resolves.toMatchObject({
        dense: [[{
          documentId,
          evidenceContent: element.content,
          sourceFile: element.sourceFile,
        }]],
      });
    } finally {
      releaseBlocker.resolve();
      await Promise.allSettled([blocker, publication]);
      await Promise.all([blockerSession.close(), publisherSession.close()]);
    }
  });

  it("rejects stale publication identities and accepts an exhausted scope", async () => {
    const space: EmbeddingSpaceConfig = {
      ...space768,
      id: `${space768.id}:stale-scope`,
    };
    await ensureEmbeddingSpace(session.database, space);
    const documentId = "c".repeat(64);
    const element = buildTextElement(documentId, "f".repeat(64));
    const generationId = randomUUID();
    await indexTestElements(
      session.database,
      space,
      documentId,
      generationId,
      [],
      [buildEmbedding(space.dimensions, 1)],
      [element],
    );
    await session.database
      .delete(indexedDocumentSpaces)
      .where(and(
        eq(indexedDocumentSpaces.sourceFile, element.sourceFile),
        eq(indexedDocumentSpaces.embeddingSpaceId, space.id),
      ));
    const query = [{
      embedding: buildEmbedding(space.dimensions, 1),
      text: "stale scope",
    }];
    const config = {
      answerTemperature: 0,
      candidateK: 1,
      chatTemperature: 0,
      fusion: { ...EQUAL_WEIGHT_FUSION_CONFIG },
      mode: "hybrid" as const,
      queryExpansions: 0,
      queryExpansionTemperature: 0,
      reranker: null,
      rrfK: 60,
      topK: 1,
    };
    await expect(queryRetrievalCandidateRankings(
      session.database,
      session.query,
      space,
      query,
      config,
      [{ documentId, generationId, sourceFile: element.sourceFile }],
      new AbortController().signal,
    )).rejects.toBeInstanceOf(RetrievalScopeChangedError);
    await expect(queryRetrievalCandidateRankings(
      session.database,
      session.query,
      space,
      query,
      config,
      [],
      new AbortController().signal,
    )).resolves.toEqual({ dense: [[]], lexical: [[]] });
  });

  it("uses specialized top-k indexes at representative projection cardinality", async () => {
    const space: EmbeddingSpaceConfig = {
      ...space384,
      id: `${space384.id}:scaled-plan`,
    };
    await ensureEmbeddingSpace(session.database, space);
    const documentId = "7".repeat(64);
    const generationId = randomUUID();
    const sourceFile = "/documents/scaled-plan.pdf";
    const representationCount = 36_970;
    const firstRepresentationId = "1".padStart(64, "0");
    await session.database.insert(indexedDocumentSpaces).values({
      documentId,
      embeddingSpaceId: space.id,
      generationId,
      representationCount,
      sourceFile,
    });
    await session.database.transaction(async (transaction) => {
      await transaction.execute(sql`
        INSERT INTO "active_retrieval_chunks_384" (
          "document_id", "embedding_space_id", "generation_id",
          "representation_id", "source_file", "embedding"
        )
        SELECT
          ${documentId}, ${space.id}, ${generationId},
          lpad(to_hex("value"), 64, '0'), ${sourceFile},
          (
            ARRAY[1::real, "value"::real / ${representationCount}::real]
            || array_fill(0::real, ARRAY[382])
          )::vector
        FROM generate_series(1, ${representationCount}) AS "value"
      `);
      await transaction.execute(sql`
        INSERT INTO "active_retrieval_lexical_chunks" (
          "content", "document_id", "embedding_space_id", "generation_id",
          "representation_id", "source_file"
        )
        SELECT
          CASE
            WHEN "value" <= 50
              THEN repeat('scaledplanmarker ', 51 - "value"::integer)
            ELSE 'unrelated corpus text '
          END || "value", ${documentId}, ${space.id},
          ${generationId}, lpad(to_hex("value"), 64, '0'), ${sourceFile}
        FROM generate_series(1, ${representationCount}) AS "value"
      `);
      await transaction.execute(sql`
        INSERT INTO "active_retrieval_routes" (
          "document_id", "embedding_space_id", "generation_id",
          "representation_id", "source_file", "evidence_id",
          "evidence_mode", "kind", "parent_id", "representation_content",
          "representation_type"
        )
        SELECT
          ${documentId}, ${space.id}, ${generationId},
          lpad(to_hex("value"), 64, '0'), ${sourceFile},
          lpad(to_hex("value"), 64, '0'), 'direct', 'text',
          lpad(to_hex("value"), 64, '0'),
          'scaled plan evidence ' || "value", 'exact-window'
        FROM generate_series(1, ${representationCount}) AS "value"
      `);
      await transaction.execute(sql`
        INSERT INTO "active_retrieval_evidence" (
          "document_id", "embedding_space_id", "evidence_content",
          "evidence_id", "generation_id", "kind", "parent_id", "source_file"
        )
        SELECT
          ${documentId}, ${space.id}, 'scaled plan evidence ' || "value",
          lpad(to_hex("value"), 64, '0'), ${generationId}, 'text',
          lpad(to_hex("value"), 64, '0'), ${sourceFile}
        FROM generate_series(1, ${representationCount}) AS "value"
      `);
      await transaction.execute(sql`ANALYZE "active_retrieval_chunks_384"`);
      await transaction.execute(sql`ANALYZE "active_retrieval_lexical_chunks"`);
    });

    await session.database.transaction(async (transaction) => {
      await transaction.execute(sql`SET LOCAL enable_indexscan = on`);
      const rows = await queryDenseEvidenceCandidates(
        transaction as unknown as CiteLoomDatabase,
        space,
        buildEmbedding(space.dimensions, 1),
        [{ documentId, generationId, sourceFile }],
        [firstRepresentationId],
      );
      expect(rows).toHaveLength(1);
      const settingResult = await transaction.execute(sql<{ value: string }>`
        SELECT current_setting('enable_indexscan') AS "value"
      `);
      expect(settingResult.rows).toEqual([{ value: "on" }]);
    });

    await expectIndexedTopKPlans(space, {
      forcePlanner: false,
      lexicalQuery: "scaledplanmarker",
    });
  }, 30_000);

  it("indexes identical structured windows and text across every dimension", async () => {
    const policy = createRetrievalWindowPolicyContract(
      createRetrievalWindowPolicy("structured-token-v3", 64, 2_048),
    );
    const element = buildTextElement("4".repeat(64), "5".repeat(64));
    element.content = [
      "Safety records list one, two, and three.",
      "x".repeat(700),
      "Final evidence remains in the same canonical parent.",
    ].join("\n\n");
    element.sectionPath = ["Policy", "A section path counted in the input"];
    const windows = createRetrievalWindows(
      [element],
      {
        embeddingInputFormat: TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
        policy,
      },
    );
    const representations = createRetrievalRepresentations(
      [element],
      [],
      windows,
      policy,
    );
    expect(windows.length).toBeGreaterThan(1);
    const expectedContent = new Map<string, {
      content: string;
      evidence: string;
      nextRetrievalId: string | null;
      previousRetrievalId: string | null;
    }>();
    for (const representation of representations) {
      expectedContent.set(representation.id, {
        content: representation.embeddingText,
        evidence: representation.content,
        nextRetrievalId: representation.nextRetrievalId,
        previousRetrievalId: representation.previousRetrievalId,
      });
    }

    for (const baseSpace of [
      space384,
      space768,
      space1024,
      space1536,
      space2048,
    ]) {
      const space: EmbeddingSpaceConfig = {
        ...baseSpace,
        id: `${baseSpace.id}:structured-${policy.fingerprint.slice(0, 16)}`,
        retrievalWindow: policy,
      };
      await ensureEmbeddingSpace(session.database, space);
      const embeddings = representations.map((_, index) => {
        return buildEmbedding(space.dimensions, index + 1);
      });
      const generationId = randomUUID();
      await stageTestRetrievalRepresentations(
        session.database,
        space,
        element.documentId,
        generationId,
        representations,
        embeddings,
      );

      let vectorRows: Array<{
        evidenceContent: string;
        id: string;
        nextRetrievalId: string | null;
        previousRetrievalId: string | null;
      }>;
      let descriptionVectorRows: Array<{ id: string }>;
      if (space.dimensions === 384) {
        vectorRows = await session.database
          .select({
            evidenceContent: retrievalChunks384.evidenceContent,
            id: retrievalChunks384.id,
            nextRetrievalId: retrievalChunks384.nextRetrievalId,
            previousRetrievalId: retrievalChunks384.previousRetrievalId,
          })
          .from(retrievalChunks384)
          .where(and(
            eq(retrievalChunks384.embeddingSpaceId, space.id),
            eq(retrievalChunks384.representationType, "exact-window"),
          ));
        descriptionVectorRows = await session.database
          .select({ id: retrievalChunks384.id })
          .from(retrievalChunks384)
          .where(and(
            eq(retrievalChunks384.embeddingSpaceId, space.id),
            ne(retrievalChunks384.representationType, "exact-window"),
          ));
      } else if (space.dimensions === 768) {
        vectorRows = await session.database
          .select({
            evidenceContent: retrievalChunks768.evidenceContent,
            id: retrievalChunks768.id,
            nextRetrievalId: retrievalChunks768.nextRetrievalId,
            previousRetrievalId: retrievalChunks768.previousRetrievalId,
          })
          .from(retrievalChunks768)
          .where(and(
            eq(retrievalChunks768.embeddingSpaceId, space.id),
            eq(retrievalChunks768.representationType, "exact-window"),
          ));
        descriptionVectorRows = await session.database
          .select({ id: retrievalChunks768.id })
          .from(retrievalChunks768)
          .where(and(
            eq(retrievalChunks768.embeddingSpaceId, space.id),
            ne(retrievalChunks768.representationType, "exact-window"),
          ));
      } else if (space.dimensions === 1024) {
        vectorRows = await session.database
          .select({
            evidenceContent: retrievalChunks1024.evidenceContent,
            id: retrievalChunks1024.id,
            nextRetrievalId: retrievalChunks1024.nextRetrievalId,
            previousRetrievalId: retrievalChunks1024.previousRetrievalId,
          })
          .from(retrievalChunks1024)
          .where(and(
            eq(retrievalChunks1024.embeddingSpaceId, space.id),
            eq(retrievalChunks1024.representationType, "exact-window"),
          ));
        descriptionVectorRows = await session.database
          .select({ id: retrievalChunks1024.id })
          .from(retrievalChunks1024)
          .where(and(
            eq(retrievalChunks1024.embeddingSpaceId, space.id),
            ne(retrievalChunks1024.representationType, "exact-window"),
          ));
      } else if (space.dimensions === 1536) {
        vectorRows = await session.database
          .select({
            evidenceContent: retrievalChunks1536.evidenceContent,
            id: retrievalChunks1536.id,
            nextRetrievalId: retrievalChunks1536.nextRetrievalId,
            previousRetrievalId: retrievalChunks1536.previousRetrievalId,
          })
          .from(retrievalChunks1536)
          .where(and(
            eq(retrievalChunks1536.embeddingSpaceId, space.id),
            eq(retrievalChunks1536.representationType, "exact-window"),
          ));
        descriptionVectorRows = await session.database
          .select({ id: retrievalChunks1536.id })
          .from(retrievalChunks1536)
          .where(and(
            eq(retrievalChunks1536.embeddingSpaceId, space.id),
            ne(retrievalChunks1536.representationType, "exact-window"),
          ));
      } else {
        vectorRows = await session.database
          .select({
            evidenceContent: retrievalChunks2048.evidenceContent,
            id: retrievalChunks2048.id,
            nextRetrievalId: retrievalChunks2048.nextRetrievalId,
            previousRetrievalId: retrievalChunks2048.previousRetrievalId,
          })
          .from(retrievalChunks2048)
          .where(and(
            eq(retrievalChunks2048.embeddingSpaceId, space.id),
            eq(retrievalChunks2048.representationType, "exact-window"),
          ));
        descriptionVectorRows = await session.database
          .select({ id: retrievalChunks2048.id })
          .from(retrievalChunks2048)
          .where(and(
            eq(retrievalChunks2048.embeddingSpaceId, space.id),
            ne(retrievalChunks2048.representationType, "exact-window"),
          ));
      }
      const lexicalRows = await session.database
        .select({
          content: retrievalLexicalChunks.content,
          evidenceContent: retrievalLexicalChunks.evidenceContent,
          id: retrievalLexicalChunks.id,
          nextRetrievalId: retrievalLexicalChunks.nextRetrievalId,
          previousRetrievalId: retrievalLexicalChunks.previousRetrievalId,
        })
        .from(retrievalLexicalChunks)
        .where(and(
          eq(retrievalLexicalChunks.embeddingSpaceId, space.id),
          eq(retrievalLexicalChunks.representationType, "exact-window"),
        ));
      const descriptionLexicalRows = await session.database
        .select({ id: retrievalLexicalChunks.id })
        .from(retrievalLexicalChunks)
        .where(and(
          eq(retrievalLexicalChunks.embeddingSpaceId, space.id),
          ne(retrievalLexicalChunks.representationType, "exact-window"),
        ));

      expect(vectorRows).toHaveLength(windows.length);
      expect(lexicalRows).toHaveLength(windows.length);
      expect(descriptionVectorRows).toEqual([]);
      expect(descriptionLexicalRows).toEqual([]);
      for (const vectorRow of vectorRows) {
        expect(vectorRow).toMatchObject({
          evidenceContent: expectedContent.get(vectorRow.id)?.evidence,
          nextRetrievalId:
            expectedContent.get(vectorRow.id)?.nextRetrievalId,
          previousRetrievalId:
            expectedContent.get(vectorRow.id)?.previousRetrievalId,
        });
      }
      for (const lexicalRow of lexicalRows) {
        expect(lexicalRow).toEqual({
          content: expectedContent.get(lexicalRow.id)?.content,
          evidenceContent: expectedContent.get(lexicalRow.id)?.evidence,
          id: lexicalRow.id,
          nextRetrievalId:
            expectedContent.get(lexicalRow.id)?.nextRetrievalId,
          previousRetrievalId:
            expectedContent.get(lexicalRow.id)?.previousRetrievalId,
        });
      }
    }
  });

  it("orders dense and lexical score ties by retrieval-window identity before limits", async () => {
    const documentIds = [
      "a".repeat(64),
      "b".repeat(64),
      "c".repeat(64),
    ];
    const sourceFiles = [
      "/documents/tie-a.pdf",
      "/documents/tie-b.pdf",
      "/documents/tie-c.pdf",
    ];
    const versionIds = [
      "00000000-0000-4000-8000-000000000301",
      "00000000-0000-4000-8000-000000000302",
      "00000000-0000-4000-8000-000000000303",
    ];
    const generationIds = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    const elementSetIds: string[] = [];
    for (let index = 0; index < documentIds.length; index += 1) {
      const documentId = documentIds[index];
      const sourceFile = sourceFiles[index];
      const versionId = versionIds[index];
      const generationId = generationIds[index];
      if (
        documentId === undefined
        || sourceFile === undefined
        || versionId === undefined
        || generationId === undefined
      ) {
        throw new Error(`Incomplete structural tie document at index ${index}.`);
      }
      const elementSetId = await writeTestElementSet(
        documentId,
        sourceFile,
      );
      elementSetIds.push(elementSetId);
      await session.database.insert(documentVersions).values({
        ...buildTestDocumentFormatRow(sourceFile),
        documentId,
        elementSetId,
        generationId,
        id: versionId,
        images: 0,
        pageCount: 1,
        sourceFile,
        tables: 0,
        textChunks: 1,
        totalElements: 1,
        version: 1,
      });
      await session.database.insert(indexedDocuments).values({
        documentId,
        elementSetId,
        generationId,
        images: 0,
        pageCount: 1,
        sourceFile,
        tables: 0,
        tags: [],
        textChunks: 1,
        totalElements: 1,
        versionId,
      });
    }

    const spaces = [space384, space768, space1024, space1536, space2048];
    const observedRankings: Array<{
      dense: string[];
      dimensions: number;
      fused: string[];
      lexical: string[];
    }> = [];
    for (const space of spaces) {
      await session.database
        .insert(embeddingSpaces)
        .values(buildEmbeddingSpaceRow(space));
      await ensureActiveRetrievalSpacePartitions(
        session.database,
        space,
      );
      const retrievalGenerationIds = documentIds.map(() => randomUUID());
      for (let index = 0; index < documentIds.length; index += 1) {
        const documentId = documentIds[index];
        const sourceFile = sourceFiles[index];
        const elementSetId = elementSetIds[index];
        const generationId = retrievalGenerationIds[index];
        if (
          documentId === undefined
          || elementSetId === undefined
          || sourceFile === undefined
          || generationId === undefined
        ) {
          throw new Error(
            `Incomplete structural tie space at index ${index}.`,
          );
        }
        await session.database.insert(ingestionJobs).values({
          documentId,
          elementSetId,
          embeddingSpaceId: space.id,
          fileExtension: ".pdf",
          generationId,
          indexingActivity: "embedding",
          mediaType: "application/pdf",
          phase: "normalized",
          sourceFile,
          state: "pending",
          textChunks: 1,
          totalElements: 1,
        });
        await beginEmbeddingGeneration(session.database, space, {
          documentId,
          elementSetId,
          generationId,
          totalElements: 1,
        });
      }
      const vectorRows = buildStructuralTieVectorRows(
        space,
        documentIds,
        retrievalGenerationIds,
        sourceFiles,
      );
      if (space.dimensions === 384) {
        await session.database.insert(retrievalChunks384).values(vectorRows);
      } else if (space.dimensions === 768) {
        await session.database.insert(retrievalChunks768).values(vectorRows);
      } else if (space.dimensions === 1024) {
        await session.database.insert(retrievalChunks1024).values(vectorRows);
      } else if (space.dimensions === 1536) {
        await session.database.insert(retrievalChunks1536).values(vectorRows);
      } else {
        await session.database.insert(retrievalChunks2048).values(vectorRows);
      }
      const lexicalRows = vectorRows.map((row) => ({
        documentId: row.documentId,
        embeddingSpaceId: row.embeddingSpaceId,
        evidenceContent: row.evidenceContent,
        generationId: row.generationId,
        id: row.id,
        kind: row.kind,
        pageNumber: row.pageNumber,
        parentId: row.parentId,
        representationType: row.representationType,
        sourceFile: row.sourceFile,
        content: "deterministicfixturetoken",
      }));
      await session.database.insert(retrievalLexicalChunks).values(lexicalRows);
      for (let index = 0; index < documentIds.length; index += 1) {
        const documentId = documentIds[index];
        const generationId = retrievalGenerationIds[index];
        const sourceFile = sourceFiles[index];
        if (
          documentId === undefined
          || generationId === undefined
          || sourceFile === undefined
        ) {
          throw new Error(
            `Incomplete structural projection at index ${index}.`,
          );
        }
        await session.database.transaction(async (transaction) => {
          await synchronizeActiveRetrievalProjection(transaction, {
            documentId,
            elementSetId: randomUUID(),
            embeddingSpaceId: space.id,
            generationId,
            indexedAt: new Date("2026-01-01T00:00:00.000Z"),
            sourceFile,
            totalElements: 1,
          });
        });
      }
      await expectIndexedTopKPlans(space);

      const rankings = await queryRetrievalCandidateRankings(
        session.database,
        session.query,
        space,
        [{
          embedding: buildEmbedding(space.dimensions, 1),
          text: "deterministicfixturetoken",
        }],
        {
          answerTemperature: 0,
          candidateK: 5,
          chatTemperature: 0,
          fusion: { ...EQUAL_WEIGHT_FUSION_CONFIG },
          mode: "hybrid",
          queryExpansions: 0,
          queryExpansionTemperature: 0,
          reranker: null,
          rrfK: 60,
          topK: 5,
        },
        buildResolvedScopeTargets(
          documentIds,
          retrievalGenerationIds,
          sourceFiles,
        ),
        new AbortController().signal,
      );
      const dense = rankings.dense[0];
      const lexical = rankings.lexical[0];
      if (dense === undefined || lexical === undefined) {
        throw new Error(`Missing structural tie rankings for ${space.dimensions} dimensions.`);
      }
      const fused = rankRetrievalCandidates(
        "hybrid",
        rankings,
        60,
        EQUAL_WEIGHT_FUSION_CONFIG,
      );
      observedRankings.push({
        dense: dense.map((candidate) => candidate.evidenceRetrievalId),
        dimensions: space.dimensions,
        fused: fused.map((candidate) => candidate.retrievalId),
        lexical: lexical.map((candidate) => candidate.evidenceRetrievalId),
      });
      await session.database
        .delete(ingestionJobs)
        .where(inArray(ingestionJobs.generationId, retrievalGenerationIds));
    }

    const expectedDense = [
      createStructuralTieRetrievalId(9),
      createStructuralTieRetrievalId(10),
      createStructuralTieRetrievalId(3),
      createStructuralTieRetrievalId(4),
      createStructuralTieRetrievalId(5),
    ];
    const expectedLexical = [
      createStructuralTieRetrievalId(1),
      createStructuralTieRetrievalId(2),
      createStructuralTieRetrievalId(3),
      createStructuralTieRetrievalId(4),
      createStructuralTieRetrievalId(5),
    ];
    const expectedFused = [
      createStructuralTieRetrievalId(3),
      createStructuralTieRetrievalId(4),
      createStructuralTieRetrievalId(5),
      createStructuralTieRetrievalId(1),
      createStructuralTieRetrievalId(9),
      createStructuralTieRetrievalId(10),
      createStructuralTieRetrievalId(2),
    ];
    const expectedRankings = spaces.map((space) => ({
      dense: expectedDense,
      dimensions: space.dimensions,
      fused: expectedFused,
      lexical: expectedLexical,
    }));
    expect(observedRankings).toEqual(expectedRankings);
  });

  it("rejects retrieval rows that do not match their generation source", async () => {
    const documentStore = new SourceDocumentStore(session.database);
    const documentId = "9".repeat(64);
    const element = buildTextElement(documentId, "8".repeat(64));
    const activeSource = "/documents/uploads/active/document.pdf";
    const staleSource = "/documents/uploads/retired/document.pdf";
    element.sourceFile = activeSource;
    await ensureTestSourceMetadata(documentId);
    await documentStore.writeMany([element]);
    const elementSet = await documentStore.writeElementSet(
      documentId,
      [element],
    );
    const generationId = randomUUID();
    await ensureEmbeddingSpace(session.database, space768);
    const retrievalMetadata = {
      documentId,
      embeddingSpaceId: space768.id,
      evidenceContent: "Robert is the subject.",
      generationId,
      id: element.id,
      kind: "text" as const,
      pageNumber: 1,
      parentId: element.id,
      representationType: "exact-window" as const,
      sourceFile: staleSource,
    };
    await expect(withOpenTestRetrievalGeneration(session.database, {
      documentId,
      elementSetId: elementSet.id,
      generationId,
      sourceFile: activeSource,
      space: space768,
      totalElements: 1,
    }, async () => {
      await session.database.insert(retrievalChunks768).values({
        ...retrievalMetadata,
        embedding: buildEmbedding(768, 1),
      });
    })).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: `Retrieval row does not match generation ${generationId}.`,
      }),
    });
  });

  it("paginates keyword discovery by document and retains the total", async () => {
    const documentStore = new SourceDocumentStore(session.database);
    const loanDocumentId = "1".repeat(64);
    const mortgageDocumentId = "2".repeat(64);
    const firstLoanElement = buildTextElement(loanDocumentId, "3".repeat(64));
    const secondLoanElement = buildTextElement(loanDocumentId, "4".repeat(64));
    const mortgageElement = buildTextElement(mortgageDocumentId, "5".repeat(64));
    firstLoanElement.content = "The agreement describes a secured loan.";
    secondLoanElement.content = "Loan repayment begins next month.";
    mortgageElement.content = "The company provides mortgage financing.";
    await documentStore.writeMany([
      firstLoanElement,
      secondLoanElement,
      mortgageElement,
    ]);
    await ensureEmbeddingSpace(session.database, space768);
    const loanGenerationId = randomUUID();
    const mortgageGenerationId = randomUUID();
    await indexTestElements(
      session.database,
      space768,
      loanDocumentId,
      loanGenerationId,
      [],
      [buildEmbedding(768, 1), buildEmbedding(768, 0.8)],
      [firstLoanElement, secondLoanElement],
    );
    await indexTestElements(
      session.database,
      space768,
      mortgageDocumentId,
      mortgageGenerationId,
      [],
      [buildEmbedding(768, 0.6)],
      [mortgageElement],
    );

    const firstPage = await retrieveKeywordDiscoveryPage(
      session.query,
      documentStore,
      "loan",
      space768.id,
      [
        {
          documentId: loanDocumentId,
          generationId: loanGenerationId,
          sourceFile: firstLoanElement.sourceFile,
        },
        {
          documentId: mortgageDocumentId,
          generationId: mortgageGenerationId,
          sourceFile: mortgageElement.sourceFile,
        },
      ],
      1,
      1,
      3,
    );
    const secondPage = await retrieveKeywordDiscoveryPage(
      session.query,
      documentStore,
      "loan",
      space768.id,
      [
        {
          documentId: loanDocumentId,
          generationId: loanGenerationId,
          sourceFile: firstLoanElement.sourceFile,
        },
        {
          documentId: mortgageDocumentId,
          generationId: mortgageGenerationId,
          sourceFile: mortgageElement.sourceFile,
        },
      ],
      2,
      1,
      3,
    );
    const matchingDocumentKeys = await readKeywordMatchingDocumentKeys(
      session.query,
      "loan",
      space768.id,
      [
        {
          documentId: loanDocumentId,
          generationId: loanGenerationId,
          sourceFile: firstLoanElement.sourceFile,
        },
        {
          documentId: mortgageDocumentId,
          generationId: mortgageGenerationId,
          sourceFile: mortgageElement.sourceFile,
        },
      ],
    );

    expect(firstPage.totalDocuments).toBe(1);
    expect(firstPage.matches).toHaveLength(2);
    expect(firstPage.matches[0]?.matchingPassageCount).toBe(2);
    expect(secondPage).toEqual({ matches: [], totalDocuments: 1 });
    expect([...matchingDocumentKeys]).toEqual([
      `${loanDocumentId}\u0000${firstLoanElement.sourceFile}`,
    ]);
  });

  it("isolates models and dimensions while applying a document filter", async () => {
    const documentStore = new SourceDocumentStore(session.database);
    const firstDocumentId = "4".repeat(64);
    const secondDocumentId = "5".repeat(64);
    const firstElement = buildTextElement(firstDocumentId, "6".repeat(64));
    const secondElement = buildTextElement(secondDocumentId, "7".repeat(64));
    firstElement.content = "The exact lexical marker is beneficiarymarker.";
    secondElement.content = "The exact lexical marker is zephyrcalibration.";
    await documentStore.writeMany([firstElement, secondElement]);
    await ensureEmbeddingSpace(session.database, space768);
    await ensureEmbeddingSpace(session.database, space384);
    const firstVersionId = "00000000-0000-4000-8000-000000000121";
    const secondVersionId = "00000000-0000-4000-8000-000000000122";
    const firstElementSet = await documentStore.writeElementSet(
      firstDocumentId,
      [firstElement],
    );
    const secondElementSet = await documentStore.writeElementSet(
      secondDocumentId,
      [secondElement],
    );
    const firstGenerationId = randomUUID();
    const secondGenerationId = randomUUID();
    const first384GenerationId = randomUUID();
    await ensureTestSourceMetadata(firstDocumentId);
    await ensureTestSourceMetadata(secondDocumentId);
    await session.database.insert(documentVersions).values([
      {
        ...buildTestDocumentFormatRow(firstElement.sourceFile),
        documentId: firstDocumentId,
        elementSetId: firstElementSet.id,
        generationId: firstGenerationId,
        id: firstVersionId,
        images: 0,
        pageCount: 1,
        sourceFile: firstElement.sourceFile,
        tables: 0,
        textChunks: 1,
        totalElements: 1,
        version: 1,
      },
      {
        ...buildTestDocumentFormatRow(secondElement.sourceFile),
        documentId: secondDocumentId,
        elementSetId: secondElementSet.id,
        generationId: secondGenerationId,
        id: secondVersionId,
        images: 0,
        pageCount: 1,
        sourceFile: secondElement.sourceFile,
        tables: 0,
        textChunks: 1,
        totalElements: 1,
        version: 1,
      },
    ]);
    await session.database.insert(indexedDocuments).values([
      {
        documentId: firstDocumentId,
        elementSetId: firstElementSet.id,
        generationId: firstGenerationId,
        images: 0,
        pageCount: 1,
        sourceFile: firstElement.sourceFile,
        tables: 0,
        tags: [],
        textChunks: 1,
        totalElements: 1,
        versionId: firstVersionId,
      },
      {
        documentId: secondDocumentId,
        elementSetId: secondElementSet.id,
        generationId: secondGenerationId,
        images: 0,
        pageCount: 1,
        sourceFile: secondElement.sourceFile,
        tables: 0,
        tags: [],
        textChunks: 1,
        totalElements: 1,
        versionId: secondVersionId,
      },
    ]);

    await indexTestElements(
      session.database,
      space768,
      firstDocumentId,
      firstGenerationId,
      [],
      [buildEmbedding(768, 1)],
      [firstElement],
    );
    await indexTestElements(
      session.database,
      space768,
      secondDocumentId,
      secondGenerationId,
      [],
      [buildEmbedding(768, -1)],
      [secondElement],
    );
    await indexTestElements(
      session.database,
      space384,
      firstDocumentId,
      first384GenerationId,
      [],
      [buildEmbedding(384, 1)],
      [firstElement],
    );

    const rankings = await queryRetrievalCandidateRankings(
      session.database,
      session.query,
      space768,
      [{
        embedding: buildEmbedding(768, -1),
        text: "beneficiarymarker",
      }],
      {
        answerTemperature: 0,
        candidateK: 5,
        chatTemperature: 0,
        fusion: { ...EQUAL_WEIGHT_FUSION_CONFIG },
        mode: "hybrid",
        queryExpansions: 0,
        queryExpansionTemperature: 0,
        reranker: null,
        rrfK: 60,
        topK: 5,
      },
      [{
        documentId: firstDocumentId,
        generationId: firstGenerationId,
        sourceFile: firstElement.sourceFile,
      }],
      new AbortController().signal,
    );
    expect([
      ...rankings.dense[0] ?? [],
      ...rankings.lexical[0] ?? [],
    ].some((candidate) => {
      return candidate.representation.type === "exact-window";
    })).toBe(true);

    const results = await retrieveRelevantElements(
      session.database,
      session.query,
      documentStore,
      space768,
      "beneficiarymarker",
      [{ embedding: buildEmbedding(768, -1), text: "beneficiarymarker" }],
      {
        answerTemperature: 0,
        candidateK: 5,
        chatTemperature: 0,
        fusion: { ...EQUAL_WEIGHT_FUSION_CONFIG },
        mode: "hybrid",
        queryExpansions: 0,
        queryExpansionTemperature: 0,
        reranker: null,
        rrfK: 60,
        topK: 5,
      },
      [{
        documentId: firstDocumentId,
        generationId: firstGenerationId,
        sourceFile: firstElement.sourceFile,
      }],
      null,
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.element.documentId).toBe(firstDocumentId);
    expect(results[0]?.evidenceContent).toBe(firstElement.content);
    expect(results[0]?.provenance.descriptionAffected).toBe(false);
    expect(results[0]?.provenance.representationHits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          representationType: "exact-window",
        }),
      ]),
    );

    const results384 = await retrieveRelevantElements(
      session.database,
      session.query,
      documentStore,
      space384,
      "first report",
      [{ embedding: buildEmbedding(384, 1), text: "first report" }],
      {
        answerTemperature: 0,
        candidateK: 5,
        chatTemperature: 0,
        fusion: { ...EQUAL_WEIGHT_FUSION_CONFIG },
        mode: "hybrid",
        queryExpansions: 0,
        queryExpansionTemperature: 0,
        reranker: null,
        rrfK: 60,
        topK: 5,
      },
      [{
        documentId: firstDocumentId,
        generationId: first384GenerationId,
        sourceFile: firstElement.sourceFile,
      }],
      null,
    );
    expect(results384[0]?.evidenceContent).toBe(firstElement.content);

    const denseResults = await retrieveRelevantElements(
      session.database,
      session.query,
      documentStore,
      space768,
      "zephyrcalibration",
      [{ embedding: buildEmbedding(768, 1), text: "zephyrcalibration" }],
      {
        answerTemperature: 0,
        candidateK: 5,
        chatTemperature: 0,
        fusion: { ...EQUAL_WEIGHT_FUSION_CONFIG },
        mode: "dense",
        queryExpansions: 0,
        queryExpansionTemperature: 0,
        reranker: null,
        rrfK: 60,
        topK: 5,
      },
      [
        {
          documentId: firstDocumentId,
          generationId: firstGenerationId,
          sourceFile: firstElement.sourceFile,
        },
        {
          documentId: secondDocumentId,
          generationId: secondGenerationId,
          sourceFile: secondElement.sourceFile,
        },
      ],
      null,
    );
    expect(denseResults[0]?.element.documentId).toBe(firstDocumentId);

    const bm25Results = await retrieveRelevantElements(
      session.database,
      session.query,
      documentStore,
      space768,
      "zephyrcalibration",
      [{ embedding: null, text: "zephyrcalibration" }],
      {
        answerTemperature: 0,
        candidateK: 5,
        chatTemperature: 0,
        fusion: { ...EQUAL_WEIGHT_FUSION_CONFIG },
        mode: "bm25",
        queryExpansions: 0,
        queryExpansionTemperature: 0,
        reranker: null,
        rrfK: 60,
        topK: 5,
      },
      [
        {
          documentId: firstDocumentId,
          generationId: firstGenerationId,
          sourceFile: firstElement.sourceFile,
        },
        {
          documentId: secondDocumentId,
          generationId: secondGenerationId,
          sourceFile: secondElement.sourceFile,
        },
      ],
      null,
    );
    expect(bm25Results[0]?.element.documentId).toBe(secondDocumentId);
    expect(bm25Results[0]?.provenance.descriptionAffected).toBe(false);

    const hybridResults = await retrieveRelevantElements(
      session.database,
      session.query,
      documentStore,
      space768,
      "zephyrcalibration",
      [{ embedding: buildEmbedding(768, 1), text: "zephyrcalibration" }],
      {
        answerTemperature: 0,
        candidateK: 5,
        chatTemperature: 0,
        fusion: { ...EQUAL_WEIGHT_FUSION_CONFIG },
        mode: "hybrid",
        queryExpansions: 0,
        queryExpansionTemperature: 0,
        reranker: null,
        rrfK: 60,
        topK: 5,
      },
      [
        {
          documentId: firstDocumentId,
          generationId: firstGenerationId,
          sourceFile: firstElement.sourceFile,
        },
        {
          documentId: secondDocumentId,
          generationId: secondGenerationId,
          sourceFile: secondElement.sourceFile,
        },
      ],
      null,
    );
    expect(hybridResults[0]?.element.documentId).toBe(secondDocumentId);
    expect(hybridResults[0]?.evidenceContent).toBe(secondElement.content);

    const rerankerConfig = readEqualWeightTestConfig({
      providerOptions: { rerankEnabled: true },
    }).retrieval.reranker;
    if (rerankerConfig === null) {
      throw new Error("Missing test reranker configuration.");
    }
    let rerankingCallCount = 0;
    const rerankingModel = new MockRerankingModelV4({
      doRerank: async (options) => {
        rerankingCallCount += 1;
        if (options.documents.type !== "text") {
          throw new Error("Expected text reranker documents.");
        }
        return {
          ranking: options.documents.values.map((_document, index) => ({
            index,
            relevanceScore: 1 - (index / 10),
          })),
        };
      },
    });
    const resolvedReranker = {
      metrics: new InferenceMetricsReporter({ enabled: false }),
      model: rerankingModel,
      timeoutMs: 1_000,
    };
    const rerankingScheduler = new TaskLimiter(1);
    const rerankingScenarios = [
      { embedding: null, mode: "bm25" as const },
      { embedding: buildEmbedding(768, 1), mode: "dense" as const },
      { embedding: buildEmbedding(768, 1), mode: "hybrid" as const },
    ];
    for (const scenario of rerankingScenarios) {
      const reranked = await retrieveRelevantElements(
        session.database,
        session.query,
        documentStore,
        space768,
        "zephyrcalibration",
        [{
          embedding: scenario.embedding,
          text: "zephyrcalibration",
        }],
        {
          answerTemperature: 0,
          candidateK: 5,
          chatTemperature: 0,
          fusion: { ...EQUAL_WEIGHT_FUSION_CONFIG },
          mode: scenario.mode,
          queryExpansions: 0,
          queryExpansionTemperature: 0,
          reranker: rerankerConfig,
          rrfK: 60,
          topK: 5,
        },
        [
          {
            documentId: firstDocumentId,
            generationId: firstGenerationId,
            sourceFile: firstElement.sourceFile,
          },
          {
            documentId: secondDocumentId,
            generationId: secondGenerationId,
            sourceFile: secondElement.sourceFile,
          },
        ],
        resolvedReranker,
        rerankingScheduler,
      );
      expect(reranked.length).toBeGreaterThan(0);
    }
    expect(rerankingCallCount).toBe(3);

    await indexTestElements(
      session.database,
      space768,
      firstDocumentId,
      randomUUID(),
      [],
      [],
      [],
    );
    const remainingRows = await session.database
      .select({ id: retrievalChunks768.id })
      .from(retrievalChunks768)
      .where(eq(retrievalChunks768.documentId, firstDocumentId));
    expect(remainingRows).toEqual([]);
    const remaining384Rows = await session.database
      .select({ id: retrievalChunks384.id })
      .from(retrievalChunks384)
      .where(eq(retrievalChunks384.documentId, firstDocumentId));
    expect(remaining384Rows).toHaveLength(1);
  });
});

function buildTextElement(documentId: string, id: string): SourceElement {
  return {
    content: `content for ${documentId}`,
    documentId,
    id,
    detectedTypes: ["paragraph"],
    kind: "text",
    ...buildSourceLocation(1),
    sourceFile: `/documents/${documentId}.pdf`,
  };
}

function buildTableElement(
  documentId: string,
  id: string,
  sourceFile = `/documents/${documentId}.pdf`,
): TableElement {
  const table = buildTableStructure();
  table.columnCount = 2;
  table.rowCount = 4;
  table.rowEnd = 4;
  return {
    caption: "Privacy complaints by province",
    content: [
      "Privacy complaints by province",
      "| Province | Complaints |",
      "| --- | --- |",
      "| Ontario | 120 |",
      "| Quebec | 85 |",
      "| Alberta | 42 |",
    ].join("\n"),
    detectedType: "table",
    documentId,
    id,
    kind: "table",
    ...buildSourceLocation(1),
    sourceFile,
    table,
  };
}

function buildImageElement(
  documentId: string,
  id: string,
  sourceFile = `/documents/${documentId}.pdf`,
): ImageElement {
  return {
    caption: "Document processing architecture",
    content: Buffer.from("image fixture").toString("base64"),
    detectedType: "picture",
    documentId,
    id,
    kind: "image",
    mimeType: "image/png",
    ...buildSourceLocation(1),
    sourceFile,
  };
}

function buildTestRepresentations(
  elements: readonly SourceElement[],
  descriptions: readonly RetrievalDescriptionRecord[],
  space: EmbeddingSpaceConfig,
): RetrievalRepresentation[] {
  const windows = createRetrievalWindows(elements, {
    embeddingInputFormat: space.inputFormat,
    policy: space.retrievalWindow,
  });
  return createRetrievalRepresentations(
    elements,
    descriptions,
    windows,
    space.retrievalWindow,
  );
}

async function indexTestElements(
  database: typeof session.database,
  space: EmbeddingSpaceConfig,
  documentId: string,
  generationId: string,
  descriptions: RetrievalDescriptionRecord[],
  embeddings: number[][],
  elements: SourceElement[],
): Promise<void> {
  const windows = createRetrievalWindows(elements, {
    embeddingInputFormat: space.inputFormat,
    policy: space.retrievalWindow,
  });
  if (windows.length !== embeddings.length) {
    throw new Error("Test retrieval windows must match the supplied embeddings.");
  }
  const representations = createRetrievalRepresentations(
    elements,
    descriptions,
    windows,
    space.retrievalWindow,
  );
  const representationEmbeddings = buildTestRepresentationEmbeddings(
    windows,
    representations,
    embeddings,
  );
  await stageTestRetrievalRepresentations(
    database,
    space,
    documentId,
    generationId,
    representations,
    representationEmbeddings,
  );
}

async function stageTestRetrievalRepresentations(
  database: typeof session.database,
  space: EmbeddingSpaceConfig,
  documentId: string,
  generationId: string,
  representations: readonly RetrievalRepresentation[],
  embeddings: readonly number[][],
): Promise<void> {
  const sourceFile = representations[0]?.sourceFile
    ?? `/documents/${documentId}.pdf`;
  const elementSetId = await writeTestElementSet(
    documentId,
    sourceFile,
  );
  const totalElements = 1;
  const input = {
    documentId,
    elementSetId,
    generationId,
    totalElements,
  };
  await withOpenTestRetrievalGeneration(database, {
    documentId,
    elementSetId,
    generationId,
    sourceFile,
    space,
    totalElements,
  }, async () => {
    await stageRetrievalRepresentationBatch(
      database,
      space,
      input,
      0,
      totalElements,
      representations,
      embeddings,
    );

    await database.transaction(async (transaction) => {
      const previousRows = await transaction
        .select({ generationId: indexedDocumentSpaces.generationId })
        .from(indexedDocumentSpaces)
        .where(and(
          eq(indexedDocumentSpaces.sourceFile, sourceFile),
          eq(indexedDocumentSpaces.embeddingSpaceId, space.id),
        ))
        .limit(1);
      if (representations.length > 0) {
        await synchronizeActiveRetrievalProjection(transaction, {
          documentId,
          elementSetId,
          embeddingSpaceId: space.id,
          generationId,
          indexedAt: new Date(),
          sourceFile,
          totalElements,
        });
      } else {
        await transaction
          .delete(indexedDocumentSpaces)
          .where(and(
            eq(indexedDocumentSpaces.sourceFile, sourceFile),
            eq(indexedDocumentSpaces.embeddingSpaceId, space.id),
          ));
      }
      const previousGenerationId = previousRows[0]?.generationId;
      if (
        previousGenerationId !== undefined
        && previousGenerationId !== generationId
      ) {
        await deleteRetrievalGenerationRows(
          transaction,
          previousGenerationId,
        );
      }
    });
  });
}

function buildTestRepresentationEmbeddings(
  windows: ReturnType<typeof createRetrievalWindows>,
  representations: RetrievalRepresentation[],
  embeddings: number[][],
): number[][] {
  const embeddingByWindowId = new Map<string, number[]>();
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    const embedding = embeddings[index];
    if (window === undefined || embedding === undefined) {
      throw new Error(`Incomplete test embedding at index ${index}.`);
    }
    embeddingByWindowId.set(window.id, embedding);
  }

  const representationEmbeddings: number[][] = [];
  for (const representation of representations) {
    const exactEmbedding = embeddingByWindowId.get(representation.id);
    if (exactEmbedding !== undefined) {
      representationEmbeddings.push(exactEmbedding);
      continue;
    }
    const parentWindow = windows.find((window) => {
      return window.parentId === representation.parentId;
    });
    const parentEmbedding = parentWindow === undefined
      ? undefined
      : embeddingByWindowId.get(parentWindow.id);
    if (parentEmbedding === undefined) {
      throw new Error(
        `Retrieval representation ${representation.id} has no exact test evidence.`,
      );
    }
    representationEmbeddings.push(parentEmbedding);
  }
  return representationEmbeddings;
}

function buildEmbedding(dimensions: number, firstValue: number): number[] {
  const embedding = Array.from({ length: dimensions }, () => 0);
  embedding[0] = firstValue;
  return embedding;
}

async function expectIndexedTopKPlans(
  space: EmbeddingSpaceConfig,
  options: {
    forcePlanner?: boolean;
    lexicalQuery?: string;
  } = {},
): Promise<void> {
  const forcePlanner = options.forcePlanner ?? true;
  const lexicalQuery = options.lexicalQuery ?? "deterministicfixturetoken";
  const vectorTable = readActiveRetrievalVectorTable(space.dimensions);
  const embedding = buildEmbedding(space.dimensions, 1);
  const distance = cosineDistance(vectorTable.embedding, embedding);
  const plans = await session.database.transaction(async (transaction) => {
    if (forcePlanner) {
      await transaction.execute(sql`SET LOCAL enable_seqscan = off`);
      await transaction.execute(sql`SET LOCAL enable_sort = off`);
    }
    const denseResult = await transaction.execute(sql`
      EXPLAIN (ANALYZE, COSTS OFF, BUFFERS)
      SELECT ${vectorTable.representationId}
      FROM ${vectorTable}
      WHERE ${vectorTable.embeddingSpaceId} = ${space.id}
      ORDER BY ${distance}
      LIMIT 5
    `);
    const lexicalResult = await transaction.execute(sql`
      EXPLAIN (ANALYZE, COSTS OFF, BUFFERS)
      SELECT ${activeRetrievalLexicalChunks.representationId}
      FROM ${activeRetrievalLexicalChunks}
      WHERE ${activeRetrievalLexicalChunks.embeddingSpaceId} = ${space.id}
      ORDER BY ${activeRetrievalLexicalChunks.content}
        <@> to_bm25query(
          ${lexicalQuery},
          'active_retrieval_lexical_bm25_idx'
        )
      LIMIT 5
    `);
    return {
      dense: readExplainPlan(denseResult.rows),
      lexical: readExplainPlan(lexicalResult.rows),
    };
  });
  expect(plans.dense).toContain("_embedding_idx");
  expect(plans.dense).toContain("Order By");
  expect(plans.dense).not.toContain("indexed_document_spaces");
  expect(plans.dense).not.toContain("Append");
  expect(plans.lexical).toContain("_content_idx");
  expect(plans.lexical).toContain("Order By");
  expect(plans.lexical).not.toContain("indexed_document_spaces");
  expect(plans.lexical).not.toContain("Append");
}

function readExplainPlan(value: unknown): string {
  if (!Array.isArray(value)) {
    throw new Error("PostgreSQL EXPLAIN did not return rows.");
  }
  const lines: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const row = value[index];
    if (typeof row !== "object" || row === null) {
      throw new Error(`PostgreSQL EXPLAIN row ${index + 1} is invalid.`);
    }
    const line = (row as { "QUERY PLAN"?: unknown })["QUERY PLAN"];
    if (typeof line !== "string") {
      throw new Error(`PostgreSQL EXPLAIN row ${index + 1} has no plan text.`);
    }
    lines.push(line);
  }
  return lines.join("\n");
}

function buildTestApplicationError(sourceFile: string, message: string) {
  const reporter = new ApplicationErrorReporter(session.database);
  return reporter.prepare(new Error(message), {
    category: "test-ingestion-failure",
    code: "test_ingestion_failed",
    operation: "test-ingestion",
    origin: "ingestion",
    retryable: true,
    service: "test-worker",
    severity: "error",
    sourceFile,
  });
}

function buildResolvedScopeTargets(
  documentIds: readonly string[],
  generationIds: readonly string[],
  sourceFiles: readonly string[],
): ResolvedQueryScopeTarget[] {
  if (
    documentIds.length !== generationIds.length
    || documentIds.length !== sourceFiles.length
  ) {
    throw new Error("Resolved scope fixture columns must have equal lengths.");
  }
  const targets: ResolvedQueryScopeTarget[] = [];
  for (let index = 0; index < documentIds.length; index += 1) {
    const documentId = documentIds[index];
    const generationId = generationIds[index];
    const sourceFile = sourceFiles[index];
    if (
      documentId === undefined
      || generationId === undefined
      || sourceFile === undefined
    ) {
      throw new Error(`Incomplete resolved scope fixture at index ${index}.`);
    }
    targets.push({ documentId, generationId, sourceFile });
  }
  return targets;
}

function buildStructuralTieVectorRows(
  space: EmbeddingSpaceConfig,
  documentIds: readonly string[],
  generationIds: readonly string[],
  sourceFiles: readonly string[],
) {
  const rows: Array<{
    documentId: string;
    embedding: number[];
    embeddingSpaceId: string;
    evidenceContent: string;
    generationId: string;
    id: string;
    kind: "text";
    pageNumber: number;
    parentId: string;
    representationType: "exact-window";
    sourceFile: string;
  }> = [];
  for (let index = 0; index < 10; index += 1) {
    const documentIndex = index % documentIds.length;
    const documentId = documentIds[documentIndex];
    const generationId = generationIds[documentIndex];
    const sourceFile = sourceFiles[documentIndex];
    if (
      documentId === undefined
      || generationId === undefined
      || sourceFile === undefined
    ) {
      throw new Error(`Incomplete structural tie row at index ${index}.`);
    }
    const retrievalNumber = 10 - index;
    const embedding = buildEmbedding(space.dimensions, 1);
    if (index >= 2) {
      embedding[1] = index < 8 ? 1 : 2;
    }
    rows.push({
      documentId,
      embedding,
      embeddingSpaceId: space.id,
      evidenceContent: `Structural tie window ${retrievalNumber}.`,
      generationId,
      id: createStructuralTieRetrievalId(retrievalNumber),
      kind: "text",
      pageNumber: 1,
      parentId: createStructuralTieParentId(Math.floor(index / 2)),
      representationType: "exact-window",
      sourceFile,
    });
  }
  return rows;
}

function createStructuralTieRetrievalId(value: number): string {
  return value.toString(16).padStart(64, "0");
}

function createStructuralTieParentId(value: number): string {
  return (value + 32).toString(16).padStart(64, "0");
}

describe("PostgreSQL application settings", () => {
  it("requires a connected device credential before routing to OpenAI Codex", async () => {
    const config = buildTestConfig();
    const repository = new ApplicationSettingsRepository(session.database);
    const routeChange = {
      action: "route" as const,
      capability: "queryExpansion" as const,
      providerId: "openai-codex" as const,
    };

    await expect(repository.update(
      config.database,
      1,
      [],
      [routeChange],
    )).rejects.toThrow(
      "Sign in to OpenAI Codex before assigning a feature to it.",
    );

    const credentials = new OpenAICodexCredentialStore(session.database);
    await credentials.replace({
      accessToken: "connected-access",
      accountId: "account-123",
      expiresAt: new Date(Date.now() + 3_600_000),
      refreshToken: "connected-refresh",
    });
    const updated = await repository.update(
      config.database,
      1,
      [],
      [routeChange],
    );

    expect(updated.providerSettings.routing.queryExpansion).toBe(
      "openai-codex",
    );
  });

  it("requires database-owned settings and never creates them at runtime", async () => {
    const config = buildTestConfig();
    const repository = new ApplicationSettingsRepository(session.database);
    await session.database.delete(applicationSettings);

    await expect(repository.read(
      config.database,
    )).rejects.toThrow("The database does not contain application settings.");
    await expect(repository.update(
      config.database,
      0,
      [{ key: "topK", value: 4 }],
    )).rejects.toThrow("The database does not contain application settings.");
    expect(await session.database.select().from(applicationSettings)).toEqual([]);
  });

  it("adds the default search method to an existing settings document", async () => {
    await session.database
      .update(applicationSettings)
      .set({
        defaults: sql`${applicationSettings.defaults} #- '{runtime,searchMethod}'`,
        settings: sql`${applicationSettings.settings} #- '{runtime,searchMethod}'`,
      })
      .where(eq(applicationSettings.id, "runtime"));

    await applyDatabaseBootstrap(session.database, {
      CITELOOM_ADMIN_PASSWORD: "integration test administrator password",
      CITELOOM_ADMIN_USERNAME: "IntegrationAdmin",
      CITELOOM_SOURCE_CONTENT_DIRECTORY: sourceContentConfig.directory,
    });

    const rows = await session.database
      .select({
        defaults: applicationSettings.defaults,
        settings: applicationSettings.settings,
      })
      .from(applicationSettings)
      .where(eq(applicationSettings.id, "runtime"));
    const row = rows[0];
    if (row === undefined) {
      throw new Error("Missing bootstrapped application settings.");
    }
    const defaults = parseStoredApplicationSettings(row.defaults);
    const settings = parseStoredApplicationSettings(row.settings);
    expect(defaults.runtime.searchMethod).toBe("hybrid");
    expect(settings.runtime.searchMethod).toBe("hybrid");
  });

  it("does not persist an unchanged database-owned settings document", async () => {
    const config = buildTestConfig();
    const repository = new ApplicationSettingsRepository(session.database);

    const unchanged = await repository.update(
      config.database,
      1,
      [],
    );

    expect(unchanged).toMatchObject({ version: 1 });
    expect(unchanged.config.settingsVersion).toBe(1);
    expect(unchanged.config.scheduling.settingsVersion).toBe(1);
    const rows = await session.database.select().from(applicationSettings);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 1 });
  });

  it("persists the default Docling service capacity", async () => {
    const config = buildTestConfig();
    const repository = new ApplicationSettingsRepository(session.database);

    const updated = await repository.update(
      config.database,
      1,
      [
        { key: "doclingDefaultServiceCapacity", value: 2 },
      ],
    );

    expect(updated.runtimeSettings.doclingDefaultServiceCapacity).toBe(2);
    expect(updated.config.doclingServices).toEqual([{
      ...config.doclingServices[0],
      capacity: 2,
    }]);
    await expect(repository.read(
      config.database,
    )).resolves.toMatchObject({
      overrides: {
        doclingDefaultServiceCapacity: 2,
      },
      version: 2,
    });
  });

  it("persists the application search method independently from providers", async () => {
    const config = buildTestConfig();
    const repository = new ApplicationSettingsRepository(session.database);

    const updated = await repository.update(
      config.database,
      1,
      [{ key: "searchMethod", value: "bm25" }],
    );

    expect(updated.runtimeSettings.searchMethod).toBe("bm25");
    expect(updated.config.retrieval.mode).toBe("bm25");
    await expect(repository.read(
      config.database,
    )).resolves.toMatchObject({
      overrides: { searchMethod: "bm25" },
      version: 2,
    });
  });

  it("rejects a default Docling endpoint change while a job retains affinity", async () => {
    const config = buildTestConfig();
    const defaultService = config.doclingServices[0];
    if (defaultService === undefined) {
      throw new Error("Missing default Docling test service.");
    }
    const ownerId = "00000000-0000-4000-8000-000000000151";
    const sourceFile = "/documents/settings-docling-affinity.pdf";
    const catalog = new DocumentCatalog(session.database, {
      newLeaseOwnerId: () => ownerId,
    });
    await prepareTestIngestion(catalog,
      sourceFile,
      "a".repeat(64),
      space768.id,
      [],
      false,
    );
    await claimTestJob(catalog, sourceFile, "discovered");
    const services = new DoclingServiceStore(session.database);
    await services.synchronize([
      buildAvailableDoclingServiceVerification(defaultService),
    ]);
    await services.ensureAssignment(ownerId, sourceFile);
    const repository = new ApplicationSettingsRepository(session.database);
    await expect(repository.update(
      config.database,
      1,
      [{ key: "doclingBaseUrl", value: "http://127.0.0.1:5999" }],
    )).rejects.toThrow(
      "The default Docling URL cannot change while jobs remain assigned",
    );
    await expect(repository.read(
      config.database,
    )).resolves.toMatchObject({ overrides: {}, version: 1 });
  });

  it("persists typed overrides, detects stale revisions, and restores defaults", async () => {
    const config = buildTestConfig();
    const repository = new ApplicationSettingsRepository(session.database);

    const initial = await repository.read(
      config.database,
    );
    expect(initial.version).toBe(1);
    expect(initial.updatedAt).not.toBeNull();
    expect(initial.runtimeSettings.doclingTimeoutSeconds).toBe(1_800);

    const updated = await repository.update(
      config.database,
      1,
      [
        { key: "claimVerifierSupportThreshold", value: 0.8 },
        { key: "denseWeight", value: 2 },
        { key: "doclingOcrEnabled", value: false },
        { key: "doclingPdfBackend", value: "threaded_docling_parse" },
        { key: "doclingPerformanceMetricsEnabled", value: true },
        { key: "doclingSecondaryImageScale", value: 3 },
        { key: "doclingTableMode", value: "fast" },
        { key: "doclingTableStructureEnabled", value: false },
        { key: "doclingTimeoutSeconds", value: 600 },
        { key: "expansionDecay", value: 0.5 },
      ],
    );
    expect(updated).toMatchObject({ version: 2 });
    expect(updated.config.claimVerifier.supportThreshold).toBe(0.8);
    expect(updated.config.docling.baseTimeoutMs).toBe(600_000);
    expect(updated.config.docling).toMatchObject({
      ocrEnabled: false,
      pdfBackend: "threaded_docling_parse",
      performanceMetricsEnabled: true,
      secondaryImageScale: 3,
      tableMode: "fast",
      tableStructureEnabled: false,
    });
    expect(updated.config.retrieval.fusion).toMatchObject({
      denseWeight: 2,
      expansionDecay: 0.5,
    });

    const persisted = await repository.read(
      config.database,
    );
    expect(persisted.overrides).toEqual({
      claimVerifierSupportThreshold: 0.8,
      denseWeight: 2,
      doclingOcrEnabled: false,
      doclingPdfBackend: "threaded_docling_parse",
      doclingPerformanceMetricsEnabled: true,
      doclingSecondaryImageScale: 3,
      doclingTableMode: "fast",
      doclingTableStructureEnabled: false,
      doclingTimeoutSeconds: 600,
      expansionDecay: 0.5,
    });
    await expect(repository.update(
      config.database,
      1,
      [{ key: "topK", value: 4 }],
    )).rejects.toBeInstanceOf(SettingsVersionConflictError);

    const reset = await repository.update(
      config.database,
      2,
      [
        { key: "claimVerifierSupportThreshold", reset: true },
        { key: "denseWeight", reset: true },
        { key: "doclingOcrEnabled", reset: true },
        { key: "doclingPdfBackend", reset: true },
        { key: "doclingPerformanceMetricsEnabled", reset: true },
        { key: "doclingSecondaryImageScale", reset: true },
        { key: "doclingTableMode", reset: true },
        { key: "doclingTableStructureEnabled", reset: true },
        { key: "doclingTimeoutSeconds", reset: true },
        { key: "expansionDecay", reset: true },
      ],
    );
    expect(reset).toMatchObject({ overrides: {}, version: 3 });
    expect(reset.updatedAt).not.toBeNull();
    expect(reset.config.docling.baseTimeoutMs).toBe(1_800_000);
    expect(reset.config.claimVerifier.supportThreshold).toBe(
      config.claimVerifier.supportThreshold,
    );
    expect(reset.config.speechToText).toBeNull();
  });
});

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForInferenceQueueLength(expectedLength: number): Promise<void> {
  await vi.waitFor(async () => {
    const queuedRows = await session.database.select().from(inferenceQueue);
    expect(queuedRows).toHaveLength(expectedLength);
  });
}

function buildTestConfig(): AppConfig {
  const storedSettings = buildDatabaseOwnedSettings();
  return readEqualWeightTestConfig({
    database: {
      poolMax: 4,
      url: databaseUrl,
    },
    providerSettings: storedSettings.providers,
    runtime: storedSettings.runtime,
    sourceContent: sourceContentConfig,
    embeddingInputFormat: TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
  });
}

function buildDoclingServiceIdentity() {
  return {
    coreVersion: "2.87.1",
    jobkitVersion: "2.1.0",
    modelsVersion: "3.13.3",
    parseVersion: "7.8.1",
    serveVersion: "1.27.0" as const,
    version: "2.113.0" as const,
  };
}

function buildDoclingVersionResponse() {
  return {
    docling: "2.113.0",
    "docling-core": "2.87.1",
    "docling-ibm-models": "3.13.3",
    "docling-jobkit": "2.1.0",
    "docling-parse": "7.8.1",
    "docling-serve": "1.27.0",
  };
}

function buildDoclingOpenApi() {
  return {
    components: {
      schemas: {
        ContentRequest: {
          properties: {
            byte_length: {},
            document_id: {},
            filename: {},
            options: { $ref: "#/components/schemas/ConvertOptions" },
            task_id: {},
          },
        },
        ConvertOptions: {
          properties: {
            abort_on_error: {},
            do_ocr: {},
            do_table_structure: {},
            document_timeout: {},
            force_ocr: {},
            from_formats: {},
            image_export_mode: {},
            images_scale: {},
            include_images: {},
            include_page_images: {},
            ocr_preset: {},
            pdf_backend: {
              enum: [
                "docling_parse",
                "pypdfium2",
                "threaded_docling_parse",
              ],
            },
            pipeline: { enum: ["standard", "vlm"] },
            table_cell_matching: {},
            table_mode: {},
            to_formats: {},
            vlm_pipeline_custom_config: {},
          },
        },
      },
    },
    info: { title: "Docling Serve", version: "1.27.0" },
    openapi: "3.1.0",
    paths: {
      "/v1/convert/content/async": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ContentRequest" },
              },
            },
          },
        },
      },
      "/v1/result/{task_id}": { get: {} },
      "/v1/status/poll/{task_id}": { get: {} },
      "/v1/tasks/{task_id}/pause": { post: {} },
      "/v1/tasks/{task_id}/terminate": { post: {} },
    },
  };
}

function buildAvailableDoclingServiceVerification(
  config: DoclingServiceInstanceConfig,
  identity: ReturnType<typeof buildDoclingServiceIdentity> =
    buildDoclingServiceIdentity(),
): DoclingServiceVerification {
  return {
    capabilitiesFingerprint: "a".repeat(64),
    config,
    errorCategory: null,
    identity,
    verificationConfigFingerprint: "b".repeat(64),
  };
}

function buildUnavailableDoclingServiceVerification(
  config: DoclingServiceInstanceConfig,
  errorCategory: string,
): DoclingServiceVerification {
  return {
    config,
    errorCategory,
    identity: null,
    verificationConfigFingerprint: "b".repeat(64),
  };
}

function buildBenchmarkProcessConfiguration(): DoclingBenchmarkProcessConfiguration {
  return {
    batchPollingIntervalSeconds: 0.5,
    layoutBatchSize: 4,
    loadModelsAtBoot: true,
    localModelsShared: true,
    localWorkerCount: 2,
    numThreads: 4,
    ocrBatchSize: 4,
    optionsCacheSize: 2,
    profilePipelineTimings: true,
    queueMaxSize: 100,
    resultRemovalDelaySeconds: 300,
    singleUseResults: true,
    tableBatchSize: 4,
  };
}

function buildBenchmarkCandidate(): DoclingBenchmarkCandidate {
  const config = buildTestConfig();
  return {
    id: "final:docling_parse:t4:b4",
    phase: "finalist",
    process: buildBenchmarkProcessConfiguration(),
    request: readDoclingRequestConfiguration(
      buildDoclingConversionOptions(config.docling, {
        extension: ".pdf",
        mediaType: "application/pdf",
      }),
    ),
    secondaryImageScale: 2,
  };
}

function buildBenchmarkEnvironment(): DoclingBenchmarkEnvironment {
  return {
    baseUrl: "http://127.0.0.1:5002",
    baseline: {
      baseTimeoutMs: 120_000,
      maxTimeoutMs: 43_200_000,
      megabyteTimeoutMs: 60_000,
      pageTimeoutMs: 30_000,
      requestTimeoutMs: 300_000,
      settingsVersion: 8,
    },
    capabilitiesFingerprint: "f".repeat(64),
    composeProject: "citeloom",
    corpusFingerprint: "c".repeat(64),
    cpuCount: 12,
    imageReference: "citeloom/docling-serve-cpu:1.27.0-ppocrv5-2d2fd797",
    ocrPreset: "rapidocr",
    process: buildBenchmarkProcessConfiguration(),
    service: buildDoclingServiceIdentity(),
  };
}

function buildRetentionSpace(spaceId: string, createdAt: Date) {
  return {
    createdAt,
    dimensions: 384,
    id: spaceId,
    inputFormatDocumentTemplate:
      TEST_PLAIN_EMBEDDING_INPUT_FORMAT.documentTemplate,
    inputFormatHash: TEST_PLAIN_EMBEDDING_INPUT_FORMAT.inputFormatHash,
    inputFormatId: TEST_PLAIN_EMBEDDING_INPUT_FORMAT.id,
    inputFormatName: TEST_PLAIN_EMBEDDING_INPUT_FORMAT.name,
    inputFormatQueryTemplate:
      TEST_PLAIN_EMBEDDING_INPUT_FORMAT.queryTemplate,
    inputFormatSchemaVersion:
      TEST_PLAIN_EMBEDDING_INPUT_FORMAT.schemaVersion,
    model: "retention-test-model",
    retrievalWindowPolicy: testRetrievalWindow.policy,
    retrievalWindowPolicyFingerprint: testRetrievalWindow.fingerprint,
  } as const;
}

function buildEmbeddingSpaceRow(space: EmbeddingSpaceConfig) {
  return {
    dimensions: space.dimensions,
    id: space.id,
    inputFormatDocumentTemplate: space.inputFormat.documentTemplate,
    inputFormatHash: space.inputFormat.inputFormatHash,
    inputFormatId: space.inputFormat.id,
    inputFormatName: space.inputFormat.name,
    inputFormatQueryTemplate: space.inputFormat.queryTemplate,
    inputFormatSchemaVersion: space.inputFormat.schemaVersion,
    model: space.model,
    retrievalWindowPolicy: space.retrievalWindow.policy,
    retrievalWindowPolicyFingerprint: space.retrievalWindow.fingerprint,
  };
}

function buildStoredApplicationError(
  id: string,
  occurredAt: Date,
): typeof applicationErrorEvents.$inferInsert {
  return {
    category: "test",
    code: "retention_test_failure",
    id,
    message: "Application error retention test event.",
    occurredAt,
    operation: "test-application-error-retention",
    origin: "background-task",
    service: "test",
    severity: "error",
  };
}

function buildStoredDoclingError(
  applicationErrorId: string,
): typeof doclingErrorDetails.$inferInsert {
  return {
    applicationErrorId,
    category: "backend_failure",
    componentType: "document_backend",
    message: "Application error retention test detail.",
    moduleName: "test",
    sequence: 0,
  };
}

async function insertRetentionRows(spaceId: string): Promise<void> {
  const documentId = "c".repeat(64);
  const retrievalId = documentId;
  const sourceFile = `/documents/${spaceId.replaceAll(":", "-")}.pdf`;
  const versionId = "00000000-0000-4000-8000-000000000098";
  const elementSetId = await writeTestElementSet(
    documentId,
    sourceFile,
    [documentId],
  );
  const generationId = randomUUID();
  await session.database.insert(documentVersions).values({
    ...buildTestDocumentFormatRow(sourceFile),
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    documentId,
    elementSetId,
    generationId,
    id: versionId,
    images: 0,
    pageCount: 1,
    sourceFile,
    tables: 0,
    textChunks: 1,
    totalElements: 1,
    version: 1,
  });
  await session.database.insert(indexedDocuments).values({
    documentId,
    elementSetId,
    generationId,
    images: 0,
    indexedAt: new Date("2026-01-01T00:00:00.000Z"),
    pageCount: 1,
    sourceFile,
    tables: 0,
    tags: [],
    textChunks: 1,
    totalElements: 1,
    versionId,
  });
  await session.database.insert(indexedDocumentSpaces).values({
    documentId,
    embeddingSpaceId: spaceId,
    generationId,
    indexedAt: new Date("2026-01-01T00:00:00.000Z"),
    representationCount: 1,
    sourceFile,
  });
  const metadata = {
    documentId,
    embeddingSpaceId: spaceId,
    evidenceContent: "Retention test evidence.",
    generationId,
    id: retrievalId,
    kind: "text" as const,
    pageNumber: 1,
    parentId: documentId,
    representationType: "exact-window" as const,
    sourceFile,
  };
  const embedding = Array.from({ length: 384 }, (_, index) => (
    index === 0 ? 1 : 0
  ));
  const space: EmbeddingSpaceConfig = {
    ...space384,
    id: spaceId,
    model: "retention-test-model",
  };
  await withOpenTestRetrievalGeneration(session.database, {
    documentId,
    elementSetId,
    generationId,
    sourceFile,
    space,
    totalElements: 1,
  }, async () => {
    await session.database.insert(retrievalChunks384).values({
      ...metadata,
      embedding,
    });
    await session.database.insert(retrievalLexicalChunks).values({
      ...metadata,
      content: "Retention test content.",
    });
  });
}

function buildTestRetrievalTrace(question: string): ResearchRetrievalTrace {
  return {
    generation: {
      answer: { temperature: 0 },
      queryExpansion: { temperature: 0 },
    },
    orderedSources: [],
    queries: [{ kind: "original", text: question }],
    version: 3,
  };
}

async function readRetentionRowCounts(spaceId: string): Promise<{
  documentSpaces: number;
  lexical: number;
  vectors: number;
}> {
  const [documentSpaces, lexical, vectors] = await Promise.all([
    session.database
      .select({ id: indexedDocumentSpaces.documentId })
      .from(indexedDocumentSpaces)
      .where(eq(indexedDocumentSpaces.embeddingSpaceId, spaceId)),
    session.database
      .select({ id: retrievalLexicalChunks.id })
      .from(retrievalLexicalChunks)
      .where(eq(retrievalLexicalChunks.embeddingSpaceId, spaceId)),
    session.database
      .select({ id: retrievalChunks384.id })
      .from(retrievalChunks384)
      .where(eq(retrievalChunks384.embeddingSpaceId, spaceId)),
  ]);
  return {
    documentSpaces: documentSpaces.length,
    lexical: lexical.length,
    vectors: vectors.length,
  };
}

async function readActiveProjectionCounts384(
  embeddingSpaceId: string,
  sourceFile: string,
): Promise<{
  evidence: number;
  lexical: number;
  pointers: number;
  routes: number;
  vectors: number;
}> {
  const condition = (
    table: {
      embeddingSpaceId: AnyPgColumn;
      sourceFile: AnyPgColumn;
    },
  ) => and(
    eq(table.embeddingSpaceId, embeddingSpaceId),
    eq(table.sourceFile, sourceFile),
  );
  const pointerRows = await session.database
    .select({ id: indexedDocumentSpaces.documentId })
    .from(indexedDocumentSpaces)
    .where(condition(indexedDocumentSpaces));
  const vectorRows = await session.database
    .select({ id: activeRetrievalChunks384.representationId })
    .from(activeRetrievalChunks384)
    .where(condition(activeRetrievalChunks384));
  const lexicalRows = await session.database
    .select({ id: activeRetrievalLexicalChunks.representationId })
    .from(activeRetrievalLexicalChunks)
    .where(condition(activeRetrievalLexicalChunks));
  const routeRows = await session.database
    .select({ id: activeRetrievalRoutes.representationId })
    .from(activeRetrievalRoutes)
    .where(condition(activeRetrievalRoutes));
  const evidenceRows = await session.database
    .select({ id: activeRetrievalEvidence.evidenceId })
    .from(activeRetrievalEvidence)
    .where(condition(activeRetrievalEvidence));
  return {
    evidence: evidenceRows.length,
    lexical: lexicalRows.length,
    pointers: pointerRows.length,
    routes: routeRows.length,
    vectors: vectorRows.length,
  };
}

async function readExistingTableNames(tableNames: string[]): Promise<string[]> {
  const result = await session.database.execute(sql`
    SELECT "relname" AS "name"
    FROM "pg_class"
    WHERE "relname" IN (${sql.join(
      tableNames.map((tableName) => sql`${tableName}`),
      sql`, `,
    )})
    ORDER BY "relname"
  `);
  const names: string[] = [];
  for (const row of result.rows) {
    if (
      typeof row === "object"
      && row !== null
      && "name" in row
      && typeof row.name === "string"
    ) {
      names.push(row.name);
      continue;
    }
    throw new Error("PostgreSQL returned an invalid table-name row.");
  }
  return names;
}

function readTestRepresentationIds(rows: unknown[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (
      typeof row === "object"
      && row !== null
      && "representationId" in row
      && typeof row.representationId === "string"
    ) {
      ids.push(row.representationId);
      continue;
    }
    throw new Error("PostgreSQL returned an invalid retrieval row.");
  }
  return ids;
}

async function waitForTableLockWaiters(
  tableName: string,
  minimumWaiters: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await session.database.execute(sql`
      SELECT count(*)::integer AS "value"
      FROM "pg_locks"
      WHERE "relation" = to_regclass(${tableName})
        AND NOT "granted"
    `);
    const row = result.rows[0];
    if (
      typeof row === "object"
      && row !== null
      && "value" in row
      && typeof row.value === "number"
      && row.value >= minimumWaiters
    ) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(
    `Timed out waiting for ${minimumWaiters} ${tableName} lock waiters.`,
  );
}

async function waitForDatabaseLockWaiters(
  minimumWaiters: number,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await session.database.execute(sql`
      SELECT count(*)::integer AS "value"
      FROM "pg_locks"
      WHERE NOT "granted"
    `);
    const row = result.rows[0];
    if (
      typeof row === "object"
      && row !== null
      && "value" in row
      && typeof row.value === "number"
      && row.value >= minimumWaiters
    ) {
      return;
    }
    await wait(10);
  }
  throw new Error(
    `Timed out waiting for ${minimumWaiters} database lock waiters.`,
  );
}
