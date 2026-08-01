import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { calculateRequiredPairedCaseCount } from "./statistics.js";
import { contentIdSchema } from "../../src/domain/validation.js";

export const evaluationStableNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
export const evaluationSplitSchema = z.enum(["development", "holdout"]);
export const evaluationAccessSchema = z.enum([
  "development",
  "regression",
  "sealed",
]);
export const evaluationLanguageSchema = z
  .string()
  .trim()
  .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
export const evaluationQuestionTypeSchema = z.enum([
  "calculation",
  "comparison",
  "definition",
  "factoid",
  "multi-evidence",
  "procedure",
  "visual-identification",
]);
export const evaluationRelevanceSchema = z.enum([
  "direct",
  "partial",
  "topical",
  "irrelevant",
]);
export const evaluationAuditStatusSchema = z.enum([
  "accepted",
  "pending",
  "rejected",
]);
export const evaluationStatisticalDesignSchema = z.object({
  alpha: z.literal(0.05),
  alternative: z.literal("two-sided"),
  assumedPairedNdcgDeltaStandardDeviation: z.number().positive().max(1),
  method: z.literal("normal-approximation-paired-mean"),
  minimumDetectableNdcgDelta: z.number().positive().max(1),
  power: z.literal(0.8),
  requiredCaseCount: z.number().int().positive().max(10_000),
}).strict().superRefine((value, context) => {
  const requiredCaseCount = calculateRequiredPairedCaseCount(
    value.minimumDetectableNdcgDelta,
    value.assumedPairedNdcgDeltaStandardDeviation,
  );
  if (value.requiredCaseCount !== requiredCaseCount) {
    context.addIssue({
      code: "custom",
      message: `must equal the calculated paired case count ${requiredCaseCount}`,
      path: ["requiredCaseCount"],
    });
  }
});

const retrievalModeSchema = z.enum([
  "bm25",
  "dense",
  "hybrid",
  "hybrid-reranked",
]);
const evaluationCaseOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }).strict(),
  z.object({
    documentId: contentIdSchema,
    elementId: contentIdSchema,
    kind: z.literal("generated"),
    pageNumber: z.number().int().positive().nullable(),
    sourceFile: z.string().min(1),
    sourceKind: z.enum(["text", "table", "image"]),
  }).strict(),
]);
export const evaluationSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
  }).strict(),
  z.object({
    kind: z.literal("table"),
  }).strict(),
  z.object({
    kind: z.literal("image"),
    visualIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
]);
const evaluationReviewerSchema = z.discriminatedUnion("kind", [
  z.object({
    id: evaluationStableNameSchema,
    kind: z.literal("human"),
  }).strict(),
  z.object({
    kind: z.literal("process"),
    name: evaluationStableNameSchema,
    version: z.string().trim().min(1).max(120),
  }).strict(),
]);
const evaluationReviewSchema = z.object({
  auditStatus: evaluationAuditStatusSchema,
  rationale: z.string().trim().min(1).max(4_000),
  reviewedAt: z.iso.datetime().nullable(),
  reviewer: evaluationReviewerSchema,
}).strict().superRefine((value, context) => {
  const isPending = value.auditStatus === "pending";
  if (isPending !== (value.reviewedAt === null)) {
    context.addIssue({
      code: "custom",
      message: isPending
        ? "must not have a review timestamp while pending"
        : "must have a review timestamp after review",
      path: ["reviewedAt"],
    });
  }
});
const evaluationJudgmentTargetSchema = z.discriminatedUnion("kind", [
  z.object({ id: contentIdSchema, kind: z.literal("document") }).strict(),
  z.object({ id: contentIdSchema, kind: z.literal("element") }).strict(),
]);
const evaluationJudgmentProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("origin") }).strict(),
  z.object({
    kind: z.literal("pooled"),
    methods: z.array(retrievalModeSchema).min(1),
  }).strict(),
]);
export const evaluationJudgmentSchema = z.object({
  provenance: evaluationJudgmentProvenanceSchema,
  relevance: evaluationRelevanceSchema,
  review: evaluationReviewSchema,
  target: evaluationJudgmentTargetSchema,
}).strict();
export const evaluationCaseMetadataSchema = z.object({
  language: evaluationLanguageSchema,
  questionType: evaluationQuestionTypeSchema,
  source: evaluationSourceSchema,
}).strict();

