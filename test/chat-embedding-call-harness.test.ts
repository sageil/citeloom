import { describe, expect, it } from "vitest";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";

import type { AuthenticatedPrincipal } from "../src/auth/model.js";
import {
  prepareChatMemory,
  type ChatMemoryRuntime,
  type ChatMemoryStore,
} from "../src/chat/memory.js";
import type {
  ChatMemoryTurnRecord,
  ChatMessageEmbeddingPart,
} from "../src/chat/store.js";
import { embedQuestions } from "../src/embedding/inference.js";
import { InferenceMetricsReporter } from "../src/inference/metrics.js";
import type { InferenceModelRegistry } from "../src/inference/registry.js";
import { TaskLimiter } from "../src/shared/concurrency.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";
import { FakeHhemClient } from "./hhem-fixture.js";
import { buildTestModelCapabilities } from "./model-capabilities-fixture.js";

const principal: AuthenticatedPrincipal = {
  displayName: "Harness User",
  role: "admin",
  sessionTokenDigest: "session-digest",
  userId: "00000000-0000-4000-8000-000000000001",
  username: "harness",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  workspaceName: "Harness Workspace",
};

describe("short Chat embedding call harness", () => {
  it("records every embedding provider request on the current production path", async () => {
    const documentEmbedding = buildEmbeddingModel();
    const queryEmbedding = buildEmbeddingModel();
    const scheduler = new TaskLimiter(4);
    const models = buildModelRegistry(documentEmbedding, queryEmbedding);
    const runtime = buildRuntime(models, scheduler);
    const store = buildShortConversationStore();
    const signal = new AbortController().signal;

    await prepareChatMemory(
      runtime,
      store,
      principal,
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004",
      "00000000-0000-4000-8000-000000000005",
      "What changed?",
      signal,
    );
    await embedQuestions(
      models,
      ["What changed?"],
      scheduler,
      signal,
    );
    expect(documentEmbedding.doEmbedCalls).toHaveLength(0);
    expect(queryEmbedding.doEmbedCalls.map((call) => call.values)).toEqual([
      ["What changed?"],
    ]);
    expect(
      documentEmbedding.doEmbedCalls.length + queryEmbedding.doEmbedCalls.length,
    ).toBe(1);
  });

  it("backfills only completed prior messages after semantic-memory overflow", async () => {
    const documentEmbedding = buildEmbeddingModel();
    const queryEmbedding = buildEmbeddingModel();
    const scheduler = new TaskLimiter(4);
    const models = buildModelRegistry(
      documentEmbedding,
      queryEmbedding,
      1_000,
    );
    const runtime = buildRuntime(models, scheduler);
    const harness = buildOverflowConversationStore();
    const signal = new AbortController().signal;

    await prepareChatMemory(
      runtime,
      harness.store,
      principal,
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004",
      "00000000-0000-4000-8000-000000000005",
      "What changed?",
      signal,
    );
    await embedQuestions(
      models,
      ["Previous context plus: What changed?"],
      scheduler,
      signal,
    );

    expect(documentEmbedding.doEmbedCalls.map((call) => call.values)).toEqual([
      [`User message:\n${"u".repeat(400)}`],
      [`Assistant answer:\n${"a".repeat(400)}`],
    ]);
    expect(harness.savedParts.map((part) => part.messageId)).toEqual([
      "00000000-0000-4000-8000-000000000006",
      "00000000-0000-4000-8000-000000000007",
    ]);
    expect(queryEmbedding.doEmbedCalls.map((call) => call.values)).toEqual([
      ["What changed?"],
      ["Previous context plus: What changed?"],
    ]);
  });
});

function buildEmbeddingModel(): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    doEmbed: async ({ values }) => ({
      embeddings: values.map((value) => [value.length]),
      usage: { tokens: values.length },
      warnings: [],
    }),
    maxEmbeddingsPerCall: 100,
    supportsParallelCalls: true,
  });
}

function buildModelRegistry(
  documentEmbedding: MockEmbeddingModelV4,
  queryEmbedding: MockEmbeddingModelV4,
  contextCapacityTokens = 1_000_000,
): InferenceModelRegistry {
  const languageModel = new MockLanguageModelV4();
  return {
    answer: languageModel,
    answerBudget: {
      maximumOutputTokens: 16_384,
      minimumOutputTokens: 256,
      providerSafetyMarginTokens: 0,
    },
    readAnswerCapabilities: async () => {
      return buildTestModelCapabilities(contextCapacityTokens);
    },
    claimVerifier: new FakeHhemClient(),
    documentEmbedding,
    metrics: new InferenceMetricsReporter({ enabled: false }),
    queryExpansion: languageModel,
    queryEmbedding,
    reranker: null,
    indexing: languageModel,
    timeouts: {
      answerMs: 900_000,
      embeddingMs: 600_000,
      queryExpansionMs: 900_000,
      indexingMs: 900_000,
    },
  };
}

function buildRuntime(
  models: InferenceModelRegistry,
  scheduler: TaskLimiter,
): ChatMemoryRuntime {
  const config = readEqualWeightTestConfig({
    runtime: {
      aiMetricsEnabled: false,
      queryExpansions: 0,
    },
  });
  return {
    config,
    models,
    scheduler: () => scheduler,
  };
}

function buildShortConversationStore(): ChatMemoryStore {
  return {
    readCompletedMemoryTurns: async () => [],
    readMessagesMissingEmbeddings: async () => {
      throw new Error("Short conversation must not read missing embeddings.");
    },
    saveMessageEmbeddings: async () => undefined,
    searchSemanticMemory: async () => {
      throw new Error("Short conversation must not search semantic memory.");
    },
  };
}

function buildOverflowConversationStore(): {
  savedParts: ChatMessageEmbeddingPart[];
  store: ChatMemoryStore;
} {
  const priorTurn: ChatMemoryTurnRecord = {
    assistantContent: "a".repeat(400),
    assistantMessageId: "00000000-0000-4000-8000-000000000007",
    runId: "00000000-0000-4000-8000-000000000008",
    sequence: 1,
    userContent: "u".repeat(400),
    userMessageId: "00000000-0000-4000-8000-000000000006",
  };
  const savedParts: ChatMessageEmbeddingPart[] = [];
  const store: ChatMemoryStore = {
    readCompletedMemoryTurns: async () => [priorTurn],
    readMessagesMissingEmbeddings: async () => [{
      content: priorTurn.userContent,
      id: priorTurn.userMessageId,
      role: "user" as const,
    }, {
      content: priorTurn.assistantContent,
      id: priorTurn.assistantMessageId,
      role: "assistant" as const,
    }, {
      content: "What changed?",
      id: "00000000-0000-4000-8000-000000000005",
      role: "user" as const,
    }],
    saveMessageEmbeddings: async (_embeddingSpaceId, _dimensions, parts) => {
      savedParts.push(...parts);
    },
    searchSemanticMemory: async () => [],
  };
  return {
    savedParts,
    store,
  };
}
