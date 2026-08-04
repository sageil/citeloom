import { z } from "zod";

export const ANSWER_SECTIONS = [
  "answer",
  "key-points",
  "conflicting-evidence",
] as const;

export const ANSWER_DRAFT_SECTIONS = [
  "answer",
  "key-points",
] as const;

export const ANSWER_PRESENTATIONS = ["paragraph", "bullet"] as const;

const numericCitationDecorationPattern = /(?:[\[【]\s*\d+(?:\s*(?:,|-|\u2013|to)\s*\d+)*\s*[\]】]|\(\s*(?:citation|source)s?\s*#?\s*\d+(?:\s*(?:,|-|\u2013|to)\s*\d+)*\s*\)|\b(?:citation|source)s?\s*#?\s*\d+(?:\s*(?:,|-|\u2013|to)\s*\d+)*\b)/gi;
const evidenceReferenceDecorationPattern = /(?:[\[【]\s*EVID_[A-Z]+(?:\s*(?:,|-|\u2013|to)\s*EVID_[A-Z]+)*\s*[\]】]|\(\s*(?:evidence\s+)?references?\s*EVID_[A-Z]+(?:\s*(?:,|-|\u2013|to)\s*EVID_[A-Z]+)*\s*\)|\b(?:evidence\s+)?references?\s*EVID_[A-Z]+(?:\s*(?:,|-|\u2013|to)\s*EVID_[A-Z]+)*\b)/gi;
export const answerSectionSchema = z.enum(ANSWER_SECTIONS);
export const answerDraftSectionSchema = z.enum(ANSWER_DRAFT_SECTIONS);
export const answerPresentationSchema = z.enum(ANSWER_PRESENTATIONS);
export const answerStatementContentSchema = z.string()
  .trim()
  .min(1);

const answerModelContentSchema = z.string();

export type AnswerSection = z.output<typeof answerSectionSchema>;
export type AnswerDraftSection = z.output<typeof answerDraftSectionSchema>;
export type AnswerPresentation = z.output<typeof answerPresentationSchema>;
export type EvidenceReference = string;

export interface AnswerDraftStatement {
  content: string;
  evidenceRefs: EvidenceReference[];
  presentation: AnswerPresentation;
  section: AnswerDraftSection;
}

export interface AnswerDraftConflictPosition {
  claim: string;
  evidenceRefs: EvidenceReference[];
}

export interface AnswerDraftConflictScope {
  conditions: string;
  context: string;
  scope: string;
  timePeriod: string;
}

export interface AnswerDraftConflictGroup {
  explanation: string;
  positions: AnswerDraftConflictPosition[];
  sharedScope: AnswerDraftConflictScope;
}

export type AnswerDraft =
  | {
    content: string;
    status: "uncited";
  }
  | {
    conflictGroups: AnswerDraftConflictGroup[];
    statements: AnswerDraftStatement[];
    status: "answered";
  };

interface AnswerModelStatement {
  content: string;
  evidenceRefs: EvidenceReference[];
}

interface AnswerModelResponse {
  answer: AnswerModelStatement;
  findings: AnswerModelStatement[];
}

interface AnswerSchemaParts {
  conflictGroups: z.ZodType<AnswerDraftConflictGroup[]>;
  statements: z.ZodType<AnswerDraftStatement[]>;
}

interface AnswerStatementFieldSchemas {
  presentation: z.ZodType<AnswerPresentation>;
  section: z.ZodType<AnswerDraftSection>;
}

export interface AnswerDraftValidationIssue {
  message: string;
  path: string;
}

export class AnswerDraftDecodeError extends Error {
  public constructor(
    message: string,
    public readonly failureCategory:
      | "invalid-content"
      | "invalid-structure"
      | "unknown-evidence-reference",
    public readonly issues: AnswerDraftValidationIssue[],
    public readonly unknownReferenceCount: number,
  ) {
    super(message);
    this.name = "AnswerDraftDecodeError";
  }
}

export function createEvidenceReferences(count: number): EvidenceReference[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("Answer evidence requires at least one retrieved element.");
  }
  const references: EvidenceReference[] = [];
  for (let index = 0; index < count; index += 1) {
    references.push(`EVID_${createAlphabeticLabel(index)}`);
  }
  return references;
}

export function createAnswerDraftSchema(
  allowedEvidenceRefs: readonly EvidenceReference[],
): z.ZodType<AnswerDraft> {
  return buildAnswerDraftSchema(
    allowedEvidenceRefs,
    false,
    answerStatementContentSchema,
  );
}

export function createAnswerModelResponseSchema(
  allowedEvidenceRefs: readonly EvidenceReference[],
): z.ZodType<AnswerModelResponse> {
  const evidenceReferenceSchema = createEvidenceReferenceSchema(
    allowedEvidenceRefs,
  );
  const evidenceReferencesSchema = z.array(evidenceReferenceSchema).min(1);
  const answerSchema: z.ZodType<AnswerModelStatement> = z.object({
    content: answerModelContentSchema,
    evidenceRefs: z.array(evidenceReferenceSchema),
  }).strict();
  const statementSchema: z.ZodType<AnswerModelStatement> = z.object({
    content: answerModelContentSchema,
    evidenceRefs: evidenceReferencesSchema,
  });
  return z.object({
    answer: answerSchema,
    findings: z.array(statementSchema),
  }).strict().superRefine((response, context) => {
    const hasDirectAnswer = hasAnswerText(response.answer.content);
    const hasAnswerEvidence = response.answer.evidenceRefs.length > 0;
    if (!hasAnswerEvidence) {
      if (response.findings.length > 0) {
        context.addIssue({
          code: "custom",
          message: "A response without answer evidence must not contain findings.",
          path: ["findings"],
        });
      }
      if (!hasDirectAnswer) {
        context.addIssue({
          code: "custom",
          message: "An uncited response must explain what the source material does not establish.",
          path: ["answer", "content"],
        });
      }
      return;
    }
    if (!hasDirectAnswer) {
      context.addIssue({
        code: "custom",
        message: "A cited direct answer must contain plain-text content.",
        path: ["answer", "content"],
      });
    }
  });
}

function buildAnswerDraftSchema(
  allowedEvidenceRefs: readonly EvidenceReference[],
  allowLegacyConflictGroupOmission: boolean,
  modelContentSchema: z.ZodType<string>,
): z.ZodType<AnswerDraft> {
  const parts = buildAnswerSchemaParts(
    allowedEvidenceRefs,
    modelContentSchema,
    {
      presentation: answerPresentationSchema,
      section: answerDraftSectionSchema,
    },
  );
  let conflictGroupsSchema = parts.conflictGroups;
  if (allowLegacyConflictGroupOmission) {
    conflictGroupsSchema = conflictGroupsSchema.default([]);
  }
  const schema = z.discriminatedUnion("status", [
    z.object({
      content: answerStatementContentSchema,
      status: z.literal("uncited"),
    }).strict(),
    z.object({
      status: z.literal("answered"),
      statements: parts.statements,
      conflictGroups: conflictGroupsSchema,
    }).strict(),
  ]).superRefine((draft, context) => {
    if (
      draft.status === "answered"
      && countAnswerContent(draft.statements, draft.conflictGroups) === 0
    ) {
      context.addIssue({
        code: "custom",
        message: "An answered draft must contain a statement or conflict group.",
        path: ["statements"],
      });
    }
  });
  return schema as z.ZodType<AnswerDraft>;
}

function buildAnswerSchemaParts(
  allowedEvidenceRefs: readonly EvidenceReference[],
  modelContentSchema: z.ZodType<string>,
  statementFields: AnswerStatementFieldSchemas,
): AnswerSchemaParts {
  const evidenceReferenceSchema = createEvidenceReferenceSchema(
    allowedEvidenceRefs,
  );
  const evidenceReferencesSchema = z.array(evidenceReferenceSchema).min(1);
  const statementSchema: z.ZodType<AnswerDraftStatement> = z.object({
    content: modelContentSchema,
    evidenceRefs: evidenceReferencesSchema,
    presentation: statementFields.presentation,
    section: statementFields.section,
  }).strict();
  return {
    conflictGroups: buildAnswerConflictGroupsSchema(
      evidenceReferencesSchema,
      modelContentSchema,
    ),
    statements: z.array(statementSchema),
  };
}

function buildAnswerConflictGroupsSchema(
  evidenceReferencesSchema: z.ZodType<EvidenceReference[]>,
  modelContentSchema: z.ZodType<string>,
): z.ZodType<AnswerDraftConflictGroup[]> {
  const conflictPositionSchema: z.ZodType<AnswerDraftConflictPosition> = z.object({
    claim: modelContentSchema,
    evidenceRefs: evidenceReferencesSchema,
  }).strict();
  const conflictGroupSchema: z.ZodType<AnswerDraftConflictGroup> = z.object({
    explanation: modelContentSchema,
    positions: z.array(conflictPositionSchema).min(2),
    sharedScope: z.object({
      conditions: modelContentSchema,
      context: modelContentSchema,
      scope: modelContentSchema,
      timePeriod: modelContentSchema,
    }).strict(),
  }).strict().superRefine((group, context) => {
    const claims = new Set<string>();
    for (let index = 0; index < group.positions.length; index += 1) {
      const position = group.positions[index];
      if (position === undefined) {
        continue;
      }
      const normalizedClaim = position.claim.toLocaleLowerCase();
      if (claims.has(normalizedClaim)) {
        context.addIssue({
          code: "custom",
          message: "Conflict positions must make distinct claims.",
          path: ["positions", index, "claim"],
        });
      }
      claims.add(normalizedClaim);
    }
  });
  return z.array(conflictGroupSchema);
}

function countAnswerContent(
  statements: readonly unknown[],
  conflictGroups: readonly AnswerDraftConflictGroup[],
): number {
  let statementCount = statements.length;
  for (const group of conflictGroups) {
    statementCount += group.positions.length + 2;
  }
  return statementCount;
}

export function renderAnswerDraftConflictScope(
  scope: AnswerDraftConflictScope,
): string {
  return [
    `Shared scope - context: ${scope.context}`,
    `scope: ${scope.scope}`,
    `conditions: ${scope.conditions}`,
    `time period: ${scope.timePeriod}.`,
  ].join("; ");
}

export function decodeAnswerDraft(
  value: unknown,
  allowedEvidenceRefs: readonly EvidenceReference[],
): AnswerDraft {
  const result = buildAnswerDraftSchema(
    allowedEvidenceRefs,
    true,
    answerStatementContentSchema,
  ).safeParse(value);
  if (!result.success) {
    throw createAnswerDraftDecodeError(
      "Invalid answer draft",
      result.error.issues,
      value,
      allowedEvidenceRefs,
    );
  }
  return result.data;
}

export function decodeAnswerModelResponse(
  value: unknown,
  allowedEvidenceRefs: readonly EvidenceReference[],
): AnswerDraft {
  const modelResult = createAnswerModelResponseSchema(
    allowedEvidenceRefs,
  ).safeParse(value);
  if (!modelResult.success) {
    throw createAnswerDraftDecodeError(
      "Invalid answer model response",
      modelResult.error.issues,
      value,
      allowedEvidenceRefs,
    );
  }
  if (modelResult.data.answer.evidenceRefs.length === 0) {
    const content = readNormalizedModelText(modelResult.data.answer.content);
    if (content === null) {
      throw new AnswerDraftDecodeError(
        "Invalid answer model response: an uncited response requires content.",
        "invalid-content",
        [{
          message: "An uncited response must explain what the source material does not establish.",
          path: "answer.content",
        }],
        0,
      );
    }
    return { content, status: "uncited" };
  }

  const normalized = structuredClone(modelResult.data);
  const answerContent = readNormalizedModelText(normalized.answer.content);
  if (answerContent === null) {
    throw new AnswerDraftDecodeError(
      "Invalid answer model response: no valid direct answer remained.",
      "invalid-content",
      [{
        message: "An answered response must contain a valid plain-text direct answer.",
        path: "answer.content",
      }],
      0,
    );
  }
  const normalizedFindings: AnswerModelStatement[] = [];
  for (const finding of normalized.findings) {
    const content = readNormalizedModelText(finding.content);
    if (content === null) {
      continue;
    }
    normalizedFindings.push({
      content,
      evidenceRefs: uniqueEvidenceReferences(finding.evidenceRefs),
    });
  }
  const statements: AnswerDraftStatement[] = [{
    content: answerContent,
    evidenceRefs: uniqueEvidenceReferences(normalized.answer.evidenceRefs),
    presentation: "paragraph",
    section: "answer",
  }];
  for (const finding of normalizedFindings) {
    statements.push({
      ...finding,
      presentation: "bullet",
      section: "key-points",
    });
  }
  return {
    conflictGroups: [],
    statements,
    status: "answered",
  };
}

function readNormalizedModelText(value: string): string | null {
  const normalized = normalizeAnswerModelText(value);
  if (normalized.length === 0) {
    return null;
  }
  return normalized;
}

function uniqueEvidenceReferences(
  evidenceRefs: readonly EvidenceReference[],
): EvidenceReference[] {
  const unique: EvidenceReference[] = [];
  const seen = new Set<EvidenceReference>();
  for (const evidenceRef of evidenceRefs) {
    if (seen.has(evidenceRef)) {
      continue;
    }
    seen.add(evidenceRef);
    unique.push(evidenceRef);
  }
  return unique;
}

export function normalizeAnswerModelText(value: string): string {
  const withoutNumericCitations = value.replace(
    numericCitationDecorationPattern,
    " ",
  );
  const withoutCitationDecorations = withoutNumericCitations.replace(
    evidenceReferenceDecorationPattern,
    " ",
  );
  return withoutCitationDecorations
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/ +$/gmu, "")
    .replace(/^ *\((\d+)\) +/gmu, "$1. ")
    .replace(/ +([,.;:!?])/g, "$1")
    .replace(/[,;:]+([.!?])/g, "$1")
    .trim();
}

