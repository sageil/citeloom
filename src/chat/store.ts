import { randomUUID } from "node:crypto";

import {
  and,
  asc,
  cosineDistance,
  count,
  desc,
  eq,
  inArray,
  lte,
  max,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import {
  decodePublishedAnswerDocument,
  isPublishedAnsweredDocument,
  isPublishedUncitedAnswerDocument,
  publishedAnswerDocumentSchema,
  renderPublishedAnswerMarkdown,
  type PublishedAnswerCitation,
  type PublishedAnswerDocument,
} from "../answers/published.js";
import type { AuthenticatedPrincipal } from "../auth/model.js";
import type {
  AppConfig,
  EmbeddingDimensions,
} from "../config/index.js";
import type { CiteLoomDatabase } from "../database/client.js";
import {
  chatCitationRecords,
  chatConversations,
  chatEvidenceDocuments,
  chatMessages,
  chatRuns,
  chatVerificationJobs,
  documentElementSetMembers,
  documentVersions,
  indexedDocuments,
} from "../database/schema.js";
import {
  readChatMessageEmbeddingTable,
  type ChatMessageEmbeddingTable,
} from "../embedding/storage-tables.js";
import {
  type BufferedDocumentSource,
  decodeDocumentFormat,
} from "../documents/format.js";
import {
  lockSourceContentReference,
  queueSourceContentDeletion,
  SourceContentStore,
} from "../documents/storage/source-content-store.js";
import { SourceDocumentStore } from "../documents/storage/source-document-store.js";
import {
  queryScopeSchema,
  type QueryScope,
} from "../domain/query-scope.js";
import {
  contentIdSchema,
  sourceRegionSchema,
} from "../domain/validation.js";
import type {
  AnswerClaim,
  ResearchRetrievalTrace,
} from "../research/types.js";
import type { ClaimEvidenceSource } from "../answers/claim-verification.js";
import { validateCitationSnapshot } from "../research/store.js";
import type {
  ChatAssistantMessage,
  ChatCitationEvidenceRecord,
  ChatClaimVerificationResult,
  ChatConversation,
  ChatConversationSummary,
  ChatMemoryTrace,
  ChatMessage,
  ChatRun,
  ChatRunConfiguration,
  ChatRunState,
  ChatUserMessage,
  StoredChatCitation,
} from "./types.js";

const CHAT_RUN_LEASE_MS = 2 * 60 * 1_000;
const MINIMUM_VERIFICATION_JOB_LEASE_MS = 5 * 60 * 1_000;
const SEMANTIC_MEMORY_PART_OVERSAMPLING = 64;
const passiveAbortSignal = new AbortController().signal;
const activeChatRunStates: ChatRunState[] = [
  "accepted",
  "embedding",
  "retrieving",
  "generating",
  "verifying",
  "publishing",
];

const conversationRowSchema = z.object({
  createdAt: z.date(),
  id: z.uuid(),
  ownerUserId: z.uuid(),
  scope: queryScopeSchema,
  title: z.string().trim().min(1),
  updatedAt: z.date(),
  workspaceId: z.uuid(),
});
const runRowSchema = z.object({
  attemptCount: z.number().int().positive(),
  completedAt: z.date().nullable(),
  errorMessage: z.string().min(1).nullable(),
  id: z.uuid(),
  sequence: z.number().int().positive(),
  state: z.enum([
    "accepted",
    "embedding",
    "retrieving",
    "generating",
    "verifying",
    "publishing",
    "completed",
    "failed",
    "canceled",
  ]),
});
const claimVerificationResultsSchema = z.array(z.object({
  citationNumbers: z.array(z.number().int().positive()),
  claim: z.string().trim().min(1),
  claimIndex: z.number().int().nonnegative(),
  evidenceUnits: z.array(z.object({
    citationNumber: z.number().int().positive(),
    outcome: z.enum([
      "not-evaluated",
      "supported",
      "unsupported",
      "verifier-incompatible",
    ]),
    rationale: z.string().trim().min(1),
    supportProbability: z.number().min(0).max(1).nullable(),
    unitId: z.string().trim().min(1),
  }).strict()),
  rationale: z.string().trim().min(1),
  status: z.enum([
    "collectively-supported",
    "partially-supported",
    "supported",
    "unsupported",
    "unverified",
  ]),
  verifierModel: z.string().trim().min(1),
}).strict());
const messageRowSchema = z.object({
  answerDocument: publishedAnswerDocumentSchema.nullable(),
  claims: claimVerificationResultsSchema.nullable(),
  content: z.string().trim().min(1),
  createdAt: z.date(),
  id: z.uuid(),
  role: z.enum(["assistant", "user"]),
  runId: z.uuid(),
});
const evidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    excerpt: z.string().min(1),
    kind: z.literal("text"),
  }).strict(),
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
const citationRowSchema = z.object({
  assistantMessageId: z.uuid(),
  citationNumber: z.number().int().positive(),
  createdAt: z.date(),
  currentVersionId: z.uuid().nullable(),
  documentId: contentIdSchema,
  documentVersionId: z.uuid(),
  elementId: contentIdSchema,
  evidence: evidenceSchema,
  id: z.uuid(),
  imageContent: z.instanceof(Buffer).nullable(),
  mediaType: z.string().trim().min(1),
  pageNumbers: z.array(z.number().int().positive()),
  regions: z.array(sourceRegionSchema),
  sectionPath: z.array(z.string().min(1)),
  sourceFile: z.string().trim().min(1),
});
const citationSourceVersionRowSchema = z.object({
  documentId: contentIdSchema,
  documentVersionId: z.uuid(),
  elementId: contentIdSchema,
  fileExtension: z.string().trim().min(1).max(33),
  mediaType: z.string().trim().min(1),
  sourceFile: z.string().trim().min(1),
  version: z.number().int().positive(),
});
const summaryRowSchema = z.object({
  createdAt: z.date(),
  id: z.uuid(),
  messageCount: z.number().int().nonnegative(),
  title: z.string().trim().min(1),
  updatedAt: z.date(),
});
const verificationJobStateSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
]);

export interface AcceptedChatRun {
  conversation: {
    id: string;
    scope: QueryScope;
  };
  disposition: "completed" | "in-progress" | "started";
  run: {
    attemptCount: number;
    id: string;
    sequence: number;
    state: ChatRunState;
  };
  userMessage: ChatUserMessage;
}

export interface ChatMemoryTurnRecord {
  assistantContent: string;
  assistantMessageId: string;
  runId: string;
  sequence: number;
  userContent: string;
  userMessageId: string;
}

export interface ChatMessageEmbeddingRecord {
  content: string;
  id: string;
  role: "assistant" | "user";
}

