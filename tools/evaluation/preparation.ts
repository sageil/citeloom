import { readFile } from "node:fs/promises";

import { inArray } from "drizzle-orm";

import { createRuntimeTaskScheduler } from "../../src/app/runtime.js";
import type { TaskScheduler } from "../../src/shared/concurrency.js";
import type { AppConfig, RetrievalMode } from "../../src/config/index.js";
import { DocumentCatalog } from "../../src/documents/catalog/index.js";
import {
  HNSW_QUERY_SETTINGS,
  openDatabase,
  type DatabaseSession,
} from "../../src/database/client.js";
import type {
  BenchmarkEvaluationCase,
  BenchmarkEvaluationDataset,
} from "./dataset.js";
import type { RetrievedElement } from "../../src/retrieval/document-retrieval.js";
import { partitionCandidateWindowsByParentOccurrence } from "../../src/retrieval/document-retrieval.js";
import {
  decodeEvaluationDataset,
  readBenchmarkEvaluationDataset,
} from "./dataset.js";
import {
  assertLiveEvaluationCorpus,
  inspectLiveEvaluationCorpus,
} from "./live-corpus.js";
import {
  assertEvaluationConfigurationFrozen,
  type EvaluationConfigurationFreeze,
} from "./freeze.js";
import {
  calculateJsonSha256,
  calculateSha256,
  decodeEvaluationPreparationArtifact,
  type EvaluationPreparationArtifact,
  type EvaluationBenchmarkTelemetry,
  type EvaluationProvenance,
  type PreparedEvaluationCase,
} from "./artifact.js";
import {
  createInferenceModelRegistry,
  type InferenceModelRegistry,
} from "../../src/inference/registry.js";
import { InferenceCoordinator } from "../../src/inference/coordinator.js";
import type { DenseCandidate, FusedCandidate, LexicalCandidate } from "../../src/retrieval/ranking/rank-fusion.js";
import { CHANNEL_ORDERING_POLICY } from "../../src/retrieval/ranking/channel-ordering.js";
import {
  rerankRetrievedElementsWithResponse,
  type RerankedRetrieval,
} from "../../src/retrieval/ranking/reranker.js";
import { prepareRetrievalQueriesWithSeed } from "../../src/retrieval/pipeline.js";
import {
  loadRetrievalCandidates,
  queryRetrievalCandidateRankings,
  selectPreparedRerankingCandidatesWithTrace,
  type RetrievalCandidateRankings,
  type RetrievalQuery,
} from "../../src/retrieval/indexing/query-store.js";
import type { RerankerCandidateIdentity } from "../../src/retrieval/ranking/candidate-selection.js";
import { ensureEmbeddingSpace } from "../../src/retrieval/indexing/index-store.js";
import { SourceDocumentStore } from "../../src/documents/storage/source-document-store.js";
import {
  createTelemetryStageResult,
  noopRunTelemetry,
  readTelemetryFailureOutcome,
  startRunTelemetry,
  type RunTelemetry,
} from "../../src/observability/run.js";
import { DatabaseRunTelemetrySink } from "../../src/observability/store.js";
import { sourceElements } from "../../src/database/schema.js";
import {
  listResolvedQueryDocumentIds,
  type ResolvedQueryScopeTarget,
} from "../../src/domain/query-scope.js";
import {
  decodeAnswerThresholdPreparation,
  type AnswerThresholdPreparation,
  type AnswerThresholdPreparedCase,
} from "./answer-threshold.js";

const comparativeRetrievalModes: readonly RetrievalMode[] = [
  "bm25",
  "dense",
  "hybrid",
  "hybrid-reranked",
];
const passiveAbortSignal = new AbortController().signal;

export interface EvaluationPreparationContext {
  codeRevision: string;
  frozenConfiguration: EvaluationConfigurationFreeze | null;
  settingsVersion: number;
}

export interface PreparedCaseInputs {
  queries: RetrievalQuery[];
  rankings: RetrievalCandidateRankings;
}

export interface EvaluationPreparationExecutor {
  prepareCase: (
    evaluationCase: BenchmarkEvaluationCase,
    generationSeed: number,
    runTelemetry: RunTelemetry,
  ) => Promise<PreparedCaseInputs>;
  rerank: (
    question: string,
    candidates: FusedCandidate[],
    runTelemetry: RunTelemetry,
  ) => Promise<EvaluationRerankingResult>;
}

export interface EvaluationRerankingResult {
  inputs: RetrievedElement[];
  reranked: RerankedRetrieval;
}

interface PreparedRerankerPreparation {
  candidateSelection: NonNullable<
    PreparedEvaluationCase["candidateSelection"]
  >;
  rerankerScores: NonNullable<PreparedEvaluationCase["rerankerScores"]>;
  tuningRerankerScores: NonNullable<
    PreparedEvaluationCase["tuningRerankerScores"]
  >;
}

interface EvaluationRuntime {
  embeddingScheduler: TaskScheduler;
  summarizationScheduler: TaskScheduler;
  models: InferenceModelRegistry;
  rerankingScheduler: TaskScheduler;
  session: DatabaseSession;
}

