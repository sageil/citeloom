import type { EmbeddingDimensions } from "../dimensions.js";

export interface EmbeddingSpaceRowCounts {
  indexedDocuments: number;
  lexicalChunks: number;
  vectorChunks1024: number;
  vectorChunks1536: number;
  vectorChunks2048: number;
  vectorChunks384: number;
  vectorChunks768: number;
}

export type EmbeddingSpaceProtectionKind =
  | "active"
  | "job-reference"
  | "pinned"
  | "retention-window";

export interface EmbeddingSpaceGcSpaceRecord {
  createdAt: string;
  dimensions: EmbeddingDimensions;
  disposition: "deletable" | "protected";
  errorMessage: string | null;
  estimatedBytes: string;
  inputFormatHash: string;
  inputFormatName: string;
  model: string;
  protectionDetail: string | null;
  protectionKind: EmbeddingSpaceProtectionKind | null;
  rowCounts: EmbeddingSpaceRowCounts;
  spaceId: string;
  state: "deleted" | "failed" | "planned" | "protected";
}

export interface EmbeddingSpaceGcReport {
  activeSpaceId: string;
  completedAt: string | null;
  errorMessage: string | null;
  id: string;
  mode: "apply" | "dry-run";
  retentionCutoff: string;
  spaces: EmbeddingSpaceGcSpaceRecord[];
  startedAt: string;
  status: "completed" | "failed" | "running";
}
