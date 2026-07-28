import { describe, expect, it, vi } from "vitest";

import {
  startApplicationErrorRetentionController,
} from "../src/observability/application-error-retention.js";
import { createDeferred } from "./deferred-fixture.js";

describe("application error retention controller", () => {
  it("reports a failed cleanup and retries on the next interval", async () => {
    const reported = createDeferred<void>();
    const cleanup = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue({
        batches: 1,
        deleted: 0,
        hasMore: false,
      });
    const reportError = vi.fn(async () => {
      reported.resolve();
    });
    const controller = startApplicationErrorRetentionController({
      catchUpDelayMs: 1,
      cleanup,
      intervalMs: 60_000,
      reportError,
    });

    await reported.promise;
    await vi.waitFor(() => {
      expect(cleanup.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    expect(reportError).toHaveBeenCalledOnce();
    await controller.close();
  });

  it("waits for an active cleanup before closing", async () => {
    const cleanupStarted = createDeferred<void>();
    const cleanupFinished = createDeferred<void>();
    const cleanup = vi.fn(async () => {
      cleanupStarted.resolve();
      await cleanupFinished.promise;
      return {
        batches: 1,
        deleted: 0,
        hasMore: false,
      };
    });
    const controller = startApplicationErrorRetentionController({
      cleanup,
      intervalMs: 60_000,
      reportError: async () => undefined,
    });
    await cleanupStarted.promise;

    let closed = false;
    const close = controller.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    cleanupFinished.resolve();
    await close;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(closed).toBe(true);
  });
});
