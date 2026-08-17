import { setTimeout as delay } from "node:timers/promises";
import type { Readable } from "node:stream";

import { z } from "zod";
import {
  Agent,
  fetch as undiciFetch,
  Headers,
  WebSocket,
} from "undici";

import type { DoclingConfig } from "../../config/index.js";
import type {
  DoclingConversionError,
  DoclingConversionResult,
  DoclingErrorDetail,
} from "../protocol/model.js";
import type { DoclingRequestObserver } from "./observer.js";
import type {
  DoclingTaskControl,
  DoclingTaskReference,
} from "./task.js";
import {
  decodeDoclingCapabilities,
  type DoclingCapabilityIdentity,
} from "./capabilities.js";
import {
  DoclingConversionResponseError,
  decodeDoclingVersion,
  type DoclingVersionIdentity,
} from "../protocol/index.js";

const TRANSPORT_TIMEOUT_GRACE_MS = 30_000;
const SERVICE_PROBE_TIMEOUT_MS = 10_000;
const TASK_TERMINATION_TIMEOUT_MS = 10_000;
const WEBSOCKET_HEARTBEAT_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 5_000;

type DoclingTaskStatus = z.output<typeof taskStatusResponseSchema>;

const readyResponseSchema = z.object({ status: z.literal("ok") });
const taskStatusResponseSchema = z.object({
  error_message: z.string().nullable().default(null),
  failure: z.object({
    category: z.string().min(1),
    details: z.record(z.string(), z.string()).default({}),
    message: z.string().min(1),
    phase: z.string().min(1),
    retryable: z.boolean(),
  }).nullable().default(null),
  task_id: z.string().min(1),
  task_status: z.enum([
    "pending",
    "started",
    "failure",
    "success",
    "partial_success",
    "skipped",
  ]),
  task_type: z.literal("convert"),
}).loose();
const rangeConversionFailureSchema = z.object({
  end_page: z.number().int().positive(),
  errors: z.array(z.object({
    category: z.string().min(1),
    component_type: z.string().min(1),
    docling_label: z.string().min(1).nullable().default(null),
    element_kind: z.enum(["image", "table", "text"]).nullable().default(null),
    error_message: z.string().min(1),
    module_name: z.string(),
    page_no: z.number().int().positive().nullable().default(null),
    source_ref: z.string().min(1).nullable().default(null),
  })).min(1),
  page_number_basis: z.enum(["absolute", "relative"]),
  start_page: z.number().int().positive(),
  status: z.enum(["failure", "partial_success", "success"]),
});
const terminateTaskResponseSchema = z.object({
  state: z.literal("terminated"),
  task_id: z.uuid(),
});
const pauseTaskResponseSchema = z.object({
  state: z.enum(["paused", "terminated"]),
  task_id: z.uuid(),
});
const contentUploadResponseSchema = z.object({
  byte_length: z.number().int().positive(),
  document_id: z.string().regex(/^[0-9a-f]{64}$/u),
  task_id: z.uuid(),
});
const websocketMessageSchema = z.object({
  error: z.string().nullable().default(null),
  message: z.enum(["connection", "update", "error"]),
  task: taskStatusResponseSchema.nullable().default(null),
}).loose().superRefine((message, context) => {
  if (message.message === "error" && message.error === null) {
    context.addIssue({
      code: "custom",
      message: "error message has no detail",
      path: ["error"],
    });
  }
  if (message.message !== "error" && message.task === null) {
    context.addIssue({
      code: "custom",
      message: "status message has no task",
      path: ["task"],
    });
  }
});

export interface DoclingConvertRequest {
  abortSignal: AbortSignal;
  apiKey: string | null;
  baseUrl: string;
  body: string;
  content: {
    byteLength: number;
    documentId: string;
    open: (abortSignal?: AbortSignal) => Promise<Readable>;
  };
  decodeResponse: (value: unknown) => DoclingConversionResult;
  observer: DoclingRequestObserver;
  recoveryMode: DoclingTaskRecoveryMode;
  requestTimeoutMs: number;
  resumedTask: boolean;
  task: DoclingTaskReference;
  taskControl: DoclingTaskControl;
  url: string;
}

export type DoclingTaskRecoveryMode = "restart-task" | "resume-ranges";

export type DoclingConvertRequester = (
  request: DoclingConvertRequest,
) => Promise<DoclingConversionResult>;

export interface DoclingHttpRequest {
  abortSignal: AbortSignal;
  apiKey: string | null;
  body: Readable | string | null;
  contentLength?: number;
  contentType?: "application/json" | "application/octet-stream";
  method: "GET" | "POST" | "PUT";
  timeoutMs: number;
  url: string;
}

export type DoclingHttpRequester = (
  request: DoclingHttpRequest,
) => Promise<unknown>;

export interface DoclingTaskTerminationRequest {
  apiKey: string | null;
  baseUrl: string;
  requestTimeoutMs: number;
  taskId: string;
}

export interface DoclingTaskPauseResult {
  kind: "paused" | "terminated";
}

export interface DoclingJsonRequest {
  apiKey: string | null;
  timeoutMs: number;
  url: string;
}

export type DoclingJsonRequester = (
  request: DoclingJsonRequest,
) => Promise<unknown>;

