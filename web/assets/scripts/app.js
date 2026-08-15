import {
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readPlainObject as readObject,
} from "./boundary-readers.js";
import {
  CONFIRMATION_REQUEST_EVENT,
  dispatchConfirmationResponse,
  readConfirmationRequestEvent,
} from "./confirmation.js";
import {
  DOCUMENT_NOTIFICATION_CHANGE_EVENT,
  DOCUMENT_NOTIFICATION_REQUEST_EVENT,
  DOCUMENT_NOTIFICATION_STATE_EVENT,
  buildDocumentNotificationCatalogUrl,
  buildDocumentNotificationStorageKey,
  changeDocumentNotificationSubscription,
  documentNotificationEnabled,
  readBrowserNotificationPermission,
  readDocumentNotificationCatalogStatus,
  readDocumentNotificationChange,
  readDocumentNotificationOutcome,
  readDocumentNotificationRequest,
  readStoredDocumentNotificationSubscriptions,
  requestBrowserNotificationPermission,
  showBrowserNotification,
  writeStoredDocumentNotificationSubscriptions,
} from "./document-notifications.js";
import {
  buildEmptyOverviewSummary,
  buildQuestionDocument,
  groupDiagnosticChecks,
  readDashboardSnapshot,
  readDiagnostics,
  readIngestionCompleteEvent,
} from "./dashboard-boundary.js";
import {
  configureInitialFragment,
  initializePageRouting,
  readLocationAnchor,
  readLocationView,
  routes,
} from "./page-routing.js";
import {
  clearSettingsTargetPreference,
  writeSettingsTargetPreference,
} from "./settings-target.js";
import {
  canAdministerWorkspace,
  readWorkspaceSummaries,
} from "./workspaces.js";
import { browserAuthentication } from "./browser-authentication.js";

const documentNotificationRefreshDebounceMs = 250;
const workflowRefreshIntervalMs = 60_000;
const workflowRefreshDebounceMs = 200;
const chatSwitcherRequestEvent = "citeloom:chat-switcher-request";

initializePageRouting();
configureInitialFragment();

