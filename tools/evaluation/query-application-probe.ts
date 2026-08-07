import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  and,
  asc,
  desc,
  eq,
  inArray,
} from "drizzle-orm";
import { z } from "zod";

import { isPublishedAnsweredDocument } from "../../src/answers/published-schema.js";
import { decodePublishedAnswerDocument } from "../../src/answers/published-schema.js";
import { readPublishedDirectAnswerContent } from "../../src/answers/published.js";
import { readStartupConfig } from "../../src/config/index.js";
import { openDatabase, type CiteLoomDatabase } from "../../src/database/client.js";
import {
  activeRetrievalEvidence,
  activeRetrievalRoutes,
  chatCitationRecords,
  chatMessages,
  chatRuns,
  citationRecords,
  indexedDocuments,
  researchClaimChecks,
  researchStatementCitations,
  researchStatements,
  researchTurns,
  telemetryRuns,
  telemetryStages,
} from "../../src/database/schema.js";
import { createCanonicalEvidenceIdentity } from "../../src/retrieval/evidence-identity.js";
import { readEffectiveEvaluationConfig } from "./runtime-config.js";

const probeFacetSchema = z.object({
  answerPatterns: z.array(z.string().min(1)).min(1),
  description: z.string().min(1),
  evidenceAnchorSets: z.array(z.array(z.string().min(1)).min(1)).min(1),
  id: z.string().min(1),
});

const probeDefinitionSchema = z.object({
  facets: z.array(probeFacetSchema).min(1),
  id: z.string().min(1),
  performance: z.object({
    maximumRetrievalEndToEndMs: z.number().int().positive(),
    maximumRetrievalExecutionMs: z.number().int().positive(),
  }),
  question: z.string().min(1),
  requirements: z.object({
    identicalRetrievalAcrossSurfaces: z.boolean(),
    requireCitedStatementForEveryFacet: z.boolean(),
    requireDirectAnswerCitations: z.boolean(),
    requireSupportedVerificationForEveryCitedFacet: z.boolean(),
  }),
  sourceDocumentId: z.string().regex(/^[a-f0-9]{64}$/u),
  version: z.literal(1),
});

const retrievalTraceSchema = z.object({
  orderedSources: z.array(z.object({
    documentId: z.string().min(1),
    elementId: z.string().min(1),
    retrievalWindowId: z.string().min(1),
    sourceFile: z.string().min(1),
  }).passthrough()),
  queries: z.array(z.unknown()),
}).passthrough();

const candidateBudgetSchema = z.object({
  queries: z.array(z.object({
    channels: z.array(z.object({
      candidates: z.array(z.object({
        representationId: z.string().min(1),
      }).passthrough()),
    }).passthrough()),
  }).passthrough()),
}).passthrough();

const contextSelectionSchema = z.object({
  candidates: z.array(z.object({
    reason: z.string().min(1),
    rerankerInputRank: z.number().int().positive().nullable().optional(),
    rerankerRank: z.number().int().positive().nullable().optional(),
    rerankerScore: z.number().nullable().optional(),
    retrievalWindowId: z.string().min(1),
    selected: z.boolean(),
  }).passthrough()),
}).passthrough();

const chatClaimsSchema = z.array(z.object({
  claim: z.string().min(1),
  claimIndex: z.number().int().nonnegative(),
  status: z.string().min(1),
}).passthrough());

type ProbeDefinition = z.infer<typeof probeDefinitionSchema>;
type ProbeFacet = z.infer<typeof probeFacetSchema>;
type RetrievalTrace = z.infer<typeof retrievalTraceSchema>;

type CheckStatus = "fail" | "pass";

interface ProbeCheck {
  evidence: string;
  id: string;
  status: CheckStatus;
}

interface ProbeRunMetric {
  databaseRetrievalMs: number;
  durationMs: number | null;
  retrievalEndToEndMs: number;
  retrievalExecutionMs: number;
  retrievalSchedulerWaitMs: number;
  surface: "chat" | "question";
  timeToFirstTokenMs: number | null;
}

interface FacetEvidenceResult {
  candidate: boolean;
  description: string;
  id: string;
  matchingRepresentationIds: string[];
  rerankerRanks: number[];
  selected: boolean;
}

