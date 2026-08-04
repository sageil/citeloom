import {
  readArray,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullablePositiveInteger,
  readPlainObject,
} from "./citeloom-boundaries.js";
import {
  formatRelativeTime,
  readBasename,
} from "./citeloom-document-presentation.js";
import { dispatchNotice } from "./citeloom-notices.js";

const ingestionStatuses = Object.freeze([
  "already-exists",
  "already-processing",
  "indexed",
  "queued",
  "skipped",
  "upload-blocked",
]);

const recentDocumentStatusLabels = Object.freeze({
  failed: "Failed",
  pending: "Waiting",
  ready: "Ready",
  "reindex-required": "Re-index needed",
  running: "Processing",
});

function readIngestionResponse(value) {
  const response = readPlainObject(value, "ingestion response");
  return {
    documents: readIngestionDocuments(response.documents),
    failures: readIngestionFailures(response.failures),
  };
}

function readIngestionDocuments(value) {
  const values = readArray(value, "ingested documents");
  const documents = [];
  for (const value of values) {
    const document = readPlainObject(value, "ingested document");
    documents.push({
      documentId: readNonEmptyString(document.documentId, "document ID"),
      images: readNonNegativeInteger(document.images, "document image count"),
      pageCount: readNullablePositiveInteger(
        document.pageCount,
        "document page count",
      ),
      sourceFile: readNonEmptyString(document.sourceFile, "document source file"),
      status: readEnum(document.status, ingestionStatuses, "ingestion status"),
      tables: readNonNegativeInteger(document.tables, "document table count"),
      textChunks: readNonNegativeInteger(
        document.textChunks,
        "document text chunk count",
      ),
      totalElements: readNonNegativeInteger(
        document.totalElements,
        "document element count",
      ),
    });
  }
  return documents;
}

function readIngestionFailures(value) {
  const values = readArray(value, "ingestion failures");
  const failures = [];
  for (const value of values) {
    const failure = readPlainObject(value, "ingestion failure");
    failures.push({
      error: readNonEmptyString(failure.error, "ingestion failure message"),
      sourceFile: readNonEmptyString(
        failure.sourceFile,
        "ingestion failure source file",
      ),
    });
  }
  return failures;
}

function readIngestionResponseBody(response) {
  return readJsonResponse(
    response,
    "Document ingestion",
    readIngestionResponse,
  );
}

function addTagDraft(currentTags, draft) {
  const tags = [...currentTags];
  const normalizedTags = new Set();
  for (const tag of currentTags) {
    normalizedTags.add(tag.toLocaleLowerCase());
  }
  for (const candidate of draft.split(",")) {
    const tag = candidate.trim();
    if (tag === "") {
      continue;
    }
    const normalizedTag = tag.toLocaleLowerCase();
    if (normalizedTags.has(normalizedTag)) {
      continue;
    }
    normalizedTags.add(normalizedTag);
    tags.push(tag);
  }
  return tags;
}

function buildIngestionNotice(result) {
  if (result.failures.length > 0) {
    const suffix = result.failures.length === 1 ? "" : "s";
    const messages = [
      `${result.failures.length} document${suffix} could not be submitted:`,
    ];
    for (const failure of result.failures) {
      messages.push(`${failure.sourceFile}: ${failure.error}`);
    }
    return {
      destination: null,
      kind: "error",
      message: messages.join("\n"),
    };
  }

  let queued = 0;
  let indexed = 0;
  let skipped = 0;
  let duplicates = 0;
  let processing = 0;
  const blockedDocuments = [];
  for (const document of result.documents) {
    if (document.status === "queued") {
      queued += 1;
    } else if (document.status === "indexed") {
      indexed += 1;
    } else if (document.status === "skipped") {
      skipped += 1;
    } else if (document.status === "already-processing") {
      processing += 1;
    } else if (document.status === "upload-blocked") {
      blockedDocuments.push(document);
    } else {
      duplicates += 1;
    }
  }
  const details = [];
  if (queued > 0) {
    const suffix = queued === 1 ? "" : "s";
    details.push(`${queued} document${suffix} uploaded`);
  }
  if (indexed > 0) {
    details.push(`${indexed} indexed`);
  }
  if (skipped > 0) {
    details.push(`${skipped} already current`);
  }
  if (duplicates > 0) {
    details.push(`${duplicates} already in the library`);
  }
  if (processing > 0) {
    details.push(`${processing} already processing`);
  }
  for (const document of blockedDocuments) {
    details.push(
      `${document.sourceFile} was not accepted because an earlier version is processing`,
    );
  }
  return {
    destination: "documents",
    kind: blockedDocuments.length > 0 ? "error" : "success",
    message: details.join(", ") || "Document ingestion completed.",
  };
}

