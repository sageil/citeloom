import {
  readArray,
  readBoolean,
  readEnum,
  readNonEmptyString,
  readNonNegativeInteger,
  readPlainObject,
  readPositiveInteger,
  readString,
  readTimestamp,
} from "./boundary-readers.js";
import { readSystemHealthDashboard } from "./dashboard-extensions.js";

const workflowPhaseSteps = Object.freeze({ discovered: 1, indexed: 3, normalized: 2 });
const queuePhases = Object.freeze(["discovered", "normalized", "indexed"]);
const queueStates = Object.freeze(["failed", "pending", "running"]);
const ingestionDestinations = Object.freeze(["documents"]);
const documentDisplayStatuses = Object.freeze([
  "failed",
  "pending",
  "ready",
  "reindex-required",
  "running",
]);
const diagnosticCategories = Object.freeze([
  "claim-verification",
  "document-processing",
  "embedding",
  "generation",
  "model-response",
  "persistence",
  "search-ranking",
  "speech-input",
  "spoken-answers",
]);
const diagnosticModes = Object.freeze(["live", "readiness"]);
const recentDocumentLimit = 10;

export function readDashboardSnapshot(value) {
  const dashboard = readPlainObject(value, "dashboard");
  const overview = readOverviewSummary(
    dashboard.documentSummary,
    dashboard.catalog,
    dashboard.maximumDocumentBytes,
    dashboard.maximumUploadRequestBytes,
    dashboard.supportedExtensions,
  );
  const system = readPlainObject(dashboard.system, "dashboard system");
  const queue = readQueueStatuses(system.queue);
  const revisions = readPlainObject(dashboard.revisions, "application revisions");
  const systemHealth = readSystemHealthDashboard(dashboard, system, queue);
  const catalogRevision = readRevision(revisions.catalog, "catalog revision");
  const jobsRevision = readRevision(revisions.jobs, "jobs revision");
  return {
    documentsRevision: `${catalogRevision}.${jobsRevision}`,
    overview,
    systemHealth,
    settingsRevision: readRevision(revisions.settings, "settings revision"),
    workflow: buildWorkflowSnapshot(queue, overview.readyDocuments),
  };
}

function readOverviewSummary(
  summaryValue,
  catalogValue,
  maximumDocumentBytesValue,
  maximumUploadRequestBytesValue,
  extensionValue,
) {
  const summary = readPlainObject(summaryValue, "dashboard document summary");
  const failed = readNonNegativeInteger(summary.failed, "failed document count");
  const processing = readNonNegativeInteger(
    summary.processing,
    "processing document count",
  );
  const queryable = readNonNegativeInteger(summary.queryable, "queryable document count");
  const reindexRequired = readNonNegativeInteger(
    summary.reindexRequired,
    "reindex-required document count",
  );
  return {
    maximumDocumentBytes: readPositiveInteger(
      maximumDocumentBytesValue,
      "maximum document byte count",
    ),
    maximumUploadRequestBytes: readPositiveInteger(
      maximumUploadRequestBytesValue,
      "maximum upload request byte count",
    ),
    needsAttention: failed + reindexRequired,
    processingDocuments: processing,
    readyDocuments: queryable,
    recentDocuments: readRecentDocuments(catalogValue),
    supportedExtensions: readSupportedExtensions(extensionValue),
  };
}

function readRecentDocuments(value) {
  const catalog = readPlainObject(value, "dashboard document catalog");
  const values = readArray(catalog.documents, "dashboard catalog documents");
  const documents = [];
  const limit = Math.min(values.length, recentDocumentLimit);
  for (let index = 0; index < limit; index += 1) {
    const document = readPlainObject(values[index], "dashboard catalog document");
    documents.push({
      displayStatus: readEnum(
        document.displayStatus,
        documentDisplayStatuses,
        "dashboard document display status",
      ),
      sourceFile: readNonEmptyString(
        document.sourceFile,
        "dashboard document source file",
      ),
      updatedAt: readTimestamp(document.updatedAt, "dashboard document update time"),
    });
  }
  return documents;
}

