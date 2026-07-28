import { createHash, randomUUID } from "node:crypto";

import type { CiteLoomDatabase } from "../database/client.js";
import {
  applicationErrorEvents,
  doclingErrorDetails,
} from "../database/schema.js";

export const APPLICATION_ERROR_ORIGINS = [
  "http-request",
  "streaming-answer",
  "ingestion",
  "inference-provider",
  "worker",
  "scheduler",
  "background-task",
  "settings-reload",
  "database-operation",
  "startup",
  "cli",
  "docling-transport",
  "docling-task",
  "docling-conversion",
  "docling-normalization",
  "docling-element",
] as const;

export type ApplicationErrorOrigin =
  (typeof APPLICATION_ERROR_ORIGINS)[number];
export type ApplicationErrorSeverity = "warning" | "error" | "critical";
export type ApplicationErrorElementKind = "image" | "table" | "text";

export interface DoclingErrorDetailInput {
  category: string;
  componentType: string;
  doclingLabel?: string | null;
  elementKind?: ApplicationErrorElementKind | null;
  message: string;
  moduleName: string;
  pageNumber?: number | null;
  pageRangeEnd?: number | null;
  pageRangeStart?: number | null;
  sourceRef?: string | null;
}

export interface ApplicationErrorContext {
  attemptNumber?: number | null;
  category?: string;
  code?: string;
  diagnosticMessage?: string;
  documentId?: string | null;
  doclingErrors?: readonly DoclingErrorDetailInput[];
  instance?: string | null;
  jobId?: string | null;
  occurredAt?: Date;
  operation: string;
  origin: ApplicationErrorOrigin;
  release?: string | null;
  requestId?: string | null;
  requestSequence?: number | null;
  retryable?: boolean | null;
  runId?: string | null;
  service: string;
  severity?: ApplicationErrorSeverity;
  sourceFile?: string | null;
  taskId?: string | null;
  workspaceId?: string | null;
}

export interface PreparedDoclingErrorDetail {
  category: string;
  componentType: string;
  doclingLabel: string | null;
  elementKind: ApplicationErrorElementKind | null;
  message: string;
  moduleName: string;
  pageNumber: number | null;
  pageRangeEnd: number | null;
  pageRangeStart: number | null;
  sequence: number;
  sourceRef: string | null;
}

export interface PreparedApplicationErrorEvent {
  attemptNumber: number | null;
  category: string;
  code: string;
  documentId: string | null;
  doclingErrors: PreparedDoclingErrorDetail[];
  id: string;
  instance: string | null;
  jobId: string | null;
  message: string;
  occurredAt: Date;
  operation: string;
  origin: ApplicationErrorOrigin;
  release: string | null;
  requestId: string | null;
  requestSequence: number | null;
  retryable: boolean | null;
  runId: string | null;
  service: string;
  severity: ApplicationErrorSeverity;
  sourceFile: string | null;
  stackFingerprint: string | null;
  taskId: string | null;
  workspaceId: string | null;
}

export interface ReportApplicationErrorResult {
  event: PreparedApplicationErrorEvent;
  persisted: boolean;
}

type ApplicationErrorWriter = Pick<CiteLoomDatabase, "insert">;

const trackedErrorIds = new WeakMap<Error, string>();
const processOccurrenceNamespace = randomUUID();
const maximumDiagnosticCharacters = 1_000;
const maximumContextCharacters = 8_192;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export class ApplicationErrorReporter {
  public constructor(
    private readonly database: CiteLoomDatabase,
    private readonly fallbackLogger: (message: string) => void = console.error,
  ) {}

  public prepare(
    error: unknown,
    context: ApplicationErrorContext,
  ): PreparedApplicationErrorEvent {
    return prepareApplicationErrorEvent(error, context);
  }

  public async report(
    error: unknown,
    context: ApplicationErrorContext,
  ): Promise<ReportApplicationErrorResult> {
    const event = this.prepare(error, context);
    try {
      await this.database.transaction(async (transaction) => {
        await persistApplicationErrorEvent(transaction, event);
      });
      return { event, persisted: true };
    } catch (persistenceError: unknown) {
      this.fallbackLogger(formatApplicationErrorPersistenceFailure(
        event,
        persistenceError,
      ));
      return { event, persisted: false };
    }
  }
}

