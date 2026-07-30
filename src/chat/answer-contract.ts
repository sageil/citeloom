import { z } from "zod";

import {
  AnswerDraftDecodeError,
  decodeAnswerDraft,
  normalizeAnswerModelText,
  type AnswerDraftStatement,
  type EvidenceReference,
} from "../answers/draft.js";
import {
  NO_ANSWER_TEXT,
} from "../answers/published.js";
import type {
  AnswerResponseContract,
  AnswerResponseDecodeResult,
} from "../answers/inference.js";

const internalEvidenceReferencePattern = /\bEVID_[A-Z]+\b/u;

interface ChatGroundedPoint {
  content: string;
  evidenceRefs: EvidenceReference[];
}

interface ChatAnswerModelResponse {
  analysis: {
    criteria: ChatGroundedPoint[];
    disagreements: ChatGroundedPoint[];
    findings: ChatGroundedPoint[];
    limitations: ChatGroundedPoint[];
  };
  answer: ChatGroundedPoint;
  status: "answered" | "no_answer";
}

export const CHAT_ANSWER_RESPONSE_CONTRACT: AnswerResponseContract = {
  createSchema: createChatAnswerModelResponseSchema,
  decode: decodeChatAnswerModelResponse,
  description:
    "A private CiteLoom Chat answer with a direct answer, grounded analysis, and exact request-local evidence references.",
  name: "chat_answer",
};

function createChatAnswerModelResponseSchema(
  allowedEvidenceRefs: readonly EvidenceReference[],
): z.ZodType<unknown> {
  const evidenceReference = createEvidenceReferenceSchema(
    allowedEvidenceRefs,
  );
  const groundedPoint: z.ZodType<ChatGroundedPoint> = z.object({
    content: z.string().min(1),
    evidenceRefs: z.array(evidenceReference).min(1),
  }).strict();
  const answerPoint: z.ZodType<ChatGroundedPoint> = z.object({
    content: z.string(),
    evidenceRefs: z.array(evidenceReference),
  }).strict();
  return z.object({
    analysis: z.object({
      criteria: z.array(groundedPoint),
      disagreements: z.array(groundedPoint),
      findings: z.array(groundedPoint),
      limitations: z.array(groundedPoint),
    }).strict(),
    answer: answerPoint,
    status: z.enum(["answered", "no_answer"]),
  }).strict().superRefine((response, context) => {
    if (response.status === "answered") {
      if (response.answer.content.trim().length === 0) {
        context.addIssue({
          code: "custom",
          message: "An answered response requires direct answer content.",
          path: ["answer", "content"],
        });
      }
      if (response.answer.evidenceRefs.length === 0) {
        context.addIssue({
          code: "custom",
          message: "An answered response requires answer evidence references.",
          path: ["answer", "evidenceRefs"],
        });
      }
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
  if (response.status === "no_answer") {
    return {
      draft: { status: "no_answer" },
      noAnswerContent: normalizeNoAnswerContent(response.answer.content),
      verificationStatementIndexes: [],
    };
  }
  const statements: AnswerDraftStatement[] = [];
  statements.push(createDraftStatement(
    response.answer,
    "paragraph",
    "answer",
  ));
  appendAnalysisStatements(statements, response.analysis.criteria);
  const findingsStartIndex = statements.length;
  appendAnalysisStatements(statements, response.analysis.findings);
  const verificationStatementIndexes: number[] = [];
  for (
    let index = findingsStartIndex;
    index < statements.length;
    index += 1
  ) {
    verificationStatementIndexes.push(index);
  }
  appendAnalysisStatements(statements, response.analysis.limitations);
  appendAnalysisStatements(statements, response.analysis.disagreements);
  return {
    draft: decodeAnswerDraft(
      {
        conflictGroups: [],
        statements,
        status: "answered",
      },
      allowedEvidenceRefs,
    ),
    noAnswerContent: null,
    verificationStatementIndexes,
  };
}

function normalizeNoAnswerContent(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  if (
    normalized.length === 0
    || internalEvidenceReferencePattern.test(normalized)
  ) {
    return NO_ANSWER_TEXT;
  }
  return normalized;
}

function appendAnalysisStatements(
  statements: AnswerDraftStatement[],
  points: readonly ChatGroundedPoint[],
): void {
  for (const point of points) {
    statements.push(createDraftStatement(
      point,
      "bullet",
      "key-points",
    ));
  }
}

function createDraftStatement(
  point: ChatGroundedPoint,
  presentation: AnswerDraftStatement["presentation"],
  section: AnswerDraftStatement["section"],
): AnswerDraftStatement {
  return {
    content: normalizeAnswerModelText(point.content),
    evidenceRefs: [...point.evidenceRefs],
    presentation,
    section,
  };
}

function createEvidenceReferenceSchema(
  allowedEvidenceRefs: readonly EvidenceReference[],
) {
  const first = allowedEvidenceRefs[0];
  if (first === undefined) {
    throw new Error("Chat answer evidence references must not be empty.");
  }
  const uniqueReferences = new Set(allowedEvidenceRefs);
  if (uniqueReferences.size !== allowedEvidenceRefs.length) {
    throw new Error("Chat answer evidence references must be unique.");
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
    if (key === "evidenceRefs" && Array.isArray(item)) {
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
