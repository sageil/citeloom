import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type {
  AppConfig,
  RetrievalMode,
} from "../../src/config/index.js";
import {
  calculateJsonSha256,
  type EvaluationPreparationArtifact,
  type PreparedEvaluationCase,
} from "./artifact.js";
import {
  assertEvaluationConfigurationFrozen,
  createEvaluationConfigurationFreeze,
  type EvaluationConfigurationFreeze,
} from "./freeze.js";
import {
  calculateGradedCandidateNdcgAtK,
  derivePreparedEvaluationCandidates,
  type EvaluationCaseResult,
  type EvaluationDomainResult,
} from "./index.js";
import type { TelemetryStageSnapshot } from "../../src/observability/run.js";

const MAXIMUM_SEARCH_CANDIDATES = 25_000;
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const finitePositiveNumberSchema = z.number().positive().max(100);
const fusionSchema = z.object({
  denseWeight: finitePositiveNumberSchema,
  expansionDecay: z.number().positive().max(1),
  expansionQueryWeight: finitePositiveNumberSchema,
  lexicalWeight: finitePositiveNumberSchema,
  originalQueryWeight: finitePositiveNumberSchema,
}).strict();
const tunedRetrievalConfigurationSchema = z.object({
  fusion: fusionSchema,
  queryExpansions: z.number().int().min(0).max(2),
  rerankerCandidateDepth: z.number().int().min(1),
  rrfK: z.number().int().min(1).max(1_000),
}).strict();
const uniquePositiveNumbersSchema = z.array(finitePositiveNumberSchema)
  .min(1)
  .max(20)
  .superRefine(requireUniqueNumbers);
const uniqueDecayNumbersSchema = z.array(
  z.number().positive().max(1),
).min(1).max(20).superRefine(requireUniqueNumbers);
const uniquePositiveIntegersSchema = z.array(
  z.number().int().min(1).max(1_000),
).min(1).max(20).superRefine(requireUniqueNumbers);
const tuningObjectiveSchema = z.object({
  metric: z.literal("domain-macro-mean-ndcg"),
  minimumImprovement: z.number().positive().max(1),
}).strict();
const tuningConstraintsSchema = z.object({
  maximumDomainNdcgRegression: z.number().min(0).max(1),
  maximumEstimatedP95LatencyMs: z.number().positive(),
  maximumEstimatedP95LatencyRegressionMs: z.number().min(0),
}).strict();
const evaluationTuningSpecificationSchema = z.object({
  constraints: tuningConstraintsSchema,
  objective: tuningObjectiveSchema,
  referenceConfiguration: tunedRetrievalConfigurationSchema,
  searchSpace: z.object({
    denseWeights: uniquePositiveNumbersSchema,
    expansionCounts: z.array(z.number().int().min(0).max(2))
      .length(3)
      .superRefine(requireZeroOneTwo),
    expansionDecays: uniqueDecayNumbersSchema,
    expansionWeights: uniquePositiveNumbersSchema,
    lexicalWeights: uniquePositiveNumbersSchema,
    originalQuestionWeights: uniquePositiveNumbersSchema,
    rerankerCandidateDepths: z.array(z.number().int().min(1))
      .min(1)
      .max(20)
      .superRefine(requireUniqueNumbers),
    rrfConstants: uniquePositiveIntegersSchema,
  }).strict(),
  version: z.literal(1),
}).strict().superRefine(validateSearchSize);

