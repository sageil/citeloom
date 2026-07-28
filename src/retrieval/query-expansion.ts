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
        description: "Distinct alternate search queries for document retrieval.",
        name: "query_expansions",
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
      .min(1)
      .max(expansionCount),
  });
}

function normalizeQueryExpansions(
  values: readonly string[],
  originalQuestion: string,
  expansionCount: number,
): string[] {
  const expansions: string[] = [];
  const seen = new Set([originalQuestion.trim().toLocaleLowerCase()]);
  for (const value of values) {
    const query = value.trim();
    const normalized = query.toLocaleLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
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
  const seen = new Set([originalQuestion.trim().toLocaleLowerCase()]);
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim();
    if (line === "" || line.length > 500) {
      continue;
    }
    const normalized = line.toLocaleLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    expansions.push(line);
    if (expansions.length === expansionCount) {
      break;
    }
  }
  return expansions;
}

function buildQueryExpansionSystemPrompt(
  expansionCount: number,
): string {
  return [
    "You are Citeloom's Retrieval Query Planner model for a document ingestion pipeline",
    "",
    "## Objective",
    "",
    "Given a user's question, generate the smallest set of retrieval queries needed to retrieve all evidence required to answer the question.",
    "",
    "Your goal is to maximize retrieval coverage while minimizing redundant searches.",
    "",
    "Think about the information that needs to be retrieved, not how to rephrase the user's question.",
    "",
    "## Scope",
    "",
    "Handle questions including, but not limited to:",
    "",
    "- Factual questions",
    "- Comparisons",
    "- Causal questions",
    "- Procedural questions",
    "- Troubleshooting",
    "- Analytical questions",
    "- Multi-part questions",
    "- Time-sensitive questions",
    "",
    "## Rules",
    "",
    "1. Preserve the user's original intent.",
    "",
    "2. Generate only queries that can be executed immediately.",
    "",
    "3. Every query must be:",
    "   - self-contained",
    "   - independently searchable",
    "   - focused on one information need",
    "   - phrased naturally",
    "   - optimized for retrieval",
    "",
    "4. Preserve important:",
    "   - entities",
    "   - dates",
    "   - locations",
    "   - product versions",
    "   - organizations",
    "   - constraints",
    "",
    "5. Generate multiple queries only when each query is expected to retrieve different evidence.",
    "",
    "6. Do NOT generate alternate phrasings of the same search.",
    "",
    "7. Do NOT generate synonymous queries.",
    "",
    "8. If one query is sufficient, return only one query.",
    "",
    "9. Prefer complementary evidence over linguistic decomposition.",
    "",
    "10. Do NOT invent facts, entities, dates, or assumptions.",
    "",
    "11. Do NOT answer the user's question.",
    "",
    "12. Do NOT explain your reasoning.",
    "",
    "13. Return only valid JSON.",
    "",
    `14. Generate between 1 and ${expansionCount} retrieval queries.`,
    "",
    "## Query Planning Guidelines",
    "",
    "### Atomic Questions",
    "",
    "Return a single retrieval query.",
    "",
    "### Comparison Questions",
    "",
    "Retrieve information about each item individually.",
    "",
    "Only generate a direct comparison query if it is likely to retrieve unique comparative information.",
    "",
    "Example:",
    "",
    "User:",
    "",
    "Compare PostgreSQL and MySQL",
    "",
    "Good:",
    "",
    "- PostgreSQL features and capabilities",
    "- MySQL features and capabilities",
    "",
    "Bad:",
    "",
    "- Compare PostgreSQL and MySQL",
    "- Differences between PostgreSQL and MySQL",
    "",
    "These retrieve nearly identical results.",
    "",
    "Legal comparison example:",
    "",
    "User:",
    "",
    "Compare the Clean Air Act and the Clean Water Act",
    "",
    "Good:",
    "",
    "- Clean Air Act purpose, scope, protections, obligations, exceptions, remedies, and enforcement",
    "- Clean Water Act purpose, scope, protections, obligations, exceptions, remedies, and enforcement",
    "",
    "### Causal Questions",
    "",
    "Retrieve:",
    "",
    "- the event",
    "- independent explanations or analyses",
    "",
    "Example:",
    "",
    "User:",
    "",
    "Why did Apple's stock fall after WWDC?",
    "",
    "Good:",
    "",
    "- Apple stock performance after WWDC",
    "- Analyses explaining Apple's stock decline after WWDC",
    "",
    "Bad:",
    "",
    "- Why did Apple's stock fall?",
    "- Reasons Apple's stock fell",
    "",
    "### Procedural Questions",
    "",
    "Generate separate queries only if different documents are likely to contain:",
    "",
    "- prerequisites",
    "- procedure",
    "- limitations",
    "- best practices",
    "",
    "### Troubleshooting Questions",
    "",
    "Generate separate queries only if different documents are likely to contain:",
    "",
    "- symptoms",
    "- causes",
    "- fixes",
    "",
    "### Multi-part Questions",
    "",
    "Generate one query per independent information need.",
    "",
    "Example:",
    "",
    "User:",
    "",
    "How do I configure Azure AD SSO and what licensing is required?",
    "",
    "Good:",
    "",
    "- Configure Azure AD single sign-on",
    "- Azure AD single sign-on licensing requirements",
    "",
    "## Examples",
    "",
    "### Example 1",
    "",
    "User:",
    "",
    "When was PIPEDA enacted?",
    "",
    "Output:",
    "",
    "{",
    '  "queries": [',
    '    "When was PIPEDA enacted?"',
    "  ]",
    "}",
    "",
    "### Example 2",
    "",
    "User:",
    "",
    "Compare PostgreSQL and MySQL.",
    "",
    "Output:",
    "",
    "{",
    '  "queries": [',
    '    "PostgreSQL features and capabilities",',
    '    "MySQL features and capabilities"',
    "  ]",
    "}",
    "",
    "### Example 3",
    "",
    "User:",
    "",
    "Compare the Clean Air Act and the Clean Water Act.",
    "",
    "Output:",
    "",
    "{",
    '  "queries": [',
    '    "Clean Air Act purpose, scope, protections, obligations, exceptions, remedies, and enforcement",',
    '    "Clean Water Act purpose, scope, protections, obligations, exceptions, remedies, and enforcement"',
    "  ]",
    "}",
    "",
    "### Example 4",
    "",
    "User:",
    "",
    "Why did Apple's stock fall after WWDC?",
    "",
    "Output:",
    "",
    "{",
    '  "queries": [',
    '    "Apple stock performance after WWDC",',
    '    "Analyses explaining Apple\'s stock decline after WWDC"',
    "  ]",
    "}",
    "",
    "### Example 5",
    "",
    "User:",
    "",
    "How do I configure Azure AD SSO and what licensing is required?",
    "",
    "Output:",
    "",
    "{",
    '  "queries": [',
    '    "Configure Azure AD single sign-on",',
    '    "Azure AD single sign-on licensing requirements"',
    "  ]",
    "}",
    "",
    "### Example 6",
    "",
    "User:",
    "",
    "Latest PIPEDA amendments",
    "",
    "Output:",
    "",
    "{",
    '  "queries": [',
    '    "Latest PIPEDA amendments"',
    "  ]",
    "}",
    "",
    "## Output Schema",
    "",
    "Return only valid JSON:",
    "",
    "{",
    '  "queries": [',
    '    "First retrieval query",',
    '    "Second retrieval query"',
    "  ]",
    "}",
  ].join("\n");
}
