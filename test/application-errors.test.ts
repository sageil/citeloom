import { describe, expect, it } from "vitest";

import {
  ApplicationErrorReporter,
  type ApplicationErrorTransactionRunner,
  prepareApplicationErrorEvent,
  readApplicationErrorId,
  sanitizeDiagnosticMessage,
} from "../src/observability/application-errors.js";
import {
  readApplicationErrorArea,
} from "../src/observability/application-error-store.js";

describe("application error reporting", () => {
  it("classifies operational origins into report areas", () => {
    expect(readApplicationErrorArea("ingestion")).toBe("ingestion");
    expect(readApplicationErrorArea("docling-element")).toBe("ingestion");
    expect(readApplicationErrorArea("http-request")).toBe("application");
    expect(readApplicationErrorArea("inference-provider")).toBe("application");
    expect(readApplicationErrorArea("worker")).toBe("general");
    expect(readApplicationErrorArea("database-operation")).toBe("general");
  });

  it("creates a stable occurrence ID while keeping retry attempts distinct", () => {
    const first = prepareApplicationErrorEvent(new Error("failure"), {
      attemptNumber: 1,
      jobId: "job-1",
      operation: "convert-document",
      origin: "docling-task",
      service: "worker",
      taskId: "task-1",
    });
    const duplicate = prepareApplicationErrorEvent(new Error("failure again"), {
      attemptNumber: 1,
      jobId: "job-1",
      operation: "convert-document",
      origin: "docling-task",
      service: "worker",
      taskId: "task-1",
    });
    const retry = prepareApplicationErrorEvent(new Error("failure"), {
      attemptNumber: 2,
      jobId: "job-1",
      operation: "convert-document",
      origin: "docling-task",
      service: "worker",
      taskId: "task-1",
    });

    expect(duplicate.id).toBe(first.id);
    expect(retry.id).not.toBe(first.id);
  });

  it("reuses an error ID through cause and aggregate wrappers", () => {
    const failure = new Error("failure");
    const event = prepareApplicationErrorEvent(failure, {
      operation: "background-task",
      origin: "background-task",
      service: "worker",
    });
    const aggregate = new AggregateError([
      new Error("secondary failure"),
      new Error("wrapper", { cause: failure }),
    ]);

    expect(readApplicationErrorId(aggregate)).toBe(event.id);
  });

  it("redacts credentials, request content, and provider bodies", () => {
    const message = [
      "Authorization: Bearer abc.def",
      "api_key=top-secret",
      "password=hunter2",
      "request body: private document content",
      "provider response body: unredacted provider detail",
    ].join(", ");

    const sanitized = sanitizeDiagnosticMessage(message);

    expect(sanitized).not.toContain("abc.def");
    expect(sanitized).not.toContain("top-secret");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).not.toContain("private document content");
    expect(sanitized).not.toContain("unredacted provider detail");
    expect(sanitized).toContain("[REDACTED]");
  });

  it("normalizes every Docling error detail before persistence", () => {
    const event = prepareApplicationErrorEvent(new Error("conversion failed"), {
      attemptNumber: 1,
      doclingErrors: [
        {
          category: "backend_failure",
          componentType: "document_backend",
          message: "page decode failed",
          moduleName: "pdf_backend",
          pageNumber: 17,
        },
        {
          category: "inference_failure",
          componentType: "model",
          doclingLabel: "table",
          elementKind: "table",
          message: "table model failed",
          moduleName: "table_structure",
          pageRangeEnd: 24,
          pageRangeStart: 18,
          sourceRef: "#/tables/4",
        },
      ],
      jobId: "job-1",
      operation: "convert-document",
      origin: "docling-conversion",
      service: "worker",
      sourceFile: "/documents/report.pdf",
    });

    expect(event.doclingErrors).toEqual([
      expect.objectContaining({
        pageNumber: 17,
        pageRangeEnd: null,
        pageRangeStart: null,
        sequence: 0,
      }),
      expect.objectContaining({
        doclingLabel: "table",
        elementKind: "table",
        pageNumber: null,
        pageRangeEnd: 24,
        pageRangeStart: 18,
        sequence: 1,
        sourceRef: "#/tables/4",
      }),
    ]);
  });

  it("logs one sanitized database fallback without recursing", async () => {
    const messages: string[] = [];
    const database = buildFailingApplicationErrorDatabase(
      new Error("password=database-secret"),
    );
    const reporter = new ApplicationErrorReporter(
      database,
      (message) => messages.push(message),
    );

    const result = await reporter.report(
      new Error("provider response body: private response"),
      {
        operation: "stream-answer",
        origin: "streaming-answer",
        requestId: "request-1",
        service: "web",
      },
    );

    expect(result.persisted).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(result.event.id);
    expect(messages[0]).not.toContain("database-secret");
    expect(messages[0]).not.toContain("private response");
  });
});

function buildFailingApplicationErrorDatabase(
  error: Error,
): ApplicationErrorTransactionRunner {
  return {
    transaction: async <Result>(): Promise<Result> => {
      throw error;
    },
  };
}