export async function prepareComparativeEvaluation(
  config: AppConfig,
  datasetPath: string,
  context: EvaluationPreparationContext,
  reportProgress: (message: string) => void,
): Promise<EvaluationPreparationArtifact> {
  assertEvaluationDatasetPathAccess(config, datasetPath, context);
  const datasetContent = await readFile(datasetPath, "utf8");
  const dataset = decodeDatasetContent(datasetContent, datasetPath);
  assertEvaluationDatasetPathClassification(dataset, datasetPath);
  assertEvaluationDatasetAccess(config, dataset, context);
  const evaluationConfig = config;
  const runtime = await createEvaluationRuntime(evaluationConfig);
  try {
    const liveCorpus = await inspectLiveEvaluationCorpus(
      runtime.session.database,
      evaluationConfig.embeddingSpace.id,
      dataset,
      datasetPath,
    );
    assertLiveEvaluationCorpus(liveCorpus);
    if (dataset.version !== 3 || dataset.corpus === undefined) {
      throw new Error(
        "Evaluation preparation requires version 3 corpus provenance.",
      );
    }
    const scopeTargets = [...liveCorpus.scopeTargets];
    scopeTargets.sort(compareResolvedQueryTargets);
    if (scopeTargets.length === 0) {
      throw new Error("Evaluation preparation requires an indexed corpus.");
    }
    const documentIds = listResolvedQueryDocumentIds(scopeTargets);
    documentIds.sort((left, right) => left.localeCompare(right));
    const modes = readAvailableModes(evaluationConfig);
    const provenance = buildEvaluationProvenance(
      evaluationConfig,
      dataset,
      datasetContent,
      documentIds,
      runtime.models,
      context,
    );
    const executor = createCaseExecutor(
      evaluationConfig,
      scopeTargets,
      runtime,
      reportProgress,
    );
    const cases: PreparedEvaluationCase[] = [];
    const telemetry: EvaluationBenchmarkTelemetry[] = [];
    for (const evaluationCase of dataset.cases) {
      reportProgress(
        `Preparing fixed inputs for ${evaluationCase.id}: ${evaluationCase.question}`,
      );
      const generationSeed = createQueryGenerationSeed(
        provenance.dataset.sha256,
        evaluationCase.id,
      );
      const telemetrySink = evaluationConfig.inferenceMetrics.enabled
        ? new DatabaseRunTelemetrySink(runtime.session.database)
        : null;
      const runTelemetry = await startRunTelemetry(
        evaluationConfig,
        "benchmark",
        telemetrySink,
        evaluationCase.id,
      );
      runTelemetry.setScopeSize(scopeTargets.length);
      let preparedCase: PreparedEvaluationCase;
      try {
        preparedCase = await prepareEvaluationCase(
          evaluationCase,
          generationSeed,
          modes.available,
          evaluationConfig,
          executor,
          reportProgress,
          runTelemetry,
        );
      } catch (error: unknown) {
        await runTelemetry.finish("error");
        throw error;
      }
      const trace = await runTelemetry.finish("success");
      if (trace === null) {
        throw new Error(`Evaluation case ${evaluationCase.id} has no telemetry trace.`);
      }
      cases.push(preparedCase);
      telemetry.push({ caseId: evaluationCase.id, trace });
    }
    return decodeEvaluationPreparationArtifact({
      cases,
      provenance,
      skippedModes: modes.skipped,
      telemetry,
      version: 11,
    }, "generated output");
  } finally {
    await runtime.session.close();
  }
}

