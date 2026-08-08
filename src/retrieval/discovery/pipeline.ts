import type { ApplicationRuntime } from "../../app/runtime.js";
import {
  DocumentCatalog,
  QueryScopeNotResolvedError,
} from "../../documents/catalog/index.js";
import type { AppConfig } from "../../config/index.js";
import {
  type DatabaseSession,
  openDatabase,
} from "../../database/client.js";
import type { RetrievedElement } from "../document-retrieval.js";
import { rerankRetrievedElementsAboveThreshold } from "../ranking/reranker.js";
import {
  prepareRetrieval,
  prepareRetrievalWithRuntime,
  type PreparedRetrieval,
} from "../pipeline.js";
import {
  ensureEmbeddingSpace,
  retrieveKeywordDiscoveryPage,
} from "../indexing/index.js";
import {
  buildExactAndRelatedSourceDiscoveryResponse,
  buildKeywordSourceDiscoveryResponse,
  type KeywordDiscoveryPage,
} from "./model.js";
import type {
  SourceDiscoveryRequest,
  SourceDiscoveryResponse,
} from "./schema.js";
import { SourceDocumentStore } from "../../documents/storage/source-document-store.js";
import type { ResolvedQueryScopeTarget } from "../../domain/query-scope.js";
import {
  createTelemetryStageResult,
  readTelemetryFailureOutcome,
  startRunTelemetry,
  type RunTelemetry,
} from "../../observability/run.js";
import { DatabaseRunTelemetrySink } from "../../observability/store.js";

const passiveAbortSignal = new AbortController().signal;

export class SourceDiscoveryUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SourceDiscoveryUnavailableError";
  }
}

export class SourceDiscoveryScopeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SourceDiscoveryScopeError";
  }
}

export async function searchIndexedSources(
  config: AppConfig,
  request: SourceDiscoveryRequest,
  reportProgress: (message: string) => void,
  abortSignal: AbortSignal = passiveAbortSignal,
): Promise<SourceDiscoveryResponse> {
  const databaseSession = await openDatabase(config.database);
  try {
    return await searchIndexedSourcesWithSession(
      config,
      databaseSession,
      request,
      reportProgress,
      abortSignal,
    );
  } finally {
    await databaseSession.close();
  }
}

export async function searchIndexedSourcesWithRuntime(
  runtime: ApplicationRuntime,
  request: SourceDiscoveryRequest,
  reportProgress: (message: string) => void,
  abortSignal: AbortSignal = passiveAbortSignal,
): Promise<SourceDiscoveryResponse> {
  return searchIndexedSourcesWithSession(
    runtime.config,
    runtime,
    request,
    reportProgress,
    abortSignal,
    runtime,
  );
}

