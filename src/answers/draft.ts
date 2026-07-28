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

const modelCitationDecorationPattern = /(?:[\[【]\s*\d+(?:\s*(?:,|-|\u2013|to)\s*\d+)*\s*[\]】]|\(\s*(?:citation|source)s?\s*#?\s*\d+(?:\s*(?:,|-|\u2013|to)\s*\d+)*\s*\)|\b(?:citation|source)s?\s*#?\s*\d+(?:\s*(?:,|-|\u2013|to)\s*\d+)*\b)/gi;
const htmlTagPattern = /<\/?[A-Za-z][^>]*>/;
const markdownLinkPattern = /!?\[[^\]]*\]\([^)]*\)/;
const markdownBlockPattern = /^(?:\s{0,3}(?:#{1,6}|>|\||[-+*]\s|\d+[.)]\s|```|~~~))/;
const markdownInlineDelimiterPattern = /(?:__|~~|_[^_]+_)/;

export const answerSectionSchema = z.enum(ANSWER_SECTIONS);
export const answerDraftSectionSchema = z.enum(ANSWER_DRAFT_SECTIONS);
export const answerPresentationSchema = z.enum(ANSWER_PRESENTATIONS);
export const answerStatementContentSchema = z.string()
  .min(1)
  .refine((value) => value === value.trim(), "must not have surrounding whitespace")
  .refine((value) => !/[\r\n]/.test(value), "must be one plain-text line")
  .refine((value) => !htmlTagPattern.test(value), "must not contain HTML")
  .refine((value) => !markdownLinkPattern.test(value), "must not contain Markdown links")
  .refine((value) => !markdownBlockPattern.test(value), "must not contain Markdown blocks")
  .refine((value) => !value.includes("*"), "must not contain Markdown emphasis delimiters")
  .refine((value) => !markdownInlineDelimiterPattern.test(value), "must not contain Markdown inline delimiters")
  .refine((value) => !value.includes("`"), "must not contain Markdown code delimiters");

const answerModelContentSchema = z.string();

export type AnswerSection = z.output<typeof answerSectionSchema>;
export type AnswerDraftSection = z.output<typeof answerDraftSectionSchema>;
export type AnswerPresentation = z.output<typeof answerPresentationSchema>;

export interface AnswerDraftStatement {
  content: string;
  presentation: AnswerPresentation;
  section: AnswerDraftSection;
  sourceNumbers: number[];
}

export interface AnswerDraftConflictPosition {
  claim: string;
  sourceNumbers: number[];
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
  | { status: "no_answer" }
  | {
    conflictGroups: AnswerDraftConflictGroup[];
    statements: AnswerDraftStatement[];
    status: "answered";
  };

interface AnswerModelResponse {
  conflictGroups: AnswerDraftConflictGroup[];
  statements: AnswerDraftStatement[];
  status: "answered" | "no_answer";
}

interface AnswerSchemaParts {
  conflictGroups: z.ZodType<AnswerDraftConflictGroup[]>;
  statements: z.ZodType<AnswerDraftStatement[]>;
}

export class AnswerDraftDecodeError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AnswerDraftDecodeError";
  }
}

export function createAnswerDraftSchema(
  sourceCount: number,
): z.ZodType<AnswerDraft> {
  return buildAnswerDraftSchema(
    sourceCount,
    false,
    answerStatementContentSchema,
  );
}

export function createAnswerModelResponseSchema(
  sourceCount: number,
): z.ZodType<AnswerModelResponse> {
  const parts = buildAnswerSchemaParts(
    sourceCount,
    answerModelContentSchema,
  );
  return z.object({
    conflictGroups: parts.conflictGroups,
    statements: parts.statements,
    status: z.enum(["answered", "no_answer"]),
  }).strict().superRefine((response, context) => {
    if (response.status === "no_answer") {
      if (response.statements.length > 0) {
        context.addIssue({
          code: "custom",
          message: "A no-answer response must not contain statements.",
          path: ["statements"],
        });
      }
      if (response.conflictGroups.length > 0) {
        context.addIssue({
          code: "custom",
          message: "A no-answer response must not contain conflict groups.",
          path: ["conflictGroups"],
        });
      }
      return;
    }
    if (countAnswerContent(response.statements, response.conflictGroups) === 0) {
      context.addIssue({
        code: "custom",
        message: "An answered draft must contain a statement or conflict group.",
        path: ["statements"],
      });
    }
  });
}

function buildAnswerDraftSchema(
  sourceCount: number,
  allowLegacyConflictGroupOmission: boolean,
  modelContentSchema: z.ZodType<string>,
): z.ZodType<AnswerDraft> {
  const parts = buildAnswerSchemaParts(sourceCount, modelContentSchema);
  let conflictGroupsSchema = parts.conflictGroups;
  if (allowLegacyConflictGroupOmission) {
    conflictGroupsSchema = conflictGroupsSchema.default([]);
  }
  const schema = z.discriminatedUnion("status", [
    z.object({ status: z.literal("no_answer") }).strict(),
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
  sourceCount: number,
  modelContentSchema: z.ZodType<string>,
): AnswerSchemaParts {
  if (!Number.isInteger(sourceCount) || sourceCount < 1) {
    throw new Error("Answer draft decoding requires at least one source.");
  }
  const sourceNumbersSchema = z.array(
    z.number().int().min(1).max(sourceCount),
  ).min(1);
  const statementSchema: z.ZodType<AnswerDraftStatement> = z.object({
    content: modelContentSchema,
    presentation: answerPresentationSchema,
    section: answerDraftSectionSchema,
    sourceNumbers: sourceNumbersSchema,
  }).strict();
  const conflictPositionSchema: z.ZodType<AnswerDraftConflictPosition> = z.object({
    claim: modelContentSchema,
    sourceNumbers: sourceNumbersSchema,
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
  return {
    conflictGroups: z.array(conflictGroupSchema),
    statements: z.array(statementSchema),
  };
}

function countAnswerContent(
  statements: readonly AnswerDraftStatement[],
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
  sourceCount: number,
): AnswerDraft {
  const result = buildAnswerDraftSchema(
    sourceCount,
    true,
    answerStatementContentSchema,
  ).safeParse(value);
  if (!result.success) {
    throw new AnswerDraftDecodeError(`Invalid answer draft: ${result.error.message}`);
  }
  return result.data;
}

export function decodeAnswerModelResponse(
  value: unknown,
  sourceCount: number,
): AnswerDraft {
  const modelResult = createAnswerModelResponseSchema(sourceCount).safeParse(value);
  if (!modelResult.success) {
    throw new AnswerDraftDecodeError(`Invalid answer model response: ${modelResult.error.message}`);
  }
  if (modelResult.data.status === "no_answer") {
    return { status: "no_answer" };
  }

  const normalized = structuredClone(modelResult.data);
  const statements: AnswerDraftStatement[] = [];
  for (const statement of normalized.statements) {
    const content = readCanonicalModelText(statement.content);
    if (content === null) {
      continue;
    }
    statement.content = content;
    statement.sourceNumbers = uniqueSourceNumbers(statement.sourceNumbers);
    statements.push(statement);
  }
  normalized.statements = statements;
  const conflictGroups: AnswerDraftConflictGroup[] = [];
  for (const group of normalized.conflictGroups) {
    group.explanation = normalizeModelText(group.explanation);
    group.sharedScope.conditions = normalizeModelText(group.sharedScope.conditions);
    group.sharedScope.context = normalizeModelText(group.sharedScope.context);
    group.sharedScope.scope = normalizeModelText(group.sharedScope.scope);
    group.sharedScope.timePeriod = normalizeModelText(group.sharedScope.timePeriod);
    for (const position of group.positions) {
      position.claim = normalizeModelText(position.claim);
      position.sourceNumbers = uniqueSourceNumbers(position.sourceNumbers);
    }
    if (modelNormalizationInvalidatedConflictGroup(group)) {
      continue;
    }
    conflictGroups.push(group);
  }
  normalized.conflictGroups = conflictGroups;
  return decodeAnswerDraft(normalized, sourceCount);
}

function modelNormalizationInvalidatedConflictGroup(
  group: AnswerDraftConflictGroup,
): boolean {
  const groupText = [
    group.explanation,
    group.sharedScope.conditions,
    group.sharedScope.context,
    group.sharedScope.scope,
    group.sharedScope.timePeriod,
  ];
  for (const value of groupText) {
    if (!answerStatementContentSchema.safeParse(value).success) {
      return true;
    }
  }
  const claims = new Set<string>();
  for (const position of group.positions) {
    if (!answerStatementContentSchema.safeParse(position.claim).success) {
      return true;
    }
    const claim = position.claim.toLocaleLowerCase();
    if (claims.has(claim)) {
      return true;
    }
    claims.add(claim);
  }
  return false;
}

function readCanonicalModelText(value: string): string | null {
  const normalized = normalizeModelText(value);
  if (!answerStatementContentSchema.safeParse(normalized).success) {
    return null;
  }
  return normalized;
}

function uniqueSourceNumbers(sourceNumbers: readonly number[]): number[] {
  const unique: number[] = [];
  const seen = new Set<number>();
  for (const sourceNumber of sourceNumbers) {
    if (seen.has(sourceNumber)) {
      continue;
    }
    seen.add(sourceNumber);
    unique.push(sourceNumber);
  }
  return unique;
}

function normalizeModelText(value: string): string {
  const withoutCitationDecorations = value.replace(
    modelCitationDecorationPattern,
    " ",
  );
  return withoutCitationDecorations
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/[,;:]+([.!?])/g, "$1")
    .trim();
}
