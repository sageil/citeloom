import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import {
  evaluationAccessSchema,
  evaluationCaseMetadataSchema,
  evaluationJudgmentSchema,
  evaluationSplitSchema,
  evaluationStatisticalDesignSchema,
  evaluationStableNameSchema,
} from "./dataset.js";
import type {
  DenseCandidate,
  FusedCandidate,
  LexicalCandidate,
} from "../../src/retrieval/ranking/rank-fusion.js";
import type { TelemetryRunSnapshot } from "../../src/observability/run.js";
import {
  rankRetrievalCandidates,
  selectRerankingCandidatesWithTrace,
  type RetrievalCandidateRankings,
} from "../../src/retrieval/indexing/query-store.js";
import { contentIdSchema } from "../../src/domain/validation.js";
import { embeddingInputFormatContractSchema } from "../../src/embedding/input-format-model.js";
import { partitionCandidateWindowsByParentOccurrence } from "../../src/retrieval/document-retrieval.js";
import { CHANNEL_ORDERING_POLICY } from "../../src/retrieval/ranking/channel-ordering.js";
import { retrievalWindowPolicyContractSchema } from "../../src/retrieval/window-policy.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const retrievalModeSchema = z.enum([
  "bm25",
  "dense",
  "hybrid",
  "hybrid-reranked",
]);
const modelIdentitySchema = z.object({
  modelId: z.string().min(1),
  provider: z.string().min(1),
}).strict();
const rankFusionSchema = z.object({
  denseWeight: z.number().positive().max(100),
  expansionDecay: z.number().positive().max(1),
  expansionQueryWeight: z.number().positive().max(100),
  lexicalWeight: z.number().positive().max(100),
  originalQueryWeight: z.number().positive().max(100),
}).strict();
const preparedQuerySchema = z.object({
  embeddingSha256: sha256Schema,
  text: z.string().min(1),
}).strict();
const candidateRepresentationSchema = z.object({
  content: z.string().min(1),
  id: z.string().regex(/^[a-f0-9]{64}(?:-description)?$/u),
  type: z.enum([
    "exact-window",
    "table-description",
    "image-description",
  ]),
}).strict();
const denseCandidateSchema = z.object({
  distance: z.number().finite().nonnegative(),
  documentId: contentIdSchema,
  elementId: contentIdSchema,
  evidenceContent: z.string().min(1),
  evidenceRetrievalId: sha256Schema,
  representation: candidateRepresentationSchema,
  sourceFile: z.string().min(1),
}).strict();
const lexicalCandidateSchema = z.object({
  bm25Score: z.number().finite().positive(),
  documentId: contentIdSchema,
  elementId: contentIdSchema,
  evidenceContent: z.string().min(1),
  evidenceRetrievalId: sha256Schema,
  representation: candidateRepresentationSchema,
  sourceFile: z.string().min(1),
}).strict();
const rerankerScoreSchema = z.object({
  documentId: contentIdSchema,
  documentVersionId: z.uuid(),
  elementId: contentIdSchema,
  retrievalId: sha256Schema,
  relevanceScore: z.number().finite(),
  scoringBatchIndex: z.number().int().positive(),
  scoringBatchRank: z.number().int().positive(),
  sourceFile: z.string().min(1),
}).strict();
const candidateSelectionDecisionSchema = z.object({
  admissionRank: z.number().int().positive().nullable(),
  documentId: contentIdSchema,
  elementId: contentIdSchema,
  exclusionReason: z.enum([
    "candidate-budget",
    "duplicate-evidence",
  ]).nullable(),
  fusedRank: z.number().int().positive(),
  representativeRetrievalWindowId: sha256Schema,
  retrievalId: sha256Schema,
  sourceFile: z.string().min(1),
}).strict();
const preparedCandidateSelectionSchema = z.object({
  allocationPolicy: z.enum(["document-round-robin", "fused-order"]),
  candidateK: z.number().int().positive(),
  decisions: z.array(candidateSelectionDecisionSchema).min(1),
  rerankerInputRetrievalIds: z.array(sha256Schema).min(1),
}).strict();
const preparedCaseSchema = z.object({
  candidateRankings: z.object({
    dense: z.array(z.array(denseCandidateSchema).min(1)),
    lexical: z.array(z.array(lexicalCandidateSchema)),
  }).strict(),
  candidateSelection: preparedCandidateSelectionSchema.nullable(),
  domain: evaluationStableNameSchema,
  id: evaluationStableNameSchema,
  judgments: z.array(evaluationJudgmentSchema).min(1),
  metadata: evaluationCaseMetadataSchema,
  queryGenerationSeed: z.number().int().nonnegative(),
  queries: z.array(preparedQuerySchema).min(1),
  question: z.string().trim().min(1).max(8_000),
  relevantDocumentIds: z.array(contentIdSchema),
  relevantElementIds: z.array(contentIdSchema),
  rerankerScores: z.array(rerankerScoreSchema).nullable(),
  tuningRerankerScores: z.array(rerankerScoreSchema).nullable(),
}).strict().superRefine((value, context) => {
  if (value.candidateRankings.dense.length !== value.queries.length) {
    context.addIssue({
      code: "custom",
      message: "must contain one dense ranking per query",
      path: ["candidateRankings", "dense"],
    });
  }
  if (value.candidateRankings.lexical.length !== value.queries.length) {
    context.addIssue({
      code: "custom",
      message: "must contain one lexical ranking per query",
      path: ["candidateRankings", "lexical"],
    });
  }
});
export const evaluationProvenanceSchema = z.object({
  codeRevision: z.string().min(1),
  corpus: z.object({
    documentIds: z.array(contentIdSchema),
    sha256: sha256Schema,
  }).strict(),
  dataset: z.object({
    access: evaluationAccessSchema,
    atK: z.number().int().min(1),
    configurationFreezeSha256: sha256Schema.nullable(),
    name: evaluationStableNameSchema,
    sha256: sha256Schema,
    split: evaluationSplitSchema,
    statisticalDesign: evaluationStatisticalDesignSchema,
  }).strict(),
  embeddingSpace: z.object({
    dimensions: z.union([z.literal(384), z.literal(768), z.literal(1024)]),
    id: z.string().min(1),
    inputFormat: embeddingInputFormatContractSchema,
    model: z.string().min(1),
    retrievalWindow: retrievalWindowPolicyContractSchema,
  }).strict(),
  hnsw: z.object({
    efSearch: z.number().int().positive(),
    iterativeScan: z.literal("strict_order"),
  }).strict(),
  models: z.object({
    queryEmbedding: modelIdentitySchema,
    queryExpansion: modelIdentitySchema.nullable(),
    reranker: modelIdentitySchema.nullable(),
  }).strict(),
  retrieval: z.object({
    candidateK: z.number().int().positive(),
    channelOrderingPolicy: z.literal(CHANNEL_ORDERING_POLICY),
    fusion: rankFusionSchema,
    queryExpansions: z.number().int().nonnegative(),
    rrfK: z.number().int().positive(),
    topK: z.number().int().positive(),
  }).strict(),
  settingsVersion: z.number().int().nonnegative(),
}).strict();
const telemetryStageSnapshotSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  inputCount: z.number().int().nonnegative().nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  modelId: z.string().min(1).nullable(),
  name: z.enum([
    "answer",
    // Retained so stored artifacts from the removed classifier remain readable.
    "answer-shape",
    "dense-retrieval",
    "fusion",
    "hydration",
    "lexical-retrieval",
    "query-embedding",
    "query-expansion",
    "reranking",
    "scope-resolution",
  ]),
  outcome: z.enum(["abort", "error", "fallback", "success"]),
  outputCount: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  provider: z.string().min(1).nullable(),
  providerDurationMs: z.number().int().nonnegative().nullable(),
  retrievalMode: retrievalModeSchema.nullable(),
  schedulerWaitMs: z.number().int().nonnegative().nullable(),
  sequence: z.number().int().nonnegative(),
}).strict();
export const telemetryRunSnapshotSchema: z.ZodType<TelemetryRunSnapshot> = z.object({
  durationMs: z.number().int().nonnegative(),
  fallbackCount: z.number().int().nonnegative(),
  outcome: z.enum(["abort", "error", "success"]),
  runId: z.uuid(),
  stages: z.array(telemetryStageSnapshotSchema),
  streamDurationMs: z.number().int().nonnegative().nullable(),
  timeToFirstTokenMs: z.number().int().nonnegative().nullable(),
}).strict();
const benchmarkTelemetrySchema = z.object({
  caseId: evaluationStableNameSchema,
  trace: telemetryRunSnapshotSchema,
}).strict();
const evaluationPreparationArtifactSchema = z.object({
  cases: z.array(preparedCaseSchema).min(1),
  provenance: evaluationProvenanceSchema,
  skippedModes: z.array(retrievalModeSchema),
  telemetry: z.array(benchmarkTelemetrySchema).min(1),
  version: z.literal(13),
}).strict();

