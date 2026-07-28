import { APICallError, embedMany } from "ai";

import type { TaskScheduler } from "../shared/concurrency.js";
import type { InferenceModelRegistry } from "../inference/registry.js";
import {
  createInferenceRequestSignal,
  throwInferenceRequestFailure,
} from "../inference/request.js";
import {
  createInferenceTelemetryOptions,
} from "../inference/shared.js";
import {
  createTelemetryStageResult,
  noopRunTelemetry,
  readTelemetryFailureOutcome,
  type RunTelemetry,
} from "../observability/run.js";

const passiveAbortSignal = new AbortController().signal;
export const DOCUMENT_EMBEDDING_BATCH_SIZE = 64;

export interface DocumentEmbeddingInput<Value> {
  inputTokens: number;
  value: string;
  source: Value;
}

export interface EmbeddedDocumentInput<Value> {
  embedding: number[];
  source: Value;
}

export type SplitRejectedDocumentEmbeddingInput<Value> = (
  input: DocumentEmbeddingInput<Value>,
  maximumInputTokens: number,
) => DocumentEmbeddingInput<Value>[];

export async function embedDocumentTexts(
  models: InferenceModelRegistry,
  values: string[],
  scheduler: TaskScheduler,
  abortSignal: AbortSignal = passiveAbortSignal,
): Promise<number[][]> {
  const inputs = values.map((value) => ({
    inputTokens: Number.MAX_SAFE_INTEGER,
    source: value,
    value,
  }));
  const embedded = await embedDocumentInputs(
    models,
    inputs,
    scheduler,
    abortSignal,
  );
  return embedded.map((result) => result.embedding);
}

export async function embedDocumentInputs<Value>(
  models: InferenceModelRegistry,
  inputs: readonly DocumentEmbeddingInput<Value>[],
  scheduler: TaskScheduler,
  abortSignal: AbortSignal = passiveAbortSignal,
  splitRejectedInput?: SplitRejectedDocumentEmbeddingInput<Value>,
): Promise<Array<EmbeddedDocumentInput<Value>>> {
  if (inputs.length === 0) {
    return [];
  }
  const finishMetric = models.metrics.start(
    "embed-documents",
    models.documentEmbedding.provider,
    models.documentEmbedding.modelId,
  );
  let totalInputTokens = 0;
  let receivedTokenUsage = false;
  const recordTokenUsage = (inputTokens: number | null): void => {
    if (inputTokens !== null) {
      totalInputTokens += inputTokens;
      receivedTokenUsage = true;
    }
  };
  try {
    const embedded: Array<EmbeddedDocumentInput<Value>> = [];
    for (
      let start = 0;
      start < inputs.length;
      start += DOCUMENT_EMBEDDING_BATCH_SIZE
    ) {
      abortSignal.throwIfAborted();
      const workset = inputs.slice(
        start,
        start + DOCUMENT_EMBEDDING_BATCH_SIZE,
      );
      const pending: Array<Promise<Array<EmbeddedDocumentInput<Value>>>> = [];
      for (const input of workset) {
        pending.push(embedDocumentInputWithRecovery(
          models,
          input,
          scheduler,
          abortSignal,
          recordTokenUsage,
          splitRejectedInput,
        ));
      }
      const results = await Promise.allSettled(pending);
      for (const result of results) {
        if (result.status === "rejected") {
          throw result.reason;
        }
        embedded.push(...result.value);
      }
    }
    finishMetric({
      finishReason: null,
      inputTokens: receivedTokenUsage ? totalInputTokens : null,
      outputTokens: null,
    });
    return embedded;
  } catch (error: unknown) {
    finishMetric({
      finishReason: "error",
      inputTokens: null,
      outputTokens: null,
    });
    throw error;
  }
}

async function embedDocumentInputWithRecovery<Value>(
  models: InferenceModelRegistry,
  input: DocumentEmbeddingInput<Value>,
  scheduler: TaskScheduler,
  abortSignal: AbortSignal,
  recordTokenUsage: (inputTokens: number | null) => void,
  splitRejectedInput?: SplitRejectedDocumentEmbeddingInput<Value>,
): Promise<Array<EmbeddedDocumentInput<Value>>> {
  abortSignal.throwIfAborted();
  const runEmbedding = (requestSignal: AbortSignal) => requestEmbeddings(
    models,
    models.documentEmbedding,
    [input.value],
    requestSignal,
    "citeloom.embed-documents",
    recordTokenUsage,
    0,
  );
  try {
    const result = await scheduler.run(runEmbedding, abortSignal);
    const embedding = result.embeddings[0];
    if (result.embeddings.length !== 1 || embedding === undefined) {
      throw new Error(
        `Document embedding count differs: expected 1, received ${result.embeddings.length}.`,
      );
    }
    return [{ embedding, source: input.source }];
  } catch (error: unknown) {
    if (
      splitRejectedInput === undefined
      || !isEmbeddingInputTooLargeError(error)
      || input.inputTokens <= 1
    ) {
      throw error;
    }
    const nextMaximumInputTokens = Math.floor(input.inputTokens / 2);
    const pieces = splitRejectedInput(input, nextMaximumInputTokens);
    validateSmallerEmbeddingInputs(input, pieces);
    const embedded: Array<EmbeddedDocumentInput<Value>> = [];
    for (const piece of pieces) {
      const results = await embedDocumentInputWithRecovery(
        models,
        piece,
        scheduler,
        abortSignal,
        recordTokenUsage,
        splitRejectedInput,
      );
      embedded.push(...results);
    }
    return embedded;
  }
}

