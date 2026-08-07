import { z } from "zod";

import {
  AnswerDraftDecodeError,
  decodeAnswerDraft,
  normalizeAnswerModelText,
  type AnswerDraftStatement,
  type EvidenceReference,
} from "../answers/draft.js";
import type {
  AnswerResponseContract,
  AnswerResponseDecodeResult,
} from "../answers/inference.js";
import { readAtomicAnswerStatements } from "../answers/atomic-statements.js";
import { formatAnswerTopicContent } from "../answers/topic-content.js";

interface ChatAnswerPoint {
  content: string;
  topics: ChatAnswerTopic[];
}

interface ChatAnswerTopic {
  content: string;
  source_refs: EvidenceReference[];
  title: string;
}

interface ChatAnswerModelResponse {
  answer: ChatAnswerPoint;
}

export const CHAT_ANSWER_RESPONSE: AnswerResponseContract = {
  createSchema: createChatAnswerModelResponseSchema,
  decode: decodeChatAnswerModelResponse,
  description:
    "A Chat response containing either a comprehensive grounded answer with required topics and source references or an uncited greeting, clarification question, or evidence limitation.",
  name: "chat_answer",
};

function createChatAnswerModelResponseSchema(
  allowedEvidenceRefs: readonly EvidenceReference[],
): z.ZodType<unknown> {
  const uncitedAnswerPoint = createUncitedChatAnswerPointSchema();
  if (allowedEvidenceRefs.length === 0) {
    return z.object({
      answer: uncitedAnswerPoint,
    }).strict();
  }
  const sourceReference = createSourceReferenceSchema(allowedEvidenceRefs);
  const answerTopic = createChatAnswerTopicSchema(sourceReference);
  const groundedAnswerPoint: z.ZodType<ChatAnswerPoint> = z.object({
    content: z.string().trim().min(1).describe(
      "The substantive answer content containing cross-topic synthesis and answer-level qualifications derived from the supplied evidence.",
    ),
    topics: z.array(answerTopic).min(1).describe(
      "One or more ordered findings that contain the independently verifiable details of the grounded answer.",
    ),
  }).strict();
  return z.object({
    answer: z.union([groundedAnswerPoint, uncitedAnswerPoint]),
  }).strict();
}

function createUncitedChatAnswerPointSchema(): z.ZodType<ChatAnswerPoint> {
  const answerTopic = createChatAnswerTopicSchema(z.string());
  return z.object({
    content: z.string().trim().min(1).describe(
      "A greeting, clarification question, or explanation of what the supplied evidence does not establish.",
    ),
    topics: z.array(answerTopic).max(0).describe(
      "An empty array because this response makes no grounded factual claims.",
    ),
  }).strict();
}

function createChatAnswerTopicSchema(
  sourceReference: z.ZodType<EvidenceReference>,
): z.ZodType<ChatAnswerTopic> {
  return z.object({
    content: z.string().trim().min(1).describe(
      "Exactly one independently verifiable grounded factual statement for this topic, without repeating the title.",
    ),
    source_refs: z.array(sourceReference).min(1).describe(
      "The smallest set of sources that directly supports this topic.",
    ),
    title: z.string().trim().min(1).describe(
      "A short descriptive title for this topic.",
    ),
  }).strict();
}

function decodeChatAnswerModelResponse(
  value: unknown,
  allowedEvidenceRefs: readonly EvidenceReference[],
): AnswerResponseDecodeResult {
  const result = createChatAnswerModelResponseSchema(
    allowedEvidenceRefs,
  ).safeParse(value);
  if (!result.success) {
    throw createChatAnswerDecodeError(
      result.error.issues,
      value,
      allowedEvidenceRefs,
    );
  }
  const response = result.data as ChatAnswerModelResponse;
  if (response.answer.topics.length === 0) {
    return {
      draft: {
        content: normalizeAnswerModelText(response.answer.content),
        status: "uncited",
      },
      verificationStatementIndexes: [],
    };
  }
  const statements: AnswerDraftStatement[] = [];
  statements.push(createAnswerStatement(response.answer));
  appendAnswerTopics(statements, response.answer.topics);
  const draft = decodeAnswerDraft(
    {
      conflictGroups: [],
      statements,
      status: "answered",
    },
    allowedEvidenceRefs,
  );
  return {
    draft,
    verificationStatementIndexes: null,
  };
}