export type EvaluationPreparationArtifact = z.output<
  typeof evaluationPreparationArtifactSchema
>;
export type EvaluationProvenance = z.output<typeof evaluationProvenanceSchema>;
export type PreparedEvaluationCase = z.output<typeof preparedCaseSchema>;
export type EvaluationBenchmarkTelemetry = z.output<
  typeof benchmarkTelemetrySchema
>;

export function calculateSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function calculateJsonSha256(value: unknown): string {
  return calculateSha256(JSON.stringify(value));
}

export function decodeEvaluationPreparationArtifact(
  value: unknown,
  sourceLabel: string,
): EvaluationPreparationArtifact {
  rejectIncompatibleArtifactVersion(value, sourceLabel);
  const result = evaluationPreparationArtifactSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid evaluation preparation ${sourceLabel}: ${result.error.message}`,
    );
  }
  validateEvaluationPreparation(result.data);
  return result.data;
}

function rejectIncompatibleArtifactVersion(
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
  if (version !== 13) {
    throw new Error(
      `Incompatible evaluation preparation ${sourceLabel}: expected version 13, received ${String(version)}.`,
    );
  }
}

export async function readEvaluationPreparationArtifact(
  filePath: string,
): Promise<EvaluationPreparationArtifact> {
  const content = await readFile(filePath, "utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid evaluation preparation JSON in ${filePath}: ${message}`);
  }
  return decodeEvaluationPreparationArtifact(parsedJson, filePath);
}

