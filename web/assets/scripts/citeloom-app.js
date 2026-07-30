import {
  readArray,
  readBoolean,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readNonNegativeInteger,
  readPlainObject as readObject,
  readPositiveInteger,
  readString,
} from "./citeloom-boundaries.js";
import { readSystemHealthDashboard } from "./citeloom-dashboard-extensions.js";
import {
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
  readStoredDocumentNotificationSubscriptions,
  writeStoredDocumentNotificationSubscriptions,
} from "./citeloom-document-notifications.js";
import {
  NOTICE_EVENT,
  readNoticeEvent,
  readNoticeKind,
} from "./citeloom-notices.js";

const defaultView = "overview";
const helpAnchorPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const documentNotificationRefreshDebounceMs = 250;
const workflowRefreshIntervalMs = 60_000;
const workflowRefreshDebounceMs = 200;

const workflowPhaseSteps = Object.freeze({
  discovered: 1,
  indexed: 3,
  normalized: 2,
});

const queuePhases = Object.freeze([
  "discovered",
  "normalized",
  "indexed",
]);

const queueStates = Object.freeze(["failed", "pending", "running"]);
const ingestionDestinations = Object.freeze(["documents"]);

const routes = Object.freeze({
  account: {
    fragment: "./fragments/account.html",
    pageScript: {
      id: "account",
      source: "./citeloom-account.js",
    },
    pageStyles: ["./assets/styles/citeloom-access.css"],
    title: "Account | CiteLoom",
  },
  ask: {
    fragment: "./fragments/ask.html",
    pageScript: {
      id: "ask",
      source: "./citeloom-ask.js",
    },
    pageStyles: ["./assets/styles/citeloom-ask.css"],
    title: "Ask | CiteLoom",
  },
  chat: {
    fragment: "./fragments/chat.html",
    pageScript: {
      id: "chat",
      source: "./citeloom-chat.js",
    },
    pageStyles: ["./assets/styles/citeloom-chat.css"],
    title: "Chat | CiteLoom",
  },
  documents: {
    fragment: "./fragments/documents.html",
    pageScript: {
      id: "documents",
      source: "./citeloom-documents.js",
    },
    pageStyles: ["./assets/styles/citeloom-documents.css"],
    title: "Documents | CiteLoom",
  },
  errors: {
    fragment: "./fragments/errors.html",
    pageScript: {
      id: "errors",
      source: "./citeloom-errors.js",
    },
    pageStyles: ["./assets/styles/citeloom-errors.css"],
    title: "Error reports | CiteLoom",
  },
  help: {
    fragment: "./fragments/help.html",
    pageScript: null,
    pageStyles: ["./assets/styles/citeloom-help.css"],
    title: "Help | CiteLoom",
  },
  login: {
    fragment: "./fragments/login.html",
    pageScript: {
      id: "login",
      source: "./citeloom-login.js",
    },
    pageStyles: ["./assets/styles/citeloom-login.css"],
    title: "Sign in | CiteLoom",
  },
  overview: {
    fragment: "./fragments/overview.html",
    pageScript: {
      id: "overview",
      source: "./citeloom-overview.js",
    },
    pageStyles: ["./assets/styles/citeloom-overview.css"],
    title: "CiteLoom",
  },
  settings: {
    fragment: "./fragments/settings.html",
    pageScript: {
      id: "settings",
      source: "./citeloom-settings.js",
    },
    pageStyles: ["./assets/styles/citeloom-settings.css"],
    title: "Settings | CiteLoom",
  },
  users: {
    fragment: "./fragments/users.html",
    pageScript: {
      id: "users",
      source: "./citeloom-users.js",
    },
    pageStyles: ["./assets/styles/citeloom-access.css"],
    title: "Users | CiteLoom",
  },
  "system-health": {
    fragment: "./fragments/system-health.html",
    pageScript: {
      id: "system-health",
      source: "./citeloom-system-health.js",
    },
    pageStyles: ["./assets/styles/citeloom-system-health.css"],
    title: "System health | CiteLoom",
  },
});

const pathViews = Object.freeze({
  "/account": "account",
  "/ask": "ask",
  "/chat": "chat",
  "/documents": "documents",
  "/errors": "errors",
  "/help": "help",
  "/login": "login",
  "/overview": "overview",
  "/settings": "settings",
  "/system-health": "system-health",
  "/users": "users",
});

const loadedPageScripts = new Set();
const loadedPageStyles = new Set();
const pageScriptPromises = new Map();
const pageStylePromises = new Map();
let pageNavigationGeneration = 0;
let pendingPageResourceErrorMessage = "";
function readView(value) {
  if (typeof value !== "string") {
    return defaultView;
  }
  if (Object.hasOwn(routes, value)) {
    return value;
  }
  return defaultView;
}

