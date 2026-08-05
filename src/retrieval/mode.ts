export const RETRIEVAL_MODES = ["bm25", "dense", "hybrid"] as const;

export type RetrievalMode = (typeof RETRIEVAL_MODES)[number];