interface SurfaceAnswerResult {
  auditedEvidenceFacets: Set<string>;
  citedFacets: Set<string>;
  coveredFacets: Set<string>;
  directAnswerCited: boolean;
  supportedFacets: Set<string>;
  surface: "chat" | "question";
}

const retrievalStageNames = new Set([
  "scope-resolution",
  "query-expansion",
  "query-embedding",
  "dense-retrieval",
  "lexical-retrieval",
  "fusion",
  "toc-expansion",
  "hydration",
  "reranking",
]);

export async function main(arguments_: string[] = process.argv.slice(2)): Promise<void> {
  const definitionPath = resolve(
    arguments_[0]
      ?? "evaluations/probes/systemic-hypertension.application.json",
  );
  const definition = await readProbeDefinition(definitionPath);
  const startup = readStartupConfig();
  const effective = await readEffectiveEvaluationConfig(
    startup.database,
    startup.doclingTopology,
  );
  const session = await openDatabase(effective.config.database);
  try {
    const report = await runProbe(
      session.database,
      effective.config.embeddingSpace.id,
      definition,
    );
    console.log(JSON.stringify(report, null, 2));
    if (report.summary.failed > 0) {
      process.exitCode = 1;
    }
  } finally {
    await session.close();
  }
}

async function readProbeDefinition(path: string): Promise<ProbeDefinition> {
  const content = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error: unknown) {
    throw new Error(`Invalid query probe JSON at ${path}.`, { cause: error });
  }
  const result = probeDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Invalid query probe at ${path}: ${result.error.message}`);
  }
  validateProbePatterns(result.data, path);
  return result.data;
}

function validateProbePatterns(definition: ProbeDefinition, path: string): void {
  for (const facet of definition.facets) {
    for (const pattern of facet.answerPatterns) {
      try {
        new RegExp(pattern, "iu");
      } catch (error: unknown) {
        throw new Error(
          `Invalid answer pattern for facet ${facet.id} in ${path}.`,
          { cause: error },
        );
      }
    }
  }
}

async function runProbe(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  definition: ProbeDefinition,
) {
  const executions = await readProbeExecutions(database, definition.question);
  const questionTrace = decodeRetrievalTrace(
    executions.question.retrievalTrace,
    "Question retrieval trace",
  );
  const chatTrace = decodeRetrievalTrace(
    executions.chat.run.retrievalTrace,
    "Chat retrieval trace",
  );
  const chatCandidateBudget = decodeCandidateBudget(
    executions.chat.telemetry.candidateBudget,
  );
  const chatContextSelection = decodeContextSelection(
    executions.chat.telemetry.contextSelection,
  );

  const facets = await evaluateFacetEvidence(
    database,
    embeddingSpaceId,
    definition,
    chatTrace,
    chatCandidateBudget,
    chatContextSelection,
  );
  const answers = await evaluateAnswers(database, definition, executions);
  const metrics = await readRunMetrics(database, executions);
  const checks: ProbeCheck[] = [];
  appendExecutionChecks(checks, questionTrace, chatTrace, definition);
  await appendActiveEvidenceChecks(
    checks,
    database,
    embeddingSpaceId,
    questionTrace,
    chatTrace,
  );
  appendFacetChecks(checks, facets);
  appendAnswerChecks(checks, answers, definition);
  await appendCitationIntegrityChecks(
    checks,
    database,
    executions,
    questionTrace,
    chatTrace,
  );
  appendPerformanceChecks(checks, metrics, definition);

  let failed = 0;
  let passed = 0;
  for (const check of checks) {
    if (check.status === "fail") {
      failed += 1;
    } else {
      passed += 1;
    }
  }
  return {
    checks,
    definitionId: definition.id,
    facets,
    metrics,
    question: definition.question,
    runs: {
      chatRunId: executions.chat.run.id,
      chatTelemetryRunId: executions.chat.telemetry.id,
      questionTelemetryRunId: executions.question.runId,
      questionTurnId: executions.question.id,
    },
    summary: { failed, passed },
  };
}

async function readProbeExecutions(
  database: CiteLoomDatabase,
  question: string,
) {
  const questionRows = await database
    .select()
    .from(researchTurns)
    .where(and(
      eq(researchTurns.question, question),
      eq(researchTurns.outputState, "published"),
    ))
    .orderBy(desc(researchTurns.completedAt))
    .limit(1);
  const questionTurn = questionRows[0];
  if (questionTurn === undefined) {
    throw new Error(`No published Question execution found for: ${question}`);
  }

  const chatRows = await database
    .select({
      run: chatRuns,
    })
    .from(chatMessages)
    .innerJoin(chatRuns, eq(chatRuns.id, chatMessages.runId))
    .where(and(
      eq(chatMessages.content, question),
      eq(chatMessages.role, "user"),
      eq(chatRuns.state, "completed"),
    ))
    .orderBy(desc(chatMessages.createdAt))
    .limit(1);
  const chat = chatRows[0];
  if (chat === undefined || chat.run.completedAt === null) {
    throw new Error(`No completed Chat execution found for: ${question}`);
  }
  const assistantRows = await database
    .select()
    .from(chatMessages)
    .where(and(
      eq(chatMessages.runId, chat.run.id),
      eq(chatMessages.role, "assistant"),
    ))
    .limit(1);
  const assistant = assistantRows[0];
  if (assistant === undefined) {
    throw new Error(`Chat run ${chat.run.id} has no assistant message.`);
  }
  const telemetryRows = await database
    .select()
    .from(telemetryRuns)
    .where(and(
      eq(telemetryRuns.kind, "chat"),
      eq(telemetryRuns.outcome, "success"),
      eq(telemetryRuns.workloadId, chat.run.id),
    ))
    .orderBy(desc(telemetryRuns.completedAt))
    .limit(1);
  const chatTelemetry = telemetryRows[0];
  if (chatTelemetry === undefined) {
    throw new Error(`Chat run ${chat.run.id} has no matching telemetry run.`);
  }
  return {
    chat: {
      assistant,
      run: chat.run,
      telemetry: chatTelemetry,
    },
    question: questionTurn,
  };
}

function decodeRetrievalTrace(value: unknown, label: string): RetrievalTrace {
  const result = retrievalTraceSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label} is invalid: ${result.error.message}`);
  }
  return result.data;
}

