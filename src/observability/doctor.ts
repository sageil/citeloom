import { z } from "zod";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { generateText, rerank } from "ai";

import {
  createEvidenceReferences,
  decodeAnswerModelResponse,
} from "../answers/draft.js";
import {
  createAnswerModelOutput,
  createAnswerSystemPrompt,
} from "../answers/inference.js";
import {
  createRuntimeTaskScheduler,
  type ApplicationRuntime,
} from "../app/runtime.js";
import type { TaskScheduler } from "../shared/concurrency.js";
import type {
  AppConfig,
  ClaimVerifierConfig,
  DoclingConfig,
  EmbeddingInferenceConfig,
  InferenceConfig,
  LanguageInferenceConfig,
  ProviderRuntimeConfig,
  RerankerConfig,
  ScheduledProviderCapability,
  SpeechToTextConfig,
  TextToSpeechConfig,
} from "../config/index.js";
import {
  openDatabase,
  type CiteLoomDatabase,
} from "../database/client.js";
import {
  embeddingSpaces,
  doclingArtifacts,
  inferenceLimits,
  retrievalChunks384,
  retrievalChunks768,
  retrievalChunks1024,
  retrievalLexicalChunks,
  sourceContentDeletions,
  sourceDocuments,
  workerHeartbeats,
} from "../database/schema.js";
import { readDatabaseReadiness } from "../database/readiness.js";
import { verifyDoclingService } from "../docling/index.js";
import { HttpHhemClient } from "../verification/hhem-client.js";
import {
  createHttpRerankingModel,
  type ResolvedReranker,
} from "../retrieval/ranking/reranker.js";
import { InferenceCoordinator } from "../inference/coordinator.js";
import {
  createInferenceModelRegistry,
  type InferenceModelRegistry,
} from "../inference/registry.js";
import { readOpenAICodexModels } from "../providers/openai-codex-models.js";
import { probeSpeechToTextProvider } from "../providers/speech-to-text.js";
import { probeTextToSpeechProvider } from "../providers/text-to-speech.js";

const inferenceModelsSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) }).loose()),
});
const ollamaModelsSchema = z.object({
  models: z.array(z.object({
    model: z.string().min(1),
    name: z.string().min(1),
  }).loose()),
});

export interface DoctorCheck {
  detail: string;
  name: string;
  ok: boolean;
}

type DoctorSchedulerResolver = (
  capability: ScheduledProviderCapability,
) => TaskScheduler;

export async function runDoctor(config: AppConfig): Promise<DoctorCheck[]> {
  let models: InferenceModelRegistry | null = null;
  let database: CiteLoomDatabase | null = null;
  let closeDatabase: (() => Promise<void>) | null = null;
  let databaseCheck: Promise<DoctorCheck>;
  let resolveScheduler: DoctorSchedulerResolver;
  try {
    const session = await openDatabase(config.database);
    closeDatabase = session.close;
    database = session.database;
    models = createInferenceModelRegistry(config, session.database);
    const coordinator = new InferenceCoordinator(session.database);
    await coordinator.configure(config.scheduling);
    databaseCheck = checkDatabaseSchema(session.database);
    resolveScheduler = (capability): TaskScheduler => {
      return createRuntimeTaskScheduler(
        config,
        coordinator,
        capability,
        "maintenance",
      );
    };
  } catch (error: unknown) {
    databaseCheck = Promise.resolve(
      failedCheck("PostgreSQL", readErrorMessage(error)),
    );
    resolveScheduler = (): TaskScheduler => {
      return createUnavailableScheduler(error);
    };
  }
  const pendingChecks = [
    ...buildSpeechProviderChecks(config, resolveScheduler),
    databaseCheck,
    checkDocling(config.docling),
  ];
  if (models === null) {
    pendingChecks.push(Promise.resolve(failedCheck(
      "Inference runtime",
      "the database connection required to initialize providers is unavailable",
    )));
  } else if (database !== null) {
    pendingChecks.push(...buildInferenceRuntimeChecks(
      config.inference,
      config.claimVerifier,
      models.answer,
      resolveScheduler("answer"),
      database,
    ));
  }
  if (config.retrieval.reranker !== null) {
    pendingChecks.push(checkRerankerWithScheduler(
      config.retrieval.reranker,
      resolveScheduler("reranking"),
    ));
  }
  try {
    return await Promise.all(pendingChecks);
  } finally {
    if (closeDatabase !== null) {
      await closeDatabase();
    }
  }
}

