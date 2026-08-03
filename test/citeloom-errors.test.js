import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  readApplicationErrorPage,
  readApplicationErrorPurgeResult,
  registerPage,
} from "../web/assets/scripts/citeloom-errors.js";
import {
  CONFIRMATION_REQUEST_EVENT,
  dispatchConfirmationResponse,
} from "../web/assets/scripts/citeloom-confirmation.js";

describe("CiteLoom error reports", () => {
  it("decodes sanitized parent errors and every structured Docling detail", () => {
    const page = readApplicationErrorPage(buildErrorPage());

    expect(page.counts).toEqual({
      all: 3,
      application: 1,
      general: 1,
      ingestion: 1,
    });
    expect(page.errors).toHaveLength(1);
    expect(page.errors[0]).toMatchObject({
      area: "ingestion",
      occurredAt: "2026-07-27T10:15:30.000Z",
      origin: "docling-conversion",
    });
    expect(page.errors[0].doclingErrors).toEqual([
      expect.objectContaining({
        pageNumber: 17,
        pageRangeEnd: null,
        pageRangeStart: null,
      }),
      expect.objectContaining({
        doclingLabel: "table",
        elementKind: "table",
        pageNumber: null,
        pageRangeEnd: 24,
        pageRangeStart: 18,
      }),
    ]);
  });

  it("rejects malformed error report responses at the browser boundary", () => {
    const invalidTimestamp = buildErrorPage();
    invalidTimestamp.errors[0].occurredAt = "not-a-time";
    expect(() => readApplicationErrorPage(invalidTimestamp)).toThrow(
      "application error time",
    );

    const invalidArea = buildErrorPage();
    invalidArea.errors[0].area = "private";
    expect(() => readApplicationErrorPage(invalidArea)).toThrow(
      "application error area",
    );
  });

  it("decodes purge results at the browser boundary", () => {
    expect(readApplicationErrorPurgeResult({ deleted: 3 })).toEqual({
      deleted: 3,
    });
    expect(() => readApplicationErrorPurgeResult({ deleted: -1 })).toThrow(
      "purged application error count",
    );
  });

  it("confirms and purges visible error logs before refreshing", async () => {
    const originalFetch = globalThis.fetch;
    const originalWindow = globalThis.window;
    const browserWindow = new EventTarget();
    const requests = [];
    let confirmation = null;
    globalThis.window = browserWindow;
    globalThis.fetch = async (url, options = {}) => {
      requests.push({ method: options.method ?? "GET", url: String(url) });
      if (options.method === "DELETE") {
        return Response.json({ deleted: 3 });
      }
      const page = buildErrorPage();
      page.counts = { all: 0, application: 0, general: 0, ingestion: 0 };
      page.errors = [];
      page.pageCount = 0;
      page.total = 0;
      return Response.json(page);
    };
    browserWindow.addEventListener(CONFIRMATION_REQUEST_EVENT, (event) => {
      confirmation = event.detail;
      dispatchConfirmationResponse(event.detail.requestId, true);
    });
    let pageFactory = null;
    registerPage({
      data(name, factory) {
        expect(name).toBe("citeloomErrorsPage");
        pageFactory = factory;
      },
    });

    try {
      const page = pageFactory();
      page.errorPage = readApplicationErrorPage(buildErrorPage());
      page.hasLoaded = true;
      await page.purgeErrors();

      expect(confirmation).toMatchObject({
        cancelLabel: "Keep logs",
        confirmLabel: "Purge logs",
        title: "Purge 3 error logs?",
      });
      expect(requests).toEqual([
        { method: "DELETE", url: "/api/errors" },
        {
          method: "GET",
          url: "/api/errors?area=all&page=1&pageSize=50",
        },
      ]);
      expect(page.errorPage.counts.all).toBe(0);
      expect(page.purging).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalWindow === undefined) {
        delete globalThis.window;
      } else {
        globalThis.window = originalWindow;
      }
    }
  });

  it("places the error report link in the administrator menu", async () => {
    const index = await readFile(
      new URL("../web/index.html", import.meta.url),
      "utf8",
    );
    expect(index).toContain('data-view="errors"');
    expect(index).toContain('hx-get="./fragments/errors.html"');
    expect(index).toMatch(
      /data-view="errors"[\s\S]*?x-show="currentRole === 'admin'"/,
    );
    const fragment = await readFile(
      new URL("../web/fragments/errors.html", import.meta.url),
      "utf8",
    );
    const script = await readFile(
      new URL("../web/assets/scripts/citeloom-errors.js", import.meta.url),
      "utf8",
    );
    expect(fragment).toContain('@click="purgeErrors()"');
    expect(fragment).toContain("Purge logs");
    expect(script).toContain("requestConfirmation({");
    expect(script).toContain('method: "DELETE"');
  });
});

function buildErrorPage() {
  return {
    counts: {
      all: 3,
      application: 1,
      general: 1,
      ingestion: 1,
    },
    errors: [{
      area: "ingestion",
      attemptNumber: 1,
      category: "dependency",
      code: "docling_conversion_failed",
      documentId: "a".repeat(64),
      doclingErrors: [
        {
          category: "backend_failure",
          componentType: "document_backend",
          doclingLabel: null,
          elementKind: null,
          message: "Page decode failed.",
          moduleName: "pdf_backend",
          pageNumber: 17,
          pageRangeEnd: null,
          pageRangeStart: null,
          sequence: 0,
          sourceRef: null,
        },
        {
          category: "inference_failure",
          componentType: "model",
          doclingLabel: "table",
          elementKind: "table",
          message: "Table model failed.",
          moduleName: "table_structure",
          pageNumber: null,
          pageRangeEnd: 24,
          pageRangeStart: 18,
          sequence: 1,
          sourceRef: "#/tables/4",
        },
      ],
      id: "00000000-0000-4000-8000-000000000001",
      instance: "worker-1",
      jobId: "job-1",
      message: "Document conversion failed.",
      occurredAt: "2026-07-27T10:15:30.000Z",
      operation: "convert-document",
      origin: "docling-conversion",
      release: "0.1.0",
      requestId: "request-1",
      requestSequence: 2,
      retryable: true,
      runId: "00000000-0000-4000-8000-000000000002",
      service: "worker",
      severity: "error",
      sourceFile: "/documents/report.pdf",
      stackFingerprint: "b".repeat(64),
      taskId: "task-1",
      workspaceId: "00000000-0000-4000-8000-000000000003",
    }],
    generatedAt: "2026-07-27T10:16:00.000Z",
    page: 1,
    pageCount: 1,
    pageSize: 50,
    total: 1,
  };
}
