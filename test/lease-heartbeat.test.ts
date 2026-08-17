import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startLeaseHeartbeat,
  type LeaseConfirmation,
} from "../src/shared/lease-heartbeat.js";
import { createDeferred } from "./deferred-fixture.js";

describe("lease heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renews after one third of the confirmed lease duration", async () => {
    vi.useFakeTimers();
    const renew = vi.fn().mockResolvedValue(buildLease(3_000));
    const heartbeat = await startLeaseHeartbeat({
      confirmedLease: buildLease(3_000),
      createLeaseLostError,
      renew,
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(renew).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledOnce();
    expect(heartbeat.signal.aborted).toBe(false);

    await heartbeat.stop();
  });

  it("establishes an initial lease before returning", async () => {
    vi.useFakeTimers();
    const renew = vi.fn().mockResolvedValue(buildLease(3_000));

    const heartbeat = await startLeaseHeartbeat({
      confirmedLease: null,
      createLeaseLostError,
      renew,
    });

    expect(renew).toHaveBeenCalledOnce();
    expect(heartbeat.signal.aborted).toBe(false);

    await heartbeat.stop();
  });

  it("retries a failed renewal before the confirmed deadline", async () => {
    vi.useFakeTimers();
    const renewalError = new Error("temporary database failure");
    const renew = vi.fn()
      .mockRejectedValueOnce(renewalError)
      .mockResolvedValue(buildLease(600));
    const onRenewalError = vi.fn();
    const heartbeat = await startLeaseHeartbeat({
      confirmedLease: buildLease(600),
      createLeaseLostError,
      onRenewalError,
      renew,
    });

    await vi.advanceTimersByTimeAsync(200);
    expect(renew).toHaveBeenCalledOnce();
    expect(onRenewalError).toHaveBeenCalledWith(renewalError, false);

    await vi.advanceTimersByTimeAsync(66);
    expect(renew).toHaveBeenCalledTimes(2);
    expect(heartbeat.signal.aborted).toBe(false);

    await heartbeat.stop();
  });

  it("loses an established lease when renewal is rejected", async () => {
    vi.useFakeTimers();
    const renew = vi.fn().mockResolvedValue(null);
    const heartbeat = await startLeaseHeartbeat({
      confirmedLease: buildLease(300),
      createLeaseLostError,
      renew,
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(renew).toHaveBeenCalledOnce();
    expect(heartbeat.signal.aborted).toBe(true);
    expect(heartbeat.signal.reason).toMatchObject({
      message: "Lease was lost.",
    });

    await heartbeat.stop();
  });

  it("returns an aborted heartbeat after initial renewal failure", async () => {
    vi.useFakeTimers();
    const renewalError = new Error("database unavailable");
    const renew = vi.fn().mockRejectedValue(renewalError);
    const onRenewalError = vi.fn();

    const heartbeat = await startLeaseHeartbeat({
      confirmedLease: null,
      createLeaseLostError,
      onRenewalError,
      renew,
    });

    expect(onRenewalError).toHaveBeenCalledWith(renewalError, true);
    expect(heartbeat.signal.aborted).toBe(true);
    expect(heartbeat.signal.reason).toMatchObject({
      cause: renewalError,
      message: "Lease was lost.",
    });

    await heartbeat.stop();
  });

  it("loses the lease at the confirmed deadline during a stalled renewal", async () => {
    vi.useFakeTimers();
    const renewal = createDeferred<LeaseConfirmation<null> | null>();
    const renew = vi.fn().mockReturnValue(renewal.promise);
    const heartbeat = await startLeaseHeartbeat({
      confirmedLease: buildLease(300),
      createLeaseLostError,
      renew,
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(renew).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(200);
    expect(heartbeat.signal.aborted).toBe(true);
    expect(heartbeat.signal.reason).toMatchObject({
      message: "Lease was lost.",
    });

    renewal.resolve(buildLease(300));
    await heartbeat.stop();
  });

  it("waits for an active renewal when stopped", async () => {
    vi.useFakeTimers();
    const renewal = createDeferred<LeaseConfirmation<null> | null>();
    const renew = vi.fn().mockReturnValue(renewal.promise);
    const heartbeat = await startLeaseHeartbeat({
      confirmedLease: buildLease(300),
      createLeaseLostError,
      renew,
    });
    await vi.advanceTimersByTimeAsync(100);

    let stopped = false;
    const stopping = heartbeat.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    renewal.resolve(buildLease(300));
    await stopping;
    expect(stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(renew).toHaveBeenCalledOnce();
  });
});

function buildLease(durationMs: number): LeaseConfirmation<null> {
  return {
    databaseNowMs: 0,
    details: null,
    leaseExpiresAtMs: durationMs,
  };
}

function createLeaseLostError(cause?: unknown): Error {
  return new Error("Lease was lost.", { cause });
}
