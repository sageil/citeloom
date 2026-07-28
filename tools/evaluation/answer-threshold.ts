import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { z } from "zod";

import {
  calculateJsonSha256,
  evaluationProvenanceSchema,
  telemetryRunSnapshotSchema,
} from "./artifact.js";
import { evaluationStableNameSchema } from "./dataset.js";
import { contentIdSchema } from "../../src/domain/validation.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const documentIdListSchema = z.array(contentIdSchema).min(1).superRefine(
  (value, context) => {
    const unique = new Set(value);
    if (unique.size !== value.length) {
      context.addIssue({ code: "custom", message: "document IDs must be unique" });
    }
    for (let index = 1; index < value.length; index += 1) {
      const previous = value[index - 1];
      const current = value[index];
      if (previous !== undefined && current !== undefined && current <= previous) {
        context.addIssue({ code: "custom", message: "document IDs must be sorted" });
        break;
      }
    }
  },
);
const assessmentSchema = z.object({
  acceptedEvidenceRetrieved: z.boolean(),
  candidateCount: z.number().int().nonnegative(),
  documentIds: documentIdListSchema,
  strongestScore: z.number().finite().nullable(),
  trace: telemetryRunSnapshotSchema,
}).strict();
const preparedCaseSchema = z.object({
  domain: evaluationStableNameSchema,
  excludedDocumentIds: documentIdListSchema,
  familyId: evaluationStableNameSchema,
  negative: assessmentSchema,
  positive: assessmentSchema,
  question: z.string().trim().min(1).max(8_000),
}).strict();
const answerThresholdPreparationSchema = z.object({
  cases: z.array(preparedCaseSchema).min(1),
  negativeCorpus: z.object({
    documentIds: documentIdListSchema,
    domain: evaluationStableNameSchema,
    sha256: sha256Schema,
  }).strict(),
  provenance: evaluationProvenanceSchema,
  version: z.literal(5),
}).strict().superRefine((value, context) => {
  const familyIds = new Set<string>();
  for (let index = 0; index < value.cases.length; index += 1) {
    const calibrationCase = value.cases[index];
    if (calibrationCase === undefined) {
      continue;
    }
    if (familyIds.has(calibrationCase.familyId)) {
      context.addIssue({
        code: "custom",
        message: "family IDs must be unique within a preparation",
        path: ["cases", index, "familyId"],
      });
    }
    familyIds.add(calibrationCase.familyId);
    if (calibrationCase.negative.acceptedEvidenceRetrieved) {
      context.addIssue({
        code: "custom",
        message: "negative scope must not retrieve accepted evidence",
        path: ["cases", index, "negative", "acceptedEvidenceRetrieved"],
      });
    }
    const positiveScope = new Set(calibrationCase.positive.documentIds);
    for (const excludedDocumentId of calibrationCase.excludedDocumentIds) {
      if (!positiveScope.has(excludedDocumentId)) {
        context.addIssue({
          code: "custom",
          message: "excluded documents must belong to the positive scope",
          path: ["cases", index, "excludedDocumentIds"],
        });
      }
      if (calibrationCase.negative.documentIds.includes(excludedDocumentId)) {
        context.addIssue({
          code: "custom",
          message: "negative scope must exclude every supporting document",
          path: ["cases", index, "negative", "documentIds"],
        });
      }
    }
    const expectedPositiveScope = value.provenance.corpus.documentIds;
    if (!arraysEqual(calibrationCase.positive.documentIds, expectedPositiveScope)) {
      context.addIssue({
        code: "custom",
        message: "positive scope must equal the prepared corpus scope",
        path: ["cases", index, "positive", "documentIds"],
      });
    }
    const expectedNegativeScope = value.negativeCorpus.documentIds;
    if (!arraysEqual(calibrationCase.negative.documentIds, expectedNegativeScope)) {
      context.addIssue({
        code: "custom",
        message: "negative scope must equal the prepared negative corpus scope",
        path: ["cases", index, "negative", "documentIds"],
      });
    }
  }
  const positiveDocuments = new Set(value.provenance.corpus.documentIds);
  for (const negativeDocumentId of value.negativeCorpus.documentIds) {
    if (positiveDocuments.has(negativeDocumentId)) {
      context.addIssue({
        code: "custom",
        message: "positive and negative corpus scopes must be disjoint",
        path: ["negativeCorpus", "documentIds"],
      });
    }
  }
  if (calculateJsonSha256({
    documentIds: value.negativeCorpus.documentIds,
    domain: value.negativeCorpus.domain,
  }) !== value.negativeCorpus.sha256) {
    context.addIssue({
      code: "custom",
      message: "negative corpus fingerprint does not match",
      path: ["negativeCorpus", "sha256"],
    });
  }
});

