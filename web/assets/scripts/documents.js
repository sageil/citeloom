import {
  readArray,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readNullablePositiveInteger,
  readPlainObject,
  readPositiveInteger,
  readTimestamp,
} from "./boundary-readers.js";
import {
  DOCUMENT_NOTIFICATION_CHANGE_EVENT,
  DOCUMENT_NOTIFICATION_REQUEST_EVENT,
  DOCUMENT_NOTIFICATION_STATE_EVENT,
  readDocumentNotificationState,
} from "./document-notifications.js";
import {
  catalogSorts,
  catalogStatuses,
  ingestionControlStates,
  ingestionPhases,
  pageSizes,
  readDocumentCatalog,
  readUniqueStringArray,
  readUuid,
} from "./document-catalog-schema.js";
import {
  buildCollections,
  buildPageNumbers,
  buildPhaseStages,
  formatByteLength,
  formatCount,
  formatElapsedDuration,
  formatExactDate,
  formatRelativeTime,
  readBasename,
  readIndexingActivityDetail,
  readIndexingActivityLabel,
  readNextSelectedDocument,
  readRetryPhase,
} from "./document-presentation.js";
import {
  buildSourceLibraryViewUrl,
  readSourceLibrarySummaries,
} from "./source-libraries.js";

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

function readLiteral(value, expected, label) {
  if (value !== expected) {
    throw new Error(`The ${label} response is invalid.`);
  }
  return expected;
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
    tags: false,
    version: false,
  };
}

function readProgressStyle(completed, total) {
  if (total === 0) {
    return "width: 0%";
  }
  const percentage = Math.floor((completed / total) * 100);
  return `width: ${percentage}%`;
}

function readIndexingProgressMaximum(document) {
  if (document.indexingActivity === "describing") {
    return document.images + document.tables;
  }
  return document.totalElements;
}

