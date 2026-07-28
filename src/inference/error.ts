import { APICallError, RetryError } from "ai";

const MAX_UPSTREAM_ERROR_CHARACTERS = 2_000;

export function readInferenceErrorMessage(error: unknown): string {
  const apiError = readApiCallError(error);
  if (apiError === null) {
    return error instanceof Error ? error.message : String(error);
  }

  const details: string[] = [];
  if (apiError.statusCode !== undefined) {
    details.push(`HTTP ${apiError.statusCode}`);
  }
  details.push(apiError.message);

  const endpoint = readSafeEndpoint(apiError.url);
  if (endpoint !== null) {
    details.push(`endpoint ${endpoint}`);
  }

  const upstreamMessage = readUpstreamMessage(apiError.responseBody);
  if (upstreamMessage !== null && upstreamMessage !== apiError.message) {
    details.push(`upstream: ${upstreamMessage}`);
  }

  details.push(`retryable: ${apiError.isRetryable ? "yes" : "no"}`);
  return `Inference API request failed (${details.join("; ")}).`;
}

function readApiCallError(error: unknown): APICallError | null {
  if (APICallError.isInstance(error)) {
    return error;
  }
  if (RetryError.isInstance(error) && APICallError.isInstance(error.lastError)) {
    return error.lastError;
  }
  return null;
}

function readSafeEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function readUpstreamMessage(responseBody: string | undefined): string | null {
  if (responseBody === undefined) {
    return null;
  }
  const trimmed = responseBody.trim();
  if (trimmed === "") {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    const message = readJsonErrorMessage(parsed);
    if (message !== null) {
      return truncateErrorMessage(message);
    }
  } catch {
    return truncateErrorMessage(trimmed);
  }
  return truncateErrorMessage(trimmed);
}

function readJsonErrorMessage(value: unknown): string | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const error = value.error;
  if (typeof error === "string" && error.trim() !== "") {
    return error.trim();
  }
  if (isJsonObject(error)) {
    const nestedMessage = error.message;
    if (typeof nestedMessage === "string" && nestedMessage.trim() !== "") {
      return nestedMessage.trim();
    }
  }
  const message = value.message;
  if (typeof message === "string" && message.trim() !== "") {
    return message.trim();
  }
  const detail = value.detail;
  if (typeof detail === "string" && detail.trim() !== "") {
    return detail.trim();
  }
  return null;
}

function isJsonObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateErrorMessage(value: string): string {
  const normalized = value.replaceAll(/\s+/gu, " ").trim();
  if (normalized.length <= MAX_UPSTREAM_ERROR_CHARACTERS) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_UPSTREAM_ERROR_CHARACTERS)}...`;
}
