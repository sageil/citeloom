import { z } from "zod";

import {
  ANSWER_SECTIONS,
  answerPresentationSchema,
  answerSectionSchema,
  answerStatementContentSchema,
  type AnswerPresentation,
  type AnswerSection,
} from "./draft.js";
import type { CitationEvidence } from "../research/types.js";
import type { SourceElement, SourceRegion } from "../domain/source-elements.js";
import {
  contentIdSchema,
  sourceRegionSchema,
} from "../domain/validation.js";

export const DEFAULT_UNCITED_ANSWER_TEXT = "I couldn't find the answer to your question in the available information.";

export interface PublishedAnswerCitation {
  citationNumber: number;
  documentId: string;
  documentVersionId: string;
  elementId: string;
  evidence: CitationEvidence;
  id: string;
  kind: SourceElement["kind"];
  pageNumbers: number[];
  regions: SourceRegion[];
  sectionPath: string[];
  sourceFile: string;
}

export interface PublishedAnswerStatement {
  citationIds: string[];
  content: string;
  presentation: AnswerPresentation;
  section: AnswerSection;
}

export interface PublishedUncitedAnswerDocument {
  citations: [];
  content: string;
  schemaVersion: 2;
  statements: [];
}

export interface PublishedAnsweredDocument {
  content: string;
  citations: PublishedAnswerCitation[];
  schemaVersion: 2;
  statements: PublishedAnswerStatement[];
}

export type PublishedAnswerDocument =
  | PublishedAnsweredDocument
  | PublishedUncitedAnswerDocument;

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

export const publishedAnswerCitationSchema: z.ZodType<PublishedAnswerCitation> = z.object({
  citationNumber: z.number().int().positive(),
  documentId: contentIdSchema,
  documentVersionId: z.uuid(),
  elementId: contentIdSchema,
  evidence: evidenceSchema,
  id: z.uuid(),
  kind: z.enum(["text", "table", "image"]),
  pageNumbers: z.array(z.number().int().positive()),
  regions: z.array(sourceRegionSchema),
  sectionPath: z.array(z.string().min(1)),
  sourceFile: z.string().min(1),
}).strict().superRefine((citation, context) => {
  if (citation.kind !== citation.evidence.kind) {
    context.addIssue({
      code: "custom",
      message: "Citation evidence kind does not match the citation kind.",
      path: ["evidence", "kind"],
    });
  }
});

const publishedAnswerStatementSchema: z.ZodType<PublishedAnswerStatement> = z.object({
  citationIds: z.array(z.uuid()).min(1),
  content: answerStatementContentSchema,
  presentation: answerPresentationSchema,
  section: answerSectionSchema,
}).strict();

const publishedUncitedAnswerDocumentSchema = z.object({
  citations: z.tuple([]),
  content: answerStatementContentSchema,
  schemaVersion: z.literal(2),
  statements: z.tuple([]),
}).strict();

const publishedAnsweredDocumentSchema = z.object({
  citations: z.array(publishedAnswerCitationSchema).min(1),
  content: answerStatementContentSchema,
  schemaVersion: z.literal(2),
  statements: z.array(publishedAnswerStatementSchema).min(1),
}).strict();

export const publishedAnswerDocumentSchema: z.ZodType<PublishedAnswerDocument> = z.union([
  publishedUncitedAnswerDocumentSchema,
  publishedAnsweredDocumentSchema,
]).superRefine((document, context) => {
  if (isPublishedAnsweredDocument(document)) {
    validatePublishedDocumentReferences(document, context);
  }
});

export function decodePublishedAnswerDocument(value: unknown): PublishedAnswerDocument {
  const result = publishedAnswerDocumentSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid published answer document: ${result.error.message}`);
  }
  return result.data;
}

export function createUncitedAnswerDocument(
  content = DEFAULT_UNCITED_ANSWER_TEXT,
): PublishedUncitedAnswerDocument {
  return {
    citations: [],
    content,
    schemaVersion: 2,
    statements: [],
  };
}

export function isPublishedAnsweredDocument(
  document: PublishedAnswerDocument,
): document is PublishedAnsweredDocument {
  return document.citations.length > 0;
}

export function isPublishedUncitedAnswerDocument(
  document: PublishedAnswerDocument,
): document is PublishedUncitedAnswerDocument {
  return document.citations.length === 0;
}

function validatePublishedDocumentReferences(
  document: PublishedAnsweredDocument,
  context: z.RefinementCtx,
): void {
  const citationIds = new Set<string>();
  const citationNumbers = new Set<number>();
  for (let index = 0; index < document.citations.length; index += 1) {
    const citation = document.citations[index];
    if (citation === undefined) {
      continue;
    }
    if (citationIds.has(citation.id)) {
      context.addIssue({
        code: "custom",
        message: `Citation id ${citation.id} appears more than once.`,
        path: ["citations", index, "id"],
      });
    }
    if (citationNumbers.has(citation.citationNumber)) {
      context.addIssue({
        code: "custom",
        message: `Citation number ${citation.citationNumber} appears more than once.`,
        path: ["citations", index, "citationNumber"],
      });
    }
    citationIds.add(citation.id);
    citationNumbers.add(citation.citationNumber);
  }
  const referencedCitationIds = new Set<string>();
  let previousSectionIndex = -1;
  for (let statementIndex = 0; statementIndex < document.statements.length; statementIndex += 1) {
    const statement = document.statements[statementIndex];
    if (statement === undefined) {
      continue;
    }
    const sectionIndex = ANSWER_SECTIONS.indexOf(statement.section);
    if (sectionIndex < previousSectionIndex) {
      context.addIssue({
        code: "custom",
        message: "Published answer sections are not in canonical order.",
        path: ["statements", statementIndex, "section"],
      });
    }
    previousSectionIndex = sectionIndex;
    const statementCitationIds = new Set<string>();
    for (let citationIndex = 0; citationIndex < statement.citationIds.length; citationIndex += 1) {
      const citationId = statement.citationIds[citationIndex];
      if (citationId === undefined) {
        continue;
      }
      if (!citationIds.has(citationId)) {
        context.addIssue({
          code: "custom",
          message: `Statement references missing citation ${citationId}.`,
          path: ["statements", statementIndex, "citationIds", citationIndex],
        });
      }
      if (statementCitationIds.has(citationId)) {
        context.addIssue({
          code: "custom",
          message: `Statement references citation ${citationId} more than once.`,
          path: ["statements", statementIndex, "citationIds", citationIndex],
        });
      }
      statementCitationIds.add(citationId);
      referencedCitationIds.add(citationId);
    }
  }
  for (let index = 0; index < document.citations.length; index += 1) {
    const citation = document.citations[index];
    if (citation !== undefined && !referencedCitationIds.has(citation.id)) {
      context.addIssue({
        code: "custom",
        message: `Citation ${citation.id} is not referenced by a statement.`,
        path: ["citations", index, "id"],
      });
    }
  }
}