async function searchIndexedSourcesWithSession(
  config: AppConfig,
  databaseSession: DatabaseSession,
  request: SourceDiscoveryRequest,
  reportProgress: (message: string) => void,
  abortSignal: AbortSignal,
  runtime?: ApplicationRuntime,
): Promise<SourceDiscoveryResponse> {
  const telemetrySink = config.inferenceMetrics.enabled
    ? new DatabaseRunTelemetrySink(databaseSession.database)
    : null;
  const runTelemetry = await startRunTelemetry(
    config,
    "search",
    telemetrySink,
  );
  try {
    abortSignal.throwIfAborted();
    if (runtime === undefined) {
      await ensureEmbeddingSpace(databaseSession.database, config.embeddingSpace);
    }
    const catalog = new DocumentCatalog(databaseSession.database);
    const scopeStage = runTelemetry.startStage({
      model: null,
      name: "scope-resolution",
      retrievalMode: config.retrieval.mode,
    });
    let scopeTargets: ResolvedQueryScopeTarget[];
    try {
      scopeTargets = await resolveDiscoveryScopeTargets(
        catalog,
        request,
        config.embeddingSpace.id,
      );
      await scopeStage.finish(createTelemetryStageResult("success", {
        outputCount: scopeTargets.length,
      }));
    } catch (error: unknown) {
      await scopeStage.finish(createTelemetryStageResult("error"));
      throw error;
    }
    runTelemetry.setScopeSize(scopeTargets.length);
    abortSignal.throwIfAborted();
    if (scopeTargets.length === 0) {
      runTelemetry.setQueryVariantCount(0);
      runTelemetry.setCandidateCount(0);
      runTelemetry.setHydratedContextCount(0);
      const response = buildEmptySourceDiscoveryResponse(
        request,
        config.sourceDiscovery,
      );
      await runTelemetry.finish("success");
      return response;
    }

    let response: SourceDiscoveryResponse;
    try {
      if (request.includeRelated) {
        const documentStore = new SourceDocumentStore(databaseSession.database);
        const keywordPage = await retrieveKeywordDiscovery(
          config,
          databaseSession,
          documentStore,
          request,
          scopeTargets,
          runTelemetry,
        );
        const related = await retrieveRelatedDiscoveryElements(
          config,
          databaseSession,
          request,
          reportProgress,
          abortSignal,
          runTelemetry,
          runtime,
        );
        response = buildExactAndRelatedSourceDiscoveryResponse({
          keywordPage,
          matchedElements: related.matchedElements,
          request,
          reviewedPassageCount: related.reviewedPassageCount,
          settings: config.sourceDiscovery,
        });
      } else {
        const documentStore = new SourceDocumentStore(databaseSession.database);
        const keywordPage = await retrieveKeywordDiscovery(
          config,
          databaseSession,
          documentStore,
          request,
          scopeTargets,
          runTelemetry,
        );
        runTelemetry.setQueryVariantCount(1);
        runTelemetry.setCandidateCount(keywordPage.matches.length);
        runTelemetry.setHydratedContextCount(keywordPage.matches.length);
        response = buildKeywordSourceDiscoveryResponse({
          keywordPage,
          request,
          settings: config.sourceDiscovery,
        });
      }
    } catch (error: unknown) {
      abortSignal.throwIfAborted();
      throw new SourceDiscoveryUnavailableError(
        `Source discovery failed: ${readErrorMessage(error)}`,
      );
    }
    await runTelemetry.finish("success");
    return response;
  } catch (error: unknown) {
    await runTelemetry.finish(readTelemetryFailureOutcome(abortSignal));
    throw error;
  }
}

async function resolveDiscoveryScopeTargets(
  catalog: DocumentCatalog,
  request: SourceDiscoveryRequest,
  embeddingSpaceId: string,
): Promise<ResolvedQueryScopeTarget[]> {
  try {
    return await catalog.resolveQueryScope(request.scope, embeddingSpaceId);
  } catch (error: unknown) {
    if (error instanceof QueryScopeNotResolvedError) {
      throw new SourceDiscoveryScopeError(error.message);
    }
    throw error;
  }
}

interface RelatedDiscoveryElements {
  matchedElements: RetrievedElement[];
  reviewedPassageCount: number;
}