function formatBytes(bytes) {
  if (bytes < 1_024) {
    return `${bytes} B`;
  }
  if (bytes < 1_024 * 1_024) {
    return `${(bytes / 1_024).toFixed(1)} KB`;
  }
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function buildFileSizeError(
  files,
  maximumDocumentBytes,
  maximumUploadRequestBytes,
) {
  let aggregateBytes = 0;
  for (const file of files) {
    aggregateBytes += file.size;
    if (file.size <= maximumDocumentBytes) {
      continue;
    }
    return `${file.name} is ${formatBytes(file.size)}. The configured limit is ${formatBytes(maximumDocumentBytes)} per document.`;
  }
  if (aggregateBytes > maximumUploadRequestBytes) {
    return `The selected documents total ${formatBytes(aggregateBytes)}. The configured request limit is ${formatBytes(maximumUploadRequestBytes)}.`;
  }
  return null;
}

export function registerPage(alpine) {
  alpine.data("citeloomOverviewPage", () => ({
    dashboardWarningDismissed: false,
    errorMessage: "",
    files: [],
    force: false,
    submitting: false,
    tagDraft: "",
    tags: [],
    uploadController: null,

    get selectedFileCountLabel() {
      const suffix = this.files.length === 1 ? "document" : "documents";
      return `${this.files.length} ${suffix} selected`;
    },

    get selectedFileSizeLabel() {
      let bytes = 0;
      for (const file of this.files) {
        bytes += file.size;
      }
      return formatBytes(bytes);
    },

    documentSizeLimitLabel() {
      const maximumDocumentBytes = this.overviewSummary.maximumDocumentBytes;
      if (maximumDocumentBytes === null) {
        return "the configured size limit";
      }
      return `${formatBytes(maximumDocumentBytes)} per document`;
    },

    chooseFiles(value) {
      if (value === null) {
        return;
      }
      if (!(value instanceof FileList)) {
        this.errorMessage = "The selected documents are invalid.";
        return;
      }
      const files = [];
      for (const file of value) {
        if (!(file instanceof File)) {
          this.errorMessage = "The selected documents are invalid.";
          return;
        }
        files.push(file);
      }
      this.files = files;
      const maximumDocumentBytes = this.overviewSummary.maximumDocumentBytes;
      const maximumUploadRequestBytes =
        this.overviewSummary.maximumUploadRequestBytes;
      this.errorMessage =
        maximumDocumentBytes === null || maximumUploadRequestBytes === null
        ? ""
        : buildFileSizeError(
          files,
          maximumDocumentBytes,
          maximumUploadRequestBytes,
        ) ?? "";
    },

    clearFiles() {
      this.files = [];
      if (this.$refs.fileInput instanceof HTMLInputElement) {
        this.$refs.fileInput.value = "";
      }
    },

    commitTagDraft() {
      const tags = addTagDraft(this.tags, this.tagDraft);
      this.tags = tags;
      this.tagDraft = "";
      return tags;
    },

    removeTag(tagToRemove) {
      const tags = [];
      for (const tag of this.tags) {
        if (tag !== tagToRemove) {
          tags.push(tag);
        }
      }
      this.tags = tags;
    },

    recentDocumentName(sourceFile) {
      return readBasename(sourceFile);
    },

    recentDocumentStatus(displayStatus) {
      return recentDocumentStatusLabels[displayStatus];
    },

    recentDocumentTime(updatedAt) {
      return formatRelativeTime(updatedAt);
    },

    async submit() {
      if (this.files.length === 0) {
        this.errorMessage = "Select at least one document.";
        return;
      }
      if (this.submitting) {
        return;
      }

      const maximumDocumentBytes = this.overviewSummary.maximumDocumentBytes;
      const maximumUploadRequestBytes =
        this.overviewSummary.maximumUploadRequestBytes;
      if (
        maximumDocumentBytes === null
        || maximumUploadRequestBytes === null
      ) {
        this.errorMessage = "The configured upload limit is still loading. Try again.";
        return;
      }
      const fileSizeError = buildFileSizeError(
        this.files,
        maximumDocumentBytes,
        maximumUploadRequestBytes,
      );
      if (fileSizeError !== null) {
        this.errorMessage = fileSizeError;
        return;
      }

      const submittedTags = this.commitTagDraft();
      const body = new FormData();
      body.append("force", String(this.force));
      body.append("tags", submittedTags.join(","));
      for (const file of this.files) {
        body.append("documents", file, file.name);
      }

      const controller = new AbortController();
      this.uploadController = controller;
      this.submitting = true;
      this.errorMessage = "";
      try {
        const response = await fetch("/api/ingestions", {
          body,
          method: "POST",
          signal: controller.signal,
        });
        const result = await readIngestionResponseBody(response);
        this.clearFiles();
        this.tags = [];
        this.$dispatch("citeloom:ingestion-complete", buildIngestionNotice(result));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        dispatchNotice(
          "error",
          error instanceof Error ? error.message : "Document ingestion failed.",
        );
      } finally {
        if (this.uploadController === controller) {
          this.uploadController = null;
          this.submitting = false;
        }
      }
    },

    destroy() {
      this.uploadController?.abort();
    },

    dismissDashboardWarning() {
      this.dashboardWarningDismissed = true;
    },

    stepClass(activeStep, index) {
      if (index < activeStep) {
        return "done";
      }
      if (index === activeStep) {
        return "current";
      }
      return "";
    },

    stepComplete(activeStep, index) {
      return index < activeStep;
    },

    stepCurrent(activeStep, index) {
      return index === activeStep ? "step" : null;
    },

    submitLabel() {
      if (this.submitting) {
        return "Submitting documents";
      }
      return "Queue documents";
    },

    workspaceFact(value, status) {
      if (status === "loading") {
        return "-";
      }
      if (status === "error") {
        return "Unavailable";
      }
      return String(value);
    },
  }));
}
