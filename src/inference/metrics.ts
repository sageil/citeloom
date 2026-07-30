import type { InferenceMetricsConfig } from "../config/index.js";

export type InferenceOperation =
  | "answer"
  | "answer-stream"
  | "claim-verification"
  | "describe-image"
  | "describe-table"
  | "embed-documents"
  | "embed-query"
  | "expand-query"
  | "offline-tool"
  | "rerank";

export interface InferenceMetric {
  durationMs: number;
  finishReason: string | null;
  inputTokens: number | null;
  modelId: string;
  operation: InferenceOperation;
  outputTokens: number | null;
  provider: string;
  timestamp: string;
}

export interface InferenceMetricResult {
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

const emptyMetricResult: InferenceMetricResult = {
  finishReason: null,
  inputTokens: null,
  outputTokens: null,
};

export class InferenceMetricsReporter {
  public constructor(private readonly config: InferenceMetricsConfig) {}

  public get enabled(): boolean {
    return this.config.enabled;
  }

  public start(
    operation: InferenceOperation,
    provider: string,
    modelId: string,
  ): (result?: InferenceMetricResult) => void {
    const startedAt = performance.now();
    let reported = false;
    return (result = emptyMetricResult): void => {
      if (!this.config.enabled || reported) {
        return;
      }
      reported = true;
      const metric: InferenceMetric = {
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        finishReason: result.finishReason,
        inputTokens: normalizeTokenCount(result.inputTokens),
        modelId,
        operation,
        outputTokens: normalizeTokenCount(result.outputTokens),
        provider,
        timestamp: new Date().toISOString(),
      };
      console.log(JSON.stringify({ aiMetric: metric, level: "info" }));
    };
  }
}

function normalizeTokenCount(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}
