import { generateText, Output } from "ai";
import { z } from "zod";

import type { TaskScheduler } from "../shared/concurrency.js";
import type { InferenceModelRegistry } from "../inference/registry.js";
import {
  createInferenceRequestSignal,
  throwInferenceRequestFailure,
} from "../inference/request.js";
import { createInferenceTelemetryOptions } from "../inference/shared.js";
import {
  createTelemetryStageResult,
  noopRunTelemetry,
  type RunTelemetry,
} from "../observability/run.js";

export interface QueryExpansionGenerationSettings {
  seed: number | null;
  temperature: number;
}

interface QueryExpansionCompletion {
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export async function expandRetrievalQuery(
  models: InferenceModelRegistry,
  question: string,
  expansionCount: number,
  scheduler: TaskScheduler,
  abortSignal: AbortSignal,
  generationSettings?: QueryExpansionGenerationSettings,
  runTelemetry: RunTelemetry = noopRunTelemetry,
): Promise<string[]> {
  if (expansionCount === 0) {
    return [];
  }
  const stage = runTelemetry.startStage({
    model: {
      modelId: models.queryExpansion.modelId,
      provider: models.queryExpansion.provider,
    },
    name: "query-expansion",
    retrievalMode: null,
  });
  const finishMetric = models.metrics.start(
    "expand-query",
    models.queryExpansion.provider,
    models.queryExpansion.modelId,
  );
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  const recordCompletion = (completion: QueryExpansionCompletion): void => {
    inputTokens = completion.inputTokens;
    outputTokens = completion.outputTokens;
    finishMetric(completion);
  };
  try {
    const runGeneration = (requestSignal: AbortSignal) => requestQueryExpansions(
      models,
      question,
      expansionCount,
      requestSignal,
      generationSettings,
      recordCompletion,
    );
    const result = await scheduler.run(
      runGeneration,
      abortSignal,
      stage.timingObserver,
    );
    const expansions = normalizeQueryExpansions(
      result.output.queries,
      question,
      expansionCount,
    );
    await stage.finish(createTelemetryStageResult("success", {
      inputCount: 1,
      inputTokens,
      outputCount: expansions.length,
      outputTokens,
    }));
    return expansions;
  } catch (error: unknown) {
    finishMetric({
      finishReason: abortSignal.aborted ? "aborted" : "error",
      inputTokens: null,
      outputTokens: null,
    });
    const outcome = abortSignal.aborted ? "abort" : "fallback";
    await stage.finish(createTelemetryStageResult(outcome, { inputCount: 1 }));
    throw error;
  }
}

async function requestQueryExpansions(
  models: InferenceModelRegistry,
  question: string,
  expansionCount: number,
  abortSignal: AbortSignal,
  generationSettings: QueryExpansionGenerationSettings | undefined,
  recordCompletion: (completion: QueryExpansionCompletion) => void,
) {
  const system = buildQueryExpansionSystemPrompt(expansionCount);
  const telemetry = createInferenceTelemetryOptions(
    models,
    "citeloom.expand-query",
  );
  const timeoutMs = models.timeouts.queryExpansionMs;
  const signals = createInferenceRequestSignal(timeoutMs, abortSignal);
  try {
    const samplingSettings = generationSettings === undefined
      ? {}
      : buildSamplingSettings(generationSettings);
    return await generateText({
      ...samplingSettings,
      abortSignal: signals.requestSignal,
      maxRetries: 1,
      model: models.queryExpansion,
      onFinish: (event) => {
        recordCompletion({
          finishReason: event.finishReason,
          inputTokens: event.totalUsage.inputTokens ?? null,
          outputTokens: event.totalUsage.outputTokens ?? null,
        });
      },
      output: Output.object({
        description: "Extra search queries that seek evidence not already targeted by the original question.",
        name: "extra_search_queries",
        schema: createQueryExpansionSchema(expansionCount),
      }),
      prompt: question,
      system,
      telemetry,
    });
  } catch (error: unknown) {
    throwInferenceRequestFailure(
      error,
      "queryExpansion",
      timeoutMs,
      signals.timeoutSignal,
      abortSignal,
    );
  }
}

function createQueryExpansionSchema(expansionCount: number) {
  return z.object({
    queries: z
      .array(z.string().trim().min(1).max(500))
      .max(expansionCount),
  });
}

function normalizeQueryExpansions(
  values: readonly string[],
  originalQuestion: string,
  expansionCount: number,
): string[] {
  const expansions: string[] = [];
  const seenQueries = new Set([normalizeQueryText(originalQuestion)]);
  const seenEvidenceNeeds = new Set([
    createEvidenceNeedFingerprint(originalQuestion),
  ]);
  for (const value of values) {
    const query = value.trim();
    const normalized = normalizeQueryText(query);
    const evidenceNeed = createEvidenceNeedFingerprint(query);
    if (seenQueries.has(normalized) || seenEvidenceNeeds.has(evidenceNeed)) {
      continue;
    }
    seenQueries.add(normalized);
    seenEvidenceNeeds.add(evidenceNeed);
    expansions.push(query);
    if (expansions.length === expansionCount) {
      break;
    }
  }
  return expansions;
}

function buildSamplingSettings(settings: QueryExpansionGenerationSettings): {
  seed?: number;
  temperature: number;
} {
  if (settings.seed === null) {
    return { temperature: settings.temperature };
  }
  return { seed: settings.seed, temperature: settings.temperature };
}

export function decodeQueryExpansions(
  value: string,
  originalQuestion: string,
  expansionCount: number,
): string[] {
  const expansions: string[] = [];
  const seenQueries = new Set([normalizeQueryText(originalQuestion)]);
  const seenEvidenceNeeds = new Set([
    createEvidenceNeedFingerprint(originalQuestion),
  ]);
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim();
    if (line === "" || line.length > 500) {
      continue;
    }
    const normalized = normalizeQueryText(line);
    const evidenceNeed = createEvidenceNeedFingerprint(line);
    if (seenQueries.has(normalized) || seenEvidenceNeeds.has(evidenceNeed)) {
      continue;
    }
    seenQueries.add(normalized);
    seenEvidenceNeeds.add(evidenceNeed);
    expansions.push(line);
    if (expansions.length === expansionCount) {
      break;
    }
  }
  return expansions;
}

