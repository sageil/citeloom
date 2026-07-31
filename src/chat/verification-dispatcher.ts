import { verifyAnswerClaims } from "../answers/claim-verification.js";
import type { ApplicationRuntime } from "../app/runtime.js";
import { selectChatInferenceModels } from "../inference/registry.js";
import type { ClaimVerificationResult } from "../research/types.js";
import { ChatStore } from "./store.js";
import type { ChatClaimVerificationResult } from "./types.js";

const MAXIMUM_VERIFICATION_FAILURES = 3;
const VERIFICATION_RETRY_DELAYS_MS = [1_000, 5_000] as const;

export async function processNextChatVerificationWithRuntime(
  runtime: ApplicationRuntime,
  abortSignal: AbortSignal,
): Promise<boolean> {
  abortSignal.throwIfAborted();
  const store = new ChatStore(runtime.database, runtime.config);
  const job = await store.claimNextVerificationJob(new Date());
  if (job === null) {
    return false;
  }
  try {
    const models = selectChatInferenceModels(runtime.models);
    const scheduler = runtime.scheduler("chat", "interactive-answer");
    const verifiedClaims = await verifyAnswerClaims(
      models,
      job.claims,
      job.sources,
      scheduler,
      abortSignal,
    );
    const claims = readChatVerificationResults(verifiedClaims);
    await store.completeVerificationJob(
      job.assistantMessageId,
      job.attemptCount,
      claims,
      new Date(),
    );
  } catch (error: unknown) {
    if (abortSignal.aborted) {
      await store.releaseVerificationJob(
        job.assistantMessageId,
        job.attemptCount,
      );
      return false;
    }
    const failureCount = job.failureCount + 1;
    const retryAt = readRetryTime(failureCount);
    await store.settleVerificationFailure(
      job.assistantMessageId,
      job.attemptCount,
      error,
      retryAt,
    );
  }
  return true;
}

function readChatVerificationResults(
  claims: readonly ClaimVerificationResult[],
): ChatClaimVerificationResult[] {
  const results: ChatClaimVerificationResult[] = [];
  for (const claim of claims) {
    let allCitationsNeedCollectiveSupport = claim.evidenceUnits.length > 1;
    for (const unit of claim.evidenceUnits) {
      if (unit.outcome !== "unsupported") {
        allCitationsNeedCollectiveSupport = false;
      }
    }
    if (claim.status === "supported" && allCitationsNeedCollectiveSupport) {
      results.push({
        ...claim,
        status: "collectively-supported",
      });
      continue;
    }
    results.push(claim);
  }
  return results;
}

function readRetryTime(failureCount: number): Date | null {
  if (failureCount >= MAXIMUM_VERIFICATION_FAILURES) {
    return null;
  }
  const delay = VERIFICATION_RETRY_DELAYS_MS[failureCount - 1];
  if (delay === undefined) {
    return null;
  }
  return new Date(Date.now() + delay);
}
