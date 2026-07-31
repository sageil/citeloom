import { describe, expect, it } from "vitest";

import {
  buildAppConfig,
  parseRuntimeSettings,
  readApplicationErrorRetentionConfig,
  readDatabaseConfig,
  readDoclingProcessConfiguration,
  readDoclingServiceTopology,
  readEmbeddingConfigurationWarnings,
} from "../src/config/index.js";
import {
  createTestDoclingTopology,
  createTestRuntimeSettings,
  readEqualWeightTestConfig,
  TEST_EMBEDDING_INPUT_FORMAT,
  TEST_SOURCE_CONTENT_CONFIG,
} from "./config-fixture.js";
import { createTestProviderSettings } from "./provider-settings-fixture.js";

describe("application configuration", () => {
  it("builds runtime configuration from explicit settings and providers", () => {
    const config = readEqualWeightTestConfig({
      providerOptions: {
        inferenceApiToken: "local-token",
        inferenceBaseUrl: "http://localhost:11434/v1/",
      },
      runtime: {
        aiMetricsEnabled: false,
        embeddingDimensions: 384,
        maxDocumentMegabytes: 100,
        topK: 7,
      },
      settingsVersion: 4,
    });

    expect(config.settingsVersion).toBe(4);
    expect(config.inference.answer).toMatchObject({
      apiToken: "local-token",
      baseUrl: "http://localhost:11434/v1",
      model: "vision-model",
    });
    expect(config.inference.embedding).toMatchObject({
      apiToken: "local-token",
      maximumInputTokens: 2_048,
      model: "embedding-model",
    });
    expect(config.embeddingSpace).toMatchObject({
      dimensions: 384,
      model: "embedding-model",
    });
    expect(config.inferenceMetrics.enabled).toBe(false);
    expect(config.maxDocumentBytes).toBe(100 * 1_024 * 1_024);
    expect(config.retrieval.topK).toBe(7);
  });

  it("applies the database-owned default Docling capacity without changing replicas", () => {
    const topology = createTestDoclingTopology();
    topology.additionalServices.push({
      baseUrl: "http://docling-b:5001",
      capacity: 2,
      id: "replica-b",
    });

    const config = readEqualWeightTestConfig({
      doclingTopology: topology,
      runtime: {
        doclingBaseUrl: "http://docling-a:5001",
        doclingDefaultServiceCapacity: 5,
      },
    });

    expect(config.doclingServices).toEqual([
      {
        baseUrl: "http://docling-a:5001",
        capacity: 5,
        id: "default",
        process: topology.process,
      },
      {
        baseUrl: "http://docling-b:5001",
        capacity: 2,
        id: "replica-b",
        process: topology.process,
      },
    ]);
  });

  it("maps provider capabilities onto provider concurrency limits", () => {
    const runtimeSettings = createTestRuntimeSettings();
    const providers = createTestProviderSettings();
    providers.connections.lmstudio.maximumParallelRequests = 3;
    const topology = createTestDoclingTopology();
    const doclingServices = readEqualWeightTestConfig({
      doclingTopology: topology,
      runtime: runtimeSettings,
    }).doclingServices;

    const config = buildAppConfig(
      {
        poolMax: 4,
        url: "postgresql://citeloom:citeloom@localhost:5432/citeloom",
      },
      runtimeSettings,
      7,
      providers,
      doclingServices,
      TEST_SOURCE_CONTENT_CONFIG,
      TEST_EMBEDDING_INPUT_FORMAT,
    );

    expect(config.scheduling.settingsVersion).toBe(7);
    expect(config.scheduling.targets).toEqual({
      answer: { providerId: "lmstudio" },
      chat: { providerId: "lmstudio" },
      embedding: { providerId: "lmstudio" },
      queryExpansion: { providerId: "lmstudio" },
      summarization: { providerId: "lmstudio" },
    });
    expect(config.scheduling.providers).toContainEqual({
      maximumParallelRequests: 3,
      name: "LM Studio",
      providerId: "lmstudio",
    });
  });

  it("rejects invalid settings versions and cross-setting values", () => {
    const runtimeSettings = createTestRuntimeSettings();
    const providers = createTestProviderSettings();
    const doclingServices = readEqualWeightTestConfig().doclingServices;

    expect(() => buildAppConfig(
      {
        poolMax: 4,
        url: "postgresql://citeloom:citeloom@localhost:5432/citeloom",
      },
      runtimeSettings,
      -1,
      providers,
      doclingServices,
      TEST_SOURCE_CONTENT_CONFIG,
      TEST_EMBEDDING_INPUT_FORMAT,
    )).toThrow("Settings version must be a nonnegative integer");
    expect(() => parseRuntimeSettings({
      ...runtimeSettings,
      retrievalCandidates: 5,
      topK: 10,
    })).toThrow("retrievalCandidates");
    expect(() => parseRuntimeSettings({
      ...runtimeSettings,
      doclingMaxTimeoutSeconds: 60,
      doclingTimeoutSeconds: 120,
    })).toThrow("doclingMaxTimeoutSeconds");
    expect(() => parseRuntimeSettings({
      ...runtimeSettings,
      retrievalChunkTargetTokens: 0,
    })).toThrow("retrievalChunkTargetTokens");
  });

  it("clamps the effective retrieval target and reports a warning", () => {
    const runtimeSettings = createTestRuntimeSettings({
      retrievalChunkTargetTokens: 4_096,
    });
    const config = readEqualWeightTestConfig({
      runtime: runtimeSettings,
    });

    expect(
      config.embeddingSpace.retrievalWindow.policy.targetInputTokens,
    ).toBe(2_048);
    expect(
      config.embeddingSpace.retrievalWindow.policy.maximumInputTokens,
    ).toBe(2_048);
    expect(readEmbeddingConfigurationWarnings({
      embeddingContextCapacityTokens:
        config.inference.embedding.maximumInputTokens,
      retrievalChunkTargetTokens: runtimeSettings.retrievalChunkTargetTokens,
    })).toEqual([
      "Retrieval chunk target 4096 exceeds the embedding model context of "
      + "2048. CiteLoom is using 2048 tokens as the effective retrieval chunk "
      + "target.",
    ]);
  });
});

