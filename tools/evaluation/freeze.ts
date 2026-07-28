import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import type { AppConfig } from "../../src/config/index.js";
import { HNSW_QUERY_SETTINGS } from "../../src/database/client.js";
import { embeddingInputFormatContractSchema } from "../../src/embedding/input-format-model.js";
import { createInferenceModelRegistry } from "../../src/inference/registry.js";
import { CHANNEL_ORDERING_POLICY } from "../../src/retrieval/ranking/channel-ordering.js";
import { retrievalWindowPolicyContractSchema } from "../../src/retrieval/window-policy.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const modelIdentitySchema = z.object({
  modelId: z.string().min(1),
  provider: z.string().min(1),
}).strict();
const rankFusionSchema = z.object({
  denseWeight: z.number().positive().max(100),
  expansionDecay: z.number().positive().max(1),
  expansionQueryWeight: z.number().positive().max(100),
  lexicalWeight: z.number().positive().max(100),
  originalQueryWeight: z.number().positive().max(100),
}).strict();
const freezePayloadSchema = z.object({
  codeRevision: z.string().min(1),
  embeddingSpace: z.object({
    dimensions: z.union([z.literal(384), z.literal(768), z.literal(1024)]),
    id: z.string().min(1),
    inputFormat: embeddingInputFormatContractSchema,
    model: z.string().min(1),
    retrievalWindow: retrievalWindowPolicyContractSchema,
  }).strict(),
  hnsw: z.object({
    efSearch: z.number().int().positive(),
    iterativeScan: z.literal("strict_order"),
  }).strict(),
  models: z.object({
    queryEmbedding: modelIdentitySchema,
    queryExpansion: modelIdentitySchema,
    reranker: modelIdentitySchema.nullable(),
  }).strict(),
  retrieval: z.object({
    candidateK: z.number().int().positive(),
    channelOrderingPolicy: z.literal(CHANNEL_ORDERING_POLICY),
    fusion: rankFusionSchema,
    queryExpansions: z.number().int().nonnegative(),
    rrfK: z.number().int().positive(),
    topK: z.number().int().positive(),
    variantConcurrency: z.number().int().min(1).max(16),
  }).strict(),
  settingsVersion: z.number().int().nonnegative(),
}).strict();
const evaluationConfigurationFreezeSchema = z.object({
  fingerprintSha256: sha256Schema,
  payload: freezePayloadSchema,
  version: z.literal(6),
}).strict();

export type EvaluationConfigurationFreeze = z.output<
  typeof evaluationConfigurationFreezeSchema
>;

export function createEvaluationConfigurationFreeze(
  config: AppConfig,
  codeRevision: string,
  settingsVersion: number,
): EvaluationConfigurationFreeze {
  const models = createInferenceModelRegistry(config);
  const reranker = models.reranker;
  const payload: EvaluationConfigurationFreeze["payload"] = {
    codeRevision,
    embeddingSpace: { ...config.embeddingSpace },
    hnsw: { ...HNSW_QUERY_SETTINGS },
    models: {
      queryEmbedding: {
        modelId: models.queryEmbedding.modelId,
        provider: models.queryEmbedding.provider,
      },
      queryExpansion: {
        modelId: models.summary.modelId,
        provider: models.summary.provider,
      },
      reranker: reranker === null
        ? null
        : {
          modelId: reranker.model.modelId,
          provider: reranker.model.provider,
        },
    },
    retrieval: {
      candidateK: config.retrieval.candidateK,
      channelOrderingPolicy: CHANNEL_ORDERING_POLICY,
      fusion: { ...config.retrieval.fusion },
      queryExpansions: config.retrieval.queryExpansions,
      rrfK: config.retrieval.rrfK,
      topK: config.retrieval.topK,
      variantConcurrency: config.retrieval.variantConcurrency,
    },
    settingsVersion,
  };
  return {
    fingerprintSha256: calculateJsonSha256(payload),
    payload,
    version: 6,
  };
}

export function assertEvaluationConfigurationFrozen(
  config: AppConfig,
  codeRevision: string,
  settingsVersion: number,
  freeze: EvaluationConfigurationFreeze,
): void {
  const expected = createEvaluationConfigurationFreeze(
    config,
    codeRevision,
    settingsVersion,
  );
  if (expected.fingerprintSha256 !== freeze.fingerprintSha256) {
    throw new Error(
      "The active evaluation configuration does not match the frozen configuration.",
    );
  }
}

export function decodeEvaluationConfigurationFreeze(
  value: unknown,
  sourceLabel: string,
): EvaluationConfigurationFreeze {
  rejectIncompatibleFreezeVersion(value, sourceLabel);
  const result = evaluationConfigurationFreezeSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid frozen evaluation configuration ${sourceLabel}: ${result.error.message}`,
    );
  }
  const fingerprint = calculateJsonSha256(result.data.payload);
  if (fingerprint !== result.data.fingerprintSha256) {
    throw new Error(
      `Invalid frozen evaluation configuration ${sourceLabel}: fingerprint does not match.`,
    );
  }
  return result.data;
}

function rejectIncompatibleFreezeVersion(
  value: unknown,
  sourceLabel: string,
): void {
  if (
    typeof value !== "object"
    || value === null
    || !("version" in value)
  ) {
    return;
  }
  const version = value.version;
  if (version !== 6) {
    throw new Error(
      `Incompatible frozen evaluation configuration ${sourceLabel}: expected version 6, received ${String(version)}.`,
    );
  }
}

export async function readEvaluationConfigurationFreeze(
  filePath: string,
): Promise<EvaluationConfigurationFreeze> {
  const content = await readFile(filePath, "utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid frozen evaluation JSON in ${filePath}: ${message}`);
  }
  return decodeEvaluationConfigurationFreeze(parsedJson, filePath);
}

export async function writeEvaluationConfigurationFreeze(
  filePath: string,
  freeze: EvaluationConfigurationFreeze,
): Promise<void> {
  const normalized = decodeEvaluationConfigurationFreeze(
    freeze,
    "generated output",
  );
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

function calculateJsonSha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