function readLocationView() {
  const parameters = new URLSearchParams(window.location.search);
  const queryView = parameters.get("view");
  if (queryView !== null) {
    return readView(queryView);
  }
  return readView(pathViews[window.location.pathname]);
}

function readLocationAnchor() {
  const encodedAnchor = window.location.hash.slice(1);
  if (encodedAnchor === "") {
    return null;
  }

  let anchor;
  try {
    anchor = decodeURIComponent(encodedAnchor);
  } catch {
    return null;
  }

  if (!helpAnchorPattern.test(anchor)) {
    return null;
  }
  return anchor;
}

function readHtmxWorkspaceRequest(event) {
  if (!(event instanceof CustomEvent)) {
    return null;
  }
  const detail = event.detail;
  if (typeof detail !== "object" || detail === null) {
    return null;
  }
  if (!(detail.target instanceof HTMLElement) || detail.target.id !== "workspace") {
    return null;
  }
  if (!(detail.elt instanceof HTMLElement) || typeof detail.issueRequest !== "function") {
    return null;
  }

  let view;
  const requestedView = detail.elt.dataset.view;
  if (requestedView !== undefined && Object.hasOwn(routes, requestedView)) {
    view = requestedView;
  } else if (detail.elt.id === "workspace") {
    view = readLocationView();
  } else {
    return null;
  }
  return {
    issueRequest(skipConfirmation) {
      detail.issueRequest(skipConfirmation);
    },
    view,
  };
}

function loadPageScript(pageScript) {
  if (loadedPageScripts.has(pageScript.id)) {
    return Promise.resolve();
  }
  const existingPromise = pageScriptPromises.get(pageScript.id);
  if (existingPromise !== undefined) {
    return existingPromise;
  }

  const promise = import(pageScript.source).then((pageModule) => {
    if (typeof pageModule.registerPage !== "function") {
      throw new Error(`The ${pageScript.id} page module did not export registerPage.`);
    }
    if (window.Alpine === undefined) {
      throw new Error(`The ${pageScript.id} page module loaded before Alpine.`);
    }
    pageModule.registerPage(window.Alpine);
    loadedPageScripts.add(pageScript.id);
  });
  pageScriptPromises.set(pageScript.id, promise);
  void promise.catch(() => {
    pageScriptPromises.delete(pageScript.id);
  });
  return promise;
}

function loadPageStyle(source) {
  if (loadedPageStyles.has(source)) {
    return Promise.resolve();
  }
  const existingPromise = pageStylePromises.get(source);
  if (existingPromise !== undefined) {
    return existingPromise;
  }

  const promise = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.dataset.citeloomPageStyle = source;
    link.href = source;
    link.rel = "stylesheet";

    const cleanup = () => {
      link.removeEventListener("error", handleError);
      link.removeEventListener("load", handleLoad);
    };
    const handleError = () => {
      cleanup();
      link.remove();
      reject(new Error(`The page stylesheet ${source} could not be loaded.`));
    };
    const handleLoad = () => {
      loadedPageStyles.add(source);
      cleanup();
      resolve();
    };

    link.addEventListener("error", handleError);
    link.addEventListener("load", handleLoad);
    document.head.append(link);
  });
  pageStylePromises.set(source, promise);
  void promise.catch(() => {
    pageStylePromises.delete(source);
  });
  return promise;
}

function routeResourcesLoaded(route) {
  for (const source of route.pageStyles) {
    if (!loadedPageStyles.has(source)) {
      return false;
    }
  }
  return route.pageScript === null || loadedPageScripts.has(route.pageScript.id);
}

function loadRouteResources(route) {
  const resourcePromises = [];
  for (const source of route.pageStyles) {
    resourcePromises.push(loadPageStyle(source));
  }
  if (route.pageScript !== null) {
    resourcePromises.push(loadPageScript(route.pageScript));
  }
  return Promise.all(resourcePromises);
}

function reportPageResourceError(error) {
  pendingPageResourceErrorMessage = error instanceof Error
    ? error.message
    : "The requested page resources could not be loaded.";
  window.dispatchEvent(new CustomEvent("citeloom:page-resource-error", {
    detail: pendingPageResourceErrorMessage,
  }));
}

document.addEventListener("htmx:confirm", (event) => {
  const request = readHtmxWorkspaceRequest(event);
  if (request === null) {
    return;
  }

  pageNavigationGeneration += 1;
  const requestGeneration = pageNavigationGeneration;
  const route = routes[request.view];
  if (routeResourcesLoaded(route)) {
    return;
  }

  event.preventDefault();
  void loadRouteResources(route).then(() => {
    if (requestGeneration === pageNavigationGeneration) {
      request.issueRequest(true);
    }
  }).catch((error) => {
    if (requestGeneration === pageNavigationGeneration) {
      reportPageResourceError(error);
    }
  });
});

