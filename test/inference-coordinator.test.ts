import { describe, expect, it, vi } from "vitest";

import type { SchedulingConfig } from "../src/config/index.js";
import type { CiteLoomDatabase } from "../src/database/client.js";
import { startManagedTask } from "../src/shared/concurrency.js";
import {
  type AcquiredSlot,
  type EnqueuedInferenceRequest,
  InferenceCoordinator,
  type InferenceCoordinatorPersistence,
  type InferenceLeaseRenewal,
  isBackgroundAdmissionDue,
  type QueueRequestInput,
  type QueuedRequest,
  type SchedulingEventRecord,
  selectAdmissionCandidate,
} from "../src/inference/coordinator.js";
import { createDeferred } from "./deferred-fixture.js";

describe("hardware-aware inference scheduling", () => {
  it("prefers interactive work until the background progress interval is due", () => {
    const interactive = buildRequest("interactive-answer", 2);
    const background = buildRequest("ingestion", 1);
    const lastBackgroundStart = new Date("2026-07-15T12:00:00.000Z");

    expect(isBackgroundAdmissionDue(
      lastBackgroundStart,
      new Date("2026-07-15T12:00:04.999Z"),
      5_000,
    )).toBe(false);
    expect(selectAdmissionCandidate(interactive, null)).toBe(interactive);

    expect(isBackgroundAdmissionDue(
      lastBackgroundStart,
      new Date("2026-07-15T12:00:05.000Z"),
      5_000,
    )).toBe(true);
    expect(selectAdmissionCandidate(interactive, background)).toBe(background);
  });

  it("removes cancelled queued work without consuming the acquired lease", async () => {
    const persistence = new MemoryCoordinatorPersistence();
    const coordinator = buildCoordinator(persistence);
    await coordinator.configure(buildSchedulingConfig());
    const ingestion = coordinator.createScheduler("shared", "ingestion", 2);
    const interactive = coordinator.createScheduler(
      "shared",
      "interactive-answer",
      2,
    );
    const firstGate = createDeferred<void>();
    const firstStarted = createDeferred<void>();
    const first = ingestion.run(async () => {
      firstStarted.resolve();
      await firstGate.promise;
    });
    await firstStarted.promise;

    const abortController = new AbortController();
    const second = interactive.run(
      async () => {
        throw new Error("Cancelled queued task must not execute.");
      },
      abortController.signal,
    );
    await vi.waitFor(() => expect(persistence.queuedCount).toBe(1));
    abortController.abort(new Error("request disconnected"));

    await expect(second).rejects.toThrow("request disconnected");
    expect(persistence.queuedCount).toBe(0);
    expect(persistence.events.at(-1)?.outcome).toBe("abort");
    expect(persistence.releaseCount).toBe(0);

    firstGate.resolve();
    await first;
    expect(persistence.releaseCount).toBe(1);
    await expect(interactive.run(async () => "available")).resolves.toBe(
      "available",
    );
  });

  it("releases an acquired lease and records its group and workload on abort", async () => {
    const persistence = new MemoryCoordinatorPersistence();
    const coordinator = buildCoordinator(persistence);
    await coordinator.configure(buildSchedulingConfig());
    const scheduler = coordinator.createScheduler(
      "shared",
      "interactive-search",
      1,
    );
    const abortController = new AbortController();
    const started = createDeferred<void>();
    const task = scheduler.run(async (requestSignal) => {
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        requestSignal.addEventListener("abort", () => {
          reject(requestSignal.reason);
        }, { once: true });
      });
    }, abortController.signal);
    await started.promise;

    abortController.abort(new Error("search cancelled"));

    await expect(task).rejects.toThrow("search cancelled");
    expect(persistence.releaseCount).toBe(1);
    expect(persistence.events).toHaveLength(1);
    expect(persistence.events[0]).toMatchObject({
      outcome: "abort",
      resourceGroup: "shared",
      workload: "interactive-search",
    });
    expect(persistence.events[0]?.executionDurationMs).not.toBeNull();
  });

  it("records lease cleanup failures as scheduling errors", async () => {
    const persistence = new MemoryCoordinatorPersistence();
    persistence.releaseError = new Error("database release failed");
    const coordinator = buildCoordinator(persistence);
    await coordinator.configure(buildSchedulingConfig());
    const scheduler = coordinator.createScheduler("shared", "maintenance", 1);

    await expect(scheduler.run(async () => "completed")).rejects.toThrow(
      "Inference lease cleanup failed",
    );
    expect(persistence.events).toHaveLength(1);
    expect(persistence.events[0]?.outcome).toBe("error");
  });

  it("retains capacity until a managed task completes", async () => {
    const persistence = new MemoryCoordinatorPersistence();
    const coordinator = buildCoordinator(persistence);
    await coordinator.configure(buildSchedulingConfig());
    const firstScheduler = coordinator.createScheduler(
      "shared",
      "interactive-answer",
      1,
    );
    const secondScheduler = coordinator.createScheduler(
      "shared",
      "interactive-answer",
      1,
    );
    const firstCompletion = createDeferred<void>();
    const secondStarted = vi.fn();

    const first = await startManagedTask(firstScheduler, async () => ({
      completion: firstCompletion.promise,
      value: "first",
    }));
    const second = startManagedTask(secondScheduler, async () => {
      secondStarted();
      return {
        completion: Promise.resolve(),
        value: "second",
      };
    });

    expect(first.value).toBe("first");
    await vi.waitFor(() => expect(persistence.queuedCount).toBe(1));
    expect(secondStarted).not.toHaveBeenCalled();
    expect(persistence.releaseCount).toBe(0);

    firstCompletion.resolve();

    await expect(first.completion).resolves.toBeUndefined();
    const secondTask = await second;
    expect(secondTask.value).toBe("second");
    await expect(secondTask.completion).resolves.toBeUndefined();
    expect(secondStarted).toHaveBeenCalledOnce();
    expect(persistence.releaseCount).toBe(2);
  });
});

