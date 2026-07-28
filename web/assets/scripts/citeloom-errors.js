import {
  readArray,
  readBoolean,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullableNonEmptyString,
  readNullableNonNegativeInteger,
  readPlainObject,
  readPositiveInteger,
} from "./citeloom-boundaries.js";

const errorAreas = Object.freeze([
  "all",
  "ingestion",
  "application",
  "general",
]);
const recordAreas = Object.freeze([
  "ingestion",
  "application",
  "general",
]);
const errorOrigins = Object.freeze([
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
]);
const errorSeverities = Object.freeze(["warning", "error", "critical"]);
const elementKinds = Object.freeze(["image", "table", "text"]);
const pageSize = 50;

function buildEmptyErrorPage() {
  return {
    counts: {
      all: 0,
      application: 0,
      general: 0,
      ingestion: 0,
    },
    errors: [],
    generatedAt: null,
    page: 1,
    pageCount: 0,
    total: 0,
  };
}

export function readApplicationErrorPage(value) {
  const page = readPlainObject(value, "application error page");
  const counts = readPlainObject(page.counts, "application error counts");
  const errors = [];
  for (const error of readArray(page.errors, "application errors")) {
    errors.push(readApplicationErrorRecord(error));
  }
  const generatedAt = readTimestamp(page.generatedAt, "error report generated time");
  const currentPage = readPositiveInteger(page.page, "application error page number");
  const pageCount = readNonNegativeInteger(
    page.pageCount,
    "application error page count",
  );
  const responsePageSize = readPositiveInteger(
    page.pageSize,
    "application error page size",
  );
  if (responsePageSize !== pageSize) {
    throw new Error("The application error page size response is invalid.");
  }
  return {
    counts: {
      all: readNonNegativeInteger(counts.all, "all error count"),
      application: readNonNegativeInteger(
        counts.application,
        "application error count",
      ),
      general: readNonNegativeInteger(counts.general, "general error count"),
      ingestion: readNonNegativeInteger(
        counts.ingestion,
        "ingestion error count",
      ),
    },
    errors,
    generatedAt,
    page: currentPage,
    pageCount,
    total: readNonNegativeInteger(page.total, "filtered error count"),
  };
}

function readApplicationErrorRecord(value) {
  const error = readPlainObject(value, "application error");
  const doclingErrors = [];
  for (const detail of readArray(error.doclingErrors, "Docling error details")) {
    doclingErrors.push(readDoclingErrorDetail(detail));
  }
  return {
    area: readEnum(error.area, recordAreas, "application error area"),
    attemptNumber: readNullablePositiveInteger(
      error.attemptNumber,
      "application error attempt",
    ),
    category: readNonEmptyString(error.category, "application error category"),
    code: readNonEmptyString(error.code, "application error code"),
    documentId: readNullableNonEmptyString(
      error.documentId,
      "application error document ID",
    ),
    doclingErrors,
    id: readNonEmptyString(error.id, "application error ID"),
    instance: readNullableNonEmptyString(
      error.instance,
      "application error instance",
    ),
    jobId: readNullableNonEmptyString(error.jobId, "application error job ID"),
    message: readNonEmptyString(error.message, "application error message"),
    occurredAt: readTimestamp(error.occurredAt, "application error time"),
    operation: readNonEmptyString(
      error.operation,
      "application error operation",
    ),
    origin: readEnum(error.origin, errorOrigins, "application error origin"),
    release: readNullableNonEmptyString(
      error.release,
      "application error release",
    ),
    requestId: readNullableNonEmptyString(
      error.requestId,
      "application error request ID",
    ),
    requestSequence: readNullableNonNegativeInteger(
      error.requestSequence,
      "application error request sequence",
    ),
    retryable: readNullableBoolean(
      error.retryable,
      "application error retryable state",
    ),
    runId: readNullableNonEmptyString(error.runId, "application error run ID"),
    service: readNonEmptyString(error.service, "application error service"),
    severity: readEnum(
      error.severity,
      errorSeverities,
      "application error severity",
    ),
    sourceFile: readNullableNonEmptyString(
      error.sourceFile,
      "application error source file",
    ),
    stackFingerprint: readNullableNonEmptyString(
      error.stackFingerprint,
      "application error stack fingerprint",
    ),
    taskId: readNullableNonEmptyString(
      error.taskId,
      "application error task ID",
    ),
    workspaceId: readNullableNonEmptyString(
      error.workspaceId,
      "application error workspace ID",
    ),
  };
}

function readDoclingErrorDetail(value) {
  const detail = readPlainObject(value, "Docling error detail");
  return {
    category: readNonEmptyString(detail.category, "Docling error category"),
    componentType: readNonEmptyString(
      detail.componentType,
      "Docling component type",
    ),
    doclingLabel: readNullableNonEmptyString(
      detail.doclingLabel,
      "Docling label",
    ),
    elementKind: detail.elementKind === null
      ? null
      : readEnum(detail.elementKind, elementKinds, "Docling element kind"),
    message: readNonEmptyString(detail.message, "Docling error message"),
    moduleName: readNonEmptyString(detail.moduleName, "Docling module name"),
    pageNumber: readNullablePositiveInteger(
      detail.pageNumber,
      "Docling page number",
    ),
    pageRangeEnd: readNullablePositiveInteger(
      detail.pageRangeEnd,
      "Docling page range end",
    ),
    pageRangeStart: readNullablePositiveInteger(
      detail.pageRangeStart,
      "Docling page range start",
    ),
    sequence: readNonNegativeInteger(detail.sequence, "Docling error sequence"),
    sourceRef: readNullableNonEmptyString(
      detail.sourceRef,
      "Docling source reference",
    ),
  };
}