const domainMetricSchema = z.object({
  caseCount: z.number().int().positive(),
  domain: z.string().min(1),
  meanNdcg: z.number().min(0).max(1),
  meanRecall: z.number().min(0).max(1),
}).strict();
const tuningQualitySummarySchema = z.object({
  caseCount: z.number().int().positive(),
  domainMacroMeanNdcg: z.number().min(0).max(1),
  domainMacroMeanRecall: z.number().min(0).max(1),
  domains: z.array(domainMetricSchema).min(1),
  meanNdcg: z.number().min(0).max(1),
  meanRecall: z.number().min(0).max(1),
}).strict();
const tuningMetricsSchema = tuningQualitySummarySchema.extend({
  estimatedP95LatencyMs: z.number().nonnegative(),
}).strict();
const domainRegressionSchema = z.object({
  domain: z.string().min(1),
  ndcgRegression: z.number(),
}).strict();
const rejectionReasonSchema = z.enum([
  "absolute-latency-limit",
  "domain-regression-limit",
  "latency-regression-limit",
  "objective-not-improved",
]);
const candidateAssessmentSchema = z.object({
  configuration: tunedRetrievalConfigurationSchema,
  domainRegressions: z.array(domainRegressionSchema),
  eligible: z.boolean(),
  estimatedP95LatencyRegressionMs: z.number(),
  metrics: tuningMetricsSchema,
  objectiveImprovement: z.number(),
  rejectionReasons: z.array(rejectionReasonSchema),
}).strict().superRefine((value, context) => {
  const reasonCountMatches = value.eligible
    ? value.rejectionReasons.length === 0
    : value.rejectionReasons.length > 0;
  if (!reasonCountMatches) {
    context.addIssue({
      code: "custom",
      message: "eligibility must match rejection reasons",
      path: ["eligible"],
    });
  }
  if (new Set(value.rejectionReasons).size !== value.rejectionReasons.length) {
    context.addIssue({
      code: "custom",
      message: "rejection reasons must be unique",
      path: ["rejectionReasons"],
    });
  }
});
const ablationSchema = z.object({
  metrics: tuningQualitySummarySchema,
  mode: z.enum(["bm25", "dense", "hybrid", "hybrid-reranked"]),
}).strict();
const evaluationTuningSelectionSchema = z.object({
  ablations: z.array(ablationSchema).length(4),
  candidateAssessments: z.array(candidateAssessmentSchema).min(1),
  constraints: tuningConstraintsSchema,
  fingerprintSha256: sha256Schema,
  frozenConfigurationFingerprintSha256: sha256Schema,
  objective: tuningObjectiveSchema,
  preparations: z.array(z.object({
    datasetName: z.string().min(1),
    sha256: sha256Schema,
  }).strict()).min(1),
  reference: z.object({
    configuration: tunedRetrievalConfigurationSchema,
    metrics: tuningMetricsSchema,
  }).strict(),
  selected: candidateAssessmentSchema,
  specificationSha256: sha256Schema,
  version: z.literal(1),
}).strict().superRefine((value, context) => {
  const fingerprintPayload: Omit<typeof value, "fingerprintSha256"> & {
    fingerprintSha256?: string;
  } = { ...value };
  delete fingerprintPayload.fingerprintSha256;
  if (calculateJsonSha256(fingerprintPayload) !== value.fingerprintSha256) {
    context.addIssue({
      code: "custom",
      message: "fingerprint does not match",
      path: ["fingerprintSha256"],
    });
  }
  if (!value.selected.eligible || value.selected.rejectionReasons.length > 0) {
    context.addIssue({
      code: "custom",
      message: "selected candidate must be eligible",
      path: ["selected"],
    });
  }
  const preparationHashes = value.preparations.map((entry) => entry.sha256);
  if (new Set(preparationHashes).size !== preparationHashes.length) {
    context.addIssue({
      code: "custom",
      message: "preparations must be unique",
      path: ["preparations"],
    });
  }
  const candidateFingerprints = value.candidateAssessments.map((entry) => (
    JSON.stringify(entry.configuration)
  ));
  if (new Set(candidateFingerprints).size !== candidateFingerprints.length) {
    context.addIssue({
      code: "custom",
      message: "candidate configurations must be unique",
      path: ["candidateAssessments"],
    });
  }
  if (!value.candidateAssessments.some((entry) => (
    JSON.stringify(entry) === JSON.stringify(value.selected)
  ))) {
    context.addIssue({
      code: "custom",
      message: "selected candidate must appear in candidate assessments",
      path: ["selected"],
    });
  }
  const ablationModes = value.ablations.map((entry) => entry.mode);
  const expectedModes = ["bm25", "dense", "hybrid", "hybrid-reranked"];
  if (JSON.stringify(ablationModes) !== JSON.stringify(expectedModes)) {
    context.addIssue({
      code: "custom",
      message: "ablations must contain BM25, dense, hybrid, and reranked modes in order",
      path: ["ablations"],
    });
  }
});

export type EvaluationTuningSpecification = z.output<
  typeof evaluationTuningSpecificationSchema
>;
export type TunedRetrievalConfiguration = z.output<
  typeof tunedRetrievalConfigurationSchema
>;
export type EvaluationTuningSelection = z.output<
  typeof evaluationTuningSelectionSchema
>;
export type EvaluationTuningCandidateAssessment = z.output<
  typeof candidateAssessmentSchema
>;

export interface EvaluationTuningRun {
  freeze: EvaluationConfigurationFreeze;
  selection: EvaluationTuningSelection;
}