const evaluationCorpusDocumentSchema = z.object({
  documentId: contentIdSchema,
  domain: evaluationStableNameSchema,
  modality: z.enum(["document", "image"]),
  sourceFile: z.string().trim().min(1).max(8_192),
}).strict();
export const evaluationCorpusProvenanceSchema = z.object({
  documents: z.array(evaluationCorpusDocumentSchema).min(1),
  sha256: contentIdSchema,
}).strict().superRefine((value, context) => {
  const documentIds = new Set<string>();
  const sourceFiles = new Set<string>();
  let previousDocumentId: string | null = null;
  for (let index = 0; index < value.documents.length; index += 1) {
    const document = value.documents[index];
    if (document === undefined) {
      continue;
    }
    if (documentIds.has(document.documentId)) {
      context.addIssue({
        code: "custom",
        message: "must not contain duplicate document IDs",
        path: ["documents", index, "documentId"],
      });
    }
    documentIds.add(document.documentId);
    if (sourceFiles.has(document.sourceFile)) {
      context.addIssue({
        code: "custom",
        message: "must not contain duplicate source files",
        path: ["documents", index, "sourceFile"],
      });
    }
    sourceFiles.add(document.sourceFile);
    if (previousDocumentId !== null && document.documentId <= previousDocumentId) {
      context.addIssue({
        code: "custom",
        message: "must be sorted by document ID",
        path: ["documents", index, "documentId"],
      });
    }
    previousDocumentId = document.documentId;
  }
  if (calculateEvaluationCorpusSha256(value.documents) !== value.sha256) {
    context.addIssue({
      code: "custom",
      message: "must match the corpus document provenance",
      path: ["sha256"],
    });
  }
});

const evaluationCaseShape = {
  domain: evaluationStableNameSchema,
  id: evaluationStableNameSchema,
  origin: evaluationCaseOriginSchema,
  question: z.string().trim().min(1).max(8_000),
  relevantDocumentIds: z.array(contentIdSchema).default([]),
  relevantElementIds: z.array(contentIdSchema).default([]),
};
const baseEvaluationCaseSchema = z.object(evaluationCaseShape).strict();
const benchmarkEvaluationCaseSchema = baseEvaluationCaseSchema.extend({
  judgments: z.array(evaluationJudgmentSchema).min(1),
  metadata: evaluationCaseMetadataSchema,
}).strict().superRefine((value, context) => {
  validateCommonEvaluationCase(value, context);
  validateBenchmarkEvaluationCase(value, context);
});

const benchmarkEvaluationDatasetSchema = z.object({
  access: evaluationAccessSchema,
  atK: z.number().int().min(1).default(10),
  cases: z.array(benchmarkEvaluationCaseSchema).min(1),
  corpus: evaluationCorpusProvenanceSchema.optional(),
  name: evaluationStableNameSchema,
  split: evaluationSplitSchema,
  statisticalDesign: evaluationStatisticalDesignSchema,
  version: z.union([z.literal(2), z.literal(3)]),
}).strict().superRefine((value, context) => {
  validateDatasetVersion(value, context);
  validateEvaluationDatasetCases(value, context);
  validateDatasetAccess(value, context);
  validateDatasetCorpus(value, context);
  validateDistinctImages(value, context);
  validateStatisticalDesignCaseCount(value, context);
});

export type BenchmarkEvaluationCase = z.output<
  typeof benchmarkEvaluationCaseSchema
>;
export type BenchmarkEvaluationDataset = z.output<
  typeof benchmarkEvaluationDatasetSchema
>;
export type EvaluationAccess = z.output<typeof evaluationAccessSchema>;
export type EvaluationAuditStatus = z.output<typeof evaluationAuditStatusSchema>;
export type EvaluationDataset = BenchmarkEvaluationDataset;
export type EvaluationCorpusDocument = z.output<
  typeof evaluationCorpusDocumentSchema
