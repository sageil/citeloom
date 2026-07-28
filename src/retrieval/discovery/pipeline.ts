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
  readKeywordMatchingDocumentKeys,
  retrieveKeywordDiscoveryPage,
} from "../indexing/index.js";
import {
  buildSourceDiscoveryResponse,
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

const DISCOVERY_PASSAGES_PER_DOCUMENT = 3;
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
      const response = buildEmptySourceDiscoveryResponse(request);
      await runTelemetry.finish("success");
      return response;
    }

    const documentStore = new SourceDocumentStore(databaseSession.database);
    const keywordPromise = retrieveKeywordDiscovery(
      config,
      databaseSession,
      documentStore,
      request,
      scopeTargets,
      runTelemetry,
    );
    const relatedPromise = request.includeRelated
      ? retrieveRelatedDiscoveryElements(
          config,
          databaseSession,
          request,
          reportProgress,
          abortSignal,
          runTelemetry,
          runtime,
        )
      : Promise.resolve<RetrievedElement[]>([]);
    const [keywordResult, relatedResult] = await Promise.allSettled([
      keywordPromise,
      relatedPromise,
    ]);
    abortSignal.throwIfAborted();

    requireAvailableDiscoveryPath(request, keywordResult, relatedResult);
    await recordPartialDiscoveryFallback(
      scopeTargets.length,
      keywordResult,
      relatedResult,
      runTelemetry,
    );
    const keywordPage: KeywordDiscoveryPage = keywordResult.status === "fulfilled"
      ? keywordResult.value[0]
      : { matches: [], totalDocuments: 0 };
    const lexicalDocumentKeys = keywordResult.status === "fulfilled"
      ? keywordResult.value[1]
      : new Set<string>();
    const relatedElements = relatedResult.status === "fulfilled"
      ? relatedResult.value
      : [];
    if (!request.includeRelated) {
      runTelemetry.setQueryVariantCount(1);
    }
    const hydratedResultCount = keywordPage.matches.length
      + relatedElements.length;
    runTelemetry.setCandidateCount(hydratedResultCount);
    runTelemetry.setHydratedContextCount(hydratedResultCount);
    const response = buildSourceDiscoveryResponse({
      keyword: readKeywordDiscoveryState(keywordResult),
      keywordPage,
      lexicalDocumentKeys,
      related: readRelatedDiscoveryState(request, relatedResult),
      relatedElements,
      request,
    });
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

function requireAvailableDiscoveryPath(
  request: SourceDiscoveryRequest,
  keywordResult: PromiseSettledResult<[KeywordDiscoveryPage, Set<string>]>,
  relatedResult: PromiseSettledResult<RetrievedElement[]>,
): void {
  const everyRequestedPathFailed = keywordResult.status === "rejected"
    && (!request.includeRelated || relatedResult.status === "rejected");
  if (!everyRequestedPathFailed) {
    return;
  }
  const relatedError = relatedResult.status === "rejected"
    ? `; ${readErrorMessage(relatedResult.reason)}`
    : "";
  throw new SourceDiscoveryUnavailableError(
    `Source discovery failed: ${readErrorMessage(keywordResult.reason)}${relatedError}`,
  );
}

function readKeywordDiscoveryState(
  result: PromiseSettledResult<[KeywordDiscoveryPage, Set<string>]>,
): { status: "complete" | "unavailable"; warning: string | null } {
  if (result.status === "fulfilled") {
    return { status: "complete", warning: null };
  }
  return {
    status: "unavailable",
    warning: `Keyword search was unavailable: ${readErrorMessage(result.reason)}`,
  };
}

