import {
  readArray,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullableNonNegativeInteger,
  readNullablePositiveInteger,
  readNullableString,
  readNullableTimestamp,
  readPlainObject,
  readPositiveInteger,
  readString,
  readTimestamp,
} from "./citeloom-boundaries.js";
import {
  DOCUMENT_NOTIFICATION_CHANGE_EVENT,
  DOCUMENT_NOTIFICATION_REQUEST_EVENT,
  DOCUMENT_NOTIFICATION_STATE_EVENT,
  readDocumentNotificationState,
} from "./citeloom-document-notifications.js";
import {
  buildCollections,
  buildPageNumbers,
  buildPhaseStages,
  combineStatusDetails,
  formatByteLength,
  formatCount,
  formatDocumentLocationCount,
  formatElapsedDuration,
  formatExactDate,
  formatRelativeTime,
  readBasename,
  readCollectionLabel,
  readContentCountLabel,
  readDocumentStatusCopy,
  readEmbeddingProgressDetail,
  readFileType,
  readMediaProgressDetail,
  readNextSelectedDocument,
  readRetryPhase,
} from "./citeloom-document-presentation.js";
import { dispatchNotice } from "./citeloom-notices.js";

const catalogSorts = Object.freeze([
  "name-asc",
  "name-desc",
  "updated-asc",
  "updated-desc",
]);
const catalogStatuses = Object.freeze([
  "all",
  "failed",
  "processing",
  "queryable",
  "ready",
  "reindex-required",
]);
const displayStatuses = Object.freeze([
  "failed",
  "pending",
  "ready",
  "reindex-required",
  "running",
]);
const ingestionPhases = Object.freeze([
  "discovered",
  "indexed",
  "normalized",
]);
const ingestionControlStates = Object.freeze([
  "active",
  "pause_requested",
  "paused",
  "cancel_requested",
  "cleanup_failed",
]);
const embeddingProgressStates = Object.freeze([
  "complete",
  "in-progress",
  "not-started",
]);
const queryStatuses = Object.freeze([
  "failed",
  "pending",
  "ready",
  "reindex-required",
  "running",
]);
const documentStatuses = Object.freeze([
  "failed",
  "pending",
  "ready",
  "running",
]);
const pageSizes = Object.freeze([25, 50, 100]);
const catalogRefreshDebounceMs = 200;
const searchDebounceMs = 250;
const pageSelectionCaches = new WeakMap();
const selectionSearchCaches = new WeakMap();
let documentActionInProgress = false;

const emptyFacets = Object.freeze({
  failed: 0,
  pending: 0,
  processing: 0,
  queryable: 0,
  queryableTags: [],
  ready: 0,
  reindexRequired: 0,
  running: 0,
  tags: [],
  total: 0,
  untagged: 0,
  uploads: 0,
});

export function readDocumentCatalog(value) {
  const response = readPlainObject(value, "document catalog");
  const attention = readPlainObject(
    response.attention,
    "document attention queue",
  );
  return {
    attention: {
      documents: readCatalogEntries(
        attention.documents,
        "attention queue documents",
      ),
      total: readNonNegativeInteger(
        attention.total,
        "attention queue total",
      ),
    },
    documents: readCatalogEntries(response.documents, "catalog documents"),
    facets: readCatalogFacets(response.facets),
    page: readPositiveInteger(response.page, "catalog page"),
    pageSize: readPageSize(response.pageSize),
    total: readNonNegativeInteger(response.total, "catalog total"),
  };
}

function readCatalogEntries(value, label) {
  const values = readArray(value, label);
  const documents = [];
  const sourceFiles = new Set();
  for (const value of values) {
    const document = readCatalogEntry(value);
    if (sourceFiles.has(document.sourceFile)) {
      throw new Error(`The source file ${document.sourceFile} appears more than once.`);
    }
    sourceFiles.add(document.sourceFile);
    documents.push(document);
  }
  return documents;
}