export type DoclingWebSocketReceiveResult =
  | { kind: "closed"; reason: string }
  | { kind: "message"; value: unknown }
  | { kind: "timeout" };

export interface DoclingWebSocketConnection {
  close(): void;
  receive(
    abortSignal: AbortSignal,
    timeoutMs: number,
  ): Promise<DoclingWebSocketReceiveResult>;
  send(message: string): void;
}

export interface DoclingWebSocketConnectRequest {
  abortSignal: AbortSignal;
  apiKey: string | null;
  taskId: string;
  timeoutMs: number;
  url: string;
}

export type DoclingWebSocketConnector = (
  request: DoclingWebSocketConnectRequest,
) => Promise<DoclingWebSocketConnection>;

export type DoclingReconnectWaiter = (
  task: DoclingTaskReference,
  attempt: number,
  abortSignal: AbortSignal,
) => Promise<void>;

export type DoclingSubmissionPreparer = (
  request: DoclingConvertRequest,
  requester: DoclingHttpRequester,
  timeoutMs: number,
) => Promise<void>;

export async function verifyDoclingService(
  config: DoclingConfig,
  requester: DoclingJsonRequester = sendDoclingJsonRequest,
): Promise<DoclingVersionIdentity> {
  await checkDoclingServiceAvailability(config, requester);
  const identity = await readDoclingServiceIdentity(config, requester);
  await readDoclingServiceCapabilities(config, requester);
  return identity;
}

export async function checkDoclingServiceAvailability(
  config: DoclingConfig,
  requester: DoclingJsonRequester = sendDoclingJsonRequest,
): Promise<void> {
  const readyValue = await requester({
    apiKey: config.apiKey,
    timeoutMs: SERVICE_PROBE_TIMEOUT_MS,
    url: `${config.baseUrl}/ready`,
  });
  const ready = readyResponseSchema.safeParse(readyValue);
  if (!ready.success) {
    throw new Error("Docling readiness endpoint returned an invalid response.");
  }
}

export async function readDoclingServiceIdentity(
  config: DoclingConfig,
  requester: DoclingJsonRequester = sendDoclingJsonRequest,
): Promise<DoclingVersionIdentity> {
  const versionValue = await requester({
    apiKey: config.apiKey,
    timeoutMs: SERVICE_PROBE_TIMEOUT_MS,
    url: `${config.baseUrl}/version`,
  });
  return decodeDoclingVersion(versionValue);
}

export async function readDoclingServiceCapabilities(
  config: DoclingConfig,
  requester: DoclingJsonRequester = sendDoclingJsonRequest,
): Promise<DoclingCapabilityIdentity> {
  const capabilitiesValue = await requester({
    apiKey: config.apiKey,
    timeoutMs: SERVICE_PROBE_TIMEOUT_MS,
    url: `${config.baseUrl}/openapi.json`,
  });
  return decodeDoclingCapabilities(capabilitiesValue);
}

export async function sendDoclingConvertRequest(
  request: DoclingConvertRequest,
): Promise<DoclingConversionResult> {
  const transportTimeoutMs = request.requestTimeoutMs
    + TRANSPORT_TIMEOUT_GRACE_MS;
  const dispatcher = new Agent({
    bodyTimeout: transportTimeoutMs,
    headersTimeout: transportTimeoutMs,
  });
  try {
    const requester: DoclingHttpRequester = async (httpRequest) => {
      return sendDoclingHttpRequest(httpRequest, dispatcher);
    };
    return await completeDoclingAsyncConversion(
      request,
      requester,
      connectDoclingWebSocket,
      waitForReconnect,
      uploadDoclingContent,
    );
  } catch (error: unknown) {
    throw new Error(
      `Docling conversion request failed: ${readRequestErrorMessage(error)}`,
      { cause: error },
    );
  } finally {
    await dispatcher.close();
  }
}

