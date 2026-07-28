import { hostname } from "node:os";

import {
  createUIMessageStream,
  type InferUIMessageChunk,
  type UIMessageStreamWriter,
} from "ai";

import {
  createRuntimeTaskScheduler,
  type ApplicationRuntime,
} from "../app/runtime.js";
import type {
  CiteLoomUIMessage,
  StreamedAnswer,
} from "../answers/stream.js";
import type {
  AnswerResult,
  GeneratedAnswerResult,
} from "../answers/inference.js";
import { verifyPublishedAnswer } from "../answers/claim-verification.js";
import { DocumentCatalog } from "../documents/catalog/index.js";
import type { TaskScheduler } from "../shared/concurrency.js";
import type {
  AppConfig,
  RetrievalMode,
  WorkloadClass,
} from "../config/index.js";
import {
  type CiteLoomDatabase,
  type DatabaseSession,
  openDatabase,
} from "../database/client.js";
import type { RetrievedElement } from "./document-retrieval.js";
import {
  createInferenceModelRegistry,
  type InferenceModelRegistry,
} from "../inference/registry.js";
import {
  InferenceCoordinator,
  InferenceLeaseLostError,
} from "../inference/coordinator.js";
import { InferenceFeatureTimeoutError } from "../inference/request.js";
import { HhemClientError } from "../verification/hhem-client.js";
import { RerankingTimeoutError } from "./ranking/reranker.js";
import {
  applyVerifiedAnswerPublication,
  answerQuestion,
  createNoRelevantAnswer,
  streamAnswerQuestion,
} from "../answers/inference.js";
import { embedQuestions } from "../embedding/inference.js";
import { expandRetrievalQuery } from "./query-expansion.js";
import type { QueryExpansionGenerationSettings } from "./query-expansion.js";
import type {
  QueryScope,
  ResolvedQueryScopeTarget,
} from "../domain/query-scope.js";
import type { ClaimVerificationResult } from "../research/types.js";
import type { ResearchRetrievalTrace } from "../research/types.js";
import {
  createTurnGenerationSettings,
  type TurnGenerationSettings,
} from "../inference/generation-settings.js";
import {
  ensureEmbeddingSpace,
  retrieveRelevantElementsWithScores,
  retrievalModeUsesDense,
  type RetrievalQuery,
} from "./indexing/index.js";
import { SourceDocumentStore } from "../documents/storage/source-document-store.js";
import {
  createTelemetryStageResult,
  noopRunTelemetry,
  readTelemetryFailureOutcome,
  startRunTelemetry,
  type RunTelemetry,
  type TelemetryRunSnapshot,
  type TelemetryStageName,
  type TelemetryRunKind,
} from "../observability/run.js";
import {
  ApplicationErrorReporter,
  readApplicationErrorId,
  reportApplicationErrorToContainerLog,
} from "../observability/application-errors.js";
import { DatabaseRunTelemetrySink } from "../observability/store.js";
import {
  buildResearchRunConfiguration,
  ResearchStore,
} from "../research/store.js";

export interface PreparedRetrieval {
  answerScheduler: TaskScheduler;
  generationSettings: TurnGenerationSettings;
  models: InferenceModelRegistry;
  rerankingScheduler: TaskScheduler | null;
  retrievalTrace: ResearchRetrievalTrace;
  retrieved: RetrievedElement[];
}

function createRetrievalTrace(
  generation: TurnGenerationSettings,
  queryTexts: readonly string[],
  retrieved: readonly RetrievedElement[],
): ResearchRetrievalTrace {
  const queries: ResearchRetrievalTrace["queries"] = [];
  for (let index = 0; index < queryTexts.length; index += 1) {
    const text = queryTexts[index];
    if (text === undefined) {
      continue;
    }
    queries.push({
      kind: index === 0 ? "original" : "expansion",
      text,
    });
  }
  const orderedSources: ResearchRetrievalTrace["orderedSources"] = [];
  for (let index = 0; index < retrieved.length; index += 1) {
    const item = retrieved[index];
    if (item === undefined) {
      continue;
    }
    orderedSources.push({
      documentId: item.element.documentId,
      documentVersionId: item.documentVersionId,
      evidenceSha256: item.provenance.evidenceSha256,
      elementId: item.element.id,
      rank: index + 1,
      representationHits: item.provenance.representationHits,
      retrievalWindowId: item.provenance.retrievalWindowId,
      sourceFile: item.element.sourceFile,
      descriptionAffected: item.provenance.descriptionAffected,
    });
  }
  return {
    generation,
    orderedSources,
    queries,
    version: 3,
  };
}