export async function writeEvaluationPreparationArtifact(
  filePath: string,
  artifact: EvaluationPreparationArtifact,
): Promise<void> {
  const normalized = decodeEvaluationPreparationArtifact(
    artifact,
    "generated output",
  );
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeEvaluationPreparationArtifact(normalized), {
    encoding: "utf8",
    flag: "wx",
  });
}

export function serializeEvaluationPreparationArtifact(
  artifact: EvaluationPreparationArtifact,
): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

export function assertEvaluationProvenanceMatches(
  expected: EvaluationProvenance,
  actual: EvaluationProvenance,
): void {
  assertProvenanceValue("dataset", expected.dataset, actual.dataset);
  assertProvenanceValue("corpus", expected.corpus, actual.corpus);
  assertProvenanceValue(
    "embedding space",
    expected.embeddingSpace,
    actual.embeddingSpace,
  );
  assertProvenanceValue("models", expected.models, actual.models);
  assertProvenanceValue("retrieval settings", expected.retrieval, actual.retrieval);
  assertProvenanceValue("HNSW settings", expected.hnsw, actual.hnsw);
  assertProvenanceValue(
    "settings version",
    expected.settingsVersion,
    actual.settingsVersion,
  );
  assertProvenanceValue(
    "code revision",
    expected.codeRevision,
    actual.codeRevision,
  );
}

function assertProvenanceValue(
  label: string,
  expected: unknown,
  actual: unknown,
): void {
  if (calculateJsonSha256(expected) === calculateJsonSha256(actual)) {
    return;
  }
  throw new Error(`Evaluation preparation ${label} does not match.`);
}

