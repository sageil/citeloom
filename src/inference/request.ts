export type InferenceFeature =
  | "answer"
  | "embedding"
  | "queryExpansion"
  | "summarization";

export interface InferenceRequestSignal {
  requestSignal: AbortSignal;
  timeoutSignal: AbortSignal;
}

export class InferenceFeatureTimeoutError extends Error {
  public constructor(
    public readonly feature: InferenceFeature,
    public readonly timeoutMs: number,
  ) {
    super(`${formatInferenceFeature(feature)} timed out after ${timeoutMs} ms.`);
    this.name = "InferenceFeatureTimeoutError";
  }
}

export function createInferenceRequestSignal(
  timeoutMs: number,
  abortSignal?: AbortSignal,
): InferenceRequestSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = abortSignal === undefined
    ? timeoutSignal
    : AbortSignal.any([abortSignal, timeoutSignal]);
  return { requestSignal, timeoutSignal };
}

export function throwInferenceRequestFailure(
  error: unknown,
  feature: InferenceFeature,
  timeoutMs: number,
  timeoutSignal: AbortSignal,
  abortSignal?: AbortSignal,
): never {
  if (abortSignal?.aborted === true) {
    throw abortSignal.reason;
  }
  if (timeoutSignal.aborted) {
    throw new InferenceFeatureTimeoutError(feature, timeoutMs);
  }
  throw error;
}

function formatInferenceFeature(feature: InferenceFeature): string {
  if (feature === "answer") {
    return "Answer generation";
  }
  if (feature === "embedding") {
    return "Embedding generation";
  }
  if (feature === "queryExpansion") {
    return "Query expansion";
  }
  return "Summarization";
}