export async function completeDoclingAsyncConversion(
  request: DoclingConvertRequest,
  requester: DoclingHttpRequester,
  connector: DoclingWebSocketConnector = connectDoclingWebSocket,
  reconnectWaiter: DoclingReconnectWaiter = waitForReconnect,
  prepareSubmission: DoclingSubmissionPreparer = noOpSubmissionPreparer,
): Promise<DoclingConversionResult> {
  const invocationStartedAtMs = Date.now();
  const requestId = request.observer.identity.id;
  const requestSequence = request.observer.identity.sequence;
  const task = request.task;
  let shouldSubmit = !request.resumedTask
    || request.recoveryMode === "resume-ranges";
  let recoveredMissingTask = false;
  while (true) {
    let taskDeadlineAtMs: number | null = readTaskDeadline(task);
    let responseRejected = false;
    try {
      let status: DoclingTaskStatus;
      if (shouldSubmit) {
        const submittedAtMs = Date.parse(task.submittedAt);
        await prepareSubmission(
          request,
          requester,
          readRequestTimeout(taskDeadlineAtMs, request.requestTimeoutMs),
        );
        const submittedValue = await requester({
          abortSignal: request.abortSignal,
          apiKey: request.apiKey,
          body: request.body,
          method: "POST",
          timeoutMs: readRequestTimeout(
            taskDeadlineAtMs,
            request.requestTimeoutMs,
          ),
          url: request.url,
        });
        const acceptedAtMs = Date.now();
        status = decodeTaskStatus(submittedValue);
        shouldSubmit = false;
        if (request.resumedTask) {
          await request.observer.observe({
            at: new Date(acceptedAtMs),
            kind: "resumed",
            task,
          });
        } else {
          await request.observer.observe({
            at: new Date(acceptedAtMs),
            kind: "submitted",
            task,
            uploadMs: acceptedAtMs - submittedAtMs,
          });
        }
      } else {
        await request.observer.observe({
          at: new Date(),
          kind: "resumed",
          task,
        });
        status = await reconcileTaskStatus(request, requester, task);
      }

      let previousStatus: DoclingTaskStatus["task_status"] | null = null;
      previousStatus = validateTaskStatus(task, previousStatus, status);
      await observeStarted(request.observer, status);
      if (isActiveStatus(status.task_status)) {
        status = await watchTaskStatus(
          request,
          requester,
          connector,
          task,
          status,
          previousStatus,
          reconnectWaiter,
        );
      }
      if (status.task_status !== "success") {
        const detail = status.error_message
          ?? `task ended with ${status.task_status}`;
        const failure = decodeDoclingTaskFailure(status.failure);
        throw new DoclingTaskTerminalError(
          `Docling conversion ${status.task_id} failed: ${detail}.`,
          {
            category: failure?.category ?? "unknown",
            conversionErrors: failure?.conversionErrors ?? [],
            requestId,
            requestSequence,
            retryable: failure?.retryable ?? null,
            taskId: status.task_id,
          },
        );
      }

      const resultStartedAtMs = Date.now();
      taskDeadlineAtMs = readTaskDeadline(task);
      const responseBody = await requester({
        abortSignal: request.abortSignal,
        apiKey: request.apiKey,
        body: null,
        method: "GET",
        timeoutMs: readRequestTimeout(
          taskDeadlineAtMs,
          request.requestTimeoutMs,
        ),
        url: `${request.baseUrl}/v1/result/${encodeURIComponent(task.id)}`,
      });
      let result: DoclingConversionResult;
      try {
        result = request.decodeResponse(responseBody);
      } catch (error: unknown) {
        responseRejected = true;
        if (error instanceof DoclingConversionResponseError) {
          throw new DoclingTaskResultError(
            error.message,
            {
              conversionErrors: addDoclingErrorRange(
                error.conversionErrors,
                null,
                null,
              ),
              requestId,
              requestSequence,
              taskId: task.id,
            },
            error,
          );
        }
        throw error;
      }
      const completedAtMs = Date.now();
      const submittedAtMs = Date.parse(task.submittedAt);
      await request.observer.observe({
        at: new Date(completedAtMs),
        kind: "transport-succeeded",
        resultRetrievalMs: completedAtMs - resultStartedAtMs,
        taskWaitMs: Math.max(0, resultStartedAtMs - submittedAtMs),
        totalMs: completedAtMs - invocationStartedAtMs,
      });
      return result;
    } catch (error: unknown) {
      const failure = normalizeTaskDeadlineFailure(
        error,
        request.abortSignal,
        taskDeadlineAtMs,
      );
      let taskCleared = false;
      if (
        failure instanceof DoclingTaskDeadlineError
        || responseRejected
      ) {
        try {
          await terminateDoclingTask({
            apiKey: request.apiKey,
            baseUrl: request.baseUrl,
            requestTimeoutMs: request.requestTimeoutMs,
            taskId: task.id,
          }, requester);
          await clearTask(request.taskControl, task.id);
          taskCleared = true;
        } catch (terminationError: unknown) {
          const reason = responseRejected
            ? ` returned an invalid result and could not be discarded: ${readRequestErrorMessage(failure)}`
            : " termination was not acknowledged";
          const terminationFailure = new DoclingTaskTerminationError(
            `Docling task ${task.id}${reason}.`,
            new AggregateError(
              [failure, terminationError],
              "Docling task termination failed.",
            ),
          );
          await request.observer.observe({
            at: new Date(),
            kind: "transport-failed",
            outcome: "transport-error",
            totalMs: Date.now() - invocationStartedAtMs,
          });
          throw terminationFailure;
        }
      }
      if (
        failure instanceof DoclingTaskNotFoundError
        && !recoveredMissingTask
        && !request.abortSignal.aborted
        && request.recoveryMode === "resume-ranges"
      ) {
        recoveredMissingTask = true;
        shouldSubmit = true;
        continue;
      }
      if (
        !taskCleared
        && shouldClearTask(
          failure,
          request.recoveryMode,
        )
      ) {
        await clearTask(request.taskControl, task.id);
      }
      await request.observer.observe({
        at: new Date(),
        kind: "transport-failed",
        outcome: responseRejected
          ? "service-error"
          : classifyRequestFailure(failure, request.abortSignal),
        totalMs: Date.now() - invocationStartedAtMs,
      });
      throw failure;
    }
  }
}

async function noOpSubmissionPreparer(): Promise<void> {}

