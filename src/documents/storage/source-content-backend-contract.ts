import type { Readable } from "node:stream";

export interface SourceContentMetadata {
  byteLength: number;
  documentId: string;
}

export type SourceContentWrite =
  | ({ content: Buffer; kind: "buffer" } & SourceContentMetadata)
  | ({ kind: "file"; sourceFile: string } & SourceContentMetadata)
  | ({
      kind: "stream";
      open: (abortSignal?: AbortSignal) => Promise<Readable>;
    } & SourceContentMetadata);

export interface SourceContentOrphanReconciliationRequest {
  graceMs: number;
  limit: number;
  nowMs: number;
  removeIfOrphan: (
    documentId: string,
    remove: () => Promise<void>,
  ) => Promise<boolean>;
}

export type SourceContentAccessMode = "read" | "write";

export interface SourceContentBackend {
  readonly identity: string;
  assertPresent(document: SourceContentMetadata): Promise<void>;
  initialize(mode?: SourceContentAccessMode): Promise<void>;
  openRead(
    document: SourceContentMetadata,
    abortSignal?: AbortSignal,
  ): Promise<Readable>;
  publish(
    document: SourceContentWrite,
    abortSignal?: AbortSignal,
  ): Promise<void>;
  read(document: SourceContentMetadata): Promise<Buffer>;
  reconcileOrphans(
    request: SourceContentOrphanReconciliationRequest,
  ): Promise<number>;
  remove(documentId: string): Promise<void>;
  verify(
    document: SourceContentMetadata,
    abortSignal?: AbortSignal,
  ): Promise<void>;
}

export class SourceContentMissingError extends Error {
  public constructor(documentId: string) {
    super(`Stored source document is missing or invalid: ${documentId}`);
    this.name = "SourceContentMissingError";
  }
}
