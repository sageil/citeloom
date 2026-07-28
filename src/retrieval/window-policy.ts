import { createHash } from "node:crypto";

import { z } from "zod";

export const retrievalWindowPolicySchema = z.object({
  accounting: z.literal("cl100k-base-tokens-v1"),
  canonicalEvidence: z.literal("query-dense-exact-window-v1"),
  finalInput: z.literal("provider-formatted-section-and-content-v1"),
  generatedDescription: z.literal(
    "separate-table-description-dense-plus-hybrid-lexical-v1",
  ),
  id: z.literal("citeloom/retrieval-window:structured-token-v3"),
  image: z.literal("description-only-single-window-v1"),
  kind: z.literal("structured-token"),
  maximumInputTokens: z.number().int().positive(),
  oversizedUnit: z.literal("split-boundary-retry-smaller-v1"),
  parentFusion: z.literal("retrieval-evidence-before-candidate-budget-v1"),
  table: z.literal("complete-table-caption-header-row-split-v3"),
  targetInputTokens: z.number().int().positive(),
  text: z.literal(
    "same-section-structure-paragraph-sentence-punctuation-word-no-overlap-v3",
  ),
}).strict().superRefine((policy, context) => {
  if (policy.targetInputTokens > policy.maximumInputTokens) {
    context.addIssue({
      code: "custom",
      message: "target input tokens exceed maximum input tokens",
      path: ["targetInputTokens"],
    });
  }
});

export const storedRetrievalWindowPolicySchema = retrievalWindowPolicySchema;

export const retrievalWindowPolicyContractSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  policy: retrievalWindowPolicySchema,
}).strict().superRefine((value, context) => {
  const expected = createRetrievalWindowPolicyFingerprint(value.policy);
  if (value.fingerprint !== expected) {
    context.addIssue({
      code: "custom",
      message: "fingerprint does not match the retrieval-window policy",
      path: ["fingerprint"],
    });
  }
});

export type RetrievalWindowPolicy = z.infer<typeof retrievalWindowPolicySchema>;
export type StoredRetrievalWindowPolicy = RetrievalWindowPolicy;
export type RetrievalWindowPolicySelection = "structured-token-v3";

export interface RetrievalWindowPolicyContract {
  fingerprint: string;
  policy: RetrievalWindowPolicy;
}

export function createRetrievalWindowPolicy(
  _selection: RetrievalWindowPolicySelection,
  retrievalChunkTargetTokens: number,
  embeddingContextCapacityTokens: number,
): RetrievalWindowPolicy {
  const targetInputTokens = Math.min(
    retrievalChunkTargetTokens,
    embeddingContextCapacityTokens,
  );
  return {
    accounting: "cl100k-base-tokens-v1",
    canonicalEvidence: "query-dense-exact-window-v1",
    finalInput: "provider-formatted-section-and-content-v1",
    generatedDescription:
      "separate-table-description-dense-plus-hybrid-lexical-v1",
    id: "citeloom/retrieval-window:structured-token-v3",
    image: "description-only-single-window-v1",
    kind: "structured-token",
    maximumInputTokens: embeddingContextCapacityTokens,
    oversizedUnit: "split-boundary-retry-smaller-v1",
    parentFusion: "retrieval-evidence-before-candidate-budget-v1",
    table: "complete-table-caption-header-row-split-v3",
    targetInputTokens,
    text:
      "same-section-structure-paragraph-sentence-punctuation-word-no-overlap-v3",
  };
}

export function createRetrievalWindowPolicyContract(
  policy: RetrievalWindowPolicy,
): RetrievalWindowPolicyContract {
  const normalized = readRetrievalWindowPolicy(policy);
  return {
    fingerprint: createRetrievalWindowPolicyFingerprint(normalized),
    policy: normalized,
  };
}

export function readRetrievalWindowPolicyContract(
  value: unknown,
): RetrievalWindowPolicyContract {
  const result = retrievalWindowPolicyContractSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid retrieval-window policy contract: ${result.error.message}`,
    );
  }
  return result.data;
}

export function readRetrievalWindowPolicy(
  value: unknown,
): RetrievalWindowPolicy {
  const result = retrievalWindowPolicySchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid retrieval-window policy: ${result.error.message}`);
  }
  return result.data;
}

export function createRetrievalWindowPolicyFingerprint(
  policy: RetrievalWindowPolicy,
): string {
  const normalized = readRetrievalWindowPolicy(policy);
  return createStoredRetrievalWindowPolicyFingerprint(normalized);
}

export function createStoredRetrievalWindowPolicyFingerprint(
  policy: StoredRetrievalWindowPolicy,
): string {
  return createHash("sha256")
    .update(serializeRetrievalWindowPolicy(policy))
    .digest("hex");
}

function serializeRetrievalWindowPolicy(
  policy: StoredRetrievalWindowPolicy,
): string {
  return [
    policy.id,
    policy.kind,
    policy.generatedDescription,
    policy.parentFusion,
    policy.canonicalEvidence,
    policy.accounting,
    policy.targetInputTokens,
    policy.maximumInputTokens,
    policy.finalInput,
    policy.text,
    policy.table,
    policy.image,
    policy.oversizedUnit,
  ].join("\0");
}
