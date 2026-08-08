import {
  generateText,
  type FilePart,
  type TelemetryOptions,
  type TextPart,
  type UserContent,
} from "ai";
import { z } from "zod";

import {
  createInferenceRequestSignal,
  throwInferenceRequestFailure,
} from "../../src/inference/request.js";
import type { TaskScheduler } from "../../src/shared/concurrency.js";
import type {
  RetrievalSourceElement,
  SourceElement,
} from "../../src/domain/source-elements.js";
import type { EvaluationModelRegistry } from "./models.js";

const MAX_EVALUATION_SOURCE_CHARACTERS = 16_000;
const evaluationQuestionResponseSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => value.endsWith("?"), "must end with a question mark");
const evaluationRelevanceResponseSchema = z.enum(["true", "false"]);

type EvaluationContentPart = FilePart | TextPart;

interface EvaluationElementRequest {
  domain: string;
  element: SourceElement;
}

interface EvaluationCompletion {
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface EvaluationQuestionRequest extends EvaluationElementRequest {
  excludedQuestions: string[];
}

export interface EvaluationRelevanceRequest {
  domain: string;
  element: RetrievalSourceElement;
  evidenceContent: string;
  question: string;
}

export async function generateEvaluationQuestion(
  models: EvaluationModelRegistry,
  scheduler: TaskScheduler,
  request: EvaluationQuestionRequest,
): Promise<string> {
  const finishMetric = models.metrics.start(
    "offline-tool",
    models.evaluation.provider,
    models.evaluation.modelId,
  );
  try {
    const content = buildQuestionGenerationContent(
      request.domain,
      request.element,
      request.excludedQuestions,
    );
    const runGeneration = (abortSignal: AbortSignal) => requestEvaluationText(
      models,
      content,
      createQuestionGenerationSystemPrompt(request.domain),
      "citeloom.evaluation-question",
      finishMetric,
      abortSignal,
    );
    const result = await scheduler.run(runGeneration);
    return decodeEvaluationQuestionResponse(result.text);
  } catch (error: unknown) {
    finishMetric({
      finishReason: "error",
      inputTokens: null,
      outputTokens: null,
    });
    throw error;
  }
}

export async function judgeEvaluationRelevance(
  models: EvaluationModelRegistry,
  scheduler: TaskScheduler,
  request: EvaluationRelevanceRequest,
): Promise<boolean> {
  const finishMetric = models.metrics.start(
    "offline-tool",
    models.evaluation.provider,
    models.evaluation.modelId,
  );
  try {
    const content = buildRelevanceContent(
      request.domain,
      request.question,
      request.element,
      request.evidenceContent,
    );
    const runGeneration = (abortSignal: AbortSignal) => requestEvaluationText(
      models,
      content,
      createRelevanceSystemPrompt(),
      "citeloom.evaluation-relevance",
      finishMetric,
      abortSignal,
    );
    const result = await scheduler.run(runGeneration);
    return decodeEvaluationRelevanceResponse(result.text);
  } catch (error: unknown) {
    finishMetric({
      finishReason: "error",
      inputTokens: null,
      outputTokens: null,
    });
    throw error;
  }
}

async function requestEvaluationText(
  models: EvaluationModelRegistry,
  content: UserContent,
  system: string,
  telemetryFunctionId: string,
  recordCompletion: (completion: EvaluationCompletion) => void,
  abortSignal: AbortSignal,
) {
  const telemetry = createEvaluationTelemetryOptions(
    models,
    telemetryFunctionId,
  );
  const timeoutMs = models.timeouts.answerMs;
  const signals = createInferenceRequestSignal(timeoutMs, abortSignal);
  try {
    return await generateText({
      abortSignal: signals.requestSignal,
      maxRetries: 1,
      messages: [{ content, role: "user" }],
      model: models.evaluation,
      onFinish: (event) => {
        recordCompletion({
          finishReason: event.finishReason,
          inputTokens: event.usage.inputTokens ?? null,
          outputTokens: event.usage.outputTokens ?? null,
        });
      },
      system,
      telemetry,
    });
  } catch (error: unknown) {
    throwInferenceRequestFailure(
      error,
      "answer",
      timeoutMs,
      signals.timeoutSignal,
      abortSignal,
    );
  }
}

function createQuestionGenerationSystemPrompt(domain: string): string {
  return [
    `Create one retrieval benchmark question for the ${domain} domain.`,
    "The supplied source must contain the answer.",
    "Write the question as a real user would ask it without mentioning the source or file.",
    "Use natural paraphrasing and do not copy a long phrase from the source.",
    "Make the question specific enough to have an objectively relevant source.",
    "Keep the question under 30 words and end it with a question mark.",
    "Return only the question without a label, quotation marks, explanation, or visible analysis.",
  ].join(" ");
}

function createRelevanceSystemPrompt(): string {
  return [
    "Judge retrieval relevance conservatively.",
    "Return relevant=true only when the supplied source contains direct evidence that answers the question or a necessary part of it.",
    "Return relevant=false for sources that merely share a topic, repeat keywords, or require unsupported inference.",
    "Return only true or false without a label, explanation, or visible analysis.",
  ].join(" ");
}

export function decodeEvaluationQuestionResponse(responseText: string): string {
  const result = evaluationQuestionResponseSchema.safeParse(responseText);
  if (!result.success) {
    throw new Error(
      `Evaluation question response is invalid: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

export function decodeEvaluationRelevanceResponse(
  responseText: string,
): boolean {
  const normalized = responseText.trim().toLowerCase();
  const result = evaluationRelevanceResponseSchema.safeParse(normalized);
  if (!result.success) {
    throw new Error(
      `Evaluation relevance response is invalid: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data === "true";
}

function buildQuestionGenerationContent(
  domain: string,
  element: SourceElement,
  excludedQuestions: string[],
): UserContent {
  const lines = [
    `Domain: ${domain}`,
    `Source type: ${element.kind}`,
    "Generate the benchmark question from this source:",
  ];
  if (excludedQuestions.length > 0) {
    lines.push(
      "Do not repeat or closely paraphrase any of these existing benchmark questions:",
    );
    for (const question of excludedQuestions) {
      lines.push(`- ${question}`);
    }
  }
  const instruction = lines.join("\n");
  return buildElementContent(instruction, element);
}

function buildRelevanceContent(
  domain: string,
  question: string,
  element: RetrievalSourceElement,
  evidenceContent: string,
): UserContent {
  const instruction = [
    `Domain: ${domain}`,
    `Question: ${question}`,
    `Candidate source type: ${element.kind}`,
    "Decide whether this candidate source is directly relevant:",
  ].join("\n");
  const source = element.kind === "image"
    ? evidenceContent
    : element.content.slice(0, MAX_EVALUATION_SOURCE_CHARACTERS);
  return `${instruction}\n\n${source}`;
}

function buildElementContent(
  instruction: string,
  element: SourceElement,
): UserContent {
  if (element.kind !== "image") {
    const source = element.content.slice(0, MAX_EVALUATION_SOURCE_CHARACTERS);
    return `${instruction}\n\n${source}`;
  }

  const content: EvaluationContentPart[] = [
    { text: instruction, type: "text" },
    {
      data: Buffer.from(element.content, "base64"),
      filename: "evaluation-source",
      mediaType: element.mimeType,
      type: "file",
    },
  ];
  return content;
}

function createEvaluationTelemetryOptions(
  models: EvaluationModelRegistry,
  functionId: string,
): TelemetryOptions {
  return {
    functionId,
    isEnabled: models.metrics.enabled,
    recordInputs: false,
    recordOutputs: false,
  };
}