export function prepareApplicationErrorEvent(
  error: unknown,
  context: ApplicationErrorContext,
): PreparedApplicationErrorEvent {
  const id = ensureApplicationErrorId(error, context);
  return normalizeApplicationErrorEvent(id, error, context);
}

export function reportApplicationErrorToContainerLog(
  error: unknown,
  context: ApplicationErrorContext,
  persistenceError: unknown,
  fallbackLogger: (message: string) => void = console.error,
): PreparedApplicationErrorEvent {
  const event = prepareApplicationErrorEvent(error, context);
  fallbackLogger(formatApplicationErrorPersistenceFailure(
    event,
    persistenceError,
  ));
  return event;
}

export async function persistApplicationErrorEvent(
  database: ApplicationErrorWriter,
  event: PreparedApplicationErrorEvent,
): Promise<void> {
  await database
    .insert(applicationErrorEvents)
    .values({
      attemptNumber: event.attemptNumber,
      category: event.category,
      code: event.code,
      documentId: event.documentId,
      id: event.id,
      instance: event.instance,
      jobId: event.jobId,
      message: event.message,
      occurredAt: event.occurredAt,
      operation: event.operation,
      origin: event.origin,
      release: event.release,
      requestId: event.requestId,
      requestSequence: event.requestSequence,
      retryable: event.retryable,
      runId: event.runId,
      service: event.service,
      severity: event.severity,
      sourceFile: event.sourceFile,
      stackFingerprint: event.stackFingerprint,
      taskId: event.taskId,
      workspaceId: event.workspaceId,
    })
    .onConflictDoNothing({ target: applicationErrorEvents.id });

  if (event.doclingErrors.length === 0) {
    return;
  }
  const rows = [];
  for (const detail of event.doclingErrors) {
    rows.push({
      applicationErrorId: event.id,
      category: detail.category,
      componentType: detail.componentType,
      doclingLabel: detail.doclingLabel,
      elementKind: detail.elementKind,
      message: detail.message,
      moduleName: detail.moduleName,
      pageNumber: detail.pageNumber,
      pageRangeEnd: detail.pageRangeEnd,
      pageRangeStart: detail.pageRangeStart,
      sequence: detail.sequence,
      sourceRef: detail.sourceRef,
    });
  }
  await database
    .insert(doclingErrorDetails)
    .values(rows)
    .onConflictDoNothing({
      target: [
        doclingErrorDetails.applicationErrorId,
        doclingErrorDetails.sequence,
      ],
    });
}

export function withApplicationErrorAttempt(
  event: PreparedApplicationErrorEvent,
  attemptNumber: number,
): PreparedApplicationErrorEvent {
  return {
    ...event,
    attemptNumber: readPositiveInteger(attemptNumber, "attempt number"),
  };
}

export function readApplicationErrorId(error: unknown): string | null {
  const pending: unknown[] = [error];
  const visited = new Set<Error>();
  while (pending.length > 0 && visited.size < 16) {
    const current = pending.pop();
    if (!(current instanceof Error) || visited.has(current)) {
      continue;
    }
    visited.add(current);
    const tracked = trackedErrorIds.get(current);
    if (tracked !== undefined) {
      return tracked;
    }
    const candidate = readErrorIdProperty(current);
    if (candidate !== null) {
      return candidate;
    }
    if (current.cause !== undefined) {
      pending.push(current.cause);
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
  }
  return null;
}

export function sanitizeDiagnosticMessage(value: string): string {
  let message = replaceControlCharacters(value).trim();
  message = message.replace(
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/giu,
    "Bearer [REDACTED]",
  );
  message = message.replace(
    /\b(authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|password|secret)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
    "$1$2[REDACTED]",
  );
  message = message.replace(
    /([?&](?:api[-_]?key|access[-_]?token|token|password|secret)=)[^&\s]+/giu,
    "$1[REDACTED]",
  );
  message = message.replace(
    /(https?:\/\/)[^:/@\s]+:[^@\s]+@/giu,
    "$1[REDACTED]@",
  );
  message = message.replace(
    /\b(provider response body|response body|request body|payload|user question|prompt)\b(\s*[:=]\s*).*/giu,
    "$1$2[REDACTED]",
  );
  if (message === "") {
    return "Operational failure without diagnostic detail.";
  }
  if (message.length <= maximumDiagnosticCharacters) {
    return message;
  }
  return `${message.slice(0, maximumDiagnosticCharacters)}...`;
}

function replaceControlCharacters(value: string): string {
  const characters: string[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint !== undefined
      && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))
    ) {
      characters.push(" ");
      continue;
    }
    characters.push(character);
  }
  return characters.join("");
}

