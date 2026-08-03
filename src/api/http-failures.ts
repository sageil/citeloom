export function isExpectedRequestCancellation(
  error: unknown,
  requestDisconnected: boolean,
): boolean {
  if (requestDisconnected) {
    return true;
  }
  const pending: unknown[] = [error];
  const visited = new Set<Error>();
  while (pending.length > 0 && visited.size < 16) {
    const current = pending.pop();
    if (!(current instanceof Error) || visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (
      current.name === "AbortError"
      || current.name === "RequestAbortedError"
      || current.name === "ClientClosedRequestError"
    ) {
      return true;
    }
    if (current.cause !== undefined) {
      pending.push(current.cause);
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
  }
  return false;
}

export function readHttpErrorCategory(statusCode: number): string {
  if (statusCode === 502) {
    return "dependency-bad-gateway";
  }
  if (statusCode === 503) {
    return "dependency-unavailable";
  }
  if (statusCode === 504) {
    return "dependency-timeout";
  }
  return "unexpected-internal";
}

export function normalizeHttpFailureStatus(statusCode: number): number {
  if (statusCode < 500) {
    return statusCode;
  }
  if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
    return statusCode;
  }
  return 500;
}

export function readHttpErrorCode(statusCode: number): string {
  if (statusCode === 502) {
    return "dependency_bad_gateway";
  }
  if (statusCode === 503) {
    return "dependency_unavailable";
  }
  if (statusCode === 504) {
    return "dependency_timeout";
  }
  return "internal_error";
}

export function readSafeHttpFailureMessage(statusCode: number): string {
  if (statusCode === 502) {
    return "A required dependency returned an invalid response.";
  }
  if (statusCode === 503) {
    return "A required service is unavailable.";
  }
  if (statusCode === 504) {
    return "A required service did not respond in time.";
  }
  return "The request could not be completed.";
}
