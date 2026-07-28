const attemptWindowMs = 15 * 60 * 1_000;
const maximumAttemptsPerWindow = 5;
const maximumTrackedBuckets = 10_000;

interface AttemptBucket {
  attempts: number;
  windowStartedAt: number;
}

export class LoginRateLimitExceededError extends Error {
  public constructor() {
    super("Too many login attempts. Try again later.");
    this.name = "LoginRateLimitExceededError";
  }
}

export class LoginRateLimiter {
  private readonly buckets = new Map<string, AttemptBucket>();

  public constructor(private readonly now: () => number = () => Date.now()) {}

  public check(sourceAddress: string, usernameNormalized: string): void {
    const now = this.now();
    this.deleteExpiredBuckets(now);
    const keys = buildBucketKeys(sourceAddress, usernameNormalized);
    for (const key of keys) {
      const bucket = this.buckets.get(key);
      if (
        bucket !== undefined
        && bucket.attempts >= maximumAttemptsPerWindow
      ) {
        throw new LoginRateLimitExceededError();
      }
    }
  }

  public recordFailure(sourceAddress: string, usernameNormalized: string): void {
    const now = this.now();
    const keys = buildBucketKeys(sourceAddress, usernameNormalized);
    for (const key of keys) {
      const current = this.buckets.get(key);
      if (current === undefined || isExpired(current, now)) {
        this.buckets.set(key, { attempts: 1, windowStartedAt: now });
        continue;
      }
      current.attempts += 1;
    }
    this.enforceMaximumSize();
  }

  public recordSuccess(usernameNormalized: string): void {
    this.buckets.delete(`username:${usernameNormalized}`);
  }

  private deleteExpiredBuckets(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (isExpired(bucket, now)) {
        this.buckets.delete(key);
      }
    }
  }

  private enforceMaximumSize(): void {
    while (this.buckets.size > maximumTrackedBuckets) {
      const oldestKey = this.buckets.keys().next().value;
      if (typeof oldestKey !== "string") {
        return;
      }
      this.buckets.delete(oldestKey);
    }
  }
}

function buildBucketKeys(
  sourceAddress: string,
  usernameNormalized: string,
): [string, string] {
  return [`source:${sourceAddress}`, `username:${usernameNormalized}`];
}

function isExpired(bucket: AttemptBucket, now: number): boolean {
  return now - bucket.windowStartedAt >= attemptWindowMs;
}