function decodeCandidateBudget(value: unknown) {
  const result = candidateBudgetSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Chat candidate telemetry is invalid: ${result.error.message}`);
  }
  return result.data;
}

function decodeContextSelection(value: unknown) {
  const result = contextSelectionSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Chat context telemetry is invalid: ${result.error.message}`);
  }
  return result.data;
}

async function evaluateFacetEvidence(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  definition: ProbeDefinition,
  trace: RetrievalTrace,
  candidateBudget: z.infer<typeof candidateBudgetSchema>,
  contextSelection: z.infer<typeof contextSelectionSchema>,
): Promise<FacetEvidenceResult[]> {
  const routes = await database
    .select({
      content: activeRetrievalRoutes.representationContent,
      representationId: activeRetrievalRoutes.representationId,
    })
    .from(activeRetrievalRoutes)
    .where(and(
      eq(activeRetrievalRoutes.documentId, definition.sourceDocumentId),
      eq(activeRetrievalRoutes.embeddingSpaceId, embeddingSpaceId),
      eq(activeRetrievalRoutes.representationType, "exact-window"),
    ));
  const candidateIds = readCandidateIds(candidateBudget);
  const selectedIds = new Set(
    trace.orderedSources.map((source) => source.retrievalWindowId),
  );
  const selectionById = new Map(
    contextSelection.candidates.map((candidate) => [
      candidate.retrievalWindowId,
      candidate,
    ]),
  );
  const results: FacetEvidenceResult[] = [];
  for (const facet of definition.facets) {
    const matchingRepresentationIds: string[] = [];
    for (const route of routes) {
      if (containsAnAnchorSet(route.content, facet.evidenceAnchorSets)) {
        matchingRepresentationIds.push(route.representationId);
      }
    }
    const rerankerRanks: number[] = [];
    let candidate = false;
    let selected = false;
    for (const representationId of matchingRepresentationIds) {
      candidate = candidate || candidateIds.has(representationId);
      selected = selected || selectedIds.has(representationId);
      const selection = selectionById.get(representationId);
      if (selection?.rerankerRank !== undefined && selection.rerankerRank !== null) {
        rerankerRanks.push(selection.rerankerRank);
      }
    }
    rerankerRanks.sort((left, right) => left - right);
    results.push({
      candidate,
      description: facet.description,
      id: facet.id,
      matchingRepresentationIds,
      rerankerRanks,
      selected,
    });
  }
  return results;
}

