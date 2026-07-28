import type { UIMessage } from "ai";
import { z } from "zod";

import {
  publishedAnswerDocumentSchema,
} from "./published-schema.js";
import { contentIdSchema } from "../domain/validation.js";

export const matchedDocumentSchema = z.object({
  documentId: contentIdSchema,
  retrievedElementCount: z.number().int().positive(),
  sourceFile: z.string().min(1),
}).strict();

export const storedClaimCheckSchema = z.object({
  citationNumbers: z.array(z.number().int().positive()),
  claim: z.string().min(1),
  claimIndex: z.number().int().nonnegative(),
  createdAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
  evidenceUnits: z.array(z.object({
    citationNumber: z.number().int().positive(),
    outcome: z.enum([
      "not-evaluated",
      "supported",
      "unsupported",
      "verifier-incompatible",
    ]),
    rationale: z.string().min(1),
    supportProbability: z.number().finite().min(0).max(1).nullable(),
    unitId: z.string().min(1),
  }).strict()),
  rationale: z.string().min(1),
  status: z.enum(["supported", "partially-supported", "unsupported", "unverified"]),
  turnId: z.uuid(),
  verifierModel: z.string().min(1),
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
};

export type CiteLoomUIMessage = UIMessage<never, CiteLoomAnswerDataParts>;

export type AnswerDataPart = {
  data: StreamedAnswer;
  type: "data-answer";
};

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
