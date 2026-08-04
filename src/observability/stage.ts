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
  "query-expansion",
  "reranking",
  "scope-resolution",
  "toc-expansion",
  // Retained so stored runs from the removed model router remain readable.
  "toc-routing",
]);

export type TelemetryStageName = z.output<typeof telemetryStageNameSchema>;
