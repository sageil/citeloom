import type { UIMessage, UIMessageStreamWriter } from "ai";
import { z } from "zod";

import { publishedAnswerDocumentSchema } from "./published-schema.js";
import {
  hasAnswerContent,
  type AnswerContentSnapshot,
  type AnswerContentStatement,
} from "./content-snapshot.js";
import { contentIdSchema } from "../domain/validation.js";
import type { ChatMessageResponse } from "../chat/types.js";

export const matchedDocumentSchema = z.object({
  documentId: contentIdSchema,
  retrievedElementCount: z.number().int().positive(),
  sourceFile: z.string().min(1),
}).strict();

const claimVerificationResultSchema = z.object({
  citationNumbers: z.array(z.number().int().positive()),
  claim: z.string().min(1),
  claimIndex: z.number().int().nonnegative(),
  evidenceUnits: z.array(z.object({
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
  }).strict()),
  rationale: z.string().min(1),
  status: z.enum(["supported", "partially-supported", "unsupported", "unverified"]),
  verifierModel: z.string().min(1),
}).strict();

export const storedClaimCheckSchema = claimVerificationResultSchema.extend({
  createdAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
  turnId: z.uuid(),
}).strict();

export const streamedResearchTurnSchema = z.object({
  runId: z.uuid(),
  sequence: z.number().int().positive(),
  threadId: z.uuid(),
  turnId: z.uuid(),
}).strict();

export const streamedRunDetailsSchema = z.object({
  durationMs: z.number().int().nonnegative(),
  finishReason: z.string().min(1).nullable(),
  inputTokens: z.number().int().nonnegative().nullable(),
  modelId: z.string().min(1),
  outputTokens: z.number().int().nonnegative().nullable(),
  runId: z.uuid().nullable(),
  sourceCount: z.number().int().nonnegative(),
}).strict();

export const streamedAnswerSchema = z.object({
  answerDocument: publishedAnswerDocumentSchema,
  claims: z.array(storedClaimCheckSchema),
  matchedDocuments: z.array(matchedDocumentSchema),
  runDetails: streamedRunDetailsSchema.nullable(),
  turn: streamedResearchTurnSchema,
}).strict();

export type StreamedAnswer = z.output<typeof streamedAnswerSchema>;
export type StreamedResearchTurn = z.output<typeof streamedResearchTurnSchema>;
export type StreamedRunDetails = z.output<typeof streamedRunDetailsSchema>;

export type CiteLoomAnswerDataParts = {
  answer: StreamedAnswer;
  "answer-content": AnswerContentUpdate;
  chat: ChatMessageResponse;
};

export type CiteLoomUIMessage = UIMessage<never, CiteLoomAnswerDataParts>;

export type AnswerDataPart = {
  data: StreamedAnswer;
  type: "data-answer";
};

interface AnswerContentStatementUpdateBase {
  citationKeys: string[];
  index: number;
}

interface AnswerContentTextUpdate extends AnswerContentStatementUpdateBase {
  content: string;
  mode: "append" | "replace";
  presentation: AnswerContentStatement["presentation"];
  section: AnswerContentStatement["section"];
}

interface AnswerContentMetadataUpdate extends AnswerContentStatementUpdateBase {
  mode: "metadata";
}

export type AnswerContentStatementUpdate =
  | AnswerContentMetadataUpdate
  | AnswerContentTextUpdate;

export interface AnswerContentUpdate {
  citations: AnswerContentSnapshot["citations"];
  statementCount: number;
  statements: AnswerContentStatementUpdate[];
}

export type AnswerContentDataPart = {
  data: AnswerContentUpdate;
  type: "data-answer-content";
};

export type ChatDataPart = {
  data: ChatMessageResponse;
  type: "data-chat";
};