function readCandidateIds(
  candidateBudget: z.infer<typeof candidateBudgetSchema>,
): Set<string> {
  const ids = new Set<string>();
  for (const query of candidateBudget.queries) {
    for (const channel of query.channels) {
      for (const candidate of channel.candidates) {
        ids.add(candidate.representationId);
      }
    }
  }
  return ids;
}

function containsEveryAnchor(content: string, anchors: readonly string[]): boolean {
  const normalized = content.toLocaleLowerCase("en");
  for (const anchor of anchors) {
    if (!normalized.includes(anchor.toLocaleLowerCase("en"))) {
      return false;
    }
  }
  return true;
}

function containsAnAnchorSet(
  content: string,
  anchorSets: readonly (readonly string[])[],
): boolean {
  for (const anchors of anchorSets) {
    if (containsEveryAnchor(content, anchors)) {
      return true;
    }
  }
  return false;
}

async function evaluateAnswers(
  database: CiteLoomDatabase,
  definition: ProbeDefinition,
  executions: Awaited<ReturnType<typeof readProbeExecutions>>,
): Promise<SurfaceAnswerResult[]> {
  const chatCitationRows = await database
    .select({
      evidence: chatCitationRecords.evidence,
      id: chatCitationRecords.id,
    })
    .from(chatCitationRecords)
    .where(eq(
      chatCitationRecords.assistantMessageId,
      executions.chat.assistant.id,
    ));
  const chat = evaluateChatAnswer(
    definition,
    executions.chat.assistant,
    chatCitationRows,
  );
  const question = await evaluateQuestionAnswer(
    database,
    definition,
    executions.question,
  );
  return [question, chat];
}

function evaluateChatAnswer(
  definition: ProbeDefinition,
  assistant: Awaited<ReturnType<typeof readProbeExecutions>>["chat"]["assistant"],
  citationRows: Array<Pick<typeof chatCitationRecords.$inferSelect, "evidence" | "id">>,
): SurfaceAnswerResult {
  const answerDocument = decodePublishedAnswerDocument(assistant.answerDocument);
  const claims = chatClaimsSchema.parse(assistant.claims);
  let fullContent = readPublishedDirectAnswerContent(answerDocument);
  if (isPublishedAnsweredDocument(answerDocument)) {
    const statementContents: string[] = [];
    for (const statement of answerDocument.statements) {
      statementContents.push(statement.content);
    }
    fullContent = statementContents.join("\n");
  }
  const result = createEmptySurfaceAnswerResult("chat");
  const evidenceByCitationId = new Map(
    citationRows.map((citation) => [
      citation.id,
      readCitationEvidenceText(citation.evidence),
    ]),
  );
  if (isPublishedAnsweredDocument(answerDocument)) {
    const directAnswer = answerDocument.statements[0];
    result.directAnswerCited = directAnswer !== undefined
      && directAnswer.section === "answer"
      && directAnswer.presentation === "paragraph"
      && directAnswer.citationIds.length > 0;
  }
  for (const facet of definition.facets) {
    if (matchesFacet(fullContent, facet)) {
      result.coveredFacets.add(facet.id);
    }
    if (!isPublishedAnsweredDocument(answerDocument)) {
      continue;
    }
    for (let index = 0; index < answerDocument.statements.length; index += 1) {
      const statement = answerDocument.statements[index];
      if (statement === undefined || !matchesFacet(statement.content, facet)) {
        continue;
      }
      if (statement.citationIds.length > 0) {
        result.citedFacets.add(facet.id);
      }
      const citedEvidence = statement.citationIds.map((citationId) => {
        return evidenceByCitationId.get(citationId) ?? "";
      }).join("\n");
      if (containsAnAnchorSet(citedEvidence, facet.evidenceAnchorSets)) {
        result.auditedEvidenceFacets.add(facet.id);
      }
      const verification = claims.find((claim) => claim.claimIndex === index);
      if (verification?.status === "supported") {
        result.supportedFacets.add(facet.id);
      }
    }
  }
  return result;
}