export interface ChatMessageEmbeddingPart {
  content: string;
  embedding: number[];
  inputTokens: number;
  messageId: string;
  partOrdinal: number;
}

export interface ChatSemanticMemoryHit {
  runId: string;
  score: number;
  sequence: number;
}

export interface ClaimedChatVerificationJob {
  assistantMessageId: string;
  attemptCount: number;
  claims: AnswerClaim[];
  failureCount: number;
  sources: ClaimEvidenceSource[];
}

export interface PublishChatAssistantInput {
  answerDocument: PublishedAnswerDocument;
  attemptCount: number;
  claims: readonly ChatClaimVerificationResult[];
  completedAt: Date;
  content: string;
  memoryTrace: ChatMemoryTrace;
  retrievalTrace: ResearchRetrievalTrace;
  runConfiguration: ChatRunConfiguration;
  runId: string;
}

function normalizePublishedChatContent(
  answerDocument: PublishedAnswerDocument,
  claims: readonly ChatClaimVerificationResult[],
  value: string,
): string {
  const content = z.string().trim().min(1).parse(value);
  if (isPublishedAnsweredDocument(answerDocument)) {
    const renderedContent = renderPublishedAnswerMarkdown(answerDocument);
    if (content !== renderedContent) {
      throw new Error(
        "An answered Chat message must match its published answer document.",
      );
    }
    return renderedContent;
  }
  if (claims.length > 0) {
    throw new Error("An uncited Chat message must not contain claims.");
  }
  return content;
}

export class ChatNotFoundError extends Error {
  public constructor() {
    super("The chat was not found.");
    this.name = "ChatNotFoundError";
  }
}

export class ChatConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ChatConflictError";
  }
}