window.addEventListener("popstate", () => {
  pageNavigationGeneration += 1;
});

function readDashboardSnapshot(value) {
  const dashboard = readObject(value, "dashboard");
  const overview = readOverviewSummary(
    dashboard.documentSummary,
    dashboard.maximumDocumentBytes,
    dashboard.maximumUploadRequestBytes,
    dashboard.supportedExtensions,
  );
  const system = readObject(dashboard.system, "dashboard system");
  const queue = readQueueStatuses(system.queue);
  const revisions = readObject(dashboard.revisions, "application revisions");
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
  maximumDocumentBytesValue,
  maximumUploadRequestBytesValue,
  extensionValue,
) {
  const summary = readObject(summaryValue, "dashboard document summary");
  const failed = readNonNegativeInteger(
    summary.failed,
    "failed document count",
  );
  const processing = readNonNegativeInteger(
    summary.processing,
    "processing document count",
  );
  const queryable = readNonNegativeInteger(
    summary.queryable,
    "queryable document count",
  );
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
    supportedExtensions: readSupportedExtensions(extensionValue),
  };
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

function readIngestionCompleteEvent(event) {
  if (!(event instanceof CustomEvent)) {
    return null;
  }
  try {
    const detail = readObject(event.detail, "ingestion completion");
    const destination = detail.destination === null
      ? null
      : readEnum(
        detail.destination,
        ingestionDestinations,
        "ingestion destination",
      );
    return {
      destination,
      kind: readNoticeKind(detail.kind, "ingestion notice kind"),
      message: readNonEmptyString(detail.message, "ingestion notice message"),
    };
  } catch {
    return null;
  }
}

function buildQuestionDocument(document) {
  return {
    documentId: document.documentId,
    sourceFile: document.sourceFile,
  };
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
    const job = readObject(value, "dashboard queue job");
    queue.push({
      phase: readEnum(job.phase, queuePhases, "dashboard queue phase"),
      state: readEnum(job.state, queueStates, "dashboard queue state"),
    });
  }
  return queue;
}

function readDiagnostics(value) {
  const diagnostics = readObject(value, "diagnostics");
  const values = readArray(diagnostics.checks, "diagnostic checks");
  const checks = [];
  const ids = new Set();
  for (const value of values) {
    const check = readObject(value, "diagnostic check");
    const id = readNonEmptyString(check.id, "diagnostic identifier");
    if (ids.has(id)) {
      throw new Error(`The diagnostic identifier ${id} appears more than once.`);
    }
    ids.add(id);
    checks.push({
      detail: readString(check.detail, "diagnostic detail"),
      id,
      name: readNonEmptyString(check.name, "diagnostic name"),
      ok: readBoolean(check.ok, "diagnostic result"),
    });
  }
  return {
    checks,
    generatedAt: readNonEmptyString(
      diagnostics.generatedAt,
      "diagnostics generated time",
    ),
  };
}

function buildWorkflowSnapshot(queue, readyDocumentCount) {
  let activeStep = null;
  let processingCount = 0;
  for (const job of queue) {
    const state = job.state;
    const phase = job.phase;
    if (state !== "pending" && state !== "running") {
      continue;
    }
    processingCount += 1;
    const jobStep = workflowPhaseSteps[phase];
    if (activeStep === null || jobStep < activeStep) {
      activeStep = jobStep;
    }
  }

  if (activeStep === null) {
    const completedStep = readyDocumentCount > 0 ? 4 : 0;
    return {
      activeStep: completedStep,
      processingCount,
      visible: false,
    };
  }
  return {
    activeStep,
    processingCount,
    visible: true,
  };
}

