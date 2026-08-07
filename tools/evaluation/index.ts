import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { AppConfig, RankFusionConfig } from "../../src/config/index.js";
import type { NonOverlappingCandidateSelection } from "../../src/retrieval/document-retrieval.js";
import type { RetrievedElement } from "../../src/retrieval/document-retrieval.js";
import type {
  EvaluationAccess,
  EvaluationDataset,
  EvaluationJudgment,
  EvaluationLanguage,
  EvaluationQuestionType,
  EvaluationStatisticalDesign,
} from "./dataset.js";
import {
  assertEvaluationProvenanceMatches,
  calculateJsonSha256,
  readPreparedCandidateRankings,
  type EvaluationBenchmarkTelemetry,
  type EvaluationPreparationArtifact,
  type EvaluationProvenance,
  type PreparedEvaluationCase,
} from "./artifact.js";
import {
  prepareComparativeEvaluation,
  type EvaluationPreparationContext,
} from "./preparation.js";
import {
  calculateBootstrapMeanInterval,
  type EvaluationConfidenceInterval,
} from "./statistics.js";
import {
  selectPreparedRerankingCandidatesWithTrace,
  selectPreparedRetrievalCandidates,
  type RetrievalCandidateRankings,
} from "../../src/retrieval/indexing/query-store.js";
import type { FusedCandidate } from "../../src/retrieval/ranking/rank-fusion.js";
import { createEvidenceSha256 } from "../../src/retrieval/evidence-identity.js";
import {
  selectRerankedContext,
  type ContextSelectionPolicy,
  type PostRerankCandidateSelection,
} from "../../src/retrieval/ranking/candidate-selection.js";
import {
  EVALUATION_RETRIEVAL_MODES,
  type EvaluationRetrievalMode,
} from "./retrieval-mode.js";

const comparativeRetrievalModes = EVALUATION_RETRIEVAL_MODES;

export interface EvaluationCaseResult {
  domain: string;
  id: string;
  language: EvaluationLanguage;
  ndcg: number;
  questionType: EvaluationQuestionType;
  question: string;
  recall: number;
  relevantRetrieved: number;
  retrieved: number;
  sourceKind: "image" | "table" | "text";
}

export interface EvaluationDomainResult {
  caseCount: number;
  domain: string;
  meanNdcg: number;
  meanRecall: number;
}

export interface EvaluationMethodResult {
  cases: EvaluationCaseResult[];
  domains: EvaluationDomainResult[];
  languages: EvaluationSliceResult[];
  macroMeanNdcg: number;
  macroMeanRecall: number;
  meanNdcg: number;
  meanNdcgInterval: EvaluationConfidenceInterval;
  meanRecall: number;
  meanRecallInterval: EvaluationConfidenceInterval;
  mode: EvaluationRetrievalMode;
  questionTypes: EvaluationSliceResult[];
  sourceKinds: EvaluationSliceResult[];
}

export interface EvaluationSliceResult {
  caseCount: number;
  meanNdcg: number;
  meanRecall: number;
  value: string;
}

export interface EvaluationCoverageCount {
  count: number;
  value: string;
}

export interface EvaluationCoverage {
  caseCount: number;
  domains: EvaluationCoverageCount[];
  languages: EvaluationCoverageCount[];
  questionTypes: EvaluationCoverageCount[];
  sourceKinds: EvaluationCoverageCount[];
}

export interface EvaluationCaseDelta {
  domain: string;
  id: string;
  ndcgDelta: number;
  recallDelta: number;
}

export interface EvaluationMethodComparison {
  baselineMode: EvaluationRetrievalMode;
  cases: EvaluationCaseDelta[];
  contenderMode: EvaluationRetrievalMode;
  meanNdcgDelta: number;
  meanNdcgDeltaInterval: EvaluationConfidenceInterval;
  meanRecallDelta: number;
  meanRecallDeltaInterval: EvaluationConfidenceInterval;
}

