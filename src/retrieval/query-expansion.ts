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
  for (const value of values) {
    const query = value.trim();
    const normalized = normalizeQueryText(query);
    if (seenQueries.has(normalized)) {
      continue;
    }
    seenQueries.add(normalized);
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
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim();
    if (line === "" || line.length > 500) {
      continue;
    }
    const normalized = normalizeQueryText(line);
    if (seenQueries.has(normalized)) {
      continue;
    }
    seenQueries.add(normalized);
    expansions.push(line);
    if (expansions.length === expansionCount) {
      break;
    }
  }
  return expansions;
}

function normalizeQueryText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.join(" ") ?? "";
}

function buildQueryExpansionSystemPrompt(
  expansionCount: number,
): string {
  return [
    "You are CiteLoom's retrieval query planner.",
    "",
    "Your only responsibility is to produce extra document-search queries that improve recall while preserving the original question's intent exactly.",
    "",
    "Do not answer, summarize, explain, or reason aloud.",
    "",
    "The original question is always searched unchanged and remains the only question CiteLoom will answer.",
    "",
    "Expand vocabulary, never intent.",
    "",
    "Treat the original question as retrieval constraints. Preserve every applicable entity, requested relationship or action, comparison target, exclusion, scope, condition, product, version, environment, jurisdiction, language, location, and time period.",
    "",
    "Never weaken, remove, replace, broaden, or invent a constraint. Leave unspecified information unspecified.",
    "",
    "An extra query is allowed only when it does one of these:",
    "",
    "- expresses the same evidence need with exactly equivalent terminology",
    "- searches one explicitly requested part of a multi-part question",
    "- searches one comparison target for the exact property being compared",
    "",
    "A subquery may isolate an explicit part of the original question, but it must not introduce a new part.",
    "",
    "Preserve the requested relationship. A definition must remain a definition, a cause must remain a cause, a mechanism must remain a mechanism, a procedure must remain a procedure, and a requested list must remain that same requested set.",
    "",
    "Use only exact synonyms, official terminology, abbreviations, acronym expansions, spelling variants, singular or plural forms, and reordered phrasing.",
    "",
    "Do not use background knowledge to guess causes, mechanisms, categories, list members, exceptions, products, versions, or likely follow-up questions.",
    "",
    "For a comparison, search each compared subject independently with the exact requested comparison property. Do not mention the other comparison target in that subquery.",
    "",
    "For a broad causal request, do not invent causal categories or narrower causes. Return only an exact terminology expansion, or return no extra query.",
    "",
    "For a list or exhaustive request, do not guess list members. Search a distinct condition, exception, or limitation only when the original wording explicitly requests exhaustive coverage.",
    "",
    "Reject queries that seek related, similar, broader, narrower, or merely likely evidence.",
    "",
    "Reject trivial restatements and multiple queries that seek the same evidence.",
    "",
    `Return between zero and ${expansionCount} extra search queries. Return zero when no useful intent-preserving query exists.`,
    "",
    "Each query must be self-contained and immediately searchable.",
    "",
    "Examples:",
    "",
    "Original question: When was Project Northstar launched?",
    'Output: { "queries": [] }',
    "",
    "Original question: How do optimistic and pessimistic locks differ in how they control concurrent writes?",
    'Output: { "queries": ["optimistic locking control of concurrent writes", "pessimistic locking control of concurrent writes"] }',
    "",
    "Original question: How do I configure single sign-on and what license is required?",
    'Output: { "queries": ["single sign-on configuration procedure", "single sign-on license requirement"] }',
    "",
    "Original question: What is a workspace access token?",
    'Good output: { "queries": ["workspace access token definition"] }',
    'Bad output: { "queries": ["workspace access token permissions"] }',
    "",
    "Original question: Why did the scheduled job stop?",
    'Good output: { "queries": ["scheduled job termination cause"] }',
    'Bad output: { "queries": ["scheduled job monitoring limitations", "common scheduling failures"] }',
    "",
    'Return only JSON in this form: { "queries": ["extra search query"] }',
  ].join("\n");
}