async function retrieveRelatedDiscoveryElements(
  config: AppConfig,
  databaseSession: DatabaseSession,
  request: SourceDiscoveryRequest,
  reportProgress: (message: string) => void,
  abortSignal: AbortSignal,
  runTelemetry: RunTelemetry,
  runtime?: ApplicationRuntime,
): Promise<RetrievedElement[]> {
  const resultLimit = Math.min(50, Math.max(
    request.relatedLimit,
    request.relatedLimit * DISCOVERY_PASSAGES_PER_DOCUMENT,
  ));
  const candidateLimit = Math.min(config.retrieval.candidateK, 50);
  const retrieval = {
    ...config.retrieval,
    mode: "dense" as const,
    topK: candidateLimit,
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
    );
  }
  if (prepared.retrieved.length === 0) {
    return [];
  }
  if (config.retrieval.mode !== "hybrid-reranked") {
    throw new Error(
      "Semantic discovery requires a configured reranker with a calibrated relevance threshold.",
    );
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
    retrievalMode: "hybrid-reranked",
  });
  try {
    const reranked = await rerankingScheduler.run(
      (requestSignal) => rerankRetrievedElementsAboveThreshold(
        reranker,
        request.query,
        prepared.retrieved,
        resultLimit,
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
    return reranked;
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
): Promise<[KeywordDiscoveryPage, Set<string>]> {
  const stage = runTelemetry.startStage({
    model: null,
    name: "lexical-retrieval",
    retrievalMode: config.retrieval.mode,
  });
  try {
    const result = await Promise.all([
      retrieveKeywordDiscoveryPage(
        databaseSession.query,
        documentStore,
        request.query,
        config.embeddingSpace.id,
        scopeTargets,
        request.keywordPage,
        request.keywordPageSize,
        DISCOVERY_PASSAGES_PER_DOCUMENT,
      ),
      readKeywordMatchingDocumentKeys(
        databaseSession.query,
        request.query,
        config.embeddingSpace.id,
        scopeTargets,
      ),
    ]);
    await stage.finish(createTelemetryStageResult("success", {
      inputCount: scopeTargets.length,
      outputCount: result[0].matches.length,
    }));
    return result;
  } catch (error: unknown) {
    await stage.finish(createTelemetryStageResult("error", {
      inputCount: scopeTargets.length,
    }));
    throw error;
  }
}

async function recordPartialDiscoveryFallback(
  documentCount: number,
  keywordResult: PromiseSettledResult<[KeywordDiscoveryPage, Set<string>]>,
  relatedResult: PromiseSettledResult<RetrievedElement[]>,
  runTelemetry: RunTelemetry,
): Promise<void> {
  let name: "dense-retrieval" | "lexical-retrieval" | null = null;
  let retrievalMode: "bm25" | "dense" | null = null;
  if (keywordResult.status === "rejected") {
    name = "lexical-retrieval";
    retrievalMode = "bm25";
  } else if (relatedResult.status === "rejected") {
    name = "dense-retrieval";
    retrievalMode = "dense";
  }
  if (name === null || retrievalMode === null) {
    return;
  }
  const stage = runTelemetry.startStage({
    model: null,
    name,
    retrievalMode,
  });
  await stage.finish(createTelemetryStageResult("fallback", {
    inputCount: documentCount,
  }));
  if (relatedResult.status === "rejected") {
    runTelemetry.setQueryVariantCount(1);
  }
}

function buildEmptySourceDiscoveryResponse(
  request: SourceDiscoveryRequest,
): SourceDiscoveryResponse {
  return buildSourceDiscoveryResponse({
    keyword: { status: "complete", warning: null },
    keywordPage: { matches: [], totalDocuments: 0 },
    lexicalDocumentKeys: new Set(),
    related: request.includeRelated
      ? { status: "complete", warning: null }
      : { status: "disabled", warning: null },
    relatedElements: [],
    request,
  });
}

function readRelatedDiscoveryState(
  request: SourceDiscoveryRequest,
  result: PromiseSettledResult<RetrievedElement[]>,
): { status: "complete" | "disabled" | "unavailable"; warning: string | null } {
  if (!request.includeRelated) {
    return { status: "disabled", warning: null };
  }
  if (result.status === "fulfilled") {
    return { status: "complete", warning: null };
  }
  return {
    status: "unavailable",
    warning: `Semantic search was unavailable: ${readErrorMessage(result.reason)}`,
  };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