function createEvidenceReferenceSchema(
  allowedEvidenceRefs: readonly EvidenceReference[],
) {
  const first = allowedEvidenceRefs[0];
  if (first === undefined) {
    throw new Error("Answer evidence references must not be empty.");
  }
  const uniqueReferences = new Set(allowedEvidenceRefs);
  if (uniqueReferences.size !== allowedEvidenceRefs.length) {
    throw new Error("Answer evidence references must be unique.");
  }
  return z.enum([first, ...allowedEvidenceRefs.slice(1)]);
}

function createAlphabeticLabel(index: number): string {
  let remaining = index;
  let label = "";
  do {
    label = String.fromCharCode(65 + (remaining % 26)) + label;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return label;
}

function hasAnswerText(value: string): boolean {
  return value.trim().length > 0;
}

function createAnswerDraftDecodeError(
  label: string,
  issues: readonly {
    code: string;
    message: string;
    path: PropertyKey[];
  }[],
  value: unknown,
  allowedEvidenceRefs: readonly EvidenceReference[],
): AnswerDraftDecodeError {
  const allowed = new Set(allowedEvidenceRefs);
  const unknownReferenceCount = countUnknownEvidenceReferences(value, allowed);
  const failureCategory = unknownReferenceCount > 0
    ? "unknown-evidence-reference"
    : "invalid-structure";
  const validationIssues: AnswerDraftValidationIssue[] = [];
  for (const issue of issues) {
    validationIssues.push({
      message: readShortValidationMessage(issue, failureCategory),
      path: formatValidationPath(issue.path),
    });
  }
  return new AnswerDraftDecodeError(
    `${label}: ${formatValidationIssues(validationIssues)}`,
    failureCategory,
    validationIssues,
    unknownReferenceCount,
  );
}

function readShortValidationMessage(
  issue: { code: string; message: string },
  failureCategory: AnswerDraftDecodeError["failureCategory"],
): string {
  if (failureCategory === "unknown-evidence-reference") {
    return "must contain only allowed evidence references";
  }
  if (issue.code === "unrecognized_keys") {
    return "contains fields that are not allowed";
  }
  return issue.message;
}

function formatValidationIssues(
  issues: readonly AnswerDraftValidationIssue[],
): string {
  if (issues.length === 0) {
    return "the response does not match the required structure.";
  }
  return issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");
}

function formatValidationPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "$";
  }
  let formatted = "";
  for (const part of path) {
    if (typeof part === "number") {
      formatted += `[${part}]`;
      continue;
    }
    const name = String(part);
    formatted += formatted === "" ? name : `.${name}`;
  }
  return formatted;
}

