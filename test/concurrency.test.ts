import { setTimeout as delay } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { mapWithConcurrency, TaskLimiter } from "../src/shared/concurrency.js";

describe("bounded concurrency", () => {
  it("never exceeds the configured task limit and preserves result order", async () => {
    const limiter = new TaskLimiter(2);
    const inputs = [1, 2, 3, 4, 5, 6];
    let activeTasks = 0;
    let maximumActiveTasks = 0;

    const results = await mapWithConcurrency(inputs, 6, async (value) =>
      limiter.run(async () => {
        activeTasks += 1;
        maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks);
        await delay(2);
        activeTasks -= 1;
        return value * 2;
      }),
    );

    expect(maximumActiveTasks).toBe(2);
    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
  });

  it("removes an aborted task while it waits for capacity", async () => {
    const limiter = new TaskLimiter(1);
    const firstGate = { resolve: (): void => {
      throw new Error("First task did not start.");
    } };
    const first = limiter.run(async () => {
      await new Promise<void>((resolve) => {
        firstGate.resolve = resolve;
      });
    });
    const abortController = new AbortController();
    const second = limiter.run(async () => undefined, abortController.signal);
    abortController.abort(new Error("worker stopped"));

    await expect(second).rejects.toThrow("worker stopped");
    firstGate.resolve();
    await first;
    await expect(limiter.run(async () => "available")).resolves.toBe("available");
  });

  it("marks execution only after scheduler capacity is acquired", async () => {
    const limiter = new TaskLimiter(1);
    const firstGate = { resolve: (): void => {
      throw new Error("First task did not start.");
    } };
    const first = limiter.run(async () => {
      await new Promise<void>((resolve) => {
        firstGate.resolve = resolve;
      });
    });
    const events: string[] = [];
    const second = limiter.run(
      async () => {
        events.push("task");
      },
      undefined,
      {
        completed: () => events.push("completed"),
        started: () => events.push("started"),
      },
    );

    await Promise.resolve();
    expect(events).toEqual([]);
    firstGate.resolve();
    await first;
    await second;

    expect(events).toEqual(["started", "task", "completed"]);
  });
});
