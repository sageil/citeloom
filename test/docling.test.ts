import { createHash } from "node:crypto";
import { createReadStream, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PDFDocument } from "pdf-lib";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { DoclingConfig } from "../src/config/index.js";
import {
  DoclingTaskDeadlineError,
  DoclingTaskNotFoundError,
  normalizeDoclingPageNumber,
} from "../src/docling/client/index.js";
import {
  decodeDoclingConversionResponse,
  decodeDoclingVersion,
  DoclingConversionResponseError,
} from "../src/docling/protocol/index.js";
import {
  completeDoclingAsyncConversion,
  createDoclingElements,
  partitionDocumentContents,
  readDoclingErrorCategory,
  readDoclingFailureContext,
  terminateDoclingTask,
  uploadDoclingContent,
  type DoclingConvertRequest,
  type DoclingConvertRequester,
  type DoclingHttpRequest,
  type DoclingHttpRequester,
  type DoclingWebSocketConnection,
  type DoclingWebSocketConnector,
  type DoclingWebSocketReceiveResult,
} from "../src/docling/index.js";
import type { DoclingRequestObserver } from "../src/docling/client/observer.js";
import {
  compareDoclingOutputQuality,
  fingerprintDoclingOutput,
} from "../scripts/docling-benchmark/quality.js";
import { calculateDoclingConversionDeadline } from "../src/docling/client/deadline.js";
import {
  ephemeralDoclingTaskControl,
  prepareDoclingTask,
  type DoclingTaskControl,
  type DoclingTaskReference,
} from "../src/docling/client/task.js";
import type { FileDocumentSource } from "../src/documents/format.js";

const onePixelPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const testSourceDirectory = mkdtempSync(join(tmpdir(), "citeloom-docling-test-"));

afterAll(() => {
  rmSync(testSourceDirectory, { force: true, recursive: true });
});

describe("Docling response boundary", () => {
  it("reads the most specific bounded category from a wrapped failure", () => {
    const terminal = new Error("provider failure");
    terminal.name = "DoclingTaskTerminalError";
    const wrapped = new Error("request failed", { cause: terminal });

    expect(readDoclingErrorCategory(wrapped)).toBe("DoclingTaskTerminalError");
    terminal.name = "x".repeat(100);
    expect(readDoclingErrorCategory(wrapped)).toHaveLength(64);
  });

  it("accepts only a success response without conversion errors", () => {
    const conversion = decodeDoclingConversionResponse(buildDoclingResponse());

    expect(conversion.document.name).toBe("sample");
    expect(conversion).not.toHaveProperty("errors");
  });

  it("rejects malformed and partial conversion responses", () => {
    expect(() => decodeDoclingConversionResponse({ status: "success" })).toThrow(
      "Invalid Docling response",
    );
    const response = {
      ...buildDoclingResponse(),
      errors: [{
        category: "backend_failure",
        component_type: "document_backend",
        error_message: "one page failed",
        module_name: "pdf_backend",
        page_no: 7,
      }],
      status: "partial_success",
    };
    expect(() => decodeDoclingConversionResponse(response)).toThrow(
      "Docling conversion ended with partial_success and reported 1 structured error(s).",
    );
    try {
      decodeDoclingConversionResponse(response);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DoclingConversionResponseError);
      expect(error).toMatchObject({
        conversionErrors: [{
          category: "backend_failure",
          componentType: "document_backend",
          message: "one page failed",
          moduleName: "pdf_backend",
          pageNumber: 7,
        }],
      });
    }
  });

  it("rejects conversion errors paired with a success status", () => {
    const response = {
      ...buildDoclingResponse(),
      errors: [{
        category: "backend_failure",
        component_type: "document_backend",
        error_message: "one page failed",
        module_name: "pdf_backend",
        page_no: null,
      }],
    };

    expect(() => decodeDoclingConversionResponse(response)).toThrow(
      "Docling conversion reported 1 error(s) despite a success status.",
    );
  });

  it("requires the pinned Docling Serve and parser versions", () => {
    expect(decodeDoclingVersion(buildVersionResponse())).toMatchObject({
      serveVersion: "1.27.0",
      version: "2.113.0",
    });
    expect(() => decodeDoclingVersion({
      ...buildVersionResponse(),
      "docling-serve": "1.22.0",
    })).toThrow("Docling version mismatch");
  });
});