export function isEmbeddingInputTooLargeError(error: unknown): boolean {
  if (!APICallError.isInstance(error)) {
    return false;
  }
  if (
    error.statusCode !== 400
    && error.statusCode !== 413
    && error.statusCode !== 422
  ) {
    return false;
  }
  const details = `${error.message}\n${error.responseBody ?? ""}`
    .toLocaleLowerCase();
  return details.includes("context_length_exceeded")
    || details.includes("input is too long")
    || details.includes("input too long")
    || details.includes("maximum context length")
    || details.includes("maximum input length")
    || details.includes("too many tokens")
    || details.includes("token limit");
}

function validateSmallerEmbeddingInputs<Value>(
  rejected: DocumentEmbeddingInput<Value>,
  pieces: readonly DocumentEmbeddingInput<Value>[],
): void {
  if (pieces.length < 2) {
    throw new Error(
      "An oversized embedding input must split into at least two pieces.",
    );
  }
  for (const piece of pieces) {
    if (
      !Number.isInteger(piece.inputTokens)
      || piece.inputTokens < 1
      || piece.inputTokens >= rejected.inputTokens
      || piece.value === rejected.value
    ) {
      throw new Error(
        "Every retried embedding input must be strictly smaller than the rejected input.",
      );
    }
  }
}

export async function embedQuestions(
  models: InferenceModelRegistry,
  questions: string[],
  scheduler: TaskScheduler,
  abortSignal: AbortSignal,
  runTelemetry: RunTelemetry = noopRunTelemetry,
): Promise<number[][]> {
  if (questions.length === 0) {
    throw new Error("Query embedding requires at least one question.");
  }
  const stage = runTelemetry.startStage({
    model: {
      modelId: models.queryEmbedding.modelId,
      provider: models.queryEmbedding.provider,
    },
    name: "query-embedding",
    retrievalMode: null,
  });
  const finishMetric = models.metrics.start(
    "embed-query",
    models.queryEmbedding.provider,
    models.queryEmbedding.modelId,
  );
  let inputTokens: number | null = null;
  const recordTokenUsage = (value: number | null): void => {
    inputTokens = value;
    finishMetric({
      finishReason: null,
      inputTokens,
      outputTokens: null,
    });
  };
  try {
    const runEmbedding = (requestSignal: AbortSignal) => requestEmbeddings(
      models,
      models.queryEmbedding,
      questions,
      requestSignal,
      "citeloom.embed-query",
      recordTokenUsage,
      1,
    );
    const result = await scheduler.run(
      runEmbedding,
      abortSignal,
      stage.timingObserver,
    );
    if (result.embeddings.length !== questions.length) {
      throw new Error(
        `Query embedding count differs: expected ${questions.length}, received ${result.embeddings.length}.`,
      );
    }
    await stage.finish(createTelemetryStageResult("success", {
      inputCount: questions.length,
      inputTokens,
      outputCount: result.embeddings.length,
    }));
    return result.embeddings;
  } catch (error: unknown) {
    finishMetric({
      finishReason: abortSignal.aborted ? "aborted" : "error",
      inputTokens: null,
      outputTokens: null,
    });
    await stage.finish(createTelemetryStageResult(
      readTelemetryFailureOutcome(abortSignal),
      { inputCount: questions.length },
    ));
    throw error;
  }
}

async function requestEmbeddings(
  models: InferenceModelRegistry,
  model: InferenceModelRegistry["documentEmbedding"],
  values: string[],
  abortSignal: AbortSignal,
  telemetryFunctionId: string,
  recordTokenUsage: (inputTokens: number | null) => void,
  maxRetries: number,
) {
  const telemetry = createInferenceTelemetryOptions(
    models,
    telemetryFunctionId,
  );
  const timeoutMs = models.timeouts.embeddingMs;
  const signals = createInferenceRequestSignal(timeoutMs, abortSignal);
  try {
    return await embedMany({
      abortSignal: signals.requestSignal,
      maxParallelCalls: 1,
      maxRetries,
      model,
      onEnd: (event) => {
        recordTokenUsage(event.usage.tokens ?? null);
      },
      telemetry,
      values,
    });
  } catch (error: unknown) {
    throwInferenceRequestFailure(
      error,
      "embedding",
      timeoutMs,
      signals.timeoutSignal,
      abortSignal,
    );
  }
}