export async function runDoctorWithRuntime(
  runtime: ApplicationRuntime,
): Promise<DoctorCheck[]> {
  const config = runtime.config;
  const pendingChecks = [
    ...buildInferenceRuntimeChecks(
      config.inference,
      config.claimVerifier,
      runtime.models.answer,
      runtime.scheduler("answer", "maintenance"),
      runtime.database,
    ),
    ...buildSpeechProviderChecks(
      config,
      (capability) => runtime.scheduler(capability, "maintenance"),
    ),
    checkDatabaseSchema(runtime.database),
    checkDocling(config.docling),
  ];
  if (config.retrieval.reranker !== null) {
    if (runtime.models.reranker === null) {
      pendingChecks.push(Promise.resolve(failedCheck(
        config.retrieval.reranker.runtimeName,
        "the configured reranker model is missing from the runtime snapshot",
      )));
    } else {
      pendingChecks.push(checkRuntimeReranker(
        config.retrieval.reranker,
        runtime.models.reranker,
        runtime.scheduler("reranking", "maintenance"),
      ));
    }
  }
  return Promise.all(pendingChecks);
}

export function buildSpeechProviderChecks(
  config: AppConfig,
  resolveScheduler: DoctorSchedulerResolver,
): Promise<DoctorCheck>[] {
  const checks: Promise<DoctorCheck>[] = [];
  if (config.speechToText !== null) {
    checks.push(checkSpeechToText(
      config.speechToText,
      resolveScheduler("speechToText"),
    ));
  }
  if (config.textToSpeech !== null) {
    checks.push(checkTextToSpeech(
      config.textToSpeech,
      resolveScheduler("textToSpeech"),
    ));
  }
  return checks;
}

async function checkSpeechToText(
  config: SpeechToTextConfig,
  scheduler: TaskScheduler,
): Promise<DoctorCheck> {
  try {
    await scheduler.run(
      (requestSignal) => probeSpeechToTextProvider(config, requestSignal),
    );
    return successfulCheck(
      "Speech-to-text provider",
      `model ${config.model} accepted a transcription capability probe`,
    );
  } catch (error: unknown) {
    return failedCheck("Speech-to-text provider", readErrorMessage(error));
  }
}

async function checkTextToSpeech(
  config: TextToSpeechConfig,
  scheduler: TaskScheduler,
): Promise<DoctorCheck> {
  try {
    await scheduler.run(
      (requestSignal) => probeTextToSpeechProvider(config, requestSignal),
    );
    return successfulCheck(
      "Text-to-speech provider",
      `model ${config.model} returned an audio capability probe`,
    );
  } catch (error: unknown) {
    return failedCheck("Text-to-speech provider", readErrorMessage(error));
  }
}

function buildInferenceRuntimeChecks(
  config: InferenceConfig,
  claimVerifier: ClaimVerifierConfig,
  answerModel: LanguageModelV4,
  answerScheduler: TaskScheduler,
  database: CiteLoomDatabase,
): Promise<DoctorCheck>[] {
  const groups = groupInferenceProviders([
    config.answer,
    config.queryExpansion,
    config.summary,
    config.embedding,
  ]);
  const checks: Promise<DoctorCheck>[] = [];
  checks.push(checkStructuredAnswerCapability(
    answerModel,
    config.answer.model,
    config.answer.timeoutMs,
    answerScheduler,
  ));
  for (const group of groups) {
    checks.push(checkInferenceProviderRuntime(
      group.config,
      group.models,
      database,
    ));
  }
  checks.push(checkHhemRuntime(claimVerifier));
  return checks;
}

