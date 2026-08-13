import { describe, expect, it } from "vitest";

import {
  buildAppConfig,
  BOOTSTRAP_DATABASE_POOL_MAX,
  parseRuntimeSettings,
  readDatabaseConfig,
  readEmbeddingConfigurationWarnings,
} from "../src/config/index.js";
import {
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
        applicationErrorMaximumRows: 12_000,
        applicationErrorRetentionDays: 14,
        aiMetricsEnabled: false,
        databasePoolMax: 12,
        embeddingDimensions: 384,
        hhemMaxAttentionCells: 5_000_000,
        hhemMaxPaddedTokens: 10_000,
        hhemModelBatchSize: 8,
        hhemTorchThreads: 3,
        maxDocumentMegabytes: 100,
        maxUploadRequestMegabytes: 64,
        mcpTaskRetentionDays: 14,
        publicOrigin: "https://localhost:4443/",
        secureSessionCookie: false,
        topK: 7,
        trustProxy: true,
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
    expect(config.applicationErrorRetention).toEqual({
      maximumRows: 12_000,
      retentionDays: 14,
    });
    expect(config.database.poolMax).toBe(12);
    expect(config.maxDocumentBytes).toBe(100 * 1_024 * 1_024);
    expect(config.mcp.taskRetentionMs).toBe(14 * 24 * 60 * 60 * 1_000);
    expect(config.retrieval.topK).toBe(7);
    expect(config.verifierProcess).toEqual({
      maxAttentionCells: 5_000_000,
      maxPaddedTokens: 10_000,
      modelBatchSize: 8,
      torchThreads: 3,
    });
    expect(config.web).toEqual({
      maximumUploadRequestBytes: 64 * 1_024 * 1_024,
      publicOrigin: "https://localhost:4443",
      secureSessionCookie: false,
      trustProxy: true,
    });
  });

  it("applies the database-owned default Docling capacity without changing replicas", () => {
    const process = {
      numThreads: 4,
      pageBatchSize: 4,
      profilePipelineTimings: false,
    };

    const config = readEqualWeightTestConfig({
      runtime: {
        doclingAdditionalServiceInstances: [{
          baseUrl: "http://docling-b:5001",
          capacity: 2,
          id: "replica-b",
        }],
        doclingBaseUrl: "http://docling-a:5001",
        doclingDefaultServiceCapacity: 5,
      },
    });

    expect(config.doclingServices).toEqual([
      {
        baseUrl: "http://docling-a:5001",
        capacity: 5,
        id: "default",
        process,
      },
      {
        baseUrl: "http://docling-b:5001",
        capacity: 2,
        id: "replica-b",
        process,
      },
    ]);
  });

  it("selects the application search method independently from reranking", () => {
    const methods = ["bm25", "dense", "hybrid"] as const;
    for (const method of methods) {
      const withoutReranker = readEqualWeightTestConfig({
        providerOptions: { rerankEnabled: false },
        runtime: { searchMethod: method },
      });
      const withReranker = readEqualWeightTestConfig({
        providerOptions: { rerankEnabled: true },
        runtime: { searchMethod: method },
      });

      expect(withoutReranker.retrieval.mode).toBe(method);
      expect(withoutReranker.retrieval.reranker).toBeNull();
      expect(withReranker.retrieval.mode).toBe(method);
      expect(withReranker.retrieval.reranker).not.toBeNull();
    }
  });

  it("maps provider capabilities onto provider concurrency limits", () => {
    const runtimeSettings = createTestRuntimeSettings();
    const providers = createTestProviderSettings();
    providers.connections.lmstudio.maximumParallelRequests = 3;
    const config = buildAppConfig(
      {
        poolMax: 4,
        url: "postgresql://citeloom:citeloom@localhost:5432/citeloom",
      },
      runtimeSettings,
      7,
      providers,
      TEST_SOURCE_CONTENT_CONFIG,
      TEST_EMBEDDING_INPUT_FORMAT,
    );

    expect(config.scheduling.settingsVersion).toBe(7);
    expect(config.scheduling.targets).toEqual({
      answer: { providerId: "lmstudio" },
      chat: { providerId: "lmstudio" },
      embedding: { providerId: "lmstudio" },
      queryExpansion: { providerId: "lmstudio" },
      indexing: { providerId: "lmstudio" },
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
    expect(() => buildAppConfig(
      {
        poolMax: 4,
        url: "postgresql://citeloom:citeloom@localhost:5432/citeloom",
      },
      runtimeSettings,
      -1,
      providers,
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
      mcpTaskRetentionDays: 0,
    })).toThrow("mcpTaskRetentionDays");
    expect(() => parseRuntimeSettings({
      ...runtimeSettings,
      retrievalChunkTargetTokens: 0,
    })).toThrow("retrievalChunkTargetTokens");
    expect(() => parseRuntimeSettings({
      ...runtimeSettings,
      searchMethod: "automatic",
    })).toThrow("searchMethod");
  });

  it("accepts retrieval counts above the former fixed limits", () => {
    const settings = parseRuntimeSettings({
      ...createTestRuntimeSettings(),
      retrievalCandidates: 501,
      topK: 500,
    });

    expect(settings.retrievalCandidates).toBe(501);
    expect(settings.topK).toBe(500);
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
      "Document section size 4096 exceeds the embedding model's maximum input of "
      + "2048 tokens. CiteLoom will use 2048 tokens instead.",
    ]);
  });
});

describe("startup configuration boundaries", () => {
  it("uses a single bootstrap connection before database settings load", () => {
    expect(readDatabaseConfig({
      DATABASE_POOL_MAX: "4",
      DATABASE_URL: "postgresql://citeloom:citeloom@localhost:5432/citeloom",
    })).toEqual({
      poolMax: BOOTSTRAP_DATABASE_POOL_MAX,
      url: "postgresql://citeloom:citeloom@localhost:5432/citeloom",
    });
  });

  it("reads Docling process and replica topology from runtime settings", () => {
    const settings = parseRuntimeSettings({
      ...createTestRuntimeSettings(),
      doclingAdditionalServiceInstances: [
        { baseUrl: "http://docling-b:5001/", capacity: 2, id: "replica-b" },
      ],
      doclingNumThreads: 12,
      doclingPageBatchSize: 8,
      doclingProfilePipelineTimings: true,
    });
    const config = readEqualWeightTestConfig({ runtime: settings });

    expect(config.doclingServices[1]).toEqual({
      baseUrl: "http://docling-b:5001",
      capacity: 2,
      id: "replica-b",
      process: {
        numThreads: 12,
        pageBatchSize: 8,
        profilePipelineTimings: true,
      },
    });
  });

  it("rejects duplicate Docling replica addresses", () => {
    expect(() => parseRuntimeSettings({
      ...createTestRuntimeSettings(),
      doclingAdditionalServiceInstances: [
        { baseUrl: "http://docling-a:5001", capacity: 1, id: "replica-a" },
        { baseUrl: "http://docling-a:5001/", capacity: 1, id: "replica-b" },
      ],
    })).toThrow("duplicate service base URL");
  });
});
