import {
  readJsonResponse,
  readString,
} from "./citeloom-boundaries.js";
import {
  applyAnswerContentUpdate,
  createAnswerContentFromDocument,
  createEmptyAnswerContent,
} from "./citeloom-answer-content.js";
import { requestAnswerSpeech } from "./citeloom-answer-speech.js";
import {
  readChatConversation,
  readChatMessageStream,
  readChatSpeechFeatures,
  readChatSummaries,
  readCreatedChat,
} from "./citeloom-chat-boundaries.js";
import { readDocumentCatalog } from "./citeloom-documents.js";
import { buildPdfViewerUrl } from "./citeloom-file-links.js";
import { focusTextArea } from "./citeloom-focus.js";
import {
  createDictationController,
  formatDictationElapsedTime,
} from "./citeloom-dictation.js";
import { dispatchNotice } from "./citeloom-notices.js";
import { requestConfirmation } from "./citeloom-confirmation.js";
const chatSwitcherRequestEvent = "citeloom:chat-switcher-request";

function appendUniqueNewChatDocuments(current, additions) {
  const documents = [...current];
  const sourceFiles = new Set(
    current.map((document) => document.sourceFile),
  );
  for (const document of additions) {
    if (sourceFiles.has(document.sourceFile)) {
      continue;
    }
    sourceFiles.add(document.sourceFile);
    documents.push(document);
  }
  return documents;
}

function createPendingChatRun(conversation, requestId, content) {
  let sequence = 1;
  for (const run of conversation.runs) {
    sequence = Math.max(sequence, run.sequence + 1);
  }
  const createdAt = new Date().toISOString();
  return {
    attemptCount: 1,
    completedAt: null,
    errorMessage: null,
    id: requestId,
    messages: [{
      content,
      createdAt,
      id: `${requestId}:user`,
      role: "user",
      runId: requestId,
    }, {
      answerContent: createEmptyAnswerContent(),
      citations: [],
      claims: [],
      content: "",
      createdAt,
      id: `${requestId}:assistant`,
      role: "assistant",
      runId: requestId,
      streaming: true,
      verificationState: "pending",
    }],
    sequence,
    state: "generating",
  };
}

function replaceChatRun(conversation, replacement) {
  const runs = [];
  let replaced = false;
  for (const run of conversation.runs) {
    if (run.id === replacement.id) {
      runs.push(replacement);
      replaced = true;
      continue;
    }
    runs.push(run);
  }
  if (!replaced) {
    runs.push(replacement);
  }
  runs.sort((left, right) => left.sequence - right.sequence);
  return { ...conversation, runs };
}

function updatePendingChatAnswer(conversation, runId, answerContentUpdate) {
  const run = conversation.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) {
    return conversation;
  }
  const messages = [];
  for (const message of run.messages) {
    if (message.role === "assistant" && message.streaming === true) {
      const answerContent = applyAnswerContentUpdate(
        message.answerContent,
        answerContentUpdate,
      );
      messages.push({ ...message, answerContent });
      continue;
    }
    messages.push(message);
  }
  return replaceChatRun(conversation, { ...run, messages });
}

function findLatestChatSpeechTarget(conversation) {
  if (conversation === null) {
    return null;
  }
  let latest = null;
  let latestSequence = 0;
  for (const run of conversation.runs) {
    if (run.state !== "completed" || run.sequence < latestSequence) {
      continue;
    }
    for (const message of run.messages) {
      if (message.role !== "assistant") {
        continue;
      }
      latest = {
        answerDocument: message.answerDocument,
        messageId: message.id,
      };
      latestSequence = run.sequence;
    }
  }
  return latest;
}