async function checkStructuredAnswerCapability(
  model: LanguageModelV4,
  modelId: string,
  timeoutMs: number,
  scheduler: TaskScheduler,
): Promise<DoctorCheck> {
  try {
    const allowedEvidenceRefs = createEvidenceReferences(1);
    const result = await scheduler.run(
      (requestSignal) => generateText({
        abortSignal: AbortSignal.any([
          requestSignal,
          AbortSignal.timeout(timeoutMs),
        ]),
        maxOutputTokens: 200,
        maxRetries: 0,
        model,
        output: createAnswerModelOutput(allowedEvidenceRefs),
        prompt: [
          "ORIGINAL QUESTION:",
          "What does the retrieved evidence say about structured answer generation?",
          "",
          "RETRIEVED EVIDENCE FOLLOWS.",
          "",
          "Use the exact evidence reference on each retrieved item.",
          "Do not invent, change, or guess evidence references.",
          "",
          "EVID_A: A readiness probe checks structured answer generation.",
          "Return status answered with one plain-text statement supported by evidence reference EVID_A.",
        ].join("\n"),
        system: createAnswerSystemPrompt(),
        telemetry: {
          isEnabled: false,
          recordInputs: false,
          recordOutputs: false,
        },
        temperature: 0,
      }),
    );
    const draft = decodeAnswerModelResponse(
      result.output,
      allowedEvidenceRefs,
    );
    if (draft.status !== "answered") {
      return failedCheck(
        "Answer draft protocol",
        `model ${modelId} returned no_answer for the structured-output readiness probe`,
      );
    }
    return successfulCheck(
      "Answer draft protocol",
      `model ${modelId} returned a valid structured answer draft`,
    );
  } catch (error) {
    return failedCheck("Answer draft protocol", readErrorMessage(error));
  }
}

type InferenceProviderConfig =
  | EmbeddingInferenceConfig
  | LanguageInferenceConfig;

interface InferenceProviderGroup {
  config: InferenceProviderConfig;
  models: string[];
}

function groupInferenceProviders(
  configurations: readonly InferenceProviderConfig[],
): InferenceProviderGroup[] {
  const groups: InferenceProviderGroup[] = [];
  for (const config of configurations) {
    const existing = groups.find((candidate) => {
      return candidate.config.adapter === config.adapter
        && candidate.config.apiToken === config.apiToken
        && candidate.config.baseUrl === config.baseUrl
        && candidate.config.runtimeName === config.runtimeName;
    });
    if (existing === undefined) {
      groups.push({ config, models: [config.model] });
      continue;
    }
    if (!existing.models.includes(config.model)) {
      existing.models.push(config.model);
    }
  }
  return groups;
}

function checkInferenceProviderRuntime(
  config: InferenceProviderConfig,
  configuredModels: readonly string[],
  database: CiteLoomDatabase,
): Promise<DoctorCheck> {
  if (config.adapter === "openai-codex-language") {
    return checkOpenAICodexRuntime(config, configuredModels, database);
  }
  if (
    config.adapter === "cohere-language"
    || config.adapter === "cohere-embedding"
  ) {
    return checkCohereRuntime(config, configuredModels);
  }
  if (
    config.adapter === "ollama-embedding"
    || config.adapter === "ollama-language"
  ) {
    return checkOllamaRuntime(config, configuredModels);
  }
  return checkOpenAICompatibleRuntime(config, configuredModels);
}

async function checkOpenAICodexRuntime(
  config: ProviderRuntimeConfig,
  configuredModels: readonly string[],
  database: CiteLoomDatabase,
): Promise<DoctorCheck> {
  try {
    const models = await readOpenAICodexModels(database, {
      signal: AbortSignal.timeout(10_000),
    });
    const available = new Set(models.map((model) => model.id));
    const missing = configuredModels.filter((model) => !available.has(model));
    if (missing.length > 0) {
      return failedCheck(
        config.runtimeName,
        `the Codex subscription does not list configured model(s): ${missing.join(", ")}`,
      );
    }
    return successfulCheck(
      config.runtimeName,
      `the Codex subscription lists ${configuredModels.join(", ")}`,
    );
  } catch (error: unknown) {
    return failedCheck(config.runtimeName, readErrorMessage(error));
  }
}

async function checkHhemRuntime(
  config: ClaimVerifierConfig,
): Promise<DoctorCheck> {
  try {
    const client = new HttpHhemClient(config);
    await client.checkReady();
    return successfulCheck(
      config.runtimeName,
      `model ${config.model} is loaded and ready`,
    );
  } catch (error: unknown) {
    return failedCheck(config.runtimeName, readErrorMessage(error));
  }
}

