import { generateText, Output } from "ai";

import {
  createAnswerSemanticShapeSystemPrompt,
  readAnswerSemanticShape,
  type AnswerSemanticShape,
} from "./presentation.js";
import type { AppliedGenerationSettings } from "../inference/generation-settings.js";
import type { InferenceModelRegistry } from "../inference/registry.js";
import { createProcessingQuestion } from "../domain/question.js";
import {
  createInferenceRequestSignal,
  throwInferenceRequestFailure,
} from "../inference/request.js";
import { createInferenceTelemetryOptions } from "../inference/shared.js";
import {
  createTelemetryStageResult,
  noopRunTelemetry,
  readTelemetryFailureOutcome,
  type RunTelemetry,
} from "../observability/run.js";
import type { TaskScheduler } from "../shared/concurrency.js";

interface AnswerShapeCompletion {
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

export async function classifyAnswerSemanticShape(
  models: InferenceModelRegistry,
  question: string,
  scheduler: TaskScheduler,
  abortSignal: AbortSignal,
  generationSettings: AppliedGenerationSettings,
  runTelemetry: RunTelemetry = noopRunTelemetry,
): Promise<AnswerSemanticShape | null> {
  const stage = runTelemetry.startStage({
    model: {
      modelId: models.queryExpansion.modelId,
      provider: models.queryExpansion.provider,
    },
    name: "answer-shape",
    retrievalMode: null,
  });
  const finishMetric = models.metrics.start(
    "answer-shape",
    models.queryExpansion.provider,
    models.queryExpansion.modelId,
  );
  const processingQuestion = createProcessingQuestion(question);
  let completion: AnswerShapeCompletion | null = null;
  try {
    const result = await scheduler.run(
      (requestSignal) => requestAnswerSemanticShape(
        models,
        processingQuestion,
        requestSignal,
        generationSettings,
      ),
      abortSignal,
      stage.timingObserver,
    );
    completion = {
      finishReason: result.finishReason,
      inputTokens: result.totalUsage.inputTokens ?? null,
      outputTokens: result.totalUsage.outputTokens ?? null,
    };
    finishMetric(completion);
    const shape = readAnswerSemanticShape(result.output);
    const outcome = shape === null ? "fallback" : "success";
    await stage.finish(createTelemetryStageResult(outcome, {
      inputCount: 1,
      inputTokens: completion.inputTokens,
      outputCount: shape === null ? 0 : 1,
      outputTokens: completion.outputTokens,
    }));
    return shape;
  } catch (error: unknown) {
    finishMetric(completion ?? {
      finishReason: abortSignal.aborted ? "aborted" : "error",
      inputTokens: null,
      outputTokens: null,
    });
    if (abortSignal.aborted) {
      await stage.finish(createTelemetryStageResult(
        readTelemetryFailureOutcome(abortSignal),
        { inputCount: 1 },
      ));
      throw error;
    }
    await stage.finish(createTelemetryStageResult(
      "fallback",
      { inputCount: 1 },
    ));
    return null;
  }
}

async function requestAnswerSemanticShape(
  models: InferenceModelRegistry,
  question: string,
  abortSignal: AbortSignal,
  generationSettings: AppliedGenerationSettings,
) {
  const timeoutMs = models.timeouts.queryExpansionMs;
  const signals = createInferenceRequestSignal(timeoutMs, abortSignal);
  try {
    const samplingSettings = generationSettings.seed === null
      ? { temperature: 0 }
      : { seed: generationSettings.seed, temperature: 0 };
    return await generateText({
      ...samplingSettings,
      abortSignal: signals.requestSignal,
      maxRetries: 1,
      model: models.queryExpansion,
      output: Output.text(),
      prompt: question,
      system: createAnswerSemanticShapeSystemPrompt(),
      telemetry: createInferenceTelemetryOptions(
        models,
        "citeloom.classify-answer-shape",
      ),
    });
  } catch (error: unknown) {
    throwInferenceRequestFailure(
      error,
      "queryExpansion",
      timeoutMs,
      signals.timeoutSignal,
      abortSignal,
    );
  }
}
