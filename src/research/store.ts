import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  max,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type { AppConfig } from "../config/index.js";
import type { CiteLoomDatabase } from "../database/client.js";
import {
  citationRecords,
  documentElementSetMembers,
  documentVersions,
  embeddingSpaces,
  indexedDocuments,
  researchClaimChecks,
  researchClaimEvidenceUnits,
  researchFeedback,
  researchStatementCitations,
  researchStatements,
  researchThreads,
  researchTurns,
  researchVerificationJobs,
  sourceElements,
} from "../database/schema.js";
import type {
  ClaimedVerificationJob,
} from "../answers/verification-worker.js";
import { researchVerificationJobQueue } from "../answers/verification-job-queue.js";
import {
  verificationJobStateSchema,
} from "../answers/verification-state.js";
import type { MatchedDocument } from "../retrieval/document-retrieval.js";
import {
  publishedAnswerDocumentSchema,
  decodePublishedAnswerDocument,
  isPublishedAnsweredDocument,
  isPublishedUncitedAnswerDocument,
  readPublishedAnswerClaims,
  renderPublishedAnswerMarkdown,
  type PublishedAnswerCitation,
  type PublishedAnswerDocument,
  type PublishedAnswerStatement,
} from "../answers/published.js";
import { queryScopeSchema, type QueryScope } from "../domain/query-scope.js";
import { RETRIEVAL_MODES } from "../retrieval/mode.js";
import { QUESTION_PROCESSING_POLICY_ID } from "../domain/question.js";
import type {
  AnswerClaim,
  CitationEvidence,
  ClaimVerificationResult,
  DocumentVersionDifference,
  DocumentVersionRecord,
  FeedbackDimension,
  ResearchReproducibility,
  ResearchRetrievalTrace,
  ResearchFeedbackSummary,
  ResearchRunConfiguration,
  ResearchThread,
  ResearchThreadSummary,
  ResearchTurn,
  StoredCitationRecord,
  StoredClaimCheck,
} from "./types.js";
import type { ClaimEvidenceSource } from "../answers/claim-verification.js";
import {
  SourceDocumentStore,
} from "../documents/storage/source-document-store.js";
import { SourceContentStore } from "../documents/storage/source-content-store.js";
import {
  decodeDocumentFormat,
  type BufferedDocumentSource,
} from "../documents/format.js";
import type { SourceElement } from "../domain/source-elements.js";
import {
  contentIdSchema,
  sourceRegionSchema,
} from "../domain/validation.js";

const fusionSchema = z.object({
  denseWeight: z.number().nonnegative(),
  expansionDecay: z.number().nonnegative(),
  expansionQueryWeight: z.number().nonnegative(),
  lexicalWeight: z.number().nonnegative(),
  originalQueryWeight: z.number().nonnegative(),
}).strict();
const RESEARCH_THREAD_TITLE_LOCK_ID = 1_384_921_704;
const runConfigurationSchema = z.object({
  embeddingSpaceId: z.string().min(1),
  models: z.object({
    answer: z.string().min(1),
    embedding: z.string().min(1),
    reranker: z.string().min(1).nullable(),
    verifier: z.string().min(1),
  }).strict(),
  retrieval: z.object({
    answerTemperature: z.number().min(0).max(2).default(0.1),
    answerMinimumRerankerScore: z.number().nullable().default(null),
    candidateK: z.number().int().positive(),
    fusion: fusionSchema,
    mode: z.enum([...RETRIEVAL_MODES, "hybrid-reranked"]).transform((mode) => {
      return mode === "hybrid-reranked" ? "hybrid" : mode;
    }),
    queryExpansions: z.number().int().nonnegative(),
    queryExpansionTemperature: z.number().min(0).max(2).default(0.1),
    rrfK: z.number().int().positive(),
    tocRoutingEnabled: z.boolean().default(false),
    topK: z.number().int().positive(),
  }).strict(),
  settingsVersion: z.number().int().nonnegative(),
}).strict();
const retrievalTraceGenerationSchema = z.object({
  generation: z.object({
    answer: z.object({
      temperature: z.number().min(0).max(2),
    }).strict(),
    queryExpansion: z.object({
      temperature: z.number().min(0).max(2),
    }).strict(),
  }).strict(),
});
const previousRetrievalTraceQueriesSchema = z.object({
  queries: z.array(z.object({
    kind: z.enum(["expansion", "original"]),
    text: z.string().min(1),
  }).strict()).min(1),
});
const currentRetrievalTraceQueriesSchema = z.object({
  queries: z.array(z.object({
    kind: z.enum(["conversation", "expansion", "original"]),
    text: z.string().min(1),
  }).strict()).min(1),
});
const retrievalTraceOrderedSourcesSchema = z.array(z.object({
    documentId: contentIdSchema,
    documentVersionId: z.uuid(),
    evidenceSha256: contentIdSchema,
    elementId: contentIdSchema,
    rank: z.number().int().positive(),
    representationHits: z.array(z.object({
      channel: z.enum(["dense", "lexical", "toc"]),
      queryIndex: z.number().int().nonnegative(),
      rank: z.number().int().positive(),
      representationId: z.string().regex(
        /^[a-f0-9]{64}(?:-description)?$/u,
      ),
      representationType: z.enum([
        "exact-window",
        "table-description",
        "image-description",
      ]),
      routingType: z.enum(["document-title", "section-outline"]).optional(),
    }).strict()).min(1),
    retrievalWindowId: contentIdSchema,
    sourceFile: z.string().min(1),
    descriptionAffected: z.boolean(),
  }).strict());
const legacyRetrievalTraceSchema = retrievalTraceGenerationSchema.extend({
  ...previousRetrievalTraceQueriesSchema.shape,
  orderedSources: retrievalTraceOrderedSourcesSchema,
  version: z.literal(3),
}).strict();
const previousRetrievalTraceSchema = retrievalTraceGenerationSchema.extend({
  ...previousRetrievalTraceQueriesSchema.shape,
  orderedSources: retrievalTraceOrderedSourcesSchema,
  question: z.object({
    original: z.string().min(1),
    policyId: z.literal(QUESTION_PROCESSING_POLICY_ID),
    processing: z.string().min(1),
  }).strict(),
  version: z.literal(4),
}).strict();
const currentRetrievalTraceSchema = retrievalTraceGenerationSchema.extend({
  ...currentRetrievalTraceQueriesSchema.shape,
  orderedSources: retrievalTraceOrderedSourcesSchema,
  question: z.object({
    original: z.string().min(1),
    policyId: z.literal(QUESTION_PROCESSING_POLICY_ID),
    processing: z.string().min(1),
  }).strict(),
  version: z.literal(5),
}).strict();
const storedRetrievalTraceSchema = z.discriminatedUnion("version", [
  legacyRetrievalTraceSchema,
  previousRetrievalTraceSchema,
  currentRetrievalTraceSchema,
]);
const passiveAbortSignal = new AbortController().signal;
type ResearchTransaction = Parameters<
  Parameters<CiteLoomDatabase["transaction"]>[0]