async function checkOpenAICompatibleRuntime(
  config: ProviderRuntimeConfig,
  configuredModels: readonly string[],
): Promise<DoctorCheck> {
  const runtimeName = config.runtimeName;
  try {
    const headers = new Headers();
    if (config.apiToken !== null) {
      headers.set("authorization", `Bearer ${config.apiToken}`);
    }
    const response = await fetch(`${config.baseUrl}/models`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return failedCheck(runtimeName, `GET /models returned HTTP ${response.status}`);
    }

    const responseBody: unknown = await response.json();
    const parsed = inferenceModelsSchema.safeParse(responseBody);
    if (!parsed.success) {
      return failedCheck(runtimeName, "GET /models returned an invalid response");
    }

    const modelIds = new Set(parsed.data.data.map((model) => model.id));
    const missingModels: string[] = [];
    for (const modelId of configuredModels) {
      if (!modelIds.has(modelId) && !missingModels.includes(modelId)) {
        missingModels.push(modelId);
      }
    }
    if (missingModels.length > 0) {
      return failedCheck(
        runtimeName,
        `server is reachable, but these configured models are not visible: ${missingModels.join(", ")}`,
      );
    }

    return successfulCheck(
      runtimeName,
      `server is reachable and all configured models are visible`,
    );
  } catch (error) {
    return failedCheck(runtimeName, readErrorMessage(error));
  }
}

async function checkCohereRuntime(
  config: ProviderRuntimeConfig,
  configuredModels: readonly string[],
): Promise<DoctorCheck> {
  const runtimeName = config.runtimeName;
  try {
    const headers = new Headers();
    if (config.apiToken !== null) {
      headers.set("authorization", `Bearer ${config.apiToken}`);
    }
    const baseUrl = new URL(config.baseUrl);
    for (const model of configuredModels) {
      const modelUrl = new URL(
        `/v1/models/${encodeURIComponent(model)}`,
        baseUrl.origin,
      );
      const response = await fetch(modelUrl, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        return failedCheck(
          runtimeName,
          `model ${model} check returned HTTP ${response.status}`,
        );
      }
    }
    return successfulCheck(
      runtimeName,
      "server is reachable and all configured models are visible",
    );
  } catch (error) {
    return failedCheck(runtimeName, readErrorMessage(error));
  }
}

async function checkOllamaRuntime(
  config: ProviderRuntimeConfig,
  configuredModels: readonly string[],
): Promise<DoctorCheck> {
  const runtimeName = config.runtimeName;
  try {
    const headers = new Headers();
    if (config.apiToken !== null) {
      headers.set("authorization", `Bearer ${config.apiToken}`);
    }
    const baseUrl = config.baseUrl.replace(/\/+$/, "");
    const response = await fetch(`${baseUrl}/api/tags`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return failedCheck(runtimeName, `GET /api/tags returned HTTP ${response.status}`);
    }
    const responseBody: unknown = await response.json();
    const parsed = ollamaModelsSchema.safeParse(responseBody);
    if (!parsed.success) {
      return failedCheck(runtimeName, "GET /api/tags returned an invalid response");
    }
    const modelIds = new Set<string>();
    for (const model of parsed.data.models) {
      modelIds.add(model.model);
      modelIds.add(model.name);
    }
    const missingModels: string[] = [];
    for (const modelId of configuredModels) {
      if (!modelIds.has(modelId) && !missingModels.includes(modelId)) {
        missingModels.push(modelId);
      }
    }
    if (missingModels.length > 0) {
      return failedCheck(
        runtimeName,
        `server is reachable, but these configured models are not visible: ${missingModels.join(", ")}`,
      );
    }
    return successfulCheck(
      runtimeName,
      "Ollama is reachable and all configured models are visible",
    );
  } catch (error) {
    return failedCheck(runtimeName, readErrorMessage(error));
  }
}

