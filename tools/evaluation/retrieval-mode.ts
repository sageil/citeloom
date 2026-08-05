import {
  RETRIEVAL_MODES,
  type RetrievalMode,
} from "../../src/retrieval/mode.js";

export const EVALUATION_RETRIEVAL_MODES = [
  ...RETRIEVAL_MODES,
  "hybrid-reranked",
] as const;

export type EvaluationRetrievalMode =
  (typeof EVALUATION_RETRIEVAL_MODES)[number];

export function readCandidateRetrievalMode(
  mode: EvaluationRetrievalMode,
): RetrievalMode {
  return mode === "hybrid-reranked" ? "hybrid" : mode;
}