function readCatalogEntry(value) {
  const document = readPlainObject(value, "catalog document");
  const displayStatus = readEnum(
    document.displayStatus,
    displayStatuses,
    "document display status",
  );
  const pageCount = readNullablePositiveInteger(
    document.pageCount,
    "document page count",
  );
  const phase = readNullableEnum(
    document.phase,
    ingestionPhases,
    "document ingestion phase",
  );
  const sourceFile = readNonEmptyString(
    document.sourceFile,
    "document source file",
  );
  const filename = readBasename(sourceFile);
  const status = readEnum(
    document.status,
    documentStatuses,
    "document status",
  );
  const controlState = readEnum(
    document.controlState,
    ingestionControlStates,
    "document ingestion control state",
  );
  const images = readNonNegativeInteger(
    document.images,
    "document image count",
  );
  const queryStatus = readEnum(
    document.queryStatus,
    queryStatuses,
    "document query status",
  );
  const tables = readNonNegativeInteger(
    document.tables,
    "document table count",
  );
  const textChunks = readNonNegativeInteger(
    document.textChunks,
    "document text chunk count",
  );
  const totalElements = readNonNegativeInteger(
    document.totalElements,
    "document element count",
  );
  const embeddingProgress = readEmbeddingProgress(
    document.embeddingProgress,
    totalElements,
  );
  const mediaDescriptionProgress = readMediaDescriptionProgress(
    document.mediaDescriptionProgress,
    images,
    tables,
  );
  validateDocumentProcessingProgress(
    phase,
    status,
    embeddingProgress,
    mediaDescriptionProgress,
    images,
    tables,
  );
  const contentCountsAvailable = status === "ready"
    || phase === "normalized"
    || phase === "indexed";
  const controlError = readNullableString(
    document.controlError,
    "ingestion control error",
  );
  let statusCopy = readDocumentStatusCopy({
    displayStatus,
    embeddingProgress,
    phase,
    queryStatus,
  });
  if (controlState === "pause_requested") {
    statusCopy = {
      detail: combineStatusDetails(
        controlError ?? "Stopping the active operation safely",
        readEmbeddingProgressDetail(embeddingProgress),
      ),
      label: controlError === null ? "Pausing" : "Pause delayed",
    };
  } else if (controlState === "paused") {
    statusCopy = {
      detail: combineStatusDetails(
        "Resume when ready",
        readEmbeddingProgressDetail(embeddingProgress),
      ),
      label: "Paused",
    };
  } else if (controlState === "cancel_requested") {
    statusCopy = {
      detail: controlError
        ?? "Stopping ingestion and cleaning partial data",
      label: controlError === null ? "Canceling" : "Cancellation delayed",
    };
  } else if (controlState === "cleanup_failed") {
    statusCopy = {
      detail: "Cleanup failed. Retry cancellation.",
      label: "Cleanup failed",
    };
  }
  if (
    queryStatus === "ready"
    && displayStatus !== "ready"
    && displayStatus !== "reindex-required"
  ) {
    statusCopy.detail = combineStatusDetails(
      statusCopy.detail,
      "Current version available to ask",
    );
  }
  const errorMessage = readNullableString(
    document.errorMessage,
    "document error message",
  );
  const retryState = readDocumentRetryState(document, status, errorMessage);
  let compactStatusLabel = statusCopy.label;
  if (controlState === "active" && displayStatus === "pending") {
    compactStatusLabel = "Waiting";
  } else if (controlState === "active" && displayStatus === "failed") {
    compactStatusLabel = "Failed";
  }
  return {
    activeDocumentId: readNullableString(
      document.activeDocumentId,
      "active document ID",
    ),
    activeVersionId: readNullableUuid(
      document.activeVersionId,
      "active document version ID",
    ),
    byteLength: readNullableNonNegativeInteger(
      document.byteLength,
      "document byte length",
    ),
    compactStatusLabel,
    displayStatus,
    documentId: readNonEmptyString(document.documentId, "document ID"),
    embeddingSpaceIds: readUniqueStringArray(
      document.embeddingSpaceIds,
      "document embedding space IDs",
      false,
    ),
    embeddingProgress,
    errorMessage,
    failureContext: retryState.failureContext,
    failureHeading: retryState.failureHeading,
    images,
    imagesLabel: readContentCountLabel(images, contentCountsAvailable),
    filename,
    fileType: readFileType(filename),
    mediaDescriptionProgress,
    pageCount,
    pageCountLabel: contentCountsAvailable
      ? formatDocumentLocationCount(filename, pageCount)
      : "Waiting",
    phase,
    queryStatus,
    controlError,
    controlState,
    sourceFile,
    statusDetail: statusCopy.detail,
    statusLabel: statusCopy.label,
    status,
    tables,
    tablesLabel: readContentCountLabel(tables, contentCountsAvailable),
    tags: readUniqueStringArray(document.tags, "document tags", true),
    textChunks,
    textChunksLabel: readContentCountLabel(
      textChunks,
      contentCountsAvailable,
    ),
    totalElements,
    uploadedByUserId: readNullableUuid(
      document.uploadedByUserId,
      "document uploader ID",
    ),
    updatedAt: readTimestamp(document.updatedAt, "document updated time"),
  };
}

function readEmbeddingProgress(value, documentTotalElements) {
  const progress = readPlainObject(value, "document embedding progress");
  const state = readEnum(
    progress.state,
    embeddingProgressStates,
    "document embedding progress state",
  );
  if (state === "not-started") {
    return { state };
  }
  const completedElements = readNonNegativeInteger(
    progress.completedElements,
    "completed embedding element count",
  );
  const totalElements = state === "in-progress"
    ? readPositiveInteger(
      progress.totalElements,
      "embedding element total",
    )
    : readNonNegativeInteger(
      progress.totalElements,
      "embedding element total",
    );
  if (completedElements > totalElements) {
    throw new Error("Completed embedding elements exceed the document total.");
  }
  if (totalElements !== documentTotalElements) {
    throw new Error("Embedding progress does not match the document element total.");
  }
  if (state === "in-progress" && completedElements === totalElements) {
    throw new Error("In-progress embedding has no remaining elements.");
  }
  if (state === "complete" && completedElements !== totalElements) {
    throw new Error("Complete embedding does not cover every document element.");
  }
  return { completedElements, state, totalElements };
}

function readMediaDescriptionProgress(value, images, tables) {
  const progress = readPlainObject(value, "document media description progress");
  const completedImages = readNonNegativeInteger(
    progress.completedImages,
    "completed image description count",
  );
  const completedTables = readNonNegativeInteger(
    progress.completedTables,
    "completed table description count",
  );
  if (completedImages > images) {
    throw new Error("Completed image descriptions exceed the document image total.");
  }
  if (completedTables > tables) {
    throw new Error("Completed table descriptions exceed the document table total.");
  }
  return { completedImages, completedTables };
}

function validateDocumentProcessingProgress(
  phase,
  status,
  embeddingProgress,
  mediaDescriptionProgress,
  images,
  tables,
) {
  if (phase === "discovered" && embeddingProgress.state !== "not-started") {
    throw new Error("A discovered document cannot have embedding progress.");
  }
  if (
    (status === "ready" || phase === "indexed")
    && embeddingProgress.state !== "complete"
  ) {
    throw new Error("An indexed document requires complete embedding progress.");
  }
  if (
    phase === "discovered"
    && (
      mediaDescriptionProgress.completedImages !== 0
      || mediaDescriptionProgress.completedTables !== 0
    )
  ) {
    throw new Error("A discovered document cannot have media description progress.");
  }
  if (
    (status === "ready" || phase === "indexed")
    && (
      mediaDescriptionProgress.completedImages !== images
      || mediaDescriptionProgress.completedTables !== tables
    )
  ) {
    throw new Error("An indexed document requires complete media processing.");
  }
}

