import type { AuthenticatedPrincipal } from "../auth/model.js";
import { createPendingAnswerClaimChecks } from "../answers/claim-verification.js";
import {
  createNoRelevantAnswer,
  streamAnswerQuestion,
  type GeneratedAnswerResult,
} from "../answers/inference.js";
import type { ApplicationRuntime } from "../app/runtime.js";
import type { AppConfig } from "../config/index.js";
import {
  selectChatInferenceModels,
} from "../inference/registry.js";
import {
  noopRunTelemetry,
  startRunTelemetry,
} from "../observability/run.js";
import { DatabaseRunTelemetrySink } from "../observability/store.js";
import {
  prepareRetrievalWithRuntime,
} from "../retrieval/pipeline.js";
import {
  buildResearchRunConfiguration,
} from "../research/store.js";
import {
  embedChatMessageParts,
  prepareChatMemory,
} from "./memory.js";
import {
  ChatConflictError,
  ChatStore,
} from "./store.js";
import { CHAT_GENERATION_PROMPT } from "./prompt.js";
import { contextualizeChatQuestion } from "./question-contextualization.js";
import type {
  ChatAssistantMessage,
  ChatConversation,
  ChatRunConfiguration,
} from "./types.js";

const CHAT_LEASE_HEARTBEAT_MS = 30_000;
const CHAT_QUERY_EXPANSIONS = 0;

export interface ChatMessageRequest {
  content: string;
  conversationId: string;
  requestId: string;
}

export interface ChatMessageResponse {
  assistantMessage: ChatAssistantMessage;
  conversationId: string;
  runId: string;
  sequence: number;
}

export async function answerChatMessageWithRuntime(
  runtime: ApplicationRuntime,
  principal: AuthenticatedPrincipal,
  request: ChatMessageRequest,
  abortSignal: AbortSignal,
  reportProgress: (message: string) => void = () => undefined,
): Promise<ChatMessageResponse> {
  const store = new ChatStore(runtime.database, runtime.config);
  const accepted = await store.acceptUserMessage(
    principal,
    request.conversationId,
    request.requestId,
    request.content,
  );
  if (accepted.disposition === "completed") {
    return readCompletedResponse(
      store,
      principal,
      accepted.conversation.id,
      accepted.run.id,
      accepted.run.sequence,
    );
  }
  if (accepted.disposition === "in-progress") {
    throw new ChatConflictError(
      "This message already has a response in progress.",
    );
  }

  const lease = startChatRunLease(
    store,
    principal,
    accepted.run.id,
    accepted.run.attemptCount,
    abortSignal,
  );
  const telemetrySink = runtime.config.inferenceMetrics.enabled
    ? new DatabaseRunTelemetrySink(runtime.database)
    : null;
  let runTelemetry = noopRunTelemetry;
  let telemetryStarted = false;
  let telemetryFinished = false;
  try {
    runTelemetry = await startRunTelemetry(
      runtime.config,
      "chat",
      telemetrySink,
    );
    telemetryStarted = true;
    lease.signal.throwIfAborted();
    await store.transitionRun(
      principal,
      accepted.run.id,
      accepted.run.attemptCount,
      "accepted",
      "embedding",
    );
    reportProgress("Selecting relevant conversation memory");
    const memory = await prepareChatMemory(
      runtime,
      store,
      principal,
      accepted.conversation.id,
      accepted.run.id,
      accepted.userMessage.id,
      accepted.userMessage.content,
      lease.signal,
    );

    await store.transitionRun(
      principal,
      accepted.run.id,
      accepted.run.attemptCount,
      "embedding",
      "retrieving",
    );
    const retrievalQuestion = await contextualizeChatQuestion(
      runtime.models,
      accepted.userMessage.content,
      memory.questionContextTurns,
      runtime.scheduler("queryExpansion", "interactive-answer"),
      lease.signal,
      {
        seedMode: runtime.config.retrieval.generationSeedMode,
        temperature: runtime.config.retrieval.queryExpansionTemperature,
      },
      reportProgress,
      runTelemetry,
    );
    reportProgress("Retrieving evidence from indexed documents");
    const chatModels = selectChatInferenceModels(runtime.models);
    const chatScheduler = runtime.scheduler("chat", "interactive-answer");
    const prepared = await prepareRetrievalWithRuntime(
      runtime,
      retrievalQuestion,
      reportProgress,
      accepted.conversation.scope,
      lease.signal,
      runTelemetry,
      createChatRetrievalConfig(runtime.config),
      "interactive-answer",
      { models: chatModels, scheduler: chatScheduler },
    );

    await store.transitionRun(
      principal,
      accepted.run.id,
      accepted.run.attemptCount,
      "retrieving",
      "generating",
    );
    let result: GeneratedAnswerResult;
    if (prepared.retrieved.length === 0) {
      result = createNoRelevantAnswer();
    } else {
      reportProgress("Generating a grounded chat response");
      result = await streamAnswerQuestion(
        chatModels,
        accepted.userMessage.content,
        prepared.retrieved,
        chatScheduler,
        lease.signal,
        prepared.generationSettings.answer,
        runTelemetry,
        memory.conversationTurns,
        CHAT_GENERATION_PROMPT,
      );
    }

    await store.transitionRun(
      principal,
      accepted.run.id,
      accepted.run.attemptCount,
      "generating",
      "publishing",
    );
    const pendingFindings = createPendingAnswerClaimChecks(
      chatModels,
      result.claims,
      result.answerDocument.citations,
    );
    lease.signal.throwIfAborted();
    const assistantContent = result.answer;
    const assistantEmbeddings = await embedChatMessageParts(
      runtime,
      accepted.run.id,
      "assistant",
      assistantContent,
      lease.signal,
    );

    await lease.stop();
    lease.throwIfFailed();
    const assistantMessage = await store.publishAssistant(
      principal,
      {
        answerDocument: result.answerDocument,
        assistantEmbeddings,
        attemptCount: accepted.run.attemptCount,
        claims: pendingFindings,
        completedAt: new Date(),
        content: assistantContent,
        memoryTrace: memory.trace,
        retrievalTrace: prepared.retrievalTrace,
        runConfiguration: buildChatRunConfiguration(runtime),
        runId: accepted.run.id,
      },
      abortSignal,
    );
    telemetryFinished = true;
    await runTelemetry.finish("success");
    return {
      assistantMessage,
      conversationId: accepted.conversation.id,
      runId: accepted.run.id,
      sequence: accepted.run.sequence,
    };
  } catch (error: unknown) {
    await lease.stop();
    let effectiveError = lease.failure ?? error;
    if (telemetryStarted && !telemetryFinished) {
      telemetryFinished = true;
      try {
        await runTelemetry.finish(abortSignal.aborted ? "abort" : "error");
      } catch (telemetryError: unknown) {
        effectiveError = new AggregateError(
          [effectiveError, telemetryError],
          "Chat generation and telemetry finalization both failed.",
        );
      }
    }
    try {
      await store.failRun(
        principal,
        accepted.run.id,
        accepted.run.attemptCount,
        effectiveError,
        abortSignal.aborted,
      );
    } catch (persistenceError: unknown) {
      throw new AggregateError(
        [effectiveError, persistenceError],
        "Chat generation failed and the run state could not be persisted.",
      );
    }
    throw effectiveError;
  } finally {
    await lease.stop();
  }
}