function validateEvaluationPreparation(
  artifact: EvaluationPreparationArtifact,
): void {
  validateCorpusProvenance(artifact.provenance);
  if (artifact.provenance.retrieval.topK !== artifact.provenance.dataset.atK) {
    throw new Error(
      "Invalid evaluation preparation: retrieval topK must match dataset atK.",
    );
  }
  const datasetIsSealed = artifact.provenance.dataset.access === "sealed";
  const hasFreeze = artifact.provenance.dataset.configurationFreezeSha256 !== null;
  if (datasetIsSealed !== hasFreeze) {
    throw new Error(
      "Invalid evaluation preparation: sealed access and frozen configuration provenance differ.",
    );
  }
  const skippedModes = new Set(artifact.skippedModes);
  if (skippedModes.size !== artifact.skippedModes.length) {
    throw new Error(
      "Invalid evaluation preparation: skipped modes must be unique.",
    );
  }
  const rerankerWasSkipped = skippedModes.has("hybrid-reranked");
  const rerankerIsMissing = artifact.provenance.models.reranker === null;
  if (rerankerWasSkipped !== rerankerIsMissing) {
    throw new Error(
      "Invalid evaluation preparation: reranker provenance and skipped modes differ.",
    );
  }
  if (skippedModes.size !== (rerankerIsMissing ? 1 : 0)) {
    throw new Error(
      "Invalid evaluation preparation: only an unavailable reranker may be skipped.",
    );
  }

  const caseIds = new Set<string>();
  const visualIdentities = new Set<string>();
  for (const preparedCase of artifact.cases) {
    if (caseIds.has(preparedCase.id)) {
      throw new Error(
        `Invalid evaluation preparation: duplicate case ${preparedCase.id}.`,
      );
    }
    caseIds.add(preparedCase.id);
    const source = preparedCase.metadata.source;
    if (source.kind === "image") {
      if (visualIdentities.has(source.visualIdentitySha256)) {
        throw new Error(
          "Invalid evaluation preparation: repeated visual artifact.",
        );
      }
      visualIdentities.add(source.visualIdentitySha256);
    }
    validatePreparedCase(artifact, preparedCase);
  }
  validateBenchmarkTelemetry(artifact, caseIds);
}

function validateBenchmarkTelemetry(
  artifact: EvaluationPreparationArtifact,
  caseIds: Set<string>,
): void {
  if (artifact.telemetry.length !== caseIds.size) {
    throw new Error(
      "Invalid evaluation preparation: telemetry must contain one trace per case.",
    );
  }
  const tracedCaseIds = new Set<string>();
  for (const entry of artifact.telemetry) {
    if (!caseIds.has(entry.caseId) || tracedCaseIds.has(entry.caseId)) {
      throw new Error(
        "Invalid evaluation preparation: telemetry case IDs must match prepared cases.",
      );
    }
    tracedCaseIds.add(entry.caseId);
    const sequences = entry.trace.stages.map((stage) => stage.sequence);
    const expectedSequences = sequences.map((_value, index) => index);
    if (calculateJsonSha256(sequences) !== calculateJsonSha256(expectedSequences)) {
      throw new Error(
        `Invalid evaluation preparation: telemetry stages for ${entry.caseId} are not sequential.`,
      );
    }
  }
}

function validateCorpusProvenance(provenance: EvaluationProvenance): void {
  const sortedDocumentIds = [...provenance.corpus.documentIds];
  sortedDocumentIds.sort((left, right) => left.localeCompare(right));
  if (new Set(sortedDocumentIds).size !== sortedDocumentIds.length) {
    throw new Error(
      "Invalid evaluation preparation: corpus document IDs must be unique.",
    );
  }
  if (calculateJsonSha256(sortedDocumentIds) !== provenance.corpus.sha256) {
    throw new Error(
      "Invalid evaluation preparation: corpus SHA-256 does not match its document IDs.",
    );
  }
}