function readCatalogFacets(value) {
  const facets = readPlainObject(value, "document catalog facets");
  return {
    failed: readNonNegativeInteger(facets.failed, "failed document count"),
    pending: readNonNegativeInteger(facets.pending, "pending document count"),
    processing: readNonNegativeInteger(
      facets.processing,
      "processing document count",
    ),
    queryable: readNonNegativeInteger(
      facets.queryable,
      "queryable document count",
    ),
    queryableTags: readTagFacets(facets.queryableTags, "queryable tag facets"),
    ready: readNonNegativeInteger(facets.ready, "ready document count"),
    reindexRequired: readNonNegativeInteger(
      facets.reindexRequired,
      "reindex-required document count",
    ),
    running: readNonNegativeInteger(facets.running, "running document count"),
    tags: readTagFacets(facets.tags, "tag facets"),
    total: readNonNegativeInteger(facets.total, "total document count"),
    untagged: readNonNegativeInteger(
      facets.untagged,
      "untagged document count",
    ),
    uploads: readNonNegativeInteger(facets.uploads, "uploaded document count"),
  };
}

function readTagFacets(value, label) {
  const values = readArray(value, label);
  const facets = [];
  const tags = new Set();
  for (const value of values) {
    const facet = readPlainObject(value, "tag facet");
    const tag = readNonEmptyString(facet.tag, "tag facet name");
    if (tags.has(tag)) {
      throw new Error(`The tag facet ${tag} appears more than once.`);
    }
    tags.add(tag);
    facets.push({
      count: readNonNegativeInteger(facet.count, "tag facet count"),
      tag,
    });
  }
  return facets;
}

export function readDocumentVersions(value) {
  const values = readArray(value, "document versions");
  const versions = [];
  const versionIds = new Set();
  for (const value of values) {
    const version = readPlainObject(value, "document version");
    const id = readUuid(version.id, "document version ID");
    if (versionIds.has(id)) {
      throw new Error(`The document version ${id} appears more than once.`);
    }
    versionIds.add(id);
    const elementCount = readPositiveInteger(
      version.elementCount,
      "document version element count",
    );
    versions.push({
      createdAt: readTimestamp(
        version.createdAt,
        "document version created time",
      ),
      documentId: readNonEmptyString(
        version.documentId,
        "versioned document ID",
      ),
      elementCount,
      id,
      pageCount: readNullablePositiveInteger(
        version.pageCount,
        "document version page count",
      ),
      sourceFile: readNonEmptyString(
        version.sourceFile,
        "document version source file",
      ),
      version: readPositiveInteger(version.version, "document version number"),
    });
  }
  return versions;
}

function readDocumentVersionDifference(value) {
  const difference = readPlainObject(value, "document version difference");
  const modifiedValues = readArray(
    difference.modified,
    "modified document elements",
  );
  for (const value of modifiedValues) {
    const modified = readPlainObject(value, "modified document element");
    readNonEmptyString(
      modified.currentElementId,
      "current modified element ID",
    );
    readNonEmptyString(
      modified.previousElementId,
      "previous modified element ID",
    );
  }
  return {
    added: readUniqueStringArray(
      difference.addedElementIds,
      "added document element IDs",
      true,
    ).length,
    currentVersionId: readUuid(
      difference.currentVersionId,
      "current comparison version ID",
    ),
    modified: modifiedValues.length,
    previousVersionId: readUuid(
      difference.previousVersionId,
      "previous comparison version ID",
    ),
    removed: readUniqueStringArray(
      difference.removedElementIds,
      "removed document element IDs",
      true,
    ).length,
  };
}

function readRetryResponse(value) {
  const response = readPlainObject(value, "retry ingestion");
  return {
    phase: readEnum(response.phase, ingestionPhases, "retry ingestion phase"),
    sourceFile: readNonEmptyString(
      response.sourceFile,
      "retry ingestion source file",
    ),
    state: readLiteral(response.state, "pending", "retry ingestion state"),
    updatedAt: readTimestamp(response.updatedAt, "retry ingestion updated time"),
  };
}

export function readIngestionControlResponse(value) {
  const response = readPlainObject(value, "ingestion control");
  return {
    action: readEnum(
      response.action,
      ["pause", "resume", "cancel"],
      "ingestion control action",
    ),
    sourceFile: readNonEmptyString(
      response.sourceFile,
      "ingestion control source file",
    ),
    state: readEnum(
      response.state,
      ["pending", "running", "canceled", ...ingestionControlStates],
      "ingestion control state",
    ),
  };
}

function readReindexResponse(value) {
  const response = readPlainObject(value, "document reindex");
  return {
    documentId: readNonEmptyString(
      response.documentId,
      "reindexed document ID",
    ),
    sourceFile: readNonEmptyString(
      response.sourceFile,
      "reindexed document source file",
    ),
    status: readLiteral(response.status, "queued", "document reindex status"),
  };
}

function readUpdateTagsResponse(value) {
  const response = readPlainObject(value, "document tag update");
  return {
    sourceFile: readNonEmptyString(
      response.sourceFile,
      "tagged document source file",
    ),
    tags: readUniqueStringArray(response.tags, "updated document tags", true),
  };
}

function readDeleteResponse(value) {
  const response = readPlainObject(value, "document deletion");
  return {
    kind: readLiteral(response.kind, "deleted", "document deletion result"),
    sourceFile: readNonEmptyString(response.sourceFile, "deleted document source file"),
  };
}