describe("Docling conversion deadline", () => {
  it("uses the hard timeout for file-backed PDFs without reading them", async () => {
    const source = await buildPdfDocumentSource(3);
    const config = buildDoclingConfig();
    config.baseTimeoutMs = 60_000;
    config.maxTimeoutMs = 600_000;
    config.megabyteTimeoutMs = 0;
    config.pageTimeoutMs = 10_000;

    await expect(calculateDoclingConversionDeadline(source, config)).resolves.toEqual({
      byteLength: source.byteLength,
      pageCount: null,
      processingTimeoutMs: 600_000,
      taskTimeoutMs: 600_000,
    });
  });

  it("uses started mebibytes for non-PDF conversions", async () => {
    const content = Buffer.alloc(2 * 1_024 * 1_024 + 1);
    const source = buildBinaryDocumentSource(
      content,
      ".docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const config = buildDoclingConfig();
    config.baseTimeoutMs = 60_000;
    config.maxTimeoutMs = 600_000;
    config.megabyteTimeoutMs = 20_000;
    config.pageTimeoutMs = 0;

    await expect(calculateDoclingConversionDeadline(source, config)).resolves.toEqual({
      byteLength: content.byteLength,
      pageCount: null,
      processingTimeoutMs: 120_000,
      taskTimeoutMs: 600_000,
    });
  });

  it("applies the configured hard cap", async () => {
    const source = await buildPdfDocumentSource(4);
    const config = buildDoclingConfig();
    config.baseTimeoutMs = 60_000;
    config.maxTimeoutMs = 300_000;
    config.megabyteTimeoutMs = 0;
    config.pageTimeoutMs = 100_000;

    const deadline = await calculateDoclingConversionDeadline(source, config);

    expect(deadline.processingTimeoutMs).toBe(300_000);
    expect(deadline.taskTimeoutMs).toBe(300_000);
  });

  it("does not read invalid PDF bytes while calculating a deadline", async () => {
    const source = buildDocumentSource("not a PDF");

    await expect(calculateDoclingConversionDeadline(
      source,
      buildDoclingConfig(),
    )).resolves.toMatchObject({
      byteLength: source.byteLength,
      pageCount: null,
    });
  });
});

describe("Docling document conversion", () => {
  it("keeps standalone image evidence when OCR returns no text", async () => {
    const content = Buffer.from(onePixelPng, "base64");
    const source = buildBinaryDocumentSource(content, ".png", "image/png");
    const requests: DoclingConvertRequest[] = [];
    const requester: DoclingConvertRequester = async (request) => {
      requests.push(request);
      return request.decodeResponse(buildEmptyDoclingResponse());
    };

    const result = await partitionDocumentContents(
      source,
      buildDoclingConfig(),
      decodeDoclingVersion(buildVersionResponse()),
      requester,
    );

    expect(requests).toHaveLength(1);
    const body = readDoclingRequestBody(requests[0]);
    expect(body.options.from_formats).toEqual(["image"]);
    expect(body.options.ocr_preset).toBe("rapidocr");
    expect(result.pageCount).toBe(1);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({
      documentId: source.documentId,
      kind: "image",
      mimeType: "image/png",
      pageNumber: 1,
      pageNumbers: [1],
      regions: [{
        boundingBox: { bottom: 1, left: 0, right: 1, top: 0 },
        characterSpan: { end: 0, start: 0 },
        pageNumber: 1,
      }],
      sourceFile: source.sourceFile,
      sourceRefs: ["source-image"],
    });
    expect(result.elements[0]?.id).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps standalone OCR text as ordinary evidence beside the image", async () => {
    const content = Buffer.from(onePixelPng, "base64");
    const source = buildBinaryDocumentSource(content, ".png", "image/png");
    const requester: DoclingConvertRequester = async (request) => {
      const response = buildEmptyDoclingResponse();
      response.document.json_content.body.children = [{ $ref: "#/texts/0" }];
      response.document.json_content.texts = [buildTextItem(
        "#/texts/0",
        "text",
        "Recognized image text.",
        "body",
        {
          bbox: { b: 1, coord_origin: "TOPLEFT", l: 0, r: 1, t: 0 },
          charspan: [0, 22],
          page_no: 1,
        },
      )];
      return request.decodeResponse(response);
    };

    const result = await partitionDocumentContents(
      source,
      buildDoclingConfig(),
      decodeDoclingVersion(buildVersionResponse()),
      requester,
    );

    expect(result.elements).toHaveLength(2);
    expect(result.elements[0]).toMatchObject({ kind: "image" });
    expect(result.elements[1]).toMatchObject({
      content: "Recognized image text.",
      kind: "text",
    });
  });

  it("uses reading order, excludes furniture, preserves tables, and extracts pictures", async () => {
    const source = await buildPdfDocumentSource();
    const requests: DoclingConvertRequest[] = [];
    const requester: DoclingConvertRequester = async (request) => {
      requests.push(request);
      return request.decodeResponse(buildDoclingResponse());
    };

    const result = await partitionDocumentContents(
      source,
      buildDoclingConfig(),
      decodeDoclingVersion(buildVersionResponse()),
      requester,
    );

    expect(result.documentId).toBe(source.documentId);
    expect(result.pageCount).toBe(1);
    expect(result.elements).toHaveLength(3);
    expect(result.elements[0]).toMatchObject({
      content: "Results\n\nThe measured value was 42.",
      detectedTypes: ["section_header", "text"],
      kind: "text",
      pageNumber: 1,
      pageNumbers: [1],
      sectionPath: ["Results"],
      sourceRefs: ["#/texts/0", "#/texts/2"],
    });
    expect(result.elements[0]?.content).not.toContain("Confidential");
    expect(result.elements[0]?.regions).toHaveLength(2);
    expect(result.elements[1]).toMatchObject({
      content: "Caption: Figure 1\n\n| Name | Value |\n| --- | --- |\n| Alpha | 42 |",
      kind: "table",
      table: {
        columnCount: 2,
        rowCount: 2,
        rowEnd: 2,
        rowStart: 0,
      },
    });
    expect(result.elements[2]).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      pageNumbers: [1],
      sectionPath: ["Results"],
    });
    expect(result.artifact.document.pages[0]?.image).toBeNull();
    expect(result.artifact.document.pictures[0]?.image).toBeNull();
    expect(result.artifact.document.texts).toHaveLength(4);
    expect(result.artifact.processingTimeMs).toBe(1_250);

    const request = requests[0];
    expect(requests).toHaveLength(1);
    expect(request).toBeDefined();
    expect(request?.url).toBe("http://docling.test/v1/convert/content/async");
    const body = readDoclingRequestBody(request);
    expect(body.document_id).toBe(source.documentId);
    expect(body.byte_length).toBe(source.byteLength);
    expect(body.filename).toBe("sample.pdf");
    expect(body.options.from_formats).toEqual(["pdf"]);
    expect(body.options.to_formats).toEqual(["json"]);
    expect(body.options.image_export_mode).toBe("embedded");
    expect(body.options.ocr_preset).toBe("rapidocr");
    expect(body.options.table_mode).toBe("accurate");
    expect(body.options.include_images).toBe(true);
    expect(body.options.include_page_images).toBe(false);
    expect(body.options.abort_on_error).toBe(true);
    expect(body.options.document_timeout).toBe(43_195);
    expect(body.task_id).toBe(request?.task.id);
    expect(
      Date.parse(request?.task.deadlineAt ?? "")
      - Date.parse(request?.task.submittedAt ?? ""),
    ).toBe(43_200_000);
  });

  it("retains known element kind, label, page, and source reference", async () => {
    const conversion = decodeDoclingConversionResponse(buildDoclingResponse());
    const table = conversion.document.tables[0];
    if (table === undefined) {
      throw new Error("Missing normalized Docling table fixture.");
    }
    table.rowCount = 0;

    let failure: unknown;
    try {
      await createDoclingElements(
        conversion.document,
        "a".repeat(64),
        "/documents/report.pdf",
      );
    } catch (error: unknown) {
      failure = error;
    }

    expect(readDoclingFailureContext(failure)).toMatchObject({
      errors: [{
        doclingLabel: "table",
        elementKind: "table",
        pageNumber: 1,
        pageRangeEnd: null,
        pageRangeStart: null,
        sourceRef: "#/tables/0",
      }],
      origin: "docling-element",
    });
  });

  it("keeps page and element fields null for document-scoped failures", async () => {
    const conversion = decodeDoclingConversionResponse(buildDoclingResponse());
    conversion.document.body.children.push("#/missing/0");

    let failure: unknown;
    try {
      await createDoclingElements(
        conversion.document,
        "a".repeat(64),
        "/documents/report.pdf",
      );
    } catch (error: unknown) {
      failure = error;
    }

    expect(readDoclingFailureContext(failure)).toMatchObject({
      errors: [{
        doclingLabel: null,
        elementKind: null,
        pageNumber: null,
        pageRangeEnd: null,
        pageRangeStart: null,
        sourceRef: null,
      }],
      origin: "docling-normalization",
    });
  });

  it("preserves unnamed columns without inventing header labels", async () => {
    const source = await buildPdfDocumentSource();
    const response = buildDoclingResponse();
    const table = response.document.json_content.tables[0];
    if (table === undefined) {
      throw new Error("Missing Docling table fixture.");
    }
    response.document.json_content.body.children = [{ $ref: "#/tables/0" }];
    table.captions = [];
    table.data.num_cols = 4;
    table.data.num_rows = 2;
    table.data.table_cells = [
      buildTableCell("", 0, 0, false),
      buildTableCell("Third Party Intervention", 0, 1, true),
      buildTableCell("", 0, 2, false),
      buildTableCell("Intervention de tiers", 0, 3, true),
      buildTableCell("27", 1, 0, false),
      buildTableCell("Notice to third parties", 1, 1, false),
      buildTableCell("27", 1, 2, false),
      buildTableCell("Avis aux tiers", 1, 3, false),
    ];
    const requester: DoclingConvertRequester = async (request) => {
      return request.decodeResponse(response);
    };

    const result = await partitionDocumentContents(
      source,
      buildDoclingConfig(),
      decodeDoclingVersion(buildVersionResponse()),
      requester,
    );

    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({
      content: [
        "|  | Third Party Intervention |  | Intervention de tiers |",
        "| --- | --- | --- | --- |",
        "| 27 | Notice to third parties | 27 | Avis aux tiers |",
      ].join("\n"),
      kind: "table",
    });
    expect(result.elements[0]?.content).not.toMatch(/\bColumn \d+\b/u);
  });

  it("keeps every row in a table without detected headers", async () => {
    const source = await buildPdfDocumentSource();
    const response = buildDoclingResponse();
    const table = response.document.json_content.tables[0];
    if (table === undefined) {
      throw new Error("Missing Docling table fixture.");
    }
    response.document.json_content.body.children = [{ $ref: "#/tables/0" }];
    table.captions = [];
    table.data.num_cols = 2;
    table.data.num_rows = 2;
    table.data.table_cells = [
      buildTableCell("27", 0, 0, false),
      buildTableCell("Notice to third parties", 0, 1, false),
      buildTableCell("28", 1, 0, false),
      buildTableCell("Representations and decision", 1, 1, false),
    ];
    const requester: DoclingConvertRequester = async (request) => {
      return request.decodeResponse(response);
    };

    const result = await partitionDocumentContents(
      source,
      buildDoclingConfig(),
      decodeDoclingVersion(buildVersionResponse()),
      requester,
    );

    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({
      content: [
        "|  |  |",
        "| --- | --- |",
        "| 27 | Notice to third parties |",
        "| 28 | Representations and decision |",
      ].join("\n"),
      kind: "table",
    });
    expect(result.elements[0]?.content).not.toMatch(/\bColumn \d+\b/u);
  });

  it("uses Docling's returned page count for file-backed PDFs", async () => {
    const source = await buildPdfDocumentSource(2);
    const requester: DoclingConvertRequester = async (request) => {
      return request.decodeResponse(buildDoclingResponse());
    };

    await expect(partitionDocumentContents(
      source,
      buildDoclingConfig(),
      decodeDoclingVersion(buildVersionResponse()),
      requester,
    )).resolves.toMatchObject({ pageCount: 1 });
  });

  it("tracks asynchronous conversions over WebSocket within the configured deadline", async () => {
    const requests: DoclingHttpRequest[] = [];
    const responses: unknown[] = [
      { task_id: "task-1", task_status: "pending", task_type: "convert" },
      buildDoclingResponse(),
    ];
    const requester: DoclingHttpRequester = async (request) => {
      requests.push(request);
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("Unexpected Docling request.");
      }
      return response;
    };

    const connector = buildWebSocketConnector([[
      buildWebSocketMessage("task-1", "started"),
      buildWebSocketMessage("task-1", "success"),
    ]]);
    const result = await completeDoclingAsyncConversion(
      {
        ...buildAsyncConversionRequest(
          new AbortController().signal,
          ephemeralDoclingTaskControl,
          "task-1",
        ),
        apiKey: "secret",
      },
      requester,
      connector,
    );

    expect(result).toEqual(
      decodeDoclingConversionResponse(buildDoclingResponse()),
    );
    expect(requests.map((request) => request.method)).toEqual(["POST", "GET"]);
    expect(requests[1]?.url).toBe("http://docling.test/v1/result/task-1");
  });

  it("uploads source bytes before submitting a conversion", async () => {
    const taskId = "00000000-0000-4000-8000-000000000041";
    const request = buildAsyncConversionRequest(
      new AbortController().signal,
      ephemeralDoclingTaskControl,
      taskId,
    );
    const methods: DoclingHttpRequest["method"][] = [];
    let uploaded = Buffer.alloc(0);
    const requester: DoclingHttpRequester = async (httpRequest) => {
      methods.push(httpRequest.method);
      if (httpRequest.method === "PUT") {
        const chunks: Buffer[] = [];
        if (typeof httpRequest.body === "string" || httpRequest.body === null) {
          throw new Error("Expected a streamed Docling upload.");
        }
        for await (const chunk of httpRequest.body) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        uploaded = Buffer.concat(chunks);
        return {
          byte_length: request.content.byteLength,
          document_id: request.content.documentId,
          task_id: taskId,
        };
      }
      if (httpRequest.method === "POST") {
        return {
          task_id: taskId,
          task_status: "success",
          task_type: "convert",
        };
      }
      return buildDoclingResponse();
    };

    await expect(completeDoclingAsyncConversion(
      request,
      requester,
      undefined,
      undefined,
      uploadDoclingContent,
    )).resolves.toEqual(
      decodeDoclingConversionResponse(buildDoclingResponse()),
    );
    expect(methods).toEqual(["PUT", "POST", "GET"]);
    expect(uploaded).toEqual(Buffer.from("a"));
  });

  it("surfaces terminal asynchronous conversion failures without requesting a result", async () => {
    const requester = vi.fn<DoclingHttpRequester>(async () => ({
      error_message: "conversion failed",
      task_id: "task-failed",
      task_status: "failure",
      task_type: "convert",
    }));

    await expect(completeDoclingAsyncConversion(
      buildAsyncConversionRequest(
        new AbortController().signal,
        ephemeralDoclingTaskControl,
        "task-failed",
      ),
      requester,
    )).rejects.toThrow("Docling conversion task-failed failed: conversion failed");
    expect(requester).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed WebSocket messages without polling", async () => {
    const requester = vi.fn<DoclingHttpRequester>(async () => ({
      task_id: "task-malformed",
      task_status: "pending",
      task_type: "convert",
    }));
    const connector = buildWebSocketConnector([[
      { kind: "message", value: { malformed: true } },
    ]]);

    await expect(completeDoclingAsyncConversion(
      buildAsyncConversionRequest(
        new AbortController().signal,
        ephemeralDoclingTaskControl,
        "task-malformed",
      ),
      requester,
      connector,
    )).rejects.toThrow("WebSocket message is invalid");
    expect(requester).toHaveBeenCalledOnce();
  });

  it("rejects a WebSocket status for a different task", async () => {
    const requester = vi.fn<DoclingHttpRequester>(async () => ({
      task_id: "task-expected",
      task_status: "pending",
      task_type: "convert",
    }));
    const connector = buildWebSocketConnector([[
      buildWebSocketMessage("task-other", "started"),
    ]]);

    await expect(completeDoclingAsyncConversion(
      buildAsyncConversionRequest(
        new AbortController().signal,
        ephemeralDoclingTaskControl,
        "task-expected",
      ),
      requester,
      connector,
    )).rejects.toThrow("while tracking task-expected");
    expect(requester).toHaveBeenCalledOnce();
  });

  it("reconciles once after a WebSocket disconnect", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const requests: DoclingHttpRequest[] = [];
      const responses: unknown[] = [
        { task_id: "task-reconnect", task_status: "pending", task_type: "convert" },
        { task_id: "task-reconnect", task_status: "started", task_type: "convert" },
        buildDoclingResponse(),
      ];
      const requester: DoclingHttpRequester = async (request) => {
        requests.push(request);
        const response = responses.shift();
        if (response === undefined) {
          throw new Error("Unexpected reconnect request.");
        }
        return response;
      };
      const connector = buildWebSocketConnector([
        [{ kind: "closed", reason: "network interruption" }],
        [buildWebSocketMessage("task-reconnect", "success")],
      ]);

      await expect(completeDoclingAsyncConversion(
        buildAsyncConversionRequest(
          new AbortController().signal,
          ephemeralDoclingTaskControl,
          "task-reconnect",
        ),
        requester,
        connector,
      )).resolves.toEqual(
        decodeDoclingConversionResponse(buildDoclingResponse()),
      );
      expect(requests.map((request) => request.url)).toEqual([
        "http://docling.test/v1/convert/content/async",
        "http://docling.test/v1/status/poll/task-reconnect?wait=0",
        "http://docling.test/v1/result/task-reconnect",
      ]);
    } finally {
      random.mockRestore();
    }
  });

  it("clears a non-resumable task after a terminal WebSocket failure", async () => {
    const clear = vi.fn(async () => undefined);
    const control: DoclingTaskControl = {
      clear,
      current: null,
      kind: "durable",
      record: vi.fn(async () => undefined),
    };
    const requester = vi.fn<DoclingHttpRequester>(async () => ({
      task_id: "task-ws-failure",
      task_status: "pending",
      task_type: "convert",
    }));
    const connector = buildWebSocketConnector([[
      buildWebSocketMessage("task-ws-failure", "failure"),
    ]]);

    const request = buildAsyncConversionRequest(
      new AbortController().signal,
      control,
      "task-ws-failure",
    );
    request.retainTaskAfterTerminalFailure = false;
    await expect(completeDoclingAsyncConversion(
      request,
      requester,
      connector,
    )).rejects.toThrow("task ended with failure");
    expect(clear).toHaveBeenCalledExactlyOnceWith("task-ws-failure");
  });

  it("preserves a durable task when result retrieval fails", async () => {
    const clear = vi.fn(async () => undefined);
    const control: DoclingTaskControl = {
      clear,
      current: null,
      kind: "durable",
      record: vi.fn(async () => undefined),
    };
    const requester = vi.fn<DoclingHttpRequester>(async (request) => {
      if (request.method === "POST") {
        return {
          task_id: "task-result-retry",
          task_status: "success",
          task_type: "convert",
        };
      }
      throw new Error("result transport unavailable");
    });

    await expect(completeDoclingAsyncConversion(
      buildAsyncConversionRequest(
        new AbortController().signal,
        control,
        "task-result-retry",
      ),
      requester,
    )).rejects.toThrow("result transport unavailable");
    expect(control.record).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("terminates and clears a task whose completed result violates the response invariant", async () => {
    const taskId = "00000000-0000-4000-8000-000000000016";
    const clear = vi.fn(async () => undefined);
    const observe = vi.fn<DoclingRequestObserver["observe"]>(
      async () => undefined,
    );
    const taskControl: DoclingTaskControl = {
      clear,
      current: null,
      kind: "durable",
      record: vi.fn(async () => undefined),
    };
    const invalidResponse = {
      ...buildDoclingResponse(),
      errors: [{
        category: "backend_failure",
        component_type: "document_backend",
        error_message: "one page failed",
        module_name: "pdf_backend",
        page_no: 9,
      }],
    };
    const responses: unknown[] = [
      {
        task_id: taskId,
        task_status: "success",
        task_type: "convert",
      },
      invalidResponse,
      { state: "terminated", task_id: taskId },
    ];
    const requester = vi.fn<DoclingHttpRequester>(async () => {
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("Unexpected Docling request.");
      }
      return response;
    });
    const request = buildAsyncConversionRequest(
      new AbortController().signal,
      taskControl,
      taskId,
    );
    request.observer = {
      identity: {
        id: "00000000-0000-4000-8000-000000000006",
        sequence: 6,
      },
      observe,
    };

    await expect(completeDoclingAsyncConversion(
      request,
      requester,
    )).rejects.toMatchObject({
      conversionErrors: [{
        category: "backend_failure",
        componentType: "document_backend",
        message: "one page failed",
        moduleName: "pdf_backend",
        pageNumber: 9,
      }],
      message: "Docling conversion reported 1 error(s) despite a success status.",
      requestId: "00000000-0000-4000-8000-000000000006",
      requestSequence: 6,
      taskId,
    });
    expect(requester.mock.calls.map(([httpRequest]) => {
      return [httpRequest.method, httpRequest.url];
    })).toEqual([
      ["POST", "http://docling.test/v1/convert/content/async"],
      ["GET", `http://docling.test/v1/result/${taskId}`],
      ["POST", `http://docling.test/v1/tasks/${taskId}/terminate`],
    ]);
    expect(clear).toHaveBeenCalledExactlyOnceWith(taskId);
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({
      kind: "transport-failed",
      outcome: "service-error",
    }));
    expect(observe).not.toHaveBeenCalledWith(expect.objectContaining({
      kind: "transport-succeeded",
    }));
  });

  it("retains structured result errors when task termination also fails", async () => {
    const taskId = "00000000-0000-4000-8000-000000000036";
    const responses: unknown[] = [
      {
        task_id: taskId,
        task_status: "success",
        task_type: "convert",
      },
      {
        ...buildDoclingResponse(),
        errors: [{
          category: "backend_failure",
          component_type: "document_backend",
          error_message: "one page failed",
          module_name: "pdf_backend",
          page_no: 9,
        }],
      },
    ];
    const requester = vi.fn<DoclingHttpRequester>(async () => {
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("termination transport unavailable");
      }
      return response;
    });

    let failure: unknown;
    try {
      await completeDoclingAsyncConversion(
        buildAsyncConversionRequest(
          new AbortController().signal,
          ephemeralDoclingTaskControl,
          taskId,
        ),
        requester,
      );
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(readDoclingFailureContext(failure)).toMatchObject({
      errors: [{
        category: "backend_failure",
        pageNumber: 9,
      }],
      origin: "docling-conversion",
      taskId,
    });
  });

  it("preserves multiple structured range errors from a terminal task", async () => {
    const taskId = "00000000-0000-4000-8000-000000000026";
    const request = buildAsyncConversionRequest(
      new AbortController().signal,
      ephemeralDoclingTaskControl,
      taskId,
    );
    request.observer = {
      identity: {
        id: "00000000-0000-4000-8000-000000000027",
        sequence: 4,
      },
      observe: async () => undefined,
    };
    const failure = {
      end_page: 30,
      errors: [
        {
          category: "backend_failure",
          component_type: "document_backend",
          docling_label: "picture",
          element_kind: "image",
          error_message: "page decode failed",
          module_name: "pdf_backend",
          page_no: 23,
          source_ref: "#/pictures/0",
        },
        {
          category: "inference_failure",
          component_type: "model",
          error_message: "document model failed",
          module_name: "layout_model",
          page_no: null,
        },
      ],
      page_number_basis: "absolute",
      start_page: 21,
      status: "failure",
    };
    const requester = vi.fn<DoclingHttpRequester>(async () => ({
      error_message: "Document conversion failed.",
      failure: {
        category: "backend_failure",
        details: {
          citeloom_conversion_failure: JSON.stringify(failure),
        },
        message: "Document conversion failed.",
        phase: "execution",
        retryable: true,
      },
      task_id: taskId,
      task_status: "failure",
      task_type: "convert",
    }));

    await expect(completeDoclingAsyncConversion(
      request,
      requester,
    )).rejects.toMatchObject({
      category: "backend_failure",
      conversionErrors: [
        expect.objectContaining({
          doclingLabel: "picture",
          elementKind: "image",
          pageNumber: 23,
          pageRangeEnd: 30,
          pageRangeStart: 21,
          sourceRef: "#/pictures/0",
        }),
        expect.objectContaining({
          pageNumber: null,
          pageRangeEnd: 30,
          pageRangeStart: 21,
        }),
      ],
      requestId: "00000000-0000-4000-8000-000000000027",
      requestSequence: 4,
      retryable: true,
      taskId,
    });
  });

  it("retains structured task errors when the hard deadline is crossed", async () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2026-07-15T12:00:00.000Z");
      const taskId = "00000000-0000-4000-8000-000000000037";
      vi.setSystemTime(now);
      const clear = vi.fn(async () => undefined);
      const taskControl: DoclingTaskControl = {
        clear,
        current: {
          deadlineAt: new Date(now.getTime() + 100).toISOString(),
          id: taskId,
          submittedAt: now.toISOString(),
        },
        kind: "durable",
        record: vi.fn(async () => undefined),
      };
      const failure = {
        end_page: 30,
        errors: [{
          category: "backend_failure",
          component_type: "document_backend",
          error_message: "page decode failed",
          module_name: "pdf_backend",
          page_no: 23,
        }],
        page_number_basis: "absolute",
        start_page: 21,
        status: "failure",
      };
      const requester = vi.fn<DoclingHttpRequester>(async (request) => {
        if (request.url.endsWith("/terminate")) {
          return { state: "terminated", task_id: taskId };
        }
        vi.setSystemTime(new Date(now.getTime() + 101));
        return {
          error_message: "Document conversion failed.",
          failure: {
            category: "backend_failure",
            details: {
              citeloom_conversion_failure: JSON.stringify(failure),
            },
            message: "Document conversion failed.",
            phase: "execution",
            retryable: true,
          },
          task_id: taskId,
          task_status: "failure",
          task_type: "convert",
        };
      });

      let observedFailure: unknown;
      try {
        await completeDoclingAsyncConversion(
          buildAsyncConversionRequest(
            new AbortController().signal,
            taskControl,
          ),
          requester,
        );
      } catch (error: unknown) {
        observedFailure = error;
      }

      expect(observedFailure).toBeInstanceOf(DoclingTaskDeadlineError);
      expect(readDoclingFailureContext(observedFailure)).toMatchObject({
        errors: [{
          category: "backend_failure",
          pageNumber: 23,
          pageRangeEnd: 30,
          pageRangeStart: 21,
        }],
        origin: "docling-task",
        retryable: true,
        taskId,
      });
      expect(clear).toHaveBeenCalledExactlyOnceWith(taskId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes relative Docling pages once and preserves absolute pages", () => {
    expect(normalizeDoclingPageNumber({
      basis: "relative",
      pageNumber: 3,
      pageRangeEnd: 20,
      pageRangeStart: 11,
    })).toBe(13);
    expect(normalizeDoclingPageNumber({
      basis: "absolute",
      pageNumber: 13,
      pageRangeEnd: 20,
      pageRangeStart: 11,
    })).toBe(13);
  });

  it("bounds WebSocket reconnect attempts", async () => {
    try {
      const requester = vi.fn<DoclingHttpRequester>(async () => ({
        task_id: "task-reconnect-limit",
        task_status: "pending",
        task_type: "convert",
      }));
      const connector = vi.fn<DoclingWebSocketConnector>(async () => {
        throw new Error("socket unavailable");
      });
      const conversion = completeDoclingAsyncConversion(
        buildAsyncConversionRequest(
          new AbortController().signal,
          ephemeralDoclingTaskControl,
          "task-reconnect-limit",
        ),
        requester,
        connector,
        async () => undefined,
      );
      await expect(conversion).rejects.toThrow(
        "reconnect limit was exceeded",
      );
      expect(connector).toHaveBeenCalledTimes(6);
      expect(requester).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("records and resumes one durable asynchronous task with an idempotent submission", async () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2026-07-15T12:00:00.000Z");
      vi.setSystemTime(now);
      const record = vi.fn(async (_task: DoclingTaskReference) => undefined);
      const clear = vi.fn(async () => undefined);
      const taskControl: DoclingTaskControl = {
        clear,
        current: null,
        kind: "durable",
        record,
      };
      const prepared = await prepareDoclingTask(taskControl, 120_000, now);
      const initialRequester = vi.fn<DoclingHttpRequester>(async (request) => {
        if (request.method === "POST") {
          return {
            task_id: prepared.task.id,
            task_status: "started",
            task_type: "convert",
          };
        }
        throw new Error("worker interrupted");
      });
      const interruptedConnector = buildWebSocketConnector([[
        { kind: "message", value: { malformed: true } },
      ]]);
      const initialRequest = buildAsyncConversionRequest(
        new AbortController().signal,
        taskControl,
        prepared.task.id,
      );
      initialRequest.task = prepared.task;

      await expect(completeDoclingAsyncConversion(
        initialRequest,
        initialRequester,
        interruptedConnector,
      )).rejects.toThrow("WebSocket message is invalid");
      expect(record).toHaveBeenCalledOnce();
      expect(clear).not.toHaveBeenCalled();

      const task = record.mock.calls[0]?.[0];
      expect(task).toMatchObject({
        deadlineAt: "2026-07-15T12:02:00.000Z",
        submittedAt: "2026-07-15T12:00:00.000Z",
      });
      expect(task?.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      );
      if (task === undefined) {
        throw new Error("Expected a recorded Docling task.");
      }
      const resumedRequests: DoclingHttpRequest[] = [];
      const resumedResponses: unknown[] = [
        { task_id: task.id, task_status: "success", task_type: "convert" },
        buildDoclingResponse(),
      ];
      const resumedRequester: DoclingHttpRequester = async (request) => {
        resumedRequests.push(request);
        const response = resumedResponses.shift();
        if (response === undefined) {
          throw new Error("Unexpected resumed Docling request.");
        }
        return response;
      };
      const resumedControl: DoclingTaskControl = {
        clear,
        current: task,
        kind: "durable",
        record,
      };

      await expect(completeDoclingAsyncConversion(
        buildAsyncConversionRequest(
          new AbortController().signal,
          resumedControl,
        ),
        resumedRequester,
      )).resolves.toEqual(
        decodeDoclingConversionResponse(buildDoclingResponse()),
      );
      expect(resumedRequests.map((request) => request.method)).toEqual([
        "POST",
        "GET",
      ]);
      expect(record).toHaveBeenCalledOnce();
      expect(clear).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a durable task after a terminal status for retry", async () => {
    const clear = vi.fn(async () => undefined);
    const taskControl: DoclingTaskControl = {
      clear,
      current: {
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
        id: "task-terminal",
        submittedAt: new Date().toISOString(),
      },
      kind: "durable",
      record: vi.fn(async () => undefined),
    };
    const requester = vi.fn<DoclingHttpRequester>(async () => ({
      error_message: "conversion failed",
      task_id: "task-terminal",
      task_status: "failure",
      task_type: "convert",
    }));

    await expect(completeDoclingAsyncConversion(
      buildAsyncConversionRequest(new AbortController().signal, taskControl),
      requester,
    )).rejects.toThrow("conversion failed");
    expect(clear).not.toHaveBeenCalled();
  });

  it("resubmits a missing durable task with the same identity", async () => {
    const clear = vi.fn(async () => undefined);
    const record = vi.fn(async (_task: DoclingTaskReference) => undefined);
    const taskControl: DoclingTaskControl = {
      clear,
      current: {
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
        id: "task-missing",
        submittedAt: new Date().toISOString(),
      },
      kind: "durable",
      record,
    };
    const requests: DoclingHttpRequest[] = [];
    const requester = vi.fn<DoclingHttpRequester>(async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        throw new DoclingTaskNotFoundError("Docling task is unavailable.");
      }
      if (request.method === "POST") {
        return {
          task_id: "task-missing",
          task_status: "success",
          task_type: "convert",
        };
      }
      return buildDoclingResponse();
    });

    await expect(completeDoclingAsyncConversion(
      buildAsyncConversionRequest(new AbortController().signal, taskControl),
      requester,
    )).resolves.toEqual(
      decodeDoclingConversionResponse(buildDoclingResponse()),
    );
    expect(clear).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(requests.map((request) => request.method)).toEqual(["POST", "POST", "GET"]);
  });

  it("only resubmits a missing durable task once", async () => {
    const clear = vi.fn(async () => undefined);
    const taskControl: DoclingTaskControl = {
      clear,
      current: {
        deadlineAt: new Date(Date.now() + 120_000).toISOString(),
        id: "task-missing",
        submittedAt: new Date().toISOString(),
      },
      kind: "durable",
      record: vi.fn(async () => undefined),
    };
    const requester = vi.fn<DoclingHttpRequester>(async () => {
      throw new DoclingTaskNotFoundError("Docling task is unavailable.");
    });

    await expect(completeDoclingAsyncConversion(
      buildAsyncConversionRequest(new AbortController().signal, taskControl),
      requester,
    )).rejects.toThrow("unavailable");
    expect(requester).toHaveBeenCalledTimes(2);
    expect(clear).toHaveBeenCalledExactlyOnceWith("task-missing");
  });

  it("terminates an expired task before clearing its checkpoint", async () => {
    const taskId = "00000000-0000-4000-8000-000000000010";
    const clear = vi.fn(async () => undefined);
    const taskControl: DoclingTaskControl = {
      clear,
      current: {
        deadlineAt: new Date(Date.now() - 1).toISOString(),
        id: taskId,
        submittedAt: new Date(Date.now() - 120_000).toISOString(),
      },
      kind: "durable",
      record: vi.fn(async () => undefined),
    };
    const requester = vi.fn<DoclingHttpRequester>(async () => ({
      state: "terminated",
      task_id: taskId,
    }));

    await expect(completeDoclingAsyncConversion(
      buildAsyncConversionRequest(new AbortController().signal, taskControl),
      requester,
    )).rejects.toThrow("hard deadline");
    expect(requester).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      method: "POST",
      url: `http://docling.test/v1/tasks/${taskId}/terminate`,
    }));
    expect(clear).toHaveBeenCalledExactlyOnceWith(taskId);
  });

  it("does not accept a completed result after the hard deadline", async () => {
    const taskId = "00000000-0000-4000-8000-000000000011";
    const clear = vi.fn(async () => undefined);
    const taskControl: DoclingTaskControl = {
      clear,
      current: {
        deadlineAt: new Date(Date.now() - 1).toISOString(),
        id: taskId,
        submittedAt: new Date(Date.now() - 120_000).toISOString(),
      },
      kind: "durable",
      record: vi.fn(async () => undefined),
    };
    const requester = vi.fn<DoclingHttpRequester>(async () => ({
      state: "terminated",
      task_id: taskId,
    }));

    await expect(completeDoclingAsyncConversion(
      buildAsyncConversionRequest(new AbortController().signal, taskControl),
      requester,
    )).rejects.toThrow("hard deadline");
    expect(requester).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledExactlyOnceWith(taskId);
  });

  it("classifies a request that reaches the hard deadline as a timeout", async () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2026-07-15T12:00:00.000Z");
      const taskId = "00000000-0000-4000-8000-000000000012";
      vi.setSystemTime(now);
      const clear = vi.fn(async () => undefined);
      const observe = vi.fn<DoclingRequestObserver["observe"]>(async () => undefined);
      const taskControl: DoclingTaskControl = {
        clear,
        current: {
          deadlineAt: new Date(now.getTime() + 100).toISOString(),
          id: taskId,
          submittedAt: now.toISOString(),
        },
        kind: "durable",
        record: vi.fn(async () => undefined),
      };
      const requester = vi.fn<DoclingHttpRequester>(async (httpRequest) => {
        if (httpRequest.url.endsWith("/terminate")) {
          return { state: "terminated", task_id: taskId };
        }
        vi.setSystemTime(new Date(now.getTime() + 101));
        throw new DOMException("The operation timed out", "TimeoutError");
      });
      const request = buildAsyncConversionRequest(
        new AbortController().signal,
        taskControl,
      );
      request.observer = {
        identity: {
          id: "00000000-0000-4000-8000-000000000007",
          sequence: 7,
        },
        observe,
      };

      await expect(completeDoclingAsyncConversion(
        request,
        requester,
      )).rejects.toThrow("hard deadline");
      expect(requester).toHaveBeenCalledTimes(2);
      expect(clear).toHaveBeenCalledExactlyOnceWith(taskId);
      expect(observe).toHaveBeenCalledWith(expect.objectContaining({
        kind: "transport-failed",
        outcome: "timeout",
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches without clearing the task when the caller stops tracking", async () => {
    const taskId = "00000000-0000-4000-8000-000000000013";
    const abortController = new AbortController();
    const clear = vi.fn(async () => undefined);
    const taskControl: DoclingTaskControl = {
      clear,
      current: null,
      kind: "durable",
      record: vi.fn(async () => undefined),
    };
    const requester = vi.fn<DoclingHttpRequester>(async () => {
      abortController.abort(new Error("worker stopped"));
      return {
        task_id: taskId,
        task_status: "pending",
        task_type: "convert",
      };
    });

    await expect(completeDoclingAsyncConversion(
      buildAsyncConversionRequest(
        abortController.signal,
        taskControl,
        taskId,
      ),
      requester,
    )).rejects.toThrow("worker stopped");
    expect(requester).toHaveBeenCalledOnce();
    expect(clear).not.toHaveBeenCalled();
  });

  it("bounds termination acknowledgement requests", async () => {
    const taskId = "00000000-0000-4000-8000-000000000015";
    const requester = vi.fn<DoclingHttpRequester>(async () => ({
      state: "terminated",
      task_id: taskId,
    }));

    await terminateDoclingTask({
      apiKey: null,
      baseUrl: "http://docling.test",
      requestTimeoutMs: 300_000,
      taskId,
    }, requester);

    expect(requester).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ timeoutMs: 10_000 }),
    );
  });

  it("checks cancellation before invoking Docling", async () => {
    const requester = vi.fn<DoclingConvertRequester>();
    const abortController = new AbortController();
    abortController.abort(new Error("stop"));
    await expect(partitionDocumentContents(
      buildDocumentSource("cancel me"),
      buildDoclingConfig(),
      decodeDoclingVersion(buildVersionResponse()),
      requester,
      abortController.signal,
    )).rejects.toThrow("stop");
    expect(requester).not.toHaveBeenCalled();
  });

  it("extracts picture-bearing PDFs with one content-ID conversion", async () => {
    const source = await buildPdfDocumentSource(9);
    const requests: DoclingConvertRequest[] = [];
    const requester: DoclingConvertRequester = async (request) => {
      requests.push(request);
      return request.decodeResponse(buildMultiPageStructureResponse(9));
    };

    const result = await partitionDocumentContents(
      source,
      buildDoclingConfig(),
      decodeDoclingVersion(buildVersionResponse()),
      requester,
    );

    expect(result.elements).toHaveLength(9);
    expect(result.elements.every((element) => element.kind === "image")).toBe(true);
    expect(result.pageCount).toBe(9);
    expect(requests).toHaveLength(1);
  });

  it("extracts paginated non-PDF pictures with one content-ID conversion", async () => {
    const source = buildDocumentSource("docx fixture");
    source.extension = ".docx";
    source.mediaType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const requests: DoclingConvertRequest[] = [];
    const requester: DoclingConvertRequester = async (request) => {
      requests.push(request);
      return request.decodeResponse(buildMultiPageStructureResponse(9));
    };

    const result = await partitionDocumentContents(
      source,
      buildDoclingConfig(),
      decodeDoclingVersion(buildVersionResponse()),
      requester,
    );

    expect(result.elements).toHaveLength(9);
    expect(result.elements.every((element) => element.kind === "image")).toBe(true);
    expect(result.pageCount).toBeNull();
    expect(requests).toHaveLength(1);
  });

  it("extracts unpaginated HTML pictures with one content-ID conversion", async () => {
    const source = buildDocumentSource("<html><img src='figure.png'></html>");
    source.extension = ".html";
    source.mediaType = "text/html";
    const requests: DoclingConvertRequest[] = [];
    const requester: DoclingConvertRequester = async (request) => {
      requests.push(request);
      return request.decodeResponse(buildHtmlPictureResponse(true));
    };

    const result = await partitionDocumentContents(
      source,
      buildDoclingConfig(),
      decodeDoclingVersion(buildVersionResponse()),
      requester,
    );

    expect(requests).toHaveLength(1);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({
      kind: "image",
      mimeType: "image/png",
      pageNumbers: [],
    });
    expect(result.artifact.document.pictures[0]?.image).toBeNull();
  });

  it("preserves a hierarchical section path across text chunk boundaries", async () => {
    const source = await buildPdfDocumentSource();
    const requester: DoclingConvertRequester = async (request) => {
      return request.decodeResponse(buildLongNestedTextResponse());
    };

    const result = await partitionDocumentContents(
      source,
      buildDoclingConfig(),
      decodeDoclingVersion(buildVersionResponse()),
      requester,
    );

    expect(result.elements).toHaveLength(6);
    const textChunks = result.elements.slice(2);
    expect(textChunks).toHaveLength(4);
    for (const chunk of textChunks) {
      expect(chunk.sectionPath).toEqual(["Earlier section"]);
    }
  });

  it("compares all fidelity-bearing Docling output structures", async () => {
    const source = await buildPdfDocumentSource();
    const requester: DoclingConvertRequester = async (request) => {
      return request.decodeResponse(buildDoclingResponse());
    };
    const baseline = await partitionDocumentContents(
      source,
      buildDoclingConfig(),
      decodeDoclingVersion(buildVersionResponse()),
      requester,
    );
    const identical = structuredClone(baseline);

    expect(compareDoclingOutputQuality(baseline, identical)).toEqual({
      differences: [],
      passed: true,
    });
    expect(fingerprintDoclingOutput(identical)).toBe(
      fingerprintDoclingOutput(baseline),
    );

    const mutations: Array<(candidate: typeof baseline) => void> = [
      (candidate) => {
        const text = candidate.artifact.document.texts[0];
        if (text !== undefined) {
          text.text = "changed text";
        }
      },
      (candidate) => {
        candidate.artifact.document.body.children.reverse();
      },
      (candidate) => {
        const table = candidate.artifact.document.tables[0];
        const cell = table?.tableCells[0];
        if (cell !== undefined) {
          cell.text = "changed cell";
        }
      },
      (candidate) => {
        const provenance = candidate.artifact.document.pictures[0]?.provenance[0];
        if (provenance !== undefined) {
          provenance.pageNumber = 2;
        }
      },
      (candidate) => {
        candidate.embeddedPictureRefs = [];
      },
      (candidate) => {
        candidate.elements.reverse();
      },
    ];
    for (const mutate of mutations) {
      const candidate = structuredClone(baseline);
      mutate(candidate);
      const comparison = compareDoclingOutputQuality(baseline, candidate);
      expect(comparison.passed).toBe(false);
      expect(comparison.differences.length).toBeGreaterThan(0);
      expect(fingerprintDoclingOutput(candidate)).not.toBe(
        fingerprintDoclingOutput(baseline),
      );
    }
  });
});

