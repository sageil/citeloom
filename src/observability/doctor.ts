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
  category: DoctorCheckCategory;
  detail: string;
  groupId: string;
  groupName: string;
  items: string[];
  mode: "live" | "readiness";
  name: string;
  ok: boolean;
}

export type DoctorCheckCategory =
  | "claim-verification"
  | "document-processing"
  | "embedding"
  | "generation"
  | "model-response"
  | "persistence"
  | "search-ranking"
  | "speech-input"
  | "spoken-answers";

export interface DoctorLiveChecks {
  modelResponse: boolean;
  searchRanking: boolean;
  speech: boolean;
}

export const SERVICE_READINESS_CHECKS: DoctorLiveChecks = Object.freeze({
  modelResponse: false,
  searchRanking: false,
  speech: false,
});

const ALL_DOCTOR_LIVE_CHECKS: DoctorLiveChecks = Object.freeze({
  modelResponse: true,
  searchRanking: true,
  speech: true,
});

interface DoctorCheckIdentity {
  category: DoctorCheckCategory;
  groupId: string;
  groupName: string;
  items: string[];
  mode: "live" | "readiness";
  name: string;
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
      failedCheck(infrastructureCheck(
        "persistence",
        "Database",
      ), readErrorMessage(error)),
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
      infrastructureCheck("generation", "Inference runtime"),
      "the database connection required to initialize providers is unavailable",
    )));
  } else if (database !== null) {
    pendingChecks.push(...buildInferenceRuntimeChecks(
      config.inference,
      config.claimVerifier,
      models.answer,
      resolveScheduler("answer"),
      database,
      ALL_DOCTOR_LIVE_CHECKS,
    ));
  }
  if (config.retrieval.reranker !== null) {
    pendingChecks.push(checkRerankerProviderRuntime(
      config.retrieval.reranker,
    ));
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
  liveChecks: DoctorLiveChecks = SERVICE_READINESS_CHECKS,
): Promise<DoctorCheck[]> {
  const config = runtime.config;
  const pendingChecks = [
    ...buildInferenceRuntimeChecks(
      config.inference,
      config.claimVerifier,
      runtime.models.answer,
      runtime.scheduler("answer", "maintenance"),
      runtime.database,
      liveChecks,
    ),
    checkDatabaseSchema(runtime.database),
    checkDocling(config.docling),
  ];
  if (liveChecks.speech) {
    pendingChecks.push(...buildSpeechProviderChecks(
      config,
      (capability) => runtime.scheduler(capability, "maintenance"),
    ));
  }
  if (config.retrieval.reranker !== null) {
    pendingChecks.push(checkRerankerProviderRuntime(
      config.retrieval.reranker,
    ));
  }
  if (liveChecks.searchRanking && config.retrieval.reranker !== null) {
    if (runtime.models.reranker === null) {
      pendingChecks.push(Promise.resolve(failedCheck(
        providerCheck(
          config.retrieval.reranker,
          "search-ranking",
          "Search ranking",
          [config.retrieval.reranker.model],
          "live",
        ),
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
      providerCheck(
        config,
        "speech-input",
        "Speech input",
        [config.model],
        "live",
      ),
      `model ${config.model} accepted a transcription capability probe`,
    );
  } catch (error: unknown) {
    return failedCheck(providerCheck(
      config,
      "speech-input",
      "Speech input",
      [config.model],
      "live",
    ), readErrorMessage(error));
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
      providerCheck(
        config,
        "spoken-answers",
        "Spoken answers",
        [config.model],
        "live",
      ),
      `model ${config.model} returned an audio capability probe`,
    );
  } catch (error: unknown) {
    return failedCheck(providerCheck(
      config,
      "spoken-answers",
      "Spoken answers",
      [config.model],
      "live",
    ), readErrorMessage(error));
  }
}

function buildInferenceRuntimeChecks(
  config: InferenceConfig,
  claimVerifier: ClaimVerifierConfig,
  answerModel: LanguageModelV4,
  answerScheduler: TaskScheduler,
  database: CiteLoomDatabase,
  liveChecks: DoctorLiveChecks,
): Promise<DoctorCheck>[] {
  const groups = groupInferenceProviders([
    { config: config.answer, item: "Ask" },
    { config: config.chat, item: "Chat" },
    { config: config.queryExpansion, item: "Query expansion" },
    { config: config.summary, item: "Summaries" },
    { config: config.embedding, item: config.embedding.model },
  ]);
  const checks: Promise<DoctorCheck>[] = [];
  if (liveChecks.modelResponse) {
    checks.push(checkStructuredAnswerCapability(
      answerModel,
      config.answer,
      answerScheduler,
    ));
  }
  for (const group of groups) {
    checks.push(checkInferenceProviderRuntime(
      group.config,
      group.models,
      group.items,
      database,
    ));
  }
  checks.push(checkHhemRuntime(claimVerifier));
  return checks;
}

async function checkStructuredAnswerCapability(
  model: LanguageModelV4,
  config: LanguageInferenceConfig,
  scheduler: TaskScheduler,
): Promise<DoctorCheck> {
  const identity = providerCheck(
    config,
    "model-response",
    "Structured cited response",
    [config.model],
    "live",
    "model-response",
    "Model response verification",
  );
  try {
    const allowedEvidenceRefs = createEvidenceReferences(1);
    const result = await scheduler.run(
      (requestSignal) => generateText({
        abortSignal: AbortSignal.any([
          requestSignal,
          AbortSignal.timeout(config.timeoutMs),
        ]),
        maxOutputTokens: 200,
        maxRetries: 0,
        model,
        output: createAnswerModelOutput(allowedEvidenceRefs),
        prompt: [
          "USER_PROMPT",
          "---------",
          "<retrieved_sources>",
          "EVID_A: A readiness probe checks structured answer generation.",
          "</retrieved_sources>",
          "",
          "<current_question>",
          "What does the retrieved source material say about structured answer generation?",
          "</current_question>",
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
        identity,
        `model ${config.model} returned an uncited response for the structured-output readiness probe`,
      );
    }
    return successfulCheck(
      identity,
      `model ${config.model} returned a valid structured, cited response`,
    );
  } catch (error) {
    return failedCheck(identity, readErrorMessage(error));
  }
}

type InferenceProviderConfig =
  | EmbeddingInferenceConfig
  | LanguageInferenceConfig;

interface InferenceProviderGroup {
  config: InferenceProviderConfig;
  items: string[];
  models: string[];
}

interface InferenceProviderTarget {
  config: InferenceProviderConfig | null;
  item: string;
}

function groupInferenceProviders(
  targets: readonly InferenceProviderTarget[],
): InferenceProviderGroup[] {
  const groups: InferenceProviderGroup[] = [];
  for (const target of targets) {
    const config = target.config;
    if (config === null) {
      continue;
    }
    const existing = groups.find((candidate) => {
      return candidate.config.adapter === config.adapter
        && candidate.config.apiToken === config.apiToken
        && candidate.config.baseUrl === config.baseUrl
        && candidate.config.providerId === config.providerId
        && candidate.config.runtimeName === config.runtimeName;
    });
    if (existing === undefined) {
      groups.push({ config, items: [target.item], models: [config.model] });
      continue;
    }
    if (!existing.items.includes(target.item)) {
      existing.items.push(target.item);
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
  items: readonly string[],
  database: CiteLoomDatabase,
): Promise<DoctorCheck> {
  const category = config.adapter.includes("embedding")
    ? "embedding"
    : "generation";
  const name = category === "embedding"
    ? "Embeddings"
    : "Generation availability";
  const identity = providerCheck(config, category, name, items);
  if (config.adapter === "openai-codex-language") {
    return checkOpenAICodexRuntime(configuredModels, database, identity);
  }
  if (
    config.adapter === "cohere-language"
    || config.adapter === "cohere-embedding"
  ) {
    return checkCohereRuntime(config, configuredModels, identity);
  }
  if (
    config.adapter === "ollama-embedding"
    || config.adapter === "ollama-language"
  ) {
    return checkOllamaRuntime(config, configuredModels, identity);
  }
  return checkOpenAICompatibleRuntime(config, configuredModels, identity);
}

function checkRerankerProviderRuntime(
  config: RerankerConfig,
): Promise<DoctorCheck> {
  const identity = providerCheck(
    config,
    "search-ranking",
    "Search ranking availability",
    [config.model],
  );
  if (config.providerId === "cohere") {
    return checkCohereRuntime(config, [config.model], identity);
  }
  return checkOpenAICompatibleRuntime(config, [config.model], identity);
}

async function checkOpenAICodexRuntime(
  configuredModels: readonly string[],
  database: CiteLoomDatabase,
  identity: DoctorCheckIdentity,
): Promise<DoctorCheck> {
  try {
    const models = await readOpenAICodexModels(database, {
      signal: AbortSignal.timeout(10_000),
    });
    const available = new Set(models.map((model) => model.id));
    const missing = configuredModels.filter((model) => !available.has(model));
    if (missing.length > 0) {
      return failedCheck(
        identity,
        `the Codex subscription does not list configured model(s): ${missing.join(", ")}`,
      );
    }
    return successfulCheck(
      identity,
      `the Codex subscription lists ${configuredModels.join(", ")}`,
    );
  } catch (error: unknown) {
    return failedCheck(identity, readErrorMessage(error));
  }
}

async function checkHhemRuntime(
  config: ClaimVerifierConfig,
): Promise<DoctorCheck> {
  const identity = readinessCheck(
    "claim-verification",
    "claim-verifier",
    config.runtimeName,
    "Claim verification",
    [config.model],
  );
  try {
    const client = new HttpHhemClient(config);
    await client.checkReady();
    return successfulCheck(
      identity,
      `model ${config.model} is loaded and ready`,
    );
  } catch (error: unknown) {
    return failedCheck(identity, readErrorMessage(error));
  }
}

async function checkOpenAICompatibleRuntime(
  config: ProviderRuntimeConfig,
  configuredModels: readonly string[],
  identity: DoctorCheckIdentity,
): Promise<DoctorCheck> {
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
      return failedCheck(identity, `GET /models returned HTTP ${response.status}`);
    }

    const responseBody: unknown = await response.json();
    const parsed = inferenceModelsSchema.safeParse(responseBody);
    if (!parsed.success) {
      return failedCheck(identity, "GET /models returned an invalid response");
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
        identity,
        `server is reachable, but these configured models are not visible: ${missingModels.join(", ")}`,
      );
    }

    return successfulCheck(
      identity,
      `server is reachable and all configured models are visible`,
    );
  } catch (error) {
    return failedCheck(identity, readErrorMessage(error));
  }
}

async function checkCohereRuntime(
  config: ProviderRuntimeConfig,
  configuredModels: readonly string[],
  identity: DoctorCheckIdentity,
): Promise<DoctorCheck> {
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
          identity,
          `model ${model} check returned HTTP ${response.status}`,
        );
      }
    }
    return successfulCheck(
      identity,
      "server is reachable and all configured models are visible",
    );
  } catch (error) {
    return failedCheck(identity, readErrorMessage(error));
  }
}