function readTimestamp(value, label) {
  const timestamp = readNonEmptyString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`The ${label} response is invalid.`);
  }
  return timestamp;
}

function readNullablePositiveInteger(value, label) {
  if (value === null) {
    return null;
  }
  return readPositiveInteger(value, label);
}

function readNullableBoolean(value, label) {
  if (value === null) {
    return null;
  }
  return readBoolean(value, label);
}

function buildContextRows(error) {
  const rows = [
    { label: "Error ID", value: error.id },
    { label: "Origin", value: error.origin },
    { label: "Service", value: error.service },
    { label: "Operation", value: error.operation },
    { label: "Category", value: error.category },
    { label: "Code", value: error.code },
  ];
  appendContextRow(rows, "Source file", error.sourceFile);
  appendContextRow(rows, "Document ID", error.documentId);
  appendContextRow(rows, "Job ID", error.jobId);
  appendContextRow(rows, "Run ID", error.runId);
  appendContextRow(rows, "Task ID", error.taskId);
  appendContextRow(rows, "Request ID", error.requestId);
  appendContextRow(
    rows,
    "Request sequence",
    error.requestSequence === null ? null : String(error.requestSequence),
  );
  appendContextRow(
    rows,
    "Attempt",
    error.attemptNumber === null ? null : String(error.attemptNumber),
  );
  appendContextRow(
    rows,
    "Retryable",
    error.retryable === null ? null : error.retryable ? "Yes" : "No",
  );
  appendContextRow(rows, "Release", error.release);
  appendContextRow(rows, "Instance", error.instance);
  appendContextRow(rows, "Stack fingerprint", error.stackFingerprint);
  return rows;
}

function appendContextRow(rows, label, value) {
  if (value !== null) {
    rows.push({ label, value });
  }
}

export function registerPage(alpine) {
  alpine.data("citeloomErrorsPage", () => ({
    activeArea: "all",
    errorMessage: "",
    errorPage: buildEmptyErrorPage(),
    hasLoaded: false,
    loading: false,
    requestController: null,

    get areaOptions() {
      return [
        {
          count: this.errorPage.counts.all,
          id: "all",
          label: "All errors",
        },
        {
          count: this.errorPage.counts.ingestion,
          id: "ingestion",
          label: "Ingestion",
        },
        {
          count: this.errorPage.counts.application,
          id: "application",
          label: "Application",
        },
        {
          count: this.errorPage.counts.general,
          id: "general",
          label: "General",
        },
      ];
    },

    get canLoadNewer() {
      return this.errorPage.page > 1;
    },

    get canLoadOlder() {
      return this.errorPage.page < this.errorPage.pageCount;
    },

    initialize() {
      void this.loadErrors(1);
    },

    destroy() {
      this.requestController?.abort();
    },

    async loadErrors(page) {
      this.requestController?.abort();
      const controller = new AbortController();
      this.requestController = controller;
      this.loading = true;
      this.errorMessage = "";
      const parameters = new URLSearchParams({
        area: this.activeArea,
        page: String(page),
        pageSize: String(pageSize),
      });
      try {
        const response = await fetch(`/api/errors?${parameters.toString()}`, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        this.errorPage = await readJsonResponse(
          response,
          "Application error request",
          readApplicationErrorPage,
        );
        this.hasLoaded = true;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        this.errorMessage = error instanceof Error
          ? error.message
          : "Application errors could not be loaded.";
      } finally {
        if (this.requestController === controller) {
          this.loading = false;
          this.requestController = null;
        }
      }
    },

    selectArea(area) {
      this.activeArea = readEnum(area, errorAreas, "application error area");
      void this.loadErrors(1);
    },

    loadNewer() {
      if (this.canLoadNewer && !this.loading) {
        void this.loadErrors(this.errorPage.page - 1);
      }
    },

    loadOlder() {
      if (this.canLoadOlder && !this.loading) {
        void this.loadErrors(this.errorPage.page + 1);
      }
    },

    refresh() {
      if (!this.loading) {
        void this.loadErrors(this.errorPage.page);
      }
    },

    contextRows(error) {
      return buildContextRows(error);
    },

    filename(sourceFile) {
      if (sourceFile === null) {
        return null;
      }
      const segments = sourceFile.split("/");
      return segments.at(-1) || sourceFile;
    },

    formatArea(area) {
      if (area === "ingestion") {
        return "Ingestion";
      }
      if (area === "application") {
        return "Application";
      }
      return "General";
    },

    formatDay(value) {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
      }).format(new Date(value));
    },

    formatTime(value) {
      return new Intl.DateTimeFormat(undefined, {
        timeStyle: "medium",
      }).format(new Date(value));
    },

    formatDoclingLocation(detail) {
      if (detail.pageNumber !== null) {
        return `Page ${detail.pageNumber}`;
      }
      if (detail.pageRangeStart !== null && detail.pageRangeEnd !== null) {
        return `Pages ${detail.pageRangeStart}-${detail.pageRangeEnd}`;
      }
      return "Document scoped";
    },

    formatDoclingElement(detail) {
      const labels = [];
      if (detail.elementKind !== null) {
        labels.push(detail.elementKind);
      }
      if (detail.doclingLabel !== null) {
        labels.push(detail.doclingLabel);
      }
      return labels.length === 0 ? "Unknown element" : labels.join(" / ");
    },
  }));
}