function buildAsyncConversionRequest(
  abortSignal: AbortSignal = new AbortController().signal,
  taskControl: DoclingTaskControl = ephemeralDoclingTaskControl,
  taskId: string = "task-default",
): DoclingConvertRequest {
  const currentTime = new Date();
  const task = taskControl.kind === "durable" && taskControl.current !== null
    ? taskControl.current
    : {
        deadlineAt: new Date(
          currentTime.getTime() + 120_000,
        ).toISOString(),
        id: taskId,
        submittedAt: currentTime.toISOString(),
      };
  return {
    abortSignal,
    apiKey: null,
    baseUrl: "http://docling.test",
    body: "{}",
    content: {
      byteLength: 1,
      documentId: "a".repeat(64),
      open: async () => Readable.from([Buffer.from("a")]),
    },
    decodeResponse: decodeDoclingConversionResponse,
    observer: buildRequestObserver(),
    requestTimeoutMs: 30_000,
    retainTaskAfterTerminalFailure: true,
    resumedSubmission: (
      taskControl.kind === "durable"
      && taskControl.current !== null
    ),
    task,
    taskControl,
    url: "http://docling.test/v1/convert/content/async",
  };
}

interface CapturedDoclingContentRequest {
  byte_length: number;
  document_id: string;
  filename: string;
  task_id: string;
  options: {
    abort_on_error: boolean;
    document_timeout: number;
    from_formats: string[];
    image_export_mode: string;
    include_images: boolean;
    include_page_images: boolean;
    ocr_preset: string;
    table_mode: string;
    to_formats: string[];
  };
}

