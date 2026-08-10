import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildAppConfig,
  parseRuntimeSettings,
  type AppConfig,
  type DatabaseConfig,
  type DoclingServiceInstanceConfig,
  type DoclingServiceTopology,
  type ProviderSettings,
  type RankFusionConfig,
  type RuntimeSettings,
  type SourceContentConfig,
} from "../src/config/index.js";
import {
  createTestProviderSettings,
  type TestProviderSettingsOptions,
} from "./provider-settings-fixture.js";
import {
  BUILT_IN_EMBEDDING_INPUT_FORMAT_IDS,
  createEmbeddingInputFormatContract,
  type EmbeddingInputFormatContract,
} from "../src/embedding/input-format.js";

export const EQUAL_WEIGHT_FUSION_CONFIG: Readonly<RankFusionConfig> =
  Object.freeze({
    denseWeight: 1,
    expansionDecay: 1,
    expansionQueryWeight: 1,
    lexicalWeight: 1,
    originalQueryWeight: 1,
  });

const TEST_DATABASE_CONFIG: Readonly<DatabaseConfig> = Object.freeze({
  poolMax: 4,
  url: "postgresql://citeloom:citeloom@127.0.0.1:5433/citeloom_test",
});

export const TEST_SOURCE_CONTENT_CONFIG: Readonly<SourceContentConfig> =
  Object.freeze({
    directory: join(tmpdir(), "citeloom-test-source-content"),
    kind: "filesystem",
  });

export const TEST_EMBEDDING_INPUT_FORMAT = Object.freeze(
  createEmbeddingInputFormatContract(
    BUILT_IN_EMBEDDING_INPUT_FORMAT_IDS.embeddingGemma,
    {
      documentTemplate: "title: none | text: {{text}}",
      name: "EmbeddingGemma",
      queryTemplate: "task: search result | query: {{text}}",
      schemaVersion: 1,
    },
  ),
);

export const TEST_PLAIN_EMBEDDING_INPUT_FORMAT = Object.freeze(
  createEmbeddingInputFormatContract(
    BUILT_IN_EMBEDDING_INPUT_FORMAT_IDS.plain,
    {
      documentTemplate: "{{text}}",
      name: "Plain",
      queryTemplate: "{{text}}",
      schemaVersion: 1,
    },
  ),
);

const TEST_RUNTIME_SETTINGS: Readonly<RuntimeSettings> = Object.freeze({
  answerMinimumOutputTokens: 256,
  answerProviderSafetyMarginTokens: 2_048,
  answerTemperature: 0,
  answerTimeoutSeconds: 900,
  aiMetricsEnabled: true,
  backgroundProgressIntervalMs: 5_000,
  chatTemperature: 0,
  claimVerifierBaseUrl: "http://127.0.0.1:8088",
  claimVerifierRuntimeName: "HHEM-2.1-Open",
  claimVerifierSupportThreshold: 0.5,
  claimVerifierTimeoutSeconds: 120,
  denseWeight: 1,
  doclingApiKey: null,
  doclingBaseUrl: "http://127.0.0.1:5001",
  doclingDefaultServiceCapacity: 2,
  doclingMaxTimeoutSeconds: 43_200,
  doclingMegabyteTimeoutSeconds: 60,
  doclingOcrEnabled: true,
  doclingPageTimeoutSeconds: 30,
  doclingPdfBackend: "docling_parse",
  doclingPerformanceMetricsEnabled: false,
  doclingPerformanceMetricsRetentionDays: 30,
  doclingPipeline: "standard",
  doclingRequestTimeoutSeconds: 300,
  doclingSecondaryImageScale: 2,
  doclingTableMode: "accurate",
  doclingTableStructureEnabled: true,
  doclingTocEnabled: true,
  doclingTimeoutSeconds: 1_800,
  doclingVlmMaxOutputTokens: 32_768,
  doclingVlmModelOverride: "frob/unlimited-ocr:q8_0",
  doclingVlmPrompt: "document parsing.",
  doclingVlmProviderId: "ollama",
  embeddingDimensions: 768,
  embeddingInputFormatId: TEST_EMBEDDING_INPUT_FORMAT.id,
  embeddingSpaceId: null,
  embeddingTimeoutSeconds: 21_600,
  expansionDecay: 1,
  expansionQueryWeight: 1,
  findSourcesPassagesPerDocument: 3,
  findSourcesResults: 10,
  lexicalWeight: 1,
  maxAttempts: 3,
  maxDocumentMegabytes: 100,
  originalQueryWeight: 1,
  queryExpansions: 2,
  queryExpansionTemperature: 0,
  queryExpansionTimeoutSeconds: 900,
  rerankDiscoveryMinimumScore: 0.5,
  rerankTimeoutSeconds: 300,
  retrievalCandidates: 50,
  retrievalChunkTargetTokens: 512,
  retrievalWindowPolicy: "structured-token-v3",
  retryBaseMs: 5_000,
  rrfK: 60,
  searchMethod: "hybrid",
  sttLanguage: "English",
  sttMaxAudioMegabytes: 10,
  sttPrompt: null,
  sttTimeoutSeconds: 60,
  indexingTimeoutSeconds: 21_600,
  topK: 10,
  ttsPreloadEnabled: false,
  ttsSpeed: 1,
  ttsTimeoutSeconds: 30,
  workerConcurrency: 2,
  workerFallbackPollMs: 60_000,
});