export class ChatStore {
  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly config: AppConfig,
  ) {}

  public async createConversation(
    principal: AuthenticatedPrincipal,
    title: string,
    scope: QueryScope,
  ): Promise<ChatConversation> {
    const normalizedTitle = z.string().trim().min(1).max(500).parse(title);
    const normalizedScope = queryScopeSchema.parse(scope);
    const id = randomUUID();
    const now = new Date();
    await this.database.insert(chatConversations).values({
      createdAt: now,
      id,
      ownerUserId: principal.userId,
      scope: normalizedScope,
      title: normalizedTitle,
      updatedAt: now,
      workspaceId: principal.workspaceId,
    });
    const conversation = await this.readConversation(principal, id);
    if (conversation === null) {
      throw new Error(`Created chat was not found: ${id}`);
    }
    return conversation;
  }

  public async listConversations(
    principal: AuthenticatedPrincipal,
  ): Promise<ChatConversationSummary[]> {
    const rows = await this.database
      .select({
        createdAt: chatConversations.createdAt,
        id: chatConversations.id,
        messageCount: count(chatMessages.id),
        title: chatConversations.title,
        updatedAt: chatConversations.updatedAt,
      })
      .from(chatConversations)
      .leftJoin(chatRuns, eq(chatRuns.conversationId, chatConversations.id))
      .leftJoin(chatMessages, eq(chatMessages.runId, chatRuns.id))
      .where(this.ownedConversationCondition(principal))
      .groupBy(chatConversations.id)
      .orderBy(desc(chatConversations.updatedAt));
    const summaries: ChatConversationSummary[] = [];
    for (const row of rows) {
      const parsed = summaryRowSchema.parse(row);
      summaries.push({
        createdAt: parsed.createdAt.toISOString(),
        id: parsed.id,
        messageCount: parsed.messageCount,
        title: parsed.title,
        updatedAt: parsed.updatedAt.toISOString(),
      });
    }
    return summaries;
  }

  public async readConversation(
    principal: AuthenticatedPrincipal,
    id: string,
  ): Promise<ChatConversation | null> {
    const conversationRows = await this.database
      .select()
      .from(chatConversations)
      .where(and(
        eq(chatConversations.id, id),
        this.ownedConversationCondition(principal),
      ))
      .limit(1);
    const rawConversation = conversationRows[0];
    if (rawConversation === undefined) {
      return null;
    }
    const conversation = conversationRowSchema.parse(rawConversation);
    const rawRuns = await this.database
      .select({
        attemptCount: chatRuns.attemptCount,
        completedAt: chatRuns.completedAt,
        errorMessage: chatRuns.errorMessage,
        id: chatRuns.id,
        sequence: chatRuns.sequence,
        state: chatRuns.state,
      })
      .from(chatRuns)
      .where(eq(chatRuns.conversationId, conversation.id))
      .orderBy(asc(chatRuns.sequence));
    const runs = rawRuns.map((row) => runRowSchema.parse(row));
    const runIds = runs.map((run) => run.id);
    const messages = await this.readMessages(runIds);
    const messagesByRun = new Map<string, ChatMessage[]>();
    for (const message of messages) {
      const current = messagesByRun.get(message.runId) ?? [];
      current.push(message);
      messagesByRun.set(message.runId, current);
    }
    const decodedRuns: ChatRun[] = [];
    for (const run of runs) {
      decodedRuns.push({
        attemptCount: run.attemptCount,
        completedAt: run.completedAt?.toISOString() ?? null,
        errorMessage: run.errorMessage,
        id: run.id,
        messages: messagesByRun.get(run.id) ?? [],
        sequence: run.sequence,
        state: run.state,
      });
    }
    return {
      createdAt: conversation.createdAt.toISOString(),
      id: conversation.id,
      ownerUserId: conversation.ownerUserId,
      runs: decodedRuns,
      scope: conversation.scope,
      title: conversation.title,
      updatedAt: conversation.updatedAt.toISOString(),
      workspaceId: conversation.workspaceId,
    };
  }

  public async deleteConversation(
    principal: AuthenticatedPrincipal,
    id: string,
  ): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const owned = await transaction
        .select({ id: chatConversations.id })
        .from(chatConversations)
        .where(and(
          eq(chatConversations.id, id),
          this.ownedConversationCondition(principal),
        ))
        .for("update")
        .limit(1);
      if (owned[0] === undefined) {
        throw new ChatNotFoundError();
      }
      const evidenceRows = await transaction
        .select({
          documentId: chatEvidenceDocuments.documentId,
          documentVersionId: chatEvidenceDocuments.documentVersionId,
        })
        .from(chatCitationRecords)
        .innerJoin(
          chatMessages,
          eq(chatMessages.id, chatCitationRecords.assistantMessageId),
        )
        .innerJoin(chatRuns, eq(chatRuns.id, chatMessages.runId))
        .innerJoin(
          chatEvidenceDocuments,
          eq(
            chatEvidenceDocuments.documentVersionId,
            chatCitationRecords.documentVersionId,
          ),
        )
        .where(eq(chatRuns.conversationId, id));
      await transaction
        .delete(chatConversations)
        .where(eq(chatConversations.id, id));
      const versionIds = [...new Set(evidenceRows.map((row) => {
        return row.documentVersionId;
      }))];
      if (versionIds.length > 0) {
        await transaction
          .delete(chatEvidenceDocuments)
          .where(and(
            inArray(chatEvidenceDocuments.documentVersionId, versionIds),
            notExists(
              transaction
                .select({ id: chatCitationRecords.id })
                .from(chatCitationRecords)
                .where(eq(
                  chatCitationRecords.documentVersionId,
                  chatEvidenceDocuments.documentVersionId,
                )),
            ),
          ));
      }
      const documentIds = [
        ...new Set(evidenceRows.map((row) => row.documentId)),
      ].sort();
      for (const documentId of documentIds) {
        await queueSourceContentDeletion(transaction, documentId);
      }
    });
  }

  public async acceptUserMessage(
    principal: AuthenticatedPrincipal,
    conversationId: string,
    requestId: string,
    content: string,
  ): Promise<AcceptedChatRun> {
    const normalizedRequestId = z.uuid().parse(requestId);
    const normalizedContent = z.string().trim().min(1).max(8_000).parse(content);
    return this.database.transaction(async (transaction) => {
      const conversationRows = await transaction
        .select({
          id: chatConversations.id,
          scope: chatConversations.scope,
        })
        .from(chatConversations)
        .where(and(
          eq(chatConversations.id, conversationId),
          this.ownedConversationCondition(principal),
        ))
        .for("update")
        .limit(1);
      const conversation = conversationRows[0];
      if (conversation === undefined) {
        throw new ChatNotFoundError();
      }
      const recoveredAt = new Date();
      await transaction
        .update(chatRuns)
        .set({
          completedAt: recoveredAt,
          errorMessage:
            "The previous response worker stopped before publication. Send the message again to retry.",
          leaseExpiresAt: null,
          state: "failed",
          updatedAt: recoveredAt,
        })
        .where(and(
          eq(chatRuns.conversationId, conversationId),
          inArray(chatRuns.state, activeChatRunStates),
          lte(chatRuns.leaseExpiresAt, recoveredAt),
        ));
      const existingRows = await transaction
        .select({
          attemptCount: chatRuns.attemptCount,
          completedAt: chatRuns.completedAt,
          content: chatMessages.content,
          createdAt: chatMessages.createdAt,
          leaseExpiresAt: chatRuns.leaseExpiresAt,
          messageId: chatMessages.id,
          sequence: chatRuns.sequence,
          state: chatRuns.state,
        })
        .from(chatRuns)
        .innerJoin(
          chatMessages,
          and(
            eq(chatMessages.runId, chatRuns.id),
            eq(chatMessages.role, "user"),
          ),
        )
        .where(and(
          eq(chatRuns.id, normalizedRequestId),
          eq(chatRuns.conversationId, conversationId),
        ))
        .limit(1);
      const existing = existingRows[0];
      if (existing !== undefined) {
        if (existing.content !== normalizedContent) {
          throw new ChatConflictError(
            "The request ID is already associated with a different message.",
          );
        }
        const retryable = existing.state === "failed"
          || existing.state === "canceled"
          || (
            existing.state !== "completed"
            && existing.leaseExpiresAt !== null
            && existing.leaseExpiresAt.getTime() <= Date.now()
          );
        if (retryable) {
          const competingRows = await transaction
            .select({ id: chatRuns.id })
            .from(chatRuns)
            .where(and(
              eq(chatRuns.conversationId, conversationId),
              ne(chatRuns.id, normalizedRequestId),
              inArray(chatRuns.state, activeChatRunStates),
            ))
            .limit(1);
          if (competingRows[0] !== undefined) {
            throw new ChatConflictError(
              "This chat already has a response in progress.",
            );
          }
          await transaction
            .update(chatRuns)
            .set({
              attemptCount: sql`${chatRuns.attemptCount} + 1`,
              completedAt: null,
              errorMessage: null,
              leaseExpiresAt: this.nextLease(),
              memoryTrace: null,
              retrievalTrace: null,
              runConfiguration: null,
              state: "accepted",
              updatedAt: new Date(),
            })
            .where(eq(chatRuns.id, normalizedRequestId));
          return {
            conversation: {
              id: conversation.id,
              scope: queryScopeSchema.parse(conversation.scope),
            },
            disposition: "started",
            run: {
              attemptCount: existing.attemptCount + 1,
              id: normalizedRequestId,
              sequence: existing.sequence,
              state: "accepted",
            },
            userMessage: {
              content: existing.content,
              createdAt: existing.createdAt.toISOString(),
              id: existing.messageId,
              role: "user",
              runId: normalizedRequestId,
            },
          };
        }
        return {
          conversation: {
            id: conversation.id,
            scope: queryScopeSchema.parse(conversation.scope),
          },
          disposition: existing.state === "completed"
            ? "completed"
            : "in-progress",
          run: {
            attemptCount: existing.attemptCount,
            id: normalizedRequestId,
            sequence: existing.sequence,
            state: existing.state,
          },
          userMessage: {
            content: existing.content,
            createdAt: existing.createdAt.toISOString(),
            id: existing.messageId,
            role: "user",
            runId: normalizedRequestId,
          },
        };
      }
      const activeRows = await transaction
        .select({ id: chatRuns.id })
        .from(chatRuns)
        .where(and(
          eq(chatRuns.conversationId, conversationId),
          inArray(chatRuns.state, activeChatRunStates),
        ))
        .limit(1);
      if (activeRows[0] !== undefined) {
        throw new ChatConflictError(
          "This chat already has a response in progress.",
        );
      }
      const sequenceRows = await transaction
        .select({ value: max(chatRuns.sequence) })
        .from(chatRuns)
        .where(eq(chatRuns.conversationId, conversationId));
      const sequence = (sequenceRows[0]?.value ?? 0) + 1;
      const createdAt = new Date();
      const messageId = randomUUID();
      await transaction.insert(chatRuns).values({
        attemptCount: 1,
        conversationId,
        id: normalizedRequestId,
        leaseExpiresAt: this.nextLease(),
        sequence,
        state: "accepted",
        updatedAt: createdAt,
      });
      await transaction.insert(chatMessages).values({
        content: normalizedContent,
        createdAt,
        id: messageId,
        role: "user",
        runId: normalizedRequestId,
      });
      await transaction
        .update(chatConversations)
        .set({ updatedAt: createdAt })
        .where(eq(chatConversations.id, conversationId));
      return {
        conversation: {
          id: conversation.id,
          scope: queryScopeSchema.parse(conversation.scope),
        },
        disposition: "started",
        run: {
          attemptCount: 1,
          id: normalizedRequestId,
          sequence,
          state: "accepted",
        },
        userMessage: {
          content: normalizedContent,
          createdAt: createdAt.toISOString(),
          id: messageId,
          role: "user",
          runId: normalizedRequestId,
        },
      };
    });
  }

  public async transitionRun(
    principal: AuthenticatedPrincipal,
    runId: string,
    attemptCount: number,
    expectedState: ChatRunState,
    state: ChatRunState,
  ): Promise<void> {
    await this.requireOwnedRun(principal, runId);
    const terminal = state === "completed"
      || state === "failed"
      || state === "canceled";
    if (terminal) {
      throw new Error("Terminal chat transitions require a dedicated method.");
    }
    const updated = await this.database
      .update(chatRuns)
      .set({
        leaseExpiresAt: this.nextLease(),
        state,
        updatedAt: new Date(),
      })
      .where(and(
        eq(chatRuns.id, runId),
        eq(chatRuns.attemptCount, attemptCount),
        eq(chatRuns.state, expectedState),
      ))
      .returning({ id: chatRuns.id });
    if (updated[0] === undefined) {
      throw new ChatConflictError(
        `Chat run ${runId} is no longer in state ${expectedState}.`,
      );
    }
  }

  public async failRun(
    principal: AuthenticatedPrincipal,
    runId: string,
    attemptCount: number,
    error: unknown,
    canceled: boolean,
  ): Promise<void> {
    await this.requireOwnedRun(principal, runId);
    const now = new Date();
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = rawMessage.trim().slice(0, 4_000) || "Chat generation failed.";
    await this.database
      .update(chatRuns)
      .set({
        completedAt: now,
        errorMessage: canceled ? null : message,
        leaseExpiresAt: null,
        state: canceled ? "canceled" : "failed",
        updatedAt: now,
      })
      .where(and(
        eq(chatRuns.id, runId),
        eq(chatRuns.attemptCount, attemptCount),
        ne(chatRuns.state, "completed"),
      ));
  }

  public async renewRunLease(
    principal: AuthenticatedPrincipal,
    runId: string,
    attemptCount: number,
  ): Promise<void> {
    await this.requireOwnedRun(principal, runId);
    const updated = await this.database
      .update(chatRuns)
      .set({
        leaseExpiresAt: this.nextLease(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(chatRuns.id, runId),
        eq(chatRuns.attemptCount, attemptCount),
        inArray(chatRuns.state, activeChatRunStates),
      ))
      .returning({ id: chatRuns.id });
    if (updated[0] === undefined) {
      throw new ChatConflictError(
        `Chat run ${runId} is no longer owned by attempt ${attemptCount}.`,
      );
    }
  }

  public async readCompletedMemoryTurns(
    principal: AuthenticatedPrincipal,
    conversationId: string,
    excludeRunId: string,
  ): Promise<ChatMemoryTurnRecord[]> {
    await this.requireOwnedConversation(principal, conversationId);
    const rows = await this.database
      .select({
        assistantContent: sql<string>`max(${chatMessages.content}) filter (where ${chatMessages.role} = 'assistant')`,
        assistantMessageId: sql<string>`max(${chatMessages.id}::text) filter (where ${chatMessages.role} = 'assistant')`,
        runId: chatRuns.id,
        sequence: chatRuns.sequence,
        userContent: sql<string>`max(${chatMessages.content}) filter (where ${chatMessages.role} = 'user')`,
        userMessageId: sql<string>`max(${chatMessages.id}::text) filter (where ${chatMessages.role} = 'user')`,
      })
      .from(chatRuns)
      .innerJoin(chatMessages, eq(chatMessages.runId, chatRuns.id))
      .where(and(
        eq(chatRuns.conversationId, conversationId),
        eq(chatRuns.state, "completed"),
        ne(chatRuns.id, excludeRunId),
      ))
      .groupBy(chatRuns.id)
      .orderBy(asc(chatRuns.sequence));
    const schema = z.object({
      assistantContent: z.string().trim().min(1),
      assistantMessageId: z.uuid(),
      runId: z.uuid(),
      sequence: z.number().int().positive(),
      userContent: z.string().trim().min(1),
      userMessageId: z.uuid(),
    });
    return rows.map((row) => schema.parse(row));
  }

  public async readMessagesMissingEmbeddings(
    principal: AuthenticatedPrincipal,
    conversationId: string,
    embeddingSpaceId: string,
    dimensions: EmbeddingDimensions,
  ): Promise<ChatMessageEmbeddingRecord[]> {
    await this.requireOwnedConversation(principal, conversationId);
    const table = readChatMessageEmbeddingTable(dimensions);
    return this.readMissingEmbeddingsFromTable(
      conversationId,
      embeddingSpaceId,
      table,
    );
  }

  public async saveMessageEmbeddings(
    embeddingSpaceId: string,
    dimensions: EmbeddingDimensions,
    parts: readonly ChatMessageEmbeddingPart[],
  ): Promise<void> {
    if (parts.length === 0) {
      return;
    }
    const values = parts.map((part) => ({
      content: part.content,
      embedding: part.embedding,
      embeddingSpaceId,
      inputTokens: part.inputTokens,
      messageId: part.messageId,
      partOrdinal: part.partOrdinal,
    }));
    const table = readChatMessageEmbeddingTable(dimensions);
    await this.database.insert(table)
      .values(values)
      .onConflictDoNothing();
  }

  public async searchSemanticMemory(
    principal: AuthenticatedPrincipal,
    conversationId: string,
    excludeRunId: string,
    embeddingSpaceId: string,
    dimensions: EmbeddingDimensions,
    embedding: number[],
    limit: number,
  ): Promise<ChatSemanticMemoryHit[]> {
    await this.requireOwnedConversation(principal, conversationId);
    const table = readChatMessageEmbeddingTable(dimensions);
    const distance = cosineDistance(table.embedding, embedding);
    const rows = await this.database
      .select({
        distance,
        runId: chatRuns.id,
        sequence: chatRuns.sequence,
      })
      .from(table)
      .innerJoin(
        chatMessages,
        eq(chatMessages.id, table.messageId),
      )
      .innerJoin(chatRuns, eq(chatRuns.id, chatMessages.runId))
      .where(and(
        eq(table.embeddingSpaceId, embeddingSpaceId),
        eq(chatRuns.conversationId, conversationId),
        eq(chatRuns.state, "completed"),
        ne(chatRuns.id, excludeRunId),
      ))
      .orderBy(distance, desc(chatRuns.sequence))
      .limit(limit * SEMANTIC_MEMORY_PART_OVERSAMPLING);
    return decodeSemanticHits(rows, limit);
  }

  public async publishAssistant(
    principal: AuthenticatedPrincipal,
    input: PublishChatAssistantInput,
    abortSignal: AbortSignal = passiveAbortSignal,
  ): Promise<ChatAssistantMessage> {
    abortSignal.throwIfAborted();
    const answerDocument = decodePublishedAnswerDocument(input.answerDocument);
    const content = normalizePublishedChatContent(
      answerDocument,
      input.claims,
      input.content,
    );
    const assistantMessageId = randomUUID();
    const citationSources = await this.readCitationSources(
      answerDocument.citations,
    );
    abortSignal.throwIfAborted();
    await this.database.transaction(async (transaction) => {
      const ownedRows = await transaction
        .select({
          conversationId: chatRuns.conversationId,
          state: chatRuns.state,
        })
        .from(chatRuns)
        .innerJoin(
          chatConversations,
          eq(chatConversations.id, chatRuns.conversationId),
        )
        .where(and(
          eq(chatRuns.id, input.runId),
          eq(chatRuns.attemptCount, input.attemptCount),
          this.ownedConversationCondition(principal),
        ))
        .for("update")
        .limit(1);
      const owned = ownedRows[0];
      if (owned === undefined) {
        throw new ChatNotFoundError();
      }
      if (owned.state !== "publishing") {
        throw new ChatConflictError(
          `Chat run ${input.runId} cannot publish from state ${owned.state}.`,
        );
      }
      const sourceDocumentIds = [...new Set(citationSources.map((source) => {
        return source.document.documentId;
      }))].sort();
      for (const documentId of sourceDocumentIds) {
        await lockSourceContentReference(transaction, documentId);
      }
      for (const source of citationSources) {
        await transaction
          .insert(chatEvidenceDocuments)
          .values(source.document)
          .onConflictDoNothing({
            target: chatEvidenceDocuments.documentVersionId,
          });
      }
      await transaction.insert(chatMessages).values({
        answerDocument,
        claims: [...input.claims],
        content,
        createdAt: input.completedAt,
        id: assistantMessageId,
        role: "assistant",
        runId: input.runId,
      });
      if (input.claims.length > 0) {
        await transaction.insert(chatVerificationJobs).values({
          assistantMessageId,
          attemptCount: 0,
          availableAt: input.completedAt,
          failureCount: 0,
          state: "pending",
          updatedAt: input.completedAt,
        });
      }
      if (citationSources.length > 0) {
        const citationValues = citationSources.map((source) => ({
          assistantMessageId,
          citationNumber: source.citation.citationNumber,
          createdAt: input.completedAt,
          documentVersionId: source.citation.documentVersionId,
          elementId: source.citation.elementId,
          evidence: source.citation.evidence,
          id: source.citation.id,
          imageContent: source.imageContent,
          pageNumbers: source.citation.pageNumbers,
          regions: source.citation.regions,
          sectionPath: source.citation.sectionPath,
          sourceFile: source.citation.sourceFile,
        }));
        await transaction.insert(chatCitationRecords).values(citationValues);
      }
      await transaction
        .update(chatRuns)
        .set({
          completedAt: input.completedAt,
          leaseExpiresAt: null,
          memoryTrace: input.memoryTrace,
          retrievalTrace: input.retrievalTrace,
          runConfiguration: input.runConfiguration,
          state: "completed",
          updatedAt: input.completedAt,
        })
        .where(eq(chatRuns.id, input.runId));
      await transaction
        .update(chatConversations)
        .set({ updatedAt: input.completedAt })
        .where(eq(chatConversations.id, owned.conversationId));
    });
    const citations = citationSources.map((source) => {
      return toStoredCitation(
        source.citation,
        source.document.documentId,
        source.document.mediaType,
        input.completedAt,
        true,
      );
    });
    return {
      answerDocument,
      citations,
      claims: [...input.claims],
      content,
      createdAt: input.completedAt.toISOString(),
      id: assistantMessageId,
      role: "assistant",
      runId: input.runId,
      verificationState: input.claims.length > 0
        ? "pending"
        : "not-applicable",
    };
  }

  public async claimNextVerificationJob(
    currentTime: Date,
  ): Promise<ClaimedChatVerificationJob | null> {
    return this.database.transaction(async (transaction) => {
      const rows = await transaction
        .select({
          assistantMessageId: chatVerificationJobs.assistantMessageId,
          attemptCount: chatVerificationJobs.attemptCount,
          claims: chatMessages.claims,
          failureCount: chatVerificationJobs.failureCount,
        })
        .from(chatVerificationJobs)
        .innerJoin(
          chatMessages,
          eq(chatMessages.id, chatVerificationJobs.assistantMessageId),
        )
        .where(or(
          and(
            eq(chatVerificationJobs.state, "pending"),
            lte(chatVerificationJobs.availableAt, currentTime),
          ),
          and(
            eq(chatVerificationJobs.state, "running"),
            lte(chatVerificationJobs.leaseExpiresAt, currentTime),
          ),
        ))
        .orderBy(
          asc(chatVerificationJobs.availableAt),
          asc(chatVerificationJobs.updatedAt),
        )
        .limit(1)
        .for("update", { skipLocked: true });
      const row = rows[0];
      if (row === undefined) {
        return null;
      }
      const claims = claimVerificationResultsSchema.parse(row.claims);
      const nextAttemptCount = row.attemptCount + 1;
      const claimed = await transaction
        .update(chatVerificationJobs)
        .set({
          attemptCount: nextAttemptCount,
          errorMessage: null,
          leaseExpiresAt: this.nextVerificationLease(),
          state: "running",
          updatedAt: currentTime,
        })
        .where(eq(
          chatVerificationJobs.assistantMessageId,
          row.assistantMessageId,
        ))
        .returning({
          assistantMessageId: chatVerificationJobs.assistantMessageId,
        });
      if (claimed[0] === undefined) {
        throw new Error(
          `Could not claim Chat verification job ${row.assistantMessageId}.`,
        );
      }
      const citationRows = await transaction
        .select({
          citationNumber: chatCitationRecords.citationNumber,
          evidence: chatCitationRecords.evidence,
          sectionPath: chatCitationRecords.sectionPath,
        })
        .from(chatCitationRecords)
        .where(eq(
          chatCitationRecords.assistantMessageId,
          row.assistantMessageId,
        ))
        .orderBy(asc(chatCitationRecords.citationNumber));
      const sources = citationRows.map((citation) => {
        return {
          citationNumber: citation.citationNumber,
          evidence: citation.evidence,
          sectionPath: citation.sectionPath,
        };
      });
      const answerClaims = claims.map((claim) => {
        return {
          citationNumbers: [...claim.citationNumbers],
          claim: claim.claim,
          claimIndex: claim.claimIndex,
        };
      });
      return {
        assistantMessageId: row.assistantMessageId,
        attemptCount: nextAttemptCount,
        claims: answerClaims,
        failureCount: row.failureCount,
        sources,
      };
    });
  }

  public async completeVerificationJob(
    assistantMessageId: string,
    attemptCount: number,
    claims: readonly ChatClaimVerificationResult[],
    completedAt: Date,
  ): Promise<boolean> {
    const normalizedClaims = claimVerificationResultsSchema.parse(claims);
    return this.database.transaction(async (transaction) => {
      const completed = await transaction
        .update(chatVerificationJobs)
        .set({
          completedAt,
          errorMessage: null,
          leaseExpiresAt: null,
          state: "completed",
          updatedAt: completedAt,
        })
        .where(and(
          eq(chatVerificationJobs.assistantMessageId, assistantMessageId),
          eq(chatVerificationJobs.attemptCount, attemptCount),
          eq(chatVerificationJobs.state, "running"),
        ))
        .returning({
          assistantMessageId: chatVerificationJobs.assistantMessageId,
        });
      if (completed[0] === undefined) {
        return false;
      }
      await transaction
        .update(chatMessages)
        .set({ claims: normalizedClaims })
        .where(eq(chatMessages.id, assistantMessageId));
      return true;
    });
  }

  public async settleVerificationFailure(
    assistantMessageId: string,
    attemptCount: number,
    error: unknown,
    retryAt: Date | null,
  ): Promise<boolean> {
    const now = new Date();
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = rawMessage.trim().slice(0, 4_000)
      || "Automated evidence verification failed.";
    const terminal = retryAt === null;
    const settled = await this.database
      .update(chatVerificationJobs)
      .set({
        availableAt: retryAt ?? now,
        completedAt: terminal ? now : null,
        errorMessage: message,
        failureCount: sql`${chatVerificationJobs.failureCount} + 1`,
        leaseExpiresAt: null,
        state: terminal ? "failed" : "pending",
        updatedAt: now,
      })
      .where(and(
        eq(chatVerificationJobs.assistantMessageId, assistantMessageId),
        eq(chatVerificationJobs.attemptCount, attemptCount),
        eq(chatVerificationJobs.state, "running"),
      ))
      .returning({
        assistantMessageId: chatVerificationJobs.assistantMessageId,
      });
    return settled[0] !== undefined;
  }

  public async releaseVerificationJob(
    assistantMessageId: string,
    attemptCount: number,
  ): Promise<boolean> {
    const now = new Date();
    const released = await this.database
      .update(chatVerificationJobs)
      .set({
        availableAt: now,
        errorMessage: null,
        leaseExpiresAt: null,
        state: "pending",
        updatedAt: now,
      })
      .where(and(
        eq(chatVerificationJobs.assistantMessageId, assistantMessageId),
        eq(chatVerificationJobs.attemptCount, attemptCount),
        eq(chatVerificationJobs.state, "running"),
      ))
      .returning({
        assistantMessageId: chatVerificationJobs.assistantMessageId,
      });
    return released[0] !== undefined;
  }

  public async readCitation(
    principal: AuthenticatedPrincipal,
    id: string,
  ): Promise<ChatCitationEvidenceRecord | null> {
    const rows = await this.database
      .select({
        assistantMessageId: chatCitationRecords.assistantMessageId,
        citationNumber: chatCitationRecords.citationNumber,
        createdAt: chatCitationRecords.createdAt,
        currentVersionId: indexedDocuments.versionId,
        documentId: chatEvidenceDocuments.documentId,
        documentVersionId: chatCitationRecords.documentVersionId,
        elementId: chatCitationRecords.elementId,
        evidence: chatCitationRecords.evidence,
        id: chatCitationRecords.id,
        imageContent: chatCitationRecords.imageContent,
        mediaType: chatEvidenceDocuments.mediaType,
        pageNumbers: chatCitationRecords.pageNumbers,
        regions: chatCitationRecords.regions,
        sectionPath: chatCitationRecords.sectionPath,
        sourceFile: chatCitationRecords.sourceFile,
      })
      .from(chatCitationRecords)
      .innerJoin(
        chatMessages,
        eq(chatMessages.id, chatCitationRecords.assistantMessageId),
      )
      .innerJoin(chatRuns, eq(chatRuns.id, chatMessages.runId))
      .innerJoin(
        chatConversations,
        eq(chatConversations.id, chatRuns.conversationId),
      )
      .innerJoin(
        chatEvidenceDocuments,
        eq(
          chatEvidenceDocuments.documentVersionId,
          chatCitationRecords.documentVersionId,
        ),
      )
      .leftJoin(
        indexedDocuments,
        and(
          eq(indexedDocuments.sourceFile, chatCitationRecords.sourceFile),
          eq(indexedDocuments.versionId, chatCitationRecords.documentVersionId),
        ),
      )
      .where(and(
        eq(chatCitationRecords.id, id),
        this.ownedConversationCondition(principal),
      ))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const citation = citationRowSchema.parse(row);
    return {
      citation: {
        citationNumber: citation.citationNumber,
        createdAt: citation.createdAt.toISOString(),
        documentId: citation.documentId,
        documentVersionId: citation.documentVersionId,
        elementId: citation.elementId,
        evidence: citation.evidence,
        id: citation.id,
        mediaType: citation.mediaType,
        pageNumbers: citation.pageNumbers,
        regions: citation.regions,
        sectionPath: citation.sectionPath,
        sourceAvailable:
          citation.currentVersionId === citation.documentVersionId,
        sourceFile: citation.sourceFile,
      },
      imageContent: citation.imageContent,
    };
  }

  public async readCitationFile(
    principal: AuthenticatedPrincipal,
    citationId: string,
  ): Promise<BufferedDocumentSource | null> {
    const rows = await this.database
      .select({
        documentId: chatEvidenceDocuments.documentId,
        fileExtension: chatEvidenceDocuments.fileExtension,
        mediaType: chatEvidenceDocuments.mediaType,
        sourceFile: chatEvidenceDocuments.sourceFile,
      })
      .from(chatCitationRecords)
      .innerJoin(
        chatMessages,
        eq(chatMessages.id, chatCitationRecords.assistantMessageId),
      )
      .innerJoin(chatRuns, eq(chatRuns.id, chatMessages.runId))
      .innerJoin(
        chatConversations,
        eq(chatConversations.id, chatRuns.conversationId),
      )
      .innerJoin(
        chatEvidenceDocuments,
        eq(
          chatEvidenceDocuments.documentVersionId,
          chatCitationRecords.documentVersionId,
        ),
      )
      .where(and(
        eq(chatCitationRecords.id, citationId),
        this.ownedConversationCondition(principal),
      ))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      return null;
    }
    const format = decodeDocumentFormat({
      extension: row.fileExtension,
      mediaType: row.mediaType,
    });
    const sourceStore = new SourceContentStore(
      this.database,
      this.config.sourceContent,
    );
    const stored = await sourceStore.readDocument(row.documentId);
    return {
      ...stored,
      extension: format.extension,
      kind: "buffer",
      mediaType: format.mediaType,
      sourceFile: row.sourceFile,
    };
  }

  private ownedConversationCondition(principal: AuthenticatedPrincipal) {
    return and(
      eq(chatConversations.workspaceId, principal.workspaceId),
      eq(chatConversations.ownerUserId, principal.userId),
    );
  }

  private async requireOwnedConversation(
    principal: AuthenticatedPrincipal,
    id: string,
  ): Promise<void> {
    const rows = await this.database
      .select({ id: chatConversations.id })
      .from(chatConversations)
      .where(and(
        eq(chatConversations.id, id),
        this.ownedConversationCondition(principal),
      ))
      .limit(1);
    if (rows[0] === undefined) {
      throw new ChatNotFoundError();
    }
  }

  private async requireOwnedRun(
    principal: AuthenticatedPrincipal,
    runId: string,
  ): Promise<void> {
    const rows = await this.database
      .select({ id: chatRuns.id })
      .from(chatRuns)
      .innerJoin(
        chatConversations,
        eq(chatConversations.id, chatRuns.conversationId),
      )
      .where(and(
        eq(chatRuns.id, runId),
        this.ownedConversationCondition(principal),
      ))
      .limit(1);
    if (rows[0] === undefined) {
      throw new ChatNotFoundError();
    }
  }

  private nextLease(): Date {
    return new Date(Date.now() + CHAT_RUN_LEASE_MS);
  }

  private nextVerificationLease(): Date {
    const leaseMs = Math.max(
      MINIMUM_VERIFICATION_JOB_LEASE_MS,
      this.config.claimVerifier.timeoutMs + 60_000,
    );
    return new Date(Date.now() + leaseMs);
  }

  private async readMessages(runIds: string[]): Promise<ChatMessage[]> {
    if (runIds.length === 0) {
      return [];
    }
    const rawMessages = await this.database
      .select()
      .from(chatMessages)
      .where(inArray(chatMessages.runId, runIds))
      .orderBy(asc(chatMessages.createdAt));
    const messages = rawMessages.map((row) => messageRowSchema.parse(row));
    const assistantIds = messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.id);
    const verificationStates = await this.readVerificationStates(assistantIds);
    const citationsByMessage = await this.readCitationsByMessage(assistantIds);
    const decoded: ChatMessage[] = [];
    for (const message of messages) {
      if (message.role === "user") {
        if (message.answerDocument !== null || message.claims !== null) {
          throw new Error(`Chat user message ${message.id} contains assistant output.`);
        }
        decoded.push({
          content: message.content,
          createdAt: message.createdAt.toISOString(),
          id: message.id,
          role: "user",
          runId: message.runId,
        });
        continue;
      }
      if (message.answerDocument === null || message.claims === null) {
        throw new Error(`Chat assistant message ${message.id} has incomplete output.`);
      }
      const answerDocument = decodePublishedAnswerDocument(
        message.answerDocument,
      );
      if (
        isPublishedUncitedAnswerDocument(answerDocument)
        && message.claims.length > 0
      ) {
        throw new Error(
          `Uncited Chat message ${message.id} contains claims.`,
        );
      }
      if (
        isPublishedAnsweredDocument(answerDocument)
        && renderPublishedAnswerMarkdown(answerDocument) !== message.content
      ) {
        throw new Error(
          `Chat assistant message ${message.id} differs from its published output.`,
        );
      }
      decoded.push({
        answerDocument,
        citations: citationsByMessage.get(message.id) ?? [],
        claims: message.claims,
        content: message.content,
        createdAt: message.createdAt.toISOString(),
        id: message.id,
        role: "assistant",
        runId: message.runId,
        verificationState: verificationStates.get(message.id)
          ?? (message.claims.length > 0 ? "completed" : "not-applicable"),
      });
    }
    return decoded;
  }

  private async readVerificationStates(
    assistantMessageIds: string[],
  ): Promise<Map<string, z.infer<typeof verificationJobStateSchema>>> {
    const states = new Map<
      string,
      z.infer<typeof verificationJobStateSchema>
    >();
    if (assistantMessageIds.length === 0) {
      return states;
    }
    const rows = await this.database
      .select({
        assistantMessageId: chatVerificationJobs.assistantMessageId,
        state: chatVerificationJobs.state,
      })
      .from(chatVerificationJobs)
      .where(inArray(
        chatVerificationJobs.assistantMessageId,
        assistantMessageIds,
      ));
    for (const row of rows) {
      states.set(
        row.assistantMessageId,
        verificationJobStateSchema.parse(row.state),
      );
    }
    return states;
  }

  private async readCitationsByMessage(
    assistantMessageIds: string[],
  ): Promise<Map<string, StoredChatCitation[]>> {
    const grouped = new Map<string, StoredChatCitation[]>();
    if (assistantMessageIds.length === 0) {
      return grouped;
    }
    const rows = await this.database
      .select({
        assistantMessageId: chatCitationRecords.assistantMessageId,
        citationNumber: chatCitationRecords.citationNumber,
        createdAt: chatCitationRecords.createdAt,
        currentVersionId: indexedDocuments.versionId,
        documentId: chatEvidenceDocuments.documentId,
        documentVersionId: chatCitationRecords.documentVersionId,
        elementId: chatCitationRecords.elementId,
        evidence: chatCitationRecords.evidence,
        id: chatCitationRecords.id,
        imageContent: chatCitationRecords.imageContent,
        mediaType: chatEvidenceDocuments.mediaType,
        pageNumbers: chatCitationRecords.pageNumbers,
        regions: chatCitationRecords.regions,
        sectionPath: chatCitationRecords.sectionPath,
        sourceFile: chatCitationRecords.sourceFile,
      })
      .from(chatCitationRecords)
      .innerJoin(
        chatEvidenceDocuments,
        eq(
          chatEvidenceDocuments.documentVersionId,
          chatCitationRecords.documentVersionId,
        ),
      )
      .leftJoin(
        indexedDocuments,
        and(
          eq(indexedDocuments.sourceFile, chatCitationRecords.sourceFile),
          eq(indexedDocuments.versionId, chatCitationRecords.documentVersionId),
        ),
      )
      .where(inArray(
        chatCitationRecords.assistantMessageId,
        assistantMessageIds,
      ))
      .orderBy(
        asc(chatCitationRecords.assistantMessageId),
        asc(chatCitationRecords.citationNumber),
      );
    for (const raw of rows) {
      const row = citationRowSchema.parse(raw);
      const citation: StoredChatCitation = {
        citationNumber: row.citationNumber,
        createdAt: row.createdAt.toISOString(),
        documentId: row.documentId,
        documentVersionId: row.documentVersionId,
        elementId: row.elementId,
        evidence: row.evidence,
        id: row.id,
        mediaType: row.mediaType,
        pageNumbers: row.pageNumbers,
        regions: row.regions,
        sectionPath: row.sectionPath,
        sourceAvailable: row.currentVersionId === row.documentVersionId,
        sourceFile: row.sourceFile,
      };
      const current = grouped.get(row.assistantMessageId) ?? [];
      current.push(citation);
      grouped.set(row.assistantMessageId, current);
    }
    return grouped;
  }

  private async readMissingEmbeddingsFromTable(
    conversationId: string,
    embeddingSpaceId: string,
    table: ChatMessageEmbeddingTable,
  ): Promise<ChatMessageEmbeddingRecord[]> {
    const rows = await this.database
      .select({
        content: chatMessages.content,
        id: chatMessages.id,
        role: chatMessages.role,
      })
      .from(chatMessages)
      .innerJoin(chatRuns, eq(chatRuns.id, chatMessages.runId))
      .where(and(
        eq(chatRuns.conversationId, conversationId),
        notExists(
          this.database
            .select({ messageId: table.messageId })
            .from(table)
            .where(and(
              eq(table.messageId, chatMessages.id),
              eq(table.embeddingSpaceId, embeddingSpaceId),
            )),
        ),
      ))
      .orderBy(asc(chatRuns.sequence), asc(chatMessages.createdAt));
    return decodeEmbeddingRecords(rows);
  }

  private async readCitationSources(
    citations: readonly PublishedAnswerCitation[],
  ): Promise<Array<{
    citation: PublishedAnswerCitation;
    document: typeof chatEvidenceDocuments.$inferInsert;
    imageContent: Buffer | null;
  }>> {
    if (citations.length === 0) {
      return [];
    }
    const versionIds = [...new Set(citations.map((citation) => {
      return citation.documentVersionId;
    }))];
    const elementIds = [...new Set(citations.map((citation) => {
      return citation.elementId;
    }))];
    const versionRows = await this.database
      .select({
        documentId: documentVersions.documentId,
        documentVersionId: documentVersions.id,
        elementId: documentElementSetMembers.elementId,
        fileExtension: documentVersions.fileExtension,
        mediaType: documentVersions.mediaType,
        sourceFile: documentVersions.sourceFile,
        version: documentVersions.version,
      })
      .from(documentVersions)
      .innerJoin(
        documentElementSetMembers,
        eq(
          documentElementSetMembers.setId,
          documentVersions.elementSetId,
        ),
      )
      .where(and(
        inArray(documentVersions.id, versionIds),
        inArray(documentElementSetMembers.elementId, elementIds),
      ));
    const versions = new Map(versionRows.map((rawRow) => {
      const row = citationSourceVersionRowSchema.parse(rawRow);
      return [
        createCitationAnchorKey(row.documentVersionId, row.elementId),
        row,
      ];
    }));
    const sourceStore = new SourceDocumentStore(this.database);
    const elements = await sourceStore.readMany(
      citations.map((citation) => citation.elementId),
    );
    const elementsById = new Map(elements.map((element) => {
      return [element.id, element];
    }));
    const sources: Array<{
      citation: PublishedAnswerCitation;
      document: typeof chatEvidenceDocuments.$inferInsert;
      imageContent: Buffer | null;
    }> = [];
    for (const citation of citations) {
      const version = versions.get(createCitationAnchorKey(
        citation.documentVersionId,
        citation.elementId,
      ));
      const element = elementsById.get(citation.elementId);
      if (version === undefined || element === undefined) {
        throw new Error(
          `Citation source is unavailable: ${citation.citationNumber}.`,
        );
      }
      if (
        version.documentId !== citation.documentId
        || version.sourceFile !== citation.sourceFile
      ) {
        throw new Error(
          `Citation ${citation.citationNumber} document metadata does not match.`,
        );
      }
      validateCitationSnapshot(citation, element);
      sources.push({
        citation,
        document: {
          documentId: version.documentId,
          documentVersionId: version.documentVersionId,
          fileExtension: version.fileExtension,
          mediaType: version.mediaType,
          sourceFile: version.sourceFile,
          version: version.version,
        },
        imageContent: element.kind === "image"
          ? Buffer.from(element.content, "base64")
          : null,
      });
    }
    return sources;
  }
}