>[0];
const evidenceSchema = z.discriminatedUnion("kind", [
  z.object({ excerpt: z.string().min(1), kind: z.literal("text") }).strict(),
  z.object({
    content: z.string().min(1),
    kind: z.literal("table"),
    table: z.object({
      cells: z.array(z.object({
        columnHeader: z.boolean(),
        columnSpan: z.number().int().positive(),
        endColumn: z.number().int().positive(),
        endRow: z.number().int().positive(),
        rowHeader: z.boolean(),
        rowSection: z.boolean(),
        rowSpan: z.number().int().positive(),
        startColumn: z.number().int().nonnegative(),
        startRow: z.number().int().nonnegative(),
        text: z.string(),
      }).strict()),
      columnCount: z.number().int().positive(),
      rowCount: z.number().int().positive(),
      rowEnd: z.number().int().positive(),
      rowStart: z.number().int().nonnegative(),
    }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("image"),
    mimeType: z.string().min(1),
  }).strict(),
]);
const documentVersionRowSchema = z.object({
  createdAt: z.date(),
  documentId: contentIdSchema,
  elementCount: z.number().int().positive(),
  elementSetId: contentIdSchema,
  fileExtension: z.string(),
  generationId: z.uuid(),
  id: z.uuid(),
  mediaType: z.string(),
  pageCount: z.number().int().positive().nullable(),
  sourceFile: z.string().min(1),
  version: z.number().int().positive(),
});
const citationRowSchema = z.object({
  citationNumber: z.number().int().positive(),
  createdAt: z.date(),
  documentId: contentIdSchema,
  documentVersionId: z.uuid(),
  elementSetId: contentIdSchema,
  elementId: contentIdSchema,
  evidence: evidenceSchema,
  id: z.uuid(),
  pageNumbers: z.array(z.number().int().positive()),
  regions: z.array(sourceRegionSchema),
  sectionPath: z.array(z.string().min(1)),
  sourceFile: z.string().min(1),
  turnId: z.uuid(),
});
const citationRowSelection = {
  citationNumber: citationRecords.citationNumber,
  createdAt: citationRecords.createdAt,
  documentId: documentVersions.documentId,
  documentVersionId: citationRecords.documentVersionId,
  elementId: citationRecords.elementId,
  elementSetId: citationRecords.elementSetId,
  evidence: citationRecords.evidence,
  id: citationRecords.id,
  pageNumbers: citationRecords.pageNumbers,
  regions: citationRecords.regions,
  sectionPath: citationRecords.sectionPath,
  sourceFile: citationRecords.sourceFile,
  turnId: citationRecords.turnId,
};
const statementRowSchema = z.object({
  content: z.string().min(1),
  createdAt: z.date(),
  id: z.uuid(),
  presentation: z.enum(["paragraph", "bullet"]),
  section: z.enum(["answer", "key-points", "conflicting-evidence"]),
  statementIndex: z.number().int().nonnegative(),
  turnId: z.uuid(),
});
const verificationEvidenceUnitSchema = z.object({
  citationNumber: z.number().int().positive(),
  outcome: z.enum([
    "not-evaluated",
    "supported",
    "unsupported",
    "verifier-incompatible",
  ]),
  rationale: z.string().min(1),
  supportProbability: z.number().min(0).max(1).nullable(),
  unitId: z.string().min(1),
}).strict();
const claimVerificationResultSchema: z.ZodType<ClaimVerificationResult> = z.object({
  citationNumbers: z.array(z.number().int().positive()),
  claim: z.string().trim().min(1),
  claimIndex: z.number().int().nonnegative(),
  evidenceUnits: z.array(verificationEvidenceUnitSchema),
  rationale: z.string().trim().min(1),
  status: z.enum(["supported", "partially-supported", "unsupported", "unverified"]),
  verifierModel: z.string().trim().min(1),
}).strict();
const statementCitationRowSchema = z.object({
  citationId: z.uuid(),
  citationPosition: z.number().int().nonnegative(),
  statementId: z.uuid(),
  turnId: z.uuid(),
});
const claimCheckRowSchema = z.object({
  createdAt: z.date(),
  id: z.uuid(),
  rationale: z.string().min(1),
  statementId: z.uuid(),
  status: z.enum(["supported", "partially-supported", "unsupported", "unverified"]),
  turnId: z.uuid(),
  verifierModel: z.string().min(1),
});
const claimEvidenceUnitRowSchema = z.object({
  checkId: z.uuid(),
  citationId: z.uuid(),
  evidencePosition: z.number().int().nonnegative(),
  outcome: z.enum([
    "not-evaluated",
    "supported",
    "unsupported",
    "verifier-incompatible",
  ]),
  rationale: z.string().min(1),
  statementId: z.uuid(),
  supportProbability: z.number().min(0).max(1).nullable(),
  turnId: z.uuid(),
  unitId: z.string().min(1),
});
const threadRowSchema = z.object({
  createdAt: z.date(),
  id: z.uuid(),
  title: z.string().min(1),
  updatedAt: z.date(),
});
const turnRowSchema = z.object({
  answerSchemaVersion: z.literal(2),
  completedAt: z.date(),
  id: z.uuid(),
  answerContent: z.string().trim().min(1).nullable(),
  outputState: z.literal("published"),
  question: z.string().min(1),
  retrievedContext: z.array(z.object({
    documentId: contentIdSchema,
    retrievedElementCount: z.number().int().positive(),
    sourceFile: z.string().min(1),
  }).strict()),
  retrievalTrace: storedRetrievalTraceSchema,
  runConfiguration: runConfigurationSchema,
  runId: z.uuid(),
  scope: queryScopeSchema,
  sequence: z.number().int().positive(),
  threadId: z.uuid(),
});

export interface SaveResearchTurnInput {
  answerDocument: PublishedAnswerDocument;
  claims: readonly ClaimVerificationResult[];
  completedAt: Date;
  question: string;
  retrievedContext: readonly MatchedDocument[];
  retrievalTrace: ResearchRetrievalTrace;
  runConfiguration: ResearchRunConfiguration;
  runId: string;
  scope: QueryScope;
  threadId: string;
}

export interface ResearchFeedbackInput {
  citationId: string | null;
  comment: string | null;
  dimension: FeedbackDimension;
  rating: -1 | 1;
  turnId: string;
}

export type ResearchExportFormat = "citations" | "json" | "markdown";

export interface ResearchExport {
  content: string;
  filename: string;
  mediaType: string;
}

export interface CitationEvidenceRecord {
  citation: StoredCitationRecord;
  element: SourceElement;
}

export class ResearchThreadNotFoundError extends Error {
  public constructor(id: string) {
    super(`Research thread was not found: ${id}`);
    this.name = "ResearchThreadNotFoundError";
  }
}

export class ResearchRecordNotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ResearchRecordNotFoundError";
  }
}

export class ResearchInputConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ResearchInputConflictError";
  }
}