export async function uploadDoclingContent(
  request: DoclingConvertRequest,
  requester: DoclingHttpRequester,
  timeoutMs: number,
): Promise<void> {
  const body = await request.content.open(request.abortSignal);
  const value = await requester({
    abortSignal: request.abortSignal,
    apiKey: request.apiKey,
    body,
    contentLength: request.content.byteLength,
    contentType: "application/octet-stream",
    method: "PUT",
    timeoutMs,
    url: `${request.baseUrl}/v1/tasks/${encodeURIComponent(request.task.id)}/content/${request.content.documentId}`,
  });
  const result = contentUploadResponseSchema.safeParse(value);
  if (!result.success) {
    throw new DoclingTaskProtocolError(
      `Docling content upload response is invalid: ${result.error.message}`,
    );
  }
  if (
    result.data.task_id !== request.task.id
    || result.data.document_id !== request.content.documentId
    || result.data.byte_length !== request.content.byteLength
  ) {
    throw new DoclingTaskProtocolError(
      `Docling content upload acknowledgement does not match task ${request.task.id}.`,
    );
  }
}

export class DoclingTaskDeadlineError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "DoclingTaskDeadlineError";
  }
}

export class DoclingTaskNotFoundError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DoclingTaskNotFoundError";
  }
}

export class DoclingTaskTerminationError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "DoclingTaskTerminationError";
  }
}

export class DoclingTaskProtocolError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DoclingTaskProtocolError";
  }
}

export class DoclingTaskTerminalError extends Error {
  public readonly category: string;
  public readonly conversionErrors: DoclingErrorDetail[];
  public readonly requestId: string | null;
  public readonly requestSequence: number | null;
  public readonly retryable: boolean | null;
  public readonly taskId: string | null;

  public constructor(
    message: string,
    context: {
      category: string;
      conversionErrors: DoclingErrorDetail[];
      requestId: string;
      requestSequence: number;
      retryable: boolean | null;
      taskId: string;
    } | null = null,
  ) {
    super(message);
    this.name = "DoclingTaskTerminalError";
    this.category = context?.category ?? "unknown";
    this.conversionErrors = context?.conversionErrors ?? [];
    this.requestId = context?.requestId ?? null;
    this.requestSequence = context?.requestSequence ?? null;
    this.retryable = context?.retryable ?? null;
    this.taskId = context?.taskId ?? null;
  }
}

export class DoclingTaskResultError extends Error {
  public readonly conversionErrors: DoclingErrorDetail[];
  public readonly requestId: string;
  public readonly requestSequence: number;
  public readonly taskId: string;

  public constructor(
    message: string,
    context: {
      conversionErrors: DoclingErrorDetail[];
      requestId: string;
      requestSequence: number;
      taskId: string;
    },
    cause: unknown,
  ) {
    super(message, { cause });
    this.name = "DoclingTaskResultError";
    this.conversionErrors = context.conversionErrors;
    this.requestId = context.requestId;
    this.requestSequence = context.requestSequence;
    this.taskId = context.taskId;
  }
}

interface DecodedDoclingTaskFailure {
  category: string;
  conversionErrors: DoclingErrorDetail[];
  retryable: boolean;
}

function decodeDoclingTaskFailure(
  failure: DoclingTaskStatus["failure"],
): DecodedDoclingTaskFailure | null {
  if (failure === null) {
    return null;
  }
  const serialized = failure.details.citeloom_conversion_failure;
  if (serialized === undefined) {
    return {
      category: failure.category,
      conversionErrors: [],
      retryable: failure.retryable,
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error: unknown) {
    throw new DoclingTaskProtocolError(
      "Docling task failure contained unreadable structured conversion errors.",
      { cause: error },
    );
  }
  const result = rangeConversionFailureSchema.safeParse(value);
  if (!result.success) {
    throw new DoclingTaskProtocolError(
      "Docling task failure contained invalid structured conversion errors.",
      { cause: result.error },
    );
  }
  const conversionErrors: DoclingErrorDetail[] = [];
  for (const error of result.data.errors) {
    const pageNumber = normalizeDoclingPageNumber({
      basis: result.data.page_number_basis,
      pageNumber: error.page_no,
      pageRangeEnd: result.data.end_page,
      pageRangeStart: result.data.start_page,
    });
    conversionErrors.push({
      category: error.category,
      componentType: error.component_type,
      doclingLabel: error.docling_label,
      elementKind: error.element_kind,
      message: error.error_message,
      moduleName: error.module_name,
      pageNumber,
      pageRangeEnd: result.data.end_page,
      pageRangeStart: result.data.start_page,
      sourceRef: error.source_ref,
    });
  }
  return {
    category: failure.category,
    conversionErrors,
    retryable: failure.retryable,
  };
}

function addDoclingErrorRange(
  errors: DoclingConversionError[],
  pageRangeStart: number | null,
  pageRangeEnd: number | null,
): DoclingErrorDetail[] {
  const details: DoclingErrorDetail[] = [];
  for (const error of errors) {
    details.push({
      ...error,
      doclingLabel: null,
      elementKind: null,
      pageRangeEnd,
      pageRangeStart,
      sourceRef: null,
    });
  }
  return details;
}

export function normalizeDoclingPageNumber(input: {
  basis: "absolute" | "relative";
  pageNumber: number | null;
  pageRangeEnd: number;
  pageRangeStart: number;
}): number | null {
  if (input.pageNumber === null) {
    return null;
  }
  let absolutePageNumber = input.pageNumber;
  if (input.basis === "relative") {
    absolutePageNumber = input.pageRangeStart + input.pageNumber - 1;
  }
  if (
    absolutePageNumber < input.pageRangeStart
    || absolutePageNumber > input.pageRangeEnd
  ) {
    throw new DoclingTaskProtocolError(
      "Docling error page is outside the active page range.",
    );
  }
  return absolutePageNumber;
}

export function isDoclingTaskDeadlineFailure(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof DoclingTaskDeadlineError) {
      return true;
    }
    if (!(current instanceof Error)) {
      return false;
    }
    current = current.cause;
  }
  return false;
}

