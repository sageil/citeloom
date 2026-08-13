import {
  createUIMessageStream,
  type InferUIMessageChunk,
} from "ai";

import type { AuthorizationPrincipal } from "../auth/model.js";
import {
  createAnswerContentWriter,
  type CiteLoomUIMessage,
} from "../answers/stream.js";
import { createPendingAnswerClaimChecks } from "../answers/claim-verification.js";
import {
  streamAnswerQuestion,
  type GeneratedAnswerResult,
} from "../answers/inference.js";
import {
  createPublishedAnswerContentSnapshot,
  hasAnswerContent,
  type AnswerContentSnapshot,
} from "../answers/content-snapshot.js";
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
  readAnswerStreamError,
} from "../retrieval/pipeline.js";
import {
  buildResearchRunConfiguration,
} from "../research/store.js";
import {
  prepareChatMemory,
} from "./memory.js";
import { createChatRetrievalQuestionInput } from "./retrieval-question.js";
import {
  ChatConflictError,
  ChatStore,
} from "./store.js";
import { CHAT_GENERATION_PROMPT } from "./prompt.js";
import type {
  ChatAssistantMessage,
  ChatMessageResponse,
  ChatRun,
  ChatRunConfiguration,
} from "./types.js";

const CHAT_LEASE_HEARTBEAT_MS = 30_000;
const ignoreAnswerContent = (_content: AnswerContentSnapshot): void => undefined;

export interface ChatMessageRequest {
  content: string;
  conversationId: string;
  requestId: string;
}

export function streamChatMessageWithRuntime(
  runtime: ApplicationRuntime,
  principal: AuthorizationPrincipal,
  request: ChatMessageRequest,
  abortSignal: AbortSignal,
  reportProgress: (message: string) => void = () => undefined,
): ReadableStream<InferUIMessageChunk<CiteLoomUIMessage>> {
  return createUIMessageStream<CiteLoomUIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: "start" });
      const receiveAnswerContent = createAnswerContentWriter(writer);
      const response = await answerChatMessageWithRuntime(
        runtime,
        principal,
        request,
        abortSignal,
        reportProgress,
        receiveAnswerContent,
      );
      const assistantMessage = requireAssistantMessage(response.run);
      receiveAnswerContent(
        createPublishedAnswerContentSnapshot(assistantMessage.answerDocument),
      );
      writer.write({
        data: response,
        id: "chat",
        type: "data-chat",
      });
      writer.write({ finishReason: "stop", type: "finish" });
    },
    onError: readAnswerStreamError,
  });
}