function normalizeApplicationErrorEvent(
  id: string,
  error: unknown,
  context: ApplicationErrorContext,
): PreparedApplicationErrorEvent {
  const diagnostic = context.diagnosticMessage ?? readErrorMessage(error);
  return {
    attemptNumber: readOptionalPositiveInteger(
      context.attemptNumber,
      "attempt number",
    ),
    category: readBoundedLabel(
      context.category ?? readErrorName(error),
      "unknown",
      64,
    ),
    code: readBoundedLabel(context.code ?? "operational_failure", "unknown", 64),
    documentId: readNullableContext(context.documentId, 64),
    doclingErrors: normalizeDoclingErrorDetails(context.doclingErrors ?? []),
    id,
    instance: readNullableContext(context.instance, maximumContextCharacters),
    jobId: readNullableContext(context.jobId, maximumContextCharacters),
    message: sanitizeDiagnosticMessage(diagnostic),
    occurredAt: context.occurredAt ?? new Date(),
    operation: readBoundedLabel(context.operation, "unknown", 128),
    origin: context.origin,
    release: readNullableContext(
      context.release ?? readApplicationRelease(),
      maximumContextCharacters,
    ),
    requestId: readNullableContext(context.requestId, maximumContextCharacters),
    requestSequence: readOptionalNonnegativeInteger(
      context.requestSequence,
      "request sequence",
    ),
    retryable: context.retryable ?? null,
    runId: readNullableContext(context.runId, maximumContextCharacters),
    service: readBoundedLabel(context.service, "unknown", 64),
    severity: context.severity ?? "error",
    sourceFile: readNullableContext(
      context.sourceFile,
      maximumContextCharacters,
    ),
    stackFingerprint: fingerprintErrorStack(error),
    taskId: readNullableContext(context.taskId, maximumContextCharacters),
    workspaceId: readNullableContext(
      context.workspaceId,
      maximumContextCharacters,
    ),
  };
}

function normalizeDoclingErrorDetails(
  values: readonly DoclingErrorDetailInput[],
): PreparedDoclingErrorDetail[] {
  const details: PreparedDoclingErrorDetail[] = [];
  for (let sequence = 0; sequence < values.length; sequence += 1) {
    const value = values[sequence];
    if (value === undefined) {
      continue;
    }
    const pageRangeStart = readOptionalPositiveInteger(
      value.pageRangeStart,
      "Docling page range start",
    );
    const pageRangeEnd = readOptionalPositiveInteger(
      value.pageRangeEnd,
      "Docling page range end",
    );
    if ((pageRangeStart === null) !== (pageRangeEnd === null)) {
      throw new Error("Docling page range boundaries must both be known or null.");
    }
    if (
      pageRangeStart !== null
      && pageRangeEnd !== null
      && pageRangeEnd < pageRangeStart
    ) {
      throw new Error("Docling page range ends before it starts.");
    }
    details.push({
      category: readBoundedLabel(value.category, "unknown", 64),
      componentType: readBoundedLabel(
        value.componentType,
        "unknown",
        64,
      ),
      doclingLabel: readNullableContext(
        value.doclingLabel,
        maximumContextCharacters,
      ),
      elementKind: value.elementKind ?? null,
      message: sanitizeDiagnosticMessage(value.message),
      moduleName: readNullableContext(
        value.moduleName,
        maximumContextCharacters,
      ) ?? "",
      pageNumber: readOptionalPositiveInteger(
        value.pageNumber,
        "Docling page number",
      ),
      pageRangeEnd,
      pageRangeStart,
      sequence,
      sourceRef: readNullableContext(
        value.sourceRef,
        maximumContextCharacters,
      ),
    });
  }
  return details;
}