export async function prepareAnswerThresholdCalibration(
  config: AppConfig,
  datasetPath: string,
  negativeDomain: string,
  context: EvaluationPreparationContext,
  reportProgress: (message: string) => void,
): Promise<AnswerThresholdPreparation> {
  assertEvaluationDatasetPathAccess(config, datasetPath, context);
  const datasetContent = await readFile(datasetPath, "utf8");
  const dataset = decodeDatasetContent(datasetContent, datasetPath);
  assertEvaluationDatasetPathClassification(dataset, datasetPath);
  assertEvaluationDatasetAccess(config, dataset, context);
  if (config.retrieval.reranker === null) {
    throw new Error("Answer-threshold calibration requires an enabled reranker.");
  }
  const runtime = await createEvaluationRuntime(config);
  try {
    const liveCorpus = await inspectLiveEvaluationCorpus(
      runtime.session.database,
      config.embeddingSpace.id,
      dataset,
      datasetPath,
    );
    assertLiveEvaluationCorpus(liveCorpus);
    if (dataset.version !== 3 || dataset.corpus === undefined) {
      throw new Error(
        "Answer-threshold calibration requires version 3 corpus provenance.",
      );
    }
    const catalog = new DocumentCatalog(runtime.session.database);
    const scopeTargets = [...liveCorpus.scopeTargets];
    scopeTargets.sort(compareResolvedQueryTargets);
    const documentIds = listResolvedQueryDocumentIds(scopeTargets);
    documentIds.sort((left, right) => left.localeCompare(right));
    if (documentIds.length < 2) {
      throw new Error(
        "Answer-threshold calibration requires at least two indexed corpus documents.",
      );
    }
    const positiveDomains = new Set(dataset.cases.map((evaluationCase) => {
      return evaluationCase.domain;
    }));
    if (positiveDomains.has(negativeDomain)) {
      throw new Error(
        "Answer-threshold negative corpus domain must differ from every positive case domain.",
      );
    }
    const availableDocuments = await catalog.listAvailableDocuments(
      config.embeddingSpace.id,
    );
    const negativeScopeTargets: ResolvedQueryScopeTarget[] = [];
    const negativePathSegment = `evaluation-corpora/${negativeDomain}/`;
    for (const document of availableDocuments) {
      if (document.sourceFile.includes(negativePathSegment)) {
        negativeScopeTargets.push({
          documentId: document.documentId,
          sourceFile: document.sourceFile,
        });
      }
    }
    negativeScopeTargets.sort(compareResolvedQueryTargets);
    const negativeDocumentIds = listResolvedQueryDocumentIds(negativeScopeTargets);
    negativeDocumentIds.sort((left, right) => left.localeCompare(right));
    if (negativeDocumentIds.length === 0) {
      throw new Error(
        `Answer-threshold calibration found no indexed ${negativeDomain} corpus documents.`,
      );
    }
    const positiveDocumentIds = new Set(documentIds);
    for (const negativeDocumentId of negativeDocumentIds) {
      if (positiveDocumentIds.has(negativeDocumentId)) {
        throw new Error(
          "Answer-threshold positive and negative corpus documents must be disjoint.",
        );
      }
    }
    const provenance = buildEvaluationProvenance(
      config,
      dataset,
      datasetContent,
      documentIds,
      runtime.models,
      context,
    );
    const cases: AnswerThresholdPreparedCase[] = [];
    for (const evaluationCase of dataset.cases) {
      const excludedDocumentIds = await readSupportingDocumentIds(
        runtime.session,
        evaluationCase,
      );
      const positiveScope = [...scopeTargets];
      const negativeScope = [...negativeScopeTargets];
      const generationSeed = createQueryGenerationSeed(
        provenance.dataset.sha256,
        evaluationCase.id,
      );
      reportProgress(`Calibrating answerable scope for ${evaluationCase.id}`);
      const positive = await prepareAnswerThresholdAssessment(
        config,
        evaluationCase,
        generationSeed,
        positiveScope,
        runtime,
        reportProgress,
      );
      reportProgress(`Calibrating evidence-excluded scope for ${evaluationCase.id}`);
      const negative = await prepareAnswerThresholdAssessment(
        config,
        evaluationCase,
        generationSeed,
        negativeScope,
        runtime,
        reportProgress,
      );
      cases.push({
        domain: evaluationCase.domain,
        excludedDocumentIds,
        familyId: evaluationCase.id,
        negative,
        positive,
        question: evaluationCase.question,
      });
    }
    return decodeAnswerThresholdPreparation({
      cases,
      negativeCorpus: {
        documentIds: negativeDocumentIds,
        domain: negativeDomain,
        sha256: calculateJsonSha256({
          documentIds: negativeDocumentIds,
          domain: negativeDomain,
        }),
      },
      provenance,
      version: 6,
    }, "generated output");
  } finally {
    await runtime.session.close();
  }
}

export function assertEvaluationDatasetPathAccess(
  config: AppConfig,
  datasetPath: string,
  context: EvaluationPreparationContext,
): void {
  if (!datasetPath.endsWith(".sealed.json")) {
    return;
  }
  if (context.frozenConfiguration === null) {
    throw new Error(
      "A sealed holdout path cannot be opened before the evaluation configuration is frozen.",
    );
  }
  assertEvaluationConfigurationFrozen(
    config,
    context.codeRevision,
    context.settingsVersion,
    context.frozenConfiguration,
  );
}

function assertEvaluationDatasetPathClassification(
  dataset: BenchmarkEvaluationDataset,
  datasetPath: string,
): void {
  const sealedPath = datasetPath.endsWith(".sealed.json");
  if (sealedPath !== (dataset.access === "sealed")) {
    throw new Error(
      "Evaluation dataset access and its .sealed.json path classification differ.",
    );
  }
}

export async function prepareEvaluationCasesWithExecutor(
  dataset: BenchmarkEvaluationDataset,
  provenance: EvaluationProvenance,
  availableModes: RetrievalMode[],
  config: AppConfig,
  executor: EvaluationPreparationExecutor,
  reportProgress: (message: string) => void,
): Promise<PreparedEvaluationCase[]> {
  const cases: PreparedEvaluationCase[] = [];
  for (const evaluationCase of dataset.cases) {
    const generationSeed = createQueryGenerationSeed(
      provenance.dataset.sha256,
      evaluationCase.id,
    );
    cases.push(await prepareEvaluationCase(
      evaluationCase,
      generationSeed,
      availableModes,
      config,
      executor,
      reportProgress,
      noopRunTelemetry,
    ));
  }
  return cases;
}