async function evaluateQuestionAnswer(
  database: CiteLoomDatabase,
  definition: ProbeDefinition,
  turn: Awaited<ReturnType<typeof readProbeExecutions>>["question"],
): Promise<SurfaceAnswerResult> {
  const statements = await database
    .select()
    .from(researchStatements)
    .where(eq(researchStatements.turnId, turn.id))
    .orderBy(asc(researchStatements.statementIndex));
  const statementIds = statements.map((statement) => statement.id);
  const citations = statementIds.length === 0
    ? []
    : await database
      .select()
      .from(researchStatementCitations)
      .where(inArray(researchStatementCitations.statementId, statementIds));
  const claimChecks = statementIds.length === 0
    ? []
    : await database
      .select()
      .from(researchClaimChecks)
      .where(inArray(researchClaimChecks.statementId, statementIds));
  const claimCheckByStatementId = new Map(claimChecks.map((claimCheck) => {
    return [claimCheck.statementId, claimCheck];
  }));
  const citationIds = [...new Set(citations.map((citation) => citation.citationId))];
  const citationRows = citationIds.length === 0
    ? []
    : await database
      .select({
        evidence: citationRecords.evidence,
        id: citationRecords.id,
      })
      .from(citationRecords)
      .where(inArray(citationRecords.id, citationIds));
  const evidenceByCitationId = new Map(
    citationRows.map((citation) => [
      citation.id,
      readCitationEvidenceText(citation.evidence),
    ]),
  );
  const citationIdsByStatement = new Map<string, string[]>();
  const citationCountByStatement = new Map<string, number>();
  for (const citation of citations) {
    const count = citationCountByStatement.get(citation.statementId) ?? 0;
    citationCountByStatement.set(citation.statementId, count + 1);
    const ids = citationIdsByStatement.get(citation.statementId) ?? [];
    ids.push(citation.citationId);
    citationIdsByStatement.set(citation.statementId, ids);
  }
  let fullContent = turn.answerContent ?? "";
  for (const statement of statements) {
    fullContent += `\n${statement.content}`;
  }
  const result = createEmptySurfaceAnswerResult("question");
  const directAnswer = statements.find((statement) => (
    statement.statementIndex === 0
    && statement.section === "answer"
    && statement.presentation === "paragraph"
  ));
  result.directAnswerCited = directAnswer !== undefined
    && (citationCountByStatement.get(directAnswer.id) ?? 0) > 0;
  for (const facet of definition.facets) {
    if (matchesFacet(fullContent, facet)) {
      result.coveredFacets.add(facet.id);
    }
    for (const statement of statements) {
      if (!matchesFacet(statement.content, facet)) {
        continue;
      }
      if ((citationCountByStatement.get(statement.id) ?? 0) > 0) {
        result.citedFacets.add(facet.id);
      }
      const statementCitationIds = citationIdsByStatement.get(statement.id) ?? [];
      const citedEvidence = statementCitationIds.map((citationId) => {
        return evidenceByCitationId.get(citationId) ?? "";
      }).join("\n");
      if (containsAnAnchorSet(citedEvidence, facet.evidenceAnchorSets)) {
        result.auditedEvidenceFacets.add(facet.id);
      }
      if (claimCheckByStatementId.get(statement.id)?.status === "supported") {
        result.supportedFacets.add(facet.id);
      }
    }
  }
  return result;
}

function createEmptySurfaceAnswerResult(
  surface: "chat" | "question",
): SurfaceAnswerResult {
  return {
    auditedEvidenceFacets: new Set(),
    citedFacets: new Set(),
    coveredFacets: new Set(),
    directAnswerCited: false,
    supportedFacets: new Set(),
    surface,
  };
}

function readCitationEvidenceText(
  evidence: typeof citationRecords.$inferSelect.evidence,
): string {
  if (evidence.kind === "text") {
    return evidence.excerpt;
  }
  if (evidence.kind === "table") {
    return evidence.content;
  }
  return "";
}