function createCitationAnchorKey(
  documentVersionId: string,
  elementId: string,
): string {
  return `${documentVersionId}:${elementId}`;
}

function decodeEmbeddingRecords(
  rows: readonly unknown[],
): ChatMessageEmbeddingRecord[] {
  const schema = z.object({
    content: z.string().trim().min(1),
    id: z.uuid(),
    role: z.enum(["assistant", "user"]),
  });
  return rows.map((row) => schema.parse(row));
}

function decodeSemanticHits(
  rows: readonly unknown[],
  limit: number,
): ChatSemanticMemoryHit[] {
  const schema = z.object({
    distance: z.number(),
    runId: z.uuid(),
    sequence: z.number().int().positive(),
  });
  const bestByRun = new Map<string, ChatSemanticMemoryHit>();
  for (const raw of rows) {
    const row = schema.parse(raw);
    const score = 1 - row.distance;
    const existing = bestByRun.get(row.runId);
    if (existing !== undefined && existing.score >= score) {
      continue;
    }
    bestByRun.set(row.runId, {
      runId: row.runId,
      score,
      sequence: row.sequence,
    });
  }
  return [...bestByRun.values()]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.sequence - left.sequence;
    })
    .slice(0, limit);
}

function toStoredCitation(
  citation: PublishedAnswerCitation,
  documentId: string,
  mediaType: string,
  createdAt: Date,
  sourceAvailable: boolean,
): StoredChatCitation {
  return {
    citationNumber: citation.citationNumber,
    createdAt: createdAt.toISOString(),
    documentId,
    documentVersionId: citation.documentVersionId,
    elementId: citation.elementId,
    evidence: citation.evidence,
    id: citation.id,
    mediaType,
    pageNumbers: citation.pageNumbers,
    regions: citation.regions,
    sectionPath: citation.sectionPath,
    sourceAvailable,
    sourceFile: citation.sourceFile,
  };
}