function countUnknownEvidenceReferences(
  value: unknown,
  allowedEvidenceRefs: ReadonlySet<EvidenceReference>,
): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return 0;
  }
  let count = 0;
  const response = value as {
    answer?: unknown;
    conflictGroups?: unknown;
    findings?: unknown;
    statements?: unknown;
  };
  count += countUnknownAnswerPointReferences(
    response.answer,
    allowedEvidenceRefs,
  );
  count += countUnknownStatementReferences(
    response.findings,
    allowedEvidenceRefs,
  );
  count += countUnknownStatementReferences(
    response.statements,
    allowedEvidenceRefs,
  );
  if (!Array.isArray(response.conflictGroups)) {
    return count;
  }
  for (const group of response.conflictGroups) {
    if (typeof group !== "object" || group === null || Array.isArray(group)) {
      continue;
    }
    const positions = (group as { positions?: unknown }).positions;
    count += countUnknownStatementReferences(
      positions,
      allowedEvidenceRefs,
    );
  }
  return count;
}

function countUnknownAnswerPointReferences(
  value: unknown,
  allowedEvidenceRefs: ReadonlySet<EvidenceReference>,
): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return 0;
  }
  const evidenceRefs = (value as { evidenceRefs?: unknown }).evidenceRefs;
  return countUnknownReferenceValues(evidenceRefs, allowedEvidenceRefs);
}

function countUnknownStatementReferences(
  value: unknown,
  allowedEvidenceRefs: ReadonlySet<EvidenceReference>,
): number {
  if (!Array.isArray(value)) {
    return 0;
  }
  let count = 0;
  for (const statement of value) {
    if (
      typeof statement !== "object"
      || statement === null
      || Array.isArray(statement)
    ) {
      continue;
    }
    const evidenceRefs = (statement as { evidenceRefs?: unknown }).evidenceRefs;
    count += countUnknownReferenceValues(evidenceRefs, allowedEvidenceRefs);
  }
  return count;
}

function countUnknownReferenceValues(
  value: unknown,
  allowedEvidenceRefs: ReadonlySet<EvidenceReference>,
): number {
  if (!Array.isArray(value)) {
    return 0;
  }
  let count = 0;
  for (const evidenceRef of value) {
    if (
      typeof evidenceRef === "string"
      && !allowedEvidenceRefs.has(evidenceRef)
    ) {
      count += 1;
    }
  }
  return count;
}
