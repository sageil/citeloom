import type { ApplicationRuntime } from "../app/runtime.js";
import { processNextVerificationJobWithRuntime } from "../answers/verification-worker.js";
import { ResearchStore } from "./store.js";

export async function processNextResearchVerificationWithRuntime(
  runtime: ApplicationRuntime,
  abortSignal: AbortSignal,
): Promise<boolean> {
  abortSignal.throwIfAborted();
  const store = new ResearchStore(runtime.database, runtime.config);
  return processNextVerificationJobWithRuntime(
    runtime,
    runtime.models,
    "answer",
    store,
    abortSignal,
  );
}