function buildEmptyOverviewSummary() {
  return {
    maximumDocumentBytes: null,
    maximumUploadRequestBytes: null,
    needsAttention: 0,
    processingDocuments: 0,
    readyDocuments: 0,
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

function configureInitialFragment() {
  const workspace = document.getElementById("workspace");
  if (workspace === null) {
    return;
  }
  const route = routes[readLocationView()];
  workspace.setAttribute("hx-get", route.fragment);
  document.title = route.title;
}

configureInitialFragment();

function registerShell(alpine) {
  alpine.data("citeloomShell", () => ({
    accountMenuOpen: false,
    activeView: readLocationView(),
    currentDisplayName: "Account",
    currentRole: null,
    currentUserId: null,
    currentWorkspaceId: null,
    dashboardErrorMessage: "",
    dashboardHasData: false,
    dashboardRefreshQueued: false,
    dashboardRefreshTimerId: null,
    dashboardRefreshing: false,
    dashboardStatus: "loading",
    diagnosticsChecks: [],
    diagnosticsErrorMessage: "",
    diagnosticsGeneratedAt: null,
    diagnosticsRunning: false,
    documentNotificationChangeListener: null,
    documentNotificationRefreshController: null,
    documentNotificationRefreshTimerId: null,
    documentNotificationRequestListener: null,
    documentNotificationStorageKey: null,
    documentNotificationSubscriptions: [],
    documentsRevision: null,
    dashboardRefreshRequestListener: null,
    ingestionCompleteListener: null,
    noticeEventListener: null,
    noticeQueue: [],
    overviewSummary: buildEmptyOverviewSummary(),
    pageResourceErrorListener: null,
    pendingView: null,
    questionDocuments: [],
    questionSelectionOpen: false,
    settingsRevision: null,
    workflow: { activeStep: 0, processingCount: 0, visible: false },
    workflowEventSource: null,
    workflowRefreshTimerId: null,

    get showTaskLaunchpad() {
      return this.activeView === "overview"
        || this.activeView === "documents"
        || this.activeView === "ask"
        || this.activeView === "chat";
    },

    get showWorkflowProgress() {
      return this.activeView !== "overview"
        && this.activeView !== "login"
        && this.workflow.visible;
    },

    get questionSelectionOverflow() {
      return Math.max(0, this.questionDocuments.length - 2);
    },

    get noticeKind() {
      const notice = this.noticeQueue[0];
      return notice === undefined ? null : notice.kind;
    },

    get noticeMessage() {
      const notice = this.noticeQueue[0];
      return notice === undefined ? "" : notice.message;
    },

    get questionSelectionPreview() {
      return this.questionDocuments.slice(0, 2);
    },

    get accountSectionIsCurrent() {
      return this.activeView === "account"
        || this.activeView === "errors"
        || this.activeView === "users"
        || this.activeView === "settings"
        || this.activeView === "system-health";
    },

    initialize() {
      this.dashboardRefreshRequestListener = () => {
        this.scheduleDashboardRefresh();
      };
      window.addEventListener(
        "citeloom:dashboard-refresh-request",
        this.dashboardRefreshRequestListener,
      );
      this.documentNotificationChangeListener = (event) => {
        if (!(event instanceof CustomEvent)) {
          return;
        }
        let change;
        try {
          change = readDocumentNotificationChange(event.detail);
        } catch {
          return;
        }
        this.changeDocumentNotification(change);
      };
      window.addEventListener(
        DOCUMENT_NOTIFICATION_CHANGE_EVENT,
        this.documentNotificationChangeListener,
      );
      this.documentNotificationRequestListener = (event) => {
        if (!(event instanceof CustomEvent)) {
          return;
        }
        let request;
        try {
          request = readDocumentNotificationRequest(event.detail);
        } catch {
          return;
        }
        this.broadcastDocumentNotificationState(request.sourceFile);
      };
      window.addEventListener(
        DOCUMENT_NOTIFICATION_REQUEST_EVENT,
        this.documentNotificationRequestListener,
      );
      this.ingestionCompleteListener = (event) => {
        const completion = readIngestionCompleteEvent(event);
        if (completion === null) {
          return;
        }
        this.showNotice(completion.kind, completion.message);
        void this.completeIngestion(completion.destination);
      };
      this.$root.addEventListener(
        "citeloom:ingestion-complete",
        this.ingestionCompleteListener,
      );
      this.noticeEventListener = (event) => {
        const notice = readNoticeEvent(event);
        if (notice === null) {
          return;
        }
        this.showNotice(notice.kind, notice.message);
      };
      window.addEventListener(
        NOTICE_EVENT,
        this.noticeEventListener,
      );
      this.pageResourceErrorListener = (event) => {
        if (!(event instanceof CustomEvent) || typeof event.detail !== "string") {
          return;
        }
        this.pendingView = null;
        this.showNotice("error", event.detail);
      };
      window.addEventListener(
        "citeloom:page-resource-error",
        this.pageResourceErrorListener,
      );
      if (pendingPageResourceErrorMessage !== "") {
        this.showNotice("error", pendingPageResourceErrorMessage);
        pendingPageResourceErrorMessage = "";
      }
      this.$root.addEventListener("htmx:beforeRequest", (event) => {
        pendingPageResourceErrorMessage = "";
        const source = event.detail.elt;
        if (!(source instanceof HTMLElement)) {
          this.pendingView = null;
          return;
        }
        const requestedView = source.dataset.view;
        this.pendingView = requestedView !== undefined
          && Object.hasOwn(routes, requestedView)
          ? requestedView
          : null;
      });
      this.$root.addEventListener("htmx:afterSwap", (event) => {
        const target = event.detail.target;
        if (!(target instanceof HTMLElement) || target.id !== "workspace") {
          return;
        }
        const shouldMoveFocus = this.pendingView !== null;
        this.activeView = this.pendingView ?? readLocationView();
        this.pendingView = null;
        if (this.activeView !== "documents") {
          this.questionSelectionOpen = false;
        }
        document.title = routes[this.activeView].title;
        if (this.focusLocationAnchor()) {
          return;
        }
        if (!shouldMoveFocus) {
          return;
        }
        window.scrollTo({ behavior: "auto", left: 0, top: 0 });
        const heading = target.querySelector("h1");
        if (heading instanceof HTMLElement) {
          heading.setAttribute("tabindex", "-1");
          heading.focus({ preventScroll: true });
        }
      });
      this.$root.addEventListener("htmx:responseError", () => {
        this.pendingView = null;
        this.showNotice("error", "The requested workspace could not be loaded.");
      });
      this.$root.addEventListener("htmx:sendError", () => {
        this.pendingView = null;
        this.showNotice(
          "error",
          "The browser could not reach the requested workspace.",
        );
      });
      this.$root.addEventListener("htmx:timeout", () => {
        this.pendingView = null;
        this.showNotice("error", "The workspace request timed out.");
      });
      this.$root.addEventListener("citeloom:settings-saved", () => {
        this.scheduleDashboardRefresh();
      });
      if (this.activeView !== "login") {
        void this.refreshDashboard();
        void this.loadCurrentSession();
        this.workflowRefreshTimerId = window.setInterval(() => {
          void this.refreshDashboard();
        }, workflowRefreshIntervalMs);
        this.workflowEventSource = new EventSource("/api/events");
        this.workflowEventSource.addEventListener("revision", () => {
          this.scheduleDashboardRefresh();
          this.scheduleDocumentNotificationRefresh();
        });
      }
    },

    destroy() {
      if (this.dashboardRefreshRequestListener !== null) {
        window.removeEventListener(
          "citeloom:dashboard-refresh-request",
          this.dashboardRefreshRequestListener,
        );
      }
      if (this.ingestionCompleteListener !== null) {
        this.$root.removeEventListener(
          "citeloom:ingestion-complete",
          this.ingestionCompleteListener,
        );
      }
      if (this.documentNotificationChangeListener !== null) {
        window.removeEventListener(
          DOCUMENT_NOTIFICATION_CHANGE_EVENT,
          this.documentNotificationChangeListener,
        );
      }
      if (this.documentNotificationRequestListener !== null) {
        window.removeEventListener(
          DOCUMENT_NOTIFICATION_REQUEST_EVENT,
          this.documentNotificationRequestListener,
        );
      }
      if (this.noticeEventListener !== null) {
        window.removeEventListener(
          NOTICE_EVENT,
          this.noticeEventListener,
        );
      }
      if (this.pageResourceErrorListener !== null) {
        window.removeEventListener(
          "citeloom:page-resource-error",
          this.pageResourceErrorListener,
        );
      }
      if (this.workflowRefreshTimerId !== null) {
        window.clearInterval(this.workflowRefreshTimerId);
      }
      if (this.dashboardRefreshTimerId !== null) {
        window.clearTimeout(this.dashboardRefreshTimerId);
      }
      if (this.documentNotificationRefreshTimerId !== null) {
        window.clearTimeout(this.documentNotificationRefreshTimerId);
      }
      this.documentNotificationRefreshController?.abort();
      this.workflowEventSource?.close();
    },

    currentPage(view) {
      return this.activeView === view ? "page" : null;
    },

    async loadCurrentSession() {
      try {
        const response = await fetch("/api/auth/session", {
          headers: { accept: "application/json" },
        });
        const value = await readJsonResponse(response, "Session request");
        const session = readObject(value, "session");
        const user = readObject(session.user, "session user");
        const workspace = readObject(session.workspace, "session workspace");
        const userId = readNonEmptyString(user.id, "user ID");
        const workspaceId = readNonEmptyString(workspace.id, "workspace ID");
        this.currentDisplayName = readNonEmptyString(
          user.displayName,
          "user display name",
        );
        this.currentRole = readEnum(workspace.role, ["admin", "member"], "workspace role");
        this.currentUserId = userId;
        this.currentWorkspaceId = workspaceId;
        this.loadDocumentNotifications(userId, workspaceId);
      } catch {
        this.currentDisplayName = "Account";
        this.currentRole = null;
        this.currentUserId = null;
        this.currentWorkspaceId = null;
        this.documentNotificationStorageKey = null;
        this.broadcastAllDocumentNotificationStates();
      }
    },

    loadDocumentNotifications(userId, workspaceId) {
      const storageKey = buildDocumentNotificationStorageKey(
        userId,
        workspaceId,
      );
      this.documentNotificationStorageKey = storageKey;
      const pendingSubscriptions = this.documentNotificationSubscriptions;
      let subscriptions = readStoredDocumentNotificationSubscriptions(
        sessionStorage,
        storageKey,
      );
      for (const subscription of pendingSubscriptions) {
        subscriptions = changeDocumentNotificationSubscription(
          subscriptions,
          { ...subscription, enabled: true },
        );
      }
      this.documentNotificationSubscriptions = subscriptions;
      if (pendingSubscriptions.length > 0) {
        this.persistDocumentNotifications();
      }
      this.broadcastAllDocumentNotificationStates();
      this.scheduleDocumentNotificationRefresh();
    },

    changeDocumentNotification(change) {
      const nextSubscriptions = changeDocumentNotificationSubscription(
        this.documentNotificationSubscriptions,
        change,
      );
      this.documentNotificationSubscriptions = nextSubscriptions;
      const saved = this.persistDocumentNotifications();
      this.broadcastDocumentNotificationState(change.sourceFile);
      this.documentNotificationRefreshController?.abort();
      if (this.documentNotificationSubscriptions.length > 0) {
        this.scheduleDocumentNotificationRefresh();
      }
      if (!saved) {
        const message = change.enabled
          ? "The notification is active for this page, but could not be saved across reloads."
          : "The notification is off for this page, but could not be removed from saved session state.";
        this.showNotice("error", message);
        return;
      }
      if (change.enabled) {
        this.showNotice(
          "success",
          `We'll notify you when ${change.filename} is ready.`,
        );
      }
    },

    persistDocumentNotifications() {
      if (this.documentNotificationStorageKey === null) {
        return false;
      }
      return writeStoredDocumentNotificationSubscriptions(
        sessionStorage,
        this.documentNotificationStorageKey,
        this.documentNotificationSubscriptions,
      );
    },

    broadcastDocumentNotificationState(sourceFile) {
      const enabled = documentNotificationEnabled(
        this.documentNotificationSubscriptions,
        sourceFile,
      );
      window.dispatchEvent(new CustomEvent(DOCUMENT_NOTIFICATION_STATE_EVENT, {
        detail: { enabled, sourceFile },
      }));
    },

    broadcastAllDocumentNotificationStates() {
      for (const subscription of this.documentNotificationSubscriptions) {
        this.broadcastDocumentNotificationState(subscription.sourceFile);
      }
    },

    scheduleDocumentNotificationRefresh() {
      if (
        this.documentNotificationSubscriptions.length === 0
        || this.documentNotificationRefreshTimerId !== null
      ) {
        return;
      }
      this.documentNotificationRefreshTimerId = window.setTimeout(() => {
        this.documentNotificationRefreshTimerId = null;
        void this.refreshDocumentNotifications();
      }, documentNotificationRefreshDebounceMs);
    },

    async refreshDocumentNotifications() {
      if (this.documentNotificationSubscriptions.length === 0) {
        return;
      }
      this.documentNotificationRefreshController?.abort();
      const controller = new AbortController();
      this.documentNotificationRefreshController = controller;
      const subscriptions = [...this.documentNotificationSubscriptions];
      const outcomes = [];
      for (const subscription of subscriptions) {
        let documentStatus;
        try {
          const response = await fetch(
            buildDocumentNotificationCatalogUrl(subscription),
            {
              headers: { accept: "application/json" },
              signal: controller.signal,
            },
          );
          documentStatus = await readJsonResponse(
            response,
            "Document notification request",
            (value) => readDocumentNotificationCatalogStatus(
              value,
              subscription.sourceFile,
            ),
          );
        } catch {
          if (controller.signal.aborted) {
            return;
          }
          this.showNotice(
            "error",
            `CiteLoom could not check whether ${subscription.filename} is ready. It will keep watching.`,
          );
          continue;
        }
        if (controller.signal.aborted) {
          return;
        }
        const outcome = readDocumentNotificationOutcome(documentStatus);
        if (outcome === "processing") {
          continue;
        }
        if (!documentNotificationEnabled(
          this.documentNotificationSubscriptions,
          subscription.sourceFile,
        )) {
          continue;
        }
        this.documentNotificationSubscriptions =
          changeDocumentNotificationSubscription(
            this.documentNotificationSubscriptions,
            { ...subscription, enabled: false },
          );
        this.broadcastDocumentNotificationState(subscription.sourceFile);
        if (outcome === "removed") {
          continue;
        }
        outcomes.push({
          errorMessage: documentStatus.errorMessage,
          filename: subscription.filename,
          outcome,
        });
      }
      if (this.documentNotificationRefreshController === controller) {
        this.documentNotificationRefreshController = null;
      }
      this.persistDocumentNotifications();
      this.showDocumentNotificationOutcomes(outcomes);
    },

    showDocumentNotificationOutcomes(outcomes) {
      if (outcomes.length === 0) {
        return;
      }
      if (outcomes.length === 1) {
        const [outcome] = outcomes;
        if (outcome.outcome === "failed") {
          const message = outcome.errorMessage === null
            ? `${outcome.filename} needs attention.`
            : `${outcome.filename} failed: ${outcome.errorMessage}`;
          this.showNotice("error", message);
          return;
        }
        this.showNotice("success", `${outcome.filename} is ready.`);
        return;
      }
      let failed = 0;
      let ready = 0;
      const failureMessages = [];
      for (const outcome of outcomes) {
        if (outcome.outcome === "failed") {
          failed += 1;
          const message = outcome.errorMessage === null
            ? `${outcome.filename} needs attention.`
            : `${outcome.filename} failed: ${outcome.errorMessage}`;
          failureMessages.push(message);
        } else {
          ready += 1;
        }
      }
      if (failed > 0 && ready > 0) {
        failureMessages.unshift(`${ready} watched documents are ready.`);
      }
      if (failed > 0) {
        this.showNotice("error", failureMessages.join("\n"));
        return;
      }
      this.showNotice("success", `${ready} watched documents are ready.`);
    },

    clearDocumentNotifications() {
      const subscriptions = this.documentNotificationSubscriptions;
      this.documentNotificationSubscriptions = [];
      this.documentNotificationRefreshController?.abort();
      this.documentNotificationRefreshController = null;
      if (this.documentNotificationRefreshTimerId !== null) {
        window.clearTimeout(this.documentNotificationRefreshTimerId);
        this.documentNotificationRefreshTimerId = null;
      }
      this.persistDocumentNotifications();
      for (const subscription of subscriptions) {
        this.broadcastDocumentNotificationState(subscription.sourceFile);
      }
    },

    closeAccountMenu(options = {}) {
      if (!this.accountMenuOpen) {
        return;
      }
      this.accountMenuOpen = false;
      if (options.restoreFocus === true) {
        this.$nextTick(() => this.$refs.accountMenuTrigger?.focus());
      }
    },

    toggleAccountMenu() {
      this.accountMenuOpen = !this.accountMenuOpen;
    },

    focusLocationAnchor() {
      if (this.activeView !== "help") {
        return false;
      }

      const anchor = readLocationAnchor();
      if (anchor === null) {
        return false;
      }

      const workspace = document.getElementById("workspace");
      const target = document.getElementById(anchor);
      if (
        workspace === null
        || !(target instanceof HTMLElement)
        || !workspace.contains(target)
      ) {
        return false;
      }

      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const behavior = reducedMotion ? "auto" : "smooth";
      window.requestAnimationFrame(() => {
        target.scrollIntoView({ behavior, block: "start" });
        target.focus({ preventScroll: true });
      });
      return true;
    },

    async refreshDashboard() {
      if (this.dashboardRefreshing) {
        this.dashboardRefreshQueued = true;
        return;
      }
      this.dashboardRefreshing = true;
      this.dashboardErrorMessage = "";
      try {
        const response = await fetch("/api/dashboard", {
          headers: { accept: "application/json" },
        });
        const value = await readJsonResponse(response, "Dashboard request");
        const snapshot = readDashboardSnapshot(value);
        const previousDocumentsRevision = this.documentsRevision;
        this.documentsRevision = snapshot.documentsRevision;
        this.overviewSummary = snapshot.overview;
        this.workflow = snapshot.workflow;
        this.dashboardHasData = true;
        this.dashboardStatus = "ready";
        if (snapshot.systemHealth !== null) {
          window.dispatchEvent(new CustomEvent("citeloom:system-health-snapshot", {
            detail: snapshot.systemHealth,
          }));
        }
        if (
          previousDocumentsRevision !== null
          && previousDocumentsRevision !== snapshot.documentsRevision
        ) {
          window.dispatchEvent(new CustomEvent("citeloom:documents-revision", {
            detail: snapshot.documentsRevision,
          }));
        }
        if (this.settingsRevision !== snapshot.settingsRevision) {
          this.settingsRevision = snapshot.settingsRevision;
          window.dispatchEvent(new CustomEvent("citeloom:settings-revision", {
            detail: snapshot.settingsRevision,
          }));
        }
      } catch {
        this.dashboardErrorMessage = "Runtime capacity and telemetry could not be refreshed.";
        this.dashboardStatus = "error";
      } finally {
        this.dashboardRefreshing = false;
        this.scheduleDocumentNotificationRefresh();
        if (this.dashboardRefreshQueued) {
          this.dashboardRefreshQueued = false;
          void this.refreshDashboard();
        }
      }
    },

    scheduleDashboardRefresh() {
      if (this.dashboardRefreshing) {
        this.dashboardRefreshQueued = true;
        return;
      }
      if (this.dashboardRefreshTimerId !== null) {
        return;
      }
      this.dashboardRefreshTimerId = window.setTimeout(() => {
        this.dashboardRefreshTimerId = null;
        void this.refreshDashboard();
      }, workflowRefreshDebounceMs);
    },

    async runDiagnostics() {
      if (this.diagnosticsRunning) {
        return;
      }
      this.diagnosticsRunning = true;
      this.diagnosticsErrorMessage = "";
      try {
        const response = await fetch("/api/diagnostics", {
          headers: { accept: "application/json" },
          method: "POST",
        });
        const value = await readJsonResponse(response, "Diagnostics request");
        const diagnostics = readDiagnostics(value);
        this.diagnosticsChecks = diagnostics.checks;
        this.diagnosticsGeneratedAt = diagnostics.generatedAt;
      } catch {
        this.diagnosticsErrorMessage = "Diagnostics could not be completed. No diagnostic result was saved.";
      } finally {
        this.diagnosticsRunning = false;
      }
    },

    dismissDiagnosticsError() {
      this.diagnosticsErrorMessage = "";
    },

    async completeIngestion(destination) {
      await this.refreshDashboard();
      if (destination !== null) {
        this.navigateToView(destination);
      }
    },

    dismissNotice() {
      this.noticeQueue = this.noticeQueue.slice(1);
    },

    showNotice(kind, message) {
      for (const notice of this.noticeQueue) {
        if (notice.kind === kind && notice.message === message) {
          return;
        }
      }
      this.noticeQueue.push({ kind, message });
    },

    navigateToView(view) {
      if (!Object.hasOwn(routes, view)) {
        return;
      }
      const link = this.$root.querySelector(`a[data-view="${view}"]`);
      if (link instanceof HTMLAnchorElement) {
        link.click();
      }
    },

    async signOut() {
      this.clearDocumentNotifications();
      try {
        await fetch("/api/auth/logout", { method: "POST" });
      } finally {
        window.location.assign("/login");
      }
    },

    noticeRole() {
      return this.noticeKind === "error" ? "alert" : "status";
    },

    clearQuestionDocuments() {
      this.questionDocuments = [];
      this.questionSelectionOpen = false;
    },

    closeQuestionSelection() {
      this.questionSelectionOpen = false;
    },

    isQuestionDocumentSelected(sourceFile) {
      for (const document of this.questionDocuments) {
        if (document.sourceFile === sourceFile) {
          return true;
        }
      }
      return false;
    },

    openQuestionSelection() {
      if (this.questionDocuments.length > 0) {
        this.questionSelectionOpen = true;
      }
    },

    questionDocumentName(sourceFile) {
      const normalized = sourceFile.replaceAll("\\", "/");
      const segments = normalized.split("/").filter(Boolean);
      return segments.at(-1) ?? sourceFile;
    },

    removeQuestionDocument(sourceFile) {
      const documents = [];
      for (const document of this.questionDocuments) {
        if (document.sourceFile !== sourceFile) {
          documents.push(document);
        }
      }
      this.questionDocuments = documents;
      if (documents.length === 0) {
        this.questionSelectionOpen = false;
      }
    },

    setQuestionDocumentsSelected(documents, selected) {
      const nextDocuments = [...this.questionDocuments];
      for (const document of documents) {
        const index = nextDocuments.findIndex((current) => {
          return current.sourceFile === document.sourceFile;
        });
        if (selected && index === -1) {
          nextDocuments.push(buildQuestionDocument(document));
          continue;
        }
        if (!selected && index !== -1) {
          nextDocuments.splice(index, 1);
        }
      }
      this.questionDocuments = nextDocuments;
    },

    toggleQuestionDocument(document) {
      const selected = this.isQuestionDocumentSelected(document.sourceFile);
      this.setQuestionDocumentsSelected([document], !selected);
    },

    synchronizeHistory() {
      this.activeView = readLocationView();
      document.title = routes[this.activeView].title;
      this.focusLocationAnchor();
    },

    workflowStepClass(index) {
      if (index < this.workflow.activeStep) {
        return "done";
      }
      if (index === this.workflow.activeStep) {
        return "current";
      }
      return "";
    },

    workflowStepComplete(index) {
      return index < this.workflow.activeStep;
    },

    workflowStepCurrent(index) {
      return index === this.workflow.activeStep ? "step" : null;
    },

    workflowStatusLabel() {
      if (this.workflow.processingCount === 0) {
        return "Local pipeline";
      }
      const suffix = this.workflow.processingCount === 1
        ? "document"
        : "documents";
      return `${this.workflow.processingCount} ${suffix} processing`;
    },
  }));
}

if (window.Alpine === undefined) {
  document.addEventListener("alpine:init", () => {
    registerShell(window.Alpine);
  }, { once: true });
} else {
  registerShell(window.Alpine);
}