describe("startup configuration boundaries", () => {
  it("reads bounded application error retention configuration", () => {
    expect(readApplicationErrorRetentionConfig({})).toEqual({
      maximumRows: 100_000,
      retentionDays: 30,
    });
    expect(readApplicationErrorRetentionConfig({
      CITELOOM_APPLICATION_ERROR_MAXIMUM_ROWS: "25000",
      CITELOOM_APPLICATION_ERROR_RETENTION_DAYS: "14",
    })).toEqual({
      maximumRows: 25_000,
      retentionDays: 14,
    });
    expect(() => readApplicationErrorRetentionConfig({
      CITELOOM_APPLICATION_ERROR_MAXIMUM_ROWS: "0",
    })).toThrow("Invalid application error retention configuration");
  });

  it("reads database-only configuration", () => {
    expect(readDatabaseConfig({
      DATABASE_POOL_MAX: "4",
      DATABASE_URL: "postgresql://citeloom:citeloom@localhost:5432/citeloom",
    })).toEqual({
      poolMax: 4,
      url: "postgresql://citeloom:citeloom@localhost:5432/citeloom",
    });
  });

  it("reads Docling process and replica topology", () => {
    const environment = {
      DOCLING_ADDITIONAL_SERVICE_INSTANCES: JSON.stringify([
        { baseUrl: "http://docling-b:5001/", capacity: 2, id: "replica-b" },
      ]),
      DOCLING_DEBUG_PROFILE_PIPELINE_TIMINGS: "true",
      DOCLING_NUM_THREADS: "12",
      DOCLING_PERF_PAGE_BATCH_SIZE: "8",
    };

    expect(readDoclingProcessConfiguration(environment)).toEqual({
      numThreads: 12,
      pageBatchSize: 8,
      profilePipelineTimings: true,
    });
    expect(readDoclingServiceTopology(environment)).toEqual({
      additionalServices: [{
        baseUrl: "http://docling-b:5001",
        capacity: 2,
        id: "replica-b",
      }],
      process: {
        numThreads: 12,
        pageBatchSize: 8,
        profilePipelineTimings: true,
      },
    });
  });

  it("rejects duplicate Docling replica addresses", () => {
    expect(() => readDoclingServiceTopology({
      DOCLING_ADDITIONAL_SERVICE_INSTANCES: JSON.stringify([
        { baseUrl: "http://docling-a:5001", capacity: 1, id: "replica-a" },
        { baseUrl: "http://docling-a:5001/", capacity: 1, id: "replica-b" },
      ]),
      DOCLING_DEBUG_PROFILE_PIPELINE_TIMINGS: "false",
      DOCLING_NUM_THREADS: "4",
      DOCLING_PERF_PAGE_BATCH_SIZE: "4",
    })).toThrow("duplicate service base URL");
  });
});