function matchesFacet(content: string, facet: ProbeFacet): boolean {
  for (const pattern of facet.answerPatterns) {
    if (new RegExp(pattern, "iu").test(content)) {
      return true;
    }
  }
  return false;
}

async function readRunMetrics(
  database: CiteLoomDatabase,
  executions: Awaited<ReturnType<typeof readProbeExecutions>>,
): Promise<ProbeRunMetric[]> {
  const telemetryIds = [executions.question.runId, executions.chat.telemetry.id];
  const stages = await database
    .select()
    .from(telemetryStages)
    .where(inArray(telemetryStages.runId, telemetryIds));
  const questionMetric = buildRunMetric(
    "question",
    executions.question.runId,
    executions.question.completedAt,
    stages,
    null,
  );
  const chatMetric = buildRunMetric(
    "chat",
    executions.chat.telemetry.id,
    executions.chat.run.completedAt,
    stages,
    executions.chat.telemetry,
  );
  const questionTelemetryRows = await database
    .select()
    .from(telemetryRuns)
    .where(eq(telemetryRuns.id, executions.question.runId))
    .limit(1);
  const questionTelemetry = questionTelemetryRows[0];
  if (questionTelemetry === undefined) {
    throw new Error(`Question run ${executions.question.runId} has no telemetry.`);
  }
  questionMetric.durationMs = questionTelemetry.durationMs;
  questionMetric.timeToFirstTokenMs = questionTelemetry.timeToFirstTokenMs;
  return [questionMetric, chatMetric];
}

function buildRunMetric(
  surface: "chat" | "question",
  runId: string,
  completedAt: Date | null,
  stages: Array<typeof telemetryStages.$inferSelect>,
  telemetry: typeof telemetryRuns.$inferSelect | null,
): ProbeRunMetric {
  if (completedAt === null) {
    throw new Error(`${surface} execution has no completion timestamp.`);
  }
  let databaseRetrievalMs = 0;
  let retrievalEndToEndMs = 0;
  let retrievalSchedulerWaitMs = 0;
  for (const stage of stages) {
    if (stage.runId !== runId) {
      continue;
    }
    if (stage.name === "dense-retrieval" || stage.name === "lexical-retrieval") {
      databaseRetrievalMs += stage.durationMs;
    }
    if (retrievalStageNames.has(stage.name)) {
      retrievalEndToEndMs += stage.durationMs;
      retrievalSchedulerWaitMs += stage.schedulerWaitMs ?? 0;
    }
  }
  const retrievalExecutionMs = Math.max(
    0,
    retrievalEndToEndMs - retrievalSchedulerWaitMs,
  );
  return {
    databaseRetrievalMs,
    durationMs: telemetry?.durationMs ?? null,
    retrievalEndToEndMs,
    retrievalExecutionMs,
    retrievalSchedulerWaitMs,
    surface,
    timeToFirstTokenMs: telemetry?.timeToFirstTokenMs ?? null,
  };
}

async function appendActiveEvidenceChecks(
  checks: ProbeCheck[],
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  questionTrace: RetrievalTrace,
  chatTrace: RetrievalTrace,
): Promise<void> {
  await appendTraceAuthorityCheck(
    checks,
    database,
    embeddingSpaceId,
    "question",
    questionTrace,
  );
  await appendTraceAuthorityCheck(
    checks,
    database,
    embeddingSpaceId,
    "chat",
    chatTrace,
  );
}