const passiveAbortSignal = new AbortController().signal;
const maximumLoggedAnswerErrorMessageCharacters = 500;

export async function askIndexedDocuments(
  config: AppConfig,
  question: string,
  reportProgress: (message: string) => void,
  scope: QueryScope = { kind: "all" },
): Promise<AnswerResult> {
  const databaseSession = await openDatabase(config.database);
  const runTelemetry = await createDatabaseRunTelemetry(
    config,
    databaseSession,
    "answer",
  );
  try {
    const prepared = await prepareRetrieval(
      config,
      databaseSession,
      question,
      reportProgress,
      scope,
      passiveAbortSignal,
      runTelemetry,
      "interactive-answer",
    );
    if (prepared.retrieved.length === 0) {
      await runTelemetry.finish("success");
      return createNoRelevantAnswer();
    }
    reportProgress("Generating an answer from the retrieved multimodal context");
    let result = await answerQuestion(
      prepared.models,
      question,
      prepared.retrieved,
      prepared.answerScheduler,
      prepared.generationSettings.answer,
      runTelemetry,
    );
    if (result.outcome === "answered") {
      reportProgress("Verifying factual claims against cited evidence");
      const verified = await verifyPublishedAnswer(
        prepared.models,
        result.answerDocument,
        prepared.answerScheduler,
        passiveAbortSignal,
        runTelemetry,
      );
      result = applyVerifiedAnswerPublication(
        result,
        verified.answerDocument,
      );
    }
    await runTelemetry.finish("success");
    return result;
  } catch (error: unknown) {
    await runTelemetry.finish("error");
    throw error;
  } finally {
    await databaseSession.close();
  }
}

export function streamIndexedDocumentAnswer(
  config: AppConfig,
  question: string,
  reportProgress: (message: string) => void,
  scope: QueryScope,
  threadId: string,
  abortSignal: AbortSignal,
): ReadableStream<InferUIMessageChunk<CiteLoomUIMessage>> {
  return createUIMessageStream<CiteLoomUIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: "start" });
      let databaseSession: DatabaseSession | null = null;
      try {
        const openedSession = await openDatabase(config.database);
        databaseSession = openedSession;
        await writeStreamedAnswer(
          config,
          openedSession,
          question,
          scope,
          threadId,
          reportProgress,
          abortSignal,
          writer,
          async (runTelemetry) => prepareRetrieval(
            config,
            openedSession,
            question,
            reportProgress,
            scope,
            abortSignal,
            runTelemetry,
            "interactive-answer",
          ),
        );
      } catch (error: unknown) {
        await reportUntrackedAnswerStreamFailure(
          databaseSession?.database ?? null,
          error,
          abortSignal,
        );
        throw error;
      } finally {
        await databaseSession?.close();
      }
    },
    onError: readAnswerStreamError,
  });
}

export function streamIndexedDocumentAnswerWithRuntime(
  runtime: ApplicationRuntime,
  question: string,
  reportProgress: (message: string) => void,
  scope: QueryScope,
  threadId: string,
  abortSignal: AbortSignal,
): ReadableStream<InferUIMessageChunk<CiteLoomUIMessage>> {
  return createUIMessageStream<CiteLoomUIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: "start" });
      try {
        await writeStreamedAnswer(runtime.config, runtime, question, scope, threadId, reportProgress, abortSignal, writer,
          async (runTelemetry) => prepareRetrievalWithRuntime(
            runtime,
            question,
            reportProgress,
            scope,
            abortSignal,
            runTelemetry,
            runtime.config,
            "interactive-answer",
          ),
        );
      } catch (error: unknown) {
        await reportUntrackedAnswerStreamFailure(
          runtime.database,
          error,
          abortSignal,
        );
        throw error;
      }
    },
    onError: readAnswerStreamError,
  });
}

