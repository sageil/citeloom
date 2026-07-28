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
  });

const TEST_RUNTIME_SETTINGS: Readonly<RuntimeSettings> = Object.freeze({
  answerMaximumOutputTokens: 8_192,
  answerMinimumOutputTokens: 256,
  answerProviderSafetyMarginTokens: 2_048,
  answerTemperature: 0,
  answerTimeoutSeconds: 900,
  aiMetricsEnabled: true,
  backgroundProgressIntervalMs: 5_000,
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
  doclingRequestTimeoutSeconds: 300,
  doclingSecondaryImageScale: 2,
  doclingTableMode: "accurate",
  doclingTableStructureEnabled: true,
  doclingTimeoutSeconds: 1_800,
  embeddingDimensions: 768,
  embeddingProfile: "embeddinggemma",
  embeddingSpaceId: null,
  embeddingTimeoutSeconds: 21_600,
  expansionDecay: 1,
  expansionQueryWeight: 1,
  generationSeedMode: "stable",
  inferenceThinkingMode: "disabled",
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
  retrievalVariantConcurrency: 2,
  retrievalWindowPolicy: "structured-token-v3",
  retryBaseMs: 5_000,
  rrfK: 60,
  sttLanguage: "English",
  sttMaxAudioMegabytes: 10,
  sttPrompt: null,
  sttTimeoutSeconds: 60,
  summaryTimeoutSeconds: 21_600,
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
