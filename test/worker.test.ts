import { describe, expect, it, vi } from "vitest";

import type { IngestionJob } from "../src/documents/catalog/index.js";
import {
  runWorkerDispatcher,
  type WorkerActivityRegistry,
  type WorkerClaimedWork,
  type WorkerClaimResult,
  type WorkerDispatcherSource,
  type WorkerWakeup,
} from "../src/ingestion/worker.js";

describe("worker dispatcher", () => {
  it("does not claim work after shutdown has started", async () => {
    const controller = new AbortController();
    controller.abort(new Error("worker stopped"));
    const source = buildDispatcherSource();
    const registry = buildActivityRegistry();

    await runWorkerDispatcher(source, registry, false, controller.signal);

    expect(source.claimNextJob).not.toHaveBeenCalled();
    expect(registry.jobStarted).not.toHaveBeenCalled();
  });

  it("interrupts and releases a claim returned during shutdown", async () => {
    const controller = new AbortController();
    const processClaimedJob = vi.fn(async (_job, signal?: AbortSignal) => {
      expect(signal).toBe(controller.signal);
      expect(signal?.aborted).toBe(true);
      return { kind: "interrupted" } as const;
    });
    const work: WorkerClaimedWork = {
      doclingProbeFailed: false,
      doclingServicesWaiting: false,
      job: buildRunningJob(),
      processor: { processClaimedJob },
      requiresDocling: true,
    };
    const source = buildDispatcherSource();
    source.claimNextJob = vi.fn(async () => {
      controller.abort(new Error("worker stopped"));
      return { kind: "claimed", work };
    });
    const registry = buildActivityRegistry();

    await runWorkerDispatcher(source, registry, false, controller.signal);

    expect(source.claimNextJob).toHaveBeenCalledOnce();
    expect(processClaimedJob).toHaveBeenCalledOnce();
    expect(registry.jobStarted).toHaveBeenCalledOnce();
    expect(registry.jobFinished).toHaveBeenCalledOnce();
  });

  it("discovers new work immediately after a jobs revision", async () => {
    const controller = new AbortController();
    const source = buildDispatcherSource();
    const work = buildClaimedWork(
      "/documents/notified.pdf",
      Promise.resolve(),
    );
    let claims = 0;
    source.claimNextJob = vi.fn(async () => {
      claims += 1;
      if (claims === 2) {
        return { kind: "claimed", work };
      }
      if (claims === 3) {
        controller.abort(new Error("test complete"));
      }
      return { kind: "idle" };
    });
    source.waitForWakeup = vi.fn(async (): Promise<WorkerWakeup> => {
      return { channels: ["jobs"] };
    });

    await runWorkerDispatcher(source, buildActivityRegistry(), false, controller.signal);

    expect(source.waitForWakeup).toHaveBeenCalledOnce();
    expect(source.claimNextJob).toHaveBeenCalledTimes(3);
  });

  it("reconciles repeated idle fallback wakeups", async () => {
    const controller = new AbortController();
    const source = buildDispatcherSource();
    let claims = 0;
    source.claimNextJob = vi.fn(async () => {
      claims += 1;
      if (claims === 3) {
        controller.abort(new Error("test complete"));
      }
      return { kind: "idle" };
    });
    source.waitForWakeup = vi.fn(async (): Promise<WorkerWakeup> => {
      return { channels: [] };
    });

    await runWorkerDispatcher(
      source,
      buildActivityRegistry(),
      false,
      controller.signal,
    );

    expect(source.claimNextJob).toHaveBeenCalledTimes(3);
    expect(source.waitForWakeup).toHaveBeenCalledTimes(2);
  });

  it("recovers missed work from a fallback without a notification", async () => {
    const controller = new AbortController();
    const source = buildDispatcherSource();
    const work = buildClaimedWork(
      "/documents/fallback.pdf",
      Promise.resolve(),
    );
    let claimCount = 0;
    source.claimNextJob = vi.fn(async () => {
      claimCount += 1;
      if (claimCount === 1) {
        return { kind: "idle" };
      }
      if (claimCount === 2) {
        return { kind: "claimed", work };
      }
      controller.abort(new Error("test complete"));
      return { kind: "idle" };
    });
    source.waitForWakeup = vi.fn(async (): Promise<WorkerWakeup> => {
      return { channels: [] };
    });

    await runWorkerDispatcher(
      source,
      buildActivityRegistry(),
      false,
      controller.signal,
    );

    expect(source.waitForWakeup).toHaveBeenCalled();
    expect(source.claimNextJob).toHaveBeenCalledTimes(3);
  });

  it("backs off an unavailable service and resumes after recovery", async () => {
    const controller = new AbortController();
    const source = buildDispatcherSource();
    const work = buildClaimedWork(
      "/documents/recovered.pdf",
      Promise.resolve(),
      true,
    );
    let now = 0;
    let claimCount = 0;
    source.claimNextJob = vi.fn(async (allowDoclingVerification) => {
      claimCount += 1;
      if (claimCount === 1) {
        expect(allowDoclingVerification).toBe(true);
        return {
          doclingProbeFailed: true,
          doclingServicesWaiting: true,
          kind: "docling-unavailable",
        };
      }
      if (claimCount === 2) {
        expect(allowDoclingVerification).toBe(true);
        return { kind: "claimed", work };
      }
      controller.abort(new Error("test complete"));
      return { kind: "idle" };
    });
    source.waitForWakeup = vi.fn(async (
      timeoutMs: number,
    ): Promise<WorkerWakeup> => {
      now += timeoutMs;
      return { channels: [] };
    });

    await runWorkerDispatcher(
      source,
      buildActivityRegistry(),
      false,
      controller.signal,
      { now: () => now, random: () => 0 },
    );

    expect(source.waitForWakeup).toHaveBeenCalledWith(
      500,
      controller.signal,
    );
    expect(source.claimNextJob).toHaveBeenCalledTimes(3);
  });

  it("lets a jobs notification interrupt Docling backoff", async () => {
    const controller = new AbortController();
    const source = buildDispatcherSource();
    let claimCount = 0;
    source.claimNextJob = vi.fn(async (allowDoclingVerification) => {
      claimCount += 1;
      if (claimCount === 1) {
        return {
          doclingProbeFailed: true,
          doclingServicesWaiting: true,
          kind: "docling-unavailable",
        };
      }
      expect(allowDoclingVerification).toBe(true);
      controller.abort(new Error("test complete"));
      return { kind: "idle" };
    });
    source.waitForWakeup = vi.fn(async (): Promise<WorkerWakeup> => {
      return { channels: ["jobs"] };
    });

    await runWorkerDispatcher(
      source,
      buildActivityRegistry(),
      false,
      controller.signal,
      { now: () => 0, random: () => 0 },
    );

    expect(source.waitForWakeup).toHaveBeenCalledOnce();
    expect(source.claimNextJob).toHaveBeenCalledTimes(2);
  });

  it("lets a settings notification interrupt Docling backoff", async () => {
    const controller = new AbortController();
    const source = buildDispatcherSource();
    let claimCount = 0;
    source.claimNextJob = vi.fn(async (allowDoclingVerification) => {
      claimCount += 1;
      if (claimCount === 1) {
        return {
          doclingProbeFailed: true,
          doclingServicesWaiting: true,
          kind: "docling-unavailable",
        };
      }
      expect(allowDoclingVerification).toBe(true);
      controller.abort(new Error("test complete"));
      return { kind: "idle" };
    });
    source.waitForWakeup = vi.fn(async (): Promise<WorkerWakeup> => {
      return { channels: ["settings"] };
    });

    await runWorkerDispatcher(
      source,
      buildActivityRegistry(),
      false,
      controller.signal,
      { now: () => 0, random: () => 0 },
    );

    expect(source.waitForWakeup).toHaveBeenCalledOnce();
    expect(source.claimNextJob).toHaveBeenCalledTimes(2);
  });

  it("stops Docling retries when dependent demand disappears", async () => {
    const controller = new AbortController();
    const source = buildDispatcherSource();
    const timeouts: number[] = [];
    let claimCount = 0;
    source.claimNextJob = vi.fn(async () => {
      claimCount += 1;
      if (claimCount === 1) {
        return {
          doclingProbeFailed: true,
          doclingServicesWaiting: true,
          kind: "docling-unavailable",
        };
      }
      return { kind: "idle" };
    });
    source.waitForWakeup = vi.fn(async (
      timeoutMs: number,
    ): Promise<WorkerWakeup> => {
      timeouts.push(timeoutMs);
      if (timeouts.length === 2) {
        controller.abort(new Error("test complete"));
      }
      return { channels: ["catalog"] };
    });

    await runWorkerDispatcher(
      source,
      buildActivityRegistry(),
      false,
      controller.signal,
      { now: () => 0, random: () => 0 },
    );

    expect(timeouts).toEqual([500, 60_000]);
  });

  it("refreshes settings before claiming replacement work", async () => {
    const controller = new AbortController();
    const source = buildDispatcherSource();
    let completeFirstJob: () => void = () => undefined;
    let completeSecondJob: () => void = () => undefined;
    const firstJob = new Promise<void>((resolve) => {
      completeFirstJob = resolve;
    });
    const secondJob = new Promise<void>((resolve) => {
      completeSecondJob = resolve;
    });
    const firstWork = buildClaimedWork("/documents/first.pdf", firstJob);
    const secondWork = buildClaimedWork("/documents/second.pdf", secondJob);
    let claimCount = 0;
    source.claimNextJob = vi.fn(async () => {
      claimCount += 1;
      if (claimCount === 1) {
        return { kind: "claimed", work: firstWork };
      }
      if (claimCount === 2) {
        return { kind: "claimed", work: secondWork };
      }
      completeSecondJob();
      controller.abort(new Error("test complete"));
      return { kind: "idle" };
    });

    const dispatcher = runWorkerDispatcher(
      source,
      buildActivityRegistry(),
      false,
      controller.signal,
    );
    await vi.waitFor(() => {
      expect(source.claimNextJob).toHaveBeenCalledTimes(2);
    });
    completeFirstJob();
    await dispatcher;

    expect(source.refreshIfChanged).toHaveBeenCalledTimes(2);
    const refreshOrder = source.refreshIfChanged.mock.invocationCallOrder[1];
    const replacementClaimOrder = source.claimNextJob.mock.invocationCallOrder[2];
    if (refreshOrder === undefined || replacementClaimOrder === undefined) {
      throw new Error("Missing worker dispatcher invocation order.");
    }
    expect(refreshOrder).toBeLessThan(replacementClaimOrder);
  });

  it("fills increased concurrency while existing work remains active", async () => {
    const controller = new AbortController();
    const source = buildDispatcherSource();
    let concurrency = 1;
    Object.defineProperty(source, "concurrency", {
      get: () => concurrency,
    });
    let refreshCount = 0;
    source.refreshIfChanged = vi.fn(async () => {
      refreshCount += 1;
      if (refreshCount === 2) {
        concurrency = 2;
        return true;
      }
      return false;
    });
    let completeFirstJob: () => void = () => undefined;
    const firstJob = new Promise<void>((resolve) => {
      completeFirstJob = resolve;
    });
    const firstWork = buildClaimedWork("/documents/first.pdf", firstJob);
    const secondWork = buildClaimedWork("/documents/second.pdf", Promise.resolve());
    let claimCount = 0;
    source.claimNextJob = vi.fn(async () => {
      claimCount += 1;
      if (claimCount === 1) {
        return { kind: "claimed", work: firstWork };
      }
      if (claimCount === 2) {
        completeFirstJob();
        controller.abort(new Error("test complete"));
        return { kind: "claimed", work: secondWork };
      }
      return { kind: "idle" };
    });
    let wakeWorker: () => void = () => undefined;
    source.waitForWakeup = vi.fn(async (
      _timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<WorkerWakeup> => {
      await new Promise<void>((resolve) => {
        wakeWorker = resolve;
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { channels: ["settings"] };
    });

    const dispatcher = runWorkerDispatcher(
      source,
      buildActivityRegistry(),
      false,
      controller.signal,
    );
    await vi.waitFor(() => {
      expect(source.claimNextJob).toHaveBeenCalledOnce();
      expect(source.waitForWakeup).toHaveBeenCalledOnce();
    });
    wakeWorker();
    await dispatcher;

    expect(source.refreshIfChanged).toHaveBeenCalledTimes(2);
    expect(source.claimNextJob).toHaveBeenCalledTimes(2);
  });
});

function buildDispatcherSource(): WorkerDispatcherSource & {
  claimNextJob: ReturnType<
    typeof vi.fn<(allowDoclingVerification: boolean) => Promise<WorkerClaimResult>>
  >;
  refreshIfChanged: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
} {
  return {
    claimNextJob: vi.fn(async () => ({ kind: "idle" })),
    concurrency: 2,
    fallbackPollIntervalMs: 60_000,
    refreshIfChanged: vi.fn(async () => false),
    waitForWakeup: vi.fn(async (
      _timeoutMs: number,
      signal?: AbortSignal,
    ): Promise<WorkerWakeup> => {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return { channels: [] };
    }),
  };
}

function buildActivityRegistry(): WorkerActivityRegistry & {
  jobFinished: ReturnType<typeof vi.fn<() => Promise<void>>>;
  jobStarted: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  return {
    jobFinished: vi.fn(async () => undefined),
    jobStarted: vi.fn(async () => undefined),
  };
}

function buildRunningJob(): IngestionJob {
  return {
    attemptCount: 0,
    documentId: "a".repeat(64),
    doclingAttemptConfig: null,
    doclingRunId: null,
    elementSetId: null,
    embeddingSpaceId: "test:plain:768",
    controlError: null,
    controlState: "active",
    errorMessage: null,
    format: {
      extension: ".pdf",
      mediaType: "application/pdf",
    },
    generationId: "00000000-0000-4000-8000-000000000001",
    images: 0,
    indexingActivity: null,
    leaseExpiresAt: "2026-07-15T12:02:00.000Z",
    maxAttempts: 3,
    nextAttemptAt: "2026-07-15T12:00:00.000Z",
    ownerId: "00000000-0000-4000-8000-000000000001",
    pageCount: null,
    phase: "discovered",
    sourceFile: "/documents/test.pdf",
    state: "running",
    tables: 0,
    tags: [],
    textChunks: 0,
    totalElements: 0,
    updatedAt: "2026-07-15T12:00:00.000Z",
    uploadedByUserId: null,
  };
}

function buildClaimedWork(
  sourceFile: string,
  completion: Promise<void>,
  requiresDocling: boolean = false,
): WorkerClaimedWork {
  const job = buildRunningJob();
  job.sourceFile = sourceFile;
  return {
    doclingProbeFailed: false,
    doclingServicesWaiting: false,
    job,
    processor: {
      processClaimedJob: async () => {
        await completion;
        return { kind: "interrupted" } as const;
      },
    },
    requiresDocling,
  };
}