function readSupportedExtensions(value) {
  const values = readArray(value, "supported document extensions");
  const extensions = [];
  const uniqueExtensions = new Set();
  for (const value of values) {
    const extension = readNonEmptyString(value, "supported document extension");
    if (uniqueExtensions.has(extension)) {
      throw new Error(`The supported extension ${extension} appears more than once.`);
    }
    uniqueExtensions.add(extension);
    extensions.push(extension);
  }
  return extensions;
}

export function readIngestionCompleteEvent(event) {
  if (!(event instanceof CustomEvent)) {
    return null;
  }
  try {
    const detail = readPlainObject(event.detail, "ingestion completion");
    const destination = detail.destination === null
      ? null
      : readEnum(detail.destination, ingestionDestinations, "ingestion destination");
    return { destination };
  } catch {
    return null;
  }
}

export function buildQuestionDocument(document) {
  return { documentId: document.documentId, sourceFile: document.sourceFile };
}

function readRevision(value, label) {
  const revision = readString(value, label);
  if (!/^(0|[1-9][0-9]*)$/u.test(revision)) {
    throw new Error(`The ${label} response is invalid.`);
  }
  return revision;
}

function readQueueStatuses(value) {
  const values = readArray(value, "dashboard queue");
  const queue = [];
  for (const value of values) {
    const job = readPlainObject(value, "dashboard queue job");
    queue.push({
      phase: readEnum(job.phase, queuePhases, "dashboard queue phase"),
      state: readEnum(job.state, queueStates, "dashboard queue state"),
    });
  }
  return queue;
}

export function readDiagnostics(value) {
  const diagnostics = readPlainObject(value, "diagnostics");
  const values = readArray(diagnostics.checks, "diagnostic checks");
  const checks = [];
  const ids = new Set();
  for (const value of values) {
    const check = readPlainObject(value, "diagnostic check");
    const id = readNonEmptyString(check.id, "diagnostic identifier");
    if (ids.has(id)) {
      throw new Error(`The diagnostic identifier ${id} appears more than once.`);
    }
    ids.add(id);
    const items = [];
    for (const item of readArray(check.items, "diagnostic items")) {
      items.push(readNonEmptyString(item, "diagnostic item"));
    }
    checks.push({
      category: readEnum(check.category, diagnosticCategories, "diagnostic category"),
      detail: readString(check.detail, "diagnostic detail"),
      groupId: readNonEmptyString(check.groupId, "diagnostic group identifier"),
      groupName: readNonEmptyString(check.groupName, "diagnostic group name"),
      id,
      items,
      mode: readEnum(check.mode, diagnosticModes, "diagnostic mode"),
      name: readNonEmptyString(check.name, "diagnostic name"),
      ok: readBoolean(check.ok, "diagnostic result"),
    });
  }
  return {
    checks,
    generatedAt: readNonEmptyString(diagnostics.generatedAt, "diagnostics generated time"),
  };
}

export function groupDiagnosticChecks(checks) {
  const groups = [];
  for (const check of checks) {
    if (check.category === "model-response") {
      continue;
    }
    let group = groups.find((candidate) => candidate.id === check.groupId);
    if (group === undefined) {
      group = { checks: [], id: check.groupId, name: check.groupName };
      groups.push(group);
    }
    group.checks.push(check);
  }
  return groups;
}

function buildWorkflowSnapshot(queue, readyDocumentCount) {
  let activeStep = null;
  let processingCount = 0;
  for (const job of queue) {
    if (job.state !== "pending" && job.state !== "running") {
      continue;
    }
    processingCount += 1;
    const jobStep = workflowPhaseSteps[job.phase];
    if (activeStep === null || jobStep < activeStep) {
      activeStep = jobStep;
    }
  }

  if (activeStep === null) {
    return {
      activeStep: readyDocumentCount > 0 ? 4 : 0,
      processingCount,
      visible: false,
    };
  }
  return { activeStep, processingCount, visible: true };
}

export function buildEmptyOverviewSummary() {
  return {
    maximumDocumentBytes: null,
    maximumUploadRequestBytes: null,
    needsAttention: 0,
    processingDocuments: 0,
    readyDocuments: 0,
    recentDocuments: [],
    supportedExtensions: [
      ".pdf",
      ".html",
      ".htm",
      ".docx",
      ".xlsx",
      ".pptx",
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
    ],
  };
}