async function checkOllamaRuntime(
  config: ProviderRuntimeConfig,
  configuredModels: readonly string[],
  identity: DoctorCheckIdentity,
): Promise<DoctorCheck> {
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
      return failedCheck(identity, `GET /api/tags returned HTTP ${response.status}`);
    }
    const responseBody: unknown = await response.json();
    const parsed = ollamaModelsSchema.safeParse(responseBody);
    if (!parsed.success) {
      return failedCheck(identity, "GET /api/tags returned an invalid response");
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
        identity,
        `server is reachable, but these configured models are not visible: ${missingModels.join(", ")}`,
      );
    }
    return successfulCheck(
      identity,
      "Ollama is reachable and all configured models are visible",
    );
  } catch (error) {
    return failedCheck(identity, readErrorMessage(error));
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
      infrastructureCheck("persistence", "Database"),
      `database schema, ${readiness.appliedMigrationCount} ${migrationNoun}, and ${readiness.requiredExtensions.join(" and ")} extensions are ready`,
    );
  } catch (error) {
    return failedCheck(
      infrastructureCheck("persistence", "Database"),
      readErrorMessage(error),
    );
  }
}

async function checkRerankerWithScheduler(
  config: RerankerConfig,
  scheduler: TaskScheduler,
): Promise<DoctorCheck> {
  try {
    return await scheduler.run(
      (requestSignal) => probeReranker(config, requestSignal),
    );
  } catch (error) {
    return failedCheck(providerCheck(
      config,
      "search-ranking",
      "Search ranking",
      [config.model],
      "live",
    ), readErrorMessage(error));
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
    return failedCheck(providerCheck(
      config,
      "search-ranking",
      "Search ranking",
      [config.model],
      "live",
    ), readErrorMessage(error));
  }
}