interface ScoredTuningMode {
  cases: EvaluationCaseResult[];
  domains: EvaluationDomainResult[];
  macroMeanNdcg: number;
  macroMeanRecall: number;
  meanNdcg: number;
  meanRecall: number;
}

export async function readEvaluationTuningSpecification(
  filePath: string,
): Promise<EvaluationTuningSpecification> {
  return decodeEvaluationTuningSpecification(
    await readJsonFile(filePath, "evaluation tuning specification"),
    filePath,
  );
}

export function decodeEvaluationTuningSpecification(
  value: unknown,
  sourceLabel: string,
): EvaluationTuningSpecification {
  const result = evaluationTuningSpecificationSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid evaluation tuning specification ${sourceLabel}: ${result.error.message}`,
    );
  }
  return result.data;
}

export function decodeEvaluationTuningSelection(
  value: unknown,
  sourceLabel: string,
): EvaluationTuningSelection {
  const result = evaluationTuningSelectionSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid evaluation tuning selection ${sourceLabel}: ${result.error.message}`,
    );
  }
  try {
    validateEvaluationTuningSelection(result.data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid evaluation tuning selection ${sourceLabel}: ${message}`,
    );
  }
  return result.data;
}

export async function readEvaluationTuningSelection(
  filePath: string,
): Promise<EvaluationTuningSelection> {
  return decodeEvaluationTuningSelection(
    await readJsonFile(filePath, "evaluation tuning selection"),
    filePath,
  );
}

export async function writeEvaluationTuningSelection(
  filePath: string,
  selection: EvaluationTuningSelection,
): Promise<void> {
  const normalized = decodeEvaluationTuningSelection(
    selection,
    "generated output",
  );
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

export function runEvaluationTuning(
  config: AppConfig,
  codeRevision: string,
  settingsVersion: number,
  preparations: EvaluationPreparationArtifact[],
  specification: EvaluationTuningSpecification,
): EvaluationTuningRun {
  validateTuningInputs(
    config,
    codeRevision,
    settingsVersion,
    preparations,
    specification,
  );
  const referenceMetrics = scoreTuningConfiguration(
    preparations,
    specification.referenceConfiguration,
  );
  const configurations = buildSearchConfigurations(specification);
  const assessments: EvaluationTuningCandidateAssessment[] = [];
  for (const candidate of configurations) {
    const metrics = scoreTuningConfiguration(preparations, candidate);
    assessments.push(assessCandidate(
      candidate,
      metrics,
      referenceMetrics,
      specification.objective,
      specification.constraints,
    ));
  }
  const eligible = assessments.filter((assessment) => assessment.eligible);
  eligible.sort(compareCandidateAssessments);
  const selected = eligible[0];
  if (selected === undefined) {
    throw new Error(
      "Evaluation tuning found no configuration that improves the declared objective within every domain and latency limit.",
    );
  }
  const selectedConfig = applyTunedRetrievalConfiguration(
    config,
    selected.configuration,
  );
  const freeze = createEvaluationConfigurationFreeze(
    selectedConfig,
    codeRevision,
    settingsVersion,
  );
  const selectionPayload = {
    ablations: buildAblations(preparations, selected.configuration),
    candidateAssessments: assessments,
    constraints: { ...specification.constraints },
    frozenConfigurationFingerprintSha256: freeze.fingerprintSha256,
    objective: { ...specification.objective },
    preparations: preparations.map((preparation) => ({
      datasetName: preparation.provenance.dataset.name,
      sha256: calculateJsonSha256(preparation),
    })),
    reference: {
      configuration: structuredClone(specification.referenceConfiguration),
      metrics: referenceMetrics,
    },
    selected,
    specificationSha256: calculateJsonSha256(specification),
    version: 1,
  } as const;
  const selection = decodeEvaluationTuningSelection({
    ...selectionPayload,
    fingerprintSha256: calculateJsonSha256(selectionPayload),
  }, "generated output");
  return { freeze, selection };
}

export function applyEvaluationTuningSelection(
  config: AppConfig,
  codeRevision: string,
  settingsVersion: number,
  selection: EvaluationTuningSelection,
  freeze: EvaluationConfigurationFreeze,
): AppConfig {
  if (
    selection.frozenConfigurationFingerprintSha256
    !== freeze.fingerprintSha256
  ) {
    throw new Error(
      "The tuning selection does not match the frozen evaluation configuration.",
    );
  }
  const selectedConfig = applyTunedRetrievalConfiguration(
    config,
    selection.selected.configuration,
  );
  assertEvaluationConfigurationFrozen(
    selectedConfig,
    codeRevision,
    settingsVersion,
    freeze,
  );
  return selectedConfig;
}

export function applyTunedRetrievalConfiguration(
  config: AppConfig,
  selected: TunedRetrievalConfiguration,
): AppConfig {
  if (config.retrieval.reranker === null) {
    throw new Error("Evaluation tuning requires a configured reranker.");
  }
  if (selected.rerankerCandidateDepth < config.retrieval.topK) {
    throw new Error("The selected reranker candidate depth must be at least topK.");
  }
  return {
    ...config,
    retrieval: {
      ...config.retrieval,
      candidateK: selected.rerankerCandidateDepth,
      fusion: { ...selected.fusion },
      mode: "hybrid-reranked",
      queryExpansions: selected.queryExpansions,
      rrfK: selected.rrfK,
    },
  };
}

function validateTuningInputs(
  config: AppConfig,
  codeRevision: string,
  settingsVersion: number,
  preparations: EvaluationPreparationArtifact[],
  specification: EvaluationTuningSpecification,
): void {
  if (preparations.length === 0) {
    throw new Error("Evaluation tuning requires at least one preparation.");
  }
  if (config.retrieval.reranker === null) {
    throw new Error("Evaluation tuning requires a configured reranker.");
  }
  if (config.settingsVersion !== settingsVersion) {
    throw new Error(
      "Evaluation tuning settings version does not match the active configuration.",
    );
  }
  const maximumDepth = readMaximumCandidateDepth(specification);
  const reference = specification.referenceConfiguration;
  if (reference.rerankerCandidateDepth < config.retrieval.topK) {
    throw new Error("The tuning reference candidate depth must be at least topK.");
  }
  const currentFreeze = createEvaluationConfigurationFreeze(
    config,
    codeRevision,
    settingsVersion,
  );
  const first = preparations[0];
  if (first === undefined) {
    throw new Error("Evaluation tuning requires a preparation.");
  }
  const firstProvenance = first.provenance;
  const caseIds = new Set<string>();
  const datasetHashes = new Set<string>();
  const domains = new Set<string>();
  for (const preparation of preparations) {
    const provenance = preparation.provenance;
    if (
      provenance.dataset.access !== "development"
      || provenance.dataset.split !== "development"
    ) {
      throw new Error(
        `Evaluation tuning accepts development data only: ${provenance.dataset.name}.`,
      );
    }
    if (datasetHashes.has(provenance.dataset.sha256)) {
      throw new Error("Evaluation tuning preparations must use distinct datasets.");
    }
    datasetHashes.add(provenance.dataset.sha256);
    assertMatchingValue("code revision", provenance.codeRevision, codeRevision);
    assertMatchingValue(
      "settings version",
      provenance.settingsVersion,
      settingsVersion,
    );
    assertMatchingValue(
      "embedding space",
      provenance.embeddingSpace,
      currentFreeze.payload.embeddingSpace,
    );
    assertMatchingValue("model identities", provenance.models, currentFreeze.payload.models);
    assertMatchingValue("HNSW settings", provenance.hnsw, currentFreeze.payload.hnsw);
    assertMatchingValue(
      "retrieval preparation settings",
      provenance.retrieval,
      currentFreeze.payload.retrieval,
    );
    assertMatchingValue("corpus", provenance.corpus, firstProvenance.corpus);
    if (provenance.retrieval.topK !== config.retrieval.topK) {
      throw new Error("Evaluation tuning preparation topK does not match the active configuration.");
    }
    if (provenance.retrieval.queryExpansions < 2) {
      throw new Error(
        `Evaluation tuning preparation ${provenance.dataset.name} must contain two fixed expansions.`,
      );
    }
    if (provenance.retrieval.candidateK < maximumDepth) {
      throw new Error(
        `Evaluation tuning preparation ${provenance.dataset.name} candidate depth is below the search maximum.`,
      );
    }
    for (const preparedCase of preparation.cases) {
      if (caseIds.has(preparedCase.id)) {
        throw new Error(`Evaluation tuning contains duplicate case ${preparedCase.id}.`);
      }
      caseIds.add(preparedCase.id);
      domains.add(preparedCase.domain);
      if (preparedCase.queries.length < 3) {
        throw new Error(
          `Evaluation tuning case ${preparedCase.id} does not contain two fixed expansions.`,
        );
      }
      if (
        preparedCase.rerankerScores === null
        || preparedCase.tuningRerankerScores === null
      ) {
        throw new Error(
          `Evaluation tuning case ${preparedCase.id} has no prepared reranker scores.`,
        );
      }
    }
  }
  if (domains.size < 2) {
    throw new Error(
      "Evaluation tuning requires at least two development domains for its cross-domain objective.",
    );
  }
  for (const depth of specification.searchSpace.rerankerCandidateDepths) {
    if (depth < config.retrieval.topK) {
      throw new Error("Every reranker candidate depth must be at least topK.");
    }
  }
}

function buildSearchConfigurations(
  specification: EvaluationTuningSpecification,
): TunedRetrievalConfiguration[] {
  const space = specification.searchSpace;
  const configurations: TunedRetrievalConfiguration[] = [];
  for (const denseWeight of space.denseWeights) {
    for (const lexicalWeight of space.lexicalWeights) {
      for (const originalQueryWeight of space.originalQuestionWeights) {
        for (const expansionQueryWeight of space.expansionWeights) {
          for (const expansionDecay of space.expansionDecays) {
            for (const queryExpansions of space.expansionCounts) {
              for (const rrfK of space.rrfConstants) {
                for (
                  const rerankerCandidateDepth
                  of space.rerankerCandidateDepths
                ) {
                  configurations.push({
                    fusion: {
                      denseWeight,
                      expansionDecay,
                      expansionQueryWeight,
                      lexicalWeight,
                      originalQueryWeight,
                    },
                    queryExpansions,
                    rerankerCandidateDepth,
                    rrfK,
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return configurations;
}

function scoreTuningConfiguration(
  preparations: EvaluationPreparationArtifact[],
  configuration: TunedRetrievalConfiguration,
): z.output<typeof tuningMetricsSchema> {
  const method = scoreTuningMode(
    preparations,
    configuration,
    "hybrid-reranked",
  );
  return {
    ...buildQualitySummary(method),
    estimatedP95LatencyMs: estimateP95Latency(preparations, configuration),
  };
}

function scoreTuningMode(
  preparations: EvaluationPreparationArtifact[],
  configuration: TunedRetrievalConfiguration,
  mode: RetrievalMode,
): ScoredTuningMode {
  const cases: EvaluationCaseResult[] = [];
  for (const preparation of preparations) {
    const atK = preparation.provenance.dataset.atK;
    for (const preparedCase of preparation.cases) {
      const retrieved = derivePreparedEvaluationCandidates(
        preparedCase,
        mode,
        {
          candidateK: configuration.rerankerCandidateDepth,
          fusion: configuration.fusion,
          queryExpansions: configuration.queryExpansions,
          rrfK: configuration.rrfK,
          topK: atK,
        },
        "relevance-cliff",
        "tuning-universe",
      );
      const score = calculateGradedCandidateNdcgAtK(
        retrieved,
        preparedCase.judgments,
        atK,
      );
      cases.push(buildCaseResult(preparedCase, score, retrieved.length));
    }
  }
  return summarizeTuningCases(cases);
}

function buildCaseResult(
  preparedCase: PreparedEvaluationCase,
  score: { ndcg: number; recall: number; relevantRetrieved: number },
  retrievedCount: number,
): EvaluationCaseResult {
  return {
    domain: preparedCase.domain,
    id: preparedCase.id,
    language: preparedCase.metadata.language,
    ndcg: score.ndcg,
    question: preparedCase.question,
    questionType: preparedCase.metadata.questionType,
    recall: score.recall,
    relevantRetrieved: score.relevantRetrieved,
    retrieved: retrievedCount,
    sourceKind: preparedCase.metadata.source.kind,
  };
}

function buildQualitySummary(
  method: ScoredTuningMode,
): z.output<typeof tuningQualitySummarySchema> {
  return {
    caseCount: method.cases.length,
    domainMacroMeanNdcg: method.macroMeanNdcg,
    domainMacroMeanRecall: method.macroMeanRecall,
    domains: method.domains.map((domain) => ({ ...domain })),
    meanNdcg: method.meanNdcg,
    meanRecall: method.meanRecall,
  };
}

function summarizeTuningCases(cases: EvaluationCaseResult[]): ScoredTuningMode {
  const casesByDomain = new Map<string, EvaluationCaseResult[]>();
  let ndcgTotal = 0;
  let recallTotal = 0;
  for (const evaluationCase of cases) {
    ndcgTotal += evaluationCase.ndcg;
    recallTotal += evaluationCase.recall;
    const domainCases = casesByDomain.get(evaluationCase.domain);
    if (domainCases === undefined) {
      casesByDomain.set(evaluationCase.domain, [evaluationCase]);
    } else {
      domainCases.push(evaluationCase);
    }
  }
  if (cases.length === 0 || casesByDomain.size === 0) {
    throw new Error("Evaluation tuning requires scored cases.");
  }
  const domainNames = [...casesByDomain.keys()];
  domainNames.sort((left, right) => left.localeCompare(right));
  const domains: EvaluationDomainResult[] = [];
  let macroNdcgTotal = 0;
  let macroRecallTotal = 0;
  for (const domain of domainNames) {
    const domainCases = casesByDomain.get(domain);
    if (domainCases === undefined || domainCases.length === 0) {
      throw new Error(`Evaluation tuning domain ${domain} has no cases.`);
    }
    let domainNdcgTotal = 0;
    let domainRecallTotal = 0;
    for (const evaluationCase of domainCases) {
      domainNdcgTotal += evaluationCase.ndcg;
      domainRecallTotal += evaluationCase.recall;
    }
    const meanNdcg = domainNdcgTotal / domainCases.length;
    const meanRecall = domainRecallTotal / domainCases.length;
    macroNdcgTotal += meanNdcg;
    macroRecallTotal += meanRecall;
    domains.push({
      caseCount: domainCases.length,
      domain,
      meanNdcg,
      meanRecall,
    });
  }
  return {
    cases,
    domains,
    macroMeanNdcg: macroNdcgTotal / domains.length,
    macroMeanRecall: macroRecallTotal / domains.length,
    meanNdcg: ndcgTotal / cases.length,
    meanRecall: recallTotal / cases.length,
  };
}

function assessCandidate(
  configuration: TunedRetrievalConfiguration,
  metrics: z.output<typeof tuningMetricsSchema>,
  reference: z.output<typeof tuningMetricsSchema>,
  objective: EvaluationTuningSpecification["objective"],
  constraints: EvaluationTuningSpecification["constraints"],
): EvaluationTuningCandidateAssessment {
  const objectiveImprovement = metrics.domainMacroMeanNdcg
    - reference.domainMacroMeanNdcg;
  const estimatedP95LatencyRegressionMs = metrics.estimatedP95LatencyMs
    - reference.estimatedP95LatencyMs;
  const domainRegressions = calculateDomainRegressions(
    metrics.domains,
    reference.domains,
  );
  const rejectionReasons: z.output<typeof rejectionReasonSchema>[] = [];
  if (objectiveImprovement < objective.minimumImprovement) {
    rejectionReasons.push("objective-not-improved");
  }
  if (domainRegressions.some((entry) => (
    entry.ndcgRegression
    > constraints.maximumDomainNdcgRegression
  ))) {
    rejectionReasons.push("domain-regression-limit");
  }
  if (
    metrics.estimatedP95LatencyMs
    > constraints.maximumEstimatedP95LatencyMs
  ) {
    rejectionReasons.push("absolute-latency-limit");
  }
  if (
    estimatedP95LatencyRegressionMs
    > constraints.maximumEstimatedP95LatencyRegressionMs
  ) {
    rejectionReasons.push("latency-regression-limit");
  }
  return {
    configuration: structuredClone(configuration),
    domainRegressions,
    eligible: rejectionReasons.length === 0,
    estimatedP95LatencyRegressionMs,
    metrics,
    objectiveImprovement,
    rejectionReasons,
  };
}

function validateEvaluationTuningSelection(
  selection: EvaluationTuningSelection,
): void {
  for (const assessment of selection.candidateAssessments) {
    const expected = assessCandidate(
      assessment.configuration,
      assessment.metrics,
      selection.reference.metrics,
      selection.objective,
      selection.constraints,
    );
    if (calculateJsonSha256(expected) !== calculateJsonSha256(assessment)) {
      throw new Error("candidate assessment does not match its declared guardrails");
    }
  }
  const eligible = selection.candidateAssessments.filter((assessment) => (
    assessment.eligible
  ));
  eligible.sort(compareCandidateAssessments);
  const selected = eligible[0];
  if (
    selected === undefined
    || calculateJsonSha256(selected) !== calculateJsonSha256(selection.selected)
  ) {
    throw new Error("selected candidate is not the deterministic winner");
  }
}

function calculateDomainRegressions(
  candidateDomains: EvaluationDomainResult[],
  referenceDomains: EvaluationDomainResult[],
): Array<{ domain: string; ndcgRegression: number }> {
  const referenceByDomain = new Map<string, EvaluationDomainResult>();
  for (const domain of referenceDomains) {
    referenceByDomain.set(domain.domain, domain);
  }
  const regressions = [];
  for (const candidate of candidateDomains) {
    const reference = referenceByDomain.get(candidate.domain);
    if (reference === undefined) {
      throw new Error(`Tuning reference is missing domain ${candidate.domain}.`);
    }
    regressions.push({
      domain: candidate.domain,
      ndcgRegression: reference.meanNdcg - candidate.meanNdcg,
    });
  }
  if (regressions.length !== referenceDomains.length) {
    throw new Error("Tuning candidate and reference domains differ.");
  }
  return regressions;
}

function compareCandidateAssessments(
  left: EvaluationTuningCandidateAssessment,
  right: EvaluationTuningCandidateAssessment,
): number {
  const objectiveDifference = right.metrics.domainMacroMeanNdcg
    - left.metrics.domainMacroMeanNdcg;
  if (objectiveDifference !== 0) {
    return objectiveDifference;
  }
  const recallDifference = right.metrics.domainMacroMeanRecall
    - left.metrics.domainMacroMeanRecall;
  if (recallDifference !== 0) {
    return recallDifference;
  }
  const latencyDifference = left.metrics.estimatedP95LatencyMs
    - right.metrics.estimatedP95LatencyMs;
  if (latencyDifference !== 0) {
    return latencyDifference;
  }
  const depthDifference = left.configuration.rerankerCandidateDepth
    - right.configuration.rerankerCandidateDepth;
  if (depthDifference !== 0) {
    return depthDifference;
  }
  const expansionDifference = left.configuration.queryExpansions
    - right.configuration.queryExpansions;
  if (expansionDifference !== 0) {
    return expansionDifference;
  }
  return JSON.stringify(left.configuration).localeCompare(
    JSON.stringify(right.configuration),
  );
}

function buildAblations(
  preparations: EvaluationPreparationArtifact[],
  configuration: TunedRetrievalConfiguration,
): Array<z.output<typeof ablationSchema>> {
  const modes: RetrievalMode[] = [
    "bm25",
    "dense",
    "hybrid",
    "hybrid-reranked",
  ];
  const ablations = [];
  for (const mode of modes) {
    const method = scoreTuningMode(preparations, configuration, mode);
    ablations.push({ metrics: buildQualitySummary(method), mode });
  }
  return ablations;
}

function estimateP95Latency(
  preparations: EvaluationPreparationArtifact[],
  configuration: TunedRetrievalConfiguration,
): number {
  const caseLatencies: number[] = [];
  for (const preparation of preparations) {
    const traceByCaseId = new Map(
      preparation.telemetry.map((entry) => [entry.caseId, entry.trace]),
    );
    for (const preparedCase of preparation.cases) {
      const trace = traceByCaseId.get(preparedCase.id);
      if (trace === undefined) {
        throw new Error(`Tuning telemetry is missing case ${preparedCase.id}.`);
      }
      caseLatencies.push(estimateCaseLatency(
        trace.stages,
        configuration,
        preparedCase.id,
      ));
    }
  }
  caseLatencies.sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(caseLatencies.length * 0.95) - 1);
  const latency = caseLatencies[index];
  if (latency === undefined) {
    throw new Error("Cannot estimate tuning latency without cases.");
  }
  return latency;
}

function estimateCaseLatency(
  stages: TelemetryStageSnapshot[],
  configuration: TunedRetrievalConfiguration,
  caseId: string,
): number {
  let total = 0;
  if (configuration.queryExpansions > 0) {
    const expansionStage = readRequiredStages(
      stages,
      "query-expansion",
      1,
      caseId,
    )[0];
    if (
      expansionStage === undefined
      || expansionStage.outputCount === null
      || expansionStage.outputCount < configuration.queryExpansions
    ) {
      throw new Error(
        `Tuning telemetry query-expansion for ${caseId} does not contain the selected fixed expansions.`,
      );
    }
    total += scaleStageDuration(
      expansionStage,
      configuration.queryExpansions / expansionStage.outputCount,
    );
  }
  const queryCount = configuration.queryExpansions + 1;
  const embeddingStage = readRequiredStages(
    stages,
    "query-embedding",
    1,
    caseId,
  )[0];
  if (
    embeddingStage === undefined
    || embeddingStage.inputCount === null
    || embeddingStage.inputCount < queryCount
  ) {
    throw new Error(
      `Tuning telemetry query-embedding for ${caseId} does not contain the selected fixed query variants.`,
    );
  }
  total += scaleStageDuration(
    embeddingStage,
    queryCount / embeddingStage.inputCount,
  );
  const denseStages = readRequiredStages(
    stages,
    "dense-retrieval",
    queryCount,
    caseId,
  );
  const lexicalStages = readRequiredStages(
    stages,
    "lexical-retrieval",
    queryCount,
    caseId,
  );
  let retrievalDuration = 0;
  for (let index = 0; index < queryCount; index += 1) {
    const denseStage = denseStages[index];
    const lexicalStage = lexicalStages[index];
    if (denseStage === undefined || lexicalStage === undefined) {
      throw new Error(
        `Tuning telemetry retrieval stages for ${caseId} are incomplete.`,
      );
    }
    const variantDuration = Math.max(
      denseStage.durationMs,
      lexicalStage.durationMs,
    );
    retrievalDuration = Math.max(retrievalDuration, variantDuration);
  }
  total += retrievalDuration;
  for (const stageName of ["hydration", "reranking"] as const) {
    const stage = readRequiredStages(stages, stageName, 1, caseId)[0];
    if (stage === undefined || stage.inputCount === null || stage.inputCount < 1) {
      throw new Error(
        `Tuning telemetry ${stageName} for ${caseId} has no candidate count.`,
      );
    }
    const depth = Math.min(
      configuration.rerankerCandidateDepth,
      stage.inputCount,
    );
    total += scaleStageDuration(stage, depth / stage.inputCount);
  }
  return total;
}

function scaleStageDuration(
  stage: TelemetryStageSnapshot,
  ratio: number,
): number {
  if (stage.providerDurationMs === null) {
    return stage.durationMs * ratio;
  }
  const fixedDuration = Math.max(
    0,
    stage.durationMs - stage.providerDurationMs,
  );
  return fixedDuration + (stage.providerDurationMs * ratio);
}

function readRequiredStages(
  stages: TelemetryStageSnapshot[],
  name: TelemetryStageSnapshot["name"],
  count: number,
  caseId: string,
): TelemetryStageSnapshot[] {
  const matching = stages.filter((stage) => stage.name === name);
  if (matching.length < count) {
    throw new Error(
      `Tuning telemetry for ${caseId} requires ${count} successful ${name} stage(s).`,
    );
  }
  const selected = matching.slice(0, count);
  if (selected.some((stage) => stage.outcome !== "success")) {
    throw new Error(
      `Tuning telemetry for ${caseId} contains an unsuccessful ${name} stage.`,
    );
  }
  return selected;
}

function readMaximumCandidateDepth(
  specification: EvaluationTuningSpecification,
): number {
  let maximum = specification.referenceConfiguration.rerankerCandidateDepth;
  for (const depth of specification.searchSpace.rerankerCandidateDepths) {
    maximum = Math.max(maximum, depth);
  }
  return maximum;
}

function assertMatchingValue(
  label: string,
  actual: unknown,
  expected: unknown,
): void {
  if (calculateJsonSha256(actual) !== calculateJsonSha256(expected)) {
    throw new Error(`Evaluation tuning preparation ${label} does not match.`);
  }
}

function validateSearchSize(
  specification: z.output<typeof evaluationTuningSpecificationSchema>,
  context: z.RefinementCtx,
): void {
  const space = specification.searchSpace;
  const sizes = [
    space.denseWeights.length,
    space.lexicalWeights.length,
    space.originalQuestionWeights.length,
    space.expansionWeights.length,
    space.expansionDecays.length,
    space.expansionCounts.length,
    space.rrfConstants.length,
    space.rerankerCandidateDepths.length,
  ];
  let candidateCount = 1;
  for (const size of sizes) {
    candidateCount *= size;
  }
  if (candidateCount > MAXIMUM_SEARCH_CANDIDATES) {
    context.addIssue({
      code: "custom",
      message: `search contains ${candidateCount} candidates; maximum is ${MAXIMUM_SEARCH_CANDIDATES}`,
      path: ["searchSpace"],
    });
  }
}

function requireUniqueNumbers(
  values: number[],
  context: z.RefinementCtx,
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", message: "must contain unique values" });
  }
}

function requireZeroOneTwo(
  values: number[],
  context: z.RefinementCtx,
): void {
  const sorted = [...values].sort((left, right) => left - right);
  if (JSON.stringify(sorted) !== JSON.stringify([0, 1, 2])) {
    context.addIssue({
      code: "custom",
      message: "must contain exactly 0, 1, and 2",
    });
  }
}

async function readJsonFile(filePath: string, label: string): Promise<unknown> {
  const content = await readFile(filePath, "utf8");
  try {
    return JSON.parse(content) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label} JSON in ${filePath}: ${message}`);
  }
}