export function readDoclingErrorCategory(error: unknown): string {
  let current = error;
  let fallback = "UnknownError";
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(current instanceof Error)) {
      break;
    }
    const name = current.name.trim();
    if (name.length > 0) {
      fallback = name.slice(0, 64);
      if (name !== "Error") {
        return fallback;
      }
    }
    current = current.cause;
  }
  return fallback;
}

export async function terminateDoclingTask(
  request: DoclingTaskTerminationRequest,
  requester?: DoclingHttpRequester,
): Promise<void> {
  const boundedRequest = {
    ...request,
    requestTimeoutMs: Math.min(
      request.requestTimeoutMs,
      TASK_TERMINATION_TIMEOUT_MS,
    ),
  };
  if (requester !== undefined) {
    await requestDoclingTaskTermination(boundedRequest, requester);
    return;
  }

  const dispatcher = new Agent({
    bodyTimeout: boundedRequest.requestTimeoutMs,
    headersTimeout: boundedRequest.requestTimeoutMs,
  });
  try {
    await requestDoclingTaskTermination(boundedRequest, async (httpRequest) => {
      return sendDoclingHttpRequest(httpRequest, dispatcher);
    });
  } finally {
    await dispatcher.close();
  }
}

export async function pauseDoclingTask(
  request: DoclingTaskTerminationRequest,
  requester?: DoclingHttpRequester,
): Promise<DoclingTaskPauseResult> {
  const boundedRequest = {
    ...request,
    requestTimeoutMs: Math.min(
      request.requestTimeoutMs,
      TASK_TERMINATION_TIMEOUT_MS,
    ),
  };
  if (requester !== undefined) {
    return requestDoclingTaskPause(boundedRequest, requester);
  }

  const dispatcher = new Agent({
    bodyTimeout: boundedRequest.requestTimeoutMs,
    headersTimeout: boundedRequest.requestTimeoutMs,
  });
  try {
    return await requestDoclingTaskPause(
      boundedRequest,
      async (httpRequest) => {
        return sendDoclingHttpRequest(httpRequest, dispatcher);
      },
    );
  } finally {
    await dispatcher.close();
  }
}

async function requestDoclingTaskPause(
  request: DoclingTaskTerminationRequest,
  requester: DoclingHttpRequester,
): Promise<DoclingTaskPauseResult> {
  const value = await requester({
    abortSignal: new AbortController().signal,
    apiKey: request.apiKey,
    body: null,
    method: "POST",
    timeoutMs: request.requestTimeoutMs,
    url: `${request.baseUrl}/v1/tasks/${encodeURIComponent(request.taskId)}/pause`,
  });
  const result = pauseTaskResponseSchema.safeParse(value);
  if (!result.success) {
    throw new DoclingTaskProtocolError(
      `Docling pause response is invalid: ${result.error.message}`,
    );
  }
  if (result.data.task_id !== request.taskId) {
    throw new DoclingTaskProtocolError(
      `Docling paused task ${result.data.task_id} while tracking ${request.taskId}.`,
    );
  }
  return { kind: result.data.state };
}

async function requestDoclingTaskTermination(
  request: DoclingTaskTerminationRequest,
  requester: DoclingHttpRequester,
): Promise<void> {
  const value = await requester({
    abortSignal: new AbortController().signal,
    apiKey: request.apiKey,
    body: null,
    method: "POST",
    timeoutMs: request.requestTimeoutMs,
    url: `${request.baseUrl}/v1/tasks/${encodeURIComponent(request.taskId)}/terminate`,
  });
  const result = terminateTaskResponseSchema.safeParse(value);
  if (!result.success) {
    throw new DoclingTaskProtocolError(
      `Docling termination response is invalid: ${result.error.message}`,
    );
  }
  if (result.data.task_id !== request.taskId) {
    throw new DoclingTaskProtocolError(
      `Docling terminated task ${result.data.task_id} while tracking ${request.taskId}.`,
    );
  }
}