function readIndexingProgressValue(document) {
  if (document.indexingActivity === "describing") {
    return document.mediaDescriptionProgress.completedImages
      + document.mediaDescriptionProgress.completedTables;
  }
  if (document.embeddingProgress.state === "not-started") {
    return 0;
  }
  return document.embeddingProgress.completedElements;
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
    notificationErrorsBySourceFile: {},
    notificationSourceFiles: [],
    notificationStateListener: null,
    page: 1,
    pageSize: 25,
    search: "",
    searchInput: "",
    searchTimerId: null,
    selectedDocument: null,
    selectionSearch: "",
    sharedSourceLibraries: [],
    sort: "updated-desc",
    sourceLibraryAccessById: {},
    sourceLibraryId: null,
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

    async init() {
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
      const sourceLibraryAvailable = await this.loadSourceLibraryContext();
      if (!sourceLibraryAvailable) {
        this.loading = false;
        return;
      }
      await this.loadCatalog();
    },

    async loadSourceLibraryContext() {
      const parameters = new URLSearchParams(window.location.search);
      const requestedLibraryId = parameters.get("source-library");
      const hasRequestedLibrary = requestedLibraryId !== null
        && requestedLibraryId.trim() !== "";
      this.sourceLibraryId = hasRequestedLibrary ? requestedLibraryId : null;
      try {
        const response = await fetch("/api/source-libraries", {
          headers: { accept: "application/json" },
        });
        const libraries = await readJsonResponse(
          response,
          "Source library request",
          readSourceLibrarySummaries,
        );
        const accessById = {};
        const sharedLibraries = [];
        let selectedLibraryAvailable = false;
        for (const library of libraries) {
          accessById[library.id] = library.access;
          if (library.kind === "shared") {
            sharedLibraries.push(library);
          }
          if (library.id === requestedLibraryId) {
            selectedLibraryAvailable = true;
          }
        }
        this.sharedSourceLibraries = sharedLibraries;
        this.sourceLibraryAccessById = accessById;
        if (!hasRequestedLibrary) {
          return true;
        }
        if (selectedLibraryAvailable) {
          return true;
        }
        this.loadErrorMessage = "The selected source library is unavailable.";
        return false;
      } catch (error) {
        this.loadErrorMessage = error instanceof Error
          ? error.message
          : "The selected source library could not be loaded.";
        return false;
      }
    },

    canManageDocument(document) {
      if (document.sourceLibraryId === null) {
        return this.currentDataScope === "all";
      }
      return this.sourceLibraryAccessById[document.sourceLibraryId] === "manage";
    },

    selectSharedSource(libraryId) {
      if (this.sourceLibraryId === libraryId) {
        const location = new URL(window.location.href);
        location.searchParams.delete("source-library");
        window.location.assign(location);
        return;
      }
      window.location.assign(
        buildSourceLibraryViewUrl("documents", libraryId),
      );
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
      if (this.sourceLibraryId !== null) {
        parameters.set("sourceLibraryId", this.sourceLibraryId);
      }
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

    indexingProgressDeterminate(document) {
      if (readIndexingProgressMaximum(document) === 0) {
        return false;
      }
      if (document.displayStatus !== "running") {
        return true;
      }
      if (document.indexingActivity === "describing") {
        return document.images + document.tables > 0;
      }
      if (document.indexingActivity === "embedding") {
        return document.totalElements > 0;
      }
      return false;
    },

    indexingProgressMaximum(document) {
      return readIndexingProgressMaximum(document);
    },

    indexingProgressValue(document) {
      return readIndexingProgressValue(document);
    },

    indexingProgressStyle(document) {
      return readProgressStyle(
        readIndexingProgressValue(document),
        readIndexingProgressMaximum(document),
      );
    },

    indexingActivityLabel(document) {
      return readIndexingActivityLabel(document);
    },

    indexingActivityDetail(document) {
      return readIndexingActivityDetail(document);
    },

    indexingProgressVisible(document) {
      return document.phase === "normalized"
        && document.status !== "ready";
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
        ? "Browser notification set"
        : "Notify me when ready";
    },

    documentNotificationError(document) {
      if (document === null) {
        return "";
      }
      return this.notificationErrorsBySourceFile[document.sourceFile] ?? "";
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
      const errors = { ...this.notificationErrorsBySourceFile };
      if (state.errorMessage === null) {
        delete errors[state.sourceFile];
      } else {
        errors[state.sourceFile] = state.errorMessage;
      }
      this.notificationErrorsBySourceFile = errors;
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
        requestDashboardRefresh();
        await this.loadCatalog();
      } catch (error) {
        this.loadErrorMessage = error instanceof Error
          ? error.message
          : "Document tags could not be updated.";
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
        this.loadErrorMessage = "The source path could not be copied.";
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
        requestDashboardRefresh();
        await this.loadCatalog();
      } catch (error) {
        this.loadErrorMessage = error instanceof Error
          ? error.message
          : `Document ${action} failed.`;
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
        await readJsonResponse(
          response,
          "Retry ingestion request",
          readRetryResponse,
        );
        requestDashboardRefresh();
        if (this.destroyed) {
          requestDocumentsRefresh();
        } else {
          await this.loadCatalog();
        }
      } catch (error) {
        this.loadErrorMessage = error instanceof Error
          ? error.message
          : "Document retry failed.";
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
        await readJsonResponse(
          response,
          "Document reindex request",
          readReindexResponse,
        );
        requestDashboardRefresh();
        if (this.destroyed) {
          requestDocumentsRefresh();
        } else {
          await this.loadCatalog();
        }
      } catch (error) {
        this.loadErrorMessage = error instanceof Error
          ? error.message
          : "Document reindex failed.";
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
        await readJsonResponse(
          response,
          "Document deletion request",
          readDeleteResponse,
        );
        this.setDocumentNotification(document, false);
        this.selectedDocument = null;
        this.detailsOpen = false;
        this.inspectorDisclosures = createInspectorDisclosureState();
        requestDashboardRefresh();
        await this.loadCatalog();
      } catch (error) {
        this.loadErrorMessage = error instanceof Error
          ? error.message
          : "Document deletion failed.";
      } finally {
        documentActionInProgress = false;
        this.actionKind = null;
        this.actionSourceFile = null;
      }
    },
  }));
}
