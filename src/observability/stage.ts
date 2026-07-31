import { z } from "zod";

export const telemetryStageNameSchema = z.enum([
  "answer",
  // Retained so stored runs from the removed classifier remain readable.
  "answer-shape",
  "claim-verification",
  "dense-retrieval",
  "fusion",
  "hydration",
  "lexical-retrieval",
  "query-embedding",
  "query-contextualization",
  "query-expansion",
  "reranking",
  "scope-resolution",
]);

export type TelemetryStageName = z.output<typeof telemetryStageNameSchema>;