export function createAnswerContentWriter(
  writer: UIMessageStreamWriter<CiteLoomUIMessage>,
  receiveFirstContent: () => void = () => undefined,
): (content: AnswerContentSnapshot) => void {
  let lastContent: AnswerContentSnapshot = { citations: [], statements: [] };
  return (content) => {
    if (!hasAnswerContent(content)) {
      return;
    }
    const update = createAnswerContentUpdate(lastContent, content);
    if (
      update.statements.length === 0
      && update.statementCount === lastContent.statements.length
      && citationsMatch(lastContent, content)
    ) {
      return;
    }
    if (lastContent.statements.length === 0) {
      receiveFirstContent();
    }
    lastContent = content;
    writer.write({
      data: update,
      id: "answer-content",
      type: "data-answer-content",
    });
  };
}

function createAnswerContentUpdate(
  previous: AnswerContentSnapshot,
  current: AnswerContentSnapshot,
): AnswerContentUpdate {
  const statements: AnswerContentStatementUpdate[] = [];
  for (let index = 0; index < current.statements.length; index += 1) {
    const currentStatement = current.statements[index];
    if (currentStatement === undefined) {
      continue;
    }
    const previousStatement = previous.statements[index];
    if (statementsMatch(previousStatement, currentStatement)) {
      continue;
    }
    const metadataOnly = previousStatement !== undefined
      && previousStatement.content === currentStatement.content
      && previousStatement.presentation === currentStatement.presentation
      && previousStatement.section === currentStatement.section;
    if (metadataOnly) {
      statements.push({
        citationKeys: [...currentStatement.citationKeys],
        index,
        mode: "metadata",
      });
      continue;
    }
    const append = previousStatement !== undefined
      && previousStatement.presentation === currentStatement.presentation
      && previousStatement.section === currentStatement.section
      && currentStatement.content.startsWith(previousStatement.content);
    statements.push({
      citationKeys: [...currentStatement.citationKeys],
      content: append
        ? currentStatement.content.slice(previousStatement.content.length)
        : currentStatement.content,
      index,
      mode: append ? "append" : "replace",
      presentation: currentStatement.presentation,
      section: currentStatement.section,
    });
  }
  return {
    citations: current.citations.map((citation) => ({
      key: citation.key,
      pageNumbers: [...citation.pageNumbers],
      sourceFile: citation.sourceFile,
    })),
    statementCount: current.statements.length,
    statements,
  };
}

function statementsMatch(
  previous: AnswerContentStatement | undefined,
  current: AnswerContentStatement,
): boolean {
  if (previous === undefined) {
    return false;
  }
  return previous.content === current.content
    && stringArraysMatch(previous.citationKeys, current.citationKeys)
    && previous.presentation === current.presentation
    && previous.section === current.section;
}

function citationsMatch(
  previous: AnswerContentSnapshot,
  current: AnswerContentSnapshot,
): boolean {
  if (previous.citations.length !== current.citations.length) {
    return false;
  }
  for (let index = 0; index < current.citations.length; index += 1) {
    const previousCitation = previous.citations[index];
    const currentCitation = current.citations[index];
    if (
      previousCitation === undefined
      || currentCitation === undefined
      || previousCitation.key !== currentCitation.key
      || previousCitation.sourceFile !== currentCitation.sourceFile
      || !numberArraysMatch(
        previousCitation.pageNumbers,
        currentCitation.pageNumbers,
      )
    ) {
      return false;
    }
  }
  return true;
}

function stringArraysMatch(
  previous: readonly string[],
  current: readonly string[],
): boolean {
  if (previous.length !== current.length) {
    return false;
  }
  return previous.every((value, index) => value === current[index]);
}

function numberArraysMatch(
  previous: readonly number[],
  current: readonly number[],
): boolean {
  if (previous.length !== current.length) {
    return false;
  }
  return previous.every((value, index) => value === current[index]);
}

export function decodeAnswerDataPart(value: unknown): AnswerDataPart {
  const part = answerDataPartSchema.safeParse(value);
  if (!part.success) {
    throw new Error(`Invalid streamed answer data: ${part.error.message}`);
  }
  return part.data;
}

const answerDataPartSchema = z.object({
  data: streamedAnswerSchema,
  type: z.literal("data-answer"),
}).strict();