async function appendTraceAuthorityCheck(
  checks: ProbeCheck[],
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  surface: "chat" | "question",
  trace: RetrievalTrace,
): Promise<void> {
  const retrievalWindowIds = trace.orderedSources.map((source) => (
    source.retrievalWindowId
  ));
  const evidenceRows = retrievalWindowIds.length === 0
    ? []
    : await database
      .select({
        documentId: activeRetrievalEvidence.documentId,
        elementSetId: indexedDocuments.elementSetId,
        evidenceContent: activeRetrievalEvidence.evidenceContent,
        evidenceRetrievalId: activeRetrievalEvidence.evidenceId,
        parentId: activeRetrievalEvidence.parentId,
        sourceFile: activeRetrievalEvidence.sourceFile,
      })
      .from(activeRetrievalEvidence)
      .innerJoin(
        indexedDocuments,
        and(
          eq(indexedDocuments.documentId, activeRetrievalEvidence.documentId),
          eq(indexedDocuments.sourceFile, activeRetrievalEvidence.sourceFile),
        ),
      )
      .where(and(
        eq(activeRetrievalEvidence.embeddingSpaceId, embeddingSpaceId),
        inArray(activeRetrievalEvidence.evidenceId, retrievalWindowIds),
      ));
  const evidenceBySource = new Map<string, string>();
  for (const row of evidenceRows) {
    const sourceIdentity = createTraceSourceIdentity(row);
    const evidenceIdentity = createCanonicalEvidenceIdentity({
      documentId: row.documentId,
      elementSetId: row.elementSetId,
      evidenceContent: row.evidenceContent,
      parentId: row.parentId,
    });
    evidenceBySource.set(sourceIdentity, evidenceIdentity);
  }
  let active = 0;
  const selectedEvidenceIdentities = new Set<string>();
  for (const source of trace.orderedSources) {
    const evidenceIdentity = evidenceBySource.get(
      createTraceSourceIdentity(source),
    );
    if (evidenceIdentity === undefined) {
      continue;
    }
    active += 1;
    selectedEvidenceIdentities.add(evidenceIdentity);
  }
  checks.push({
    evidence: `${active}/${trace.orderedSources.length} selected sources remain authoritative`,
    id: `${surface}-retrieval-authority`,
    status: active === trace.orderedSources.length ? "pass" : "fail",
  });
  checks.push({
    evidence: `${selectedEvidenceIdentities.size}/${trace.orderedSources.length} selected sources are unique canonical evidence`,
    id: `${surface}-selected-evidence-uniqueness`,
    status: selectedEvidenceIdentities.size === trace.orderedSources.length
      ? "pass"
      : "fail",
  });
}

function createTraceSourceIdentity(source: {
  documentId: string;
  elementId?: string;
  retrievalWindowId?: string;
  evidenceRetrievalId?: string;
  parentId?: string;
  representationId?: string;
  sourceFile: string;
}): string {
  const retrievalId = source.retrievalWindowId
    ?? source.evidenceRetrievalId
    ?? source.representationId;
  if (retrievalId === undefined) {
    throw new Error("Retrieval source identity has no window identifier.");
  }
  const parentId = source.elementId ?? source.parentId;
  if (parentId === undefined) {
    throw new Error("Retrieval source identity has no parent identifier.");
  }
  return [source.documentId, source.sourceFile, retrievalId, parentId].join(
    "\u0000",
  );
}

function appendExecutionChecks(
  checks: ProbeCheck[],
  questionTrace: RetrievalTrace,
  chatTrace: RetrievalTrace,
  definition: ProbeDefinition,
): void {
  const sameQueries = JSON.stringify(questionTrace.queries)
    === JSON.stringify(chatTrace.queries);
  const sameSources = JSON.stringify(questionTrace.orderedSources)
    === JSON.stringify(chatTrace.orderedSources);
  const required = definition.requirements.identicalRetrievalAcrossSurfaces;
  const passed = !required || (sameQueries && sameSources);
  checks.push({
    evidence: `queries identical=${sameQueries}; ordered sources identical=${sameSources}`,
    id: "surface-retrieval-parity",
    status: passed ? "pass" : "fail",
  });
}

function appendFacetChecks(
  checks: ProbeCheck[],
  facets: readonly FacetEvidenceResult[],
): void {
  for (const facet of facets) {
    checks.push({
      evidence: `candidate=${facet.candidate}; selected=${facet.selected}; rerankerRanks=${facet.rerankerRanks.join(",") || "none"}`,
      id: `evidence-facet:${facet.id}`,
      status: facet.selected ? "pass" : "fail",
    });
  }
}

