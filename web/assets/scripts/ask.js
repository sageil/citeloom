import {
  readJsonResponse,
  readNonEmptyString,
} from "./boundary-readers.js";
import {
  applyAnswerContentUpdate,
  buildAnswerContentSections,
  createAnswerContentFromDocument,
  createEmptyAnswerContent,
  hasFencedCodeBlock,
  linkAnswerContentCitations,
  linkAnswerContentVerification,
  renderAnswerMarkdown,
} from "./answer-content.js";
import { createAnswerSpeechControls } from "./answer-speech.js";
import {
  aggregateCitationStatus,
  applyResearchVerificationUpdate,
  buildHistoricalAnswer,
  buildStoredCitationPreview,
  feedbackDimensions,
  formatClaimStatusLabel,
  readAnswerStream,
  readAskAnswerSpeechTarget,
  readAskDashboard,
  readDiscoveryResponse,
  readErrorMessage,
  readFeedbackResponse,
  readResearchThreadSummaries,
  readResearchThread,
  readStoredCitation,
} from "./ask-schema.js";
import { createEvidenceSpeechControls } from "./evidence-speech.js";
import {
  buildHighlightedSourceViewerUrl,
  buildPdfViewerUrl,
  isTextSourceFile,
} from "./file-links.js";
import {
  createEvidenceWindowControls,
  findEvidenceCitationTrigger,
  readEvidenceClaimIndex,
  readEvidenceWindowPlacement,
  revealEvidenceCitationTrigger,
} from "./evidence-window.js";
import { focusTextArea } from "./focus.js";
import { createDictationController } from "./dictation.js";
import { requestConfirmation } from "./confirmation.js";
import {
  clearVerificationRefresh as clearVerificationPolling,
  isVerificationPending,
  runVerificationRefresh,
  scheduleVerificationRefresh as scheduleVerificationPolling,
  verificationLabel,
  verificationProgressValue,
  verificationStatusLabel,
} from "./verification.js";

const askAnswerSpeechOptions = {
  audioRefName: "answerSpeechAudio",
  beforePlay(page) {
    page.resetEvidenceSpeechPlayback();
  },
  findPreloadTarget(page) {
    return readAskAnswerSpeechTarget(page.answer);
  },
  findTarget(page, turnId) {
    const target = readAskAnswerSpeechTarget(page.answer);
    if (target === null || target.turnId !== turnId) {
      return null;
    }
    return target;
  },
  readTargetId(target) {
    return target.turnId;
  },
  reportError() {},
  targetIdProperty: "speechAnswerTurnId",
};
const askEvidenceSpeechOptions = {
  audioRefName: "evidenceSpeechAudio",
  beforePlay(page) {
    page.pauseAnswerSpeech();
  },
  readCitation(page) {
    return page.citationLoading ? null : page.inspectedCitation;
  },
  readEvidenceText(page) {
    return page.citationEvidenceText();
  },
  reportError(page, message) {
    page.citationError = message;
  },
};
const askEvidenceWindowOptions = {
  close(page) {
    page.closeEvidenceInspector();
  },
  readCitation(page) {
    return page.inspectedCitation;
  },
  readClaims(page) {
    return page.answer?.claims ?? [];
  },
  readError(page) {
    return page.citationError;
  },
  readFileLabel(page) {
    return page.citationFileLabel();
  },
  readFileUrl(page) {
    return page.citationFileUrl();
  },
  readImageUrl(page) {
    return page.citationImageUrl();
  },
  readLoading(page) {
    return page.citationLoading;
  },
  readSelectedCitation(page) {
    return page.selectedCitation;
  },
  readSummary(page) {
    return page.selectedCitationSummary();
  },
  readText(page) {
    return page.citationEvidenceText();
  },
};

const evidenceInspectorResizeStep = 16;
const minimumEvidenceInspectorHeight = 260;
const minimumEvidenceInspectorWidth = 360;

export function constrainEvidenceInspectorSize(
  width,
  height,
  currentBounds,
  viewport,
) {
  const rightMargin = Math.max(10, viewport.width - currentBounds.right);
  const maximumWidth = Math.max(0, viewport.width - rightMargin - 10);
  const maximumHeight = Math.max(0, viewport.height - currentBounds.top - 10);
  const minimumWidth = Math.min(minimumEvidenceInspectorWidth, maximumWidth);
  const minimumHeight = Math.min(minimumEvidenceInspectorHeight, maximumHeight);
  return {
    height: clampEvidenceInspectorDimension(
      height,
      minimumHeight,
      maximumHeight,
    ),
    width: clampEvidenceInspectorDimension(
      width,
      minimumWidth,
      maximumWidth,
    ),
  };
}

export function readExpandedEvidenceInspectorSize(currentBounds, viewport) {
  return constrainEvidenceInspectorSize(
    viewport.width,
    viewport.height,
    currentBounds,
    viewport,
  );
}

function clampEvidenceInspectorDimension(value, minimum, maximum) {
  return Math.min(Math.max(Math.round(value), minimum), maximum);
}

export const readAskEvidencePanelPlacement = readEvidenceWindowPlacement;

export function formatDocumentLocationLabel(sourceFile, pageNumbers) {
  const normalizedSourceFile = sourceFile.toLowerCase();
  let singular = "Page";
  let plural = "Pages";
  if (normalizedSourceFile.endsWith(".xlsx")) {
    singular = "Sheet";
    plural = "Sheets";
  } else if (normalizedSourceFile.endsWith(".pptx")) {
    singular = "Slide";
    plural = "Slides";
  }
  if (pageNumbers.length === 0) {
    return "";
  }
  if (pageNumbers.length === 1) {
    return `${singular} ${pageNumbers[0]}`;
  }
  return `${plural} ${pageNumbers.join(", ")}`;
}

function readEvidenceInspectorViewport() {
  return {
    height: window.innerHeight,
    width: window.innerWidth,
  };
}