const rateSchema = z.object({
  count: z.number().int().nonnegative(),
  rate: z.number().finite().min(0).max(1),
  total: z.number().int().positive(),
  wilson95: z.object({
    lower: z.number().finite().min(0).max(1),
    upper: z.number().finite().min(0).max(1),
  }).strict(),
}).strict();
const domainMetricsSchema = z.object({
  answerablePassRate: rateSchema,
  domain: evaluationStableNameSchema,
  falseAcceptanceRate: rateSchema,
}).strict();
const scoringConfigurationSchema = evaluationProvenanceSchema.pick({
  codeRevision: true,
  embeddingSpace: true,
  hnsw: true,
  models: true,
  retrieval: true,
});
const reportedMetricsSchema = z.object({
  answerablePassRate: rateSchema,
  domains: z.array(domainMetricsSchema).min(1),
  excludedPositiveRetrievalMissCount: z.number().int().nonnegative(),
  falseAcceptanceRate: rateSchema,
}).strict();
const answerThresholdSelectionSchema = z.object({
  developmentPreparations: z.array(z.object({
    datasetName: evaluationStableNameSchema,
    sha256: sha256Schema,
  }).strict()).min(1),
  fingerprintSha256: sha256Schema,
  maximumFalseAcceptanceRate: z.number().finite().min(0).max(1),
  metrics: reportedMetricsSchema,
  regressionMetrics: reportedMetricsSchema.nullable(),
  regressionPreparations: z.array(z.object({
    datasetName: evaluationStableNameSchema,
    sha256: sha256Schema,
  }).strict()),
  scoringConfiguration: scoringConfigurationSchema,
  selectedThreshold: z.number().finite(),
  version: z.literal(3),
}).strict().superRefine((value, context) => {
  const payload: Omit<typeof value, "fingerprintSha256"> & {
    fingerprintSha256?: string;
  } = { ...value };
  delete payload.fingerprintSha256;
  if (calculateJsonSha256(payload) !== value.fingerprintSha256) {
    context.addIssue({
      code: "custom",
      message: "fingerprint does not match",
      path: ["fingerprintSha256"],
    });
  }
});

export type AnswerThresholdPreparation = z.output<
  typeof answerThresholdPreparationSchema
>;
export type AnswerThresholdPreparedCase = z.output<typeof preparedCaseSchema>;
export type AnswerThresholdSelection = z.output<
  typeof answerThresholdSelectionSchema
>;

