import {
  readArray,
  readEnum,
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
} from "./boundary-readers.js";
import {
  combineStatusDetails,
  formatDocumentLocationCount,
  formatExactDate,
  readBasename,
  readContentCountLabel,
  readDocumentStatusCopy,
  readFileType,
  readIndexingProgressDetail,
} from "./document-presentation.js";

export const catalogSorts = Object.freeze([
  "name-asc",
  "name-desc",
  "updated-asc",
  "updated-desc",
]);
export const catalogStatuses = Object.freeze([
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
export const ingestionPhases = Object.freeze([
  "discovered",
  "indexed",
  "normalized",
]);
const indexingActivities = Object.freeze([
  "preparing",
  "describing",
  "embedding",
  "building_outline",
]);
export const ingestionControlStates = Object.freeze([
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
export const pageSizes = Object.freeze([25, 50, 100]);

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
  const indexingActivity = readNullableEnum(
    document.indexingActivity,
    indexingActivities,
    "document indexing activity",
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
    indexingActivity,
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
    indexingActivity,
    phase,
    queryStatus,
  });
  if (controlState === "pause_requested") {
    statusCopy = {
      detail: combineStatusDetails(
        controlError ?? "Stopping the active operation safely",
        readIndexingProgressDetail(embeddingProgress),
      ),
      label: controlError === null ? "Pausing" : "Pause delayed",
    };
  } else if (controlState === "paused") {
    statusCopy = {
      detail: combineStatusDetails(
        "Resume when ready",
        readIndexingProgressDetail(embeddingProgress),
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
    indexingActivity,
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
    sourceLibraryId: readNullableUuid(
      document.sourceLibraryId,
      "document source library ID",
    ),
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
  indexingActivity,
  embeddingProgress,
  mediaDescriptionProgress,
  images,
  tables,
) {
  if ((phase === "normalized") !== (indexingActivity !== null)) {
    throw new Error("Indexing activity does not match the document phase.");
  }
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
    failureContext: `Attempt ${attemptCount} of ${maxAttempts} failed. Retry queued for ${formatExactDate(nextAttemptAt)}.`,
    failureHeading: "Last attempt failed",
  };
}

function readNullableEnum(value, allowedValues, label) {
  if (value === null) {
    return null;
  }
  return readEnum(value, allowedValues, label);
}

export function readPageSize(value) {
  if (!pageSizes.includes(value)) {
    throw new Error("The catalog page size response is invalid.");
  }
  return value;
}

export function readUuid(value, label) {
  const id = readNonEmptyString(value, label);
  const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  if (!pattern.test(id)) {
    throw new Error(`The ${label} response is invalid.`);
  }
  return id;
}

export function readNullableUuid(value, label) {
  if (value === null) {
    return null;
  }
  return readUuid(value, label);
}

export function readUniqueStringArray(value, label, requireNonEmpty) {
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
