import { z } from "zod";

export const telemetryStageNameSchema = z.enum([
  "answer",
  "claim-verification",
  "dense-retrieval",
  "fusion",
  "hydration",
  "lexical-retrieval",
  "query-embedding",
  "query-expansion",
  "reranking",
  "scope-resolution",
]);

export type TelemetryStageName = z.output<typeof telemetryStageNameSchema>;