async function watchTaskStatus(
  request: DoclingConvertRequest,
  requester: DoclingHttpRequester,
  connector: DoclingWebSocketConnector,
  task: DoclingTaskReference,
  initialStatus: DoclingTaskStatus,
  initialPreviousStatus: DoclingTaskStatus["task_status"],
  reconnectWaiter: DoclingReconnectWaiter,
): Promise<DoclingTaskStatus> {
  let reconnectAttempt = 0;
  let status = initialStatus;
  let previousStatus = initialPreviousStatus;
  while (isActiveStatus(status.task_status)) {
    request.abortSignal.throwIfAborted();
    const deadlineAtMs = readTaskDeadline(task);
    const timeoutMs = Math.min(
      readRemainingTime(deadlineAtMs),
      request.requestTimeoutMs,
    );
    let connection: DoclingWebSocketConnection | null = null;
    try {
      connection = await connector({
        abortSignal: request.abortSignal,
        apiKey: request.apiKey,
        taskId: task.id,
        timeoutMs,
        url: createTaskWebSocketUrl(request.baseUrl, task.id, request.apiKey),
      });
      if (reconnectAttempt > 0) {
        await request.observer.observe({ at: new Date(), kind: "reconnected" });
        status = await reconcileTaskStatus(request, requester, task);
        previousStatus = validateTaskStatus(task, previousStatus, status);
        await observeStarted(request.observer, status);
        if (!isActiveStatus(status.task_status)) {
          return status;
        }
      }
      status = await receiveTaskStatuses(
        request,
        connection,
        task,
        status,
        previousStatus,
      );
      return status;
    } catch (error: unknown) {
      if (!isReconnectableWebSocketError(error, request.abortSignal)) {
        throw error;
      }
      reconnectAttempt += 1;
      if (reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
        throw new Error(
          `Docling task ${task.id} WebSocket reconnect limit was exceeded.`,
          { cause: error },
        );
      }
      await reconnectWaiter(task, reconnectAttempt, request.abortSignal);
    } finally {
      connection?.close();
    }
  }
  return status;
}

async function receiveTaskStatuses(
  request: DoclingConvertRequest,
  connection: DoclingWebSocketConnection,
  task: DoclingTaskReference,
  initialStatus: DoclingTaskStatus,
  initialPreviousStatus: DoclingTaskStatus["task_status"],
): Promise<DoclingTaskStatus> {
  let status = initialStatus;
  let previousStatus = initialPreviousStatus;
  while (isActiveStatus(status.task_status)) {
    request.abortSignal.throwIfAborted();
    const remainingMs = readRemainingTime(readTaskDeadline(task));
    const received = await connection.receive(
      request.abortSignal,
      Math.min(remainingMs, WEBSOCKET_HEARTBEAT_MS),
    );
    if (received.kind === "timeout") {
      connection.send("status");
      continue;
    }
    if (received.kind === "closed") {
      throw new DoclingWebSocketClosedError(
        `Docling task ${task.id} WebSocket closed before completion: ${received.reason}`,
      );
    }
    status = decodeWebSocketTaskStatus(received.value);
    previousStatus = validateTaskStatus(task, previousStatus, status);
    await observeStarted(request.observer, status);
  }
  return status;
}

async function reconcileTaskStatus(
  request: DoclingConvertRequest,
  requester: DoclingHttpRequester,
  task: DoclingTaskReference,
): Promise<DoclingTaskStatus> {
  const deadlineAtMs = readTaskDeadline(task);
  const statusValue = await requester({
    abortSignal: request.abortSignal,
    apiKey: request.apiKey,
    body: null,
    method: "GET",
    timeoutMs: readRequestTimeout(
      deadlineAtMs,
      request.requestTimeoutMs,
    ),
    url: `${request.baseUrl}/v1/status/poll/${encodeURIComponent(task.id)}?wait=0`,
  });
  return decodeTaskStatus(statusValue);
}

function validateTaskStatus(
  task: DoclingTaskReference,
  previous: DoclingTaskStatus["task_status"] | null,
  status: DoclingTaskStatus,
): DoclingTaskStatus["task_status"] {
  if (status.task_id !== task.id) {
    throw new DoclingTaskProtocolError(
      `Docling status returned task ${status.task_id} while tracking ${task.id}.`,
    );
  }
  if (previous === "started" && status.task_status === "pending") {
    throw new DoclingTaskProtocolError(
      `Docling task ${task.id} regressed from started to pending.`,
    );
  }
  if (previous !== null && isTerminalStatus(previous) && status.task_status !== previous) {
    throw new DoclingTaskProtocolError(
      `Docling task ${task.id} changed terminal state from ${previous} to ${status.task_status}.`,
    );
  }
  return status.task_status;
}

async function observeStarted(
  observer: DoclingRequestObserver,
  status: DoclingTaskStatus,
): Promise<void> {
  if (status.task_status === "started") {
    await observer.observe({ at: new Date(), kind: "first-started" });
  }
}

function decodeTaskStatus(value: unknown): DoclingTaskStatus {
  const result = taskStatusResponseSchema.safeParse(value);
  if (!result.success) {
    throw new DoclingTaskProtocolError(
      `Docling task status response is invalid: ${result.error.message}`,
    );
  }
  return result.data;
}

function decodeWebSocketTaskStatus(value: unknown): DoclingTaskStatus {
  const result = websocketMessageSchema.safeParse(value);
  if (!result.success) {
    throw new DoclingTaskProtocolError(
      `Docling WebSocket message is invalid: ${result.error.message}`,
    );
  }
  if (result.data.message === "error") {
    const detail = result.data.error ?? "unknown WebSocket error";
    if (detail.toLowerCase().includes("task not found")) {
      throw new DoclingTaskNotFoundError(`Docling task is unavailable: ${detail}`);
    }
    throw new DoclingTaskTerminalError(`Docling WebSocket failed: ${detail}`);
  }
  if (result.data.task === null) {
    throw new DoclingTaskProtocolError("Docling WebSocket message has no task.");
  }
  return result.data.task;
}