export function registerPage(alpine) {
  alpine.data("citeloomAskPage", () => ({
    answer: null,
    answerContentSections: [],
    streamedAnswerContent: createEmptyAnswerContent(),
    availableTagFacets: [],
    citationAbortController: null,
    citationError: "",
    citationInspectorExpanded: false,
    citationInspectorExpandedRestoreSize: null,
    citationInspectorResizeSession: null,
    citationInspectorSize: null,
    citationInspectorViewportResizeListener: null,
    citationImageDimensions: null,
    citationLoading: false,
    claimVerifierSupportThreshold: null,
    creatingThread: false,
    dashboardError: "",
    dashboardRefreshListener: null,
    deletingThread: false,
    discoveryResult: null,
    discoveryPageAbortController: null,
    discoveryPageLoading: false,
    discoveryScope: null,
    discoveryStatus: "",
    dictationController: null,
    feedback: { answer: 0, citation: 0, retrieval: 0 },
    feedbackCounts: {
      answer: { negative: 0, positive: 0 },
      citation: { negative: 0, positive: 0 },
      retrieval: { negative: 0, positive: 0 },
    },
    includeRelated: false,
    inferenceRuntimeName: "the configured inference runtime",
    inspectedCitation: null,
    expandedDiscoveryResultKeys: [],
    ...createAnswerSpeechControls(askAnswerSpeechOptions),
    ...createEvidenceWindowControls(askEvidenceWindowOptions),
    ...createEvidenceSpeechControls(askEvidenceSpeechOptions),
    historicalAnswerVisible: false,
    mode: "ask",
    newThreadTitle: "",
    operation: null,
    pushToTalkActive: false,
    pushToTalkAltHeld: false,
    pushToTalkBlockedUntilRelease: false,
    pushToTalkBlurListener: null,
    pushToTalkKeyDownListener: null,
    hasFencedCodeBlock,
    renderMarkdown: renderAnswerMarkdown,
    pushToTalkKeyUpListener: null,
    question: "",
    queryableDocumentCount: 0,
    requestAbortController: null,
    requestError: "",
    scopeKind: "all",
    selectedCitation: null,
    selectedDiscoveryDocuments: [],
    selectedTags: [],
    speechState: "idle",
    speechStatus: "",
    speechToTextEnabled: false,
    tagPickerOpen: false,
    tagSearchQuery: "",
    textToSpeechEnabled: false,
    textToSpeechPreloadEnabled: false,
    thread: null,
    threadId: "",
    threads: [],
    threadsError: "",
    threadsLoading: false,
    turnId: "",
    verificationRefreshTimer: null,

    async initialize() {
      this.initializeDictationController();
      this.dashboardRefreshListener = () => {
        void this.loadDashboard();
      };
      this.pushToTalkKeyDownListener = (event) => {
        this.handlePushToTalkKeyDown(event.key);
      };
      this.pushToTalkKeyUpListener = (event) => {
        this.handlePushToTalkKeyUp(event.key);
      };
      this.pushToTalkBlurListener = () => {
        this.releasePushToTalk();
      };
      this.citationInspectorViewportResizeListener = () => {
        this.resizeExpandedCitationInspector();
      };
      window.addEventListener(
        "citeloom:documents-revision",
        this.dashboardRefreshListener,
      );
      window.addEventListener(
        "citeloom:settings-revision",
        this.dashboardRefreshListener,
      );
      window.addEventListener("keydown", this.pushToTalkKeyDownListener);
      window.addEventListener("keyup", this.pushToTalkKeyUpListener);
      window.addEventListener("blur", this.pushToTalkBlurListener);
      window.addEventListener(
        "resize",
        this.citationInspectorViewportResizeListener,
      );
      await Promise.all([
        this.loadDashboard(),
        this.loadResearchThreads(),
      ]);
      this.maybePreloadAnswerSpeech();
      this.focusQuestionInput();
    },

    destroy() {
      if (this.dashboardRefreshListener !== null) {
        window.removeEventListener(
          "citeloom:documents-revision",
          this.dashboardRefreshListener,
        );
        window.removeEventListener(
          "citeloom:settings-revision",
          this.dashboardRefreshListener,
        );
      }
      if (this.pushToTalkKeyDownListener !== null) {
        window.removeEventListener("keydown", this.pushToTalkKeyDownListener);
      }
      if (this.pushToTalkKeyUpListener !== null) {
        window.removeEventListener("keyup", this.pushToTalkKeyUpListener);
      }
      if (this.pushToTalkBlurListener !== null) {
        window.removeEventListener("blur", this.pushToTalkBlurListener);
      }
      if (this.citationInspectorViewportResizeListener !== null) {
        window.removeEventListener(
          "resize",
          this.citationInspectorViewportResizeListener,
        );
      }
      this.pushToTalkActive = false;
      this.pushToTalkAltHeld = false;
      this.pushToTalkBlockedUntilRelease = false;
      this.stopRequest();
      this.clearVerificationRefresh();
      this.citationAbortController?.abort();
      this.resetCitationInspectorSize();
      this.dictationController?.destroy();
      this.dictationController = null;
      this.resetEvidenceSpeechPlayback();
      this.resetAnswerSpeechAudio();
    },

    async loadDashboard() {
      try {
        const response = await fetch("/api/dashboard", {
          headers: { accept: "application/json" },
        });
        const snapshot = await readJsonResponse(
          response,
          "Dashboard request",
          readAskDashboard,
        );
        this.availableTagFacets = snapshot.availableTagFacets;
        this.claimVerifierSupportThreshold =
          snapshot.claimVerifierSupportThreshold;
        this.retainAvailableSelectedTags();
        this.inferenceRuntimeName = snapshot.inferenceRuntimeName;
        this.queryableDocumentCount = snapshot.queryableDocumentCount;
        this.speechToTextEnabled = snapshot.speechToTextEnabled;
        this.textToSpeechEnabled = snapshot.textToSpeechEnabled;
        this.textToSpeechPreloadEnabled = snapshot.textToSpeechPreloadEnabled;
        if (!this.textToSpeechEnabled) {
          this.resetAnswerSpeechAudio();
          this.resetEvidenceSpeechPlayback();
        }
        if (!this.speechToTextEnabled) {
          this.cancelDictation();
        }
        this.dashboardError = "";
        this.maybePreloadAnswerSpeech();
      } catch (error) {
        this.dashboardError = readErrorMessage(
          error,
          "The Ask workspace configuration could not be loaded.",
        );
      }
    },

    async loadResearchThreads() {
      this.threadsLoading = true;
      try {
        const response = await fetch("/api/research/threads", {
          headers: { accept: "application/json" },
        });
        this.threads = await readJsonResponse(
          response,
          "Research threads request",
          readResearchThreadSummaries,
        );
        this.threadsError = "";
      } catch (error) {
        this.threadsError = readErrorMessage(
          error,
          "Research threads could not be loaded.",
        );
      } finally {
        this.threadsLoading = false;
      }
    },

    clearAnswerPresentation() {
      this.clearVerificationRefresh();
      this.answer = null;
      this.streamedAnswerContent = createEmptyAnswerContent();
      this.answerContentSections = [];
      this.historicalAnswerVisible = false;
    },

    presentHistoricalAnswer(answer) {
      if (answer === null) {
        this.clearAnswerPresentation();
        return;
      }
      const content = createAnswerContentFromDocument(answer.answerDocument);
      linkAnswerContentCitations(content, answer.sources);
      this.answer = answer;
      this.streamedAnswerContent = content;
      this.answerContentSections = buildAnswerContentSections(content);
      this.historicalAnswerVisible = true;
      this.scheduleVerificationRefresh();
    },

    applyStreamedAnswerUpdate(update) {
      const content = applyAnswerContentUpdate(
        this.streamedAnswerContent,
        update,
      );
      this.streamedAnswerContent = content;
      this.answerContentSections = buildAnswerContentSections(content);
    },

    completeStreamedAnswer(answer) {
      linkAnswerContentVerification(
        this.streamedAnswerContent,
        this.answerContentSections,
        answer.answerDocument,
      );
      linkAnswerContentCitations(this.streamedAnswerContent, answer.sources);
      this.answer = answer;
      this.scheduleVerificationRefresh();
    },

    async selectResearchThread(threadId) {
      if (this.operation === "answer") {
        this.stopRequest();
      }
      this.threadId = threadId;
      this.thread = null;
      this.turnId = "";
      this.clearAnswerPresentation();
      this.requestError = "";
      this.closeEvidenceInspector();
      this.resetAnswerSpeechAudio();
      if (threadId === "") {
        return;
      }
      await this.loadResearchThread(threadId);
    },

    async loadResearchThread(
      threadId,
      preferredTurnId = "",
      preserveRenderedAnswer = false,
    ) {
      try {
        const encodedThreadId = encodeURIComponent(threadId);
        const response = await fetch(`/api/research/threads/${encodedThreadId}`, {
          headers: { accept: "application/json" },
        });
        const thread = await readJsonResponse(
          response,
          "Research thread request",
          readResearchThread,
        );
        if (this.threadId !== threadId) {
          return;
        }
        this.thread = thread;
        const latestTurn = thread.turns.at(-1) ?? null;
        let nextTurn = latestTurn;
        if (preferredTurnId !== "") {
          nextTurn = thread.turns.find((turn) => {
            return turn.id === preferredTurnId;
          }) ?? latestTurn;
        }
        this.turnId = nextTurn?.id ?? "";
        const nextAnswer = nextTurn === null
          ? null
          : buildHistoricalAnswer(nextTurn);
        const currentTurnId = this.answer?.turn.turnId ?? "";
        if (!preserveRenderedAnswer || currentTurnId !== this.turnId) {
          this.presentHistoricalAnswer(nextAnswer);
        }
        this.feedback = { answer: 0, citation: 0, retrieval: 0 };
        this.feedbackCounts = {
          answer: { negative: 0, positive: 0 },
          citation: { negative: 0, positive: 0 },
          retrieval: { negative: 0, positive: 0 },
        };
        await this.loadTurnFeedback();
        this.resetAnswerSpeechAudio();
        await this.loadResearchThreads();
        this.maybePreloadAnswerSpeech();
      } catch (error) {
        this.requestError = readErrorMessage(
          error,
          "The research thread could not be loaded.",
        );
      }
    },

    async selectHistoricalTurn(turnId) {
      this.turnId = turnId;
      const turn = this.thread?.turns.find((candidate) => {
        return candidate.id === turnId;
      }) ?? null;
      this.presentHistoricalAnswer(
        turn === null ? null : buildHistoricalAnswer(turn),
      );
      this.feedback = { answer: 0, citation: 0, retrieval: 0 };
      this.feedbackCounts = {
        answer: { negative: 0, positive: 0 },
        citation: { negative: 0, positive: 0 },
        retrieval: { negative: 0, positive: 0 },
      };
      await this.loadTurnFeedback();
      this.closeEvidenceInspector();
      this.resetAnswerSpeechAudio();
      this.maybePreloadAnswerSpeech();
    },

    async createThread() {
      if (this.operation === "answer") {
        return;
      }
      const title = this.newThreadTitle.trim();
      if (title === "") {
        this.requestError = "Enter a thread title, or use Default when asking.";
        return;
      }
      this.creatingThread = true;
      this.requestError = "";
      try {
        await this.resolveResearchThread(title);
        this.newThreadTitle = "";
      } catch (error) {
        this.requestError = readErrorMessage(
          error,
          "The research thread could not be selected.",
        );
      } finally {
        this.creatingThread = false;
      }
    },

    async requestResearchThread(title, abortSignal) {
      const response = await fetch("/api/research/threads", {
        body: JSON.stringify({ title }),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        method: "POST",
        signal: abortSignal,
      });
      const thread = await readJsonResponse(
        response,
        "Resolve research thread request",
        readResearchThread,
      );
      return thread;
    },

    async resolveResearchThread(title, abortSignal) {
      const thread = await this.requestResearchThread(title, abortSignal);
      if (abortSignal?.aborted === true) {
        return thread;
      }
      this.thread = thread;
      this.threadId = thread.id;
      const latestTurn = thread.turns.at(-1) ?? null;
      this.turnId = latestTurn?.id ?? "";
      this.presentHistoricalAnswer(
        latestTurn === null ? null : buildHistoricalAnswer(latestTurn),
      );
      await this.loadResearchThreads();
      return thread;
    },

    async resolveAnsweringThreadId(abortSignal) {
      const requestedTitle = this.newThreadTitle.trim();
      if (requestedTitle !== "") {
        const thread = await this.requestResearchThread(
          requestedTitle,
          abortSignal,
        );
        if (!abortSignal.aborted) {
          this.thread = thread;
          this.threadId = thread.id;
          this.turnId = "";
          this.newThreadTitle = "";
          await this.loadResearchThreads();
        }
        return thread.id;
      }
      if (this.threadId !== "") {
        return this.threadId;
      }
      const thread = await this.requestResearchThread("Default", abortSignal);
      if (!abortSignal.aborted) {
        this.thread = thread;
        this.threadId = thread.id;
        this.turnId = "";
        await this.loadResearchThreads();
      }
      return thread.id;
    },

    async deleteThread() {
      if (
        this.thread === null
        || this.deletingThread
        || this.operation === "answer"
      ) {
        return;
      }
      const thread = this.thread;
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep thread",
        confirmLabel: "Delete thread",
        description: "This permanently removes every saved turn and its retained evidence. This action cannot be undone.",
        title: `Delete “${thread.title}”?`,
        tone: "danger",
      });
      if (
        !confirmed
        || this.thread?.id !== thread.id
        || this.operation === "answer"
      ) {
        return;
      }
      this.deletingThread = true;
      try {
        const encodedThreadId = encodeURIComponent(thread.id);
        const response = await fetch(`/api/research/threads/${encodedThreadId}`, {
          method: "DELETE",
        });
        if (!response.ok) {
          await readJsonResponse(response, "Delete research thread request");
        }
        if (this.thread?.id === thread.id) {
          this.thread = null;
          this.threadId = "";
          this.turnId = "";
          this.clearAnswerPresentation();
        }
        await this.loadResearchThreads();
      } catch (error) {
        this.requestError = readErrorMessage(
          error,
          "The research thread could not be deleted.",
        );
      } finally {
        this.deletingThread = false;
      }
    },

    changeMode(nextMode) {
      if (nextMode !== "ask" && nextMode !== "discover") {
        return;
      }
      if (this.mode === nextMode) {
        return;
      }
      this.stopRequest();
      this.releasePushToTalk();
      this.mode = nextMode;
      this.requestError = "";
      this.closeEvidenceInspector();
    },

    changeScope(value) {
      if (value !== "all" && value !== "tag") {
        return;
      }
      this.scopeKind = value;
      if (value === "all") {
        this.selectedTags = [];
        this.closeTagPicker();
      }
    },

    changeSelectedScope(value) {
      if (value === "selected") {
        return;
      }
      this.changeScope(value);
    },

    closeTagPicker() {
      this.tagPickerOpen = false;
      this.tagSearchQuery = "";
    },

    filteredAvailableTagFacets() {
      const query = this.tagSearchQuery.trim().toLocaleLowerCase();
      if (query === "") {
        return this.availableTagFacets;
      }
      const matches = [];
      for (const facet of this.availableTagFacets) {
        if (facet.tag.toLocaleLowerCase().includes(query)) {
          matches.push(facet);
        }
      }
      return matches;
    },

    isTagSelected(tag) {
      return this.selectedTags.includes(tag);
    },

    openTagPicker() {
      this.tagPickerOpen = true;
      this.$nextTick(() => {
        this.$refs.tagScopeSearch?.focus();
      });
    },

    removeSelectedTag(tag) {
      const remainingTags = [];
      for (const selectedTag of this.selectedTags) {
        if (selectedTag !== tag) {
          remainingTags.push(selectedTag);
        }
      }
      this.selectedTags = remainingTags;
    },

    retainAvailableSelectedTags() {
      const availableTags = new Set();
      for (const facet of this.availableTagFacets) {
        availableTags.add(facet.tag);
      }
      const retainedTags = [];
      for (const selectedTag of this.selectedTags) {
        if (availableTags.has(selectedTag)) {
          retainedTags.push(selectedTag);
        }
      }
      this.selectedTags = retainedTags;
      if (this.availableTagFacets.length === 0) {
        this.closeTagPicker();
      }
    },

    toggleTagPicker() {
      if (this.tagPickerOpen) {
        this.closeTagPicker();
        return;
      }
      this.openTagPicker();
    },

    toggleTagSelection(tag) {
      if (this.isTagSelected(tag)) {
        this.removeSelectedTag(tag);
        return;
      }
      this.selectedTags.push(tag);
    },

    buildScope(questionDocuments) {
      if (questionDocuments.length > 0) {
        const sourceFiles = [];
        for (const document of questionDocuments) {
          sourceFiles.push(readNonEmptyString(
            document.sourceFile,
            "selected question document source file",
          ));
        }
        return { kind: "sourceFiles", sourceFiles };
      }
      if (this.scopeKind === "tag") {
        const tags = [];
        for (const selectedTag of this.selectedTags) {
          const tag = selectedTag.trim();
          if (tag !== "" && !tags.includes(tag)) {
            tags.push(tag);
          }
        }
        if (tags.length === 0) {
          throw new Error("Select at least one tag for this search scope.");
        }
        return { kind: "tags", tags };
      }
      return { kind: "all" };
    },

    submit(questionDocuments) {
      if (this.mode === "discover") {
        void this.runDiscovery(1, true, questionDocuments);
        return;
      }
      void this.askQuestion(questionDocuments);
    },

    handleSubmitShortcut(questionDocuments) {
      if (this.speechState !== "idle" && this.speechState !== "error") {
        return;
      }
      if (this.operation !== null) {
        this.stopRequest(true);
        return;
      }
      this.submit(questionDocuments);
    },

    async askQuestion(questionDocuments) {
      const question = this.question.trim();
      if (question === "") {
        this.requestError = "Enter a question about the indexed documents.";
        return;
      }
      let scope;
      try {
        scope = this.buildScope(questionDocuments);
      } catch (error) {
        this.requestError = readErrorMessage(error, "The search scope is invalid.");
        return;
      }
      this.stopRequest();
      const controller = new AbortController();
      this.requestAbortController = controller;
      this.operation = "answer";
      this.requestError = "";
      this.clearAnswerPresentation();
      this.closeEvidenceInspector();
      this.resetAnswerSpeechAudio();
      try {
        const answeringThreadId = await this.resolveAnsweringThreadId(
          controller.signal,
        );
        controller.signal.throwIfAborted();
        const response = await fetch("/api/questions", {
          body: JSON.stringify({
            question,
            scope,
            threadId: answeringThreadId,
          }),
          headers: {
            accept: "text/event-stream",
            "content-type": "application/json",
          },
          method: "POST",
          signal: controller.signal,
        });
        await readAnswerStream(
          response,
          (answer) => {
            if (!controller.signal.aborted) {
              this.completeStreamedAnswer(answer);
            }
          },
          (update) => {
            if (!controller.signal.aborted && this.answer === null) {
              this.applyStreamedAnswerUpdate(update);
            }
          },
        );
        const completedTurnId = this.answer?.turn.turnId ?? "";
        if (!controller.signal.aborted) {
          await this.loadResearchThread(
            answeringThreadId,
            completedTurnId,
            true,
          );
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = readErrorMessage(
            error,
            "The answer could not be generated.",
          );
          this.requestError = message;
        }
      } finally {
        if (this.requestAbortController === controller) {
          this.requestAbortController = null;
          this.operation = null;
        }
        this.focusQuestionInput();
      }
    },

    focusQuestionInput() {
      this.$nextTick(() => focusTextArea(this.$refs.questionInput));
    },

    async runDiscovery(
      keywordPage,
      clearSelection,
      questionDocuments,
      requestedQuery = this.question,
    ) {
      const query = requestedQuery.trim();
      if (query === "") {
        this.requestError = "Enter a topic or keywords to find sources.";
        return;
      }
      let scope;
      try {
        scope = this.buildScope(questionDocuments);
      } catch (error) {
        this.requestError = readErrorMessage(error, "The search scope is invalid.");
        return;
      }
      this.stopRequest();
      const controller = new AbortController();
      this.requestAbortController = controller;
      this.operation = "search";
      this.discoveryStatus = "Searching indexed sources.";
      this.discoveryResult = null;
      this.expandedDiscoveryResultKeys = [];
      this.requestError = "";
      if (clearSelection) {
        this.selectedDiscoveryDocuments = [];
      }
      try {
        const response = await fetch("/api/search", {
          body: JSON.stringify({
            includeRelated: this.includeRelated,
            keywordPage,
            query,
            scope,
          }),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          method: "POST",
          signal: controller.signal,
        });
        const result = await readJsonResponse(
          response,
          "Source discovery request",
          readDiscoveryResponse,
        );
        if (!controller.signal.aborted) {
          this.discoveryResult = result;
          this.discoveryScope = scope;
          this.initializeDiscoveryExpansion(result);
          this.discoveryStatus = `Search completed. ${this.discoverySummary()}`;
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          this.discoveryStatus = "Source discovery could not be completed.";
          this.requestError = readErrorMessage(
            error,
            "Source discovery could not be completed.",
          );
        }
      } finally {
        if (this.requestAbortController === controller) {
          this.requestAbortController = null;
          this.operation = null;
        }
      }
    },

    runDiscoveryPage(direction) {
      const exact = this.discoveryExactResults();
      if (
        exact === null
        || this.discoveryScope === null
        || this.operation !== null
        || this.discoveryPageLoading
      ) {
        return;
      }
      const currentPage = exact.page;
      const pageOffset = direction === "previous" ? -1 : 1;
      const requestedPage = currentPage + pageOffset;
      this.goToDiscoveryPage(requestedPage);
    },

    goToDiscoveryPage(requestedPage) {
      const exact = this.discoveryExactResults();
      if (
        exact === null
        || this.discoveryScope === null
        || this.operation !== null
        || this.discoveryPageLoading
        || requestedPage === exact.page
        || requestedPage < 1
        || requestedPage > this.discoveryTotalPages()
      ) {
        return;
      }
      void this.loadDiscoveryPage(requestedPage);
    },

    async loadDiscoveryPage(keywordPage) {
      const exact = this.discoveryExactResults();
      if (
        this.discoveryResult === null
        || exact === null
        || this.discoveryScope === null
      ) {
        return;
      }
      this.discoveryPageAbortController?.abort();
      const controller = new AbortController();
      const completedResult = this.discoveryResult;
      this.discoveryPageAbortController = controller;
      this.discoveryPageLoading = true;
      this.discoveryStatus = `Loading keyword results page ${keywordPage}.`;
      this.requestError = "";
      try {
        const response = await fetch("/api/search", {
          body: JSON.stringify({
            includeRelated: false,
            keywordPage,
            query: completedResult.query,
            scope: this.discoveryScope,
          }),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          method: "POST",
          signal: controller.signal,
        });
        const pageResult = await readJsonResponse(
          response,
          "Keyword results page request",
          readDiscoveryResponse,
        );
        if (!controller.signal.aborted) {
          if (pageResult.results.kind !== "exact") {
            throw new Error("The exact-match page response has the wrong result kind.");
          }
          if (completedResult.results.kind === "exact-and-related") {
            this.discoveryResult = {
              query: pageResult.query,
              results: {
                exact: {
                  documents: pageResult.results.documents,
                  page: pageResult.results.page,
                  pageSize: pageResult.results.pageSize,
                  totalDocuments: pageResult.results.totalDocuments,
                },
                kind: "exact-and-related",
                related: completedResult.results.related,
              },
            };
          } else {
            this.discoveryResult = pageResult;
          }
          this.initializeDiscoveryExpansion(this.discoveryResult);
          this.discoveryStatus = `Keyword results page ${keywordPage} loaded. ${this.discoverySummary()}`;
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          this.discoveryStatus = "The requested results page could not be loaded.";
          this.requestError = readErrorMessage(
            error,
            "The requested results page could not be loaded.",
          );
        }
      } finally {
        if (this.discoveryPageAbortController === controller) {
          this.discoveryPageAbortController = null;
          this.discoveryPageLoading = false;
        }
      }
    },

    stopRequest(announce = false) {
      const stoppedOperation = this.operation;
      this.discoveryPageAbortController?.abort();
      this.discoveryPageAbortController = null;
      this.discoveryPageLoading = false;
      this.requestAbortController?.abort();
      this.requestAbortController = null;
      this.operation = null;
      if (announce && stoppedOperation === "search") {
        this.discoveryStatus = this.discoveryResult === null
          ? "The latest search stopped."
          : "The latest search stopped. Previous completed results are still shown.";
      }
    },

    async inspectCitation(source, trigger = null, claimIndex = null) {
      if (source.preview === true) {
        return;
      }
      this.resetEvidenceSpeechPlayback();
      this.citationAbortController?.abort();
      const controller = new AbortController();
      this.citationAbortController = controller;
      this.prepareEvidencePanel(trigger, claimIndex);
      this.selectedCitation = source;
      this.inspectedCitation = buildStoredCitationPreview(source);
      this.citationError = "";
      this.citationImageDimensions = null;
      this.citationLoading = true;
      this.feedback = {
        answer: this.feedback.answer,
        citation: 0,
        retrieval: this.feedback.retrieval,
      };
      this.feedbackCounts = {
        ...this.feedbackCounts,
        citation: { negative: 0, positive: 0 },
      };
      await this.$nextTick();
      if (controller.signal.aborted) {
        return;
      }
      if (this.mode === "ask") {
        const panelReady = await this.completeEvidencePanelOpen(source.id);
        if (controller.signal.aborted) {
          return;
        }
        if (!panelReady) {
          this.citationError = "Citation evidence could not be displayed.";
        }
      } else {
        this.$root.querySelector(".evidence-inspector")?.focus();
      }
      try {
        const encodedCitationId = encodeURIComponent(source.id);
        const response = await fetch(`/api/citations/${encodedCitationId}`, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        const citation = await readJsonResponse(
          response,
          "Citation evidence request",
          readStoredCitation,
        );
        if (!controller.signal.aborted) {
          this.inspectedCitation = citation;
          await this.loadFeedbackSummary("citation-correctness", citation.id);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          this.citationError = readErrorMessage(
            error,
            "Citation evidence could not be loaded.",
          );
        }
      } finally {
        if (this.citationAbortController === controller) {
          this.citationAbortController = null;
          this.citationLoading = false;
          await this.$nextTick();
          this.repositionEvidencePanel();
        }
      }
    },

    inspectCitationNumber(citationNumber) {
      const source = this.answer?.sources.find((candidate) => {
        return candidate.citationNumber === citationNumber;
      });
      if (source !== undefined) {
        void this.inspectCitationFromNavigator(source);
      }
    },

    readAskFindingCitationTrigger(citationId) {
      return findEvidenceCitationTrigger(
        this.$root,
        citationId,
      );
    },

    async inspectCitationFromNavigator(source) {
      const trigger = this.readAskFindingCitationTrigger(source.id);
      if (trigger === null) {
        await this.inspectCitation(source);
        return;
      }
      const claimIndex = readEvidenceClaimIndex(trigger);
      revealEvidenceCitationTrigger(trigger);
      await this.$nextTick();
      await this.inspectCitation(source, trigger, claimIndex);
    },

    citationInspectorStyle() {
      if (this.mode === "ask") {
        return {};
      }
      if (this.citationInspectorSize === null) {
        return {};
      }
      return {
        height: `${this.citationInspectorSize.height}px`,
        width: `${this.citationInspectorSize.width}px`,
      };
    },

    readEvidenceInspectorElement() {
      const inspector = this.$root.querySelector(".evidence-inspector");
      if (!(inspector instanceof HTMLElement)) {
        throw new Error("The citation evidence inspector is unavailable.");
      }
      return inspector;
    },

    beginCitationInspectorResize(event) {
      if (
        event.button !== 0
        || this.citationInspectorResizeSession !== null
      ) {
        return;
      }
      const inspector = this.readEvidenceInspectorElement();
      this.leaveExpandedCitationInspectorForManualResize();
      const bounds = inspector.getBoundingClientRect();
      this.citationInspectorResizeSession = {
        pointerId: event.pointerId,
        startHeight: bounds.height,
        startWidth: bounds.width,
        startX: event.clientX,
        startY: event.clientY,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },

    continueCitationInspectorResize(event) {
      const session = this.citationInspectorResizeSession;
      if (session === null || session.pointerId !== event.pointerId) {
        return;
      }
      const inspector = this.readEvidenceInspectorElement();
      const bounds = inspector.getBoundingClientRect();
      const width = session.startWidth + session.startX - event.clientX;
      const height = session.startHeight + event.clientY - session.startY;
      this.citationInspectorSize = constrainEvidenceInspectorSize(
        width,
        height,
        bounds,
        readEvidenceInspectorViewport(),
      );
    },

    finishCitationInspectorResize(event) {
      const session = this.citationInspectorResizeSession;
      if (session === null || session.pointerId !== event.pointerId) {
        return;
      }
      this.citationInspectorResizeSession = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },

    resizeCitationInspectorWithKeyboard(event) {
      const inspector = this.readEvidenceInspectorElement();
      const step = event.shiftKey
        ? evidenceInspectorResizeStep * 3
        : evidenceInspectorResizeStep;
      let heightDelta = 0;
      let widthDelta = 0;
      if (event.key === "ArrowLeft") {
        widthDelta = step;
      } else if (event.key === "ArrowRight") {
        widthDelta = -step;
      } else if (event.key === "ArrowDown") {
        heightDelta = step;
      } else if (event.key === "ArrowUp") {
        heightDelta = -step;
      } else {
        return;
      }
      this.leaveExpandedCitationInspectorForManualResize();
      const bounds = inspector.getBoundingClientRect();
      this.citationInspectorSize = constrainEvidenceInspectorSize(
        bounds.width + widthDelta,
        bounds.height + heightDelta,
        bounds,
        readEvidenceInspectorViewport(),
      );
      event.preventDefault();
    },

    leaveExpandedCitationInspectorForManualResize() {
      if (!this.citationInspectorExpanded) {
        return;
      }
      this.citationInspectorExpanded = false;
      this.citationInspectorExpandedRestoreSize = null;
    },

    toggleExpandedCitationInspector() {
      const inspector = this.readEvidenceInspectorElement();
      if (this.citationInspectorExpanded) {
        this.citationInspectorSize = this.citationInspectorExpandedRestoreSize;
        this.citationInspectorExpanded = false;
        this.citationInspectorExpandedRestoreSize = null;
        return;
      }
      this.citationInspectorExpandedRestoreSize = this.citationInspectorSize;
      this.citationInspectorSize = readExpandedEvidenceInspectorSize(
        inspector.getBoundingClientRect(),
        readEvidenceInspectorViewport(),
      );
      this.citationInspectorExpanded = true;
    },

    resizeExpandedCitationInspector() {
      if (!this.citationInspectorExpanded || this.selectedCitation === null) {
        return;
      }
      const inspector = this.readEvidenceInspectorElement();
      this.citationInspectorSize = readExpandedEvidenceInspectorSize(
        inspector.getBoundingClientRect(),
        readEvidenceInspectorViewport(),
      );
    },

    resetCitationInspectorSize() {
      this.citationInspectorExpanded = false;
      this.citationInspectorExpandedRestoreSize = null;
      this.citationInspectorResizeSession = null;
      this.citationInspectorSize = null;
    },

    closeEvidenceInspector() {
      this.citationAbortController?.abort();
      this.citationAbortController = null;
      this.resetEvidenceSpeechPlayback();
      this.resetEvidencePanelState();
      this.inspectedCitation = null;
      this.citationError = "";
      this.citationImageDimensions = null;
      this.citationLoading = false;
      this.resetCitationInspectorSize();
      this.selectedCitation = null;
    },

    async submitFeedback(dimension, rating, citationId) {
      if (!feedbackDimensions.includes(dimension) || (rating !== -1 && rating !== 1)) {
        return;
      }
      const turnId = this.answer?.turn.turnId;
      if (turnId === undefined) {
        return;
      }
      try {
        const response = await fetch("/api/research/feedback", {
          body: JSON.stringify({
            citationId,
            comment: null,
            dimension,
            rating,
            turnId,
          }),
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          method: "POST",
        });
        const summary = await readJsonResponse(
          response,
          "Research feedback request",
          readFeedbackResponse,
        );
        const feedback = { ...this.feedback };
        if (dimension === "answer-usefulness") {
          feedback.answer = rating;
        } else if (dimension === "retrieval-relevance") {
          feedback.retrieval = rating;
        } else {
          feedback.citation = rating;
        }
        this.feedback = feedback;
        this.applyFeedbackSummary(dimension, summary);
      } catch (error) {
        this.requestError = readErrorMessage(
          error,
          "Research feedback could not be saved.",
        );
      }
    },

    applyFeedbackSummary(dimension, summary) {
      const key = dimension === "answer-usefulness"
        ? "answer"
        : dimension === "retrieval-relevance" ? "retrieval" : "citation";
      this.feedback = { ...this.feedback, [key]: summary.rating };
      this.feedbackCounts = {
        ...this.feedbackCounts,
        [key]: {
          negative: summary.negativeCount,
          positive: summary.positiveCount,
        },
      };
    },

    async loadFeedbackSummary(dimension, citationId) {
      if (this.turnId === "") {
        return;
      }
      const response = await fetch("/api/research/feedback-summary", {
        body: JSON.stringify({ citationId, dimension, turnId: this.turnId }),
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
      });
      const summary = await readJsonResponse(
        response,
        "Research feedback summary request",
        readFeedbackResponse,
      );
      this.applyFeedbackSummary(dimension, summary);
    },

    async loadTurnFeedback() {
      await Promise.all([
        this.loadFeedbackSummary("answer-usefulness", null),
        this.loadFeedbackSummary("retrieval-relevance", null),
      ]);
    },

    initializeDictationController() {
      this.dictationController = createDictationController({
        onStart: () => {
          this.question = "";
          this.$nextTick(() => this.$refs.questionInput?.focus());
        },
        onStateChange: (snapshot) => {
          this.speechState = snapshot.state;
          this.speechStatus = snapshot.status;
        },
        onTranscript: (transcript) => {
          this.question = transcript;
          this.$nextTick(() => this.$refs.questionInput?.focus());
        },
      });
    },

    async startDictation() {
      await this.dictationController?.start();
    },

    handlePushToTalkKeyDown(key) {
      if (key === "Alt") {
        const firstKeyDown = !this.pushToTalkAltHeld;
        this.pushToTalkAltHeld = true;
        if (
          firstKeyDown
          && !this.pushToTalkActive
          && !this.pushToTalkBlockedUntilRelease
          && this.canStartPushToTalk()
        ) {
          this.pushToTalkActive = true;
          void this.startDictation();
        }
        return;
      }
      if (!this.pushToTalkActive) {
        return;
      }
      this.pushToTalkActive = false;
      this.pushToTalkBlockedUntilRelease = this.pushToTalkAltHeld;
      this.cancelDictation();
    },

    handlePushToTalkKeyUp(key) {
      if (key !== "Alt") {
        return;
      }
      this.pushToTalkAltHeld = false;
      this.pushToTalkBlockedUntilRelease = false;
      if (!this.pushToTalkActive) {
        return;
      }
      this.pushToTalkActive = false;
      this.releasePushToTalkRecording();
    },

    canStartPushToTalk() {
      return this.mode === "ask"
        && this.speechToTextEnabled
        && this.operation === null
        && (this.speechState === "idle" || this.speechState === "error");
    },

    releasePushToTalk() {
      this.pushToTalkAltHeld = false;
      this.pushToTalkBlockedUntilRelease = false;
      if (!this.pushToTalkActive) {
        return;
      }
      this.pushToTalkActive = false;
      this.releasePushToTalkRecording();
    },

    releasePushToTalkRecording() {
      if (this.speechState === "recording") {
        this.stopDictation();
        return;
      }
      if (this.speechState === "requesting") {
        this.cancelDictation();
      }
    },

    stopDictation() {
      this.dictationController?.stop();
    },

    cancelDictation() {
      this.dictationController?.cancel();
    },

    answerSections() {
      return this.answerContentSections;
    },

    hasAnswerContent() {
      return this.answerSections().length > 0;
    },

    citedSourceGroups() {
      if (this.answer === null) {
        return [];
      }
      const groups = [];
      const groupsByKey = new Map();
      for (const source of this.answer.sources) {
        const key = `${source.documentVersionId}\u0000${source.documentId}\u0000${source.sourceFile}`;
        let group = groupsByKey.get(key);
        if (group === undefined) {
          group = {
            fileSource: source,
            key,
            sources: [],
          };
          groupsByKey.set(key, group);
          groups.push(group);
        }
        group.sources.push(source);
      }
      return groups;
    },

    citedSourceGroupLabel(sourceCount) {
      const noun = sourceCount === 1 ? "evidence item" : "evidence items";
      return `${sourceCount} ${noun}`;
    },

    discoveryExactResults() {
      if (this.discoveryResult === null) {
        return null;
      }
      if (this.discoveryResult.results.kind === "exact") {
        return this.discoveryResult.results;
      }
      return this.discoveryResult.results.exact;
    },

    discoveryRelatedResults() {
      if (this.discoveryResult?.results.kind !== "exact-and-related") {
        return null;
      }
      return this.discoveryResult.results.related;
    },

    discoveryRelatedDocuments() {
      const exact = this.discoveryExactResults();
      const related = this.discoveryRelatedResults();
      if (exact === null || related === null) {
        return [];
      }
      const exactPassageKeys = new Set();
      for (const document of exact.documents) {
        for (const passage of document.passages) {
          exactPassageKeys.add(this.discoveryPassageKey(document, passage));
        }
      }
      const documents = [];
      for (const document of related.documents) {
        const passages = [];
        for (const passage of document.passages) {
          const passageKey = this.discoveryPassageKey(document, passage);
          if (!exactPassageKeys.has(passageKey)) {
            passages.push(passage);
          }
        }
        if (passages.length === 0) {
          continue;
        }
        const removedPassageCount = document.passages.length - passages.length;
        documents.push({
          documentId: document.documentId,
          matchingPassageCount: Math.max(
            passages.length,
            document.matchingPassageCount - removedPassageCount,
          ),
          passages,
          sourceFile: document.sourceFile,
        });
      }
      return documents;
    },

    discoveryGroups() {
      const exact = this.discoveryExactResults();
      if (exact === null) {
        return [];
      }
      const groups = [{
        description: "BM25 keyword matches",
        entries: this.discoveryEntries("exact", exact.documents),
        key: "exact",
        title: "Exact matches",
        totalDocuments: exact.totalDocuments,
      }];
      const related = this.discoveryRelatedResults();
      if (related !== null) {
        const relatedDocuments = this.discoveryRelatedDocuments();
        groups.push({
          description: "Dense retrieval, reranked",
          entries: this.discoveryEntries("related", relatedDocuments),
          key: "related",
          title: "Related by meaning",
          totalDocuments: relatedDocuments.length,
        });
      }
      return groups;
    },

    discoveryEntries(lane, documents) {
      const entries = [];
      for (let index = 0; index < documents.length; index += 1) {
        const document = documents[index];
        entries.push({
          document,
          key: this.discoveryResultKey(lane, document),
          lane,
          rank: this.discoveryDocumentRank(lane, index),
        });
      }
      return entries;
    },

    discoveryOrderLabel() {
      if (this.discoveryResult?.results.kind === "exact-and-related") {
        return "Exact matches first, then related by meaning";
      }
      return "Best exact matches first";
    },

    discoveryGroupCountLabel(group) {
      const noun = group.totalDocuments === 1 ? "document" : "documents";
      return `${group.totalDocuments} ${noun}`;
    },

    discoveryGroupEmptyMessage(group) {
      if (group.key === "related") {
        return "No related passages passed the configured relevance threshold.";
      }
      return "No exact keyword matches were found.";
    },

    discoveryResultKey(lane, document) {
      return `${lane}\u0000${this.discoveryDocumentKey(document)}`;
    },

    discoveryDocumentRank(lane, index) {
      if (lane !== "exact") {
        return index + 1;
      }
      const exact = this.discoveryExactResults();
      if (exact === null) {
        return index + 1;
      }
      return ((exact.page - 1) * exact.pageSize) + index + 1;
    },

    initializeDiscoveryExpansion(result) {
      const exact = result.results.kind === "exact"
        ? result.results
        : result.results.exact;
      const firstDocument = exact.documents[0];
      if (firstDocument !== undefined) {
        this.expandedDiscoveryResultKeys = [
          this.discoveryResultKey("exact", firstDocument),
        ];
        return;
      }
      if (result.results.kind === "exact-and-related") {
        const firstRelatedDocument = result.results.related.documents[0];
        if (firstRelatedDocument !== undefined) {
          this.expandedDiscoveryResultKeys = [
            this.discoveryResultKey("related", firstRelatedDocument),
          ];
          return;
        }
      }
      this.expandedDiscoveryResultKeys = [];
    },

    discoveryDocumentExpanded(entry) {
      return this.expandedDiscoveryResultKeys.includes(entry.key);
    },

    toggleDiscoveryDocumentExpanded(entry) {
      const expandedKeys = [];
      let removed = false;
      for (const expandedKey of this.expandedDiscoveryResultKeys) {
        if (expandedKey === entry.key) {
          removed = true;
          continue;
        }
        expandedKeys.push(expandedKey);
      }
      if (!removed) {
        expandedKeys.push(entry.key);
      }
      this.expandedDiscoveryResultKeys = expandedKeys;
    },

    clearDiscoverySelection() {
      this.selectedDiscoveryDocuments = [];
    },

    discoveryHasResults() {
      const exact = this.discoveryExactResults();
      if (exact === null) {
        return false;
      }
      if (exact.documents.length > 0) {
        return true;
      }
      return this.discoveryRelatedDocuments().length > 0;
    },

    discoverySummary() {
      if (this.discoveryResult === null) {
        return "";
      }
      const results = this.discoveryResult.results;
      const exact = this.discoveryExactResults();
      if (exact === null) {
        return "";
      }
      const exactNoun = exact.totalDocuments === 1 ? "document" : "documents";
      if (results.kind === "exact") {
        return `${exact.totalDocuments} exact-match ${exactNoun}.`;
      }
      const relatedDocuments = this.discoveryRelatedDocuments();
      const relatedNoun = relatedDocuments.length === 1 ? "document" : "documents";
      return `${exact.totalDocuments} exact-match ${exactNoun} and ${relatedDocuments.length} related ${relatedNoun}.`;
    },

    discoveryTotalPages() {
      const exact = this.discoveryExactResults();
      if (exact === null) {
        return 1;
      }
      return Math.max(
        1,
        Math.ceil(
          exact.totalDocuments / exact.pageSize,
        ),
      );
    },

    discoveryPageNumbers() {
      const exact = this.discoveryExactResults();
      if (exact === null) {
        return [];
      }
      const totalPages = this.discoveryTotalPages();
      const currentPage = exact.page;
      const maximumStart = Math.max(1, totalPages - 2);
      const start = Math.min(Math.max(1, currentPage - 1), maximumStart);
      const end = Math.min(totalPages, start + 2);
      const pages = [];
      for (let page = start; page <= end; page += 1) {
        pages.push(page);
      }
      return pages;
    },

    discoveryPageSummary() {
      const exact = this.discoveryExactResults();
      if (exact === null) {
        return "";
      }
      if (exact.totalDocuments === 0) {
        return "Showing 0 of 0 sources";
      }
      const first = ((exact.page - 1) * exact.pageSize) + 1;
      const last = Math.min(
        exact.page * exact.pageSize,
        exact.totalDocuments,
      );
      return `Showing ${first}-${last} of ${exact.totalDocuments} exact matches`;
    },

    discoveryCurrentPage() {
      return this.discoveryExactResults()?.page ?? 1;
    },

    discoveryPassageMatchLabel(passage) {
      return passage.matchKind === "keyword" ? "Keyword" : "Semantic";
    },

    discoveryRankLabel(rank) {
      return String(rank).padStart(2, "0");
    },

    discoveryDocumentKey(document) {
      return `${document.documentId}\u0000${document.sourceFile}`;
    },

    discoveryPassageKey(document, passage) {
      return `${this.discoveryDocumentKey(document)}\u0000${passage.id}`;
    },

    discoveryDocumentSelected(document) {
      const key = this.discoveryDocumentKey(document);
      return this.selectedDiscoveryDocuments.some((candidate) => {
        return this.discoveryDocumentKey(candidate) === key;
      });
    },

    toggleDiscoveryDocument(document) {
      const key = this.discoveryDocumentKey(document);
      const documents = [];
      let removed = false;
      for (const candidate of this.selectedDiscoveryDocuments) {
        if (this.discoveryDocumentKey(candidate) === key) {
          removed = true;
          continue;
        }
        documents.push(candidate);
      }
      if (!removed) {
        documents.push(document);
      }
      this.selectedDiscoveryDocuments = documents;
    },

    selectedDiscoveryQuestionDocuments() {
      const documents = [];
      for (const document of this.selectedDiscoveryDocuments) {
        documents.push(this.discoveryQuestionDocument(document));
      }
      return documents;
    },

    discoveryQuestionDocument(document) {
      return {
        documentId: document.documentId,
        sourceFile: document.sourceFile,
      };
    },

    selectedDiscoveryLabel() {
      const count = this.selectedDiscoveryDocuments.length;
      return `${count} ${count === 1 ? "document" : "documents"} selected`;
    },

    selectedDocumentScopeLabel(count) {
      return `Using ${count} selected ${count === 1 ? "document" : "documents"}`;
    },

    questionPlaceholder(documentCount) {
      if (this.mode === "discover") {
        return "Describe the evidence or topic you need";
      }
      if (documentCount > 0) {
        return "What would you like to compare across these documents?";
      }
      return "What are the main findings across these documents?";
    },

    submitLabel() {
      if (this.operation === "answer") {
        return "Stop generation";
      }
      if (this.operation === "search") {
        return "Stop search";
      }
      return this.mode === "ask" ? "Ask CiteLoom" : "Find sources";
    },

    submitIconHref() {
      let icon = "send";
      if (this.operation !== null) {
        icon = "close";
      } else if (this.mode === "discover") {
        icon = "search";
      }
      return `./assets/images/citeloom-icons.svg#citeloom-${icon}`;
    },

    answerLoadingStatus() {
      return `The question is being embedded and answered by ${this.inferenceRuntimeName}.`;
    },

    emptyAnswerDescription(documentCount) {
      if (documentCount > 0) {
        const label = documentCount === 1 ? "document" : "documents";
        return `Ask across ${documentCount} selected ${label}.`;
      }
      return "Choose all documents or a single source, then ask a focused question.";
    },

    answerCitationStatus(citationNumber) {
      if (this.answer === null) {
        return "unverified";
      }
      return aggregateCitationStatus(this.answer.claims, citationNumber);
    },

    answerQuestionTitle() {
      const turn = this.thread?.turns.find((candidate) => {
        return candidate.id === this.turnId;
      });
      if (turn !== undefined) {
        return turn.question;
      }
      const question = this.question.trim();
      return question === "" ? "Answer" : question;
    },

    askScopeLabel() {
      if (this.questionDocuments.length > 0) {
        const count = this.questionDocuments.length;
        return `${count} selected ${count === 1 ? "document" : "documents"}`;
      }
      if (this.scopeKind === "tag") {
        const count = this.selectedTags.length;
        return count === 0
          ? "Choose tags"
          : `${count} ${count === 1 ? "tag" : "tags"}`;
      }
      return "All documents";
    },

    citationNavigatorStatusLabel(citationNumber) {
      if (isVerificationPending(this.answerVerificationState())) {
        return "Checking";
      }
      const status = this.answerCitationStatus(citationNumber);
      if (status === "supported") {
        return "Verified";
      }
      if (status === "partially-supported" || status === "unsupported") {
        return "Needs review";
      }
      return "Unverified";
    },

    citationNavigatorStatus(citationNumber) {
      if (isVerificationPending(this.answerVerificationState())) {
        return "pending";
      }
      return this.answerCitationStatus(citationNumber);
    },

    answerVerificationState() {
      return this.answer?.verificationState ?? "not-applicable";
    },

    answerVerificationVisible() {
      return this.answerVerificationState() !== "not-applicable";
    },

    answerVerificationLabel() {
      return verificationLabel(this.answerVerificationState());
    },

    answerVerificationStatusLabel() {
      return verificationStatusLabel(this.answerVerificationState());
    },

    answerVerificationProgressValue() {
      return verificationProgressValue(this.answerVerificationState());
    },

    hasPendingVerification() {
      return isVerificationPending(this.answerVerificationState());
    },

    scheduleVerificationRefresh() {
      scheduleVerificationPolling(this);
    },

    clearVerificationRefresh() {
      clearVerificationPolling(this);
    },

    async refreshVerification() {
      const threadId = this.threadId;
      const turnId = this.answer?.turn.turnId;
      if (threadId === "" || turnId === undefined) {
        return;
      }
      await runVerificationRefresh(this, async () => {
        const response = await fetch(
          `/api/research/threads/${encodeURIComponent(threadId)}`,
          { headers: { accept: "application/json" } },
        );
        const thread = await readJsonResponse(
          response,
          "Research verification refresh",
          readResearchThread,
        );
        const turn = thread.turns.find((candidate) => candidate.id === turnId);
        if (
          turn !== undefined
          && this.threadId === threadId
          && this.answer?.turn.turnId === turnId
        ) {
          applyResearchVerificationUpdate(this.answer, turn);
          this.thread = thread;
        }
      });
    },

    answerStatementClaim(statement) {
      if (this.answer === null || statement.verificationIndex === null) {
        return null;
      }
      return this.answer.claims[statement.verificationIndex] ?? null;
    },

    answerStatementStatus(statement) {
      const claim = this.answerStatementClaim(statement);
      return claim === null ? "unverified" : claim.status;
    },

    answerStatementStatusLabel(statement) {
      const claim = this.answerStatementClaim(statement);
      if (isVerificationPending(this.answerVerificationState())) {
        return "Checking evidence";
      }
      if (claim === null) {
        return "Not verified";
      }
      if (claim.status === "supported") {
        return "Verified";
      }
      if (
        claim.status === "partially-supported"
        || claim.status === "unsupported"
      ) {
        return "Review evidence";
      }
      return "Not verified";
    },

    answerStatementVerificationDescription(statement) {
      const claim = this.answerStatementClaim(statement);
      if (claim !== null) {
        return claim.rationale;
      }
      if (this.answer === null) {
        return "Evidence verification is in progress.";
      }
      return "No evidence verification result is available for this finding.";
    },

    selectedCitationStatus() {
      if (this.selectedCitation === null) {
        return "unverified";
      }
      return this.answerCitationStatus(this.selectedCitation.citationNumber);
    },

    claimStatusLabel(status, rationale = "") {
      if (
        status === "unverified"
        && rationale === "Automated evidence verification is pending."
      ) {
        return "Checking evidence";
      }
      return formatClaimStatusLabel(status);
    },

    citationLabel(citation) {
      const sourceSummary = this.citationSourceSummary(citation);
      if (citation.preview === true) {
        const number = citation.citationNumber ?? "pending";
        return `Citation ${number}, source identified from ${sourceSummary}. The evidence link will be available when the answer is complete.`;
      }
      const status = this.claimStatusLabel(
        this.answerCitationStatus(citation.citationNumber),
      );
      const evidence = this.accessibleEvidenceExcerpt(citation.evidence);
      return `Citation ${citation.citationNumber}, ${status}, ${sourceSummary}, ${evidence}`;
    },

    accessibleEvidenceExcerpt(evidence) {
      if (evidence.kind === "image") {
        return "stored image crop";
      }
      const content = evidence.kind === "text"
        ? evidence.excerpt
        : evidence.content;
      const normalized = content.replace(/\s+/gu, " ").trim();
      if (normalized.length <= 240) {
        return normalized;
      }
      return `${normalized.slice(0, 237)}...`;
    },

    selectedCitationSummary() {
      if (this.selectedCitation === null) {
        return "";
      }
      return this.citationSourceSummary(this.selectedCitation);
    },

    citationSourceSummary(citation) {
      const parts = [this.basename(citation.sourceFile)];
      const location = this.documentLocationLabel(
        citation.sourceFile,
        citation.pageNumbers,
      );
      if (location !== "") {
        parts.push(location);
      }
      return parts.join(" · ");
    },

    sourceDetail(source) {
      const parts = [source.kind];
      if (source.pageNumbers.length > 0) {
        parts.push(this.documentLocationLabel(source.sourceFile, source.pageNumbers).toLowerCase());
      }
      if (source.sectionPath.length > 0) {
        parts.push(source.sectionPath.join(" > "));
      }
      return parts.join(", ");
    },

    documentLocationLabel(sourceFile, pageNumbers) {
      return formatDocumentLocationLabel(sourceFile, pageNumbers);
    },

    basename(path) {
      const normalized = path.replaceAll("\\", "/");
      const segments = normalized.split("/").filter(Boolean);
      return segments.at(-1) ?? path;
    },

    documentFileUrl(documentId, sourceFile) {
      const parameters = new URLSearchParams({ sourceFile });
      return `/api/documents/${encodeURIComponent(documentId)}/file?${parameters.toString()}`;
    },

    sourceFileUrl(source) {
      const url = this.documentFileUrl(source.documentId, source.sourceFile);
      if (!source.sourceFile.toLowerCase().endsWith(".pdf")) {
        return url;
      }
      return buildPdfViewerUrl(url, source.pageNumbers);
    },

    discoverySourceUrl(document, passage) {
      const url = this.documentFileUrl(document.documentId, document.sourceFile);
      if (!document.sourceFile.toLowerCase().endsWith(".pdf")) {
        return url;
      }
      return buildPdfViewerUrl(url, passage.pageNumbers);
    },

    discoveryPassageDetail(sourceFile, passage) {
      const parts = [passage.kind];
      if (passage.pageNumbers.length > 0) {
        parts.push(this.documentLocationLabel(sourceFile, passage.pageNumbers).toLowerCase());
      }
      if (passage.sectionPath.length > 0) {
        parts.push(passage.sectionPath.join(" > "));
      }
      return parts.join(", ");
    },

    discoveryFileTypeLabel(sourceFile) {
      const fileName = this.basename(sourceFile);
      const extensionIndex = fileName.lastIndexOf(".");
      if (extensionIndex < 0 || extensionIndex === fileName.length - 1) {
        return "Document";
      }
      return fileName.slice(extensionIndex + 1).toUpperCase();
    },

    discoveryRepresentativeLocations(document) {
      const pages = new Set();
      for (const passage of document.passages) {
        for (const pageNumber of passage.pageNumbers) {
          pages.add(pageNumber);
        }
      }
      const orderedPages = Array.from(pages).sort((left, right) => left - right);
      if (orderedPages.length > 0) {
        return this.documentLocationLabel(document.sourceFile, orderedPages);
      }
      const sectionLabels = [];
      for (const passage of document.passages) {
        const sectionLabel = passage.sectionPath.at(-1);
        if (sectionLabel !== undefined && !sectionLabels.includes(sectionLabel)) {
          sectionLabels.push(sectionLabel);
        }
      }
      if (sectionLabels.length > 0) {
        return sectionLabels.join(", ");
      }
      return "Indexed content";
    },

    discoveryRepresentativeLabel(document) {
      const shownCount = document.passages.length;
      const matchingCount = document.matchingPassageCount;
      const shownNoun = shownCount === 1 ? "excerpt" : "excerpts";
      const matchingNoun = matchingCount === 1 ? "match" : "matches";
      if (shownCount >= matchingCount) {
        return `${shownCount} matching ${shownNoun}`;
      }
      return `Showing ${shownCount} representative ${shownNoun} of ${matchingCount} ${matchingNoun}`;
    },

    discoveryExcerptSegments(passage) {
      if (passage.matchKind !== "keyword") {
        return [{ highlighted: false, key: `${passage.id}:0`, text: passage.excerpt }];
      }
      const query = this.discoveryResult?.query.trim() ?? "";
      if (query === "") {
        return [{ highlighted: false, key: `${passage.id}:0`, text: passage.excerpt }];
      }
      const excerpt = passage.excerpt;
      const normalizedExcerpt = excerpt.toLocaleLowerCase();
      const queryTerms = [];
      for (const rawTerm of query.split(/\s+/u)) {
        const term = rawTerm
          .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
          .toLocaleLowerCase();
        if (term !== "" && !queryTerms.includes(term)) {
          queryTerms.push(term);
        }
      }
      if (queryTerms.length === 0) {
        return [{ highlighted: false, key: `${passage.id}:0`, text: passage.excerpt }];
      }
      const segments = [];
      let cursor = 0;
      while (cursor < excerpt.length) {
        let matchIndex = -1;
        let matchedTerm = "";
        for (const term of queryTerms) {
          const candidateIndex = normalizedExcerpt.indexOf(term, cursor);
          const isEarlierMatch = matchIndex < 0 || candidateIndex < matchIndex;
          const isLongerSamePosition = candidateIndex === matchIndex
            && term.length > matchedTerm.length;
          if (candidateIndex >= 0 && (isEarlierMatch || isLongerSamePosition)) {
            matchIndex = candidateIndex;
            matchedTerm = term;
          }
        }
        if (matchIndex < 0) {
          segments.push({
            highlighted: false,
            key: `${passage.id}:${segments.length}`,
            text: excerpt.slice(cursor),
          });
          break;
        }
        if (matchIndex > cursor) {
          segments.push({
            highlighted: false,
            key: `${passage.id}:${segments.length}`,
            text: excerpt.slice(cursor, matchIndex),
          });
        }
        const matchEnd = matchIndex + matchedTerm.length;
        segments.push({
          highlighted: true,
          key: `${passage.id}:${segments.length}`,
          text: excerpt.slice(matchIndex, matchEnd),
        });
        cursor = matchEnd;
      }
      return segments;
    },

    retrievedContextLabel() {
      if (this.answer === null) {
        return "";
      }
      let elementCount = 0;
      for (const document of this.answer.matchedDocuments) {
        elementCount += document.retrievedElementCount;
      }
      const documentCount = this.answer.matchedDocuments.length;
      const documentLabel = documentCount === 1 ? "document" : "documents";
      const sectionLabel = elementCount === 1 ? "section" : "sections";
      return `${documentCount} ${documentLabel}, ${elementCount} ${sectionLabel}`;
    },

    retrievedElementLabel(count) {
      return `${count} ${count === 1 ? "section" : "sections"} reviewed`;
    },

    citationEvidenceText() {
      if (this.inspectedCitation === null) {
        return "";
      }
      if (this.inspectedCitation.evidence.kind === "text") {
        return this.inspectedCitation.evidence.excerpt;
      }
      if (this.inspectedCitation.evidence.kind === "table") {
        return this.inspectedCitation.evidence.content;
      }
      return "Stored image crop";
    },

    citationImageUrl() {
      if (this.inspectedCitation === null) {
        return "";
      }
      return `/api/citations/${encodeURIComponent(this.inspectedCitation.id)}/image`;
    },

    citationSourceIsImage() {
      if (this.inspectedCitation === null) {
        return false;
      }
      const sourceFile = this.inspectedCitation.sourceFile.toLowerCase();
      return sourceFile.endsWith(".jpeg")
        || sourceFile.endsWith(".jpg")
        || sourceFile.endsWith(".png")
        || sourceFile.endsWith(".webp");
    },

    citationOriginalFileUrl() {
      if (this.inspectedCitation === null) {
        return "";
      }
      const versionId = encodeURIComponent(
        this.inspectedCitation.documentVersionId,
      );
      return `/api/document-versions/${versionId}/file`;
    },

    recordCitationImageDimensions(event) {
      const image = event.currentTarget;
      if (
        !(image instanceof HTMLImageElement)
        || image.naturalWidth < 1
        || image.naturalHeight < 1
      ) {
        this.citationImageDimensions = null;
        return;
      }
      this.citationImageDimensions = {
        height: image.naturalHeight,
        width: image.naturalWidth,
      };
    },

    citationRegionStyle(region) {
      const dimensions = this.citationImageDimensions;
      if (dimensions === null) {
        return { display: "none" };
      }
      const left = Math.max(0, Math.min(region.boundingBox.left, dimensions.width));
      const right = Math.max(0, Math.min(region.boundingBox.right, dimensions.width));
      const top = Math.max(0, Math.min(region.boundingBox.top, dimensions.height));
      const bottom = Math.max(0, Math.min(region.boundingBox.bottom, dimensions.height));
      if (right <= left || bottom <= top) {
        return { display: "none" };
      }
      return {
        height: `${((bottom - top) / dimensions.height) * 100}%`,
        left: `${(left / dimensions.width) * 100}%`,
        top: `${(top / dimensions.height) * 100}%`,
        width: `${((right - left) / dimensions.width) * 100}%`,
      };
    },

    citationFileUrl() {
      if (this.inspectedCitation === null) {
        return "";
      }
      const sourceFile = this.inspectedCitation.sourceFile.toLowerCase();
      if (this.citationSourceIsImage()) {
        return this.citationOriginalFileUrl();
      }
      if (
        sourceFile.endsWith(".pdf")
        && this.inspectedCitation.regions.length === 0
      ) {
        return this.citationOriginalFileUrl();
      }
      if (sourceFile.endsWith(".pdf") || isTextSourceFile(sourceFile)) {
        const citationId = encodeURIComponent(this.inspectedCitation.id);
        return buildHighlightedSourceViewerUrl(
          `/api/citations/${citationId}/highlighted-file`,
          sourceFile,
          this.inspectedCitation.pageNumbers,
        );
      }
      return this.citationOriginalFileUrl();
    },

    citationFileLabel() {
      if (this.inspectedCitation === null) {
        return "Open source document";
      }
      if (this.inspectedCitation.sourceFile.toLowerCase().endsWith(".pdf")) {
        return this.inspectedCitation.regions.length > 0
          ? "Open highlighted PDF"
          : "Open original PDF";
      }
      if (isTextSourceFile(this.inspectedCitation.sourceFile)) {
        return "Open highlighted source";
      }
      return this.citationSourceIsImage()
        ? "Open original image"
        : "Open original version";
    },

    citationFileCaption() {
      if (this.inspectedCitation === null) {
        return "";
      }
      const sourceFile = this.inspectedCitation.sourceFile.toLowerCase();
      if (sourceFile.endsWith(".pdf") && this.inspectedCitation.regions.length > 0) {
        return `${this.documentLocationLabel(this.inspectedCitation.sourceFile, this.inspectedCitation.pageNumbers)} · opens in the document viewer`;
      }
      if (this.citationSourceIsImage() && this.inspectedCitation.regions.length > 0) {
        return "Highlighted evidence is shown above";
      }
      if (isTextSourceFile(sourceFile)) {
        return "Opens an inert source viewer at the exact indexed evidence";
      }
      return "Opens the original stored document";
    },

    threadExportUrl(format) {
      if (this.thread === null) {
        return "";
      }
      const id = encodeURIComponent(this.thread.id);
      const query = new URLSearchParams({ format });
      return `/api/research/threads/${id}/export?${query.toString()}`;
    },

    formatDuration(durationMs) {
      if (durationMs < 1_000) {
        return `${durationMs} ms`;
      }
      const precision = durationMs < 60_000 ? 1 : 0;
      return `${(durationMs / 1_000).toFixed(precision)} s`;
    },

    formatTokenCount(value) {
      if (value === null) {
        return "Unavailable";
      }
      return new Intl.NumberFormat().format(value);
    },

    workspaceError() {
      return this.dashboardError || this.threadsError;
    },
  }));

}