function readDoclingRequestBody(
  request: DoclingConvertRequest | undefined,
): CapturedDoclingContentRequest {
  if (request === undefined) {
    throw new Error("Expected a captured Docling request.");
  }
  return JSON.parse(request.body) as CapturedDoclingContentRequest;
}

function buildDoclingResponse(
  includePictureImage: boolean = true,
  includePageImage: boolean = false,
) {
  const provenance = (top: number, bottom: number, length: number) => ({
    bbox: { b: bottom, coord_origin: "TOPLEFT", l: 10, r: 90, t: top },
    charspan: [0, length],
    page_no: 1,
  });
  return {
    document: {
      filename: "sample.pdf",
      json_content: {
        body: {
          children: [
            { $ref: "#/texts/0" },
            { $ref: "#/texts/1" },
          ],
          content_layer: "body",
          label: "unspecified",
          name: "body",
          parent: null,
          self_ref: "#/body",
        },
        furniture: {
          children: [],
          content_layer: "furniture",
          label: "unspecified",
          name: "furniture",
          parent: null,
          self_ref: "#/furniture",
        },
        groups: [],
        key_value_items: [],
        name: "sample",
        pages: {
          "1": {
            image: includePageImage ? {
              dpi: 72,
              mimetype: "image/png",
              size: { height: 1, width: 1 },
              uri: `data:image/png;base64,${onePixelPng}`,
            } : null,
            page_no: 1,
            size: includePageImage
              ? { height: 1, width: 1 }
              : { height: 100, width: 100 },
          },
        },
        pictures: [{
          captions: [{ $ref: "#/texts/3" }],
          children: [],
          content_layer: "body",
          image: includePictureImage ? {
            dpi: 72,
            mimetype: "image/png",
            size: { height: 1, width: 1 },
            uri: `data:image/png;base64,${onePixelPng}`,
          } : null,
          label: "picture",
          parent: { $ref: "#/body" },
          prov: [provenance(60, 90, 0)],
          self_ref: "#/pictures/0",
        }],
        schema_name: "DoclingDocument",
        tables: [{
          captions: [{ $ref: "#/texts/3" }],
          children: [],
          content_layer: "body",
          data: {
            num_cols: 2,
            num_rows: 2,
            table_cells: [
              buildTableCell("Name", 0, 0, true),
              buildTableCell("Value", 0, 1, true),
              buildTableCell("Alpha", 1, 0, false),
              buildTableCell("42", 1, 1, false),
            ],
          },
          label: "table",
          parent: { $ref: "#/body" },
          prov: [provenance(40, 58, 20)],
          self_ref: "#/tables/0",
        }],
        texts: [
          buildTextItem(
            "#/texts/0",
            "section_header",
            "Results",
            "body",
            provenance(5, 10, 7),
            [{ $ref: "#/texts/2" }, { $ref: "#/tables/0" }, { $ref: "#/pictures/0" }],
          ),
          buildTextItem("#/texts/1", "page_header", "Confidential", "furniture", provenance(0, 4, 12)),
          buildTextItem("#/texts/2", "text", "The measured value was 42.", "body", provenance(12, 20, 26)),
          buildTextItem("#/texts/3", "caption", "Figure 1", "body", provenance(58, 60, 8)),
        ],
        version: "1.8.0",
      },
    },
    errors: [],
    processing_time: 1.25,
    status: "success",
  };
}

