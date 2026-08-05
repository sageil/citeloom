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
import { formatAnswerTopicContent } from "../answers/topic-content.js";

interface ChatAnswerPoint {
  content: string;
  source_refs: EvidenceReference[];
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
    "A Chat response containing either a comprehensive grounded answer with optional topics and source references or an uncited clarification question.",
  name: "chat_answer",
};

function createChatAnswerModelResponseSchema(
  allowedEvidenceRefs: readonly EvidenceReference[],
): z.ZodType<unknown> {
  const sourceReference = createSourceReferenceSchema(allowedEvidenceRefs);
  const answerTopic: z.ZodType<ChatAnswerTopic> = z.object({
    content: z.string().trim().min(1).describe(
      "The grounded details for this topic without repeating the title.",
    ),
    source_refs: z.array(sourceReference).min(1).describe(
      "The smallest set of sources that directly supports this topic.",
    ),
    title: z.string().trim().min(1).describe(
      "A short descriptive title for this topic.",
    ),
  }).strict();
  const answerPoint: z.ZodType<ChatAnswerPoint> = z.object({
    content: z.string().trim().min(1).describe(
      "The substantive grounded answer content, including synthesis and qualifications that do not belong to one topic.",
    ),
    source_refs: z.array(sourceReference).describe(
      "Supporting source references for a grounded answer, or an empty array for a clarification or wholly unsupported response.",
    ),
    topics: z.array(answerTopic).describe(
      "Ordered topical sections for a multi-part or comprehensive answer, or an empty array for a concise or uncited response.",
    ),
  }).strict();
  return z.object({
    answer: answerPoint,
  }).strict().superRefine((response, context) => {
    if (
      response.answer.source_refs.length === 0
      && response.answer.topics.length > 0
    ) {
      context.addIssue({
        code: "custom",
        message: "An uncited response must not contain topics.",
        path: ["answer"],
      });
    }
  });
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
  if (response.answer.source_refs.length === 0) {
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
  const verificationStatementIndexes: number[] = [];
  for (let index = 1; index < statements.length; index += 1) {
    verificationStatementIndexes.push(index);
  }
  return {
    draft: decodeAnswerDraft(
      {
        conflictGroups: [],
        statements,
        status: "answered",
      },
      allowedEvidenceRefs,
    ),
    verificationStatementIndexes,
  };
}

function appendAnswerTopics(
  statements: AnswerDraftStatement[],
  topics: readonly ChatAnswerTopic[],
): void {
  for (const topic of topics) {
    statements.push({
      content: formatAnswerTopicContent(topic.title, topic.content),
      evidenceRefs: normalizeSourceReferences(topic.source_refs),
      presentation: "bullet",
      section: "answer",
    });
  }
}

function createAnswerStatement(
  answer: ChatAnswerPoint,
): AnswerDraftStatement {
  return {
    content: normalizeAnswerModelText(answer.content),
    evidenceRefs: normalizeSourceReferences(answer.source_refs),
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