function appendAnswerChecks(
  checks: ProbeCheck[],
  answers: readonly SurfaceAnswerResult[],
  definition: ProbeDefinition,
): void {
  for (const answer of answers) {
    for (const facet of definition.facets) {
      checks.push({
        evidence: `${answer.surface} answer facet coverage for ${facet.description}`,
        id: `${answer.surface}-answer-facet:${facet.id}`,
        status: answer.coveredFacets.has(facet.id) ? "pass" : "fail",
      });
      if (definition.requirements.requireCitedStatementForEveryFacet) {
        checks.push({
          evidence: `${answer.surface} cited statement for ${facet.description}`,
          id: `${answer.surface}-cited-facet:${facet.id}`,
          status: answer.citedFacets.has(facet.id) ? "pass" : "fail",
        });
        checks.push({
          evidence: `${answer.surface} cited evidence contains the audited anchors for ${facet.description}`,
          id: `${answer.surface}-audited-evidence-facet:${facet.id}`,
          status: answer.auditedEvidenceFacets.has(facet.id) ? "pass" : "fail",
        });
      }
      if (definition.requirements.requireSupportedVerificationForEveryCitedFacet) {
        const audited = answer.auditedEvidenceFacets.has(facet.id);
        const supported = answer.supportedFacets.has(facet.id);
        checks.push({
          evidence: `${answer.surface} verifier supported=${supported}; audited evidence matched=${audited}; facet=${facet.description}`,
          id: `${answer.surface}-verified-facet:${facet.id}`,
          status: audited && supported ? "pass" : "fail",
        });
      }
    }
    if (definition.requirements.requireDirectAnswerCitations) {
      checks.push({
        evidence: `${answer.surface} direct answer has explicit citation bindings`,
        id: `${answer.surface}-direct-answer-citations`,
        status: answer.directAnswerCited ? "pass" : "fail",
      });
    }
  }
}

async function appendCitationIntegrityChecks(
  checks: ProbeCheck[],
  database: CiteLoomDatabase,
  executions: Awaited<ReturnType<typeof readProbeExecutions>>,
  questionTrace: RetrievalTrace,
  chatTrace: RetrievalTrace,
): Promise<void> {
  const chatCitations = await database
    .select({ elementId: chatCitationRecords.elementId })
    .from(chatCitationRecords)
    .where(eq(
      chatCitationRecords.assistantMessageId,
      executions.chat.assistant.id,
    ));
  const questionCitations = await database
    .select({ elementId: citationRecords.elementId })
    .from(citationRecords)
    .where(eq(citationRecords.turnId, executions.question.id));
  appendSurfaceCitationCheck(checks, "chat", chatCitations, chatTrace);
  appendSurfaceCitationCheck(
    checks,
    "question",
    questionCitations,
    questionTrace,
  );
}

function appendSurfaceCitationCheck(
  checks: ProbeCheck[],
  surface: "chat" | "question",
  citations: Array<{ elementId: string }>,
  trace: RetrievalTrace,
): void {
  const selectedIds = new Set(
    trace.orderedSources.map((source) => source.elementId),
  );
  let matched = 0;
  for (const citation of citations) {
    if (selectedIds.has(citation.elementId)) {
      matched += 1;
    }
  }
  checks.push({
    evidence: `${matched}/${citations.length} citations came from selected context`,
    id: `${surface}-citation-context-integrity`,
    status: matched === citations.length ? "pass" : "fail",
  });
}

function appendPerformanceChecks(
  checks: ProbeCheck[],
  metrics: readonly ProbeRunMetric[],
  definition: ProbeDefinition,
): void {
  for (const metric of metrics) {
    const executionLimit = definition.performance.maximumRetrievalExecutionMs;
    checks.push({
      evidence: `${metric.retrievalExecutionMs} ms active retrieval execution; declared limit ${executionLimit} ms; database retrieval ${metric.databaseRetrievalMs} ms`,
      id: `${metric.surface}-retrieval-execution-latency`,
      status: metric.retrievalExecutionMs <= executionLimit ? "pass" : "fail",
    });
    const endToEndLimit = definition.performance.maximumRetrievalEndToEndMs;
    checks.push({
      evidence: `${metric.retrievalEndToEndMs} ms end-to-end retrieval; declared limit ${endToEndLimit} ms; scheduler wait ${metric.retrievalSchedulerWaitMs} ms`,
      id: `${metric.surface}-retrieval-end-to-end-latency`,
      status: metric.retrievalEndToEndMs <= endToEndLimit ? "pass" : "fail",
    });
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error: ${message}`);
    process.exitCode = 1;
  });
}