async function clearTask(
  control: DoclingTaskControl,
  taskId: string,
): Promise<void> {
  if (control.kind === "durable") {
    await control.clear(taskId);
  }
}

function readTaskDeadline(task: DoclingTaskReference): number {
  const deadlineAtMs = Date.parse(task.deadlineAt);
  if (!Number.isFinite(deadlineAtMs)) {
    throw new Error(`Docling task ${task.id} has an invalid deadline.`);
  }
  return deadlineAtMs;
}

function readRequestTimeout(
  deadlineAtMs: number,
  requestTimeoutMs: number,
): number {
  const remainingMs = readRemainingTime(deadlineAtMs);
  return Math.min(remainingMs, requestTimeoutMs);
}

function readRemainingTime(deadlineAtMs: number): number {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new DoclingTaskDeadlineError(
      "Docling conversion exceeded its hard deadline.",
    );
  }
  return remainingMs;
}

function isActiveStatus(status: DoclingTaskStatus["task_status"]): boolean {
  return status === "pending" || status === "started";
}

function isTerminalStatus(status: DoclingTaskStatus["task_status"]): boolean {
  return !isActiveStatus(status);
}

function shouldClearTask(
  error: unknown,
  recoveryMode: DoclingTaskRecoveryMode,
): boolean {
  return error instanceof DoclingTaskDeadlineError
    || error instanceof DoclingTaskNotFoundError
    || (
      error instanceof DoclingTaskTerminalError
      && recoveryMode === "restart-task"
    );
}

function normalizeTaskDeadlineFailure(
  error: unknown,
  abortSignal: AbortSignal,
  deadlineAtMs: number | null,
): unknown {
  if (
    abortSignal.aborted
    || deadlineAtMs === null
    || Date.now() < deadlineAtMs
    || error instanceof DoclingTaskDeadlineError
  ) {
    return error;
  }
  return new DoclingTaskDeadlineError(
    "Docling conversion exceeded its hard deadline.",
    error,
  );
}

function classifyRequestFailure(
  error: unknown,
  abortSignal: AbortSignal,
): "abort" | "service-error" | "timeout" | "transport-error" {
  if (abortSignal.aborted) {
    return "abort";
  }
  if (error instanceof DoclingTaskDeadlineError) {
    return "timeout";
  }
  if (error instanceof DoclingTaskTerminalError) {
    return "service-error";
  }
  return "transport-error";
}

function isReconnectableWebSocketError(
  error: unknown,
  abortSignal: AbortSignal,
): boolean {
  if (abortSignal.aborted || error instanceof DoclingTaskDeadlineError) {
    return false;
  }
  if (
    error instanceof DoclingTaskNotFoundError
    || error instanceof DoclingTaskProtocolError
    || error instanceof DoclingTaskTerminalError
  ) {
    return false;
  }
  return true;
}

async function waitForReconnect(
  task: DoclingTaskReference,
  attempt: number,
  abortSignal: AbortSignal,
): Promise<void> {
  const exponentialMs = Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * (2 ** (attempt - 1)),
  );
  const jitter = 0.75 + (Math.random() * 0.5);
  const delayMs = Math.max(1, Math.round(exponentialMs * jitter));
  const remainingMs = readRemainingTime(readTaskDeadline(task));
  await delay(Math.min(delayMs, remainingMs), undefined, { signal: abortSignal });
}

