import { randomUUID } from "node:crypto";

import type { DoclingRequestKind } from "./conversion-request.js";
import type {
  DoclingEffectiveRequestOptions,
  DoclingProfilingSummary,
} from "../protocol/run-metadata.js";
import type { DoclingTaskReference } from "./task.js";

export interface DoclingRequestMetadata {
  kind: DoclingRequestKind;
  options: DoclingEffectiveRequestOptions;
  requestKey: string;
}

export type DoclingRequestEvent =
  | { at: Date; kind: "first-started" }
  | { at: Date; kind: "reconnected" }
  | { at: Date; kind: "resumed"; task: DoclingTaskReference }
  | {
      at: Date;
      kind: "submitted";
      task: DoclingTaskReference;
      uploadMs: number;
    }
  | {
      at: Date;
      kind: "transport-failed";
      outcome: "abort" | "service-error" | "timeout" | "transport-error";
      totalMs: number;
    }
  | {
      at: Date;
      kind: "transport-succeeded";
      resultRetrievalMs: number;
      taskWaitMs: number;
      totalMs: number;
    }
  | {
      at: Date;
      kind: "conversion-decoded";
      processingMs: number;
      profiling: DoclingProfilingSummary[];
    };

export interface DoclingConversionObserver {
  openRequest(metadata: DoclingRequestMetadata): Promise<DoclingRequestObserver>;
}

export interface DoclingRequestObserver {
  readonly identity: DoclingRequestIdentity;
  observe(event: DoclingRequestEvent): Promise<void>;
}

export interface DoclingRequestIdentity {
  id: string;
  sequence: number;
}

export const noOpDoclingConversionObserver: DoclingConversionObserver = {
  openRequest: async () => createNoOpDoclingRequestObserver(),
};

export function createNoOpDoclingRequestObserver(): DoclingRequestObserver {
  return {
    identity: {
      id: randomUUID(),
      sequence: 0,
    },
    observe: async () => undefined,
  };
}
