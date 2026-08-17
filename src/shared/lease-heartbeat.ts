export interface LeaseConfirmation<TDetails> {
  databaseNowMs: number;
  details: TDetails;
  leaseExpiresAtMs: number;
}

export interface LeaseHeartbeat {
  loseLease: (cause?: unknown) => void;
  signal: AbortSignal;
  stop: () => Promise<void>;
}

interface LeaseHeartbeatOptions<TDetails> {
  confirmedLease: LeaseConfirmation<TDetails> | null;
  createLeaseLostError: (cause?: unknown) => Error;
  onLeaseConfirmed?: (details: TDetails) => void;
  onRenewalError?: (error: unknown, initial: boolean) => void;
  renew: () => Promise<LeaseConfirmation<TDetails> | null>;
}

export async function startLeaseHeartbeat<TDetails>(
  options: LeaseHeartbeatOptions<TDetails>,
): Promise<LeaseHeartbeat> {
  const leaseController = new AbortController();
  let stopped = false;
  let renewal: Promise<void> | null = null;
  let renewalTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let confirmedDeadline = 0;

  const clearLeaseTimers = (): void => {
    if (renewalTimer !== null) {
      clearTimeout(renewalTimer);
      renewalTimer = null;
    }
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
      deadlineTimer = null;
    }
  };
  const loseLease = (cause?: unknown): void => {
    if (leaseController.signal.aborted) {
      return;
    }
    clearLeaseTimers();
    leaseController.abort(options.createLeaseLostError(cause));
  };
  const scheduleRenewal = (delayMs: number): void => {
    if (stopped || leaseController.signal.aborted) {
      return;
    }
    renewalTimer = setTimeout(() => {
      renewalTimer = null;
      renewal = renew(false).finally(() => {
        renewal = null;
      });
    }, Math.max(1, Math.floor(delayMs)));
    renewalTimer.unref();
  };
  const scheduleConfirmedLease = (
    lease: LeaseConfirmation<TDetails>,
  ): void => {
    if (stopped) {
      return;
    }
    const remainingMs = lease.leaseExpiresAtMs - lease.databaseNowMs;
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
      loseLease();
      return;
    }
    confirmedDeadline = performance.now() + remainingMs;
    if (deadlineTimer !== null) {
      clearTimeout(deadlineTimer);
    }
    deadlineTimer = setTimeout(() => {
      deadlineTimer = null;
      loseLease();
    }, remainingMs);
    deadlineTimer.unref();
    scheduleRenewal(remainingMs / 3);
  };
  const renew = async (initial: boolean): Promise<void> => {
    try {
      const lease = await options.renew();
      if (lease === null) {
        loseLease();
        return;
      }
      scheduleConfirmedLease(lease);
      options.onLeaseConfirmed?.(lease.details);
    } catch (error: unknown) {
      options.onRenewalError?.(error, initial);
      if (initial) {
        loseLease(error);
        return;
      }
      const remainingMs = confirmedDeadline - performance.now();
      if (remainingMs <= 0) {
        loseLease(error);
        return;
      }
      scheduleRenewal(Math.min(1_000, remainingMs / 6));
    }
  };

  if (options.confirmedLease === null) {
    await renew(true);
  } else {
    scheduleConfirmedLease(options.confirmedLease);
    options.onLeaseConfirmed?.(options.confirmedLease.details);
  }

  return {
    loseLease,
    signal: leaseController.signal,
    stop: async (): Promise<void> => {
      stopped = true;
      clearLeaseTimers();
      if (renewal !== null) {
        await renewal;
      }
    },
  };
}