function createTaskWebSocketUrl(
  baseUrl: string,
  taskId: string,
  apiKey: string | null,
): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/status/ws/${encodeURIComponent(taskId)}`;
  url.search = "";
  if (apiKey !== null) {
    url.searchParams.set("api_key", apiKey);
  }
  return url.toString();
}

class DoclingWebSocketClosedError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "DoclingWebSocketClosedError";
  }
}

async function connectDoclingWebSocket(
  request: DoclingWebSocketConnectRequest,
): Promise<DoclingWebSocketConnection> {
  request.abortSignal.throwIfAborted();
  const socket = new WebSocket(request.url);
  try {
    await waitForWebSocketOpen(socket, request.abortSignal, request.timeoutMs);
  } catch (error: unknown) {
    try {
      socket.close();
    } catch {
      // The transport can reject close while the opening handshake is pending.
    }
    throw error;
  }
  return new UndiciDoclingWebSocketConnection(socket);
}

class UndiciDoclingWebSocketConnection implements DoclingWebSocketConnection {
  public constructor(private readonly socket: WebSocket) {}

  public close(): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.close(1000, "CiteLoom status watcher completed");
    }
  }

  public async receive(
    abortSignal: AbortSignal,
    timeoutMs: number,
  ): Promise<DoclingWebSocketReceiveResult> {
    abortSignal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const operation = new DoclingWebSocketReceiveOperation(
        this.socket,
        abortSignal,
        resolve,
        reject,
      );
      operation.start(timeoutMs);
    });
  }

  public send(message: string): void {
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw new DoclingWebSocketClosedError(
        "Docling WebSocket closed before a status refresh could be sent.",
      );
    }
    this.socket.send(message);
  }
}

class DoclingWebSocketReceiveOperation {
  private settled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    private readonly socket: WebSocket,
    private readonly abortSignal: AbortSignal,
    private readonly resolve: (result: DoclingWebSocketReceiveResult) => void,
    private readonly reject: (error: unknown) => void,
  ) {}

  public start(timeoutMs: number): void {
    this.timer = setTimeout(this.onTimeout, timeoutMs);
    this.abortSignal.addEventListener("abort", this.onAbort, { once: true });
    this.socket.addEventListener("message", this.onMessage, { once: true });
    this.socket.addEventListener("close", this.onClose, { once: true });
    this.socket.addEventListener("error", this.onError, { once: true });
    if (this.abortSignal.aborted) {
      this.onAbort();
    }
  }

  private readonly onMessage = (event: MessageEvent): void => {
    try {
      const value = readWebSocketMessageData(event.data);
      this.finish({ kind: "message", value });
    } catch (error: unknown) {
      this.fail(error);
    }
  };

  private readonly onClose = (event: CloseEvent): void => {
    const reason = event.reason || `code ${event.code}`;
    this.finish({ kind: "closed", reason });
  };

  private readonly onError = (): void => {
    this.fail(new Error("Docling WebSocket transport failed."));
  };

  private readonly onAbort = (): void => {
    this.fail(this.abortSignal.reason);
  };

  private readonly onTimeout = (): void => {
    this.finish({ kind: "timeout" });
  };

  private finish(result: DoclingWebSocketReceiveResult): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.cleanup();
    this.resolve(result);
  }

  private fail(error: unknown): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.cleanup();
    this.reject(error);
  }

  private cleanup(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.abortSignal.removeEventListener("abort", this.onAbort);
    this.socket.removeEventListener("message", this.onMessage);
    this.socket.removeEventListener("close", this.onClose);
    this.socket.removeEventListener("error", this.onError);
  }
}

function readWebSocketMessageData(data: unknown): unknown {
  if (typeof data !== "string") {
    throw new DoclingTaskProtocolError(
      "Docling WebSocket returned a non-text message.",
    );
  }
  try {
    return JSON.parse(data);
  } catch {
    throw new DoclingTaskProtocolError(
      "Docling WebSocket returned malformed JSON.",
    );
  }
}

async function waitForWebSocketOpen(
  socket: WebSocket,
  abortSignal: AbortSignal,
  timeoutMs: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const onOpen = (): void => finish();
    const onClose = (): void => finish(new Error(
      "Docling WebSocket closed during its handshake.",
    ));
    const onError = (): void => finish(new Error(
      "Docling WebSocket handshake failed.",
    ));
    const onAbort = (): void => finish(readAbortError(abortSignal));
    const timer = setTimeout(() => finish(new Error(
      "Docling WebSocket handshake timed out.",
    )), timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      abortSignal.removeEventListener("abort", onAbort);
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    abortSignal.addEventListener("abort", onAbort, { once: true });
    socket.addEventListener("open", onOpen, { once: true });
    socket.addEventListener("close", onClose, { once: true });
    socket.addEventListener("error", onError, { once: true });
    if (abortSignal.aborted) {
      onAbort();
    }
  });
}

async function sendDoclingHttpRequest(
  request: DoclingHttpRequest,
  dispatcher: Agent,
): Promise<unknown> {
  const headers = createDoclingHeaders(request.apiKey);
  headers.set("accept", "application/json");
  if (request.body !== null) {
    headers.set("content-type", request.contentType ?? "application/json");
  }
  if (request.contentLength !== undefined) {
    headers.set("content-length", String(request.contentLength));
  }
  const options = {
    body: request.body,
    dispatcher,
    headers,
    method: request.method,
    signal: AbortSignal.any([
      request.abortSignal,
      AbortSignal.timeout(request.timeoutMs),
    ]),
  };
  if (typeof request.body !== "string" && request.body !== null) {
    Object.assign(options, { duplex: "half" });
  }
  const response = await undiciFetch(request.url, options);
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1_000);
    if (response.status === 404 && request.method === "GET") {
      throw new DoclingTaskNotFoundError(
        `Docling task is unavailable: ${detail || request.url}`,
      );
    }
    throw new Error(`Docling request failed with HTTP ${response.status}: ${detail}`);
  }
  return response.json();
}

async function sendDoclingJsonRequest(
  request: DoclingJsonRequest,
): Promise<unknown> {
  const headers = createDoclingHeaders(request.apiKey);
  const response = await undiciFetch(request.url, {
    headers,
    signal: AbortSignal.timeout(request.timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Docling service probe failed with HTTP ${response.status}.`);
  }
  return response.json();
}

function createDoclingHeaders(apiKey: string | null): Headers {
  const headers = new Headers();
  if (apiKey !== null) {
    headers.set("x-api-key", apiKey);
  }
  return headers;
}

function readAbortError(abortSignal: AbortSignal): Error {
  return abortSignal.reason instanceof Error
    ? abortSignal.reason
    : new Error("Docling WebSocket was aborted.");
}

function readRequestErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.cause instanceof Error) {
    return `${error.message}: ${error.cause.message}`;
  }
  return error.message;
}