function buildEmptyDoclingResponse() {
  const response = buildDoclingResponse(false, true);
  response.document.json_content.body.children = [];
  response.document.json_content.pictures = [];
  response.document.json_content.tables = [];
  response.document.json_content.texts = [];
  return response;
}

function buildTextItem(
  selfRef: string,
  label: string,
  text: string,
  contentLayer: string,
  provenance: object,
  children: Array<{ $ref: string }> = [],
) {
  return {
    children,
    content_layer: contentLayer,
    label,
    orig: text,
    parent: { $ref: "#/body" },
    prov: [provenance],
    self_ref: selfRef,
    text,
  };
}

function buildTableCell(
  text: string,
  row: number,
  column: number,
  columnHeader: boolean,
) {
  return {
    col_span: 1,
    column_header: columnHeader,
    end_col_offset_idx: column + 1,
    end_row_offset_idx: row + 1,
    row_header: false,
    row_section: false,
    row_span: 1,
    start_col_offset_idx: column,
    start_row_offset_idx: row,
    text,
  };
}

function buildVersionResponse() {
  return {
    docling: "2.113.0",
    "docling-core": "2.87.1",
    "docling-ibm-models": "3.13.3",
    "docling-jobkit": "2.1.0",
    "docling-parse": "7.8.1",
    "docling-serve": "1.27.0",
  };
}