function ensureApplicationErrorId(
  error: unknown,
  context?: ApplicationErrorContext,
): string {
  const existing = readApplicationErrorId(error);
  if (existing !== null) {
    return existing;
  }
  const occurrenceKey = context === undefined
    ? null
    : buildApplicationErrorOccurrenceKey(context);
  const id = occurrenceKey === null
    ? randomUUID()
    : createDeterministicErrorId(occurrenceKey);
  if (error instanceof Error) {
    trackedErrorIds.set(error, id);
  }
  return id;
}

function buildApplicationErrorOccurrenceKey(
  context: ApplicationErrorContext,
): string | null {
  const attemptNumber = context.attemptNumber ?? null;
  const jobId = context.jobId?.trim() ?? "";
  const taskId = context.taskId?.trim() ?? "";
  if (taskId !== "" && jobId !== "" && attemptNumber !== null) {
    return [
      context.service,
      context.origin,
      context.operation,
      jobId,
      taskId,
      String(attemptNumber),
    ].join("\u001f");
  }
  const requestId = context.requestId?.trim() ?? "";
  if (requestId !== "") {
    return [
      context.service,
      processOccurrenceNamespace,
      context.instance ?? "",
      context.origin,
      context.operation,
      requestId,
      String(context.requestSequence ?? 0),
    ].join("\u001f");
  }
  const runId = context.runId?.trim() ?? "";
  if (runId !== "") {
    return [
      context.service,
      context.origin,
      context.operation,
      runId,
    ].join("\u001f");
  }
  if (jobId !== "" && attemptNumber !== null) {
    return [
      context.service,
      context.origin,
      context.operation,
      jobId,
      String(attemptNumber),
    ].join("\u001f");
  }
  return null;
}

function createDeterministicErrorId(occurrenceKey: string): string {
  const digest = createHash("sha256").update(occurrenceKey).digest("hex");
  const versioned = `${digest.slice(0, 12)}5${digest.slice(13, 16)}`;
  const variant = ((Number.parseInt(digest[16] ?? "0", 16) & 0x3) | 0x8)
    .toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    versioned.slice(12, 16),
    `${variant}${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function readApplicationRelease(): string | null {
  const value = process.env.CITELOOM_RELEASE;
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim();
  if (normalized === "" || normalized.length > 128) {
    return null;
  }
  return normalized;
}

function readErrorIdProperty(error: Error): string | null {
  if (!("errorId" in error)) {
    return null;
  }
  const value = error.errorId;
  return typeof value === "string" && uuidPattern.test(value) ? value : null;
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "A non-Error value was thrown.";
}

function readErrorName(error: unknown): string {
  if (!(error instanceof Error)) {
    return "NonErrorThrow";
  }
  return error.name.trim() === "" ? "Error" : error.name;
}

function fingerprintErrorStack(error: unknown): string | null {
  if (!(error instanceof Error) || error.stack === undefined) {
    return null;
  }
  const lines = error.stack.split("\n");
  const frames: string[] = [readErrorName(error)];
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (line !== undefined && line !== "") {
      frames.push(line);
    }
  }
  if (frames.length === 1) {
    return null;
  }
  return createHash("sha256").update(frames.join("\n")).digest("hex");
}

function formatApplicationErrorPersistenceFailure(
  event: PreparedApplicationErrorEvent,
  error: unknown,
): string {
  return JSON.stringify({
    error: {
      category: "database-operation",
      code: "application_error_persistence_failed",
      diagnosticMessage: event.message,
      eventId: event.id,
      message: sanitizeDiagnosticMessage(readErrorMessage(error)),
      operation: event.operation,
      origin: event.origin,
      service: event.service,
    },
    level: "error",
  });
}

function readBoundedLabel(
  value: string,
  fallback: string,
  maximumLength: number,
): string {
  const normalized = value.trim();
  if (normalized === "") {
    return fallback;
  }
  return normalized.slice(0, maximumLength);
}

function readNullableContext(
  value: string | null | undefined,
  maximumLength: number,
): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = value.trim();
  return normalized === "" ? null : normalized.slice(0, maximumLength);
}

function readOptionalPositiveInteger(
  value: number | null | undefined,
  name: string,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return readPositiveInteger(value, name);
}

function readOptionalNonnegativeInteger(
  value: number | null | undefined,
  name: string,
): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a nonnegative safe integer.`);
  }
  return value;
}

function readPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return value;
}
