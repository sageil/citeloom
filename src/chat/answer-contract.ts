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

interface ChatAnswerPoint {
  content: string;
  source_refs: EvidenceReference[];
}

interface ChatGroundedClaim {
  claim: string;
  source_refs: EvidenceReference[];
}

interface ChatAnswerModelResponse {
  answer: ChatAnswerPoint;
  findings: ChatGroundedClaim[];
}

export const CHAT_ANSWER_RESPONSE_CONTRACT: AnswerResponseContract = {
  createSchema: createChatAnswerModelResponseSchema,
  decode: decodeChatAnswerModelResponse,
  description:
    "A Chat response containing either a grounded answer with findings and source references or an uncited clarification question with no findings.",
  name: "chat_answer",
};

function createChatAnswerModelResponseSchema(
  allowedEvidenceRefs: readonly EvidenceReference[],
): z.ZodType<unknown> {
  const sourceReference = createSourceReferenceSchema(allowedEvidenceRefs);
  const groundedClaim: z.ZodType<ChatGroundedClaim> = z.object({
    claim: z.string().min(1),
    source_refs: z.array(sourceReference).min(1),
  }).strict();
  const answerPoint: z.ZodType<ChatAnswerPoint> = z.object({
    content: z.string().trim().min(1).describe(
      "The grounded answer, evidence limitation, or focused clarification question with meaningful options.",
    ),
    source_refs: z.array(sourceReference).describe(
      "Supporting source references for a grounded answer, or an empty array for a clarification or wholly unsupported response.",
    ),
  }).strict();
  return z.object({
    answer: answerPoint,
    findings: z.array(groundedClaim).describe(
      "Grounded findings for an answered response, or an empty array for a clarification or wholly unsupported response.",
    ),
  }).strict().superRefine((response, context) => {
    if (
      response.answer.source_refs.length === 0
      && response.findings.length > 0
    ) {
      context.addIssue({
        code: "custom",
        message: "An uncited response must not contain findings.",
        path: ["findings"],
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
  const findingsStartIndex = statements.length;
  appendGroundedClaims(statements, response.findings);
  const verificationStatementIndexes: number[] = [];
  for (
    let index = findingsStartIndex;
    index < statements.length;
    index += 1
  ) {
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

function appendGroundedClaims(
  statements: AnswerDraftStatement[],
  claims: readonly ChatGroundedClaim[],
): void {
  for (const claim of claims) {
    statements.push({
      content: normalizeAnswerModelText(claim.claim),
      evidenceRefs: normalizeSourceReferences(claim.source_refs),
      presentation: "bullet",
      section: "key-points",
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