function validatePreparedCase(
  artifact: EvaluationPreparationArtifact,
  preparedCase: PreparedEvaluationCase,
): void {
  for (const judgment of preparedCase.judgments) {
    if (judgment.review.auditStatus !== "accepted") {
      throw new Error(
        `Invalid evaluation preparation: case ${preparedCase.id} contains an unaccepted judgment.`,
      );
    }
  }
  validatePreparedJudgmentLabels(preparedCase);
  if (preparedCase.queries[0]?.text !== preparedCase.question) {
    throw new Error(
      `Invalid evaluation preparation: case ${preparedCase.id} does not preserve its original question as query 1.`,
    );
  }
  rankRetrievalCandidates(
    "hybrid",
    readPreparedCandidateRankings(preparedCase),
    artifact.provenance.retrieval.rrfK,
    artifact.provenance.retrieval.fusion,
  );
  validateRerankerScores(artifact, preparedCase);
}

function validatePreparedJudgmentLabels(
  preparedCase: PreparedEvaluationCase,
): void {
  const documentIds: string[] = [];
  const elementIds: string[] = [];
  for (const judgment of preparedCase.judgments) {
    if (judgment.relevance === "irrelevant") {
      continue;
    }
    if (judgment.target.kind === "document") {
      documentIds.push(judgment.target.id);
    } else {
      elementIds.push(judgment.target.id);
    }
  }
  documentIds.sort();
  elementIds.sort();
  const expectedDocumentIds = [...preparedCase.relevantDocumentIds];
  const expectedElementIds = [...preparedCase.relevantElementIds];
  expectedDocumentIds.sort();
  expectedElementIds.sort();
  if (
    calculateJsonSha256(documentIds) !== calculateJsonSha256(expectedDocumentIds) ||
    calculateJsonSha256(elementIds) !== calculateJsonSha256(expectedElementIds)
  ) {
    throw new Error(
      `Invalid evaluation preparation: case ${preparedCase.id} relevance labels do not match its judgments.`,
    );
  }
}

function validateRerankerScores(
  artifact: EvaluationPreparationArtifact,
  preparedCase: PreparedEvaluationCase,
): void {
  const rerankerConfigured = artifact.provenance.models.reranker !== null;
  const scores = preparedCase.rerankerScores;
  const tuningScores = preparedCase.tuningRerankerScores;
  const storedSelection = preparedCase.candidateSelection;
  if (!rerankerConfigured) {
    if (
      scores !== null
      || storedSelection !== null
      || tuningScores !== null
    ) {
      throw new Error(
        `Invalid evaluation preparation: case ${preparedCase.id} has reranker preparation without a reranker model.`,
      );
    }
    return;
  }
  if (
    scores === null
    || storedSelection === null
    || tuningScores === null
  ) {
    throw new Error(
      `Invalid evaluation preparation: case ${preparedCase.id} has incomplete reranker preparation.`,
    );
  }
  const rankings = readPreparedCandidateRankings(preparedCase);
  const fusedCandidates = rankRetrievalCandidates(
    "hybrid-reranked",
    rankings,
    artifact.provenance.retrieval.rrfK,
    artifact.provenance.retrieval.fusion,
  );
  const expectedSelection = selectRerankingCandidatesWithTrace(
    preparedCase.question,
    fusedCandidates,
    artifact.provenance.retrieval.candidateK,
  );
  validatePreparedCandidateSelection(
    preparedCase,
    storedSelection,
    expectedSelection,
  );
  validateRerankerScoreBatches(
    preparedCase,
    scores,
    [expectedSelection.selected],
    "production",
  );
  validateRerankerScoreBatches(
    preparedCase,
    tuningScores,
    partitionCandidateWindowsByParentOccurrence(fusedCandidates),
    "tuning universe",
  );
}