export async function answerChatMessageWithRuntime(
  runtime: ApplicationRuntime,
  principal: AuthorizationPrincipal,
  request: ChatMessageRequest,
  abortSignal: AbortSignal,
  reportProgress: (message: string) => void = () => undefined,
  receiveAnswerContent: (content: AnswerContentSnapshot) => void = ignoreAnswerContent,
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
      accepted.run.id,
    );
    telemetryStarted = true;
    runTelemetry.markStreamStarted();
    let firstAnswerContentReceived = false;
    const publishAnswerContent = (content: AnswerContentSnapshot): void => {
      if (hasAnswerContent(content) && !firstAnswerContentReceived) {
        firstAnswerContentReceived = true;
        runTelemetry.markFirstToken();
      }
      receiveAnswerContent(content);
    };
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
    const chatScheduler = runtime.scheduler("chat", "interactive-answer");
    const questionInput = createChatRetrievalQuestionInput(
      accepted.userMessage.content,
      memory.questionContextTurns,
      {
        inputFormat: runtime.config.inference.embedding.inputFormat,
        maximumInputTokens:
          runtime.config.inference.embedding.maximumInputTokens,
      },
    );
    reportProgress("Retrieving evidence from indexed documents");
    const chatModels = selectChatInferenceModels(runtime.models);
    const prepared = await prepareRetrievalWithRuntime(
      runtime,
      questionInput,
      reportProgress,
      accepted.conversation.scope,
      lease.signal,
      runTelemetry,
      createChatRetrievalConfig(runtime.config),
      "interactive-answer",
      undefined,
      principal.dataScope === "all" ? null : principal.workspaceId,
    );

    await store.transitionRun(
      principal,
      accepted.run.id,
      accepted.run.attemptCount,
      "retrieving",
      "generating",
    );
    reportProgress("Generating a chat response");
    const result: ChatGeneratedResponse = await streamAnswerQuestion(
      chatModels,
      accepted.userMessage.content,
      prepared.retrieved,
      chatScheduler,
      lease.signal,
      prepared.generationSettings.answer,
      runTelemetry,
      {
        conversationTurns: memory.conversationTurns,
        prompt: CHAT_GENERATION_PROMPT,
        receiveAnswerContent: publishAnswerContent,
      },
    );
    publishAnswerContent(
      createPublishedAnswerContentSnapshot(result.answerDocument),
    );

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

    await lease.stop();
    lease.throwIfFailed();
    const assistantMessage = await store.publishAssistant(
      principal,
      {
        answerDocument: result.answerDocument,
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
    runTelemetry.markStreamCompleted();
    await runTelemetry.finish("success");
    return {
      conversationId: accepted.conversation.id,
      run: {
        attemptCount: accepted.run.attemptCount,
        completedAt: assistantMessage.createdAt,
        errorMessage: null,
        id: accepted.run.id,
        messages: [accepted.userMessage, assistantMessage],
        sequence: accepted.run.sequence,
        state: "completed",
      },
    };
  } catch (error: unknown) {
    await lease.stop();
    let effectiveError = lease.failure ?? error;
    if (telemetryStarted && !telemetryFinished) {
      telemetryFinished = true;
      try {
        runTelemetry.markStreamCompleted();
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

type ChatGeneratedResponse = Pick<
  GeneratedAnswerResult,
  "answer" | "answerDocument" | "claims"
>;

interface ChatRunLease {
  readonly failure: unknown;
  readonly signal: AbortSignal;
  stop(): Promise<void>;
  throwIfFailed(): void;
}

function startChatRunLease(
  store: ChatStore,
  principal: AuthorizationPrincipal,
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
  const research = buildResearchRunConfiguration(
    createChatRetrievalConfig(runtime.config),
  );
  return {
    ...research,
    models: {
      chat: runtime.config.inference.chat?.model
        ?? runtime.config.inference.answer.model,
      embedding: research.models.embedding,
      reranker: research.models.reranker,
      verifier: research.models.verifier,
    },
    retrieval: research.retrieval,
  };
}

export function createChatRetrievalConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    retrieval: {
      ...config.retrieval,
      answerTemperature: config.retrieval.chatTemperature,
    },
  };
}

async function readCompletedResponse(
  store: ChatStore,
  principal: AuthorizationPrincipal,
  conversationId: string,
  runId: string,
): Promise<ChatMessageResponse> {
  const conversation = await store.readConversation(principal, conversationId);
  if (conversation === null) {
    throw new Error(`Completed chat was not found: ${conversationId}`);
  }
  const run = conversation.runs.find((candidate) => candidate.id === runId);
  if (run === undefined || readAssistantMessage(run) === null) {
    throw new Error(`Completed chat run has no assistant message: ${runId}`);
  }
  return {
    conversationId,
    run,
  };
}

function readAssistantMessage(
  run: ChatRun,
): ChatAssistantMessage | null {
  for (const message of run.messages) {
    if (message.role === "assistant") {
      return message;
    }
  }
  return null;
}

function requireAssistantMessage(run: ChatRun): ChatAssistantMessage {
  const message = readAssistantMessage(run);
  if (message === null) {
    throw new Error(`Completed chat run has no assistant message: ${run.id}`);
  }
  return message;
}