function buildDocumentSource(content: string): FileDocumentSource {
  const bytes = Buffer.from(content);
  return buildBinaryDocumentSource(bytes, ".pdf", "application/pdf");
}

function buildBinaryDocumentSource(
  content: Buffer,
  extension: FileDocumentSource["extension"],
  mediaType: FileDocumentSource["mediaType"],
): FileDocumentSource {
  const documentId = createHash("sha256").update(content).digest("hex");
  const contentPath = join(testSourceDirectory, documentId);
  writeFileSync(contentPath, content);
  return {
    byteLength: content.byteLength,
    documentId,
    extension,
    kind: "file",
    mediaType,
    openContent: async (abortSignal?: AbortSignal) => {
      return createReadStream(
        contentPath,
        abortSignal === undefined ? {} : { signal: abortSignal },
      );
    },
    sourceFile: `/documents/sample${extension}`,
  };
}

async function buildPdfDocumentSource(
  pageCount: number = 1,
): Promise<FileDocumentSource> {
  const pdf = await PDFDocument.create();
  for (let page = 0; page < pageCount; page += 1) {
    pdf.addPage([100, 100]);
  }
  const content = Buffer.from(await pdf.save());
  return buildBinaryDocumentSource(content, ".pdf", "application/pdf");
}

function buildMultiPageStructureResponse(pageCount: number) {
  const children: Array<{ $ref: string }> = [];
  const pages: Record<string, object> = {};
  const pictures: object[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    const pageNumber = index + 1;
    children.push({ $ref: `#/pictures/${index}` });
    pages[String(pageNumber)] = {
      image: null,
      page_no: pageNumber,
      size: { height: 100, width: 100 },
    };
    pictures.push({
      captions: [],
      children: [],
      content_layer: "body",
      image: {
        dpi: 72,
        mimetype: "image/png",
        size: { height: 1, width: 1 },
        uri: `data:image/png;base64,${onePixelPng}`,
      },
      label: "picture",
      parent: { $ref: "#/body" },
      prov: [{
        bbox: { b: 90, coord_origin: "TOPLEFT", l: 10, r: 90, t: 10 },
        charspan: [0, 0],
        page_no: pageNumber,
      }],
      self_ref: `#/pictures/${index}`,
    });
  }
  return buildMinimalResponse(children, pages, pictures);
}