function registerShell(alpine) {
  alpine.data("citeloomShell", () => ({
    accountMenuOpen: false,
    activeView: readLocationView(),
    chatSwitcherPending: false,
    confirmationCancelLabel: "Cancel",
    confirmationConfirmLabel: "Confirm",
    confirmationDescription: "",
    confirmationOpen: false,
    confirmationRequestId: null,
    confirmationRequestListener: null,
    confirmationRestoreFocusElement: null,
    confirmationTitle: "",
    confirmationTone: "danger",
    currentDataScope: null,
    currentDisplayName: "Account",
    currentGlobalRole: null,
    currentRole: null,
    currentUserId: null,
    currentWorkspaceId: null,
    currentWorkspaceName: "Workspace",
    dashboardErrorMessage: "",
    dashboardHasData: false,
    dashboardRefreshQueued: false,
    dashboardRefreshTimerId: null,
    dashboardRefreshing: false,
    dashboardStatus: "loading",
    diagnosticsChecks: [],
    diagnosticsDialogOpen: false,
    diagnosticsErrorMessage: "",
    diagnosticsExpandedGroupIds: [],
    diagnosticsGeneratedAt: null,
    diagnosticsLiveChecks: {
      modelResponse: false,
      searchRanking: false,
      speech: false,
    },
    diagnosticsRestoreFocusElement: null,
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
    overviewSummary: buildEmptyOverviewSummary(),
    pendingView: null,
    questionDocuments: [],
    questionSelectionOpen: false,
    settingsRevision: null,
    workflow: { activeStep: 0, processingCount: 0, visible: false },
    workflowEventSource: null,
    workflowRefreshTimerId: null,
    workspaces: [],
    workspaceErrorMessage: "",
    workspaceSwitching: false,

    get diagnosticsGroups() {
      return groupDiagnosticChecks(this.diagnosticsChecks);
    },

    get diagnosticsModelResponse() {
      return this.diagnosticsChecks.find((check) => {
        return check.category === "model-response";
      }) ?? null;
    },

    get diagnosticsRunButtonLabel() {
      const liveChecks = this.diagnosticsLiveChecks;
      if (liveChecks.modelResponse || liveChecks.searchRanking || liveChecks.speech) {
        return "Run selected checks";
      }
      return "Run service checks";
    },

    get diagnosticsServiceCheckCount() {
      return this.diagnosticsChecks.filter((check) => {
        return check.mode === "readiness";
      }).length;
    },

    get diagnosticsServicePassedCount() {
      return this.diagnosticsChecks.filter((check) => {
        return check.mode === "readiness" && check.ok;
      }).length;
    },

    get showWorkflowProgress() {
      return this.activeView !== "overview"
        && this.activeView !== "documents"
        && this.activeView !== "ask"
        && this.activeView !== "chat"
        && this.activeView !== "login"
        && this.workflow.visible;
    },

    get questionSelectionOverflow() {
      return Math.max(0, this.questionDocuments.length - 2);
    },

    get questionSelectionPreview() {
      return this.questionDocuments.slice(0, 2);
    },

    get accountSectionIsCurrent() {
      return this.activeView === "account"
        || this.activeView === "errors"
        || this.activeView === "security"
        || this.activeView === "settings"
        || this.activeView === "system-health";
    },

    get canAdministerCurrentWorkspace() {
      return canAdministerWorkspace(
        this.currentRole,
        this.currentGlobalRole,
      );
    },

    get currentDisplayInitials() {
      return this.currentDisplayName.slice(0, 2).toLocaleUpperCase();
    },

    initialize() {
      this.confirmationRequestListener = (event) => {
        const request = readConfirmationRequestEvent(event);
        if (request === null) {
          return;
        }
        this.openConfirmation(request);
      };
      window.addEventListener(
        CONFIRMATION_REQUEST_EVENT,
        this.confirmationRequestListener,
      );
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
        void this.changeDocumentNotification(change);
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
        void this.completeIngestion(completion.destination);
      };
      this.$root.addEventListener(
        "citeloom:ingestion-complete",
        this.ingestionCompleteListener,
      );
      this.$root.addEventListener("htmx:beforeRequest", (event) => {
        this.cancelConfirmationForNavigation();
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
      this.$root.addEventListener("htmx:afterSettle", (event) => {
        const target = event.detail.target;
        if (!(target instanceof HTMLElement) || target.id !== "workspace") {
          return;
        }
        if (!this.chatSwitcherPending) {
          return;
        }
        this.chatSwitcherPending = false;
        if (this.activeView !== "chat") {
          return;
        }
        this.requestChatSwitcher();
      });
      this.$root.addEventListener("htmx:responseError", () => {
        this.chatSwitcherPending = false;
        this.pendingView = null;
        showPageLoadError("The requested page could not be loaded.");
      });
      this.$root.addEventListener("htmx:sendError", () => {
        this.chatSwitcherPending = false;
        this.pendingView = null;
        showPageLoadError("The browser could not reach the requested page.");
      });
      this.$root.addEventListener("htmx:timeout", () => {
        this.chatSwitcherPending = false;
        this.pendingView = null;
        showPageLoadError("The page request timed out.");
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
        void browserAuthentication.isOAuthEnabled().then((oauthEnabled) => {
          if (oauthEnabled) {
            return;
          }
          this.workflowEventSource = new EventSource("/api/events");
          this.workflowEventSource.addEventListener("revision", () => {
            this.scheduleDashboardRefresh();
            this.scheduleDocumentNotificationRefresh();
          });
        });
      }
    },

    destroy() {
      this.cancelConfirmationForNavigation();
      if (this.confirmationRequestListener !== null) {
        window.removeEventListener(
          CONFIRMATION_REQUEST_EVENT,
          this.confirmationRequestListener,
        );
      }
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

    openConfirmation(request) {
      this.cancelConfirmationForNavigation();
      this.confirmationCancelLabel = request.cancelLabel;
      this.confirmationConfirmLabel = request.confirmLabel;
      this.confirmationDescription = request.description;
      this.confirmationRequestId = request.requestId;
      this.confirmationRestoreFocusElement = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      this.confirmationTitle = request.title;
      this.confirmationTone = request.tone;
      this.confirmationOpen = true;
      this.$nextTick(() => {
        if (this.confirmationCancelLabel === null) {
          this.$refs.confirmationConfirm?.focus();
          return;
        }
        this.$refs.confirmationCancel?.focus();
      });
    },

    cancelConfirmation() {
      this.finishConfirmation(false, true);
    },

    cancelConfirmationForNavigation() {
      this.finishConfirmation(false, false);
    },

    confirmConfirmation() {
      this.finishConfirmation(true, true);
    },

    cycleConfirmationFocus(event) {
      const cancelButton = this.$refs.confirmationCancel;
      const confirmButton = this.$refs.confirmationConfirm;
      if (!(confirmButton instanceof HTMLButtonElement)) {
        return;
      }
      if (this.confirmationCancelLabel === null) {
        confirmButton.focus();
        return;
      }
      if (!(cancelButton instanceof HTMLButtonElement)) {
        return;
      }
      if (event.shiftKey) {
        if (document.activeElement === cancelButton) {
          confirmButton.focus();
          return;
        }
        cancelButton.focus();
        return;
      }
      if (document.activeElement === confirmButton) {
        cancelButton.focus();
        return;
      }
      confirmButton.focus();
    },

    finishConfirmation(confirmed, restoreFocus) {
      if (this.confirmationRequestId === null) {
        return;
      }
      const requestId = this.confirmationRequestId;
      const restoreFocusElement = this.confirmationRestoreFocusElement;
      this.confirmationOpen = false;
      this.confirmationRequestId = null;
      this.confirmationRestoreFocusElement = null;
      dispatchConfirmationResponse(requestId, confirmed);
      if (restoreFocus && restoreFocusElement?.isConnected === true) {
        this.$nextTick(() => restoreFocusElement.focus());
      }
    },

    requestChatSwitcher() {
      window.dispatchEvent(new CustomEvent(chatSwitcherRequestEvent));
    },

    handlePrimaryChatNavigation(event) {
      if (this.activeView !== "chat") {
        this.chatSwitcherPending = true;
        return;
      }
      this.chatSwitcherPending = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      this.requestChatSwitcher();
    },

    async loadCurrentSession() {
      try {
        const oauthContext = await browserAuthentication.identityContext();
        if (oauthContext !== null) {
          const workspaceId = await browserAuthentication.selectedWorkspaceId();
          const workspace = oauthContext.workspaces.find((candidate) => {
            return candidate.id === workspaceId;
          });
          if (workspace === undefined) {
            throw new Error("The selected OAuth workspace is unavailable.");
          }
          this.currentDataScope = "workspace";
          this.currentDisplayName = oauthContext.displayName;
          this.currentGlobalRole = oauthContext.globalRole;
          this.currentRole = workspace.role;
          this.currentUserId = oauthContext.userId;
          this.currentWorkspaceId = workspace.id;
          this.currentWorkspaceName = workspace.name;
          this.loadDocumentNotifications(oauthContext.userId, workspace.id);
          this.workspaces = oauthContext.workspaces;
          return;
        }
        const response = await fetch("/api/auth/session", {
          headers: { accept: "application/json" },
        });
        const value = await readJsonResponse(response, "Session request");
        const session = readObject(value, "session");
        const user = readObject(session.user, "session user");
        const workspace = readObject(session.workspace, "session workspace");
        const userId = readNonEmptyString(user.id, "user ID");
        const workspaceId = readNonEmptyString(workspace.id, "workspace ID");
        this.currentDataScope = readEnum(
          user.dataScope,
          ["all", "workspace"],
          "data scope",
        );
        this.currentDisplayName = readNonEmptyString(
          user.displayName,
          "user display name",
        );
        this.currentGlobalRole = readEnum(
          user.globalRole,
          ["global_admin", "standard"],
          "global role",
        );
        this.currentRole = readEnum(workspace.role, ["admin", "member"], "workspace role");
        this.currentUserId = userId;
        this.currentWorkspaceId = workspaceId;
        this.currentWorkspaceName = readNonEmptyString(
          workspace.name,
          "workspace name",
        );
        this.loadDocumentNotifications(userId, workspaceId);
      } catch {
        this.currentDataScope = null;
        this.currentDisplayName = "Account";
        this.currentGlobalRole = null;
        this.currentRole = null;
        this.currentUserId = null;
        this.currentWorkspaceId = null;
        this.currentWorkspaceName = "Workspace";
        this.workspaces = [];
        this.documentNotificationStorageKey = null;
        this.broadcastAllDocumentNotificationStates();
        return;
      }
      try {
        await this.loadWorkspaces();
      } catch (error) {
        this.workspaces = [];
        this.workspaceErrorMessage = error instanceof Error
          ? error.message
          : "The workspace list could not be loaded.";
      }
    },

    async loadWorkspaces() {
      const response = await fetch("/api/workspaces", {
        headers: { accept: "application/json" },
      });
      this.workspaces = await readJsonResponse(
        response,
        "Workspace request",
        readWorkspaceSummaries,
      );
    },

    async switchWorkspace(workspaceId) {
      if (workspaceId === this.currentWorkspaceId || this.workspaceSwitching) {
        return;
      }
      this.workspaceErrorMessage = "";
      this.workspaceSwitching = true;
      try {
        if (await browserAuthentication.isOAuthEnabled()) {
          await browserAuthentication.selectWorkspace(workspaceId);
          if (this.currentGlobalRole !== "global_admin") {
            writeSettingsTargetPreference(workspaceId);
          }
          window.location.reload();
          return;
        }
        const response = await fetch("/api/auth/session/workspace", {
          body: JSON.stringify({ workspaceId }),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          method: "PUT",
        });
        await readJsonResponse(response, "Workspace switch");
        if (this.currentGlobalRole !== "global_admin") {
          writeSettingsTargetPreference(workspaceId);
        }
        window.location.reload();
      } catch (error) {
        this.workspaceSwitching = false;
        this.$nextTick(() => {
          if (this.$refs.workspaceSelect instanceof HTMLSelectElement) {
            this.$refs.workspaceSelect.value = this.currentWorkspaceId ?? "";
          }
        });
        this.workspaceErrorMessage = error instanceof Error
          ? error.message
          : "Workspace switch failed.";
      }
    },

    loadDocumentNotifications(userId, workspaceId) {
      const storageKey = buildDocumentNotificationStorageKey(
        userId,
        workspaceId,
      );
      this.documentNotificationStorageKey = storageKey;
      const pendingSubscriptions = this.documentNotificationSubscriptions;
      const storedSubscriptions = readStoredDocumentNotificationSubscriptions(
        sessionStorage,
        storageKey,
      );
      const permission = readBrowserNotificationPermission();
      let subscriptions = permission === "granted" ? storedSubscriptions : [];
      if (permission === "granted") {
        for (const subscription of pendingSubscriptions) {
          subscriptions = changeDocumentNotificationSubscription(
            subscriptions,
            { ...subscription, enabled: true },
          );
        }
      }
      this.documentNotificationSubscriptions = subscriptions;
      if (
        pendingSubscriptions.length > 0
        || subscriptions.length !== storedSubscriptions.length
      ) {
        this.persistDocumentNotifications();
      }
      this.broadcastAllDocumentNotificationStates();
      this.scheduleDocumentNotificationRefresh();
    },

    async changeDocumentNotification(change) {
      if (change.enabled) {
        let permission;
        try {
          permission = await requestBrowserNotificationPermission();
        } catch {
          this.broadcastDocumentNotificationState(
            change.sourceFile,
            "CiteLoom could not request browser notification permission.",
          );
          return;
        }
        if (permission !== "granted") {
          let message = "Browser notification permission was not granted.";
          if (permission === "denied") {
            message = "Browser notifications are blocked for CiteLoom. Allow them in your browser settings to use this feature.";
          } else if (permission === "unsupported") {
            message = "This browser does not support system notifications.";
          }
          this.broadcastDocumentNotificationState(change.sourceFile, message);
          return;
        }
      }
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
        this.broadcastDocumentNotificationState(change.sourceFile, message);
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

    broadcastDocumentNotificationState(sourceFile, errorMessage = null) {
      const enabled = documentNotificationEnabled(
        this.documentNotificationSubscriptions,
        sourceFile,
      );
      window.dispatchEvent(new CustomEvent(DOCUMENT_NOTIFICATION_STATE_EVENT, {
        detail: { enabled, errorMessage, sourceFile },
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
          this.broadcastDocumentNotificationState(
            subscription.sourceFile,
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
      let body;
      let title;
      if (outcomes.length === 1) {
        const [outcome] = outcomes;
        if (outcome.outcome === "failed") {
          title = "Document needs attention";
          body = `${outcome.filename} needs attention.`;
        } else {
          title = "Document ready";
          body = `${outcome.filename} is ready.`;
        }
      } else {
        let failed = 0;
        let ready = 0;
        for (const outcome of outcomes) {
          if (outcome.outcome === "failed") {
            failed += 1;
          } else {
            ready += 1;
          }
        }
        if (failed > 0 && ready > 0) {
          title = "Documents updated";
          body = `${ready} ready and ${failed} needing attention.`;
        } else if (failed > 0) {
          title = "Documents need attention";
          body = `${failed} watched documents need attention.`;
        } else {
          title = "Documents ready";
          body = `${ready} watched documents are ready.`;
        }
      }
      this.showDocumentBrowserNotification(title, body);
    },

    showDocumentBrowserNotification(title, body) {
      try {
        const notification = showBrowserNotification(title, {
          body,
          icon: "/assets/images/citeloom-apple-touch-icon.png",
        });
        if (notification === null) {
          return;
        }
        notification.addEventListener("click", () => {
          window.focus();
          notification.close();
        });
      } catch {
        return;
      }
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

    openDiagnosticsDialog() {
      if (this.diagnosticsRunning) {
        return;
      }
      this.diagnosticsLiveChecks = {
        modelResponse: false,
        searchRanking: false,
        speech: false,
      };
      this.diagnosticsRestoreFocusElement = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      this.diagnosticsDialogOpen = true;
      this.$nextTick(() => {
        document.getElementById("diagnostics-dialog-close")?.focus();
      });
    },

    closeDiagnosticsDialog(restoreFocus = true) {
      if (!this.diagnosticsDialogOpen) {
        return;
      }
      this.diagnosticsDialogOpen = false;
      const restoreFocusElement = this.diagnosticsRestoreFocusElement;
      this.diagnosticsRestoreFocusElement = null;
      if (restoreFocus && restoreFocusElement?.isConnected === true) {
        this.$nextTick(() => restoreFocusElement.focus());
      }
    },

    cycleDiagnosticsDialogFocus(event) {
      const dialog = document.getElementById("diagnostics-dialog");
      if (dialog === null) {
        return;
      }
      const controls = Array.from(dialog.querySelectorAll(
        'button:not([disabled]), input:not([disabled])',
      ));
      const first = controls[0];
      const last = controls.at(-1);
      if (!(first instanceof HTMLElement) || !(last instanceof HTMLElement)) {
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },

    runSelectedDiagnostics() {
      const liveChecks = { ...this.diagnosticsLiveChecks };
      this.closeDiagnosticsDialog(false);
      void this.runDiagnostics(liveChecks);
    },

    async runDiagnostics(liveChecks = {
      modelResponse: false,
      searchRanking: false,
      speech: false,
    }) {
      if (this.diagnosticsRunning) {
        return;
      }
      this.diagnosticsRunning = true;
      this.diagnosticsErrorMessage = "";
      try {
        const response = await fetch("/api/diagnostics", {
          body: JSON.stringify({ liveChecks }),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          method: "POST",
        });
        const value = await readJsonResponse(response, "Diagnostics request");
        const diagnostics = readDiagnostics(value);
        this.diagnosticsChecks = diagnostics.checks;
        const firstExpandedGroup = this.diagnosticsGroups.find((group) => {
          return group.id.startsWith("provider:");
        }) ?? this.diagnosticsGroups[0];
        this.diagnosticsExpandedGroupIds = firstExpandedGroup === undefined
          ? []
          : [firstExpandedGroup.id];
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

    diagnosticGroupSummary(group) {
      const passedCount = group.checks.filter((check) => check.ok).length;
      if (group.checks.length === 1) {
        return group.checks[0].ok ? "Passed" : "Failed";
      }
      return `${passedCount}/${group.checks.length} passed`;
    },

    diagnosticServiceSummary() {
      const passed = this.diagnosticsServicePassedCount;
      const total = this.diagnosticsServiceCheckCount;
      if (passed === total) {
        return `${total} service ${total === 1 ? "check" : "checks"} passed`;
      }
      return `${passed} of ${total} service checks passed`;
    },

    isDiagnosticGroupExpanded(groupId) {
      return this.diagnosticsExpandedGroupIds.includes(groupId);
    },

    toggleDiagnosticGroup(groupId) {
      if (this.isDiagnosticGroupExpanded(groupId)) {
        this.diagnosticsExpandedGroupIds = this.diagnosticsExpandedGroupIds.filter(
          (candidate) => candidate !== groupId,
        );
        return;
      }
      this.diagnosticsExpandedGroupIds = [
        ...this.diagnosticsExpandedGroupIds,
        groupId,
      ];
    },

    async completeIngestion(destination) {
      await this.refreshDashboard();
      if (destination !== null) {
        this.navigateToView(destination);
      }
    },

    navigateToView(view) {
      if (!Object.hasOwn(routes, view)) {
        return;
      }
      const applicationShell = this.$root.closest(".app-shell");
      const link = applicationShell?.querySelector(`a[data-view="${view}"]`);
      if (link instanceof HTMLAnchorElement) {
        link.click();
      }
    },

    prepareSettingsNavigation() {
      if (this.currentGlobalRole === "global_admin") {
        writeSettingsTargetPreference("organization");
        return;
      }
      if (this.currentWorkspaceId !== null) {
        writeSettingsTargetPreference(this.currentWorkspaceId);
      }
    },

    async signOut() {
      this.clearDocumentNotifications();
      clearSettingsTargetPreference();
      if (await browserAuthentication.isOAuthEnabled()) {
        await browserAuthentication.signOut();
        return;
      }
      try {
        await fetch("/api/auth/logout", { method: "POST" });
      } finally {
        window.location.assign("/login");
      }
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
      this.cancelConfirmationForNavigation();
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