export class ResearchStore {
  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly config: AppConfig,
  ) {}

  public async createThread(title: string): Promise<ResearchThread> {
    const normalizedTitle = decodeResearchThreadTitle(title);
    const threadId = await this.database.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(${RESEARCH_THREAD_TITLE_LOCK_ID})`,
      );
      const existingRows = await transaction
        .select({ id: researchThreads.id })
        .from(researchThreads)
        .where(sql`lower(${researchThreads.title}) = lower(${normalizedTitle})`)
        .orderBy(desc(researchThreads.updatedAt))
        .limit(1);
      const existing = existingRows[0];
      if (existing !== undefined) {
        return existing.id;
      }

      const id = randomUUID();
      const now = new Date();
      await transaction.insert(researchThreads).values({
        createdAt: now,
        id,
        title: normalizedTitle,
        updatedAt: now,
      });
      return id;
    });
    const thread = await this.readThread(threadId);
    if (thread === null) {
      throw new Error(`Resolved research thread was not found: ${threadId}`);
    }
    return thread;
  }

  public async listThreads(): Promise<ResearchThreadSummary[]> {
    const rows = await this.database
      .select({
        createdAt: researchThreads.createdAt,
        id: researchThreads.id,
        title: researchThreads.title,
        turnCount: count(researchTurns.id),
        updatedAt: researchThreads.updatedAt,
      })
      .from(researchThreads)
      .leftJoin(researchTurns, eq(researchTurns.threadId, researchThreads.id))
      .groupBy(researchThreads.id)
      .orderBy(desc(researchThreads.updatedAt));
    const summaries: ResearchThreadSummary[] = [];
    for (const row of rows) {
      const parsed = z.object({
        createdAt: z.date(),
        id: z.uuid(),
        title: z.string().min(1),
        turnCount: z.number().int().nonnegative(),
        updatedAt: z.date(),
      }).safeParse(row);
      if (!parsed.success) {
        throw new Error(`Invalid research thread summary: ${parsed.error.message}`);
      }
      summaries.push({
        createdAt: parsed.data.createdAt.toISOString(),
        id: parsed.data.id,
        title: parsed.data.title,
        turnCount: parsed.data.turnCount,
        updatedAt: parsed.data.updatedAt.toISOString(),
      });
    }
    return summaries;
  }

  public async deleteThread(id: string): Promise<void> {
    const deleted = await this.database
      .delete(researchThreads)
      .where(eq(researchThreads.id, id))
      .returning({ id: researchThreads.id });
    if (deleted[0] === undefined) {
      throw new ResearchRecordNotFoundError(
        `Research thread was not found: ${id}`,
      );
    }
  }

  public async readThread(id: string): Promise<ResearchThread | null> {
    const threadRows = await this.database
      .select()
      .from(researchThreads)
      .where(eq(researchThreads.id, id))
      .limit(1);
    const rawThread = threadRows[0];
    if (rawThread === undefined) {
      return null;
    }
    const thread = decodeThreadRow(rawThread);
    const rawTurns = await this.database
      .select()
      .from(researchTurns)
      .where(eq(researchTurns.threadId, thread.id))
      .orderBy(asc(researchTurns.sequence));
    const turns = await this.decodeTurns(rawTurns);
    return {
      createdAt: thread.createdAt.toISOString(),
      id: thread.id,
      title: thread.title,
      turns,
      updatedAt: thread.updatedAt.toISOString(),
    };
  }

  public async saveTurn(
    input: SaveResearchTurnInput,
    abortSignal: AbortSignal = passiveAbortSignal,
  ): Promise<ResearchTurn> {
    abortSignal.throwIfAborted();
    const normalized = decodeSaveResearchTurnInput(input);
    const citations = [...normalized.answerDocument.citations];
    const citationElementSetIds = await this.validateCitationAnchors(citations);
    abortSignal.throwIfAborted();
    const reproducibility = await this.readReproducibility(
      normalized.runConfiguration,
      citations.map((citation) => citation.elementId),
    );
    abortSignal.throwIfAborted();
    const turnId = randomUUID();
    const statements = isPublishedAnsweredDocument(normalized.answerDocument)
      ? [...normalized.answerDocument.statements]
      : [];
    const statementIds = statements.map(() => randomUUID());
    const claimIds = normalized.claims.map(() => randomUUID());
    const sequence = await this.database.transaction(async (transaction) => {
      const threadRows = await transaction
        .select({ id: researchThreads.id })
        .from(researchThreads)
        .where(eq(researchThreads.id, normalized.threadId))
        .for("update")
        .limit(1);
      if (threadRows[0] === undefined) {
        throw new ResearchThreadNotFoundError(normalized.threadId);
      }
      abortSignal.throwIfAborted();
      const sequenceRows = await transaction
        .select({ value: max(researchTurns.sequence) })
        .from(researchTurns)
        .where(eq(researchTurns.threadId, normalized.threadId));
      const nextSequence = (sequenceRows[0]?.value ?? 0) + 1;
      await transaction.insert(researchTurns).values({
        answerSchemaVersion: normalized.answerDocument.schemaVersion,
        completedAt: normalized.completedAt,
        id: turnId,
        answerContent: normalized.answerDocument.content,
        outputState: "building",
        question: normalized.question,
        retrievedContext: [...normalized.retrievedContext],
        retrievalTrace: normalized.retrievalTrace,
        runConfiguration: normalized.runConfiguration,
        runId: normalized.runId,
        scope: normalized.scope,
        sequence: nextSequence,
        threadId: normalized.threadId,
      });
      if (citations.length > 0) {
        const citationValues = [];
        for (const citation of citations) {
          citationValues.push({
            citationNumber: citation.citationNumber,
            createdAt: normalized.completedAt,
            documentVersionId: citation.documentVersionId,
            elementSetId: readRequiredCitationElementSetId(
              citationElementSetIds,
              citation,
            ),
            elementId: citation.elementId,
            evidence: citation.evidence,
            id: citation.id,
            pageNumbers: citation.pageNumbers,
            regions: citation.regions,
            sectionPath: citation.sectionPath,
            sourceFile: citation.sourceFile,
            turnId,
          });
        }
        await transaction.insert(citationRecords).values(citationValues);
      }
      if (statements.length > 0) {
        const statementValues = [];
        const statementCitationValues = [];
        for (
          let statementIndex = 0;
          statementIndex < statements.length;
          statementIndex += 1
        ) {
          const statement = statements[statementIndex];
          const statementId = statementIds[statementIndex];
          if (statement === undefined || statementId === undefined) {
            throw new Error(
              `Missing normalized statement at index ${statementIndex}.`,
            );
          }
          statementValues.push({
            content: statement.content,
            createdAt: normalized.completedAt,
            id: statementId,
            presentation: statement.presentation,
            section: statement.section,
            statementIndex,
            turnId,
          });
          for (
            let citationPosition = 0;
            citationPosition < statement.citationIds.length;
            citationPosition += 1
          ) {
            const citationId = statement.citationIds[citationPosition];
            if (citationId === undefined) {
              throw new Error(
                `Missing citation ${citationPosition} for statement ${statementIndex}.`,
              );
            }
            statementCitationValues.push({
              citationId,
              citationPosition,
              statementId,
              turnId,
            });
          }
        }
        await transaction.insert(researchStatements).values(statementValues);
        await transaction
          .insert(researchStatementCitations)
          .values(statementCitationValues);
      }
      if (normalized.claims.length > 0) {
        const checkValues = [];
        const evidenceUnitValues = [];
        const citationByNumber = new Map(citations.map((citation) => {
          return [citation.citationNumber, citation];
        }));
        for (
          let checkIndex = 0;
          checkIndex < normalized.claims.length;
          checkIndex += 1
        ) {
          const claim = normalized.claims[checkIndex];
          const checkId = claimIds[checkIndex];
          const statementId = claim === undefined
            ? undefined
            : statementIds[claim.claimIndex];
          if (
            claim === undefined
            || checkId === undefined
            || statementId === undefined
          ) {
            throw new Error(
              `Missing normalized claim check at index ${checkIndex}.`,
            );
          }
          checkValues.push({
            createdAt: normalized.completedAt,
            id: checkId,
            rationale: claim.rationale,
            statementId,
            status: claim.status,
            turnId,
            verifierModel: claim.verifierModel,
          });
          for (
            let evidencePosition = 0;
            evidencePosition < claim.evidenceUnits.length;
            evidencePosition += 1
          ) {
            const evidenceUnit = claim.evidenceUnits[evidencePosition];
            const citation = evidenceUnit === undefined
              ? undefined
              : citationByNumber.get(evidenceUnit.citationNumber);
            if (evidenceUnit === undefined || citation === undefined) {
              throw new Error(
                `Missing evidence unit ${evidencePosition} for claim ${claim.claimIndex}.`,
              );
            }
            evidenceUnitValues.push({
              checkId,
              citationId: citation.id,
              evidencePosition,
              outcome: evidenceUnit.outcome,
              rationale: evidenceUnit.rationale,
              statementId,
              supportProbability: evidenceUnit.supportProbability,
              turnId,
              unitId: evidenceUnit.unitId,
            });
          }
        }
        await transaction.insert(researchClaimChecks).values(checkValues);
        await transaction
          .insert(researchClaimEvidenceUnits)
          .values(evidenceUnitValues);
        await transaction.insert(researchVerificationJobs).values({
          attemptCount: 0,
          availableAt: normalized.completedAt,
          failureCount: 0,
          state: "pending",
          turnId,
          updatedAt: normalized.completedAt,
        });
      }
      abortSignal.throwIfAborted();
      await transaction
        .update(researchTurns)
        .set({ outputState: "published" })
        .where(eq(researchTurns.id, turnId));
      await transaction
        .update(researchThreads)
        .set({ updatedAt: normalized.completedAt })
        .where(eq(researchThreads.id, normalized.threadId));
      return nextSequence;
    });
    const storedCitations = buildStoredCitations(
      citations,
      turnId,
      normalized.completedAt,
      new Map(),
    );
    const claims = buildStoredClaims(
      normalized.claims,
      claimIds,
      turnId,
      normalized.completedAt,
    );
    return {
      answerDocument: normalized.answerDocument,
      citations: storedCitations,
      claims,
      completedAt: normalized.completedAt.toISOString(),
      id: turnId,
      question: normalized.question,
      reproducibility,
      retrievedContext: [...normalized.retrievedContext],
      retrievalTrace: normalized.retrievalTrace,
      runConfiguration: normalized.runConfiguration,
      runId: normalized.runId,
      scope: normalized.scope,
      sequence,
      threadId: normalized.threadId,
      verificationState: normalized.claims.length > 0
        ? "pending"
        : "not-applicable",
    };
  }

  public async claimNextVerificationJob(
    currentTime: Date,
  ): Promise<ClaimedVerificationJob | null> {
    return this.database.transaction(async (transaction) => {
      const lease = await researchVerificationJobQueue.claim(
        transaction,
        currentTime,
        this.config.claimVerifier.timeoutMs,
      );
      if (lease === null) {
        return null;
      }
      const claims = await this.readVerificationClaims(transaction, lease.id);
      const sources = await this.readVerificationSources(transaction, lease.id);
      return {
        attemptCount: lease.attemptCount,
        claims,
        failureCount: lease.failureCount,
        id: lease.id,
        sources,
      };
    });
  }

  public async completeVerificationJob(
    turnId: string,
    attemptCount: number,
    claims: readonly ClaimVerificationResult[],
    completedAt: Date,
  ): Promise<boolean> {
    const normalizedClaims = z.array(claimVerificationResultSchema).parse(claims);
    return this.database.transaction(async (transaction) => {
      return researchVerificationJobQueue.complete(
        transaction,
        turnId,
        attemptCount,
        completedAt,
        async () => {
          await this.replaceVerificationResults(
            transaction,
            turnId,
            normalizedClaims,
          );
          await transaction.execute(
            sql`SELECT "assert_research_turn_output"(${turnId})`,
          );
        },
      );
    });
  }

  public async settleVerificationFailure(
    turnId: string,
    attemptCount: number,
    error: unknown,
    retryAt: Date | null,
  ): Promise<boolean> {
    return researchVerificationJobQueue.settleFailure(
      this.database,
      turnId,
      attemptCount,
      error,
      retryAt,
    );
  }

  public async releaseVerificationJob(
    turnId: string,
    attemptCount: number,
  ): Promise<boolean> {
    return researchVerificationJobQueue.release(
      this.database,
      turnId,
      attemptCount,
    );
  }

  public async readCitation(id: string): Promise<CitationEvidenceRecord | null> {
    const rows = await this.database
      .select(citationRowSelection)
      .from(citationRecords)
      .innerJoin(
        documentVersions,
        eq(documentVersions.id, citationRecords.documentVersionId),
      )
      .where(eq(citationRecords.id, id))
      .limit(1);
    const rawCitation = rows[0];
    if (rawCitation === undefined) {
      return null;
    }
    const citation = decodeCitationRow(rawCitation);
    const sourceStore = new SourceDocumentStore(this.database);
    const elements = await sourceStore.readMany([citation.elementId]);
    const element = elements[0];
    if (element === undefined) {
      throw new Error(`Citation source element is unavailable: ${citation.elementId}`);
    }
    validateCitationSnapshot(toPublishedCitation(citation), element);
    const staleVersions = await this.readCurrentVersionIds([citation.sourceFile]);
    return {
      citation: toStoredCitation(
        citation,
        staleVersions.get(citation.sourceFile) !== citation.documentVersionId,
      ),
      element,
    };
  }

  public async listDocumentVersions(
    sourceFile: string,
  ): Promise<DocumentVersionRecord[]> {
    const rows = await this.database
      .select({
        createdAt: documentVersions.createdAt,
        documentId: documentVersions.documentId,
        elementCount: documentVersions.totalElements,
        elementSetId: documentVersions.elementSetId,
        fileExtension: documentVersions.fileExtension,
        generationId: documentVersions.generationId,
        id: documentVersions.id,
        mediaType: documentVersions.mediaType,
        pageCount: documentVersions.pageCount,
        sourceFile: documentVersions.sourceFile,
        version: documentVersions.version,
      })
      .from(documentVersions)
      .where(eq(documentVersions.sourceFile, sourceFile))
      .orderBy(desc(documentVersions.version));
    return rows.map(decodeDocumentVersionRecord);
  }

  public async readDocumentVersion(
    id: string,
  ): Promise<DocumentVersionRecord | null> {
    const rows = await this.database
      .select({
        createdAt: documentVersions.createdAt,
        documentId: documentVersions.documentId,
        elementCount: documentVersions.totalElements,
        elementSetId: documentVersions.elementSetId,
        fileExtension: documentVersions.fileExtension,
        generationId: documentVersions.generationId,
        id: documentVersions.id,
        mediaType: documentVersions.mediaType,
        pageCount: documentVersions.pageCount,
        sourceFile: documentVersions.sourceFile,
        version: documentVersions.version,
      })
      .from(documentVersions)
      .where(eq(documentVersions.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : decodeDocumentVersionRecord(row);
  }

  public async readDocumentVersionFile(
    versionId: string,
  ): Promise<BufferedDocumentSource | null> {
    const rows = await this.database
      .select({
        documentId: documentVersions.documentId,
        fileExtension: documentVersions.fileExtension,
        mediaType: documentVersions.mediaType,
        sourceFile: documentVersions.sourceFile,
      })
      .from(documentVersions)
      .where(eq(documentVersions.id, versionId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const format = decodeDocumentFormat({
      extension: row.fileExtension,
      mediaType: row.mediaType,
    });
    const store = new SourceContentStore(
      this.database,
      this.config.sourceContent,
    );
    const stored = await store.readDocument(row.documentId);
    return {
      ...stored,
      extension: format.extension,
      kind: "buffer",
      mediaType: format.mediaType,
      sourceFile: row.sourceFile,
    };
  }

  public async compareDocumentVersions(
    previousVersionId: string,
    currentVersionId: string,
  ): Promise<DocumentVersionDifference | null> {
    const rows = await this.database
      .select({
        elementSetId: documentVersions.elementSetId,
        id: documentVersions.id,
        sourceFile: documentVersions.sourceFile,
      })
      .from(documentVersions)
      .where(inArray(documentVersions.id, [previousVersionId, currentVersionId]));
    const versions = new Map<string, {
      elementSetId: string;
      sourceFile: string;
    }>();
    for (const row of rows) {
      versions.set(row.id, {
        elementSetId: row.elementSetId,
        sourceFile: row.sourceFile,
      });
    }
    const previous = versions.get(previousVersionId);
    const current = versions.get(currentVersionId);
    if (previous === undefined || current === undefined) {
      return null;
    }
    if (previous.sourceFile !== current.sourceFile) {
      throw new Error("Document versions must belong to the same source file.");
    }
    const store = new SourceDocumentStore(this.database);
    const previousElements = await store.readAllElements(previous.elementSetId);
    const currentElements = await store.readAllElements(current.elementSetId);
    return buildDocumentVersionDifference(
      previousVersionId,
      currentVersionId,
      previousElements,
      currentElements,
    );
  }

  public async addFeedback(
    input: ResearchFeedbackInput,
    userId: string,
  ): Promise<ResearchFeedbackSummary> {
    const normalized = decodeResearchFeedbackInput(input);
    await this.validateFeedbackTarget(normalized);
    const id = randomUUID();
    const targetId = normalized.citationId ?? normalized.turnId;
    await this.database.insert(researchFeedback).values({
      citationId: normalized.citationId,
      comment: normalized.comment,
      dimension: normalized.dimension,
      id,
      rating: normalized.rating,
      targetId,
      turnId: normalized.turnId,
      userId,
    }).onConflictDoUpdate({
      set: {
        comment: normalized.comment,
        rating: normalized.rating,
        updatedAt: new Date(),
      },
      target: [
        researchFeedback.userId,
        researchFeedback.dimension,
        researchFeedback.targetId,
      ],
    });
    return this.readFeedbackAggregate(
      normalized.turnId,
      normalized.dimension,
      normalized.citationId,
      userId,
    );
  }

  public async readFeedbackSummary(
    turnId: string,
    dimension: FeedbackDimension,
    citationId: string | null,
    userId: string,
  ): Promise<ResearchFeedbackSummary> {
    await this.validateFeedbackTarget({
      citationId,
      comment: null,
      dimension,
      rating: 1,
      turnId,
    });
    return this.readFeedbackAggregate(turnId, dimension, citationId, userId);
  }

  private async readVerificationClaims(
    transaction: ResearchTransaction,
    turnId: string,
  ): Promise<AnswerClaim[]> {
    const statementRows = await transaction
      .select({
        claim: researchStatements.content,
        claimIndex: researchStatements.statementIndex,
        statementId: researchStatements.id,
      })
      .from(researchClaimChecks)
      .innerJoin(
        researchStatements,
        and(
          eq(researchStatements.id, researchClaimChecks.statementId),
          eq(researchStatements.turnId, researchClaimChecks.turnId),
        ),
      )
      .where(eq(researchClaimChecks.turnId, turnId))
      .orderBy(asc(researchStatements.statementIndex));
    if (statementRows.length === 0) {
      throw new Error(`Research verification job ${turnId} has no claims.`);
    }
    const citationRows = await transaction
      .select({
        citationNumber: citationRecords.citationNumber,
        statementId: researchStatementCitations.statementId,
      })
      .from(researchStatementCitations)
      .innerJoin(
        citationRecords,
        and(
          eq(citationRecords.id, researchStatementCitations.citationId),
          eq(citationRecords.turnId, researchStatementCitations.turnId),
        ),
      )
      .where(eq(researchStatementCitations.turnId, turnId))
      .orderBy(
        asc(researchStatementCitations.statementId),
        asc(researchStatementCitations.citationPosition),
      );
    const citationNumbersByStatement = new Map<string, number[]>();
    for (const row of citationRows) {
      const citationNumbers = citationNumbersByStatement.get(row.statementId)
        ?? [];
      citationNumbers.push(row.citationNumber);
      citationNumbersByStatement.set(row.statementId, citationNumbers);
    }
    const claims: AnswerClaim[] = [];
    for (const row of statementRows) {
      claims.push({
        citationNumbers: citationNumbersByStatement.get(row.statementId) ?? [],
        claim: row.claim,
        claimIndex: row.claimIndex,
      });
    }
    return claims;
  }

  private async readVerificationSources(
    transaction: ResearchTransaction,
    turnId: string,
  ): Promise<ClaimEvidenceSource[]> {
    const rows = await transaction
      .select({
        citationNumber: citationRecords.citationNumber,
        evidence: citationRecords.evidence,
        sectionPath: citationRecords.sectionPath,
      })
      .from(citationRecords)
      .where(eq(citationRecords.turnId, turnId))
      .orderBy(asc(citationRecords.citationNumber));
    const sources: ClaimEvidenceSource[] = [];
    for (const row of rows) {
      sources.push({
        citationNumber: row.citationNumber,
        evidence: row.evidence,
        sectionPath: row.sectionPath,
      });
    }
    return sources;
  }

  private async replaceVerificationResults(
    transaction: ResearchTransaction,
    turnId: string,
    claims: readonly ClaimVerificationResult[],
  ): Promise<void> {
    const expectedClaims = await this.readVerificationClaims(
      transaction,
      turnId,
    );
    const expectedByIndex = new Map<number, AnswerClaim>();
    for (const claim of expectedClaims) {
      expectedByIndex.set(claim.claimIndex, claim);
    }
    if (expectedByIndex.size !== claims.length) {
      throw new Error(
        `Research verification job ${turnId} returned an incomplete claim set.`,
      );
    }
    const checkRows = await transaction
      .select({
        checkId: researchClaimChecks.id,
        claimIndex: researchStatements.statementIndex,
        statementId: researchClaimChecks.statementId,
      })
      .from(researchClaimChecks)
      .innerJoin(
        researchStatements,
        and(
          eq(researchStatements.id, researchClaimChecks.statementId),
          eq(researchStatements.turnId, researchClaimChecks.turnId),
        ),
      )
      .where(eq(researchClaimChecks.turnId, turnId));
    const checksByIndex = new Map<number, {
      checkId: string;
      statementId: string;
    }>();
    for (const row of checkRows) {
      checksByIndex.set(row.claimIndex, {
        checkId: row.checkId,
        statementId: row.statementId,
      });
    }
    const citationRows = await transaction
      .select({
        citationNumber: citationRecords.citationNumber,
        id: citationRecords.id,
      })
      .from(citationRecords)
      .where(eq(citationRecords.turnId, turnId));
    const citationByNumber = new Map<number, string>();
    for (const row of citationRows) {
      citationByNumber.set(row.citationNumber, row.id);
    }
    await transaction
      .delete(researchClaimEvidenceUnits)
      .where(eq(researchClaimEvidenceUnits.turnId, turnId));
    const evidenceUnitValues = [];
    const seenClaimIndexes = new Set<number>();
    for (const claim of claims) {
      const expected = expectedByIndex.get(claim.claimIndex);
      const check = checksByIndex.get(claim.claimIndex);
      if (
        expected === undefined
        || check === undefined
        || seenClaimIndexes.has(claim.claimIndex)
        || expected.claim !== claim.claim
        || !isDeepStrictEqual(expected.citationNumbers, claim.citationNumbers)
      ) {
        throw new Error(
          `Research verification result ${claim.claimIndex} does not match turn ${turnId}.`,
        );
      }
      seenClaimIndexes.add(claim.claimIndex);
      await transaction
        .update(researchClaimChecks)
        .set({
          rationale: claim.rationale,
          status: claim.status,
          verifierModel: claim.verifierModel,
        })
        .where(and(
          eq(researchClaimChecks.id, check.checkId),
          eq(researchClaimChecks.turnId, turnId),
        ));
      for (
        let evidencePosition = 0;
        evidencePosition < claim.evidenceUnits.length;
        evidencePosition += 1
      ) {
        const evidenceUnit = claim.evidenceUnits[evidencePosition];
        const citationId = evidenceUnit === undefined
          ? undefined
          : citationByNumber.get(evidenceUnit.citationNumber);
        if (
          evidenceUnit === undefined
          || citationId === undefined
          || !claim.citationNumbers.includes(evidenceUnit.citationNumber)
        ) {
          throw new Error(
            `Research verification evidence ${evidencePosition} does not match claim ${claim.claimIndex}.`,
          );
        }
        evidenceUnitValues.push({
          checkId: check.checkId,
          citationId,
          evidencePosition,
          outcome: evidenceUnit.outcome,
          rationale: evidenceUnit.rationale,
          statementId: check.statementId,
          supportProbability: evidenceUnit.supportProbability,
          turnId,
          unitId: evidenceUnit.unitId,
        });
      }
    }
    if (evidenceUnitValues.length > 0) {
      await transaction
        .insert(researchClaimEvidenceUnits)
        .values(evidenceUnitValues);
    }
  }

  private async readFeedbackAggregate(
    turnId: string,
    dimension: FeedbackDimension,
    citationId: string | null,
    userId: string,
  ): Promise<ResearchFeedbackSummary> {
    const targetId = citationId ?? turnId;
    const rows = await this.database
      .select({ rating: researchFeedback.rating, userId: researchFeedback.userId })
      .from(researchFeedback)
      .where(and(
        eq(researchFeedback.dimension, dimension),
        eq(researchFeedback.targetId, targetId),
        isNotNull(researchFeedback.userId),
      ));
    let negativeCount = 0;
    let positiveCount = 0;
    let rating: -1 | 0 | 1 = 0;
    for (const row of rows) {
      if (row.rating === 1) {
        positiveCount += 1;
      } else if (row.rating === -1) {
        negativeCount += 1;
      }
      if (row.userId === userId && (row.rating === 1 || row.rating === -1)) {
        rating = row.rating;
      }
    }
    return { negativeCount, positiveCount, rating };
  }

  public async exportThread(
    id: string,
    format: ResearchExportFormat,
  ): Promise<ResearchExport | null> {
    const thread = await this.readThread(id);
    if (thread === null) {
      return null;
    }
    if (format === "json") {
      return {
        content: `${JSON.stringify(thread, null, 2)}\n`,
        filename: `citeloom-thread-${thread.id}.json`,
        mediaType: "application/json; charset=utf-8",
      };
    }
    const content = format === "citations"
      ? buildCitationReport(thread)
      : buildMarkdownExport(thread);
    const suffix = format === "citations" ? "citations" : "research";
    return {
      content,
      filename: `citeloom-thread-${thread.id}-${suffix}.md`,
      mediaType: "text/markdown; charset=utf-8",
    };
  }

  private async decodeTurns(rawTurns: unknown[]): Promise<ResearchTurn[]> {
    if (rawTurns.length === 0) {
      return [];
    }
    const turns = rawTurns.map(decodeTurnRow);
    const turnIds = turns.map((turn) => turn.id);
    const [
      rawCitations,
      rawStatements,
      rawStatementCitations,
      rawClaimChecks,
      rawClaimEvidenceUnits,
      rawVerificationJobs,
    ] = await Promise.all([
      this.database
        .select(citationRowSelection)
        .from(citationRecords)
        .innerJoin(
          documentVersions,
          eq(documentVersions.id, citationRecords.documentVersionId),
        )
        .where(inArray(citationRecords.turnId, turnIds))
        .orderBy(asc(citationRecords.citationNumber)),
      this.database
        .select()
        .from(researchStatements)
        .where(inArray(researchStatements.turnId, turnIds))
        .orderBy(asc(researchStatements.statementIndex)),
      this.database
        .select()
        .from(researchStatementCitations)
        .where(inArray(researchStatementCitations.turnId, turnIds))
        .orderBy(
          asc(researchStatementCitations.statementId),
          asc(researchStatementCitations.citationPosition),
        ),
      this.database
        .select()
        .from(researchClaimChecks)
        .where(inArray(researchClaimChecks.turnId, turnIds)),
      this.database
        .select()
        .from(researchClaimEvidenceUnits)
        .where(inArray(researchClaimEvidenceUnits.turnId, turnIds))
        .orderBy(
          asc(researchClaimEvidenceUnits.checkId),
          asc(researchClaimEvidenceUnits.evidencePosition),
        ),
      this.database
        .select({
          state: researchVerificationJobs.state,
          turnId: researchVerificationJobs.turnId,
        })
        .from(researchVerificationJobs)
        .where(inArray(researchVerificationJobs.turnId, turnIds)),
    ]);
    const decodedCitations = rawCitations.map(decodeCitationRow);
    const decodedStatements = rawStatements.map(decodeStatementRow);
    const decodedStatementCitations = rawStatementCitations.map(
      decodeStatementCitationRow,
    );
    const decodedClaimChecks = rawClaimChecks.map(decodeClaimCheckRow);
    const decodedClaimEvidenceUnits = rawClaimEvidenceUnits.map(
      decodeClaimEvidenceUnitRow,
    );
    const citationsByTurn = groupCitations(decodedCitations);
    const statementsByTurn = groupStatements(decodedStatements);
    const statementCitationsByTurn = groupStatementCitations(
      decodedStatementCitations,
    );
    const claimChecksByTurn = groupClaimChecks(decodedClaimChecks);
    const claimEvidenceUnitsByTurn = groupClaimEvidenceUnits(
      decodedClaimEvidenceUnits,
    );
    const verificationStateByTurn = new Map<
      string,
      z.infer<typeof verificationJobStateSchema>
    >();
    for (const row of rawVerificationJobs) {
      verificationStateByTurn.set(
        row.turnId,
        verificationJobStateSchema.parse(row.state),
      );
    }
    const sourceFiles = new Set<string>();
    for (const citation of decodedCitations) {
      sourceFiles.add(citation.sourceFile);
    }
    const currentVersions = await this.readCurrentVersionIds([...sourceFiles]);
    const results: ResearchTurn[] = [];
    for (const turn of turns) {
      const rawTurnCitations = citationsByTurn.get(turn.id) ?? [];
      const citations: StoredCitationRecord[] = [];
      for (const citation of rawTurnCitations) {
        const stale = currentVersions.get(citation.sourceFile)
          !== citation.documentVersionId;
        citations.push(toStoredCitation(citation, stale));
      }
      const output = buildPersistedTurnOutput(
        turn,
        rawTurnCitations,
        statementsByTurn.get(turn.id) ?? [],
        statementCitationsByTurn.get(turn.id) ?? [],
        claimChecksByTurn.get(turn.id) ?? [],
        claimEvidenceUnitsByTurn.get(turn.id) ?? [],
      );
      const reproducibility = await this.readReproducibility(
        turn.runConfiguration,
        citations.map((citation) => citation.elementId),
      );
      results.push({
        answerDocument: output.answerDocument,
        citations,
        claims: output.claims,
        completedAt: turn.completedAt.toISOString(),
        id: turn.id,
        question: turn.question,
        reproducibility,
        retrievedContext: turn.retrievedContext,
        retrievalTrace: turn.retrievalTrace,
        runConfiguration: turn.runConfiguration,
        runId: turn.runId,
        scope: turn.scope,
        sequence: turn.sequence,
        threadId: turn.threadId,
        verificationState: verificationStateByTurn.get(turn.id)
          ?? (output.claims.length > 0 ? "completed" : "not-applicable"),
      });
    }
    return results;
  }

  private async readCurrentVersionIds(
    sourceFiles: string[],
  ): Promise<Map<string, string>> {
    const versions = new Map<string, string>();
    if (sourceFiles.length === 0) {
      return versions;
    }
    const rows = await this.database
      .select({
        sourceFile: indexedDocuments.sourceFile,
        versionId: indexedDocuments.versionId,
      })
      .from(indexedDocuments)
      .where(inArray(indexedDocuments.sourceFile, sourceFiles));
    for (const row of rows) {
      versions.set(row.sourceFile, row.versionId);
    }
    return versions;
  }

  private async readReproducibility(
    runConfiguration: ResearchRunConfiguration,
    elementIds: string[],
  ): Promise<ResearchReproducibility> {
    const unavailableDependencies: string[] = [];
    const spaceRows = await this.database
      .select({ id: embeddingSpaces.id })
      .from(embeddingSpaces)
      .where(eq(embeddingSpaces.id, runConfiguration.embeddingSpaceId))
      .limit(1);
    if (spaceRows[0] === undefined) {
      unavailableDependencies.push(
        `embedding space ${runConfiguration.embeddingSpaceId}`,
      );
    }
    if (elementIds.length > 0) {
      const elementRows = await this.database
        .select({ id: sourceElements.id })
        .from(sourceElements)
        .where(inArray(sourceElements.id, elementIds));
      const availableIds = new Set(elementRows.map((row) => row.id));
      for (const elementId of elementIds) {
        if (!availableIds.has(elementId)) {
          unavailableDependencies.push(`source element ${elementId}`);
        }
      }
    }
    const configuredModels = buildConfiguredModelIdentities(this.config);
    for (const [role, storedModel] of Object.entries(runConfiguration.models)) {
      const configuredModel = configuredModels[role as keyof typeof configuredModels];
      if (storedModel !== configuredModel) {
        unavailableDependencies.push(`${role} model ${storedModel ?? "none"}`);
      }
    }
    return {
      available: unavailableDependencies.length === 0,
      unavailableDependencies,
    };
  }

  private async validateCitationAnchors(
    citations: readonly PublishedAnswerCitation[],
  ): Promise<Map<string, string>> {
    const elementSetIds = new Map<string, string>();
    if (citations.length === 0) {
      return elementSetIds;
    }
    const elementIds = [...new Set(citations.map((citation) => {
      return citation.elementId;
    }))];
    const anchorConditions = citations.map((citation) => {
      return and(
        eq(documentVersions.id, citation.documentVersionId),
        eq(documentElementSetMembers.elementId, citation.elementId),
      );
    });
    const rows = await this.database
      .select({
        documentId: documentVersions.documentId,
        elementId: documentElementSetMembers.elementId,
        elementSetId: documentVersions.elementSetId,
        id: documentVersions.id,
        sourceFile: documentVersions.sourceFile,
      })
      .from(documentVersions)
      .innerJoin(
        documentElementSetMembers,
        eq(
          documentElementSetMembers.setId,
          documentVersions.elementSetId,
        ),
      )
      .where(or(...anchorConditions));
    const anchors = new Map(rows.map((row) => {
      return [createCitationAnchorKey(row.id, row.elementId), row];
    }));
    for (const citation of citations) {
      const anchor = anchors.get(createCitationAnchorKey(
        citation.documentVersionId,
        citation.elementId,
      ));
      if (
        anchor === undefined
        || anchor.documentId !== citation.documentId
        || anchor.sourceFile !== citation.sourceFile
      ) {
        throw new Error(
          `Citation ${citation.citationNumber} does not belong to document version ${citation.documentVersionId}.`,
        );
      }
      elementSetIds.set(citation.id, anchor.elementSetId);
    }
    const sourceStore = new SourceDocumentStore(this.database);
    const elements = await sourceStore.readMany(elementIds);
    const elementsById = new Map(elements.map((element) => {
      return [element.id, element];
    }));
    for (const citation of citations) {
      const element = elementsById.get(citation.elementId);
      if (element === undefined) {
        throw new Error(`Citation source element is unavailable: ${citation.elementId}`);
      }
      validateCitationSnapshot(citation, element);
    }
    return elementSetIds;
  }

  private async validateFeedbackTarget(
    input: ResearchFeedbackInput,
  ): Promise<void> {
    const turnRows = await this.database
      .select({ id: researchTurns.id })
      .from(researchTurns)
      .where(eq(researchTurns.id, input.turnId))
      .limit(1);
    if (turnRows[0] === undefined) {
      throw new ResearchRecordNotFoundError(
        `Research turn was not found: ${input.turnId}`,
      );
    }
    if (input.dimension === "citation-correctness" && input.citationId === null) {
      throw new ResearchInputConflictError(
        "Citation correctness feedback requires a citation.",
      );
    }
    if (input.citationId === null) {
      return;
    }
    const citationRows = await this.database
      .select({ id: citationRecords.id })
      .from(citationRecords)
      .where(and(
        eq(citationRecords.id, input.citationId),
        eq(citationRecords.turnId, input.turnId),
      ))
      .limit(1);
    if (citationRows[0] === undefined) {
      throw new ResearchInputConflictError(
        "Feedback citation does not belong to the selected turn.",
      );
    }
  }
}

export function buildResearchRunConfiguration(
  config: AppConfig,
): ResearchRunConfiguration {
  const reranker = config.retrieval.reranker;
  return {
    embeddingSpaceId: config.embeddingSpace.id,
    models: {
      answer: config.inference.answer.model,
      embedding: config.inference.embedding.model,
      reranker: reranker?.model ?? null,
      verifier: config.claimVerifier.model,
    },
    retrieval: {
      answerTemperature: config.retrieval.answerTemperature,
      answerMinimumRerankerScore: null,
      candidateK: config.retrieval.candidateK,
      fusion: { ...config.retrieval.fusion },
      mode: config.retrieval.mode,
      queryExpansions: config.retrieval.queryExpansions,
      queryExpansionTemperature: config.retrieval.queryExpansionTemperature,
      rrfK: config.retrieval.rrfK,
      tocRoutingEnabled: config.docling.tocEnabled,
      topK: config.retrieval.topK,
    },
    settingsVersion: config.settingsVersion,
  };
}

function decodeSaveResearchTurnInput(input: SaveResearchTurnInput): SaveResearchTurnInput {
  const schema = z.object({
    answerDocument: publishedAnswerDocumentSchema,
    claims: z.array(claimVerificationResultSchema),
    completedAt: z.date(),
    question: z.string().trim().min(1),
    retrievedContext: z.array(z.object({
      documentId: contentIdSchema,
      retrievedElementCount: z.number().int().positive(),
      sourceFile: z.string().trim().min(1),
    }).strict()),
    retrievalTrace: storedRetrievalTraceSchema,
    runConfiguration: runConfigurationSchema,
    runId: z.uuid(),
    scope: queryScopeSchema,
    threadId: z.uuid(),
  }).strict();
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid research turn: ${result.error.message}`);
  }
  const answerDocument = normalizePublishedAnswerDocument(
    result.data.answerDocument,
  );
  validateTurnCollections(
    answerDocument,
    result.data.claims,
  );
  const claims = [...result.data.claims];
  claims.sort((left, right) => {
    return left.claimIndex - right.claimIndex;
  });
  return {
    ...result.data,
    answerDocument,
    claims,
  };
}