const queryScaffoldingWords = new Set([
  "a",
  "all",
  "an",
  "are",
  "be",
  "been",
  "being",
  "can",
  "complete",
  "comprehensive",
  "could",
  "describe",
  "details",
  "did",
  "do",
  "does",
  "enumerate",
  "explain",
  "find",
  "for",
  "give",
  "how",
  "identify",
  "information",
  "is",
  "list",
  "me",
  "name",
  "of",
  "overview",
  "please",
  "provide",
  "search",
  "show",
  "tell",
  "the",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "would",
]);

function normalizeQueryText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.join(" ") ?? "";
}

function createEvidenceNeedFingerprint(value: string): string {
  const normalized = normalizeQueryText(value);
  const words = normalized === "" ? [] : normalized.split(" ");
  const substantiveWords: string[] = [];
  for (const word of words) {
    if (!queryScaffoldingWords.has(word)) {
      substantiveWords.push(word);
    }
  }
  const fingerprintWords = substantiveWords.length > 0
    ? substantiveWords
    : words;
  const uniqueWords = [...new Set(fingerprintWords)];
  uniqueWords.sort();
  return uniqueWords.join("\0");
}

function buildQueryExpansionSystemPrompt(
  expansionCount: number,
): string {
  return [
    "You write extra search queries for CiteLoom document retrieval.",
    "",
    "The original question is always searched unchanged and remains the question CiteLoom will answer.",
    "",
    "Return only extra search queries that are likely to find different evidence from the original question.",
    "",
    `Return between zero and ${expansionCount} extra search queries.`,
    "",
    "Return zero extra search queries when the original question is sufficient.",
    "",
    "Each extra search query must be self-contained, immediately searchable, and focused on one distinct evidence need.",
    "",
    "Preserve important entities, dates, locations, versions, organizations, and constraints.",
    "",
    "Use genuinely different terminology only when it may locate evidence that the original wording would miss.",
    "",
    "For an exhaustive request such as “List all...”, add searches only for distinct categories, exceptions, conditions, limitations, or other evidence that may appear separately.",
    "",
    "Do not:",
    "",
    "- repeat or lightly restate the original question",
    "- turn a command into a grammatical question",
    "- replace the original question",
    "- return synonymous searches that seek the same evidence",
    "- invent facts, entities, dates, categories, or assumptions",
    "- answer the original question",
    "- explain your reasoning",
    "",
    "Examples:",
    "",
    "Original question: When was Project Northstar launched?",
    'Output: { "queries": [] }',
    "",
    "Original question: Compare PostgreSQL and MySQL.",
    'Output: { "queries": ["PostgreSQL features and capabilities", "MySQL features and capabilities"] }',
    "",
    "Original question: How do I configure single sign-on and what license is required?",
    'Output: { "queries": ["Single sign-on configuration steps", "Single sign-on licensing requirements"] }',
    "",
    "Original question: List all supported deployment modes.",
    'Good output: { "queries": ["Deployment mode exceptions and conditions", "Deprecated deployment modes"] }',
    'Bad output: { "queries": ["List of supported deployment modes"] }',
    "",
    'Return only JSON in this form: { "queries": ["extra search query"] }',
  ].join("\n");
}