function buildMinimalResponse(
  children: Array<{ $ref: string }>,
  pages: Record<string, object>,
  pictures: object[],
  texts: object[] = [],
) {
  return {
    document: {
      filename: "pages.pdf",
      json_content: {
        body: {
          children,
          content_layer: "body",
          label: "unspecified",
          name: "body",
          parent: null,
          self_ref: "#/body",
        },
        furniture: {
          children: [],
          content_layer: "furniture",
          label: "unspecified",
          name: "furniture",
          parent: null,
          self_ref: "#/furniture",
        },
        groups: [],
        key_value_items: [],
        name: "pages",
        pages,
        pictures,
        schema_name: "DoclingDocument",
        tables: [],
        texts,
        version: "1.8.0",
      },
    },
    errors: [],
    processing_time: 0.5,
    status: "success",
  };
}

function buildHtmlPictureResponse(includeImage: boolean) {
  const picture = {
    captions: [],
    children: [],
    content_layer: "body",
    image: includeImage ? {
      dpi: 72,
      mimetype: "image/png",
      size: { height: 1, width: 1 },
      uri: `data:image/png;base64,${onePixelPng}`,
    } : null,
    label: "picture",
    parent: { $ref: "#/body" },
    prov: [],
    self_ref: "#/pictures/0",
  };
  return buildMinimalResponse(
    [{ $ref: "#/pictures/0" }],
    {},
    [picture],
  );
}