function normalizePublishedAnswerDocument(
  document: PublishedAnswerDocument,
): PublishedAnswerDocument {
  if (isPublishedUncitedAnswerDocument(document)) {
    return document;
  }
  const citations = [...document.citations];
  citations.sort((left, right) => {
    return left.citationNumber - right.citationNumber;
  });
  return {
    ...document,
    citations,
  };
}

function validateTurnCollections(
  answerDocument: PublishedAnswerDocument,
  claims: readonly ClaimVerificationResult[],
): void {
  const citations = answerDocument.citations;
  const citationNumbers = new Set<number>();
  const citationIds = new Set<string>();
  for (let index = 0; index < citations.length; index += 1) {
    const citation = citations[index];
    if (citation === undefined || citation.citationNumber !== index + 1) {
      throw new Error("Published citation numbers must be contiguous.");
    }
    if (citationNumbers.has(citation.citationNumber)) {
      throw new Error(`Citation number appears twice: ${citation.citationNumber}.`);
    }
    if (citationIds.has(citation.id)) {
      throw new Error(`Citation id appears twice: ${citation.id}.`);
    }
    citationNumbers.add(citation.citationNumber);
    citationIds.add(citation.id);
  }
  const claimIndexes = new Set<number>();
  const expectedClaims = readPublishedAnswerClaims(answerDocument);
  if (claims.length !== expectedClaims.length) {
    throw new Error("Claim checks do not match the published answer statements.");
  }
  for (const claim of claims) {
    if (claimIndexes.has(claim.claimIndex)) {
      throw new Error(`Claim index appears twice: ${claim.claimIndex}.`);
    }
    for (const citationNumber of claim.citationNumbers) {
      if (!citationNumbers.has(citationNumber)) {
        throw new Error(
          `Claim ${claim.claimIndex} references missing citation ${citationNumber}.`,
        );
      }
    }
    validateVerificationEvidence(claim, "Claim");
    const expectedClaim = expectedClaims[claim.claimIndex];
    if (
      expectedClaim === undefined
      || expectedClaim.claim !== claim.claim
      || !isDeepStrictEqual(expectedClaim.citationNumbers, claim.citationNumbers)
    ) {
      throw new Error(`Claim ${claim.claimIndex} does not match its published statement.`);
    }
    claimIndexes.add(claim.claimIndex);
  }
}

