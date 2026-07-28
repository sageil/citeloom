import { createHash, randomUUID } from "node:crypto";

import type {
  DoclingConversionObserver,
  DoclingRequestEvent,
  DoclingRequestMetadata,
  DoclingRequestObserver,
} from "../../src/docling/client/observer.js";
import type {
  DoclingProfilingSummary,
} from "../../src/docling/protocol/run-metadata.js";

export interface DoclingBenchmarkRequestMeasurements {
  processingMs: number;
  profiling: DoclingProfilingSummary[];
  reconnectCount: number;
  resultRetrievalMs: number;
  taskWaitMs: number;
  uploadMs: number;
}

export class DoclingBenchmarkObserver implements DoclingConversionObserver {
  private processingMs = 0;
  private readonly profiling: DoclingProfilingSummary[] = [];
  private reconnectCount = 0;
  private resultRetrievalMs = 0;
  private taskWaitMs = 0;
  private uploadMs = 0;

  public async openRequest(
    metadata: DoclingRequestMetadata,
  ): Promise<DoclingRequestObserver> {
    return {
      identity: { id: randomUUID(), sequence: 0 },
      observe: async (event): Promise<void> => {
        this.observe(metadata, event);
      },
    };
  }

  public read(): DoclingBenchmarkRequestMeasurements {
    return {
      processingMs: this.processingMs,
      profiling: [...this.profiling],
      reconnectCount: this.reconnectCount,
      resultRetrievalMs: this.resultRetrievalMs,
      taskWaitMs: this.taskWaitMs,
      uploadMs: this.uploadMs,
    };
  }

  private observe(
    metadata: DoclingRequestMetadata,
    event: DoclingRequestEvent,
  ): void {
    if (event.kind === "submitted") {
      this.uploadMs += event.uploadMs;
      return;
    }
    if (event.kind === "reconnected") {
      this.reconnectCount += 1;
      return;
    }
    if (event.kind === "transport-succeeded") {
      this.resultRetrievalMs += event.resultRetrievalMs;
      this.taskWaitMs += event.taskWaitMs;
      return;
    }
    if (event.kind !== "conversion-decoded") {
      return;
    }
    this.processingMs += event.processingMs;
    for (const stage of event.profiling) {
      this.profiling.push({
        ...stage,
        stage: createScopedStageName(metadata.requestKey, stage.stage),
      });
    }
  }
}

function createScopedStageName(requestKey: string, stage: string): string {
  const name = `${requestKey}:${stage}`;
  if (name.length <= 200) {
    return name;
  }
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `${name.slice(0, 186)}:${suffix}`;
}