export async function retrieveIndexedDocuments(
  config: AppConfig,
  question: string,
  reportProgress: (message: string) => void,
  scope: QueryScope = { kind: "all" },
  workload: WorkloadClass = "interactive-search",
): Promise<RetrievedElement[]> {
  const databaseSession = await openDatabase(config.database);
  const runTelemetry = await createDatabaseRunTelemetry(
    config,
    databaseSession,
    "retrieval",
  );
  try {
    const prepared = await prepareRetrieval(
      config,
      databaseSession,
      question,
      reportProgress,
      scope,
      passiveAbortSignal,
      runTelemetry,
      workload,
    );
    await runTelemetry.finish("success");
    return prepared.retrieved;
  } catch (error: unknown) {
    await runTelemetry.finish("error");
    throw error;
  } finally {
    await databaseSession.close();
  }
}

export async function prepareRetrieval(
  config: AppConfig,
  databaseSession: DatabaseSession,
  question: string,
  reportProgress: (message: string) => void,
  scope: QueryScope,
  abortSignal: AbortSignal,
  runTelemetry: RunTelemetry = noopRunTelemetry,
  workload: WorkloadClass = "interactive-search",
): Promise<PreparedRetrieval> {
  abortSignal.throwIfAborted();
  await ensureEmbeddingSpace(databaseSession.database, config.embeddingSpace);
  const coordinator = new InferenceCoordinator(databaseSession.database);
  await coordinator.configure(config.scheduling);
  const embeddingScheduler = createRuntimeTaskScheduler(
    config,
    coordinator,
    "embedding",
    workload,
  );
  const answerScheduler = createRuntimeTaskScheduler(
    config,
    coordinator,
    "answer",
    workload,
  );
  const queryExpansionScheduler = createRuntimeTaskScheduler(
    config,
    coordinator,
    "queryExpansion",
    workload,
  );
  const rerankingScheduler = config.retrieval.reranker === null
    ? null
    : createRuntimeTaskScheduler(
      config,
      coordinator,
      "reranking",
      workload,
    );
  const models = createInferenceModelRegistry(config, databaseSession.database);
  return prepareRetrievalWithResources(
    config,
    databaseSession,
    models,
    answerScheduler,
    embeddingScheduler,
    queryExpansionScheduler,
    rerankingScheduler,
    question,
    reportProgress,
    scope,
    abortSignal,
    runTelemetry,
  );
}

export async function prepareRetrievalWithRuntime(
  runtime: ApplicationRuntime,
  question: string,
  reportProgress: (message: string) => void,
  scope: QueryScope,
  abortSignal: AbortSignal,
  runTelemetry: RunTelemetry = noopRunTelemetry,
  config: AppConfig = runtime.config,
  workload: WorkloadClass = "interactive-search",
): Promise<PreparedRetrieval> {
  return prepareRetrievalWithResources(
    config,
    runtime,
    runtime.models,
    runtime.scheduler("answer", workload),
    runtime.scheduler("embedding", workload),
    runtime.scheduler("queryExpansion", workload),
    config.retrieval.reranker === null
      ? null
      : runtime.scheduler("reranking", workload),
    question,
    reportProgress,
    scope,
    abortSignal,
    runTelemetry,
  );
}