function readDocumentRetryState(document, status, errorMessage) {
  const attemptCount = readNullableNonNegativeInteger(
    document.attemptCount,
    "document attempt count",
  );
  const maxAttempts = readNullablePositiveInteger(
    document.maxAttempts,
    "document maximum attempts",
  );
  const nextAttemptAt = readNullableTimestamp(
    document.nextAttemptAt,
    "document next attempt time",
  );
  if (status === "ready") {
    if (attemptCount !== null || maxAttempts !== null || nextAttemptAt !== null) {
      throw new Error("The ready document retry state is invalid.");
    }
    return { failureContext: "", failureHeading: "" };
  }
  if (attemptCount === null || maxAttempts === null || nextAttemptAt === null) {
    throw new Error("The ingestion retry state is incomplete.");
  }
  if (attemptCount > maxAttempts) {
    throw new Error("The ingestion attempt count is invalid.");
  }
  if (errorMessage === null) {
    return { failureContext: "", failureHeading: "" };
  }
  if (status === "failed") {
    return {
      failureContext: `Ingestion failed after ${attemptCount} of ${maxAttempts} attempts.`,
      failureHeading: "Failure details",
    };
  }
  if (status === "running") {
    return {
      failureContext: `Attempt ${attemptCount} of ${maxAttempts} failed. A new attempt is running.`,
      failureHeading: "Previous attempt",
    };
  }
  return {
    failureContext: `Attempt ${attemptCount} of ${maxAttempts} failed. Retry queued for ${exactDateFormatter.format(new Date(nextAttemptAt))}.`,
    failureHeading: "Last attempt failed",
  };
}

function readNullableEnum(value, allowedValues, label) {
  if (value === null) {
    return null;
  }
  return readEnum(value, allowedValues, label);
}

function readLiteral(value, expected, label) {
  if (value !== expected) {
    throw new Error(`The ${label} response is invalid.`);
  }
  return expected;
}

function readPageSize(value) {
  if (!pageSizes.includes(value)) {
    throw new Error("The catalog page size response is invalid.");
  }
  return value;
}

function readUuid(value, label) {
  const id = readNonEmptyString(value, label);
  const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (!pattern.test(id)) {
    throw new Error(`The ${label} response is invalid.`);
  }
  return id;
}

function readNullableUuid(value, label) {
  if (value === null) {
    return null;
  }
  return readUuid(value, label);
}

function readUniqueStringArray(value, label, requireNonEmpty) {
  const values = readArray(value, label);
  const strings = [];
  const uniqueStrings = new Set();
  for (const value of values) {
    const string = requireNonEmpty
      ? readNonEmptyString(value, label)
      : readString(value, label);
    if (uniqueStrings.has(string)) {
      throw new Error(`The ${label} response contains a duplicate value.`);
    }
    uniqueStrings.add(string);
    strings.push(string);
  }
  return strings;
}

function requestDashboardRefresh() {
  window.dispatchEvent(new CustomEvent("citeloom:dashboard-refresh-request"));
}

function requestDocumentsRefresh() {
  window.dispatchEvent(new CustomEvent("citeloom:documents-revision", {
    detail: "document-action",
  }));
}

function createInspectorDisclosureState() {
  return {
    indexedContent: true,
    source: true,
    tags: false,
    version: false,
  };
}

