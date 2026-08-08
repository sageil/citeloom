import type { ApplicationRuntime } from "../app/runtime.js";
import type { ScheduledProviderCapability } from "../config/index.js";
import type { InferenceModelRegistry } from "../inference/registry.js";
import type {
  AnswerClaim,
  ClaimVerificationResult,
} from "../research/types.js";
import {
  verifyAnswerClaims,
  type ClaimEvidenceSource,
} from "./claim-verification.js";

const MAXIMUM_VERIFICATION_FAILURES = 3;
const VERIFICATION_RETRY_DELAYS_MS = [1_000, 5_000] as const;

export interface ClaimedVerificationJob {
  attemptCount: number;
  claims: AnswerClaim[];
  failureCount: number;
  id: string;
  sources: ClaimEvidenceSource[];
}

export interface VerificationJobStore {
  claimNextVerificationJob(
    currentTime: Date,
  ): Promise<ClaimedVerificationJob | null>;
  completeVerificationJob(
    id: string,
    attemptCount: number,
    claims: readonly ClaimVerificationResult[],
    completedAt: Date,
  ): Promise<boolean>;
  releaseVerificationJob(
    id: string,
    attemptCount: number,
  ): Promise<boolean>;
  settleVerificationFailure(
    id: string,
    attemptCount: number,
    error: unknown,
    retryAt: Date | null,
  ): Promise<boolean>;
}

export async function processNextVerificationJobWithRuntime(
  runtime: Pick<ApplicationRuntime, "scheduler">,
  models: InferenceModelRegistry,
  capability: Extract<ScheduledProviderCapability, "answer" | "chat">,
  store: VerificationJobStore,
  abortSignal: AbortSignal,
): Promise<boolean> {
  abortSignal.throwIfAborted();
  const job = await store.claimNextVerificationJob(new Date());
  if (job === null) {
    return false;
  }
  try {
    const scheduler = runtime.scheduler(capability, "interactive-answer");
    const verifiedClaims = await verifyAnswerClaims(
      models,
      job.claims,
      job.sources,
      scheduler,
      abortSignal,
    );
    await store.completeVerificationJob(
      job.id,
      job.attemptCount,
      verifiedClaims,
      new Date(),
    );
  } catch (error: unknown) {
    if (abortSignal.aborted) {
      await store.releaseVerificationJob(job.id, job.attemptCount);
      return false;
    }
    const failureCount = job.failureCount + 1;
    const retryAt = readRetryTime(failureCount);
    await store.settleVerificationFailure(
      job.id,
      job.attemptCount,
      error,
      retryAt,
    );
  }
  return true;
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