function buildLongNestedTextResponse() {
  const provenance = {
    bbox: { b: 90, coord_origin: "TOPLEFT", l: 10, r: 90, t: 10 },
    charspan: [0, 8_500],
    page_no: 1,
  };
  const earlierHeading = buildTextItem(
    "#/texts/0",
    "section_header",
    "Earlier section",
    "body",
    provenance,
  );
  const laterHeading = buildTextItem(
    "#/texts/1",
    "section_header",
    "Later section",
    "body",
    provenance,
  );
  const longText = buildTextItem(
    "#/texts/2",
    "text",
    "a".repeat(8_500),
    "body",
    provenance,
  );
  longText.parent = { $ref: "#/texts/0" };
  const response = buildMinimalResponse(
    [
      { $ref: "#/texts/0" },
      { $ref: "#/texts/1" },
      { $ref: "#/texts/2" },
    ],
    {
      "1": {
        image: null,
        page_no: 1,
        size: { height: 100, width: 100 },
      },
    },
    [],
    [earlierHeading, laterHeading, longText],
  );
  return response;
}

function buildDoclingConfig(): DoclingConfig {
  return {
    apiKey: "secret",
    baseTimeoutMs: 120_000,
    baseUrl: "http://docling.test",
    maxTimeoutMs: 43_200_000,
    megabyteTimeoutMs: 60_000,
    ocrEnabled: true,
    pageTimeoutMs: 30_000,
    pdfBackend: "docling_parse",
    performanceMetricsEnabled: false,
    performanceMetricsRetentionDays: 30,
    pipeline: "standard",
    requestTimeoutMs: 300_000,
    secondaryImageScale: 2,
    tableMode: "accurate",
    tableStructureEnabled: true,
    tocEnabled: true,
    vlm: null,
  };
}

function buildRequestObserver(): DoclingRequestObserver {
  return {
    identity: {
      id: "00000000-0000-4000-8000-000000000001",
      sequence: 0,
    },
    observe: async () => undefined,
  };
}

function buildWebSocketConnector(
  connections: Array<Array<DoclingWebSocketReceiveResult | Error>>,
): DoclingWebSocketConnector {
  return async (): Promise<DoclingWebSocketConnection> => {
    const messages = connections.shift();
    if (messages === undefined) {
      throw new Error("Unexpected Docling WebSocket connection.");
    }
    return {
      close: () => undefined,
      receive: async () => {
        const message = messages.shift();
        if (message instanceof Error) {
          throw message;
        }
        return message ?? {
          kind: "closed",
          reason: "script completed",
        };
      },
      send: () => undefined,
    };
  };
}

function buildWebSocketMessage(
  taskId: string,
  status: "failure" | "pending" | "started" | "success",
): DoclingWebSocketReceiveResult {
  return {
    kind: "message",
    value: {
      error: null,
      message: "update",
      task: {
        error_message: null,
        task_id: taskId,
        task_status: status,
        task_type: "convert",
      },
    },
  };
}
