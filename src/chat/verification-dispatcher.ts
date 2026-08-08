import { processNextVerificationJobWithRuntime } from "../answers/verification-worker.js";
import type { ApplicationRuntime } from "../app/runtime.js";
import { selectChatInferenceModels } from "../inference/registry.js";
import { ChatStore } from "./store.js";

export async function processNextChatVerificationWithRuntime(
  runtime: ApplicationRuntime,
  abortSignal: AbortSignal,
): Promise<boolean> {
  abortSignal.throwIfAborted();
  const store = new ChatStore(runtime.database, runtime.config);
  return processNextVerificationJobWithRuntime(
    runtime,
    selectChatInferenceModels(runtime.models),
    "chat",
    store,
    abortSignal,
  );
}