function validateRerankerScoreBatches(
  preparedCase: PreparedEvaluationCase,
  scores: NonNullable<PreparedEvaluationCase["rerankerScores"]>,
  batches: readonly (readonly FusedCandidate[])[],
  batchLabel: string,
): void {
  const scoresByRetrievalId = new Map<string, (typeof scores)[number]>();
  for (const score of scores) {
    if (scoresByRetrievalId.has(score.retrievalId)) {
      throw new Error(
        `Invalid evaluation preparation: case ${preparedCase.id} has duplicate reranker score ${score.retrievalId}.`,
      );
    }
    scoresByRetrievalId.set(score.retrievalId, score);
  }
  let expectedScoreCount = 0;
  for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
    const batch = batches[batchIndex];
    if (batch === undefined) {
      continue;
    }
    expectedScoreCount += batch.length;
    for (let index = 0; index < batch.length; index += 1) {
      const candidate = batch[index];
      if (candidate === undefined) {
        continue;
      }
      const score = scoresByRetrievalId.get(candidate.retrievalId);
      if (score === undefined) {
        throw new Error(
          `Invalid evaluation preparation: case ${preparedCase.id} ${batchLabel} reranker scores do not cover its candidate universe.`,
        );
      }
      if (
        score.documentId !== candidate.documentId
        || score.elementId !== candidate.parentId
        || score.scoringBatchIndex !== batchIndex + 1
        || score.scoringBatchRank !== index + 1
        || score.sourceFile !== candidate.sourceFile
      ) {
        throw new Error(
          `Invalid evaluation preparation: case ${preparedCase.id} reranker identity ${candidate.retrievalId} does not match its fused candidate.`,
        );
      }
    }
  }
  if (scoresByRetrievalId.size !== expectedScoreCount) {
    throw new Error(
      `Invalid evaluation preparation: case ${preparedCase.id} ${batchLabel} reranker scores do not cover its candidate universe.`,
    );
  }
}

function validatePreparedCandidateSelection(
  preparedCase: PreparedEvaluationCase,
  stored: NonNullable<PreparedEvaluationCase["candidateSelection"]>,
  expected: ReturnType<typeof selectRerankingCandidatesWithTrace>,
): void {
  if (
    stored.allocationPolicy !== expected.allocationPolicy
    || stored.candidateK !== expected.candidateK
  ) {
    throw new Error(
      `Invalid evaluation preparation: case ${preparedCase.id} has a contradictory candidate-selection policy.`,
    );
  }
  const expectedInputIds = expected.selected.map((candidate) => (
    candidate.retrievalId
  ));
  if (
    calculateJsonSha256(stored.rerankerInputRetrievalIds)
    !== calculateJsonSha256(expectedInputIds)
  ) {
    throw new Error(
      `Invalid evaluation preparation: case ${preparedCase.id} reranker input does not replay production candidate selection.`,
    );
  }
  const expectedDecisions = expected.decisions.map((decision) => ({
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
  if (
    calculateJsonSha256(stored.decisions)
    !== calculateJsonSha256(expectedDecisions)
  ) {
    throw new Error(
      `Invalid evaluation preparation: case ${preparedCase.id} candidate-selection trace is not reproducible.`,
    );
  }
}

export function readPreparedCandidateRankings(
  preparedCase: PreparedEvaluationCase,
): RetrievalCandidateRankings {
  const dense: DenseCandidate[][] = [];
  for (const ranking of preparedCase.candidateRankings.dense) {
    const candidates: DenseCandidate[] = [];
    for (const candidate of ranking) {
      candidates.push({
        distance: candidate.distance,
        documentId: candidate.documentId,
        evidenceContent: candidate.evidenceContent,
        evidenceRetrievalId: candidate.evidenceRetrievalId,
        parentId: candidate.elementId,
        representation: candidate.representation,
        sourceFile: candidate.sourceFile,
      });
    }
    dense.push(candidates);
  }
  const lexical: LexicalCandidate[][] = [];
  for (const ranking of preparedCase.candidateRankings.lexical) {
    const candidates: LexicalCandidate[] = [];
    for (const candidate of ranking) {
      candidates.push({
        bm25Score: candidate.bm25Score,
        documentId: candidate.documentId,
        evidenceContent: candidate.evidenceContent,
        evidenceRetrievalId: candidate.evidenceRetrievalId,
        parentId: candidate.elementId,
        representation: candidate.representation,
        sourceFile: candidate.sourceFile,
      });
    }
    lexical.push(candidates);
  }
  return { dense, lexical };
}