async function checkDatabaseSchema(
  database: CiteLoomDatabase,
): Promise<DoctorCheck> {
  try {
    const readiness = await readDatabaseReadiness(database);
    await Promise.all([
      database
        .select({ id: retrievalChunks384.id })
        .from(retrievalChunks384)
        .limit(1),
      database
        .select({ id: retrievalChunks768.id })
        .from(retrievalChunks768)
        .limit(1),
      database
        .select({ id: retrievalChunks1024.id })
        .from(retrievalChunks1024)
        .limit(1),
      database
        .select({ id: retrievalLexicalChunks.id })
        .from(retrievalLexicalChunks)
        .limit(1),
      database
        .select({ id: sourceDocuments.documentId })
        .from(sourceDocuments)
        .limit(1),
      database
        .select({ id: sourceContentDeletions.documentId })
        .from(sourceContentDeletions)
        .limit(1),
      database
        .select({ id: doclingArtifacts.documentId })
        .from(doclingArtifacts)
        .limit(1),
      database.select({ id: embeddingSpaces.id }).from(embeddingSpaces).limit(1),
      database
        .select({ resourceGroup: inferenceLimits.resourceGroup })
        .from(inferenceLimits)
        .limit(1),
      database
        .select({ id: workerHeartbeats.id })
        .from(workerHeartbeats)
        .limit(1),
    ]);
    const migrationNoun = readiness.appliedMigrationCount === 1
      ? "migration"
      : "migrations";
    return successfulCheck(
      "PostgreSQL",
      `database schema, ${readiness.appliedMigrationCount} ${migrationNoun}, and ${readiness.requiredExtensions.join(" and ")} extensions are ready`,
    );
  } catch (error) {
    return failedCheck("PostgreSQL", readErrorMessage(error));
  }
}

async function checkRerankerWithScheduler(
  config: RerankerConfig,
  scheduler: TaskScheduler,
): Promise<DoctorCheck> {
  const runtimeName = config.runtimeName;
  try {
    return await scheduler.run(
      (requestSignal) => probeReranker(config, requestSignal),
    );
  } catch (error) {
    return failedCheck(runtimeName, readErrorMessage(error));
  }
}

function createUnavailableScheduler(error: unknown): TaskScheduler {
  return {
    capacity: 1,
    run: async (): Promise<never> => {
      throw error;
    },
  };
}

async function probeReranker(
  config: RerankerConfig,
  abortSignal: AbortSignal,
): Promise<DoctorCheck> {
  const model = createHttpRerankingModel(config);
  return probeRerankingModel(
    config,
    model,
    AbortSignal.any([
      abortSignal,
      AbortSignal.timeout(config.timeoutMs),
    ]),
  );
}

async function checkRuntimeReranker(
  config: RerankerConfig,
  reranker: ResolvedReranker,
  scheduler: TaskScheduler,
): Promise<DoctorCheck> {
  try {
    return await scheduler.run(
      (requestSignal) => probeRerankingModel(
        config,
        reranker.model,
        AbortSignal.any([
          requestSignal,
          AbortSignal.timeout(config.timeoutMs),
        ]),
      ),
    );
  } catch (error: unknown) {
    return failedCheck(config.runtimeName, readErrorMessage(error));
  }
}

async function probeRerankingModel(
  config: RerankerConfig,
  model: ResolvedReranker["model"],
  abortSignal: AbortSignal,
): Promise<DoctorCheck> {
  const runtimeName = config.runtimeName;
  try {
    const result = await rerank({
      abortSignal,
      documents: [
        "A local reranker scores documents against a query.",
        "This sentence is unrelated to retrieval.",
      ],
      maxRetries: 0,
      model,
      query: "How does a local reranker score documents?",
      telemetry: {
        isEnabled: false,
        recordInputs: false,
        recordOutputs: false,
      },
      topN: 1,
    });
    if (result.ranking.length !== 1) {
      return failedCheck(
        runtimeName,
        "the rerank capability probe returned no ranked document",
      );
    }
    return successfulCheck(
      runtimeName,
      `model ${config.model} completed a rerank capability probe`,
    );
  } catch (error) {
    return failedCheck(runtimeName, readErrorMessage(error));
  }
}

async function checkDocling(config: DoclingConfig): Promise<DoctorCheck> {
  try {
    const version = await verifyDoclingService(config);
    return successfulCheck(
      "Docling",
      `Docling Serve ${version.serveVersion} with Docling ${version.version} is ready`,
    );
  } catch (error) {
    return failedCheck("Docling", readErrorMessage(error));
  }
}

function successfulCheck(name: string, detail: string): DoctorCheck {
  return { detail, name, ok: true };
}

function failedCheck(name: string, detail: string): DoctorCheck {
  return { detail, name, ok: false };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
