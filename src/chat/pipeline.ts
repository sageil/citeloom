import { hostname } from "node:os";

import {
  createUIMessageStream,
  type InferUIMessageChunk,
} from "ai";

import type { AuthenticatedPrincipal } from "../auth/model.js";
import {
  createAnswerContentWriter,
  type CiteLoomUIMessage,
} from "../answers/stream.js";
import { createPendingAnswerClaimChecks } from "../answers/claim-verification.js";
import {
  createEmptyRetrievalAnswer,
  streamAnswerQuestion,
  type GeneratedAnswerResult,
} from "../answers/inference.js";
import {
  createUncitedAnswerDocument,
  renderPublishedAnswerMarkdown,
  type PublishedAnswerDocument,
} from "../answers/published.js";
import {
  createPublishedAnswerContentSnapshot,
  hasAnswerContent,
  type AnswerContentSnapshot,
} from "../answers/content-snapshot.js";
import type { ApplicationRuntime } from "../app/runtime.js";
import type { AppConfig } from "../config/index.js";
import { createContextualizedQuestionInput } from "../domain/question.js";
import {
  selectChatInferenceModels,
} from "../inference/registry.js";
import {
  noopRunTelemetry,
  startRunTelemetry,
} from "../observability/run.js";
import { DatabaseRunTelemetrySink } from "../observability/store.js";
import { ApplicationErrorReporter } from "../observability/application-errors.js";
import {
  prepareRetrievalWithRuntime,
  readAnswerStreamError,
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
import {
  contextualizeChatQuestion,
  type ContextualizedChatQuestion,
} from "./question-contextualization.js";
import type {
  ChatAssistantMessage,
  ChatMessageResponse,
  ChatRun,
  ChatRunConfiguration,
} from "./types.js";

const CHAT_LEASE_HEARTBEAT_MS = 30_000;
const CHAT_QUERY_EXPANSIONS = 0;
const ignoreAnswerContent = (_content: AnswerContentSnapshot): void => undefined;

export interface ChatMessageRequest {
  content: string;
  conversationId: string;
  requestId: string;
}

export function streamChatMessageWithRuntime(
  runtime: ApplicationRuntime,
  principal: AuthenticatedPrincipal,
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
  principal: AuthenticatedPrincipal,
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
    let questionResolution: ContextualizedChatQuestion = {
      clarification: null,
      question: accepted.userMessage.content,
    };
    if (memory.questionContextTurns.length > 0) {
      questionResolution = await contextualizeChatQuestion(
        runtime.models,
        accepted.userMessage.content,
        memory.questionContextTurns,
        chatScheduler,
        lease.signal,
        {
          seedMode: runtime.config.retrieval.generationSeedMode,
          temperature: runtime.config.retrieval.chatTemperature,
        },
        reportProgress,
        runTelemetry,
        async (error) => reportChatContextualizationFailure(
          runtime,
          principal,
          runTelemetry.runId,
          accepted.run.id,
          error,
        ),
      );
    }
    const questionInput = createContextualizedQuestionInput(
      accepted.userMessage.content,
      questionResolution.question,
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
      { models: chatModels, scheduler: chatScheduler },
    );

    await store.transitionRun(
      principal,
      accepted.run.id,
      accepted.run.attemptCount,
      "retrieving",
      "generating",
    );
    let result: ChatGeneratedResponse;
    if (questionResolution.clarification !== null) {
      result = createChatClarification(questionResolution.clarification);
    } else if (prepared.retrieved.length === 0) {
      result = createEmptyRetrievalAnswer();
    } else {
      reportProgress("Generating a grounded chat response");
      result = await streamAnswerQuestion(
        chatModels,
        questionResolution.question,
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
    }
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

function createChatClarification(content: string): ChatGeneratedResponse {
  const answerDocument: PublishedAnswerDocument = createUncitedAnswerDocument(
    content,
  );
  return {
    answer: renderPublishedAnswerMarkdown(answerDocument),
    answerDocument,
    claims: [],
  };
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
      answerTemperature: runtime.config.retrieval.chatTemperature,
      queryExpansions: CHAT_QUERY_EXPANSIONS,
    },
  };
}

function createChatRetrievalConfig(config: AppConfig): AppConfig {
  return {
    ...config,
    retrieval: {
      ...config.retrieval,
      answerTemperature: config.retrieval.chatTemperature,
      queryExpansions: CHAT_QUERY_EXPANSIONS,
    },
  };
}

async function readCompletedResponse(
  store: ChatStore,
  principal: AuthenticatedPrincipal,
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

async function reportChatContextualizationFailure(
  runtime: ApplicationRuntime,
  principal: AuthenticatedPrincipal,
  telemetryRunId: string | null,
  chatRunId: string,
  error: unknown,
): Promise<void> {
  const reporter = new ApplicationErrorReporter(runtime.database);
  await reporter.report(error, {
    category: "inference-provider",
    code: "chat_contextualization_failed",
    instance: hostname(),
    operation: "contextualize-chat-question",
    origin: "inference-provider",
    requestId: chatRunId,
    retryable: true,
    runId: telemetryRunId,
    service: "web",
    severity: "warning",
    workspaceId: principal.workspaceId,
  });
}