function decodeDatasetContent(
  content: string,
  sourceLabel: string,
): BenchmarkEvaluationDataset {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid evaluation JSON in ${sourceLabel}: ${message}`);
  }
  const dataset = decodeEvaluationDataset(parsedJson, sourceLabel);
  return readBenchmarkEvaluationDataset(dataset, sourceLabel);
}

export function assertEvaluationDatasetAccess(
  config: AppConfig,
  dataset: BenchmarkEvaluationDataset,
  context: EvaluationPreparationContext,
): void {
  if (config.settingsVersion !== context.settingsVersion) {
    throw new Error(
      "Evaluation context settings version does not match the active configuration.",
    );
  }
  if (config.retrieval.topK !== dataset.atK) {
    throw new Error(
      `Evaluation dataset atK ${dataset.atK} does not match the frozen retrieval topK ${config.retrieval.topK}.`,
    );
  }
  if (config.retrieval.candidateK < dataset.atK) {
    throw new Error(
      `Evaluation candidateK ${config.retrieval.candidateK} must be at least dataset atK ${dataset.atK}.`,
    );
  }
  if (dataset.access !== "sealed") {
    return;
  }
  if (context.frozenConfiguration === null) {
    throw new Error(
      "A sealed holdout can only be evaluated with a frozen configuration.",
    );
  }
  assertEvaluationConfigurationFrozen(
    config,
    context.codeRevision,
    context.settingsVersion,
    context.frozenConfiguration,
  );
}

async function createEvaluationRuntime(
  config: AppConfig,
): Promise<EvaluationRuntime> {
  const session = await openDatabase(config.database);
  try {
    await ensureEmbeddingSpace(session.database, config.embeddingSpace);
    const coordinator = new InferenceCoordinator(session.database);
    await coordinator.configure(config.scheduling);
    const embeddingScheduler = createRuntimeTaskScheduler(
      config,
      coordinator,
      "embedding",
      "offline-tool",
    );
    const summarizationScheduler = createRuntimeTaskScheduler(
      config,
      coordinator,
      "summarization",
      "offline-tool",
    );
    const rerankingScheduler = createRuntimeTaskScheduler(
      config,
      coordinator,
      "reranking",
      "offline-tool",
    );
    const models = createInferenceModelRegistry(config);
    return {
      embeddingScheduler,
      models,
      rerankingScheduler,
      session,
      summarizationScheduler,
    };
  } catch (error: unknown) {
    await session.close();
    throw error;
  }
}

function createCaseExecutor(
  config: AppConfig,
  scopeTargets: ResolvedQueryScopeTarget[],
  runtime: EvaluationRuntime,
  reportProgress: (message: string) => void,
): EvaluationPreparationExecutor {
  const documentStore = new SourceDocumentStore(runtime.session.database);
  const prepareCase: EvaluationPreparationExecutor["prepareCase"] = (
    evaluationCase,
    generationSeed,
    runTelemetry,
  ) => prepareEvaluationCaseInputs(
    config,
    scopeTargets,
    runtime,
    reportProgress,
    evaluationCase,
    generationSeed,
    runTelemetry,
  );
  const rerank: EvaluationPreparationExecutor["rerank"] = (
    question,
    candidates,
    runTelemetry,
  ) => rerankEvaluationCandidates(
    config,
    runtime,
    documentStore,
    scopeTargets,
    question,
    candidates,
    runTelemetry,
  );
  return {
    prepareCase,
    rerank,
  };
}

async function prepareAnswerThresholdAssessment(
  config: AppConfig,
  evaluationCase: BenchmarkEvaluationCase,
  generationSeed: number,
  scopeTargets: ResolvedQueryScopeTarget[],
  runtime: EvaluationRuntime,
  reportProgress: (message: string) => void,
): Promise<AnswerThresholdPreparedCase["positive"]> {
  const telemetrySink = config.inferenceMetrics.enabled
    ? new DatabaseRunTelemetrySink(runtime.session.database)
    : null;
  const runTelemetry = await startRunTelemetry(
    config,
    "benchmark",
    telemetrySink,
    evaluationCase.id,
  );
  runTelemetry.setScopeSize(scopeTargets.length);
  try {
    const executor = createCaseExecutor(
      config,
      scopeTargets,
      runtime,
      reportProgress,
    );
    const inputs = await executor.prepareCase(
      evaluationCase,
      generationSeed,
      runTelemetry,
    );
    validatePreparedQueries(inputs.queries, evaluationCase.id);
    const candidateSelection = selectPreparedRerankingCandidatesWithTrace(
      evaluationCase.question,
      inputs.rankings,
      config.retrieval.candidateK,
      config.retrieval.rrfK,
      config.retrieval.fusion,
    );
    runTelemetry.setCandidateCount(candidateSelection.selected.length);
    const execution = await executor.rerank(
      evaluationCase.question,
      candidateSelection.selected,
      runTelemetry,
    );
    const reranked = execution.reranked;
    const relevantElementIds = new Set(evaluationCase.relevantElementIds);
    const relevantDocumentIds = new Set(evaluationCase.relevantDocumentIds);
    let acceptedEvidenceRetrieved = false;
    for (const retrieved of reranked.retrieved) {
      if (
        relevantElementIds.has(retrieved.element.id)
        || relevantDocumentIds.has(retrieved.element.documentId)
      ) {
        acceptedEvidenceRetrieved = true;
        break;
      }
    }
    let strongestScore: number | null = null;
    for (const ranking of reranked.ranking) {
      if (strongestScore === null || ranking.relevanceScore > strongestScore) {
        strongestScore = ranking.relevanceScore;
      }
    }
    const trace = await runTelemetry.finish("success");
    if (trace === null) {
      throw new Error(
        `Calibration assessment ${evaluationCase.id} has no telemetry trace.`,
      );
    }
    return {
      acceptedEvidenceRetrieved,
      candidateCount: candidateSelection.selected.length,
      documentIds: listResolvedQueryDocumentIds(scopeTargets),
      strongestScore,
      trace,
    };
  } catch (error: unknown) {
    await runTelemetry.finish("error");
    throw error;
  }
}

async function readSupportingDocumentIds(
  session: DatabaseSession,
  evaluationCase: BenchmarkEvaluationCase,
): Promise<string[]> {
  const supportingDocumentIds = new Set(evaluationCase.relevantDocumentIds);
  if (evaluationCase.relevantElementIds.length > 0) {
    const rows = await session.database
      .select({
        documentId: sourceElements.documentId,
        elementId: sourceElements.id,
      })
      .from(sourceElements)
      .where(inArray(sourceElements.id, evaluationCase.relevantElementIds));
    const resolvedElementIds = new Set<string>();
    for (const row of rows) {
      resolvedElementIds.add(row.elementId);
      supportingDocumentIds.add(row.documentId);
    }
    for (const elementId of evaluationCase.relevantElementIds) {
      if (!resolvedElementIds.has(elementId)) {
        throw new Error(
          `Calibration case ${evaluationCase.id} references missing element ${elementId}.`,
        );
      }
    }
  }
  if (supportingDocumentIds.size === 0) {
    throw new Error(
      `Calibration case ${evaluationCase.id} has no accepted supporting documents.`,
    );
  }
  return [...supportingDocumentIds].sort((left, right) => {
    return left.localeCompare(right);
  });
}

async function prepareEvaluationCaseInputs(
  config: AppConfig,
  scopeTargets: ResolvedQueryScopeTarget[],
  runtime: EvaluationRuntime,
  reportProgress: (message: string) => void,
  evaluationCase: BenchmarkEvaluationCase,
  generationSeed: number,
  runTelemetry: RunTelemetry,
): Promise<PreparedCaseInputs> {
  const queries = await prepareRetrievalQueriesWithSeed(
    config,
    runtime.models,
    evaluationCase.question,
    reportProgress,
    runtime.embeddingScheduler,
    runtime.summarizationScheduler,
    passiveAbortSignal,
    generationSeed,
    runTelemetry,
  );
  const rankings = await queryRetrievalCandidateRankings(
    runtime.session.database,
    runtime.session.query,
    config.embeddingSpace,
    queries,
    config.retrieval,
    scopeTargets,
    passiveAbortSignal,
    runTelemetry,
  );
  return { queries, rankings };
}

async function rerankEvaluationCandidates(
  config: AppConfig,
  runtime: EvaluationRuntime,
  documentStore: SourceDocumentStore,
  scopeTargets: ResolvedQueryScopeTarget[],
  question: string,
  candidates: FusedCandidate[],
  runTelemetry: RunTelemetry,
): Promise<EvaluationRerankingResult> {
  const reranker = runtime.models.reranker;
  if (reranker === null) {
    throw new Error("Evaluation reranking requires a configured reranker.");
  }
  const retrieved = await hydrateEvaluationCandidates(
    runtime,
    documentStore,
    candidates,
    scopeTargets,
    runTelemetry,
  );
  const candidateIdentities = buildRerankerCandidateIdentities(
    candidates,
    retrieved,
  );
  const rerankingStage = runTelemetry.startStage({
    model: {
      modelId: reranker.model.modelId,
      provider: reranker.model.provider,
    },
    name: "reranking",
    retrievalMode: "hybrid-reranked",
  });
  try {
    const reranked = await runtime.rerankingScheduler.run(
      (requestSignal) => rerankRetrievedElementsWithResponse(
        reranker,
        question,
        retrieved,
        config.retrieval.topK,
        requestSignal,
        candidateIdentities,
      ),
      passiveAbortSignal,
      rerankingStage.timingObserver,
    );
    await rerankingStage.finish(createTelemetryStageResult("success", {
      inputCount: retrieved.length,
      outputCount: reranked.retrieved.length,
    }));
    runTelemetry.setHydratedContextCount(reranked.retrieved.length);
    return {
      inputs: retrieved,
      reranked,
    };
  } catch (error: unknown) {
    await rerankingStage.finish(createTelemetryStageResult(
      readTelemetryFailureOutcome(passiveAbortSignal),
      { inputCount: retrieved.length },
    ));
    throw error;
  }
}

function buildRerankerCandidateIdentities(
  candidates: readonly FusedCandidate[],
  retrieved: readonly RetrievedElement[],
): RerankerCandidateIdentity[] {
  if (candidates.length !== retrieved.length) {
    throw new Error(
      "Evaluation hydration did not preserve the reranker candidate batch.",
    );
  }
  const identities: RerankerCandidateIdentity[] = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const item = retrieved[index];
    if (candidate === undefined || item === undefined) {
      throw new Error(`Incomplete evaluation reranker input at index ${index}.`);
    }
    identities.push({
      documentId: candidate.documentId,
      documentVersionId: item.documentVersionId,
      elementId: candidate.parentId,
      representativeRetrievalWindowId: candidate.retrievalId,
      sourceFile: candidate.sourceFile,
    });
  }
  return identities;
}

async function hydrateEvaluationCandidates(
  runtime: EvaluationRuntime,
  documentStore: SourceDocumentStore,
  candidates: FusedCandidate[],
  scopeTargets: ResolvedQueryScopeTarget[],
  runTelemetry: RunTelemetry,
): Promise<RetrievedElement[]> {
  const stage = runTelemetry.startStage({
    model: null,
    name: "hydration",
    retrievalMode: "hybrid-reranked",
  });
  try {
    const retrieved = await loadRetrievalCandidates(
      runtime.session.database,
      documentStore,
      candidates,
      scopeTargets,
    );
    await stage.finish(createTelemetryStageResult("success", {
      inputCount: candidates.length,
      outputCount: retrieved.length,
    }));
    return retrieved;
  } catch (error: unknown) {
    await stage.finish(createTelemetryStageResult("error", {
      inputCount: candidates.length,
    }));
    throw error;
  }
}

async function prepareEvaluationCase(
  evaluationCase: BenchmarkEvaluationCase,
  generationSeed: number,
  availableModes: RetrievalMode[],
  config: AppConfig,
  executor: EvaluationPreparationExecutor,
  reportProgress: (message: string) => void,
  runTelemetry: RunTelemetry,
): Promise<PreparedEvaluationCase> {
  const inputs = await executor.prepareCase(
    evaluationCase,
    generationSeed,
    runTelemetry,
  );
  validatePreparedQueries(inputs.queries, evaluationCase.id);
  const maximumQueryCount = config.retrieval.queryExpansions + 1;
  if (inputs.queries.length > maximumQueryCount) {
    throw new Error(
      `Evaluation case ${evaluationCase.id} prepared ${inputs.queries.length} query variants; the deployed configuration allows at most ${maximumQueryCount}.`,
    );
  }
  freezePreparedInputs(inputs);
  const inputFingerprint = calculateJsonSha256(inputs);
  const rerankerPreparation = availableModes.includes("hybrid-reranked")
    ? await prepareRerankerPreparation(
      evaluationCase,
      inputs.rankings,
      config,
      executor,
      runTelemetry,
      reportProgress,
    )
    : null;
  assertPreparedInputsUnchanged(inputFingerprint, inputs, "reranker scoring");
  return {
    candidateRankings: serializeCandidateRankings(inputs.rankings),
    candidateSelection: rerankerPreparation?.candidateSelection ?? null,
    domain: evaluationCase.domain,
    id: evaluationCase.id,
    judgments: structuredClone(evaluationCase.judgments),
    metadata: structuredClone(evaluationCase.metadata),
    queries: serializeQueries(inputs.queries),
    queryGenerationSeed: generationSeed,
    question: evaluationCase.question,
    relevantDocumentIds: [...evaluationCase.relevantDocumentIds],
    relevantElementIds: [...evaluationCase.relevantElementIds],
    rerankerScores: rerankerPreparation?.rerankerScores ?? null,
    tuningRerankerScores:
      rerankerPreparation?.tuningRerankerScores ?? null,
  };
}

async function prepareRerankerPreparation(
  evaluationCase: BenchmarkEvaluationCase,
  rankings: RetrievalCandidateRankings,
  config: AppConfig,
  executor: EvaluationPreparationExecutor,
  runTelemetry: RunTelemetry,
  reportProgress: (message: string) => void,
): Promise<PreparedRerankerPreparation> {
  const candidateSelection = selectPreparedRerankingCandidatesWithTrace(
    evaluationCase.question,
    rankings,
    config.retrieval.candidateK,
    config.retrieval.rrfK,
    config.retrieval.fusion,
  );
  const candidates = candidateSelection.decisions.map((decision) => (
    decision.candidate
  ));
  const tuningBatches = partitionCandidateWindowsByParentOccurrence(candidates);
  runTelemetry.setCandidateCount(candidateSelection.selected.length);
  reportProgress(
    `Scoring the production reranker batch for ${evaluationCase.id}`,
  );
  const productionExecution = await executor.rerank(
    evaluationCase.question,
    candidateSelection.selected,
    runTelemetry,
  );
  const rerankerScores = serializeRerankerScores(
    candidateSelection.selected,
    productionExecution,
    1,
  );
  let tuningRerankerScores = rerankerScores;
  const firstTuningBatch = tuningBatches[0] ?? [];
  const canReuseProductionScores = tuningBatches.length === 1
    && areSameCandidateBatch(candidateSelection.selected, firstTuningBatch);
  if (!canReuseProductionScores) {
    tuningRerankerScores = [];
    for (let index = 0; index < tuningBatches.length; index += 1) {
      const tuningBatch = tuningBatches[index];
      if (tuningBatch === undefined) {
        continue;
      }
      reportProgress(
        `Scoring tuning candidate batch ${index + 1} of ${tuningBatches.length} for ${evaluationCase.id}`,
      );
      const tuningExecution = await executor.rerank(
        evaluationCase.question,
        tuningBatch,
        runTelemetry,
      );
      const batchScores = serializeRerankerScores(
        tuningBatch,
        tuningExecution,
        index + 1,
      );
      tuningRerankerScores.push(...batchScores);
    }
  }
  const decisions = candidateSelection.decisions.map((decision) => ({
    admissionRank: decision.admissionRank,
    documentId: decision.candidate.documentId,
    elementId: decision.candidate.parentId,
    exclusionReason: decision.exclusionReason,
    fusedRank: decision.fusedRank,
    representativeRetrievalWindowId:
      decision.representativeRetrievalWindowId,
    retrievalId: decision.candidate.retrievalId,
    sourceFile: decision.candidate.sourceFile,
  }));
  return {
    candidateSelection: {
      allocationPolicy: candidateSelection.allocationPolicy,
      candidateK: config.retrieval.candidateK,
      decisions,
      rerankerInputRetrievalIds: candidateSelection.selected.map(
        (candidate) => candidate.retrievalId,
      ),
    },
    rerankerScores,
    tuningRerankerScores,
  };
}

function areSameCandidateBatch(
  left: readonly FusedCandidate[],
  right: readonly FusedCandidate[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.retrievalId !== right[index]?.retrievalId) {
      return false;
    }
  }
  return true;
}

function serializeRerankerScores(
  candidates: readonly FusedCandidate[],
  execution: EvaluationRerankingResult,
  scoringBatchIndex: number,
): NonNullable<PreparedEvaluationCase["rerankerScores"]> {
  if (execution.inputs.length !== candidates.length) {
    throw new Error(
      `Reranker received ${execution.inputs.length} hydrated inputs for ${candidates.length} fixed candidates.`,
    );
  }
  const scores: NonNullable<PreparedEvaluationCase["rerankerScores"]> = [];
  for (const entry of execution.reranked.ranking) {
    const candidate = candidates[entry.originalIndex];
    const input = execution.inputs[entry.originalIndex];
    if (candidate === undefined || input === undefined) {
      throw new Error(
        `Reranker returned an unknown candidate index ${entry.originalIndex}.`,
      );
    }
    scores.push({
      documentId: candidate.documentId,
      documentVersionId: input.documentVersionId,
      elementId: candidate.parentId,
      relevanceScore: entry.relevanceScore,
      retrievalId: candidate.retrievalId,
      scoringBatchIndex,
      scoringBatchRank: entry.originalIndex + 1,
      sourceFile: candidate.sourceFile,
    });
  }
  if (scores.length !== candidates.length) {
    throw new Error(
      `Reranker returned ${scores.length} scores for ${candidates.length} fixed candidates.`,
    );
  }
  return scores;
}

function validatePreparedQueries(
  queries: RetrievalQuery[],
  caseId: string,
): void {
  if (queries.length === 0) {
    throw new Error(`Evaluation case ${caseId} has no prepared queries.`);
  }
  for (let index = 0; index < queries.length; index += 1) {
    const query = queries[index];
    if (query === undefined || query.embedding === null) {
      throw new Error(
        `Evaluation case ${caseId} is missing query embedding ${index + 1}.`,
      );
    }
  }
}

function freezePreparedInputs(inputs: PreparedCaseInputs): void {
  for (const query of inputs.queries) {
    if (query.embedding !== null) {
      Object.freeze(query.embedding);
    }
    Object.freeze(query);
  }
  Object.freeze(inputs.queries);
  for (const ranking of inputs.rankings.dense) {
    for (const candidate of ranking) {
      Object.freeze(candidate);
    }
    Object.freeze(ranking);
  }
  Object.freeze(inputs.rankings.dense);
  for (const ranking of inputs.rankings.lexical) {
    for (const candidate of ranking) {
      Object.freeze(candidate);
    }
    Object.freeze(ranking);
  }
  Object.freeze(inputs.rankings.lexical);
  Object.freeze(inputs.rankings);
  Object.freeze(inputs);
}

function assertPreparedInputsUnchanged(
  expectedFingerprint: string,
  inputs: PreparedCaseInputs,
  operation: string,
): void {
  const actualFingerprint = calculateJsonSha256(inputs);
  if (actualFingerprint !== expectedFingerprint) {
    throw new Error(`${operation} mutated prepared evaluation inputs.`);
  }
}

function serializeQueries(queries: RetrievalQuery[]): PreparedEvaluationCase["queries"] {
  const serialized: PreparedEvaluationCase["queries"] = [];
  for (const query of queries) {
    if (query.embedding === null) {
      throw new Error("Prepared evaluation queries require embeddings.");
    }
    serialized.push({
      embeddingSha256: calculateJsonSha256(query.embedding),
      text: query.text,
    });
  }
  return serialized;
}

function serializeCandidateRankings(
  rankings: RetrievalCandidateRankings,
): PreparedEvaluationCase["candidateRankings"] {
  const dense: PreparedEvaluationCase["candidateRankings"]["dense"] = [];
  for (const ranking of rankings.dense) {
    const candidates = [];
    for (const candidate of ranking) {
      candidates.push(serializeDenseCandidate(candidate));
    }
    dense.push(candidates);
  }
  const lexical: PreparedEvaluationCase["candidateRankings"]["lexical"] = [];
  for (const ranking of rankings.lexical) {
    const candidates = [];
    for (const candidate of ranking) {
      candidates.push(serializeLexicalCandidate(candidate));
    }
    lexical.push(candidates);
  }
  return { dense, lexical };
}

function serializeDenseCandidate(candidate: DenseCandidate) {
  return {
    distance: candidate.distance,
    documentId: candidate.documentId,
    evidenceContent: candidate.evidenceContent,
    evidenceRetrievalId: candidate.evidenceRetrievalId,
    elementId: candidate.parentId,
    representation: candidate.representation,
    sourceFile: candidate.sourceFile,
  };
}

function serializeLexicalCandidate(candidate: LexicalCandidate) {
  return {
    bm25Score: candidate.bm25Score,
    documentId: candidate.documentId,
    evidenceContent: candidate.evidenceContent,
    evidenceRetrievalId: candidate.evidenceRetrievalId,
    elementId: candidate.parentId,
    representation: candidate.representation,
    sourceFile: candidate.sourceFile,
  };
}

function buildEvaluationProvenance(
  config: AppConfig,
  dataset: BenchmarkEvaluationDataset,
  datasetContent: string,
  documentIds: string[],
  models: InferenceModelRegistry,
  context: EvaluationPreparationContext,
): EvaluationProvenance {
  const reranker = models.reranker;
  const rerankerIdentity = reranker === null
    ? null
    : {
      modelId: reranker.model.modelId,
      provider: reranker.model.provider,
    };
  return {
    codeRevision: context.codeRevision,
    corpus: {
      documentIds: [...documentIds],
      sha256: calculateJsonSha256(documentIds),
    },
    dataset: {
      access: dataset.access,
      atK: dataset.atK,
      configurationFreezeSha256: dataset.access === "sealed"
        ? context.frozenConfiguration?.fingerprintSha256 ?? null
        : null,
      name: dataset.name,
      sha256: calculateSha256(datasetContent),
      split: dataset.split,
      statisticalDesign: { ...dataset.statisticalDesign },
    },
    embeddingSpace: { ...config.embeddingSpace },
    hnsw: { ...HNSW_QUERY_SETTINGS },
    models: {
      queryEmbedding: {
        modelId: models.queryEmbedding.modelId,
        provider: models.queryEmbedding.provider,
      },
      queryExpansion: {
        modelId: models.summary.modelId,
        provider: models.summary.provider,
      },
      reranker: rerankerIdentity,
    },
    retrieval: {
      candidateK: config.retrieval.candidateK,
      channelOrderingPolicy: CHANNEL_ORDERING_POLICY,
      fusion: { ...config.retrieval.fusion },
      queryExpansions: config.retrieval.queryExpansions,
      rrfK: config.retrieval.rrfK,
      topK: config.retrieval.topK,
      variantConcurrency: config.retrieval.variantConcurrency,
    },
    settingsVersion: context.settingsVersion,
  };
}

function compareResolvedQueryTargets(
  left: ResolvedQueryScopeTarget,
  right: ResolvedQueryScopeTarget,
): number {
  const documentOrder = left.documentId.localeCompare(right.documentId);
  if (documentOrder !== 0) {
    return documentOrder;
  }
  return left.sourceFile.localeCompare(right.sourceFile);
}

function readAvailableModes(config: AppConfig): {
  available: RetrievalMode[];
  skipped: RetrievalMode[];
} {
  const available: RetrievalMode[] = [];
  const skipped: RetrievalMode[] = [];
  for (const mode of comparativeRetrievalModes) {
    if (mode === "hybrid-reranked" && config.retrieval.reranker === null) {
      skipped.push(mode);
      continue;
    }
    available.push(mode);
  }
  return { available, skipped };
}

function createQueryGenerationSeed(datasetSha256: string, caseId: string): number {
  const digest = calculateSha256(`${datasetSha256}:query-expansion:${caseId}`);
  return Number.parseInt(digest.slice(0, 8), 16) % 2_147_483_647;
}
