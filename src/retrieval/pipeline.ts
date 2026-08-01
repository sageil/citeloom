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
import {
  attachAdvisoryClaimChecks,
  AnswerOutputTokenLimitError,
  answerQuestion,
  createNoRelevantAnswer,
  InvalidAnswerDraftError,
  streamAnswerQuestion,
  UnexpectedAnswerFinishReasonError,
  type AnswerResult,
  type GeneratedAnswerResult,
} from "../answers/inference.js";
import { AnswerCapacityError } from "../answers/context-budget.js";
import {
  readInferenceApiFailure,
  readInferenceErrorMessage,
  type InferenceApiFailure,
} from "../inference/error.js";
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
  StaleInferenceSettingsError,
} from "../inference/coordinator.js";
import { InferenceFeatureTimeoutError } from "../inference/request.js";
import { RerankingTimeoutError } from "./ranking/reranker.js";
import { embedQuestions } from "../embedding/inference.js";
import { expandRetrievalQuery } from "./query-expansion.js";
import type { QueryExpansionGenerationSettings } from "./query-expansion.js";
import {
  createQuestionInput,
  type QuestionInput,
} from "../domain/question.js";
import type {
  QueryScope,
  ResolvedQueryScopeTarget,
} from "../domain/query-scope.js";
import type { ClaimVerificationResult } from "../research/types.js";
import type {
  CurrentResearchRetrievalTrace,
  ResearchRetrievalTrace,
} from "../research/types.js";
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
import type { TocRoutingResources } from "./toc/routing.js";
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
  question: QuestionInput,
  queryTexts: readonly string[],
  retrieved: readonly RetrievedElement[],
): CurrentResearchRetrievalTrace {
  const queries: CurrentResearchRetrievalTrace["queries"] = [];
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
  const orderedSources: CurrentResearchRetrievalTrace["orderedSources"] = [];
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
    question: {
      original: question.original,
      policyId: question.policyId,
      processing: question.processing,
    },
    queries,
    version: 4,
  };
}

const passiveAbortSignal = new AbortController().signal;
const maximumLoggedAnswerErrorMessageCharacters = 500;

function readQuestionInput(question: string | QuestionInput): QuestionInput {
  if (typeof question === "string") {
    return createQuestionInput(question);
  }
  return question;
}

type AnswerStreamFailure =
  | { kind: "answer-capacity" }
  | { kind: "answer-finish" }
  | { kind: "answer-invalid" }
  | { kind: "answer-output-limit"; outputTokenLimit: number }
  | { kind: "answer-timeout"; message: string }
  | { kind: "provider"; error: Error; failure: InferenceApiFailure }
  | { kind: "reranking-timeout"; message: string }
  | { kind: "scheduler-lease" }
  | { kind: "settings-changed" }
  | { kind: "unexpected" };

