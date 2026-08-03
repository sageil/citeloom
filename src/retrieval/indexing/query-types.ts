import type {
  DenseCandidate,
  LexicalCandidate,
} from "../ranking/rank-fusion.js";

export interface RetrievalCandidateRankings {
  dense: DenseCandidate[][];
  lexical: LexicalCandidate[][];
}

export interface RetrievalQuery {
  embedding: number[] | null;
  kind?: "contextualized" | "expansion" | "original";
  text: string;
}