function validateVerificationEvidence(
  verification: ClaimVerificationResult,
  label: "Claim",
): void {
  if (verification.evidenceUnits.length !== verification.citationNumbers.length) {
    throw new Error(
      `${label} ${verification.claimIndex} verification evidence does not match its citations.`,
    );
  }
  for (
    let evidenceIndex = 0;
    evidenceIndex < verification.evidenceUnits.length;
    evidenceIndex += 1
  ) {
    const evidenceUnit = verification.evidenceUnits[evidenceIndex];
    const citationNumber = verification.citationNumbers[evidenceIndex];
    if (
      evidenceUnit === undefined
      || citationNumber === undefined
      || evidenceUnit.citationNumber !== citationNumber
    ) {
      throw new Error(
        `${label} ${verification.claimIndex} verification evidence is out of order.`,
      );
    }
  }
}

function decodeResearchFeedbackInput(
  input: ResearchFeedbackInput,
): ResearchFeedbackInput {
  const result = z.object({
    citationId: z.uuid().nullable(),
    comment: z.string().trim().min(1).max(4_000).nullable(),
    dimension: z.enum([
      "answer-usefulness",
      "citation-correctness",
      "retrieval-relevance",
    ]),
    rating: z.union([z.literal(-1), z.literal(1)]),
    turnId: z.uuid(),
  }).strict().safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid research feedback: ${result.error.message}`);
  }
  return result.data;
}

function decodeResearchThreadTitle(title: string): string {
  const result = z.string().trim().min(1).max(500).safeParse(title);
  if (!result.success) {
    throw new Error(`Invalid research thread title: ${result.error.message}`);
  }
  return result.data;
}

function decodeThreadRow(value: unknown): z.output<typeof threadRowSchema> {
  const result = threadRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid research thread row: ${result.error.message}`);
  }
  return result.data;
}