async function retrieveRelatedDiscoveryElements(
  config: AppConfig,
  databaseSession: DatabaseSession,
  request: SourceDiscoveryRequest,
  reportProgress: (message: string) => void,
  abortSignal: AbortSignal,
  runTelemetry: RunTelemetry,
  runtime?: ApplicationRuntime,
): Promise<RelatedDiscoveryElements> {
  const retrieval = {
    ...config.retrieval,
    mode: "dense" as const,
    topK: config.retrieval.candidateK,
  };
  const discoveryConfig = { ...config, retrieval };
  let prepared: PreparedRetrieval;
  if (runtime === undefined) {
    prepared = await prepareRetrieval(
      discoveryConfig,
      databaseSession,
      request.query,
      reportProgress,
      request.scope,
      abortSignal,
      runTelemetry,
      "interactive-search",
      { applyReranking: false },
    );
  } else {
    prepared = await prepareRetrievalWithRuntime(
      runtime,
      request.query,
      reportProgress,
      request.scope,
      abortSignal,
      runTelemetry,
      discoveryConfig,
      "interactive-search",
      { applyReranking: false },
    );
  }
  if (prepared.retrieved.length === 0) {
    return { matchedElements: [], reviewedPassageCount: 0 };
  }
  if (prepared.models.reranker === null) {
    throw new Error("The configured reranker model was not resolved.");
  }
  if (config.retrieval.reranker === null) {
    throw new Error("The configured reranker settings were not resolved.");
  }
  if (prepared.rerankingScheduler === null) {
    throw new Error("The configured reranker provider scheduler was not resolved.");
  }
  const reranker = prepared.models.reranker;
  const rerankingScheduler = prepared.rerankingScheduler;
  const minimumRelevanceScore = config.retrieval.reranker.discoveryMinimumScore;
  const rerankingStage = runTelemetry.startStage({
    model: {
      modelId: reranker.model.modelId,
      provider: reranker.model.provider,
    },
    name: "reranking",
    retrievalMode: "dense",
  });
  try {
    const reranked = await rerankingScheduler.run(
      (requestSignal) => rerankRetrievedElementsAboveThreshold(
        reranker,
        request.query,
        prepared.retrieved,
        config.retrieval.candidateK,
        minimumRelevanceScore,
        requestSignal,
      ),
      abortSignal,
      rerankingStage.timingObserver,
    );
    await rerankingStage.finish(createTelemetryStageResult("success", {
      inputCount: prepared.retrieved.length,
      outputCount: reranked.length,
    }));
    runTelemetry.setHydratedContextCount(reranked.length);
    return {
      matchedElements: reranked,
      reviewedPassageCount: prepared.retrieved.length,
    };
  } catch (error: unknown) {
    await rerankingStage.finish(createTelemetryStageResult(
      readTelemetryFailureOutcome(abortSignal),
      { inputCount: prepared.retrieved.length },
    ));
    throw error;
  }
}

async function retrieveKeywordDiscovery(
  config: AppConfig,
  databaseSession: DatabaseSession,
  documentStore: SourceDocumentStore,
  request: SourceDiscoveryRequest,
  scopeTargets: ResolvedQueryScopeTarget[],
  runTelemetry: RunTelemetry,
): Promise<KeywordDiscoveryPage> {
  const stage = runTelemetry.startStage({
    model: null,
    name: "lexical-retrieval",
    retrievalMode: "bm25",
  });
  try {
    const result = await retrieveKeywordDiscoveryPage(
      databaseSession.query,
      documentStore,
      request.query,
      config.embeddingSpace.id,
      scopeTargets,
      request.keywordPage,
      config.sourceDiscovery.resultsPerGroup,
      config.sourceDiscovery.passagesPerDocument,
    );
    await stage.finish(createTelemetryStageResult("success", {
      inputCount: scopeTargets.length,
      outputCount: result.matches.length,
    }));
    return result;
  } catch (error: unknown) {
    await stage.finish(createTelemetryStageResult("error", {
      inputCount: scopeTargets.length,
    }));
    throw error;
  }
}

function buildEmptySourceDiscoveryResponse(
  request: SourceDiscoveryRequest,
  settings: AppConfig["sourceDiscovery"],
): SourceDiscoveryResponse {
  if (request.includeRelated) {
    return buildExactAndRelatedSourceDiscoveryResponse({
      keywordPage: { matches: [], totalDocuments: 0 },
      matchedElements: [],
      request,
      reviewedPassageCount: 0,
      settings,
    });
  }
  return buildKeywordSourceDiscoveryResponse({
    keywordPage: { matches: [], totalDocuments: 0 },
    request,
    settings,
  });
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