>;
export type EvaluationCorpusProvenance = z.output<
  typeof evaluationCorpusProvenanceSchema
>;
export type EvaluationJudgment = z.output<typeof evaluationJudgmentSchema>;
export type EvaluationLanguage = z.output<typeof evaluationLanguageSchema>;
export type EvaluationQuestionType = z.output<typeof evaluationQuestionTypeSchema>;
export type EvaluationRelevance = z.output<typeof evaluationRelevanceSchema>;
export type EvaluationSplit = z.output<typeof evaluationSplitSchema>;
export type EvaluationStatisticalDesign = z.output<
  typeof evaluationStatisticalDesignSchema
>;
export type TuningEvaluationDataset = BenchmarkEvaluationDataset & {
  access: "development";
  split: "development";
};

export function decodeEvaluationDataset(
  value: unknown,
  sourceLabel: string,
): EvaluationDataset {
  const result = benchmarkEvaluationDatasetSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid evaluation dataset ${sourceLabel}: ${result.error.message}`,
    );
  }
  return result.data;
}

export function readBenchmarkEvaluationDataset(
  dataset: EvaluationDataset,
  sourceLabel: string,
): BenchmarkEvaluationDataset {
  const pendingCases: string[] = [];
  for (const evaluationCase of dataset.cases) {
    for (const judgment of evaluationCase.judgments) {
      if (judgment.review.auditStatus !== "accepted") {
        pendingCases.push(evaluationCase.id);
        break;
      }
    }
  }
  if (pendingCases.length > 0) {
    throw new Error(
      `Evaluation dataset ${sourceLabel} is not benchmark-ready because ${pendingCases.length} case(s) contain pending or rejected judgments.`,
    );
  }
  return dataset;
}

export function readTuningEvaluationDataset(
  dataset: EvaluationDataset,
  sourceLabel: string,
): TuningEvaluationDataset {
  const benchmarkDataset = readBenchmarkEvaluationDataset(dataset, sourceLabel);
  if (
    benchmarkDataset.access !== "development" ||
    benchmarkDataset.split !== "development"
  ) {
    throw new Error(
      `Evaluation dataset ${sourceLabel} is not available to tuning code.`,
    );
  }
  return {
    ...benchmarkDataset,
    access: "development",
    split: "development",
  };
}

export async function readEvaluationDataset(
  filePath: string,
): Promise<EvaluationDataset> {
  const content = await readFile(filePath, "utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid evaluation JSON in ${filePath}: ${message}`);
  }
  return decodeEvaluationDataset(parsedJson, filePath);
}

export async function writeEvaluationDataset(
  filePath: string,
  dataset: EvaluationDataset,
  overwrite: boolean,
): Promise<void> {
  const normalized = decodeEvaluationDataset(dataset, "generated output");
  const sealedPath = filePath.endsWith(".sealed.json");
  if (sealedPath !== (normalized.access === "sealed")) {
    throw new Error(
      "Evaluation dataset access and its .sealed.json path classification differ.",
    );
  }
  await mkdir(dirname(filePath), { recursive: true });
  const flag = overwrite ? "w" : "wx";
  await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    flag,
  });
}

export function createEvaluationCorpusProvenance(
  documents: EvaluationCorpusDocument[],
): EvaluationCorpusProvenance {
  const normalizedDocuments = [...documents];
  normalizedDocuments.sort((left, right) => {
    return left.documentId.localeCompare(right.documentId);
  });
  return {
    documents: normalizedDocuments,
    sha256: calculateEvaluationCorpusSha256(normalizedDocuments),
  };
}

export function calculateEvaluationCorpusSha256(
  documents: EvaluationCorpusDocument[],
): string {
  return createHash("sha256")
    .update(JSON.stringify(documents))
    .digest("hex");
}