export function registerPage(alpine) {
  alpine.data("citeloomDocumentsPage", () => ({
    actionKind: null,
    actionSourceFile: null,
    actionConfirmation: null,
    attentionOpen: true,
    catalog: null,
    catalogController: null,
    catalogRefreshTimerId: null,
    collection: "all",
    copyResetTimerId: null,
    copyState: "idle",
    currentTimeMs: Date.now(),
    destroyed: false,
    detailsOpen: false,
    documentsRevisionListener: null,
    elapsedTimerId: null,
    inspectorDisclosures: createInspectorDisclosureState(),
    loadErrorMessage: "",
    loading: true,
    notificationSourceFiles: [],
    notificationStateListener: null,
    page: 1,
    pageSize: 25,
    search: "",
    searchInput: "",
    searchTimerId: null,
    selectedDocument: null,
    selectionSearch: "",
    sort: "updated-desc",
    status: "all",
    tagFilter: "",
    tagDraft: "",
    tagDrafts: [],
    tagErrorMessage: "",
    versionController: null,
    versionDifference: null,
    versionErrorMessage: "",
    versionLoading: false,
    versions: [],
    visibilityListener: null,

    get attentionDocuments() {
      return this.catalog?.attention.documents ?? [];
    },

    get attentionTotal() {
      return this.catalog?.attention.total ?? 0;
    },

    get catalogDocuments() {
      return this.catalog?.documents ?? [];
    },

    get collectionLabel() {
      return readCollectionLabel(this.collection);
    },

    get collections() {
      return buildCollections(this.facets);
    },

    get facets() {
      return this.catalog?.facets ?? emptyFacets;
    },

    get firstResult() {
      if (this.total === 0) {
        return 0;
      }
      return ((this.page - 1) * this.pageSize) + 1;
    },

    get lastResult() {
      return Math.min(this.page * this.pageSize, this.total);
    },

    get lowDocumentCount() {
      return this.total <= 5;
    },

    get pageNumbers() {
      return buildPageNumbers(this.page, this.totalPages);
    },

    get readyPageDocuments() {
      const documents = [];
      for (const document of this.catalogDocuments) {
        if (document.queryStatus === "ready") {
          documents.push(document);
        }
      }
      return documents;
    },

    get total() {
      return this.catalog?.total ?? 0;
    },

    get totalPages() {
      return Math.max(1, Math.ceil(this.total / this.pageSize));
    },

    init() {
      this.documentsRevisionListener = () => {
        this.scheduleCatalogRefresh();
      };
      window.addEventListener(
        "citeloom:documents-revision",
        this.documentsRevisionListener,
      );
      this.notificationStateListener = (event) => {
        if (!(event instanceof CustomEvent)) {
          return;
        }
        let state;
        try {
          state = readDocumentNotificationState(event.detail);
        } catch {
          return;
        }
        this.updateDocumentNotificationState(state);
      };
      window.addEventListener(
        DOCUMENT_NOTIFICATION_STATE_EVENT,
        this.notificationStateListener,
      );
      this.visibilityListener = () => {
        this.syncElapsedTimer();
      };
      document.addEventListener("visibilitychange", this.visibilityListener);
      void this.loadCatalog();
    },

    destroy() {
      this.destroyed = true;
      this.catalogController?.abort();
      this.versionController?.abort();
      if (this.copyResetTimerId !== null) {
        window.clearTimeout(this.copyResetTimerId);
      }
      if (this.catalogRefreshTimerId !== null) {
        window.clearTimeout(this.catalogRefreshTimerId);
      }
      if (this.elapsedTimerId !== null) {
        window.clearInterval(this.elapsedTimerId);
      }
      if (this.searchTimerId !== null) {
        window.clearTimeout(this.searchTimerId);
      }
      if (this.documentsRevisionListener !== null) {
        window.removeEventListener(
          "citeloom:documents-revision",
          this.documentsRevisionListener,
        );
      }
      if (this.notificationStateListener !== null) {
        window.removeEventListener(
          DOCUMENT_NOTIFICATION_STATE_EVENT,
          this.notificationStateListener,
        );
      }
      if (this.visibilityListener !== null) {
        document.removeEventListener("visibilitychange", this.visibilityListener);
      }
    },

    scheduleCatalogRefresh() {
      if (this.catalogRefreshTimerId !== null) {
        return;
      }
      this.catalogRefreshTimerId = window.setTimeout(() => {
        this.catalogRefreshTimerId = null;
        void this.loadCatalog();
      }, catalogRefreshDebounceMs);
    },

    syncElapsedTimer() {
      let hasRunningDocument = false;
      for (const document of this.attentionDocuments) {
        if (document.displayStatus === "running") {
          hasRunningDocument = true;
          break;
        }
      }
      const shouldRun = hasRunningDocument && !document.hidden;
      if (shouldRun && this.elapsedTimerId === null) {
        this.currentTimeMs = Date.now();
        this.elapsedTimerId = window.setInterval(() => {
          this.currentTimeMs = Date.now();
        }, 1_000);
        return;
      }
      if (!shouldRun && this.elapsedTimerId !== null) {
        window.clearInterval(this.elapsedTimerId);
        this.elapsedTimerId = null;
      }
    },

    async loadCatalog() {
      if (this.catalogRefreshTimerId !== null) {
        window.clearTimeout(this.catalogRefreshTimerId);
        this.catalogRefreshTimerId = null;
      }
      this.catalogController?.abort();
      const controller = new AbortController();
      this.catalogController = controller;
      this.loading = true;
      const parameters = new URLSearchParams({
        collection: this.collection,
        page: String(this.page),
        pageSize: String(this.pageSize),
        search: this.search,
        sort: this.sort,
        status: this.status,
        tag: this.tagFilter,
      });
      try {
        const response = await fetch(`/api/documents?${parameters.toString()}`, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        const catalog = await readJsonResponse(
          response,
          "Document catalog request",
          readDocumentCatalog,
        );
        if (controller.signal.aborted) {
          return;
        }
        this.catalog = catalog;
        this.syncElapsedTimer();
        this.loadErrorMessage = "";
        if (this.page > this.totalPages) {
          this.page = this.totalPages;
          void this.loadCatalog();
          return;
        }
        const nextDocument = readNextSelectedDocument(
          this.selectedDocument,
          catalog,
        );
        this.updateSelectedDocument(nextDocument);
      } catch (error) {
        if (!controller.signal.aborted) {
          this.loadErrorMessage = error instanceof Error
            ? error.message
            : "The document catalog could not be loaded.";
        }
      } finally {
        if (this.catalogController === controller) {
          this.catalogController = null;
          this.loading = false;
        }
      }
    },

    scheduleSearch() {
      if (this.searchTimerId !== null) {
        window.clearTimeout(this.searchTimerId);
      }
      this.searchTimerId = window.setTimeout(() => {
        this.searchTimerId = null;
        const search = this.searchInput.trim().toLocaleLowerCase();
        if (search === this.search) {
          return;
        }
        this.search = search;
        this.page = 1;
        void this.loadCatalog();
      }, searchDebounceMs);
    },

    chooseCollection(collection) {
      const tagCollection = typeof collection === "string"
        && collection.startsWith("tag:")
        && collection.slice(4).trim() !== "";
      if (
        collection !== "all"
        && collection !== "uploads"
        && collection !== "untagged"
        && !tagCollection
      ) {
        return;
      }
      this.collection = collection;
      this.status = "all";
      this.page = 1;
      void this.loadCatalog();
    },

    chooseStatus(status) {
      if (!catalogStatuses.includes(status)) {
        return;
      }
      this.status = status;
      this.page = 1;
      void this.loadCatalog();
    },

    chooseTag(tag) {
      this.tagFilter = tag;
      this.page = 1;
      void this.loadCatalog();
    },

    chooseSort(sort) {
      if (!catalogSorts.includes(sort)) {
        return;
      }
      this.sort = sort;
      this.page = 1;
      void this.loadCatalog();
    },

    choosePageSize(pageSize) {
      const value = Number(pageSize);
      if (!pageSizes.includes(value)) {
        return;
      }
      this.pageSize = value;
      this.page = 1;
      void this.loadCatalog();
    },

    choosePage(page) {
      if (!Number.isInteger(page) || page < 1 || page > this.totalPages) {
        return;
      }
      this.page = page;
      void this.loadCatalog();
    },

    collectionActive(collection) {
      return this.collection === collection && this.status === "all";
    },

    statusFilterActive(status) {
      return this.status === status;
    },

    attentionLabel() {
      if (this.facets.failed > 0 && this.facets.processing > 0) {
        return "Processing and needs attention";
      }
      if (this.facets.processing > 0) {
        return "Processing";
      }
      return "Needs attention";
    },

    attentionClass() {
      if (this.facets.failed === 0 && this.facets.processing > 0) {
        return "attention-queue processing";
      }
      return "attention-queue";
    },

    attentionProcessing(document) {
      return document.displayStatus === "pending"
        || document.displayStatus === "running";
    },

    attentionRunning(document) {
      return document.displayStatus === "running";
    },

    embeddingProgressDeterminate(document) {
      return document.embeddingProgress.state !== "not-started";
    },

    embeddingProgressStyle(document) {
      const progress = document.embeddingProgress;
      if (progress.state === "not-started") {
        return "";
      }
      if (progress.totalElements === 0) {
        return "width: 100%";
      }
      const percentage = Math.floor(
        (progress.completedElements / progress.totalElements) * 100,
      );
      return `width: ${percentage}%`;
    },

    embeddingProgressDetail(document) {
      return readEmbeddingProgressDetail(document.embeddingProgress)
        ?? "Waiting for the first completed embedding batch";
    },

    embeddingProgressVisible(document) {
      return document.phase === "normalized"
        && document.status !== "ready";
    },

    mediaProgressDetail(document, kind) {
      return readMediaProgressDetail(document, kind);
    },

    mediaProgressStyle(document, kind) {
      const progress = readMediaProgress(document, kind);
      if (progress.total === 0) {
        return "width: 100%";
      }
      const percentage = Math.floor(
        (progress.completed / progress.total) * 100,
      );
      return `width: ${percentage}%`;
    },

    mediaProgressVisible(document, kind) {
      const progress = readMediaProgress(document, kind);
      return this.embeddingProgressVisible(document) && progress.total > 0;
    },

    elapsedDuration(document) {
      return formatElapsedDuration(document.updatedAt, this.currentTimeMs);
    },

    documentUpdated(document) {
      return formatRelativeTime(document.updatedAt);
    },

    displayCount(value) {
      return formatCount(value);
    },

    collectionIcon(collection) {
      if (collection === "uploads") {
        return "./assets/images/citeloom-icons.svg#citeloom-upload";
      }
      if (collection === "untagged" || collection.startsWith("tag:")) {
        return "./assets/images/citeloom-icons.svg#citeloom-stack";
      }
      return "./assets/images/citeloom-icons.svg#citeloom-documents";
    },

    documentIcon() {
      return "./assets/images/citeloom-icons.svg#citeloom-documents";
    },

    documentNotificationAvailable(document) {
      if (document === null) {
        return false;
      }
      return document.queryStatus !== "ready"
        && (document.status === "pending" || document.status === "running");
    },

    documentNotificationEnabled(document) {
      if (document === null) {
        return false;
      }
      return this.notificationSourceFiles.includes(document.sourceFile);
    },

    documentNotificationLabel(document) {
      return this.documentNotificationEnabled(document)
        ? "Notification set"
        : "Notify me when ready";
    },

    updateDocumentNotificationState(state) {
      const sourceFiles = [];
      for (const sourceFile of this.notificationSourceFiles) {
        if (sourceFile !== state.sourceFile) {
          sourceFiles.push(sourceFile);
        }
      }
      if (state.enabled) {
        sourceFiles.push(state.sourceFile);
      }
      sourceFiles.sort();
      this.notificationSourceFiles = sourceFiles;
    },

    requestDocumentNotificationState(document) {
      window.dispatchEvent(new CustomEvent(
        DOCUMENT_NOTIFICATION_REQUEST_EVENT,
        { detail: { sourceFile: document.sourceFile } },
      ));
    },

    toggleDocumentNotification(document) {
      if (document === null) {
        return;
      }
      const enabled = !this.documentNotificationEnabled(document);
      this.setDocumentNotification(document, enabled);
    },

    setDocumentNotification(document, enabled) {
      if (document === null) {
        return;
      }
      window.dispatchEvent(new CustomEvent(
        DOCUMENT_NOTIFICATION_CHANGE_EVENT,
        {
          detail: {
            documentId: document.documentId,
            enabled,
            filename: document.filename,
            sourceFile: document.sourceFile,
          },
        },
      ));
    },

    updateSelectedDocument(document) {
      const previousSourceFile = this.selectedDocument?.sourceFile ?? null;
      const previousStatus = this.selectedDocument?.status ?? null;
      const previousQueryStatus = this.selectedDocument?.queryStatus ?? null;
      const previousVersionId = this.selectedDocument?.activeVersionId ?? null;
      this.selectedDocument = document;
      const nextSourceFile = document?.sourceFile ?? null;
      const nextStatus = document?.status ?? null;
      const nextQueryStatus = document?.queryStatus ?? null;
      const nextVersionId = document?.activeVersionId ?? null;
      if (
        previousSourceFile === nextSourceFile
        && previousStatus === nextStatus
        && previousQueryStatus === nextQueryStatus
        && previousVersionId === nextVersionId
      ) {
        return;
      }
      this.copyState = "idle";
      this.actionConfirmation = null;
      this.detailsOpen = false;
      this.inspectorDisclosures = createInspectorDisclosureState();
      this.tagDraft = "";
      this.tagDrafts = document === null ? [] : [...document.tags];
      this.tagErrorMessage = "";
      this.versionDifference = null;
      this.versionErrorMessage = "";
      this.versionLoading = false;
      this.versions = [];
      const previousVersionController = this.versionController;
      this.versionController = null;
      previousVersionController?.abort();
      if (this.copyResetTimerId !== null) {
        window.clearTimeout(this.copyResetTimerId);
        this.copyResetTimerId = null;
      }
      if (document !== null && document.activeVersionId !== null) {
        void this.loadDocumentVersions(document);
      }
      if (document !== null) {
        this.requestDocumentNotificationState(document);
      }
    },

    selectDocument(document) {
      this.updateSelectedDocument(document);
    },

    closeInspector() {
      this.updateSelectedDocument(null);
    },

    addTagDraft() {
      const tag = this.tagDraft.trim().toLowerCase();
      if (tag === "") {
        return;
      }
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(tag) || tag.length > 64) {
        this.tagErrorMessage = "Use up to 64 letters, numbers, dots, dashes, or underscores.";
        return;
      }
      if (this.tagDrafts.length >= 20) {
        this.tagErrorMessage = "A document can have up to 20 tags.";
        return;
      }
      if (!this.tagDrafts.includes(tag)) {
        this.tagDrafts.push(tag);
        this.tagDrafts.sort();
      }
      this.tagDraft = "";
      this.tagErrorMessage = "";
    },

    removeTagDraft(tag) {
      this.tagDrafts = this.tagDrafts.filter((candidate) => candidate !== tag);
      this.tagErrorMessage = "";
    },

    tagsChanged(document) {
      return document.tags.join("\u0000") !== this.tagDrafts.join("\u0000");
    },

    async saveDocumentTags(document) {
      if (
        this.actionKind !== null
        || documentActionInProgress
        || document.activeDocumentId === null
      ) {
        return;
      }
      this.addTagDraft();
      if (this.tagErrorMessage !== "" || !this.tagsChanged(document)) {
        return;
      }
      documentActionInProgress = true;
      this.actionKind = "tags";
      this.actionSourceFile = document.sourceFile;
      try {
        const response = await fetch(
          `/api/documents/${encodeURIComponent(document.activeDocumentId)}/tags`,
          {
            body: JSON.stringify({
              sourceFile: document.sourceFile,
              tags: this.tagDrafts,
            }),
            headers: {
              accept: "application/json",
              "content-type": "application/json",
            },
            method: "PUT",
          },
        );
        const result = await readJsonResponse(
          response,
          "Document tag update request",
          readUpdateTagsResponse,
        );
        document.tags = result.tags;
        this.tagDrafts = [...result.tags];
        dispatchNotice("success", `Updated tags for ${document.filename}.`);
        requestDashboardRefresh();
        await this.loadCatalog();
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error
            ? error.message
            : "Document tags could not be updated.",
        );
      } finally {
        documentActionInProgress = false;
        this.actionKind = null;
        this.actionSourceFile = null;
      }
    },

    async loadDocumentVersions(document) {
      this.versionController?.abort();
      const controller = new AbortController();
      this.versionController = controller;
      this.versionLoading = true;
      try {
        const parameters = new URLSearchParams({
          sourceFile: document.sourceFile,
        });
        const response = await fetch(
          `/api/document-versions?${parameters.toString()}`,
          {
            headers: { accept: "application/json" },
            signal: controller.signal,
          },
        );
        const versions = await readJsonResponse(
          response,
          "Document versions request",
          readDocumentVersions,
        );
        if (controller.signal.aborted) {
          return;
        }
        this.versions = versions;
        const currentIndex = versions.findIndex((version) => {
          return version.id === document.activeVersionId;
        });
        const previous = versions[currentIndex + 1];
        if (previous === undefined) {
          return;
        }
        const comparisonParameters = new URLSearchParams({
          current: document.activeVersionId,
          previous: previous.id,
        });
        const comparisonResponse = await fetch(
          `/api/document-versions/compare?${comparisonParameters.toString()}`,
          {
            headers: { accept: "application/json" },
            signal: controller.signal,
          },
        );
        const difference = await readJsonResponse(
          comparisonResponse,
          "Document version comparison",
          readDocumentVersionDifference,
        );
        if (!controller.signal.aborted) {
          this.versionDifference = difference;
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          this.versionErrorMessage = error instanceof Error
            ? error.message
            : "Document versions could not be loaded.";
        }
      } finally {
        if (this.versionController === controller) {
          this.versionController = null;
          this.versionLoading = false;
        }
      }
    },

    async copySource() {
      if (this.selectedDocument === null) {
        return;
      }
      try {
        await navigator.clipboard.writeText(this.selectedDocument.sourceFile);
        this.copyState = "copied";
        if (this.copyResetTimerId !== null) {
          window.clearTimeout(this.copyResetTimerId);
        }
        this.copyResetTimerId = window.setTimeout(() => {
          this.copyResetTimerId = null;
          this.copyState = "idle";
        }, 1_800);
      } catch {
        this.copyState = "idle";
        dispatchNotice("error", "The source path could not be copied.");
      }
    },

    pageSelectionState(questionDocuments) {
      const cached = pageSelectionCaches.get(this);
      if (
        cached !== undefined
        && cached.catalog === this.catalog
        && cached.questionDocuments === questionDocuments
      ) {
        return cached.value;
      }
      const selectedSourceFiles = new Set();
      for (const document of questionDocuments) {
        selectedSourceFiles.add(document.sourceFile);
      }
      let selectedCount = 0;
      const readyPageDocuments = this.readyPageDocuments;
      for (const document of readyPageDocuments) {
        if (selectedSourceFiles.has(document.sourceFile)) {
          selectedCount += 1;
        }
      }
      const readyCount = readyPageDocuments.length;
      const value = {
        all: readyCount > 0 && selectedCount === readyCount,
        some: selectedCount > 0 && selectedCount < readyCount,
      };
      pageSelectionCaches.set(this, {
        catalog: this.catalog,
        questionDocuments,
        value,
      });
      return value;
    },

    filteredQuestionDocuments(questionDocuments) {
      const search = this.selectionSearch.trim().toLocaleLowerCase();
      const cached = selectionSearchCaches.get(this);
      if (
        cached !== undefined
        && cached.search === search
        && cached.questionDocuments === questionDocuments
      ) {
        return cached.value;
      }
      let value;
      if (search === "") {
        value = questionDocuments;
      } else {
        const documents = [];
        for (const document of questionDocuments) {
          if (readBasename(document.sourceFile).toLocaleLowerCase().includes(search)) {
            documents.push(document);
          }
        }
        value = documents;
      }
      selectionSearchCaches.set(this, {
        questionDocuments,
        search,
        value,
      });
      return value;
    },

    phaseStages(document) {
      return buildPhaseStages(document);
    },

    completedPhaseCount(document) {
      const stages = buildPhaseStages(document);
      let completed = 0;
      for (const stage of stages) {
        if (stage.state === "complete") {
          completed += 1;
        }
      }
      return completed;
    },

    formatExactDate(value) {
      return formatExactDate(value);
    },

    formatByteLength(value) {
      return formatByteLength(value);
    },

    versionFileUrl(versionId) {
      return `/api/document-versions/${encodeURIComponent(versionId)}/file`;
    },

    retryLabel(document) {
      if (this.actionKind === "retry" && this.actionSourceFile === document.sourceFile) {
        return "Retrying";
      }
      return `Retry from ${readRetryPhase(document)}`;
    },

    reindexLabel(document) {
      if (this.actionKind === "reindex" && this.actionSourceFile === document.sourceFile) {
        return "Requesting reindex";
      }
      return "Reindex document";
    },

    async controlIngestion(document, action) {
      if (
        this.actionKind !== null
        || documentActionInProgress
        || (
          action !== "cancel"
          && document.status !== "pending"
          && document.status !== "running"
        )
      ) {
        return;
      }
      documentActionInProgress = true;
      this.actionConfirmation = null;
      this.actionKind = action;
      this.actionSourceFile = document.sourceFile;
      try {
        const response = await fetch(`/api/ingestion-jobs/${action}`, {
          body: JSON.stringify({ sourceFile: document.sourceFile }),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          method: "POST",
        });
        const result = await readJsonResponse(
          response,
          `${action} ingestion request`,
          readIngestionControlResponse,
        );
        if (result.action === "cancel") {
          this.setDocumentNotification(document, false);
        }
        const verb = result.action === "resume"
          ? "Resumed"
          : result.action === "pause"
            ? "Pause requested for"
            : "Cancellation requested for";
        dispatchNotice("success", `${verb} ${readBasename(result.sourceFile)}.`);
        requestDashboardRefresh();
        await this.loadCatalog();
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error ? error.message : `Document ${action} failed.`,
        );
      } finally {
        documentActionInProgress = false;
        this.actionKind = null;
        this.actionSourceFile = null;
      }
    },

    async retryDocument(document) {
      if (
        this.actionKind !== null
        || documentActionInProgress
        || document.status !== "failed"
      ) {
        return;
      }
      documentActionInProgress = true;
      this.actionKind = "retry";
      this.actionSourceFile = document.sourceFile;
      try {
        const response = await fetch("/api/ingestion-jobs/retry", {
          body: JSON.stringify({ sourceFile: document.sourceFile }),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          method: "POST",
        });
        const result = await readJsonResponse(
          response,
          "Retry ingestion request",
          readRetryResponse,
        );
        dispatchNotice(
          "success",
          `Queued ${readBasename(result.sourceFile)} from the ${result.phase} phase.`,
        );
        requestDashboardRefresh();
        if (this.destroyed) {
          requestDocumentsRefresh();
        } else {
          await this.loadCatalog();
        }
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error ? error.message : "Document retry failed.",
        );
      } finally {
        documentActionInProgress = false;
        this.actionKind = null;
        this.actionSourceFile = null;
      }
    },

    async reindexDocument(document) {
      if (
        this.actionKind !== null
        || documentActionInProgress
        || document.status !== "ready"
      ) {
        return;
      }
      documentActionInProgress = true;
      this.actionConfirmation = null;
      this.actionKind = "reindex";
      this.actionSourceFile = document.sourceFile;
      try {
        const response = await fetch(
          `/api/documents/${encodeURIComponent(document.documentId)}/reindex`,
          {
            body: JSON.stringify({ sourceFile: document.sourceFile }),
            headers: {
              accept: "application/json",
              "content-type": "application/json",
            },
            method: "POST",
          },
        );
        const result = await readJsonResponse(
          response,
          "Document reindex request",
          readReindexResponse,
        );
        dispatchNotice(
          "success",
          `Reindex requested for ${readBasename(result.sourceFile)}.`,
        );
        requestDashboardRefresh();
        if (this.destroyed) {
          requestDocumentsRefresh();
        } else {
          await this.loadCatalog();
        }
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error ? error.message : "Document reindex failed.",
        );
      } finally {
        documentActionInProgress = false;
        this.actionKind = null;
        this.actionSourceFile = null;
      }
    },

    async deleteDocument(document) {
      if (
        this.actionKind !== null
        || documentActionInProgress
        || document.status === "pending"
        || document.status === "running"
      ) {
        return;
      }
      documentActionInProgress = true;
      this.actionConfirmation = null;
      this.actionKind = "delete";
      this.actionSourceFile = document.sourceFile;
      try {
        const response = await fetch(
          `/api/documents/${encodeURIComponent(document.documentId)}`,
          {
            body: JSON.stringify({ sourceFile: document.sourceFile }),
            headers: {
              accept: "application/json",
              "content-type": "application/json",
            },
            method: "DELETE",
          },
        );
        const result = await readJsonResponse(
          response,
          "Document deletion request",
          readDeleteResponse,
        );
        this.setDocumentNotification(document, false);
        this.selectedDocument = null;
        this.detailsOpen = false;
        this.inspectorDisclosures = createInspectorDisclosureState();
        dispatchNotice(
          "success",
          `Deleted ${readBasename(result.sourceFile)} from CiteLoom.`,
        );
        requestDashboardRefresh();
        await this.loadCatalog();
      } catch (error) {
        dispatchNotice(
          "error",
          error instanceof Error ? error.message : "Document deletion failed.",
        );
      } finally {
        documentActionInProgress = false;
        this.actionKind = null;
        this.actionSourceFile = null;
      }
    },
  }));
}