class MemoryCoordinatorPersistence implements InferenceCoordinatorPersistence {
  public readonly events: SchedulingEventRecord[] = [];
  public releaseError: Error | null = null;
  public releaseCount = 0;
  private activeOwner: string | null = null;
  private readonly queue = new Map<string, QueuedRequest>();

  public get queuedCount(): number {
    return this.queue.size;
  }

  public async configure(_config: SchedulingConfig): Promise<void> {}

  public async enqueue(
    input: QueueRequestInput,
    leaseDurationMs: number,
  ): Promise<EnqueuedInferenceRequest> {
    const databaseNow = new Date();
    const request: QueuedRequest = {
      ...input,
      queuedAt: databaseNow,
    };
    this.queue.set(input.id, request);
    return {
      lease: {
        databaseNow,
        leaseExpiresAt: addMilliseconds(databaseNow, leaseDurationMs),
      },
      request,
    };
  }

  public async recordSchedulingEvent(
    record: SchedulingEventRecord,
  ): Promise<void> {
    this.events.push(record);
  }

  public async releaseSlot(
    slot: AcquiredSlot,
  ): Promise<boolean> {
    if (this.releaseError !== null) {
      throw this.releaseError;
    }
    if (this.activeOwner !== slot.ownerId) {
      return false;
    }
    this.activeOwner = null;
    this.releaseCount += 1;
    return true;
  }

  public async removeQueuedRequest(request: QueuedRequest): Promise<void> {
    this.queue.delete(request.id);
  }

  public async renewQueuedRequest(
    request: QueuedRequest,
    leaseDurationMs: number,
  ): Promise<InferenceLeaseRenewal | null> {
    if (!this.queue.has(request.id)) {
      return null;
    }
    const databaseNow = new Date();
    return {
      databaseNow,
      leaseExpiresAt: addMilliseconds(databaseNow, leaseDurationMs),
    };
  }

  public async renewSlot(
    slot: AcquiredSlot,
    leaseDurationMs: number,
  ): Promise<InferenceLeaseRenewal | null> {
    if (this.activeOwner !== slot.ownerId) {
      return null;
    }
    const databaseNow = new Date();
    return {
      databaseNow,
      leaseExpiresAt: addMilliseconds(databaseNow, leaseDurationMs),
    };
  }

  public async tryAcquire(
    request: QueuedRequest,
    ownerId: string,
    leaseDurationMs: number,
  ): Promise<AcquiredSlot | null> {
    if (this.activeOwner !== null || !this.queue.has(request.id)) {
      return null;
    }
    const first = this.queue.values().next().value as QueuedRequest | undefined;
    if (first?.id !== request.id) {
      return null;
    }
    this.queue.delete(request.id);
    this.activeOwner = ownerId;
    const databaseNow = new Date();
    return {
      databaseNow,
      leaseExpiresAt: addMilliseconds(databaseNow, leaseDurationMs),
      ownerId,
      queuedAt: request.queuedAt,
      resourceGroup: request.resourceGroup,
      slotNumber: 1,
    };
  }
}

function addMilliseconds(value: Date, milliseconds: number): Date {
  return new Date(value.getTime() + milliseconds);
}

function buildCoordinator(
  persistence: InferenceCoordinatorPersistence,
): InferenceCoordinator {
  return new InferenceCoordinator(
    {} as CiteLoomDatabase,
    "11111111-1111-4111-8111-111111111111",
    60_000,
    1,
    persistence,
  );
}

function buildSchedulingConfig(): SchedulingConfig {
  return {
    backgroundProgressIntervalMs: 5_000,
    providers: [{
      maximumParallelRequests: 1,
      name: "Shared test capacity",
      providerId: "shared",
    }],
    settingsVersion: 0,
    targets: {
      answer: { providerId: "shared" },
    },
    telemetryEnabled: true,
  };
}

function buildRequest(
  workload: QueuedRequest["workload"],
  second: number,
): QueuedRequest {
  return {
    id: `00000000-0000-4000-8000-00000000000${second}`,
    ownerId: "11111111-1111-4111-8111-111111111111",
    queuedAt: new Date(`2026-07-15T12:00:0${second}.000Z`),
    resourceGroup: "shared",
    settingsVersion: 0,
    workload,
  };
}