function validateCommonEvaluationCase(
  value: z.output<typeof baseEvaluationCaseSchema>,
  context: z.RefinementCtx,
): void {
  if (
    value.relevantDocumentIds.length === 0 &&
    value.relevantElementIds.length === 0
  ) {
    context.addIssue({
      code: "custom",
      message: "must name at least one relevant document or element",
      path: ["relevantDocumentIds"],
    });
  }
  if (new Set(value.relevantDocumentIds).size !== value.relevantDocumentIds.length) {
    context.addIssue({
      code: "custom",
      message: "must not contain duplicate document IDs",
      path: ["relevantDocumentIds"],
    });
  }
  if (new Set(value.relevantElementIds).size !== value.relevantElementIds.length) {
    context.addIssue({
      code: "custom",
      message: "must not contain duplicate element IDs",
      path: ["relevantElementIds"],
    });
  }
  if (
    value.origin.kind === "generated" &&
    !value.relevantElementIds.includes(value.origin.elementId)
  ) {
    context.addIssue({
      code: "custom",
      message: "must label the generated origin element as relevant",
      path: ["relevantElementIds"],
    });
  }
}

function validateBenchmarkEvaluationCase(
  value: BenchmarkEvaluationCase,
  context: z.RefinementCtx,
): void {
  const judgmentTargets = new Set<string>();
  const judgedDocumentIds = new Set<string>();
  const judgedElementIds = new Set<string>();
  for (let index = 0; index < value.judgments.length; index += 1) {
    const judgment = value.judgments[index];
    if (judgment === undefined) {
      continue;
    }
    const targetKey = `${judgment.target.kind}:${judgment.target.id}`;
    if (judgmentTargets.has(targetKey)) {
      context.addIssue({
        code: "custom",
        message: "must not contain duplicate judgment targets",
        path: ["judgments", index, "target"],
      });
    }
    judgmentTargets.add(targetKey);
    if (
      judgment.relevance === "irrelevant" ||
      judgment.review.auditStatus === "rejected"
    ) {
      continue;
    }
    if (judgment.target.kind === "document") {
      judgedDocumentIds.add(judgment.target.id);
    } else {
      judgedElementIds.add(judgment.target.id);
    }
  }
  validateLabelSet(
    value.relevantDocumentIds,
    judgedDocumentIds,
    "must match reviewed positive document judgments",
    ["relevantDocumentIds"],
    context,
  );
  validateLabelSet(
    value.relevantElementIds,
    judgedElementIds,
    "must match reviewed positive element judgments",
    ["relevantElementIds"],
    context,
  );
  if (value.origin.kind !== "generated") {
    return;
  }
  if (value.metadata.source.kind !== value.origin.sourceKind) {
    context.addIssue({
      code: "custom",
      message: "must match the generated origin source kind",
      path: ["metadata", "source", "kind"],
    });
  }
  const originJudgment = value.judgments.find((judgment) =>
    judgment.provenance.kind === "origin"
  );
  if (
    originJudgment === undefined ||
    originJudgment.target.kind !== "element" ||
    originJudgment.target.id !== value.origin.elementId
  ) {
    context.addIssue({
      code: "custom",
      message: "must include an origin judgment for the generated element",
      path: ["judgments"],
    });
  }
}

function validateEvaluationDatasetCases(
  value: { cases: BenchmarkEvaluationCase[] },
  context: z.RefinementCtx,
): void {
  const caseIds = new Set<string>();
  const originElementIds = new Set<string>();
  const questions = new Set<string>();
  for (let index = 0; index < value.cases.length; index += 1) {
    const evaluationCase = value.cases[index];
    if (evaluationCase === undefined) {
      continue;
    }
    if (caseIds.has(evaluationCase.id)) {
      context.addIssue({
        code: "custom",
        message: "must not contain duplicate case IDs",
        path: ["cases", index, "id"],
      });
    }
    caseIds.add(evaluationCase.id);
    const normalizedQuestion = evaluationCase.question.toLowerCase();
    if (questions.has(normalizedQuestion)) {
      context.addIssue({
        code: "custom",
        message: "must not contain duplicate questions",
        path: ["cases", index, "question"],
      });
    }
    questions.add(normalizedQuestion);
    if (evaluationCase.origin.kind !== "generated") {
      continue;
    }
    const originElementId = evaluationCase.origin.elementId;
    if (originElementIds.has(originElementId)) {
      context.addIssue({
        code: "custom",
        message: "must not reuse a generated origin element",
        path: ["cases", index, "origin", "elementId"],
      });
    }
    originElementIds.add(originElementId);
  }
}