export interface TestConfigOptions {
  database?: Partial<DatabaseConfig>;
  doclingTopology?: DoclingServiceTopology;
  embeddingInputFormat?: EmbeddingInputFormatContract;
  providerOptions?: TestProviderSettingsOptions;
  providerSettings?: ProviderSettings;
  runtime?: Partial<RuntimeSettings>;
  sourceContent?: SourceContentConfig;
  settingsVersion?: number;
}

export function createTestRuntimeSettings(
  overrides: Partial<RuntimeSettings> = {},
): RuntimeSettings {
  return parseRuntimeSettings({
    ...TEST_RUNTIME_SETTINGS,
    ...overrides,
  });
}

export function createTestDoclingTopology(): DoclingServiceTopology {
  return {
    additionalServices: [],
    process: {
      numThreads: 4,
      pageBatchSize: 4,
      profilePipelineTimings: false,
    },
  };
}

export function readEqualWeightTestConfig(
  options: TestConfigOptions = {},
): AppConfig {
  const database = {
    ...TEST_DATABASE_CONFIG,
    ...options.database,
  };
  const runtimeSettings = createTestRuntimeSettings(options.runtime);
  const providerSettings = options.providerSettings
    ?? createTestProviderSettings(options.providerOptions);
  const doclingTopology = options.doclingTopology
    ?? createTestDoclingTopology();
  const doclingServices = buildTestDoclingServices(
    runtimeSettings,
    doclingTopology,
  );
  return buildAppConfig(
    database,
    runtimeSettings,
    options.settingsVersion ?? 0,
    providerSettings,
    doclingServices,
    options.sourceContent ?? TEST_SOURCE_CONTENT_CONFIG,
    options.embeddingInputFormat ?? TEST_EMBEDDING_INPUT_FORMAT,
  );
}

function buildTestDoclingServices(
  runtimeSettings: RuntimeSettings,
  topology: DoclingServiceTopology,
): DoclingServiceInstanceConfig[] {
  const defaultService: DoclingServiceInstanceConfig = {
    baseUrl: runtimeSettings.doclingBaseUrl,
    capacity: runtimeSettings.doclingDefaultServiceCapacity,
    id: "default",
    process: { ...topology.process },
  };
  const services = [defaultService];
  for (const additionalService of topology.additionalServices) {
    services.push({
      ...additionalService,
      process: { ...topology.process },
    });
  }
  return services;
}