export function registerPage(alpine) {
  alpine.data("citeloomChatPage", () => ({
    busy: false,
    chatSearchQuery: "",
    chatSwitcherActiveIndex: 0,
    chatSwitcherOpen: false,
    chatSwitcherRequestListener: null,
    chatSwitcherReturnFocus: null,
    conversation: null,
    conversations: [],
    dictationController: null,
    dictationElapsedSeconds: 0,
    dictationState: "idle",
    dictationStatus: "",
    draft: "",
    errorMessage: "",
    loading: true,
    newChatCatalogController: null,
    newChatCatalogLoading: false,
    newChatDocumentOptions: [],
    newChatDocumentPage: 1,
    newChatDocumentSearch: "",
    newChatDocumentTotal: 0,
    newChatErrorMessage: "",
    newChatIncludedSearch: "",
    newChatOpen: false,
    newChatPreviewController: null,
    newChatPreviewDocuments: [],
    newChatPreviewLoading: false,
    newChatPreviewPage: 1,
    newChatPreviewTotal: 0,
    newChatScopeMode: "all",
    newChatSelectedDocuments: [],
    newChatSelectedTags: [],
    newChatTagOptions: [],
    newChatTagSearch: "",
    newChatTitle: "",
    newChatTotalDocuments: 0,
    selectedCitation: null,
    speechAbortController: null,
    speechAnswerMessageId: null,
    speechAudioError: "",
    speechAudioLoading: false,
    speechAudioPlaying: false,
    speechAudioUrl: "",
    speechSettingsRefreshListener: null,
    speechToTextEnabled: false,
    textToSpeechEnabled: false,
    textToSpeechPreloadEnabled: false,
    verificationRefreshTimer: null,

    get filteredConversations() {
      const query = this.chatSearchQuery.trim().toLocaleLowerCase();
      if (query === "") {
        return this.conversations.slice(0, 6);
      }
      return this.conversations.filter((conversation) => {
        return conversation.title.toLocaleLowerCase().includes(query);
      }).slice(0, 8);
    },

    get filteredNewChatTags() {
      const query = this.newChatTagSearch.trim().toLocaleLowerCase();
      if (query === "") {
        return this.newChatTagOptions;
      }
      return this.newChatTagOptions.filter((facet) => {
        return facet.tag.toLocaleLowerCase().includes(query);
      });
    },

    get newChatCanCreate() {
      if (this.newChatTitle.trim() === "") {
        return false;
      }
      if (this.newChatScopeMode === "tags") {
        return this.newChatSelectedTags.length > 0;
      }
      if (this.newChatScopeMode === "documents") {
        return this.newChatSelectedDocuments.length > 0;
      }
      return true;
    },

    get newChatCanLoadMoreDocuments() {
      return this.newChatDocumentOptions.length < this.newChatDocumentTotal;
    },

    get newChatCanLoadMorePreview() {
      if (this.newChatScopeMode === "documents") {
        return false;
      }
      return this.newChatPreviewDocuments.length < this.newChatPreviewTotal;
    },

    get newChatIncludedDocuments() {
      if (this.newChatScopeMode !== "documents") {
        return this.newChatPreviewDocuments;
      }
      const query = this.newChatIncludedSearch.trim().toLocaleLowerCase();
      if (query === "") {
        return this.newChatSelectedDocuments;
      }
      return this.newChatSelectedDocuments.filter((document) => {
        return this.sourceTitle(document.sourceFile)
          .toLocaleLowerCase()
          .includes(query);
      });
    },

    get newChatIncludedTotal() {
      if (this.newChatScopeMode === "documents") {
        return this.newChatSelectedDocuments.length;
      }
      return this.newChatPreviewTotal;
    },

    async initialize() {
      this.initializeDictationController();
      this.chatSwitcherRequestListener = () => {
        this.openChatSwitcher();
      };
      this.speechSettingsRefreshListener = () => {
        void this.loadSpeechFeatures();
      };
      window.addEventListener(
        chatSwitcherRequestEvent,
        this.chatSwitcherRequestListener,
      );
      window.addEventListener(
        "citeloom:settings-revision",
        this.speechSettingsRefreshListener,
      );
      await Promise.all([
        this.refreshConversations(),
        this.loadSpeechFeatures(),
      ]);
      if (this.conversations.length > 0) {
        await this.selectConversation(this.conversations[0].id);
      }
      this.loading = false;
      this.focusMessageComposer();
    },

    destroy() {
      if (this.chatSwitcherRequestListener !== null) {
        window.removeEventListener(
          chatSwitcherRequestEvent,
          this.chatSwitcherRequestListener,
        );
      }
      if (this.speechSettingsRefreshListener !== null) {
        window.removeEventListener(
          "citeloom:settings-revision",
          this.speechSettingsRefreshListener,
        );
      }
      this.newChatCatalogController?.abort();
      this.newChatPreviewController?.abort();
      this.clearVerificationRefresh();
      this.dictationController?.destroy();
      this.dictationController = null;
      this.resetChatSpeechAudio();
    },

    async loadSpeechFeatures() {
      try {
        const response = await fetch("/api/dashboard", {
          headers: { accept: "application/json" },
        });
        const features = await readJsonResponse(
          response,
          "Dashboard request",
          readChatSpeechFeatures,
        );
        this.speechToTextEnabled = features.speechToTextEnabled;
        this.textToSpeechEnabled = features.textToSpeechEnabled;
        this.textToSpeechPreloadEnabled =
          features.textToSpeechPreloadEnabled;
        if (!this.textToSpeechEnabled) {
          this.resetChatSpeechAudio();
        }
        if (!this.speechToTextEnabled) {
          this.cancelChatDictation();
        }
        if (!this.textToSpeechEnabled) {
          return;
        }
        this.prepareSpeechForLatestAnswer();
        this.maybePreloadChatSpeech();
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : "Chat speech configuration could not be loaded.";
        this.speechAudioError = message;
        dispatchNotice("error", message);
      }
    },

    initializeDictationController() {
      this.dictationController = createDictationController({
        onStart: () => {
          this.draft = "";
          this.$nextTick(() => {
            this.resizeMessageComposer();
            focusTextArea(this.$refs.messageComposer);
          });
        },
        onStateChange: (snapshot) => {
          this.dictationElapsedSeconds = snapshot.elapsedSeconds;
          this.dictationState = snapshot.state;
          this.dictationStatus = snapshot.status;
          if (snapshot.state === "error") {
            dispatchNotice("error", snapshot.status);
          }
        },
        onTranscript: (transcript) => {
          this.draft = transcript;
          this.$nextTick(() => {
            this.resizeMessageComposer();
            focusTextArea(this.$refs.messageComposer);
          });
        },
      });
    },

    chatDictationActive() {
      return this.dictationState !== "idle"
        && this.dictationState !== "error";
    },

    chatDictationElapsedLabel() {
      return formatDictationElapsedTime(this.dictationElapsedSeconds);
    },

    async startChatDictation() {
      if (!this.speechToTextEnabled || this.busy) {
        return;
      }
      await this.dictationController?.start();
    },

    stopChatDictation() {
      this.dictationController?.stop();
    },

    cancelChatDictation() {
      this.dictationController?.cancel();
    },

    async refreshConversations() {
      try {
        const response = await fetch("/api/chat/conversations");
        this.conversations = await readJsonResponse(
          response,
          "Chat list",
          readChatSummaries,
        );
      } catch (error) {
        this.reportError(error, "Chats could not be loaded.");
      }
    },

    async selectConversation(id) {
      this.clearVerificationRefresh();
      this.cancelChatDictation();
      this.resetChatSpeechAudio();
      this.errorMessage = "";
      this.selectedCitation = null;
      try {
        const response = await fetch(
          `/api/chat/conversations/${encodeURIComponent(id)}`,
        );
        this.conversation = await readJsonResponse(
          response,
          "Chat",
          readChatConversation,
        );
        this.$nextTick(() => this.scrollToLatest());
        this.scheduleVerificationRefresh();
        this.prepareSpeechForLatestAnswer();
        this.maybePreloadChatSpeech();
        this.focusMessageComposer();
      } catch (error) {
        this.reportError(error, "The chat could not be loaded.");
      }
    },

    canUseChatSpeech() {
      return this.textToSpeechEnabled
        && findLatestChatSpeechTarget(this.conversation) !== null;
    },

    chatSpeechActionLabel() {
      if (this.speechAudioLoading) {
        return "Preparing latest answer audio";
      }
      if (this.speechAudioPlaying) {
        return "Pause latest answer";
      }
      return "Play latest answer";
    },

    chatSpeechIcon() {
      if (this.speechAudioLoading) {
        return "./assets/images/citeloom-icons.svg#citeloom-refresh";
      }
      if (this.speechAudioPlaying) {
        return "./assets/images/citeloom-icons.svg#citeloom-pause";
      }
      return "./assets/images/citeloom-icons.svg#citeloom-speaker";
    },

    prepareSpeechForLatestAnswer() {
      const target = findLatestChatSpeechTarget(this.conversation);
      if (target?.messageId === this.speechAnswerMessageId) {
        return;
      }
      this.resetChatSpeechAudio();
    },

    maybePreloadChatSpeech() {
      if (
        !this.textToSpeechEnabled
        || !this.textToSpeechPreloadEnabled
        || this.speechAudioLoading
        || this.speechAudioUrl !== ""
        || findLatestChatSpeechTarget(this.conversation) === null
      ) {
        return;
      }
      void this.loadLatestChatSpeech(false);
    },

    async loadLatestChatSpeech(surfaceError = true) {
      const target = findLatestChatSpeechTarget(this.conversation);
      if (target === null || this.speechAudioLoading) {
        return false;
      }
      if (
        this.speechAnswerMessageId === target.messageId
        && this.speechAudioUrl !== ""
      ) {
        return true;
      }
      this.resetChatSpeechAudio();
      const controller = new AbortController();
      this.speechAbortController = controller;
      this.speechAnswerMessageId = target.messageId;
      this.speechAudioLoading = true;
      this.speechAudioError = "";
      try {
        const audioBlob = await requestAnswerSpeech(
          target.answerDocument,
          controller.signal,
        );
        const currentTarget = findLatestChatSpeechTarget(this.conversation);
        if (
          controller.signal.aborted
          || currentTarget?.messageId !== target.messageId
        ) {
          return false;
        }
        const audio = this.$refs.chatSpeechAudio;
        if (!(audio instanceof HTMLAudioElement)) {
          throw new Error("The chat audio player is unavailable.");
        }
        const audioUrl = URL.createObjectURL(audioBlob);
        this.speechAudioUrl = audioUrl;
        audio.src = audioUrl;
        audio.load();
        return true;
      } catch (error) {
        if (!controller.signal.aborted && surfaceError) {
          const message = error instanceof Error
            ? error.message
            : "The latest answer audio could not be generated.";
          this.speechAudioError = message;
          dispatchNotice("error", message);
        }
        return false;
      } finally {
        if (this.speechAbortController === controller) {
          this.speechAbortController = null;
          this.speechAudioLoading = false;
        }
      }
    },

    async toggleChatSpeech() {
      const audio = this.$refs.chatSpeechAudio;
      if (!(audio instanceof HTMLAudioElement)) {
        return;
      }
      if (!audio.paused && !audio.ended) {
        audio.pause();
        return;
      }
      if (this.speechAudioUrl === "") {
        const loaded = await this.loadLatestChatSpeech(true);
        if (!loaded) {
          return;
        }
      }
      if (audio.ended) {
        audio.currentTime = 0;
      }
      try {
        await audio.play();
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : "The latest answer audio could not be played.";
        this.speechAudioError = message;
        this.speechAudioPlaying = false;
        dispatchNotice("error", message);
      }
    },

    resetChatSpeechAudio() {
      this.speechAbortController?.abort();
      this.speechAbortController = null;
      this.speechAnswerMessageId = null;
      this.speechAudioError = "";
      this.speechAudioLoading = false;
      this.speechAudioPlaying = false;
      const audioUrl = this.speechAudioUrl;
      this.speechAudioUrl = "";
      const audio = this.$refs.chatSpeechAudio;
      if (audio instanceof HTMLAudioElement) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      if (audioUrl !== "") {
        URL.revokeObjectURL(audioUrl);
      }
    },

    handleChatSpeechError() {
      if (this.speechAudioUrl === "") {
        return;
      }
      this.speechAudioPlaying = false;
      const message = "The latest answer audio could not be played.";
      this.speechAudioError = message;
      dispatchNotice("error", message);
    },

    openNewChat() {
      if (this.chatSwitcherOpen) {
        this.closeChatSwitcher({ restoreFocus: false });
      }
      this.resetNewChatForm();
      this.newChatOpen = true;
      this.$nextTick(() => this.$refs.newChatTitle?.focus());
      void this.loadNewChatDocumentOptions();
      void this.loadNewChatPreview();
    },

    closeNewChat() {
      if (this.busy) {
        return;
      }
      this.newChatCatalogController?.abort();
      this.newChatPreviewController?.abort();
      this.newChatOpen = false;
      this.resetNewChatForm();
    },

    resetNewChatForm() {
      this.newChatCatalogController = null;
      this.newChatCatalogLoading = false;
      this.newChatDocumentOptions = [];
      this.newChatDocumentPage = 1;
      this.newChatDocumentSearch = "";
      this.newChatDocumentTotal = 0;
      this.newChatErrorMessage = "";
      this.newChatIncludedSearch = "";
      this.newChatPreviewController = null;
      this.newChatPreviewDocuments = [];
      this.newChatPreviewLoading = false;
      this.newChatPreviewPage = 1;
      this.newChatPreviewTotal = 0;
      this.newChatScopeMode = "all";
      this.newChatSelectedDocuments = [];
      this.newChatSelectedTags = [];
      this.newChatTagOptions = [];
      this.newChatTagSearch = "";
      this.newChatTitle = "";
      this.newChatTotalDocuments = 0;
    },

    setNewChatScopeMode(mode) {
      if (!["all", "tags", "documents"].includes(mode)) {
        return;
      }
      this.newChatScopeMode = mode;
      this.newChatIncludedSearch = "";
      this.newChatErrorMessage = "";
      if (mode === "documents") {
        this.newChatPreviewController?.abort();
        this.newChatPreviewDocuments = [];
        this.newChatPreviewPage = 1;
        this.newChatPreviewTotal = 0;
        return;
      }
      void this.loadNewChatPreview();
    },

    isNewChatTagSelected(tag) {
      return this.newChatSelectedTags.includes(tag);
    },

    toggleNewChatTag(tag) {
      this.newChatScopeMode = "tags";
      if (this.isNewChatTagSelected(tag)) {
        this.newChatSelectedTags = this.newChatSelectedTags.filter((item) => {
          return item !== tag;
        });
      } else {
        this.newChatSelectedTags = [...this.newChatSelectedTags, tag].sort();
      }
      this.newChatIncludedSearch = "";
      this.newChatErrorMessage = "";
      void this.loadNewChatPreview();
    },

    isNewChatDocumentSelected(sourceFile) {
      return this.newChatSelectedDocuments.some((document) => {
        return document.sourceFile === sourceFile;
      });
    },

    toggleNewChatDocument(document) {
      this.newChatScopeMode = "documents";
      if (this.isNewChatDocumentSelected(document.sourceFile)) {
        this.removeNewChatDocument(document.sourceFile);
        return;
      }
      this.newChatSelectedDocuments = [
        ...this.newChatSelectedDocuments,
        document,
      ].sort((left, right) => {
        return this.sourceTitle(left.sourceFile).localeCompare(
          this.sourceTitle(right.sourceFile),
        );
      });
      this.newChatErrorMessage = "";
    },

    removeNewChatDocument(sourceFile) {
      this.newChatSelectedDocuments = this.newChatSelectedDocuments.filter(
        (document) => document.sourceFile !== sourceFile,
      );
    },

    clearNewChatSelection() {
      this.newChatScopeMode = "all";
      this.newChatSelectedDocuments = [];
      this.newChatSelectedTags = [];
      this.newChatIncludedSearch = "";
      this.newChatErrorMessage = "";
      void this.loadNewChatPreview();
    },

    newChatScope() {
      if (this.newChatScopeMode === "tags") {
        return {
          kind: "tags",
          tags: [...this.newChatSelectedTags],
        };
      }
      if (this.newChatScopeMode === "documents") {
        return {
          kind: "sourceFiles",
          sourceFiles: this.newChatSelectedDocuments.map((document) => {
            return document.sourceFile;
          }),
        };
      }
      return { kind: "all" };
    },

    async loadNewChatDocumentOptions(options = {}) {
      const append = options.append === true;
      const page = append ? this.newChatDocumentPage + 1 : 1;
      this.newChatCatalogController?.abort();
      const controller = new AbortController();
      this.newChatCatalogController = controller;
      this.newChatCatalogLoading = true;
      const parameters = new URLSearchParams({
        collection: "all",
        page: String(page),
        pageSize: "100",
        search: this.newChatDocumentSearch.trim(),
        sort: "name-asc",
        status: "queryable",
        tag: "",
      });
      try {
        const response = await fetch(`/api/documents?${parameters.toString()}`, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        const catalog = await readJsonResponse(
          response,
          "Chat documents",
          readDocumentCatalog,
        );
        if (controller.signal.aborted) {
          return;
        }
        this.newChatDocumentOptions = append
          ? appendUniqueNewChatDocuments(
            this.newChatDocumentOptions,
            catalog.documents,
          )
          : catalog.documents;
        this.newChatDocumentPage = catalog.page;
        this.newChatDocumentTotal = catalog.total;
        this.newChatTagOptions = catalog.facets.queryableTags;
        this.newChatTotalDocuments = catalog.facets.queryable;
      } catch (error) {
        if (!controller.signal.aborted) {
          this.newChatErrorMessage = error instanceof Error
            ? error.message
            : "Documents could not be loaded.";
        }
      } finally {
        if (this.newChatCatalogController === controller) {
          this.newChatCatalogController = null;
          this.newChatCatalogLoading = false;
        }
      }
    },

    async loadNewChatPreview(options = {}) {
      if (this.newChatScopeMode === "documents") {
        return;
      }
      if (
        this.newChatScopeMode === "tags"
        && this.newChatSelectedTags.length === 0
      ) {
        this.newChatPreviewController?.abort();
        this.newChatPreviewDocuments = [];
        this.newChatPreviewPage = 1;
        this.newChatPreviewTotal = 0;
        return;
      }
      const append = options.append === true;
      const page = append ? this.newChatPreviewPage + 1 : 1;
      this.newChatPreviewController?.abort();
      const controller = new AbortController();
      this.newChatPreviewController = controller;
      this.newChatPreviewLoading = true;
      const collection = this.newChatScopeMode === "tags"
        ? `tags:${this.newChatSelectedTags.join(",")}`
        : "all";
      const parameters = new URLSearchParams({
        collection,
        page: String(page),
        pageSize: "100",
        search: this.newChatIncludedSearch.trim(),
        sort: "name-asc",
        status: "queryable",
        tag: "",
      });
      try {
        const response = await fetch(`/api/documents?${parameters.toString()}`, {
          headers: { accept: "application/json" },
          signal: controller.signal,
        });
        const catalog = await readJsonResponse(
          response,
          "Chat document preview",
          readDocumentCatalog,
        );
        if (controller.signal.aborted) {
          return;
        }
        this.newChatPreviewDocuments = append
          ? appendUniqueNewChatDocuments(
            this.newChatPreviewDocuments,
            catalog.documents,
          )
          : catalog.documents;
        this.newChatPreviewPage = catalog.page;
        this.newChatPreviewTotal = catalog.total;
      } catch (error) {
        if (!controller.signal.aborted) {
          this.newChatErrorMessage = error instanceof Error
            ? error.message
            : "The included documents could not be loaded.";
        }
      } finally {
        if (this.newChatPreviewController === controller) {
          this.newChatPreviewController = null;
          this.newChatPreviewLoading = false;
        }
      }
    },

    newChatDocumentTags(document) {
      return document.tags.slice(0, 2);
    },

    toggleChatSwitcher() {
      if (this.chatSwitcherOpen) {
        this.closeChatSwitcher();
        return;
      }
      this.openChatSwitcher();
    },

    openChatSwitcher() {
      if (this.newChatOpen) {
        return;
      }
      const activeElement = document.activeElement;
      this.chatSwitcherReturnFocus = activeElement instanceof HTMLElement
        ? activeElement
        : null;
      this.chatSearchQuery = "";
      this.chatSwitcherActiveIndex = this.activeConversationIndex();
      this.chatSwitcherOpen = true;
      this.$nextTick(() => this.$refs.chatSwitcherSearch?.focus());
    },

    closeChatSwitcher(options = {}) {
      if (!this.chatSwitcherOpen) {
        return;
      }
      const restoreFocus = options.restoreFocus !== false;
      const returnFocus = this.chatSwitcherReturnFocus;
      this.chatSwitcherOpen = false;
      this.chatSearchQuery = "";
      this.chatSwitcherActiveIndex = 0;
      this.chatSwitcherReturnFocus = null;
      if (restoreFocus && returnFocus instanceof HTMLElement) {
        this.$nextTick(() => returnFocus.focus());
      }
    },

    activeConversationIndex() {
      const activeId = this.conversation?.id;
      if (activeId === undefined) {
        return 0;
      }
      const index = this.filteredConversations.findIndex((conversation) => {
        return conversation.id === activeId;
      });
      return index < 0 ? 0 : index;
    },

    resetChatSwitcherSelection() {
      this.chatSwitcherActiveIndex = this.filteredConversations.length === 0
        ? -1
        : 0;
    },

    moveChatSwitcherSelection(offset) {
      const conversationCount = this.filteredConversations.length;
      if (conversationCount === 0) {
        this.chatSwitcherActiveIndex = -1;
        return;
      }
      const currentIndex = this.chatSwitcherActiveIndex < 0
        ? 0
        : this.chatSwitcherActiveIndex;
      this.chatSwitcherActiveIndex = (
        currentIndex + offset + conversationCount
      ) % conversationCount;
    },

    async selectActiveChatFromSwitcher() {
      const conversation = this.filteredConversations[
        this.chatSwitcherActiveIndex
      ];
      if (conversation === undefined) {
        return;
      }
      await this.selectConversationFromSwitcher(conversation.id);
    },

    async selectConversationFromSwitcher(id) {
      await this.selectConversation(id);
      this.closeChatSwitcher({ restoreFocus: false });
    },

    chatSwitcherOptionId(index) {
      return `chat-switcher-option-${index}`;
    },

    chatSwitcherActiveDescendant() {
      if (this.chatSwitcherActiveIndex < 0) {
        return null;
      }
      return this.chatSwitcherOptionId(this.chatSwitcherActiveIndex);
    },

    async createConversation() {
      const title = this.newChatTitle.trim();
      if (title === "") {
        this.newChatErrorMessage = "Enter a chat title.";
        this.$nextTick(() => this.$refs.newChatTitle?.focus());
        return;
      }
      if (!this.newChatCanCreate) {
        this.newChatErrorMessage = this.newChatScopeMode === "tags"
          ? "Select at least one tag."
          : "Select at least one document.";
        return;
      }
      this.busy = true;
      this.newChatErrorMessage = "";
      try {
        const response = await fetch("/api/chat/conversations", {
          body: JSON.stringify({
            scope: this.newChatScope(),
            title,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        const conversation = await readJsonResponse(
          response,
          "Create chat",
          readCreatedChat,
        );
        this.newChatOpen = false;
        this.resetNewChatForm();
        await this.refreshConversations();
        await this.selectConversation(conversation.id);
      } catch (error) {
        this.newChatErrorMessage = error instanceof Error
          ? error.message
          : "The chat could not be created.";
      } finally {
        this.busy = false;
      }
    },

    async deleteConversation() {
      if (this.conversation === null) {
        return;
      }
      const confirmed = await requestConfirmation({
        cancelLabel: "Keep chat",
        confirmLabel: "Delete chat",
        description: "This permanently removes every message and its retained evidence. This action cannot be undone.",
        title: `Delete “${this.conversation.title}”?`,
        tone: "danger",
      });
      if (!confirmed) {
        return;
      }
      this.busy = true;
      try {
        const response = await fetch(
          `/api/chat/conversations/${encodeURIComponent(this.conversation.id)}`,
          { method: "DELETE" },
        );
        if (!response.ok) {
          await readJsonResponse(response, "Delete chat");
        }
        this.conversation = null;
        this.resetChatSpeechAudio();
        this.selectedCitation = null;
        this.clearVerificationRefresh();
        await this.refreshConversations();
        if (this.conversations.length > 0) {
          await this.selectConversation(this.conversations[0].id);
        }
      } catch (error) {
        this.reportError(error, "The chat could not be deleted.");
      } finally {
        this.busy = false;
      }
    },

    async sendMessage() {
      const content = this.draft.trim();
      if (content === "" || this.conversation === null || this.busy) {
        return;
      }
      const conversationId = this.conversation.id;
      const requestId = crypto.randomUUID();
      this.busy = true;
      this.errorMessage = "";
      this.draft = "";
      this.$nextTick(() => this.resizeMessageComposer());
      let completed = false;
      const pendingRun = createPendingChatRun(
        this.conversation,
        requestId,
        content,
      );
      this.conversation = replaceChatRun(this.conversation, pendingRun);
      this.$nextTick(() => this.scrollToLatest());
      try {
        const response = await fetch(
          `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
          {
            body: JSON.stringify({
              content,
              requestId,
            }),
            headers: {
              Accept: "text/event-stream",
              "Content-Type": "application/json",
            },
            method: "POST",
          },
        );
        await readChatMessageStream(
          response,
          (messageResponse) => {
            if (
              messageResponse.conversationId !== conversationId
              || this.conversation?.id !== conversationId
            ) {
              throw new Error("The completed response belongs to another chat.");
            }
            const updated = replaceChatRun(
              this.conversation,
              messageResponse.run,
            );
            this.conversation = {
              ...updated,
              updatedAt: messageResponse.run.completedAt
                ?? this.conversation.updatedAt,
            };
            completed = true;
            this.$nextTick(() => this.scrollToLatest());
            this.scheduleVerificationRefresh();
            this.prepareSpeechForLatestAnswer();
            this.maybePreloadChatSpeech();
          },
          (answerContentUpdate) => {
            if (this.conversation?.id !== conversationId) {
              return;
            }
            this.conversation = updatePendingChatAnswer(
              this.conversation,
              requestId,
              answerContentUpdate,
            );
            this.$nextTick(() => this.scrollToLatest());
          },
        );
      } catch (error) {
        this.reportError(error, "The response could not be generated.");
      } finally {
        this.busy = false;
        await this.refreshConversations();
        if (!completed) {
          await this.selectConversation(conversationId);
        }
        this.focusMessageComposer();
      }
    },

    focusMessageComposer() {
      this.$nextTick(() => focusTextArea(this.$refs.messageComposer));
    },

    resizeMessageComposer() {
      const input = this.$refs.messageComposer;
      if (!(input instanceof HTMLTextAreaElement)) {
        return;
      }
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    },

    citationForId(message, id) {
      return message.citations.find((citation) => citation.id === id) ?? null;
    },

    messageAnswerStatements(message) {
      if (message.streaming === true) {
        return message.answerContent.statements;
      }
      return createAnswerContentFromDocument(message.answerDocument).statements;
    },

    findingCheckForStatement(message, statementIndex) {
      return message.claims.find((claim) => {
        return claim.claimIndex === statementIndex;
      }) ?? null;
    },

    citationVerificationStatus(message, statementIndex, citationId) {
      const check = this.findingCheckForStatement(message, statementIndex);
      const citation = this.citationForId(message, citationId);
      if (check === null || citation === null) {
        return null;
      }
      const evidenceUnit = check.evidenceUnits.find((unit) => {
        return unit.citationNumber === citation.citationNumber;
      });
      if (evidenceUnit === undefined) {
        return null;
      }
      if (evidenceUnit.outcome === "supported") {
        return "supported";
      }
      if (evidenceUnit.outcome === "unsupported") {
        return "unsupported";
      }
      return "unverified";
    },

    citationVerificationClasses(message, statementIndex, citationId) {
      const status = this.citationVerificationStatus(
        message,
        statementIndex,
        citationId,
      );
      if (status === null) {
        return "";
      }
      const check = this.findingCheckForStatement(message, statementIndex);
      if (
        status === "unsupported"
        && check?.status === "collectively-supported"
      ) {
        return "unsupported collectively-supported";
      }
      return status;
    },

    citationVerificationDescription(message, statementIndex, citationId) {
      const status = this.citationVerificationStatus(
        message,
        statementIndex,
        citationId,
      );
      const check = this.findingCheckForStatement(message, statementIndex);
      if (status === "supported") {
        return "Automated evidence check: this citation supports the finding.";
      }
      if (status === "unsupported") {
        if (check?.status === "collectively-supported") {
          return "Automated evidence check: this citation does not independently support the complete finding, but the cited evidence supports it collectively.";
        }
        return "Automated evidence check: this citation does not sufficiently support the finding.";
      }
      if (status === "unverified") {
        if (
          message.verificationState === "pending"
          || message.verificationState === "running"
        ) {
          return "Automated evidence check is pending.";
        }
        if (message.verificationState === "failed") {
          return "Automated evidence check could not be completed.";
        }
        return "Automated evidence check: this citation could not be verified.";
      }
      return "This citation was not checked because the statement is not a finding.";
    },

    statementCitationLabel(message, statementIndex, citationId) {
      const citation = this.citationForId(message, citationId);
      if (citation === null) {
        return "";
      }
      const label = this.citationLabel(citation);
      const description = this.citationVerificationDescription(
        message,
        statementIndex,
        citationId,
      );
      return `${label}. ${description}`;
    },

    citationLabel(citation) {
      if (citation === null) {
        return "";
      }
      const page = citation.pageNumbers[0];
      return page === undefined
        ? `[${citation.citationNumber}]`
        : `[${citation.citationNumber}] p. ${page}`;
    },

    sourcePageLabel(source) {
      if (source.pageNumbers.length === 0) {
        return "Page not specified";
      }
      const prefix = source.pageNumbers.length === 1 ? "p." : "pp.";
      return `${prefix} ${source.pageNumbers.join(", ")}`;
    },

    evidenceSources(message) {
      const sourcesByKey = new Map();
      for (const citation of message.citations) {
        const key = `${citation.documentVersionId}:${citation.sourceFile}`;
        const existing = sourcesByKey.get(key);
        if (existing !== undefined) {
          for (const pageNumber of citation.pageNumbers) {
            existing.pageNumberSet.add(pageNumber);
          }
          continue;
        }
        sourcesByKey.set(key, {
          citation,
          pageNumberSet: new Set(citation.pageNumbers),
        });
      }
      const sources = [];
      for (const source of sourcesByKey.values()) {
        sources.push({
          citation: source.citation,
          pageNumbers: [...source.pageNumberSet].sort((left, right) => {
            return left - right;
          }),
        });
      }
      return sources;
    },

    sourceTitle(sourceFile) {
      const parts = sourceFile.split(/[\\/]/u);
      return parts[parts.length - 1] ?? sourceFile;
    },

    openCitation(citation) {
      if (citation === null) {
        return;
      }
      this.selectedCitation = citation;
    },

    closeCitation() {
      this.selectedCitation = null;
    },

    statementSectionHeading(section) {
      if (section === "key-points") {
        return "Key findings";
      }
      if (section === "conflicting-evidence") {
        return "Conflicting evidence";
      }
      return "Answer";
    },

    shouldShowStatementSectionHeading(message, statementIndex) {
      const statements = this.messageAnswerStatements(message);
      const statement = statements[statementIndex];
      if (statement === undefined || statement.section === "answer") {
        return false;
      }
      const previousStatement = statements[statementIndex - 1];
      return previousStatement?.section !== statement.section;
    },

    evidenceText(citation) {
      if (citation.evidence.kind === "text") {
        return citation.evidence.excerpt;
      }
      if (citation.evidence.kind === "table") {
        return citation.evidence.content;
      }
      return "Image evidence";
    },

    highlightedFileUrl(citation) {
      const citationId = encodeURIComponent(citation.id);
      return buildPdfViewerUrl(
        `/api/chat/citations/${citationId}/highlighted-file`,
        citation.pageNumbers,
      );
    },

    imageUrl(citation) {
      return `/api/chat/citations/${encodeURIComponent(citation.id)}/image`;
    },

    scopeLabel() {
      if (this.conversation?.scope.kind === "all") {
        return "All indexed documents";
      }
      if (this.conversation?.scope.kind === "documentIds") {
        return `${this.conversation.scope.documentIds.length} selected documents`;
      }
      if (this.conversation?.scope.kind === "sourceFiles") {
        return `${this.conversation.scope.sourceFiles.length} selected documents`;
      }
      return `Documents tagged ${this.conversation?.scope.tags.join(", ")}`;
    },

    hasPendingVerification() {
      if (this.conversation === null) {
        return false;
      }
      for (const run of this.conversation.runs) {
        for (const message of run.messages) {
          if (
            message.role === "assistant"
            && (
              message.verificationState === "pending"
              || message.verificationState === "running"
            )
          ) {
            return true;
          }
        }
      }
      return false;
    },

    scheduleVerificationRefresh() {
      this.clearVerificationRefresh();
      if (!this.hasPendingVerification()) {
        return;
      }
      this.verificationRefreshTimer = window.setTimeout(() => {
        this.verificationRefreshTimer = null;
        void this.refreshVerification();
      }, 800);
    },

    clearVerificationRefresh() {
      if (this.verificationRefreshTimer === null) {
        return;
      }
      window.clearTimeout(this.verificationRefreshTimer);
      this.verificationRefreshTimer = null;
    },

    async refreshVerification() {
      const conversationId = this.conversation?.id;
      if (conversationId === undefined) {
        return;
      }
      try {
        const response = await fetch(
          `/api/chat/conversations/${encodeURIComponent(conversationId)}`,
        );
        const conversation = await readJsonResponse(
          response,
          "Chat verification refresh",
          readChatConversation,
        );
        if (this.conversation?.id === conversationId) {
          this.conversation = conversation;
        }
      } catch {
        // Verification refresh is best effort. The published answer remains usable.
      } finally {
        this.scheduleVerificationRefresh();
      }
    },

    runStatusLabel(run) {
      if (run.state === "failed") {
        return "Response failed";
      }
      if (run.state === "canceled") {
        return "Response canceled";
      }
      return run.state;
    },

    formatTime(value) {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(readString(value, "chat time")));
    },

    formatRecency(value) {
      const date = new Date(readString(value, "chat time"));
      const today = new Date();
      const dateDay = new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
      );
      const todayDay = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
      );
      const dayDifference = Math.round(
        (todayDay.getTime() - dateDay.getTime()) / 86_400_000,
      );
      if (dayDifference === 0) {
        return "Today";
      }
      if (dayDifference === 1) {
        return "Yesterday";
      }
      return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
      }).format(date);
    },

    scrollToLatest() {
      const thread = this.$refs.thread;
      if (thread instanceof HTMLElement) {
        thread.scrollTop = thread.scrollHeight;
      }
    },

    reportError(error, fallback) {
      const message = error instanceof Error ? error.message : fallback;
      this.errorMessage = message;
      dispatchNotice("error", message);
    },
  }));
}