function decodeTurnRow(value: unknown): z.output<typeof turnRowSchema> {
  const result = turnRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid research turn row: ${result.error.message}`);
  }
  return result.data;
}

function decodeCitationRow(value: unknown): z.output<typeof citationRowSchema> {
  const result = citationRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid citation row: ${result.error.message}`);
  }
  return result.data;
}

function decodeStatementRow(value: unknown): z.output<typeof statementRowSchema> {
  const result = statementRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid research statement row: ${result.error.message}`);
  }
  return result.data;
}

function decodeStatementCitationRow(
  value: unknown,
): z.output<typeof statementCitationRowSchema> {
  const result = statementCitationRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid statement citation row: ${result.error.message}`);
  }
  return result.data;
}

function decodeClaimCheckRow(
  value: unknown,
): z.output<typeof claimCheckRowSchema> {
  const result = claimCheckRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid claim check row: ${result.error.message}`);
  }
  return result.data;
}

function decodeClaimEvidenceUnitRow(
  value: unknown,
): z.output<typeof claimEvidenceUnitRowSchema> {
  const result = claimEvidenceUnitRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid claim evidence unit row: ${result.error.message}`);
  }
  return result.data;
}

function decodeDocumentVersionRecord(value: unknown): DocumentVersionRecord {
  const result = documentVersionRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid document version row: ${result.error.message}`);
  }
  const format = decodeDocumentFormat({
    extension: result.data.fileExtension,
    mediaType: result.data.mediaType,
  });
  return {
    createdAt: result.data.createdAt.toISOString(),
    documentId: result.data.documentId,
    elementCount: result.data.elementCount,
    elementSetId: result.data.elementSetId,
    format,
    generationId: result.data.generationId,
    id: result.data.id,
    pageCount: result.data.pageCount,
    sourceFile: result.data.sourceFile,
    version: result.data.version,
  };
}

function groupCitations(
  citations: Array<z.output<typeof citationRowSchema>>,
): Map<string, Array<z.output<typeof citationRowSchema>>> {
  const grouped = new Map<string, Array<z.output<typeof citationRowSchema>>>();
  for (const citation of citations) {
    const current = grouped.get(citation.turnId) ?? [];
    current.push(citation);
    grouped.set(citation.turnId, current);
  }
  return grouped;
}

function groupStatements(
  statements: Array<z.output<typeof statementRowSchema>>,
): Map<string, Array<z.output<typeof statementRowSchema>>> {
  const grouped = new Map<string, Array<z.output<typeof statementRowSchema>>>();
  for (const statement of statements) {
    const current = grouped.get(statement.turnId) ?? [];
    current.push(statement);
    grouped.set(statement.turnId, current);
  }
  return grouped;
}

function groupStatementCitations(
  citations: Array<z.output<typeof statementCitationRowSchema>>,
): Map<string, Array<z.output<typeof statementCitationRowSchema>>> {
  const grouped = new Map<
    string,
    Array<z.output<typeof statementCitationRowSchema>>
  >();
  for (const citation of citations) {
    const current = grouped.get(citation.turnId) ?? [];
    current.push(citation);
    grouped.set(citation.turnId, current);
  }
  return grouped;
}

function groupClaimChecks(
  checks: Array<z.output<typeof claimCheckRowSchema>>,
): Map<string, Array<z.output<typeof claimCheckRowSchema>>> {
  const grouped = new Map<
    string,
    Array<z.output<typeof claimCheckRowSchema>>
  >();
  for (const check of checks) {
    const current = grouped.get(check.turnId) ?? [];
    current.push(check);
    grouped.set(check.turnId, current);
  }
  return grouped;
}

function groupClaimEvidenceUnits(
  evidenceUnits: Array<z.output<typeof claimEvidenceUnitRowSchema>>,
): Map<string, Array<z.output<typeof claimEvidenceUnitRowSchema>>> {
  const grouped = new Map<
    string,
    Array<z.output<typeof claimEvidenceUnitRowSchema>>
  >();
  for (const evidenceUnit of evidenceUnits) {
    const current = grouped.get(evidenceUnit.turnId) ?? [];
    current.push(evidenceUnit);
    grouped.set(evidenceUnit.turnId, current);
  }
  return grouped;
}

function toStoredCitation(
  citation: z.output<typeof citationRowSchema>,
  stale: boolean,
): StoredCitationRecord {
  return {
    citationNumber: citation.citationNumber,
    createdAt: citation.createdAt.toISOString(),
    documentId: citation.documentId,
    documentVersionId: citation.documentVersionId,
    elementId: citation.elementId,
    evidence: citation.evidence,
    id: citation.id,
    pageNumbers: citation.pageNumbers,
    regions: citation.regions,
    sectionPath: citation.sectionPath,
    sourceFile: citation.sourceFile,
    stale,
    turnId: citation.turnId,
  };
}

function toPublishedCitation(
  citation: z.output<typeof citationRowSchema>,
): PublishedAnswerCitation {
  return {
    citationNumber: citation.citationNumber,
    documentId: citation.documentId,
    documentVersionId: citation.documentVersionId,
    elementId: citation.elementId,
    evidence: citation.evidence,
    id: citation.id,
    kind: citation.evidence.kind,
    pageNumbers: citation.pageNumbers,
    regions: citation.regions,
    sectionPath: citation.sectionPath,
    sourceFile: citation.sourceFile,
  };
}

function buildPersistedTurnOutput(
  turn: z.output<typeof turnRowSchema>,
  citationRows: readonly z.output<typeof citationRowSchema>[],
  statementRows: readonly z.output<typeof statementRowSchema>[],
  statementCitationRows: readonly z.output<typeof statementCitationRowSchema>[],
  claimCheckRows: readonly z.output<typeof claimCheckRowSchema>[],
  claimEvidenceUnitRows: readonly z.output<typeof claimEvidenceUnitRowSchema>[],
): {
  answerDocument: PublishedAnswerDocument;
  claims: StoredClaimCheck[];
} {
  const citationById = new Map<string, z.output<typeof citationRowSchema>>();
  for (let index = 0; index < citationRows.length; index += 1) {
    const citation = citationRows[index];
    if (citation === undefined || citation.citationNumber !== index + 1) {
      throw new Error(`Turn ${turn.id} has non-contiguous citation numbers.`);
    }
    citationById.set(citation.id, citation);
  }
  const linksByStatement = new Map<
    string,
    Array<z.output<typeof statementCitationRowSchema>>
  >();
  for (const link of statementCitationRows) {
    const current = linksByStatement.get(link.statementId) ?? [];
    current.push(link);
    linksByStatement.set(link.statementId, current);
  }
  const publishedStatements = buildPersistedStatements(
    turn.id,
    statementRows,
    linksByStatement,
    citationById,
  );
  const publishedCitations: PublishedAnswerCitation[] = [];
  for (const citationRow of citationRows) {
    const citation = toPublishedCitation(citationRow);
    if (citation.citationNumber !== publishedCitations.length + 1) {
      throw new Error(`Turn ${turn.id} has non-contiguous published citations.`);
    }
    publishedCitations.push(citation);
  }
  let answerDocument: PublishedAnswerDocument;
  if (publishedCitations.length === 0) {
    if (publishedStatements.length > 0) {
      throw new Error(`Uncited turn ${turn.id} contains cited findings.`);
    }
    if (turn.answerContent === null) {
      throw new Error(`Uncited turn ${turn.id} has no answer content.`);
    }
    answerDocument = decodePublishedAnswerDocument({
      citations: [],
      content: turn.answerContent,
      schemaVersion: turn.answerSchemaVersion,
      statements: [],
    });
  } else {
    if (turn.answerContent === null) {
      throw new Error(`Cited turn ${turn.id} has no answer content.`);
    }
    answerDocument = decodePublishedAnswerDocument({
      citations: publishedCitations,
      content: turn.answerContent,
      schemaVersion: turn.answerSchemaVersion,
      statements: publishedStatements,
    });
  }
  const claims = buildPersistedClaimChecks(
    turn.id,
    statementRows,
    linksByStatement,
    claimCheckRows,
    claimEvidenceUnitRows,
    citationById,
  );
  validateTurnCollections(answerDocument, claims);
  return {
    answerDocument,
    claims,
  };
}

function buildPersistedStatements(
  turnId: string,
  rows: readonly z.output<typeof statementRowSchema>[],
  linksByStatement: ReadonlyMap<
    string,
    Array<z.output<typeof statementCitationRowSchema>>
  >,
  citationById: ReadonlyMap<string, z.output<typeof citationRowSchema>>,
): PublishedAnswerStatement[] {
  const statements: PublishedAnswerStatement[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const statement = rows[index];
    if (statement === undefined || statement.statementIndex !== index) {
      throw new Error(`Turn ${turnId} has non-contiguous statement indexes.`);
    }
    const links = linksByStatement.get(statement.id) ?? [];
    if (links.length === 0) {
      throw new Error(`Statement ${statement.id} has no citations.`);
    }
    const citationIds: string[] = [];
    for (let citationPosition = 0; citationPosition < links.length; citationPosition += 1) {
      const link = links[citationPosition];
      if (link === undefined || link.citationPosition !== citationPosition) {
        throw new Error(`Statement ${statement.id} has non-contiguous citation positions.`);
      }
      const citation = citationById.get(link.citationId);
      if (citation === undefined) {
        throw new Error(
          `Statement ${statement.id} references missing citation ${link.citationId}.`,
        );
      }
      citationIds.push(citation.id);
    }
    statements.push({
      citationIds,
      content: statement.content,
      presentation: statement.presentation,
      section: statement.section,
    });
  }
  return statements;
}

function buildPersistedClaimChecks(
  turnId: string,
  statementRows: readonly z.output<typeof statementRowSchema>[],
  linksByStatement: ReadonlyMap<
    string,
    Array<z.output<typeof statementCitationRowSchema>>
  >,
  checkRows: readonly z.output<typeof claimCheckRowSchema>[],
  evidenceUnitRows: readonly z.output<typeof claimEvidenceUnitRowSchema>[],
  citationById: ReadonlyMap<string, z.output<typeof citationRowSchema>>,
): StoredClaimCheck[] {
  const statementById = new Map<string, z.output<typeof statementRowSchema>>();
  for (const statement of statementRows) {
    statementById.set(statement.id, statement);
  }
  const evidenceUnitsByCheck = new Map<
    string,
    Array<z.output<typeof claimEvidenceUnitRowSchema>>
  >();
  for (const evidenceUnit of evidenceUnitRows) {
    const current = evidenceUnitsByCheck.get(evidenceUnit.checkId) ?? [];
    current.push(evidenceUnit);
    evidenceUnitsByCheck.set(evidenceUnit.checkId, current);
  }
  const orderedChecks = [...checkRows];
  orderedChecks.sort((left, right) => {
    const leftStatement = statementById.get(left.statementId);
    const rightStatement = statementById.get(right.statementId);
    if (leftStatement === undefined || rightStatement === undefined) {
      throw new Error(`Turn ${turnId} contains a check for a missing statement.`);
    }
    return leftStatement.statementIndex - rightStatement.statementIndex;
  });
  const claims: StoredClaimCheck[] = [];
  for (const check of orderedChecks) {
    const statement = statementById.get(check.statementId);
    if (statement === undefined) {
      throw new Error(`Claim check ${check.id} references a missing statement.`);
    }
    const statementLinks = linksByStatement.get(statement.id) ?? [];
    const evidenceUnitRowsForCheck = evidenceUnitsByCheck.get(check.id) ?? [];
    if (statementLinks.length !== evidenceUnitRowsForCheck.length) {
      throw new Error(
        `Claim check ${check.id} does not cover every statement citation.`,
      );
    }
    const citationNumbers: number[] = [];
    const evidenceUnits: ClaimVerificationResult["evidenceUnits"] = [];
    for (
      let evidencePosition = 0;
      evidencePosition < evidenceUnitRowsForCheck.length;
      evidencePosition += 1
    ) {
      const evidenceUnit = evidenceUnitRowsForCheck[evidencePosition];
      const statementLink = statementLinks[evidencePosition];
      if (
        evidenceUnit === undefined
        || evidenceUnit.evidencePosition !== evidencePosition
        || statementLink === undefined
        || evidenceUnit.citationId !== statementLink.citationId
      ) {
        throw new Error(
          `Claim check ${check.id} has invalid evidence position ${evidencePosition}.`,
        );
      }
      const citation = citationById.get(evidenceUnit.citationId);
      if (citation === undefined) {
        throw new Error(
          `Claim check ${check.id} references missing citation ${evidenceUnit.citationId}.`,
        );
      }
      citationNumbers.push(citation.citationNumber);
      evidenceUnits.push({
        citationNumber: citation.citationNumber,
        outcome: evidenceUnit.outcome,
        rationale: evidenceUnit.rationale,
        supportProbability: evidenceUnit.supportProbability,
        unitId: evidenceUnit.unitId,
      });
    }
    claims.push({
      citationNumbers,
      claim: statement.content,
      claimIndex: statement.statementIndex,
      createdAt: check.createdAt.toISOString(),
      evidenceUnits,
      id: check.id,
      rationale: check.rationale,
      status: check.status,
      turnId: check.turnId,
      verifierModel: check.verifierModel,
    });
  }
  return claims;
}

function buildStoredCitations(
  citations: readonly PublishedAnswerCitation[],
  turnId: string,
  createdAt: Date,
  currentVersions: Map<string, string>,
): StoredCitationRecord[] {
  const records: StoredCitationRecord[] = [];
  for (const citation of citations) {
    records.push({
      citationNumber: citation.citationNumber,
      createdAt: createdAt.toISOString(),
      documentId: citation.documentId,
      documentVersionId: citation.documentVersionId,
      elementId: citation.elementId,
      evidence: citation.evidence,
      id: citation.id,
      pageNumbers: citation.pageNumbers,
      regions: citation.regions,
      sectionPath: citation.sectionPath,
      sourceFile: citation.sourceFile,
      stale: currentVersions.get(citation.sourceFile) !== undefined
        && currentVersions.get(citation.sourceFile) !== citation.documentVersionId,
      turnId,
    });
  }
  return records;
}

function buildStoredClaims(
  claims: readonly ClaimVerificationResult[],
  claimIds: readonly string[],
  turnId: string,
  createdAt: Date,
): StoredClaimCheck[] {
  const records: StoredClaimCheck[] = [];
  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index];
    const id = claimIds[index];
    if (claim === undefined || id === undefined) {
      throw new Error(`Missing persisted claim at index ${index}.`);
    }
    records.push({
      citationNumbers: claim.citationNumbers,
      claim: claim.claim,
      claimIndex: claim.claimIndex,
      createdAt: createdAt.toISOString(),
      id,
      evidenceUnits: claim.evidenceUnits,
      rationale: claim.rationale,
      status: claim.status,
      turnId,
      verifierModel: claim.verifierModel,
    });
  }
  return records;
}

function buildConfiguredModelIdentities(config: AppConfig): {
  answer: string;
  embedding: string;
  reranker: string | null;
  verifier: string;
} {
  return {
    answer: config.inference.answer.model,
    embedding: config.inference.embedding.model,
    reranker: config.retrieval.reranker?.model ?? null,
    verifier: config.claimVerifier.model,
  };
}

function buildDocumentVersionDifference(
  previousVersionId: string,
  currentVersionId: string,
  previousElements: SourceElement[],
  currentElements: SourceElement[],
): DocumentVersionDifference {
  const previousIds = new Set(previousElements.map((element) => element.id));
  const currentIds = new Set(currentElements.map((element) => element.id));
  const previousRemaining = previousElements.filter((element) => {
    return !currentIds.has(element.id);
  });
  const currentRemaining = currentElements.filter((element) => {
    return !previousIds.has(element.id);
  });
  const previousByLocator = createUniqueElementLocatorMap(previousRemaining);
  const matchedPrevious = new Set<string>();
  const matchedCurrent = new Set<string>();
  const modified: DocumentVersionDifference["modified"] = [];
  for (const current of currentRemaining) {
    const previous = previousByLocator.get(createElementLocator(current));
    if (previous === undefined) {
      continue;
    }
    matchedPrevious.add(previous.id);
    matchedCurrent.add(current.id);
    modified.push({
      currentElementId: current.id,
      previousElementId: previous.id,
    });
  }
  const addedElementIds = currentRemaining
    .filter((element) => !matchedCurrent.has(element.id))
    .map((element) => element.id);
  const removedElementIds = previousRemaining
    .filter((element) => !matchedPrevious.has(element.id))
    .map((element) => element.id);
  return {
    addedElementIds,
    currentVersionId,
    modified,
    previousVersionId,
    removedElementIds,
  };
}

function createUniqueElementLocatorMap(
  elements: SourceElement[],
): Map<string, SourceElement> {
  const result = new Map<string, SourceElement>();
  const duplicates = new Set<string>();
  for (const element of elements) {
    const locator = createElementLocator(element);
    if (result.has(locator)) {
      result.delete(locator);
      duplicates.add(locator);
      continue;
    }
    if (!duplicates.has(locator)) {
      result.set(locator, element);
    }
  }
  return result;
}

function createElementLocator(element: SourceElement): string {
  return JSON.stringify({
    kind: element.kind,
    pageNumbers: element.pageNumbers,
    sectionPath: element.sectionPath,
    sourceRefs: element.sourceRefs,
  });
}

function buildMarkdownExport(thread: ResearchThread): string {
  const lines = [
    `# ${thread.title}`,
    "",
    `Thread ID: \`${thread.id}\`  `,
    `Created: ${thread.createdAt}  `,
    `Updated: ${thread.updatedAt}`,
    "",
  ];
  for (const turn of thread.turns) {
    lines.push(`## Turn ${turn.sequence}`, "");
    lines.push(`Question: ${turn.question}`, "");
    lines.push(renderPublishedAnswerMarkdown(turn.answerDocument), "");
    lines.push(`Run ID: \`${turn.runId}\`  `);
    lines.push(`Completed: ${turn.completedAt}  `);
    lines.push(`Settings version: ${turn.runConfiguration.settingsVersion}  `);
    lines.push(`Embedding space: \`${turn.runConfiguration.embeddingSpaceId}\`  `);
    lines.push(`Answer model: \`${turn.runConfiguration.models.answer}\`  `);
    lines.push(`Embedding model: \`${turn.runConfiguration.models.embedding}\`  `);
    lines.push(`Verifier model: \`${turn.runConfiguration.models.verifier}\`  `);
    lines.push(`Reranker model: \`${turn.runConfiguration.models.reranker ?? "none"}\``);
    lines.push("");
    lines.push("### Retrieved context", "");
    if (turn.retrievedContext.length === 0) {
      lines.push("No retrieved document context.", "");
    } else {
      for (const document of turn.retrievedContext) {
        lines.push(
          `- ${document.sourceFile} (document \`${document.documentId}\`, ${document.retrievedElementCount} elements)`,
        );
      }
      lines.push("");
    }
    lines.push("");
    lines.push("### Cited evidence", "");
    for (const citation of turn.citations) {
      lines.push(formatCitationMarkdown(citation), "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function buildCitationReport(thread: ResearchThread): string {
  const lines = [`# Citation report: ${thread.title}`, ""];
  for (const turn of thread.turns) {
    lines.push(`## Turn ${turn.sequence}: ${turn.question}`, "");
    lines.push(`Run ID: \`${turn.runId}\`  `);
    lines.push(`Completed: ${turn.completedAt}  `);
    lines.push(`Settings version: ${turn.runConfiguration.settingsVersion}  `);
    lines.push(`Embedding space: \`${turn.runConfiguration.embeddingSpaceId}\`  `);
    lines.push(`Answer model: \`${turn.runConfiguration.models.answer}\`  `);
    lines.push(`Embedding model: \`${turn.runConfiguration.models.embedding}\`  `);
    lines.push(`Verifier model: \`${turn.runConfiguration.models.verifier}\`  `);
    lines.push(`Reranker model: \`${turn.runConfiguration.models.reranker ?? "none"}\``, "");
    for (const claim of turn.claims) {
      lines.push(
        `- Claim ${claim.claimIndex + 1} (${claim.status}): ${claim.claim}`,
        `  Rationale: ${claim.rationale}`,
      );
    }
    lines.push("");
    for (const citation of turn.citations) {
      lines.push(formatCitationMarkdown(citation), "");
    }
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function formatCitationMarkdown(citation: StoredCitationRecord): string {
  const evidence = readEvidenceText(citation.evidence);
  const pages = citation.pageNumbers.length === 0
    ? "unknown"
    : citation.pageNumbers.join(", ");
  return [
    `#### [${citation.citationNumber}] ${citation.sourceFile}`,
    "",
    `Citation ID: \`${citation.id}\`  `,
    `Document version: \`${citation.documentVersionId}\`  `,
    `Element: \`${citation.elementId}\`  `,
    `Pages: ${pages}  `,
    `Stale: ${citation.stale ? "yes" : "no"}`,
    "",
    `> ${evidence.replace(/\n/g, "\n> ")}`,
  ].join("\n");
}

function readEvidenceText(evidence: CitationEvidence): string {
  if (evidence.kind === "text") {
    return evidence.excerpt;
  }
  if (evidence.kind === "table") {
    return evidence.content;
  }
  return `Image evidence (${evidence.mimeType})`;
}

function createCitationAnchorKey(
  documentVersionId: string,
  elementId: string,
): string {
  return `${documentVersionId}\0${elementId}`;
}

function readRequiredCitationElementSetId(
  elementSetIds: ReadonlyMap<string, string>,
  citation: PublishedAnswerCitation,
): string {
  const elementSetId = elementSetIds.get(citation.id);
  if (elementSetId === undefined) {
    throw new Error(`Citation ${citation.id} has no validated element set.`);
  }
  return elementSetId;
}

export function validateCitationSnapshot(
  citation: PublishedAnswerCitation,
  element: SourceElement,
): void {
  if (
    citation.documentId !== element.documentId
    || citation.elementId !== element.id
    || citation.kind !== element.kind
    || !isDeepStrictEqual(citation.pageNumbers, element.pageNumbers)
    || !isDeepStrictEqual(citation.regions, element.regions)
    || !isDeepStrictEqual(citation.sectionPath, element.sectionPath)
  ) {
    throw new Error(
      `Citation ${citation.citationNumber} snapshot does not match source element ${element.id}.`,
    );
  }
  validateStoredEvidence(citation.evidence, element);
}

function validateStoredEvidence(
  evidence: CitationEvidence,
  element: SourceElement,
): void {
  if (evidence.kind !== element.kind) {
    throw new Error("Stored citation evidence kind does not match its source element.");
  }
  if (evidence.kind === "text") {
    if (evidence.excerpt !== element.content) {
      throw new Error("Stored text citation no longer matches its source element.");
    }
    return;
  }
  if (evidence.kind === "table") {
    if (
      element.kind !== "table"
      || evidence.content !== element.content
      || JSON.stringify(evidence.table) !== JSON.stringify(element.table)
    ) {
      throw new Error("Stored table citation no longer matches its source element.");
    }
    return;
  }
  if (element.kind !== "image") {
    throw new Error("Stored image citation no longer matches its source element.");
  }
  if (evidence.mimeType !== element.mimeType) {
    throw new Error("Stored image citation no longer matches its source element.");
  }
}
