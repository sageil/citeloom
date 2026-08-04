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
  kind?: "conversation" | "expansion" | "original";
  text: string;
}