function validateDatasetAccess(
  value: BenchmarkEvaluationDataset,
  context: z.RefinementCtx,
): void {
  const valid = value.split === "development"
    ? value.access === "development"
    : value.access === "regression" || value.access === "sealed";
  if (!valid) {
    context.addIssue({
      code: "custom",
      message: "must use development access for development data and regression or sealed access for holdout data",
      path: ["access"],
    });
  }
}

function validateDatasetVersion(
  value: BenchmarkEvaluationDataset,
  context: z.RefinementCtx,
): void {
  if (value.version === 2) {
    return;
  }
  if (value.corpus === undefined) {
    context.addIssue({
      code: "custom",
      message: "version 3 requires corpus provenance",
      path: ["corpus"],
    });
  }
}

function validateDatasetCorpus(
  value: BenchmarkEvaluationDataset,
  context: z.RefinementCtx,
): void {
  if (value.corpus === undefined) {
    return;
  }
  const documentsById = new Map(
    value.corpus.documents.map((document) => [document.documentId, document]),
  );
  for (let caseIndex = 0; caseIndex < value.cases.length; caseIndex += 1) {
    const evaluationCase = value.cases[caseIndex];
    if (evaluationCase === undefined) {
      continue;
    }
    for (const documentId of evaluationCase.relevantDocumentIds) {
      if (!documentsById.has(documentId)) {
        context.addIssue({
          code: "custom",
          message: "must include every relevant document in corpus provenance",
          path: ["cases", caseIndex, "relevantDocumentIds"],
        });
      }
    }
    if (evaluationCase.origin.kind !== "generated") {
      continue;
    }
    const corpusDocument = documentsById.get(evaluationCase.origin.documentId);
    if (corpusDocument === undefined) {
      context.addIssue({
        code: "custom",
        message: "must include the generated origin document in corpus provenance",
        path: ["cases", caseIndex, "origin", "documentId"],
      });
      continue;
    }
    if (corpusDocument.domain !== evaluationCase.domain) {
      context.addIssue({
        code: "custom",
        message: "must match the corpus document domain",
        path: ["cases", caseIndex, "domain"],
      });
    }
    if (corpusDocument.sourceFile !== evaluationCase.origin.sourceFile) {
      context.addIssue({
        code: "custom",
        message: "must match the corpus document source file",
        path: ["cases", caseIndex, "origin", "sourceFile"],
      });
    }
  }
}

function validateDistinctImages(
  value: BenchmarkEvaluationDataset,
  context: z.RefinementCtx,
): void {
  const visualIdentities = new Set<string>();
  for (let index = 0; index < value.cases.length; index += 1) {
    const source = value.cases[index]?.metadata.source;
    if (source?.kind !== "image") {
      continue;
    }
    if (visualIdentities.has(source.visualIdentitySha256)) {
      context.addIssue({
        code: "custom",
        message: "must not repeat the same visual artifact",
        path: ["cases", index, "metadata", "source", "visualIdentitySha256"],
      });
    }
    visualIdentities.add(source.visualIdentitySha256);
  }
}

function validateStatisticalDesignCaseCount(
  value: BenchmarkEvaluationDataset,
  context: z.RefinementCtx,
): void {
  if (value.cases.length >= value.statisticalDesign.requiredCaseCount) {
    return;
  }
  context.addIssue({
    code: "custom",
    message: `must contain at least ${value.statisticalDesign.requiredCaseCount} cases for the declared statistical design`,
    path: ["cases"],
  });
}

function validateLabelSet(
  labels: string[],
  judgedLabels: Set<string>,
  message: string,
  path: PropertyKey[],
  context: z.RefinementCtx,
): void {
  const labelSet = new Set(labels);
  if (
    labelSet.size === judgedLabels.size &&
    [...labelSet].every((label) => judgedLabels.has(label))
  ) {
    return;
  }
  context.addIssue({ code: "custom", message, path });
}