async function prepareRetrievalWithResources(
  config: AppConfig,
  databaseSession: DatabaseSession,
  models: InferenceModelRegistry,
  answerScheduler: TaskScheduler,
  embeddingScheduler: TaskScheduler,
  queryExpansionScheduler: TaskScheduler,
  rerankingScheduler: TaskScheduler | null,
  question: string,
  reportProgress: (message: string) => void,
  scope: QueryScope,
  abortSignal: AbortSignal,
  runTelemetry: RunTelemetry,
): Promise<PreparedRetrieval> {
  const catalog = new DocumentCatalog(databaseSession.database);
  const scopeStage = runTelemetry.startStage({
    model: null,
    name: "scope-resolution",
    retrievalMode: config.retrieval.mode,
  });
  let scopeTargets: ResolvedQueryScopeTarget[];
  try {
    scopeTargets = await catalog.resolveQueryScope(
      scope,
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
  const generationSettings = createTurnGenerationSettings(
    config.retrieval,
    question,
    scopeTargets,
  );
  abortSignal.throwIfAborted();
  if (scopeTargets.length === 0) {
    runTelemetry.setQueryVariantCount(0);
    runTelemetry.setCandidateCount(0);
    runTelemetry.setHydratedContextCount(0);
    return {
      answerScheduler,
      generationSettings,
      models,
      rerankingScheduler,
      retrievalTrace: createRetrievalTrace(generationSettings, [question], []),
      retrieved: [],
    };
  }

  const queries = await prepareRetrievalQueries(
    config,
    models,
    question,
    reportProgress,
    embeddingScheduler,
    queryExpansionScheduler,
    abortSignal,
    generationSettings.queryExpansion,
    runTelemetry,
  );
  const retrievalMode = readRetrievalModeLabel(config.retrieval.mode);
  reportProgress(
    `Retrieving ${config.retrieval.candidateK} candidates with ${retrievalMode} from ${scopeTargets.length} source(s)`,
  );
  const documentStore = new SourceDocumentStore(databaseSession.database);
  const retrieval = await retrieveRelevantElementsWithScores(
    databaseSession.database,
    databaseSession.query,
    documentStore,
    config.embeddingSpace,
    question,
    queries,
    config.retrieval,
    scopeTargets,
    models.reranker,
    rerankingScheduler,
    abortSignal,
    runTelemetry,
  );
  abortSignal.throwIfAborted();
  if (
    retrieval.rerankerModelId !== null
    && retrieval.strongestRerankerScore !== null
  ) {
    runTelemetry.recordRerankerRankingScore(
      retrieval.rerankerModelId,
      retrieval.strongestRerankerScore,
    );
  }
  return {
    answerScheduler,
    generationSettings,
    models,
    rerankingScheduler,
    retrievalTrace: createRetrievalTrace(
      generationSettings,
      queries.map((query) => query.text),
      retrieval.retrieved,
    ),
    retrieved: retrieval.retrieved,
  };
}

export async function prepareRetrievalQueries(
  config: AppConfig,
  models: InferenceModelRegistry,
  question: string,
  reportProgress: (message: string) => void,
  embeddingScheduler: TaskScheduler,
  queryExpansionScheduler: TaskScheduler,
  abortSignal: AbortSignal,
  generationSettings: QueryExpansionGenerationSettings,
  runTelemetry: RunTelemetry = noopRunTelemetry,
): Promise<RetrievalQuery[]> {
  return prepareRetrievalQueriesWithGenerationSettings(
    config,
    models,
    question,
    reportProgress,
    embeddingScheduler,
    queryExpansionScheduler,
    abortSignal,
    generationSettings,
    runTelemetry,
  );
}

export async function prepareRetrievalQueriesWithSeed(
  config: AppConfig,
  models: InferenceModelRegistry,
  question: string,
  reportProgress: (message: string) => void,
  embeddingScheduler: TaskScheduler,
  queryExpansionScheduler: TaskScheduler,
  abortSignal: AbortSignal,
  generationSeed: number,
  runTelemetry: RunTelemetry = noopRunTelemetry,
): Promise<RetrievalQuery[]> {
  const generationSettings: QueryExpansionGenerationSettings = {
    seed: generationSeed,
    temperature: 0,
  };
  return prepareRetrievalQueriesWithGenerationSettings(
    config,
    models,
    question,
    reportProgress,
    embeddingScheduler,
    queryExpansionScheduler,
    abortSignal,
    generationSettings,
    runTelemetry,
  );
}

async function prepareRetrievalQueriesWithGenerationSettings(
  config: AppConfig,
  models: InferenceModelRegistry,
  question: string,
  reportProgress: (message: string) => void,
  embeddingScheduler: TaskScheduler,
  queryExpansionScheduler: TaskScheduler,
  abortSignal: AbortSignal,
  generationSettings: QueryExpansionGenerationSettings | undefined,
  runTelemetry: RunTelemetry,
): Promise<RetrievalQuery[]> {
  const queryTexts = await buildRetrievalQueries(
    config,
    models,
    question,
    reportProgress,
    queryExpansionScheduler,
    abortSignal,
    generationSettings,
    runTelemetry,
  );
  runTelemetry.setQueryVariantCount(queryTexts.length);
  return embedRetrievalQueries(
    config,
    models,
    queryTexts,
    reportProgress,
    embeddingScheduler,
    abortSignal,
    runTelemetry,
  );
}

async function buildRetrievalQueries(
  config: AppConfig,
  models: InferenceModelRegistry,
  question: string,
  reportProgress: (message: string) => void,
  queryExpansionScheduler: TaskScheduler,
  abortSignal: AbortSignal,
  generationSettings: QueryExpansionGenerationSettings | undefined,
  runTelemetry: RunTelemetry,
): Promise<string[]> {
  const queryTexts = [question];
  if (config.retrieval.queryExpansions <= 0) {
    return queryTexts;
  }
  reportProgress("Expanding the retrieval query");
  try {
    const expansions = await expandRetrievalQuery(
      models,
      question,
      config.retrieval.queryExpansions,
      queryExpansionScheduler,
      abortSignal,
      generationSettings,
      runTelemetry,
    );
    queryTexts.push(...expansions);
  } catch (error: unknown) {
    abortSignal.throwIfAborted();
    reportProgress(
      `Query expansion was unavailable, so retrieval is using the original question: ${readErrorMessage(error)}`,
    );
  }
  return queryTexts;
}

async function embedRetrievalQueries(
  config: AppConfig,
  models: InferenceModelRegistry,
  queryTexts: string[],
  reportProgress: (message: string) => void,
  embeddingScheduler: TaskScheduler,
  abortSignal: AbortSignal,
  runTelemetry: RunTelemetry,
): Promise<RetrievalQuery[]> {
  let embeddings: number[][] = [];
  if (retrievalModeUsesDense(config.retrieval.mode)) {
    reportProgress(`Embedding ${queryTexts.length} retrieval query variants`);
    embeddings = await embedQuestions(
      models,
      queryTexts,
      embeddingScheduler,
      abortSignal,
      runTelemetry,
    );
  }
  const queries: RetrievalQuery[] = [];
  for (let index = 0; index < queryTexts.length; index += 1) {
    const text = queryTexts[index];
    if (text === undefined) {
      throw new Error(`Missing retrieval query at index ${index}.`);
    }
    let embedding: number[] | null = null;
    if (retrievalModeUsesDense(config.retrieval.mode)) {
      embedding = embeddings[index] ?? null;
      if (embedding === null) {
        throw new Error(`Missing retrieval query embedding at index ${index}.`);
      }
    }
    queries.push({ embedding, text });
    abortSignal.throwIfAborted();
  }
  return queries;
}

async function createDatabaseRunTelemetry(
  config: AppConfig,
  databaseSession: DatabaseSession,
  kind: TelemetryRunKind,
): Promise<RunTelemetry> {
  const sink = config.inferenceMetrics.enabled
    ? new DatabaseRunTelemetrySink(databaseSession.database)
    : null;
  return startRunTelemetry(config, kind, sink);
}

export async function writeStreamedAnswer(
  config: AppConfig,
  databaseSession: DatabaseSession,
  question: string,
  scope: QueryScope,
  threadId: string,
  reportProgress: (message: string) => void,
  abortSignal: AbortSignal,
  writer: UIMessageStreamWriter<CiteLoomUIMessage>,
  prepare: (runTelemetry: RunTelemetry) => Promise<PreparedRetrieval>,
): Promise<void> {
  const runTelemetry = await createDatabaseRunTelemetry(
    config,
    databaseSession,
    "answer",
  );
  runTelemetry.markStreamStarted();
  const researchRunId = runTelemetry.runId;
  if (researchRunId === null) {
    throw new Error("Answer telemetry did not create a run ID.");
  }
  const researchStore = new ResearchStore(databaseSession.database, config);
  let runFinished = false;
  try {
    abortSignal.throwIfAborted();
    const prepared = await prepare(runTelemetry);
    let result: GeneratedAnswerResult;
    if (prepared.retrieved.length === 0) {
      result = createNoRelevantAnswer();
    } else {
      reportProgress("Generating an answer from the retrieved multimodal context");
      result = await streamAnswerQuestion(
        prepared.models,
        question,
        prepared.retrieved,
        prepared.answerScheduler,
        abortSignal,
        prepared.generationSettings.answer,
        runTelemetry,
      );
    }
    let verifiedClaims: ClaimVerificationResult[] = [];
    if (result.outcome === "answered") {
      reportProgress("Verifying factual claims against cited evidence");
      const verified = await verifyPublishedAnswer(
        prepared.models,
        result.answerDocument,
        prepared.answerScheduler,
        abortSignal,
        runTelemetry,
      );
      verifiedClaims = verified.claims;
      result = applyVerifiedAnswerPublication(
        result,
        verified.answerDocument,
      );
    }
    abortSignal.throwIfAborted();
    const turn = await researchStore.saveTurn({
      answerDocument: result.answerDocument,
      claims: verifiedClaims,
      completedAt: new Date(),
      question,
      retrievedContext: result.matchedDocuments,
      retrievalTrace: prepared.retrievalTrace,
      runConfiguration: buildResearchRunConfiguration(config),
      runId: researchRunId,
      scope,
      threadId,
    }, abortSignal);
    abortSignal.throwIfAborted();
    let streamedRunDetails: StreamedAnswer["runDetails"] = null;
    if (result.runDetails !== null) {
      streamedRunDetails = {
        ...result.runDetails,
        sourceCount: result.sources.length,
      };
    }
    const streamedAnswer: StreamedAnswer = {
      answerDocument: turn.answerDocument,
      claims: turn.claims,
      matchedDocuments: result.matchedDocuments,
      runDetails: streamedRunDetails,
      turn: {
        runId: turn.runId,
        sequence: turn.sequence,
        threadId: turn.threadId,
        turnId: turn.id,
      },
    };
    runTelemetry.markStreamCompleted();
    await runTelemetry.finish("success");
    runFinished = true;
    writer.write({
      data: streamedAnswer,
      id: "answer",
      type: "data-answer",
    });
    writer.write({ finishReason: "stop", type: "finish" });
  } catch (error: unknown) {
    let runSnapshot: TelemetryRunSnapshot | null = null;
    if (!runFinished) {
      runTelemetry.markStreamCompleted();
      const outcome = readTelemetryFailureOutcome(abortSignal);
      runSnapshot = await runTelemetry.finish(outcome);
      if (outcome === "error") {
        await reportAnswerStreamFailure(
          databaseSession.database,
          error,
          researchRunId,
          runSnapshot,
        );
      }
    }
    throw error;
  }
}

function readRetrievalModeLabel(mode: RetrievalMode): string {
  if (mode === "bm25") {
    return "BM25 search";
  }
  if (mode === "dense") {
    return "vector search";
  }
  if (mode === "hybrid") {
    return "BM25 and vector search with RRF";
  }
  return "BM25 and vector search with RRF and local reranking";
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readAnswerStreamError(error: unknown): string {
  let message: string;
  if (error instanceof InferenceFeatureTimeoutError) {
    message = error.message;
  } else if (error instanceof RerankingTimeoutError) {
    message = error.message;
  } else if (error instanceof HhemClientError && error.category === "timeout") {
    message = "Claim verification timed out before the answer could be published.";
  } else {
    message = "The answer could not be generated.";
  }
  const errorId = readApplicationErrorId(error);
  return errorId === null ? message : `${message} Error ID: ${errorId}.`;
}

async function reportAnswerStreamFailure(
  database: CiteLoomDatabase,
  error: unknown,
  runId: string,
  runSnapshot: TelemetryRunSnapshot | null,
): Promise<void> {
  const reporter = new ApplicationErrorReporter(database);
  await reporter.report(error, {
    category: readAnswerFailureCategory(error),
    code: readAnswerFailureCode(error) ?? "answer_stream_failed",
    diagnosticMessage: readSafeAnswerFailureMessage(error),
    instance: hostname(),
    operation: `answer-stream:${readFailedAnswerStage(runSnapshot)}`,
    origin: readAnswerFailureOrigin(error),
    retryable: readAnswerFailureRetryability(error),
    runId,
    service: "web",
    severity: "error",
  });
}

async function reportUntrackedAnswerStreamFailure(
  database: CiteLoomDatabase | null,
  error: unknown,
  abortSignal: AbortSignal,
): Promise<void> {
  if (abortSignal.aborted) {
    return;
  }
  if (readApplicationErrorId(error) !== null) {
    return;
  }
  const context = {
    category: readAnswerFailureCategory(error),
    code: readAnswerFailureCode(error) ?? "answer_stream_failed",
    diagnosticMessage: readSafeAnswerFailureMessage(error),
    instance: hostname(),
    operation: "answer-stream:initialization",
    origin: readAnswerFailureOrigin(error),
    retryable: readAnswerFailureRetryability(error),
    service: "web",
    severity: "error" as const,
  };
  if (database === null) {
    reportApplicationErrorToContainerLog(
      error,
      context,
      new Error("The answer stream could not open its database reporter."),
    );
    return;
  }
  const reporter = new ApplicationErrorReporter(database);
  await reporter.report(error, context);
}

function isInferenceFailure(error: unknown): boolean {
  return findError(error, (candidate) => {
    return candidate instanceof InferenceFeatureTimeoutError
      || candidate instanceof RerankingTimeoutError
      || candidate instanceof HhemClientError;
  }) !== null;
}

function readAnswerFailureOrigin(error: unknown) {
  const schedulerFailure = findError(error, (candidate) => {
    return candidate instanceof InferenceLeaseLostError;
  });
  if (schedulerFailure !== null) {
    return "scheduler" as const;
  }
  return isInferenceFailure(error)
    ? "inference-provider" as const
    : "streaming-answer" as const;
}

function readAnswerFailureRetryability(error: unknown): boolean | null {
  if (readAnswerFailureOrigin(error) === "scheduler") {
    return true;
  }
  if (
    error instanceof InferenceFeatureTimeoutError
    || error instanceof RerankingTimeoutError
  ) {
    return true;
  }
  if (error instanceof HhemClientError) {
    return error.category === "timeout"
      || error.category === "service-unavailable";
  }
  return null;
}

function readFailedAnswerStage(
  runSnapshot: TelemetryRunSnapshot | null,
): TelemetryStageName | "answer-run" {
  if (runSnapshot === null) {
    return "answer-run";
  }
  for (let index = runSnapshot.stages.length - 1; index >= 0; index -= 1) {
    const stage = runSnapshot.stages[index];
    if (stage !== undefined && (stage.outcome === "error" || stage.outcome === "abort")) {
      return stage.name;
    }
  }
  return "answer-run";
}

function readAnswerFailureCategory(error: unknown): string {
  if (readAnswerFailureOrigin(error) === "scheduler") {
    return "inference-scheduler";
  }
  if (error instanceof InferenceFeatureTimeoutError) {
    return "inference-timeout";
  }
  if (error instanceof RerankingTimeoutError) {
    return "reranking-timeout";
  }
  if (error instanceof HhemClientError) {
    return `claim-verification-${error.category}`;
  }
  return "unexpected";
}

function findError(
  error: unknown,
  predicate: (candidate: Error) => boolean,
): Error | null {
  const pending: unknown[] = [error];
  const visited = new Set<Error>();
  while (pending.length > 0 && visited.size < 16) {
    const current = pending.pop();
    if (!(current instanceof Error) || visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (predicate(current)) {
      return current;
    }
    if (current.cause !== undefined) {
      pending.push(current.cause);
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
  }
  return null;
}

function readAnswerFailureCode(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error)) {
    return null;
  }
  const code = error.code;
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/u.test(code)) {
    return null;
  }
  return code;
}

function readSafeAnswerFailureMessage(error: unknown): string {
  if (error instanceof InferenceFeatureTimeoutError || error instanceof RerankingTimeoutError) {
    return truncateAnswerFailureMessage(error.message);
  }
  if (error instanceof HhemClientError) {
    return "Claim verification failed before the answer could be published.";
  }
  if (!(error instanceof Error)) {
    return "The answer stream threw a non-Error value.";
  }
  if (/^Stored source element is missing: [A-Za-z0-9_-]+$/u.test(error.message)) {
    return truncateAnswerFailureMessage(error.message);
  }
  if (/^Invalid source element row:/u.test(error.message)) {
    return truncateAnswerFailureMessage(error.message);
  }
  if (/^Incomplete retrieval result at index \d+\.$/u.test(error.message)) {
    return error.message;
  }
  if (error.message.startsWith("Retrieved candidate has no current document version:")) {
    return "Retrieved candidate has no current document version.";
  }
  return "Unexpected answer stream failure.";
}

function truncateAnswerFailureMessage(message: string): string {
  const characters: string[] = [];
  for (const character of message) {
    const codePoint = character.codePointAt(0);
    const isControlCharacter = codePoint !== undefined
      && (codePoint <= 31 || codePoint === 127);
    characters.push(isControlCharacter ? " " : character);
  }
  const normalized = characters.join("").trim();
  if (normalized.length <= maximumLoggedAnswerErrorMessageCharacters) {
    return normalized;
  }
  return `${normalized.slice(0, maximumLoggedAnswerErrorMessageCharacters)}...`;
}
