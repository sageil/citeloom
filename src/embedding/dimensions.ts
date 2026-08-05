import { z } from "zod";

export const EMBEDDING_DIMENSIONS = {
  DIMENSION_384: 384,
  DIMENSION_768: 768,
  DIMENSION_1024: 1024,
  DIMENSION_1536: 1536,
  DIMENSION_2048: 2048,
} as const;

export type EmbeddingDimensions =
  (typeof EMBEDDING_DIMENSIONS)[keyof typeof EMBEDDING_DIMENSIONS];

export const SUPPORTED_EMBEDDING_DIMENSIONS: readonly EmbeddingDimensions[] =
  Object.values(EMBEDDING_DIMENSIONS);

const supportedEmbeddingDimensionSet: ReadonlySet<number> = new Set(
  SUPPORTED_EMBEDDING_DIMENSIONS,
);

export const embeddingDimensionsSchema = z.custom<EmbeddingDimensions>(
  (value) => {
    return typeof value === "number"
      && Number.isInteger(value)
      && supportedEmbeddingDimensionSet.has(value);
  },
  { message: "Unsupported embedding dimensions." },
);

export function readEmbeddingDimensions(
  value: unknown,
  errorMessage = "Invalid embedding dimensions.",
): EmbeddingDimensions {
  const result = embeddingDimensionsSchema.safeParse(value);
  if (!result.success) {
    throw new Error(errorMessage);
  }
  return result.data;
}

export function readEmbeddingVector(
  value: unknown,
  dimensions: EmbeddingDimensions,
  label: string,
): number[] {
  if (!Array.isArray(value) || value.length !== dimensions) {
    throwInvalidEmbeddingVector(label, dimensions);
  }
  let hasNonzeroValue = false;
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      throwInvalidEmbeddingVector(label, dimensions);
    }
    if (entry !== 0) {
      hasNonzeroValue = true;
    }
  }
  if (!hasNonzeroValue) {
    throwInvalidEmbeddingVector(label, dimensions);
  }
  return value;
}

function throwInvalidEmbeddingVector(
  label: string,
  dimensions: EmbeddingDimensions,
): never {
  throw new Error(
    `Invalid ${label}: expected ${dimensions} finite numbers with at least one nonzero value.`,
  );
}
