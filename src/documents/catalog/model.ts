import { z } from "zod";

import type { DoclingAttemptConfigSnapshot } from "../../docling/protocol/run-metadata.js";
import type { DocumentFormat } from "../format.js";

export type { DoclingTaskReference } from "../../docling/client/task.js";

export const ingestionPhaseSchema = z.enum([
  "discovered",
  "normalized",
  "indexed",
]);
export const ingestionStateSchema = z.enum(["pending", "running", "failed"]);
export const indexingActivitySchema = z.enum([
  "preparing",
  "describing",
  "embedding",
  "building_outline",
]);
export const ingestionControlStateSchema = z.enum([
  "active",
  "pause_requested",
  "paused",
  "cancel_requested",
  "cleanup_failed",
]);

export type IngestionPhase = z.output<typeof ingestionPhaseSchema>;
export type IngestionState = z.output<typeof ingestionStateSchema>;
export type IndexingActivity = z.output<typeof indexingActivitySchema>;
export type IngestionControlState = z.output<typeof ingestionControlStateSchema>;

export interface IngestionControlActor {
  isAdministrator: boolean;
  userId: string;
}

export interface IngestionControlDoclingTask {
  controlState: "pause_requested" | "cancel_requested";
  serviceInstanceId: string;
  sourceFile: string;
  taskId: string;
}

export interface ElementCounts {
  images: number;
  tables: number;
  textChunks: number;
  totalElements: number;
}

export interface DocumentStatistics extends ElementCounts {
  pageCount: number | null;
}

export class QueryScopeNotResolvedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "QueryScopeNotResolvedError";
  }
}

export interface IndexedDocument extends DocumentStatistics {
  documentId: string;
  elementSetId: string;
  generationId: string;
  indexedAt: string;
  sourceFile: string;
  tags: string[];
  versionId: string;
}

export interface PublishedDocument extends IndexedDocument {
  format: DocumentFormat;
}

export interface IngestionJobBase extends DocumentStatistics {
  attemptCount: number;
  documentId: string;
  doclingAttemptConfig: DoclingAttemptConfigSnapshot | null;
  doclingRunId: string | null;
  elementSetId: string | null;
  embeddingSpaceId: string;
  errorMessage: string | null;
  format: DocumentFormat;
  generationId: string;
  indexingActivity: IndexingActivity | null;
  maxAttempts: number;
  nextAttemptAt: string;
  phase: IngestionPhase;
  controlError: string | null;
  controlState: IngestionControlState;
  sourceFile: string;
  tags: string[];
  updatedAt: string;
  uploadedByUserId: string | null;
}

export type RunningIngestionJob = IngestionJobBase & {
  leaseExpiresAt: string;
  ownerId: string;
  state: "running";
};

type FailedIngestionJob = IngestionJobBase & {
  leaseExpiresAt: null;
  ownerId: null;
  state: "failed";
};

export type PendingIngestionJob = IngestionJobBase & {
  leaseExpiresAt: null;
  ownerId: null;
  state: "pending";
};

export type IngestionJob =
  | FailedIngestionJob
  | PendingIngestionJob
  | RunningIngestionJob;

export interface CatalogEntry extends DocumentStatistics {
  activeDocumentId: string | null;
  activeVersionId: string | null;
  attemptCount: number | null;
  documentId: string;
  errorMessage: string | null;
  embeddingSpaceIds: string[];
  indexingActivity: IndexingActivity | null;
  maxAttempts: number | null;
  nextAttemptAt: string | null;
  phase: IngestionPhase | null;
  controlError: string | null;
  controlState: IngestionControlState;
  sourceFile: string;
  status: "ready" | IngestionState;
  tags: string[];
  updatedAt: string;
  uploadedByUserId: string | null;
}

export type PrepareIngestionResult =
  | {
      abandonedJob: null;
      existing: IngestionJob;
      kind: "busy";
    }
  | {
      abandonedJob: null;
      existing: IngestionJob;
      kind: "already-processing";
    }
  | {
      abandonedJob: null;
      existing: IndexedDocument | IngestionJob;
      kind: "duplicate";
    }
  | {
      abandonedJob: IngestionJob | null;
      document: IndexedDocument;
      kind: "skipped";
    }
  | {
      abandonedJob: IngestionJob | null;
      job: IngestionJob;
      kind: "process";
    };

export interface PromotionResult {
  indexed: IndexedDocument;
  previous: IndexedDocument | null;
}

export interface JobFailureResult {
  attempts: number;
  retryAt: string | null;
  retryScheduled: boolean;
}

export type RetryFailedJobResult =
  | { kind: "not-found" }
  | { kind: "not-failed"; state: Exclude<IngestionState, "failed"> }
  | { job: PendingIngestionJob; kind: "retried" };

export type RequestIngestionControlResult =
  | { kind: "canceled"; sourceFile: string }
  | { error: string; kind: "cleanup-failed" }
  | { kind: "forbidden" }
  | { kind: "not-found" }
  | { controlState: IngestionControlState; kind: "invalid"; state: IngestionState }
  | { job: IngestionJob; kind: "accepted" };

export type ResumeIngestionResult =
  | { kind: "forbidden" }
  | { kind: "not-found" }
  | { kind: "not-paused" }
  | { job: PendingIngestionJob; kind: "resumed" };


export interface Clock {
  now: () => Date;
}