export async function askIndexedDocuments(
  config: AppConfig,
  question: string,
  reportProgress: (message: string) => void,
  scope: QueryScope = { kind: "all" },
): Promise<AnswerResult> {
  const questionInput = createQuestionInput(question);
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
      questionInput,
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
      questionInput.processing,
      prepared.retrieved,
      prepared.answerScheduler,
      prepared.generationSettings.answer,
      runTelemetry,
    );
    if (result.outcome === "answered") {
      reportProgress("Scoring cited claims with advisory HHEM checks");
      const verified = await verifyPublishedAnswer(
        prepared.models,
        result.answerDocument,
        prepared.answerScheduler,
        passiveAbortSignal,
        runTelemetry,
      );
      result = attachAdvisoryClaimChecks(result, verified.claims);
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
  const questionInput = createQuestionInput(question);
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
          questionInput,
          scope,
          threadId,
          reportProgress,
          abortSignal,
          writer,
          async (runTelemetry) => prepareRetrieval(
            config,
            openedSession,
            questionInput,
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
  const questionInput = createQuestionInput(question);
  return createUIMessageStream<CiteLoomUIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: "start" });
      try {
        await writeStreamedAnswer(runtime.config, runtime, questionInput, scope, threadId, reportProgress, abortSignal, writer,
          async (runTelemetry) => prepareRetrievalWithRuntime(
            runtime,
            questionInput,
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
  const questionInput = createQuestionInput(question);
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
      questionInput,
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
  question: string | QuestionInput,
  reportProgress: (message: string) => void,
  scope: QueryScope,
  abortSignal: AbortSignal,
  runTelemetry: RunTelemetry = noopRunTelemetry,
  workload: WorkloadClass = "interactive-search",
): Promise<PreparedRetrieval> {
  const questionInput = readQuestionInput(question);
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
    questionInput,
    reportProgress,
    scope,
    abortSignal,
    runTelemetry,
    workload === "interactive-answer"
      ? { models, scheduler: answerScheduler }
      : null,
  );
}

export async function prepareRetrievalWithRuntime(
  runtime: ApplicationRuntime,
  question: string | QuestionInput,
  reportProgress: (message: string) => void,
  scope: QueryScope,
  abortSignal: AbortSignal,
  runTelemetry: RunTelemetry = noopRunTelemetry,
  config: AppConfig = runtime.config,
  workload: WorkloadClass = "interactive-search",
  tocRoutingResources?: TocRoutingResources,
): Promise<PreparedRetrieval> {
  const questionInput = readQuestionInput(question);
  const effectiveTocRoutingResources = workload === "interactive-answer"
    ? tocRoutingResources ?? {
      models: runtime.models,
      scheduler: runtime.scheduler("answer", workload),
    }
    : null;
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
    questionInput,
    reportProgress,
    scope,
    abortSignal,
    runTelemetry,
    effectiveTocRoutingResources,
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
  question: QuestionInput,
  reportProgress: (message: string) => void,
  scope: QueryScope,
  abortSignal: AbortSignal,
  runTelemetry: RunTelemetry,
  tocRoutingResources: TocRoutingResources | null,
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
    question.processing,
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
      retrievalTrace: createRetrievalTrace(
        generationSettings,
        question,
        [question.processing],
        [],
      ),
      retrieved: [],
    };
  }

  const queries = await prepareRetrievalQueries(
    config,
    models,
    question.processing,
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
    question.processing,
    queries,
    config.retrieval,
    scopeTargets,
    models.reranker,
    rerankingScheduler,
    abortSignal,
    runTelemetry,
    config.docling.tocEnabled && config.retrieval.mode === "hybrid-reranked"
      ? tocRoutingResources
      : null,
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
      question,
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
  reportProgress("Generating extra search queries");
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
      `Extra search queries were unavailable, so retrieval is using the original question: ${readErrorMessage(error)}`,
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
    reportProgress(`Embedding ${queryTexts.length} search queries`);
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
  question: string | QuestionInput,
  scope: QueryScope,
  threadId: string,
  reportProgress: (message: string) => void,
  abortSignal: AbortSignal,
  writer: UIMessageStreamWriter<CiteLoomUIMessage>,
  prepare: (runTelemetry: RunTelemetry) => Promise<PreparedRetrieval>,
): Promise<void> {
  const questionInput = readQuestionInput(question);
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
        questionInput.processing,
        prepared.retrieved,
        prepared.answerScheduler,
        abortSignal,
        prepared.generationSettings.answer,
        runTelemetry,
      );
    }
    let verifiedClaims: ClaimVerificationResult[] = [];
    if (result.outcome === "answered") {
      reportProgress("Scoring cited claims with advisory HHEM checks");
      const verified = await verifyPublishedAnswer(
        prepared.models,
        result.answerDocument,
        prepared.answerScheduler,
        abortSignal,
        runTelemetry,
      );
      verifiedClaims = verified.claims;
      result = attachAdvisoryClaimChecks(result, verified.claims);
    }
    abortSignal.throwIfAborted();
    const turn = await researchStore.saveTurn({
      answerDocument: result.answerDocument,
      claims: verifiedClaims,
      completedAt: new Date(),
      question: questionInput.original,
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
  const failure = readAnswerStreamFailure(error);
  const message = formatAnswerStreamFailure(failure);
  const errorId = readApplicationErrorId(error);
  return errorId === null ? message : `${message} Error ID: ${errorId}.`;
}

function readAnswerStreamFailure(error: unknown): AnswerStreamFailure {
  const pending: unknown[] = [error];
  const visited = new Set<Error>();
  while (pending.length > 0 && visited.size < 16) {
    const current = pending.pop();
    if (!(current instanceof Error) || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const failure = readDirectAnswerStreamFailure(current);
    if (failure !== null) {
      return failure;
    }
    if (current.cause !== undefined) {
      pending.push(current.cause);
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
  }
  return { kind: "unexpected" };
}

function readDirectAnswerStreamFailure(
  error: Error,
): AnswerStreamFailure | null {
  const providerFailure = readInferenceApiFailure(error);
  if (providerFailure !== null) {
    return { error, failure: providerFailure, kind: "provider" };
  }
  switch (true) {
    case error instanceof InferenceFeatureTimeoutError:
      return { kind: "answer-timeout", message: error.message };
    case error instanceof RerankingTimeoutError:
      return { kind: "reranking-timeout", message: error.message };
    case error instanceof AnswerCapacityError:
      return { kind: "answer-capacity" };
    case error instanceof AnswerOutputTokenLimitError:
      return {
        kind: "answer-output-limit",
        outputTokenLimit: error.outputTokenLimit,
      };
    case error instanceof InvalidAnswerDraftError:
      return { kind: "answer-invalid" };
    case error instanceof UnexpectedAnswerFinishReasonError:
      return { kind: "answer-finish" };
    case error instanceof StaleInferenceSettingsError:
      return { kind: "settings-changed" };
    case error instanceof InferenceLeaseLostError:
      return { kind: "scheduler-lease" };
    default:
      return null;
  }
}

function formatAnswerStreamFailure(failure: AnswerStreamFailure): string {
  switch (failure.kind) {
    case "provider":
      return readAnswerProviderFailureMessage(failure.failure);
    case "answer-timeout":
    case "reranking-timeout":
      return failure.message;
    case "answer-capacity":
      return "The selected answer model cannot fit the answer instructions and retrieved evidence. Increase its configured context capacity or select a model with a larger context window.";
    case "answer-output-limit":
      return `The answer model reached this request's ${failure.outputTokenLimit.toLocaleString("en-CA")}-token output limit before completing the answer. Increase Maximum answer tokens in Settings if the model has enough context capacity, or select a model with a larger context window.`;
    case "answer-finish":
      return "The answer provider stopped before producing a complete answer. Try again or select another answer model.";
    case "answer-invalid":
      return "The answer model returned an invalid response after one correction request. Try again or select another answer model.";
    case "settings-changed":
      return "Inference settings changed before answer generation started. Try the question again.";
    case "scheduler-lease":
      return "CiteLoom lost its inference slot while generating the answer. Try the question again.";
    case "unexpected":
      return "The answer could not be generated.";
  }
}

async function reportAnswerStreamFailure(
  database: CiteLoomDatabase,
  error: unknown,
  runId: string,
  runSnapshot: TelemetryRunSnapshot | null,
): Promise<void> {
  const failure = readAnswerStreamFailure(error);
  const reporter = new ApplicationErrorReporter(database);
  await reporter.report(error, {
    category: readAnswerFailureCategory(failure),
    code: readAnswerFailureCode(failure, error) ?? "answer_stream_failed",
    diagnosticMessage: readSafeAnswerFailureMessage(failure, error),
    instance: hostname(),
    operation: `answer-stream:${readFailedAnswerStage(runSnapshot)}`,
    origin: readAnswerFailureOrigin(failure),
    retryable: readAnswerFailureRetryability(failure),
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
  const failure = readAnswerStreamFailure(error);
  const context = {
    category: readAnswerFailureCategory(failure),
    code: readAnswerFailureCode(failure, error) ?? "answer_stream_failed",
    diagnosticMessage: readSafeAnswerFailureMessage(failure, error),
    instance: hostname(),
    operation: "answer-stream:initialization",
    origin: readAnswerFailureOrigin(failure),
    retryable: readAnswerFailureRetryability(failure),
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

function readAnswerFailureOrigin(failure: AnswerStreamFailure) {
  switch (failure.kind) {
    case "scheduler-lease":
    case "settings-changed":
      return "scheduler" as const;
    case "provider":
    case "answer-timeout":
    case "answer-finish":
    case "answer-invalid":
    case "answer-output-limit":
    case "reranking-timeout":
      return "inference-provider" as const;
    case "answer-capacity":
    case "unexpected":
      return "streaming-answer" as const;
  }
}

function readAnswerFailureRetryability(
  failure: AnswerStreamFailure,
): boolean | null {
  switch (failure.kind) {
    case "provider":
      return failure.failure.retryable;
    case "answer-timeout":
    case "reranking-timeout":
    case "scheduler-lease":
    case "settings-changed":
      return true;
    case "answer-capacity":
    case "answer-output-limit":
      return false;
    case "answer-finish":
    case "answer-invalid":
    case "unexpected":
      return null;
  }
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

function readAnswerFailureCategory(failure: AnswerStreamFailure): string {
  switch (failure.kind) {
    case "provider":
      return `inference-provider-${failure.failure.kind}`;
    case "answer-timeout":
      return "inference-timeout";
    case "reranking-timeout":
      return "reranking-timeout";
    case "scheduler-lease":
    case "settings-changed":
      return "inference-scheduler";
    case "answer-capacity":
      return "answer-capacity";
    case "answer-output-limit":
      return "inference-provider-output-limit";
    case "answer-finish":
      return "inference-provider-finish";
    case "answer-invalid":
      return "inference-provider-response";
    case "unexpected":
      return "unexpected";
  }
}

function readAnswerFailureCode(
  failure: AnswerStreamFailure,
  error: unknown,
): string | null {
  switch (failure.kind) {
    case "provider":
      return readAnswerProviderFailureCode(failure.failure);
    case "answer-timeout":
      return "answer_provider_timeout";
    case "reranking-timeout":
      return "reranker_timeout";
    case "scheduler-lease":
      return "inference_lease_lost";
    case "settings-changed":
      return "inference_settings_changed";
    case "answer-capacity":
      return "answer_context_capacity_exceeded";
    case "answer-output-limit":
      return "answer_output_token_limit_reached";
    case "answer-finish":
      return "answer_provider_incomplete";
    case "answer-invalid":
      return "answer_provider_invalid_response";
    case "unexpected":
      return readSqlStateCode(error);
  }
}

function readSqlStateCode(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error)) {
    return null;
  }
  const code = error.code;
  if (typeof code !== "string" || !/^[0-9A-Z]{5}$/u.test(code)) {
    return null;
  }
  return code;
}

function readSafeAnswerFailureMessage(
  failure: AnswerStreamFailure,
  error: unknown,
): string {
  switch (failure.kind) {
    case "provider":
      return truncateAnswerFailureMessage(
        readInferenceErrorMessage(failure.error),
      );
    case "answer-timeout":
    case "reranking-timeout":
      return truncateAnswerFailureMessage(failure.message);
    case "answer-capacity":
    case "answer-finish":
    case "answer-invalid":
    case "answer-output-limit":
    case "scheduler-lease":
    case "settings-changed":
      return truncateAnswerFailureMessage(readErrorMessage(error));
    case "unexpected":
      return readUnexpectedAnswerFailureMessage(error);
  }
}

function readUnexpectedAnswerFailureMessage(error: unknown): string {
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

function readAnswerProviderFailureCode(
  failure: InferenceApiFailure,
): string {
  switch (failure.kind) {
    case "authentication":
      return "inference_provider_authentication_failed";
    case "authorization":
      return "inference_provider_access_denied";
    case "billing":
      return "inference_provider_billing_required";
    case "conflict":
      return "inference_provider_request_conflict";
    case "model-not-found":
      return "inference_provider_model_not_found";
    case "rate-limited":
      return "inference_provider_rate_limited";
    case "request-too-large":
      return "inference_provider_request_too_large";
    case "timeout":
      return "inference_provider_timeout";
    case "unavailable":
      return "inference_provider_unavailable";
    case "unreachable":
      return "inference_provider_unreachable";
    case "invalid-request":
      return "inference_provider_request_rejected";
    case "unexpected":
      return "inference_provider_failed";
  }
}

function readAnswerProviderFailureMessage(
  failure: InferenceApiFailure,
): string {
  switch (failure.kind) {
    case "authentication":
      return "The AI provider could not authenticate the request. Configure or replace the provider API token in Settings, then try again.";
    case "authorization":
      return "The AI provider denied access. Check the API token permissions and access to the selected model.";
    case "billing":
      return "The AI provider rejected the request because of billing or account balance. Check the provider account, then try again.";
    case "conflict":
      return "The AI provider could not accept the request because of a temporary conflict. Try again.";
    case "model-not-found":
      return "The AI provider could not find the configured model or endpoint. Check the provider URL and model ID in Settings.";
    case "rate-limited":
      return "The AI provider is rate limited or its quota is exhausted. Check the provider account, then try again.";
    case "request-too-large":
      return "The AI request exceeds the provider input limit. Check the model context capacity or use a model with a larger context window.";
    case "timeout":
      return "The AI provider timed out before completing the request. Check the provider status, then try again.";
    case "unavailable":
      return "The AI provider is temporarily unavailable. Check the provider status, then try again.";
    case "unreachable":
      return "CiteLoom could not reach the AI provider. Check the provider URL, network connection, and TLS configuration.";
    case "invalid-request":
      return "The AI provider rejected CiteLoom's request. Check the selected model and provider configuration.";
    case "unexpected":
      return failure.statusCode === null
        ? "The AI provider failed before returning a response. Check the provider configuration and status."
        : `The AI provider failed with HTTP ${failure.statusCode}. Check the provider configuration and status.`;
  }
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
