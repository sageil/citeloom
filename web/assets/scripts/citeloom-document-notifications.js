import {
  readArray,
  readBoolean,
  readEnum,
  readNonEmptyString,
  readNullableString,
  readPlainObject,
} from "./citeloom-boundaries.js";

const DOCUMENT_NOTIFICATION_CHANGE_EVENT = "citeloom:document-notification-change";
const DOCUMENT_NOTIFICATION_REQUEST_EVENT = "citeloom:document-notification-request";
const DOCUMENT_NOTIFICATION_STATE_EVENT = "citeloom:document-notification-state";
const documentNotificationStatuses = Object.freeze([
  "failed",
  "pending",
  "ready",
  "running",
]);
const documentNotificationQueryStatuses = Object.freeze([
  "failed",
  "pending",
  "ready",
  "reindex-required",
  "running",
]);

function buildDocumentNotificationStorageKey(userId, workspaceId) {
  return `citeloom.document-notifications.v1:${userId}:${workspaceId}`;
}

function readDocumentNotificationSubscription(value) {
  const subscription = readPlainObject(value, "document notification subscription");
  return {
    documentId: readNonEmptyString(
      subscription.documentId,
      "document notification document ID",
    ),
    filename: readNonEmptyString(
      subscription.filename,
      "document notification filename",
    ),
    sourceFile: readNonEmptyString(
      subscription.sourceFile,
      "document notification source file",
    ),
  };
}

function readDocumentNotificationSubscriptions(value) {
  const values = readArray(value, "document notification subscriptions");
  const subscriptions = [];
  const sourceFiles = new Set();
  for (const value of values) {
    const subscription = readDocumentNotificationSubscription(value);
    if (sourceFiles.has(subscription.sourceFile)) {
      continue;
    }
    sourceFiles.add(subscription.sourceFile);
    subscriptions.push(subscription);
  }
  return subscriptions;
}

function readStoredDocumentNotificationSubscriptions(storage, storageKey) {
  let serialized;
  try {
    serialized = storage.getItem(storageKey);
  } catch {
    return [];
  }
  if (serialized === null) {
    return [];
  }
  try {
    return readDocumentNotificationSubscriptions(JSON.parse(serialized));
  } catch {
    return [];
  }
}

function writeStoredDocumentNotificationSubscriptions(
  storage,
  storageKey,
  subscriptions,
) {
  try {
    if (subscriptions.length === 0) {
      storage.removeItem(storageKey);
    } else {
      storage.setItem(storageKey, JSON.stringify(subscriptions));
    }
    return true;
  } catch {
    return false;
  }
}

function readDocumentNotificationChange(value) {
  const change = readPlainObject(value, "document notification change");
  const subscription = readDocumentNotificationSubscription(change);
  return {
    ...subscription,
    enabled: readBoolean(change.enabled, "document notification enabled state"),
  };
}

function readDocumentNotificationRequest(value) {
  const request = readPlainObject(value, "document notification request");
  return {
    sourceFile: readNonEmptyString(
      request.sourceFile,
      "document notification request source file",
    ),
  };
}

function readDocumentNotificationState(value) {
  const state = readPlainObject(value, "document notification state");
  return {
    enabled: readBoolean(state.enabled, "document notification state"),
    sourceFile: readNonEmptyString(
      state.sourceFile,
      "document notification state source file",
    ),
  };
}

function changeDocumentNotificationSubscription(subscriptions, change) {
  const nextSubscriptions = [];
  for (const subscription of subscriptions) {
    if (subscription.sourceFile !== change.sourceFile) {
      nextSubscriptions.push(subscription);
    }
  }
  if (change.enabled) {
    nextSubscriptions.push({
      documentId: change.documentId,
      filename: change.filename,
      sourceFile: change.sourceFile,
    });
  }
  nextSubscriptions.sort((left, right) => (
    left.sourceFile.localeCompare(right.sourceFile)
  ));
  return nextSubscriptions;
}

function documentNotificationEnabled(subscriptions, sourceFile) {
  for (const subscription of subscriptions) {
    if (subscription.sourceFile === sourceFile) {
      return true;
    }
  }
  return false;
}

function buildDocumentNotificationCatalogUrl(subscription) {
  const parameters = new URLSearchParams({
    collection: "all",
    page: "1",
    pageSize: "25",
    search: subscription.sourceFile.toLowerCase(),
    sort: "updated-desc",
    status: "all",
    tag: "",
  });
  return `/api/documents?${parameters.toString()}`;
}

function readDocumentNotificationCatalogEntry(value) {
  const document = readPlainObject(value, "document notification catalog entry");
  return {
    documentId: readNonEmptyString(
      document.documentId,
      "document notification catalog document ID",
    ),
    errorMessage: readNullableString(
      document.errorMessage,
      "document notification catalog error message",
    ),
    queryStatus: readEnum(
      document.queryStatus,
      documentNotificationQueryStatuses,
      "document notification catalog query status",
    ),
    sourceFile: readNonEmptyString(
      document.sourceFile,
      "document notification catalog source file",
    ),
    status: readEnum(
      document.status,
      documentNotificationStatuses,
      "document notification catalog status",
    ),
  };
}

function readDocumentNotificationCatalogStatus(value, sourceFile) {
  const catalog = readPlainObject(value, "document notification catalog");
  const attention = readPlainObject(
    catalog.attention,
    "document notification attention queue",
  );
  const groups = [
    readArray(
      attention.documents,
      "document notification attention documents",
    ),
    readArray(catalog.documents, "document notification catalog documents"),
  ];
  for (const group of groups) {
    for (const value of group) {
      const document = readDocumentNotificationCatalogEntry(value);
      if (document.sourceFile === sourceFile) {
        return document;
      }
    }
  }
  return null;
}

function readDocumentNotificationOutcome(document) {
  if (document === null) {
    return "removed";
  }
  if (document.queryStatus === "ready") {
    return "ready";
  }
  if (document.status === "failed") {
    return "failed";
  }
  return "processing";
}

export {
  DOCUMENT_NOTIFICATION_CHANGE_EVENT,
  DOCUMENT_NOTIFICATION_REQUEST_EVENT,
  DOCUMENT_NOTIFICATION_STATE_EVENT,
  buildDocumentNotificationCatalogUrl,
  buildDocumentNotificationStorageKey,
  changeDocumentNotificationSubscription,
  documentNotificationEnabled,
  readDocumentNotificationCatalogStatus,
  readDocumentNotificationChange,
  readDocumentNotificationOutcome,
  readDocumentNotificationRequest,
  readDocumentNotificationState,
  readDocumentNotificationSubscriptions,
  readStoredDocumentNotificationSubscriptions,
  writeStoredDocumentNotificationSubscriptions,
};