export interface EvaluationConfiguration {
  candidateK: number;
  embeddingSpaceId: string;
  fusion: RankFusionConfig;
  queryExpansionModel: string | null;
  queryExpansions: number;
  rerankerModel: string | null;
  rrfK: number;
  topK: number;
}

export interface EvaluationResult {
  access: EvaluationAccess;
  atK: number;
  benchmarkTelemetry: EvaluationBenchmarkTelemetry[];
  comparisons: EvaluationMethodComparison[];
  configuration: EvaluationConfiguration;
  coverage: EvaluationCoverage;
  datasetName: string;
  methods: EvaluationMethodResult[];
  preparation: {
    sha256: string;
    version: EvaluationPreparationArtifact["version"];
  };
  provenance: EvaluationProvenance;
  skippedModes: EvaluationRetrievalMode[];
  split: EvaluationDataset["split"];
  statisticalDesign: EvaluationStatisticalDesign;
}

export interface EvaluationRun {
  preparation: EvaluationPreparationArtifact;
  result: EvaluationResult;
}

export interface EvaluationRetrievedCandidate {
  documentId: string;
  elementId: string;
}

export interface PreparedRetrievalScoringConfig {
  candidateK: number;
  fusion: RankFusionConfig;
  queryExpansions: number;
  rrfK: number;
  topK: number;
}

export interface ContextPolicyEvaluationResult {
  cases: Array<{
    cliffContextSize: number;
    cliffRecall: number;
    id: string;
    topKContextSize: number;
    topKRecall: number;
  }>;
  cliffMeanContextSize: number;
  cliffMeanRecall: number;
  topKMeanContextSize: number;
  topKMeanRecall: number;
}

export { readEvaluationDataset } from "./dataset.js";

export async function writeEvaluationResult(
  filePath: string,
  result: EvaluationResult,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeEvaluationResult(result), {
    encoding: "utf8",
    flag: "wx",
  });
}

export async function evaluateRetrieval(
  config: AppConfig,
  datasetPath: string,
  context: EvaluationPreparationContext,
  reportProgress: (message: string) => void,
): Promise<EvaluationRun> {
  const preparation = await prepareComparativeEvaluation(
    config,
    datasetPath,
    context,
    reportProgress,
  );
  return { preparation, result: scorePreparedEvaluation(preparation) };
}

export function scorePreparedEvaluation(
  preparation: EvaluationPreparationArtifact,
): EvaluationResult {
  const methods: EvaluationMethodResult[] = [];
  for (const mode of comparativeRetrievalModes) {
    if (preparation.skippedModes.includes(mode)) {
      continue;
    }
    const cases: EvaluationCaseResult[] = [];
    for (const preparedCase of preparation.cases) {
      cases.push(buildPreparedEvaluationCaseResult(
        preparedCase,
        derivePreparedEvaluationCandidates(
          preparedCase,
          mode,
          preparation.provenance.retrieval,
        ),
        preparation.provenance.dataset.atK,
      ));
    }
    methods.push(summarizeEvaluationMethod(
      mode,
      cases,
      preparation.provenance.dataset.sha256,
    ));
  }
  const provenance = preparation.provenance;
  return {
    access: provenance.dataset.access,
    atK: provenance.dataset.atK,
    benchmarkTelemetry: structuredClone(preparation.telemetry),
    comparisons: buildMethodComparisons(
      methods,
      provenance.dataset.sha256,
    ),
    configuration: {
      candidateK: provenance.retrieval.candidateK,
      embeddingSpaceId: provenance.embeddingSpace.id,
      fusion: { ...provenance.retrieval.fusion },
      queryExpansionModel: provenance.models.queryExpansion?.modelId ?? null,
      queryExpansions: provenance.retrieval.queryExpansions,
      rerankerModel: provenance.models.reranker?.modelId ?? null,
      rrfK: provenance.retrieval.rrfK,
      topK: provenance.retrieval.topK,
    },
    coverage: buildEvaluationCoverage(preparation.cases),
    datasetName: provenance.dataset.name,
    methods,
    preparation: {
      sha256: calculateJsonSha256(preparation),
      version: preparation.version,
    },
    provenance,
    skippedModes: [...preparation.skippedModes],
    split: provenance.dataset.split,
    statisticalDesign: { ...provenance.dataset.statisticalDesign },
  };
}