export function decodeAnswerThresholdPreparation(
  value: unknown,
  sourceLabel: string,
): AnswerThresholdPreparation {
  rejectIncompatiblePreparationVersion(value, sourceLabel);
  const result = answerThresholdPreparationSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid answer-threshold preparation ${sourceLabel}: ${result.error.message}`,
    );
  }
  if (result.data.provenance.models.reranker === null) {
    throw new Error("Answer-threshold preparation requires a reranker model.");
  }
  return result.data;
}

function rejectIncompatiblePreparationVersion(
  value: unknown,
  sourceLabel: string,
): void {
  if (
    typeof value !== "object"
    || value === null
    || !("version" in value)
  ) {
    return;
  }
  const version = value.version;
  if (version !== 5) {
    throw new Error(
      `Incompatible answer-threshold preparation ${sourceLabel}: expected version 5, received ${String(version)}.`,
    );
  }
}

export async function readAnswerThresholdPreparation(
  filePath: string,
): Promise<AnswerThresholdPreparation> {
  return decodeAnswerThresholdPreparation(
    await readJsonFile(filePath, "answer-threshold preparation"),
    filePath,
  );
}

export async function writeAnswerThresholdPreparation(
  filePath: string,
  preparation: AnswerThresholdPreparation,
): Promise<void> {
  const normalized = decodeAnswerThresholdPreparation(
    preparation,
    "generated output",
  );
  await writeNewJsonFile(filePath, normalized);
}

export function selectAnswerThreshold(
  preparations: readonly AnswerThresholdPreparation[],
  maximumFalseAcceptanceRate: number,
): AnswerThresholdSelection {
  if (
    !Number.isFinite(maximumFalseAcceptanceRate)
    || maximumFalseAcceptanceRate < 0
    || maximumFalseAcceptanceRate > 1
  ) {
    throw new Error("Maximum false-acceptance rate must be between 0 and 1.");
  }
  if (preparations.length === 0) {
    throw new Error("Answer-threshold selection requires a preparation.");
  }
  const unsupported = preparations.filter((preparation) => {
    const access = preparation.provenance.dataset.access;
    return access !== "development" && access !== "regression";
  });
  if (unsupported.length > 0) {
    throw new Error(
      "Answer-threshold selection accepts development and regression preparations only.",
    );
  }
  const development = preparations.filter((preparation) => {
    return preparation.provenance.dataset.access === "development";
  });
  if (development.length === 0) {
    throw new Error("Answer-threshold selection requires a development preparation.");
  }
  const regression = preparations.filter((preparation) => {
    return preparation.provenance.dataset.access === "regression";
  });
  assertCompatiblePreparations(preparations);
  const everyCase = preparations.flatMap((preparation) => preparation.cases);
  assertUniqueCaseFamilies(everyCase);
  const allCases = development.flatMap((preparation) => preparation.cases);
  const cases = allCases.filter((calibrationCase) => {
    return calibrationCase.positive.acceptedEvidenceRetrieved;
  });
  if (cases.length === 0) {
    throw new Error(
      "Answer-threshold selection has no cases whose accepted evidence was retrieved.",
    );
  }
  const thresholds = readCandidateThresholds(cases);
  let bestAnswerablePassRate = -1;
  const eligibleThresholds: number[] = [];
  for (const threshold of thresholds) {
    const metrics = buildSelectionMetrics(cases, threshold);
    const domainConstraintSatisfied = metrics.domains.every((domain) => {
      return domain.falseAcceptanceRate.rate <= maximumFalseAcceptanceRate;
    });
    if (
      metrics.falseAcceptanceRate.rate > maximumFalseAcceptanceRate
      || !domainConstraintSatisfied
    ) {
      continue;
    }
    if (metrics.answerablePassRate.rate > bestAnswerablePassRate) {
      bestAnswerablePassRate = metrics.answerablePassRate.rate;
      eligibleThresholds.length = 0;
      eligibleThresholds.push(threshold);
      continue;
    }
    if (metrics.answerablePassRate.rate === bestAnswerablePassRate) {
      eligibleThresholds.push(threshold);
    }
  }
  if (eligibleThresholds.length === 0) {
    throw new Error(
      "No answer-threshold interval satisfies the false-acceptance constraint.",
    );
  }
  const lowestEligibleThreshold = eligibleThresholds[0];
  const highestEligibleThreshold = eligibleThresholds.at(-1);
  if (lowestEligibleThreshold === undefined || highestEligibleThreshold === undefined) {
    throw new Error("Answer-threshold selection produced an empty interval.");
  }
  const selectedThreshold = lowestEligibleThreshold
    + (highestEligibleThreshold - lowestEligibleThreshold) / 2;
  const firstPreparation = development[0];
  if (firstPreparation === undefined) {
    throw new Error("Answer-threshold selection requires a preparation.");
  }
  const selectedMetrics = buildSelectionMetrics(cases, selectedThreshold);
  const selectionPayload = {
    developmentPreparations: development.map((preparation) => ({
      datasetName: preparation.provenance.dataset.name,
      sha256: calculateJsonSha256(preparation),
    })),
    maximumFalseAcceptanceRate,
    metrics: {
      answerablePassRate: selectedMetrics.answerablePassRate,
      domains: selectedMetrics.domains,
      excludedPositiveRetrievalMissCount: allCases.length - cases.length,
      falseAcceptanceRate: selectedMetrics.falseAcceptanceRate,
    },
    regressionMetrics: regression.length === 0
      ? null
      : buildReportedMetrics(
        regression.flatMap((preparation) => preparation.cases),
        selectedThreshold,
      ),
    regressionPreparations: regression.map((preparation) => ({
      datasetName: preparation.provenance.dataset.name,
      sha256: calculateJsonSha256(preparation),
    })),
    scoringConfiguration: readScoringConfiguration(firstPreparation),
    selectedThreshold,
    version: 3 as const,
  };
  const selection = {
    ...selectionPayload,
    fingerprintSha256: calculateJsonSha256(selectionPayload),
  };
  return answerThresholdSelectionSchema.parse(selection);
}

function buildReportedMetrics(
  allCases: readonly AnswerThresholdPreparedCase[],
  threshold: number,
): z.output<typeof reportedMetricsSchema> {
  const eligibleCases = allCases.filter((calibrationCase) => {
    return calibrationCase.positive.acceptedEvidenceRetrieved;
  });
  if (eligibleCases.length === 0) {
    throw new Error(
      "Answer-threshold reporting has no cases whose accepted evidence was retrieved.",
    );
  }
  const metrics = buildSelectionMetrics(eligibleCases, threshold);
  return {
    answerablePassRate: metrics.answerablePassRate,
    domains: metrics.domains,
    excludedPositiveRetrievalMissCount: allCases.length - eligibleCases.length,
    falseAcceptanceRate: metrics.falseAcceptanceRate,
  };
}

export async function writeAnswerThresholdSelection(
  filePath: string,
  selection: AnswerThresholdSelection,
): Promise<void> {
  await writeNewJsonFile(filePath, answerThresholdSelectionSchema.parse(selection));
}

function readCandidateThresholds(
  cases: readonly AnswerThresholdPreparedCase[],
): number[] {
  const scores = new Set<number>();
  for (const calibrationCase of cases) {
    if (calibrationCase.positive.strongestScore !== null) {
      scores.add(calibrationCase.positive.strongestScore);
    }
    if (calibrationCase.negative.strongestScore !== null) {
      scores.add(nextRepresentableNumber(calibrationCase.negative.strongestScore));
    }
  }
  return [...scores].sort((left, right) => left - right);
}

function nextRepresentableNumber(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Reranker scores must be finite.");
  }
  if (Object.is(value, -0)) {
    return Number.MIN_VALUE;
  }
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  let bits = view.getBigUint64(0, false);
  bits = value >= 0 ? bits + 1n : bits - 1n;
  view.setBigUint64(0, bits, false);
  return view.getFloat64(0, false);
}

function buildSelectionMetrics(
  cases: readonly AnswerThresholdPreparedCase[],
  threshold: number,
): Omit<AnswerThresholdSelection["metrics"], "excludedPositiveRetrievalMissCount"> {
  const domains = new Map<string, AnswerThresholdPreparedCase[]>();
  for (const calibrationCase of cases) {
    const domainCases = domains.get(calibrationCase.domain) ?? [];
    domainCases.push(calibrationCase);
    domains.set(calibrationCase.domain, domainCases);
  }
  const domainMetrics = [...domains.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([domain, domainCases]) => ({
      answerablePassRate: calculatePassRate(
        domainCases.map((calibrationCase) => calibrationCase.positive.strongestScore),
        threshold,
      ),
      domain,
      falseAcceptanceRate: calculatePassRate(
        domainCases.map((calibrationCase) => calibrationCase.negative.strongestScore),
        threshold,
      ),
    }));
  return {
    answerablePassRate: calculatePassRate(
      cases.map((calibrationCase) => calibrationCase.positive.strongestScore),
      threshold,
    ),
    domains: domainMetrics,
    falseAcceptanceRate: calculatePassRate(
      cases.map((calibrationCase) => calibrationCase.negative.strongestScore),
      threshold,
    ),
  };
}

function calculatePassRate(
  scores: readonly (number | null)[],
  threshold: number,
): z.output<typeof rateSchema> {
  let count = 0;
  for (const score of scores) {
    if (score !== null && score >= threshold) {
      count += 1;
    }
  }
  const total = scores.length;
  const rate = count / total;
  return { count, rate, total, wilson95: calculateWilson95(count, total) };
}

function calculateWilson95(count: number, total: number) {
  const zScore = 1.959963984540054;
  const observed = count / total;
  const denominator = 1 + (zScore ** 2) / total;
  const center = (observed + (zScore ** 2) / (2 * total)) / denominator;
  const margin = zScore * Math.sqrt(
    (observed * (1 - observed) + (zScore ** 2) / (4 * total)) / total,
  ) / denominator;
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

function assertCompatiblePreparations(
  preparations: readonly AnswerThresholdPreparation[],
): void {
  const first = preparations[0];
  if (first === undefined) {
    return;
  }
  const expected = readScoringConfiguration(first);
  for (const preparation of preparations.slice(1)) {
    const actual = readScoringConfiguration(preparation);
    if (calculateJsonSha256(actual) !== calculateJsonSha256(expected)) {
      throw new Error(
        "Answer-threshold preparations use different models or retrieval configurations.",
      );
    }
  }
}

function readScoringConfiguration(
  preparation: AnswerThresholdPreparation,
): z.output<typeof scoringConfigurationSchema> {
  return {
    codeRevision: preparation.provenance.codeRevision,
    embeddingSpace: preparation.provenance.embeddingSpace,
    hnsw: preparation.provenance.hnsw,
    models: preparation.provenance.models,
    retrieval: preparation.provenance.retrieval,
  };
}

function assertUniqueCaseFamilies(
  cases: readonly AnswerThresholdPreparedCase[],
): void {
  const familyIds = new Set<string>();
  for (const calibrationCase of cases) {
    if (familyIds.has(calibrationCase.familyId)) {
      throw new Error(
        `Answer-threshold case family is duplicated: ${calibrationCase.familyId}.`,
      );
    }
    familyIds.add(calibrationCase.familyId);
  }
}

async function readJsonFile(filePath: string, label: string): Promise<unknown> {
  const content = await readFile(filePath, "utf8");
  try {
    return JSON.parse(content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${label} JSON in ${filePath}: ${message}`);
  }
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

async function writeNewJsonFile(filePath: string, value: unknown): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = join(
    directory,
    `.${basename(filePath)}.${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      flush: true,
    });
    temporaryExists = true;
    await link(temporaryPath, filePath);
  } finally {
    if (temporaryExists) {
      await unlink(temporaryPath);
    }
  }
}