function appendAnswerTopics(
  statements: AnswerDraftStatement[],
  topics: readonly ChatAnswerTopic[],
): void {
  for (const topic of topics) {
    const normalizedContent = normalizeAnswerModelText(topic.content);
    const atomicStatements = readAtomicAnswerStatements(normalizedContent);
    const evidenceRefs = normalizeSourceReferences(topic.source_refs);
    for (const atomicStatement of atomicStatements) {
      statements.push({
        content: formatAnswerTopicContent(topic.title, atomicStatement),
        evidenceRefs,
        presentation: "bullet",
        section: "answer",
      });
    }
  }
}

function createAnswerStatement(
  answer: ChatAnswerPoint,
): AnswerDraftStatement {
  return {
    content: normalizeAnswerModelText(answer.content),
    evidenceRefs: [],
    presentation: "paragraph",
    section: "answer",
  };
}

function normalizeSourceReferences(
  sourceReferences: readonly EvidenceReference[],
): EvidenceReference[] {
  const normalized: EvidenceReference[] = [];
  const seen = new Set<EvidenceReference>();
  for (const sourceReference of sourceReferences) {
    if (seen.has(sourceReference)) {
      continue;
    }
    seen.add(sourceReference);
    normalized.push(sourceReference);
  }
  return normalized;
}

function createSourceReferenceSchema(
  allowedEvidenceRefs: readonly EvidenceReference[],
) {
  const first = allowedEvidenceRefs[0];
  if (first === undefined) {
    throw new Error("Chat answer source references must not be empty.");
  }
  const uniqueReferences = new Set(allowedEvidenceRefs);
  if (uniqueReferences.size !== allowedEvidenceRefs.length) {
    throw new Error("Chat answer source references must be unique.");
  }
  return z.enum([first, ...allowedEvidenceRefs.slice(1)]);
}

function createChatAnswerDecodeError(
  issues: readonly z.core.$ZodIssue[],
  value: unknown,
  allowedEvidenceRefs: readonly EvidenceReference[],
): AnswerDraftDecodeError {
  const allowed = new Set(allowedEvidenceRefs);
  const unknownReferenceCount = countUnknownEvidenceReferences(
    value,
    allowed,
  );
  const failureCategory = unknownReferenceCount > 0
    ? "unknown-evidence-reference"
    : "invalid-structure";
  const validationIssues = [];
  for (const issue of issues) {
    validationIssues.push({
      message: failureCategory === "unknown-evidence-reference"
        ? "must contain only allowed evidence references"
        : issue.message,
      path: formatIssuePath(issue.path),
    });
  }
  return new AnswerDraftDecodeError(
    "Invalid Chat answer model response.",
    failureCategory,
    validationIssues,
    unknownReferenceCount,
  );
}

function countUnknownEvidenceReferences(
  value: unknown,
  allowedEvidenceRefs: ReadonlySet<EvidenceReference>,
): number {
  if (Array.isArray(value)) {
    let count = 0;
    for (const item of value) {
      count += countUnknownEvidenceReferences(item, allowedEvidenceRefs);
    }
    return count;
  }
  if (value === null || typeof value !== "object") {
    return 0;
  }
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (key === "source_refs" && Array.isArray(item)) {
      for (const evidenceRef of item) {
        if (
          typeof evidenceRef === "string"
          && !allowedEvidenceRefs.has(evidenceRef)
        ) {
          count += 1;
        }
      }
      continue;
    }
    count += countUnknownEvidenceReferences(item, allowedEvidenceRefs);
  }
  return count;
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  let formatted = "$";
  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
      continue;
    }
    formatted += `.${String(segment)}`;
  }
  return formatted;
}