async function probeRerankingModel(
  config: RerankerConfig,
  model: ResolvedReranker["model"],
  abortSignal: AbortSignal,
): Promise<DoctorCheck> {
  const identity = providerCheck(
    config,
    "search-ranking",
    "Search ranking",
    [config.model],
    "live",
  );
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
        identity,
        "the rerank capability probe returned no ranked document",
      );
    }
    return successfulCheck(
      identity,
      `model ${config.model} completed a rerank capability probe`,
    );
  } catch (error) {
    return failedCheck(identity, readErrorMessage(error));
  }
}

async function checkDocling(config: DoclingConfig): Promise<DoctorCheck> {
  try {
    const version = await verifyDoclingService(config);
    return successfulCheck(
      infrastructureCheck("document-processing", "Document conversion"),
      `Docling Serve ${version.serveVersion} with Docling ${version.version} is ready`,
    );
  } catch (error) {
    return failedCheck(
      infrastructureCheck("document-processing", "Document conversion"),
      readErrorMessage(error),
    );
  }
}

function readinessCheck(
  category: DoctorCheckCategory,
  groupId: string,
  groupName: string,
  name: string,
  items: readonly string[] = [],
): DoctorCheckIdentity {
  return {
    category,
    groupId,
    groupName,
    items: [...items],
    mode: "readiness",
    name,
  };
}

function infrastructureCheck(
  category: "document-processing" | "generation" | "persistence",
  name: string,
): DoctorCheckIdentity {
  return readinessCheck(
    category,
    "infrastructure",
    "Infrastructure",
    name,
  );
}

function providerCheck(
  config: ProviderRuntimeConfig,
  category: DoctorCheckCategory,
  name: string,
  items: readonly string[],
  mode: "live" | "readiness" = "readiness",
  groupId = `provider:${config.providerId}`,
  groupName = config.runtimeName,
): DoctorCheckIdentity {
  return {
    category,
    groupId,
    groupName,
    items: [...items],
    mode,
    name,
  };
}

function successfulCheck(
  identity: DoctorCheckIdentity,
  detail: string,
): DoctorCheck {
  return { ...identity, detail, ok: true };
}

function failedCheck(
  identity: DoctorCheckIdentity,
  detail: string,
): DoctorCheck {
  return { ...identity, detail, ok: false };
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