export function serializeEvaluationResult(result: EvaluationResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function assertEvaluationResultMatchesPreparation(
  result: EvaluationResult,
  preparation: EvaluationPreparationArtifact,
): void {
  assertEvaluationProvenanceMatches(result.provenance, preparation.provenance);
  const preparationSha256 = calculateJsonSha256(preparation);
  if (result.preparation.sha256 !== preparationSha256) {
    throw new Error("Evaluation baseline preparation does not match.");
  }
  if (result.preparation.version !== preparation.version) {
    throw new Error("Evaluation baseline preparation version does not match.");
  }
}

export function readAvailableEvaluationModes(config: AppConfig): {
  available: EvaluationRetrievalMode[];
  skipped: EvaluationRetrievalMode[];
} {
  const available: EvaluationRetrievalMode[] = [];
  const skipped: EvaluationRetrievalMode[] = [];
  for (const mode of comparativeRetrievalModes) {
    if (mode === "hybrid-reranked" && config.retrieval.reranker === null) {
      skipped.push(mode);
      continue;
    }
    available.push(mode);
  }
  return { available, skipped };
}

function buildPreparedEvaluationCaseResult(
  evaluationCase: PreparedEvaluationCase,
  retrieved: EvaluationRetrievedCandidate[],
  atK: number,
): EvaluationCaseResult {
  const score = calculateGradedCandidateNdcgAtK(
    retrieved,
    evaluationCase.judgments,
    atK,
  );
  return {
    domain: evaluationCase.domain,
    id: evaluationCase.id,
    language: evaluationCase.metadata.language,
    ndcg: score.ndcg,
    questionType: evaluationCase.metadata.questionType,
    question: evaluationCase.question,
    recall: score.recall,
    relevantRetrieved: score.relevantRetrieved,
    retrieved: retrieved.length,
    sourceKind: evaluationCase.metadata.source.kind,
  };
}

export function derivePreparedEvaluationCandidates(
  evaluationCase: PreparedEvaluationCase,
  mode: EvaluationRetrievalMode,
  config: PreparedRetrievalScoringConfig,
  contextPolicy: "relevance-cliff" | "top-k" = "relevance-cliff",
  rerankerScoreSource: PreparedRerankerScoreSource = "production",
): EvaluationRetrievedCandidate[] {
  const configuredQueryCount = config.queryExpansions + 1;
  const queryCount = Math.min(configuredQueryCount, evaluationCase.queries.length);
  const preparedRankings = readPreparedCandidateRankings(evaluationCase);
  const rankings = slicePreparedRankings(
    preparedRankings,
    queryCount,
    config.candidateK,
  );
  if (mode === "hybrid-reranked") {
    const selection = derivePreparedRerankedSelection(
      evaluationCase,
      rankings,
      config,
      contextPolicy,
      rerankerScoreSource,
    );
    return selection.postRerank.selected.map((candidate) => ({
      documentId: candidate.item.documentId,
      elementId: candidate.item.parentId,
    }));
  }
  const candidates = selectPreparedRetrievalCandidates(
    mode,
    evaluationCase.question,
    rankings,
    config.candidateK,
    config.topK,
    config.rrfK,
    config.fusion,
  );
  return candidates.map((candidate) => ({
    documentId: candidate.documentId,
    elementId: candidate.parentId,
  }));
}

export interface PreparedRerankedSelection {
  postRerank: PostRerankCandidateSelection<FusedCandidate>;
  preRerank: NonOverlappingCandidateSelection;
}

export type PreparedRerankerScoreSource =
  | "production"
  | "tuning-universe";

export function derivePreparedRerankedSelection(
  evaluationCase: PreparedEvaluationCase,
  rankings: RetrievalCandidateRankings,
  config: PreparedRetrievalScoringConfig,
  contextPolicy: ContextSelectionPolicy = "relevance-cliff",
  rerankerScoreSource: PreparedRerankerScoreSource = "production",
): PreparedRerankedSelection {
  const preRerank = selectPreparedRerankingCandidatesWithTrace(
    evaluationCase.question,
    rankings,
    config.candidateK,
    config.rrfK,
    config.fusion,
  );
  const scores = rerankerScoreSource === "production"
    ? evaluationCase.rerankerScores
    : evaluationCase.tuningRerankerScores;
  if (scores === null) {
    throw new Error(
      `Evaluation case ${evaluationCase.id} has no prepared reranker scores.`,
    );
  }
  const scoreByRetrievalId = new Map<string, (typeof scores)[number]>();
  for (const score of scores) {
    scoreByRetrievalId.set(score.retrievalId, score);
  }
  const scored = [];
  for (let index = 0; index < preRerank.selected.length; index += 1) {
    const candidate = preRerank.selected[index];
    if (candidate === undefined) {
      continue;
    }
    const score = scoreByRetrievalId.get(candidate.retrievalId);
    if (score === undefined) {
      throw new Error(
        `Evaluation case ${evaluationCase.id} has incomplete reranker scores.`,
      );
    }
    if (
      score.documentId !== candidate.documentId
      || score.elementId !== candidate.parentId
      || score.sourceFile !== candidate.sourceFile
    ) {
      throw new Error(
        `Evaluation case ${evaluationCase.id} has contradictory reranker identity.`,
      );
    }
    scored.push({
      identity: {
        documentId: score.documentId,
        documentVersionId: score.documentVersionId,
        elementSetId: candidate.elementSetId,
        elementId: score.elementId,
        evidenceSha256: createEvidenceSha256(candidate.evidenceContent),
        representativeRetrievalWindowId: score.retrievalId,
        sourceFile: score.sourceFile,
      },
      item: candidate,
      queryIndexes: [...new Set(
        candidate.representationHits.map((hit) => hit.queryIndex),
      )].sort((left, right) => left - right),
      relevanceScore: score.relevanceScore,
      rerankerInputRank: index + 1,
    });
  }
  const postRerank = selectRerankedContext(
    scored,
    config.topK,
    contextPolicy,
  );
  return {
    postRerank,
    preRerank,
  };
}

export function compareRerankerContextPolicies(
  preparation: EvaluationPreparationArtifact,
): ContextPolicyEvaluationResult {
  if (preparation.skippedModes.includes("hybrid-reranked")) {
    throw new Error("Context-policy comparison requires prepared reranker scores.");
  }
  const cases: ContextPolicyEvaluationResult["cases"] = [];
  let cliffRecallTotal = 0;
  let topKRecallTotal = 0;
  let cliffContextTotal = 0;
  let topKContextTotal = 0;
  for (const preparedCase of preparation.cases) {
    const cliff = derivePreparedEvaluationCandidates(
      preparedCase,
      "hybrid-reranked",
      preparation.provenance.retrieval,
      "relevance-cliff",
    );
    const topK = derivePreparedEvaluationCandidates(
      preparedCase,
      "hybrid-reranked",
      preparation.provenance.retrieval,
      "top-k",
    );
    const cliffRecall = calculatePreparedRecall(preparedCase, cliff);
    const topKRecall = calculatePreparedRecall(preparedCase, topK);
    cases.push({
      cliffContextSize: cliff.length,
      cliffRecall,
      id: preparedCase.id,
      topKContextSize: topK.length,
      topKRecall,
    });
    cliffRecallTotal += cliffRecall;
    topKRecallTotal += topKRecall;
    cliffContextTotal += cliff.length;
    topKContextTotal += topK.length;
  }
  const caseCount = cases.length;
  if (caseCount === 0) {
    throw new Error("Context-policy comparison requires evaluation cases.");
  }
  return {
    cases,
    cliffMeanContextSize: cliffContextTotal / caseCount,
    cliffMeanRecall: cliffRecallTotal / caseCount,
    topKMeanContextSize: topKContextTotal / caseCount,
    topKMeanRecall: topKRecallTotal / caseCount,
  };
}

function calculatePreparedRecall(
  evaluationCase: PreparedEvaluationCase,
  retrieved: readonly EvaluationRetrievedCandidate[],
): number {
  const relevantIds = new Set<string>();
  for (const judgment of evaluationCase.judgments) {
    if (judgment.relevance === "irrelevant") {
      continue;
    }
    relevantIds.add(judgment.target.id);
  }
  if (relevantIds.size === 0) {
    return 1;
  }
  let retrievedRelevant = 0;
  for (const candidate of retrieved) {
    if (relevantIds.has(candidate.elementId) || relevantIds.has(candidate.documentId)) {
      retrievedRelevant += 1;
    }
  }
  return Math.min(1, retrievedRelevant / relevantIds.size);
}

function slicePreparedRankings(
  rankings: RetrievalCandidateRankings,
  queryCount: number,
  candidateK: number,
): RetrievalCandidateRankings {
  const dense = [];
  const lexical = [];
  for (let index = 0; index < queryCount; index += 1) {
    const denseRanking = rankings.dense[index];
    const lexicalRanking = rankings.lexical[index];
    if (denseRanking === undefined || lexicalRanking === undefined) {
      throw new Error(`Prepared candidate ranking ${index + 1} is missing.`);
    }
    dense.push(denseRanking.slice(0, candidateK));
    lexical.push(lexicalRanking.slice(0, candidateK));
  }
  return { dense, lexical };
}

export function summarizeEvaluationMethod(
  mode: EvaluationRetrievalMode,
  cases: EvaluationCaseResult[],
  seed: string = `${mode}:${cases.map((entry) => entry.id).join(":")}`,
): EvaluationMethodResult {
  const domains = calculateDomainResults(cases);
  const domainScores: number[] = [];
  const domainRecallScores: number[] = [];
  for (const domain of domains) {
    domainScores.push(domain.meanNdcg);
    domainRecallScores.push(domain.meanRecall);
  }
  const caseScores: number[] = [];
  const caseRecallScores: number[] = [];
  for (const evaluationCase of cases) {
    caseScores.push(evaluationCase.ndcg);
    caseRecallScores.push(evaluationCase.recall);
  }
  return {
    cases,
    domains,
    languages: calculateSliceResults(cases, (entry) => entry.language),
    macroMeanNdcg: calculateMean(domainScores),
    macroMeanRecall: calculateMean(domainRecallScores),
    meanNdcg: calculateMean(caseScores),
    meanNdcgInterval: calculateBootstrapMeanInterval(
      caseScores,
      `${seed}:${mode}:ndcg`,
    ),
    meanRecall: calculateMean(caseRecallScores),
    meanRecallInterval: calculateBootstrapMeanInterval(
      caseRecallScores,
      `${seed}:${mode}:recall`,
    ),
    mode,
    questionTypes: calculateSliceResults(
      cases,
      (entry) => entry.questionType,
    ),
    sourceKinds: calculateSliceResults(cases, (entry) => entry.sourceKind),
  };
}

function calculateSliceResults(
  cases: EvaluationCaseResult[],
  readValue: (evaluationCase: EvaluationCaseResult) => string,
): EvaluationSliceResult[] {
  const casesByValue = new Map<string, EvaluationCaseResult[]>();
  for (const evaluationCase of cases) {
    const value = readValue(evaluationCase);
    const existing = casesByValue.get(value);
    if (existing === undefined) {
      casesByValue.set(value, [evaluationCase]);
    } else {
      existing.push(evaluationCase);
    }
  }
  const values = [...casesByValue.keys()];
  values.sort();
  const results: EvaluationSliceResult[] = [];
  for (const value of values) {
    const sliceCases = casesByValue.get(value);
    if (sliceCases === undefined) {
      throw new Error(`Evaluation scores are missing for slice ${value}.`);
    }
    const ndcgScores: number[] = [];
    const recallScores: number[] = [];
    for (const evaluationCase of sliceCases) {
      ndcgScores.push(evaluationCase.ndcg);
      recallScores.push(evaluationCase.recall);
    }
    results.push({
      caseCount: sliceCases.length,
      meanNdcg: calculateMean(ndcgScores),
      meanRecall: calculateMean(recallScores),
      value,
    });
  }
  return results;
}

function calculateDomainResults(
  cases: EvaluationCaseResult[],
): EvaluationDomainResult[] {
  const casesByDomain = new Map<string, EvaluationCaseResult[]>();
  for (const evaluationCase of cases) {
    const existing = casesByDomain.get(evaluationCase.domain);
    if (existing === undefined) {
      casesByDomain.set(evaluationCase.domain, [evaluationCase]);
      continue;
    }
    existing.push(evaluationCase);
  }

  const domainNames = [...casesByDomain.keys()];
  domainNames.sort((left, right) => left.localeCompare(right));
  const results: EvaluationDomainResult[] = [];
  for (const domain of domainNames) {
    const domainCases = casesByDomain.get(domain);
    if (domainCases === undefined) {
      throw new Error(`Evaluation scores are missing for domain ${domain}.`);
    }
    const ndcgScores = domainCases.map((entry) => entry.ndcg);
    const recallScores = domainCases.map((entry) => entry.recall);
    results.push({
      caseCount: domainCases.length,
      domain,
      meanNdcg: calculateMean(ndcgScores),
      meanRecall: calculateMean(recallScores),
    });
  }
  return results;
}

function buildEvaluationCoverage(
  cases: PreparedEvaluationCase[],
): EvaluationCoverage {
  return {
    caseCount: cases.length,
    domains: countCoverageValues(cases, (entry) => entry.domain),
    languages: countCoverageValues(
      cases,
      (entry) => entry.metadata.language,
    ),
    questionTypes: countCoverageValues(
      cases,
      (entry) => entry.metadata.questionType,
    ),
    sourceKinds: countCoverageValues(
      cases,
      (entry) => entry.metadata.source.kind,
    ),
  };
}

function countCoverageValues(
  cases: PreparedEvaluationCase[],
  readValue: (evaluationCase: PreparedEvaluationCase) => string,
): EvaluationCoverageCount[] {
  const counts = new Map<string, number>();
  for (const evaluationCase of cases) {
    const value = readValue(evaluationCase);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const values = [...counts.keys()];
  values.sort();
  const results: EvaluationCoverageCount[] = [];
  for (const value of values) {
    const count = counts.get(value);
    if (count === undefined) {
      throw new Error(`Evaluation coverage is missing for ${value}.`);
    }
    results.push({ count, value });
  }
  return results;
}

function buildMethodComparisons(
  methods: EvaluationMethodResult[],
  seed: string,
): EvaluationMethodComparison[] {
  const comparisons: EvaluationMethodComparison[] = [];
  for (let baselineIndex = 0; baselineIndex < methods.length; baselineIndex += 1) {
    const baseline = methods[baselineIndex];
    if (baseline === undefined) {
      continue;
    }
    for (
      let contenderIndex = baselineIndex + 1;
      contenderIndex < methods.length;
      contenderIndex += 1
    ) {
      const contender = methods[contenderIndex];
      if (contender === undefined) {
        continue;
      }
      comparisons.push(buildMethodComparison(baseline, contender, seed));
    }
  }
  return comparisons;
}

function buildMethodComparison(
  baseline: EvaluationMethodResult,
  contender: EvaluationMethodResult,
  seed: string,
): EvaluationMethodComparison {
  const contenderCases = new Map<string, EvaluationCaseResult>();
  for (const evaluationCase of contender.cases) {
    contenderCases.set(evaluationCase.id, evaluationCase);
  }
  const cases: EvaluationCaseDelta[] = [];
  const ndcgDeltas: number[] = [];
  const recallDeltas: number[] = [];
  for (const baselineCase of baseline.cases) {
    const contenderCase = contenderCases.get(baselineCase.id);
    if (contenderCase === undefined) {
      throw new Error(
        `${contender.mode} is missing evaluation case ${baselineCase.id}.`,
      );
    }
    const ndcgDelta = contenderCase.ndcg - baselineCase.ndcg;
    const recallDelta = contenderCase.recall - baselineCase.recall;
    cases.push({
      domain: baselineCase.domain,
      id: baselineCase.id,
      ndcgDelta,
      recallDelta,
    });
    ndcgDeltas.push(ndcgDelta);
    recallDeltas.push(recallDelta);
  }
  if (cases.length !== contender.cases.length) {
    throw new Error(
      `${baseline.mode} and ${contender.mode} do not contain the same cases.`,
    );
  }
  const comparisonSeed = `${seed}:${baseline.mode}:${contender.mode}`;
  return {
    baselineMode: baseline.mode,
    cases,
    contenderMode: contender.mode,
    meanNdcgDelta: calculateMean(ndcgDeltas),
    meanNdcgDeltaInterval: calculateBootstrapMeanInterval(
      ndcgDeltas,
      `${comparisonSeed}:ndcg`,
    ),
    meanRecallDelta: calculateMean(recallDeltas),
    meanRecallDeltaInterval: calculateBootstrapMeanInterval(
      recallDeltas,
      `${comparisonSeed}:recall`,
    ),
  };
}

function calculateMean(values: number[]): number {
  if (values.length === 0) {
    throw new Error("Cannot calculate an evaluation mean without scores.");
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total / values.length;
}

export function calculateNdcgAtK(
  retrieved: RetrievedElement[],
  relevantDocumentIds: string[],
  relevantElementIds: string[],
  atK: number,
): { ndcg: number; recall: number; relevantRetrieved: number } {
  const candidates: EvaluationRetrievedCandidate[] = [];
  for (const result of retrieved) {
    candidates.push({
      documentId: result.element.documentId,
      elementId: result.element.id,
    });
  }
  return calculateCandidateNdcgAtK(
    candidates,
    relevantDocumentIds,
    relevantElementIds,
    atK,
  );
}

export function calculateGradedNdcgAtK(
  retrieved: RetrievedElement[],
  judgments: EvaluationJudgment[],
  atK: number,
): { ndcg: number; recall: number; relevantRetrieved: number } {
  const candidates: EvaluationRetrievedCandidate[] = [];
  for (const result of retrieved) {
    candidates.push({
      documentId: result.element.documentId,
      elementId: result.element.id,
    });
  }
  return calculateGradedCandidateNdcgAtK(candidates, judgments, atK);
}

export function calculateGradedCandidateNdcgAtK(
  retrieved: EvaluationRetrievedCandidate[],
  judgments: EvaluationJudgment[],
  atK: number,
): { ndcg: number; recall: number; relevantRetrieved: number } {
  if (!Number.isInteger(atK) || atK < 1) {
    throw new Error("NDCG k must be a positive integer.");
  }
  const documentGrades = new Map<string, number>();
  const elementGrades = new Map<string, number>();
  const idealGains: number[] = [];
  for (const judgment of judgments) {
    if (judgment.review.auditStatus !== "accepted") {
      throw new Error("Graded evaluation requires accepted judgments.");
    }
    const grade = readRelevanceGrade(judgment);
    if (grade === 0) {
      continue;
    }
    idealGains.push(readGradedGain(grade));
    if (judgment.target.kind === "document") {
      documentGrades.set(judgment.target.id, grade);
    } else {
      elementGrades.set(judgment.target.id, grade);
    }
  }
  idealGains.sort((left, right) => right - left);
  const seenLabels = new Set<string>();
  let dcg = 0;
  let relevantRetrieved = 0;
  const resultCount = Math.min(atK, retrieved.length);
  for (let index = 0; index < resultCount; index += 1) {
    const result = retrieved[index];
    if (result === undefined) {
      continue;
    }
    const grade = readRetrievedGrade(
      result,
      documentGrades,
      elementGrades,
      seenLabels,
    );
    if (grade === 0) {
      continue;
    }
    relevantRetrieved += 1;
    dcg += readGradedGain(grade) * discountedGain(index);
  }
  let idealDcg = 0;
  const idealCount = Math.min(atK, idealGains.length);
  for (let index = 0; index < idealCount; index += 1) {
    const gain = idealGains[index];
    if (gain !== undefined) {
      idealDcg += gain * discountedGain(index);
    }
  }
  return {
    ndcg: idealDcg === 0 ? 0 : dcg / idealDcg,
    recall: idealGains.length === 0
      ? 0
      : relevantRetrieved / idealGains.length,
    relevantRetrieved,
  };
}

function readRelevanceGrade(judgment: EvaluationJudgment): number {
  if (judgment.relevance === "direct") {
    return 3;
  }
  if (judgment.relevance === "partial") {
    return 2;
  }
  if (judgment.relevance === "topical") {
    return 1;
  }
  return 0;
}

function readGradedGain(grade: number): number {
  return (2 ** grade) - 1;
}

function readRetrievedGrade(
  result: EvaluationRetrievedCandidate,
  documentGrades: Map<string, number>,
  elementGrades: Map<string, number>,
  seenLabels: Set<string>,
): number {
  const elementLabel = `element:${result.elementId}`;
  const elementGrade = elementGrades.get(result.elementId);
  if (elementGrade !== undefined && !seenLabels.has(elementLabel)) {
    seenLabels.add(elementLabel);
    return elementGrade;
  }
  const documentLabel = `document:${result.documentId}`;
  const documentGrade = documentGrades.get(result.documentId);
  if (documentGrade !== undefined && !seenLabels.has(documentLabel)) {
    seenLabels.add(documentLabel);
    return documentGrade;
  }
  return 0;
}

function calculateCandidateNdcgAtK(
  retrieved: EvaluationRetrievedCandidate[],
  relevantDocumentIds: string[],
  relevantElementIds: string[],
  atK: number,
): { ndcg: number; recall: number; relevantRetrieved: number } {
  if (!Number.isInteger(atK) || atK < 1) {
    throw new Error("NDCG k must be a positive integer.");
  }
  const relevantDocuments = new Set(relevantDocumentIds);
  const relevantElements = new Set(relevantElementIds);
  const seenLabels = new Set<string>();
  let dcg = 0;
  let relevantRetrieved = 0;
  const resultCount = Math.min(atK, retrieved.length);
  for (let index = 0; index < resultCount; index += 1) {
    const result = retrieved[index];
    if (result === undefined) {
      continue;
    }
    const label = readRelevanceLabel(
      result,
      relevantDocuments,
      relevantElements,
      seenLabels,
    );
    if (label === null) {
      continue;
    }
    seenLabels.add(label);
    relevantRetrieved += 1;
    dcg += discountedGain(index);
  }

  const idealRelevantCount = Math.min(
    atK,
    relevantDocuments.size + relevantElements.size,
  );
  const totalRelevantCount = relevantDocuments.size + relevantElements.size;
  let idealDcg = 0;
  for (let index = 0; index < idealRelevantCount; index += 1) {
    idealDcg += discountedGain(index);
  }
  const ndcg = idealDcg === 0 ? 0 : dcg / idealDcg;
  const recall = totalRelevantCount === 0
    ? 0
    : relevantRetrieved / totalRelevantCount;
  return { ndcg, recall, relevantRetrieved };
}

function readRelevanceLabel(
  result: EvaluationRetrievedCandidate,
  relevantDocumentIds: Set<string>,
  relevantElementIds: Set<string>,
  seenLabels: Set<string>,
): string | null {
  const elementLabel = `element:${result.elementId}`;
  if (
    relevantElementIds.has(result.elementId) &&
    !seenLabels.has(elementLabel)
  ) {
    return elementLabel;
  }
  const documentLabel = `document:${result.documentId}`;
  if (
    relevantDocumentIds.has(result.documentId) &&
    !seenLabels.has(documentLabel)
  ) {
    return documentLabel;
  }
  return null;
}

function discountedGain(index: number): number {
  return 1 / Math.log2(index + 2);
}