interface ChatRunLease {
  readonly failure: unknown;
  readonly signal: AbortSignal;
  stop(): Promise<void>;
  throwIfFailed(): void;
}

function startChatRunLease(
  store: ChatStore,
  principal: AuthenticatedPrincipal,
  runId: string,
  attemptCount: number,
  requestSignal: AbortSignal,
): ChatRunLease {
  const controller = new AbortController();
  let failure: unknown = null;
  let pendingRenewal: Promise<void> = Promise.resolve();
  const abortFromRequest = (): void => {
    controller.abort(requestSignal.reason);
  };
  if (requestSignal.aborted) {
    abortFromRequest();
  } else {
    requestSignal.addEventListener("abort", abortFromRequest, { once: true });
  }
  const timer = setInterval(() => {
    pendingRenewal = pendingRenewal.then(async () => {
      if (controller.signal.aborted) {
        return;
      }
      try {
        await store.renewRunLease(principal, runId, attemptCount);
      } catch (error: unknown) {
        failure = error;
        controller.abort(error);
      }
    });
  }, CHAT_LEASE_HEARTBEAT_MS);
  let stopped = false;
  return {
    get failure() {
      return failure;
    },
    signal: controller.signal,
    async stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
        requestSignal.removeEventListener("abort", abortFromRequest);
      }
      await pendingRenewal;
    },
    throwIfFailed() {
      if (failure !== null) {
        throw failure;
      }
    },
  };
}

function buildChatRunConfiguration(
  runtime: ApplicationRuntime,
): ChatRunConfiguration {
  const research = buildResearchRunConfiguration(runtime.config);
  return {
    ...research,
    models: {
      chat: runtime.config.inference.chat?.model
        ?? runtime.config.inference.answer.model,
      embedding: research.models.embedding,
      reranker: research.models.reranker,
      verifier: research.models.verifier,
    },
    retrieval: {
      ...research.retrieval,
      queryExpansions: CHAT_QUERY_EXPANSIONS,
    },
  };
}

function createChatRetrievalConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    retrieval: {
      ...config.retrieval,
      queryExpansions: CHAT_QUERY_EXPANSIONS,
    },
  };
}

async function readCompletedResponse(
  store: ChatStore,
  principal: AuthenticatedPrincipal,
  conversationId: string,
  runId: string,
  sequence: number,
): Promise<ChatMessageResponse> {
  const conversation = await store.readConversation(principal, conversationId);
  if (conversation === null) {
    throw new Error(`Completed chat was not found: ${conversationId}`);
  }
  const assistantMessage = readAssistantMessage(conversation, runId);
  if (assistantMessage === null) {
    throw new Error(`Completed chat run has no assistant message: ${runId}`);
  }
  return {
    assistantMessage,
    conversationId,
    runId,
    sequence,
  };
}

function readAssistantMessage(
  conversation: ChatConversation,
  runId: string,
): ChatAssistantMessage | null {
  const run = conversation.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) {
    return null;
  }
  for (const message of run.messages) {
    if (message.role === "assistant") {
      return message;
    }
  }
  return null;
}
