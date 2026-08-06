import {
  readArray,
  readBoolean,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullableNonEmptyString,
  readNullableNonNegativeInteger,
  readPlainObject as readObject,
  readPositiveInteger,
  readUIMessageStream,
} from "./citeloom-boundaries.js";
import {
  applyAnswerContentUpdate,
  buildAnswerContentSections,
  createAnswerContentFromDocument,
  createEmptyAnswerContent,
  readAnswerContentUpdate,
} from "./citeloom-answer-content.js";
import { requestAnswerSpeech } from "./citeloom-answer-speech.js";
import {
  buildCitationPresentation,
  buildCitationPresentations,
} from "./citeloom-citation-presentation.js";
import { buildPdfViewerUrl } from "./citeloom-file-links.js";
import { focusTextArea } from "./citeloom-focus.js";
import { createDictationController } from "./citeloom-dictation.js";
import { dispatchNotice } from "./citeloom-notices.js";
import {
  readAskAnswerDocument,
  readPublishedAnswerEvidence,
  readPublishedSourceRegions,
} from "./citeloom-published-answer.js";

const claimStatuses = Object.freeze([
  "partially-supported",
  "supported",
  "unsupported",
  "unverified",
]);
const discoveryMatchKinds = Object.freeze(["keyword", "semantic"]);
const discoveryStatuses = Object.freeze([
  "complete",
  "degraded",
  "disabled",
  "unavailable",
]);
const evidenceKinds = Object.freeze(["image", "table", "text"]);
const feedbackDimensions = Object.freeze([
  "answer-usefulness",
  "citation-correctness",
  "retrieval-relevance",
]);
const scopeKinds = Object.freeze([
  "all",
  "documentIds",
  "sourceFiles",
  "tags",
]);
const evidenceInspectorResizeStep = 16;
const minimumEvidenceInspectorHeight = 260;
const minimumEvidenceInspectorWidth = 360;

export function aggregateCitationStatus(claims, citationNumber) {
  let matched = false;
  let partiallySupported = false;
  let supported = false;
  let unsupported = false;
  for (const claim of claims) {
    if (!claim.citationNumbers.includes(citationNumber)) {
      continue;
    }
    matched = true;
    if (claim.status === "unverified") {
      return "unverified";
    }
    if (claim.status === "partially-supported") {
      partiallySupported = true;
    } else if (claim.status === "supported") {
      supported = true;
    } else {
      unsupported = true;
    }
  }
  if (!matched) {
    return "unverified";
  }
  if (partiallySupported || (supported && unsupported)) {
    return "partially-supported";
  }
  return unsupported ? "unsupported" : "supported";
}

export function formatClaimStatusLabel(status) {
  if (status === "partially-supported") {
    return "Verifier found mixed support";
  }
  if (status === "unsupported") {
    return "Possible unsupported content";
  }
  return status === "supported"
    ? "Supported by verifier"
    : "Verifier uncertain";
}

function readStringArray(value, label) {
  const values = readArray(value, label);
  const result = [];
  for (const item of values) {
    result.push(readNonEmptyString(item, `${label} item`));
  }
  return result;
}

function readPositiveIntegerArray(value, label) {
  const values = readArray(value, label);
  const result = [];
  for (const item of values) {
    result.push(readPositiveInteger(item, `${label} item`));
  }
  return result;
}

function readStringEnumArray(value, allowedValues, label) {
  const values = readArray(value, label);
  const result = [];
  for (const item of values) {
    result.push(readEnum(item, allowedValues, `${label} item`));
  }
  return result;
}

function readAskDashboard(value) {
  const dashboard = readObject(value, "dashboard");
  const summary = readObject(dashboard.documentSummary, "document summary");
  const tagValues = readArray(summary.queryableTags, "queryable tags");
  const availableTagFacets = [];
  for (const tagValue of tagValues) {
    const facet = readObject(tagValue, "queryable tag");
    availableTagFacets.push({
      count: readNonNegativeInteger(facet.count, "queryable tag count"),
      tag: readNonEmptyString(facet.tag, "queryable tag name"),
    });
  }
  const features = readObject(dashboard.features, "dashboard features");
  const inferenceRuntime = readObject(
    dashboard.inferenceRuntime,
    "inference runtime",
  );
  return {
    availableTagFacets,
    inferenceRuntimeName: readNonEmptyString(
      inferenceRuntime.name,
      "inference runtime name",
    ),
    queryableDocumentCount: readNonNegativeInteger(
      summary.queryable,
      "queryable document count",
    ),
    speechToTextEnabled: readBoolean(
      features.speechToText,
      "speech-to-text feature",
    ),
    textToSpeechEnabled: readBoolean(
      features.textToSpeech,
      "text-to-speech feature",
    ),
    textToSpeechPreloadEnabled: readBoolean(
      features.textToSpeechPreload,
      "text-to-speech preload feature",
    ),
  };
}

function readResearchThreadSummaries(value) {
  const values = readArray(value, "research threads");
  const summaries = [];
  for (const item of values) {
    const summary = readObject(item, "research thread summary");
    summaries.push({
      id: readNonEmptyString(summary.id, "research thread id"),
      title: readNonEmptyString(summary.title, "research thread title"),
      turnCount: readNonNegativeInteger(
        summary.turnCount,
        "research thread turn count",
      ),
    });
    readNonEmptyString(summary.createdAt, "research thread created time");
    readNonEmptyString(summary.updatedAt, "research thread updated time");
  }
  return summaries;
}

export function readAnswerPresentation(value) {
  const answerDocument = readAskAnswerDocument(value);
  return {
    answerDocument,
    sources: buildCitationPresentations(answerDocument.citations),
  };
}

function readClaim(value, label) {
  const claim = readObject(value, label);
  return {
    citationNumbers: readPositiveIntegerArray(
      claim.citationNumbers,
      `${label} citation numbers`,
    ),
    claim: readNonEmptyString(claim.claim, `${label} text`),
    id: readNonEmptyString(claim.id, `${label} id`),
    rationale: readNonEmptyString(claim.rationale, `${label} rationale`),
    status: readEnum(claim.status, claimStatuses, `${label} status`),
  };
}

function readClaims(value) {
  const values = readArray(value, "claim checks");
  const claims = [];
  for (let index = 0; index < values.length; index += 1) {
    claims.push(readClaim(values[index], `claim check ${index + 1}`));
  }
  return claims;
}

function readMatchedDocuments(value) {
  const values = readArray(value, "retrieved context");
  const documents = [];
  for (const item of values) {
    const document = readObject(item, "retrieved document");
    documents.push({
      documentId: readNonEmptyString(
        document.documentId,
        "retrieved document id",
      ),
      retrievedElementCount: readPositiveInteger(
        document.retrievedElementCount,
        "retrieved element count",
      ),
      sourceFile: readNonEmptyString(
        document.sourceFile,
        "retrieved source file",
      ),
    });
  }
  return documents;
}

function readRunDetails(value) {
  if (value === null) {
    return null;
  }
  const details = readObject(value, "answer run details");
  return {
    durationMs: readNonNegativeInteger(details.durationMs, "answer duration"),
    finishReason: readNullableNonEmptyString(
      details.finishReason,
      "answer finish reason",
    ),
    inputTokens: readNullableNonNegativeInteger(
      details.inputTokens,
      "answer input token count",
    ),
    modelId: readNonEmptyString(details.modelId, "answer model id"),
    outputTokens: readNullableNonNegativeInteger(
      details.outputTokens,
      "answer output token count",
    ),
    sourceCount: readNonNegativeInteger(
      details.sourceCount,
      "answer source count",
    ),
  };
}

function readAnswerTurn(value) {
  const turn = readObject(value, "answer turn");
  return {
    runId: readNonEmptyString(turn.runId, "answer run id"),
    sequence: readPositiveInteger(turn.sequence, "answer turn sequence"),
    threadId: readNonEmptyString(turn.threadId, "answer thread id"),
    turnId: readNonEmptyString(turn.turnId, "answer turn id"),
  };
}

function readStreamedAnswer(value) {
  const answer = readObject(value, "streamed answer");
  const presentation = readAnswerPresentation(
    answer.answerDocument,
    "answer citation table",
  );
  return {
    ...presentation,
    claims: readClaims(answer.claims),
    matchedDocuments: readMatchedDocuments(answer.matchedDocuments),
    runDetails: readRunDetails(answer.runDetails),
    turn: readAnswerTurn(answer.turn),
  };
}

function readScope(value) {
  const scope = readObject(value, "research turn scope");
  const kind = readEnum(scope.kind, scopeKinds, "research turn scope kind");
  if (kind === "all") {
    return { kind };
  }
  if (kind === "documentIds") {
    return {
      documentIds: readStringArray(scope.documentIds, "scope document ids"),
      kind,
    };
  }
  if (kind === "sourceFiles") {
    return {
      kind,
      sourceFiles: readStringArray(scope.sourceFiles, "scope source files"),
    };
  }
  return {
    kind,
    tags: readStringArray(scope.tags, "scope tags"),
  };
}

function readResearchTurn(value, label) {
  const turn = readObject(value, label);
  const presentation = readAnswerPresentation(
    turn.answerDocument,
    `${label} citation table`,
  );
  readArray(turn.citations, `${label} citations`);
  readObject(turn.reproducibility, `${label} reproducibility`);
  readObject(turn.runConfiguration, `${label} run configuration`);
  return {
    ...presentation,
    claims: readClaims(turn.claims),
    completedAt: readNonEmptyString(turn.completedAt, `${label} completed time`),
    id: readNonEmptyString(turn.id, `${label} id`),
    question: readNonEmptyString(turn.question, `${label} question`),
    retrievedContext: readMatchedDocuments(turn.retrievedContext),
    runId: readNonEmptyString(turn.runId, `${label} run id`),
    scope: readScope(turn.scope),
    sequence: readPositiveInteger(turn.sequence, `${label} sequence`),
    threadId: readNonEmptyString(turn.threadId, `${label} thread id`),
  };
}

function readResearchThread(value) {
  const thread = readObject(value, "research thread");
  const turnValues = readArray(thread.turns, "research turns");
  const turns = [];
  for (let index = 0; index < turnValues.length; index += 1) {
    turns.push(readResearchTurn(turnValues[index], `research turn ${index + 1}`));
  }
  return {
    id: readNonEmptyString(thread.id, "research thread id"),
    title: readNonEmptyString(thread.title, "research thread title"),
    turns,
  };
}

function readDiscoveryPassage(value, label) {
  const passage = readObject(value, label);
  readArray(passage.regions, `${label} regions`);
  return {
    excerpt: readNonEmptyString(passage.excerpt, `${label} excerpt`),
    id: readNonEmptyString(passage.id, `${label} id`),
    kind: readEnum(passage.kind, evidenceKinds, `${label} kind`),
    matchKinds: readStringEnumArray(
      passage.matchKinds,
      discoveryMatchKinds,
      `${label} match kinds`,
    ),
    pageNumbers: readPositiveIntegerArray(
      passage.pageNumbers,
      `${label} page numbers`,
    ),
    sectionPath: readStringArray(passage.sectionPath, `${label} section path`),
  };
}

function readDiscoveryDocument(value, label) {
  const document = readObject(value, label);
  const passageValues = readArray(document.passages, `${label} excerpts`);
  if (passageValues.length === 0) {
    throw new Error(`The ${label} response is invalid.`);
  }
  const passages = [];
  for (let index = 0; index < passageValues.length; index += 1) {
    passages.push(readDiscoveryPassage(
      passageValues[index],
      `${label} excerpt ${index + 1}`,
    ));
  }
  return {
    documentId: readNonEmptyString(document.documentId, `${label} document id`),
    matchKinds: readStringEnumArray(
      document.matchKinds,
      discoveryMatchKinds,
      `${label} match kinds`,
    ),
    matchingPassageCount: readPositiveInteger(
      document.matchingPassageCount,
      `${label} matching excerpt count`,
    ),
    passages,
    sourceFile: readNonEmptyString(document.sourceFile, `${label} source file`),
  };
}

function readDiscoveryDocuments(value, label) {
  const values = readArray(value, label);
  const documents = [];
  for (let index = 0; index < values.length; index += 1) {
    documents.push(readDiscoveryDocument(
      values[index],
      `${label} document ${index + 1}`,
    ));
  }
  return documents;
}

function readDiscoveryResponse(value) {
  const response = readObject(value, "source discovery");
  const keyword = readObject(response.keyword, "keyword discovery");
  const related = readObject(response.related, "related discovery");
  return {
    keyword: {
      documents: readDiscoveryDocuments(
        keyword.documents,
        "keyword discovery documents",
      ),
      page: readPositiveInteger(keyword.page, "keyword discovery page"),
      pageSize: readPositiveInteger(
        keyword.pageSize,
        "keyword discovery page size",
      ),
      status: readEnum(
        keyword.status,
        discoveryStatuses,
        "keyword discovery status",
      ),
      totalDocuments: readNonNegativeInteger(
        keyword.totalDocuments,
        "keyword discovery total",
      ),
      warning: readNullableNonEmptyString(
        keyword.warning,
        "keyword discovery warning",
      ),
    },
    query: readNonEmptyString(response.query, "source discovery query"),
    related: {
      documents: readDiscoveryDocuments(
        related.documents,
        "related discovery documents",
      ),
      limit: readPositiveInteger(related.limit, "related discovery limit"),
      status: readEnum(
        related.status,
        discoveryStatuses,
        "related discovery status",
      ),
      warning: readNullableNonEmptyString(
        related.warning,
        "related discovery warning",
      ),
    },
  };
}

function readStoredCitation(value) {
  const citation = readObject(value, "stored citation");
  const evidence = readPublishedAnswerEvidence(
    citation.evidence,
    "stored citation evidence",
  );
  const regions = readPublishedSourceRegions(
    citation.regions,
    "stored citation regions",
  );
  const storedCitation = {
    citationNumber: readPositiveInteger(
      citation.citationNumber,
      "stored citation number",
    ),
    documentId: readNonEmptyString(
      citation.documentId,
      "stored citation document id",
    ),
    documentVersionId: readNonEmptyString(
      citation.documentVersionId,
      "stored citation document version id",
    ),
    elementId: readNonEmptyString(
      citation.elementId,
      "stored citation element id",
    ),
    evidence,
    id: readNonEmptyString(citation.id, "stored citation id"),
    pageNumbers: readPositiveIntegerArray(
      citation.pageNumbers,
      "stored citation page numbers",
    ),
    regions,
    regionCount: regions.length,
    sectionPath: readStringArray(
      citation.sectionPath,
      "stored citation section path",
    ),
    sourceFile: readNonEmptyString(
      citation.sourceFile,
      "stored citation source file",
    ),
    stale: readBoolean(citation.stale, "stored citation stale state"),
  };
  return buildCitationPresentation(storedCitation);
}

function buildStoredCitationPreview(source) {
  return {
    citationNumber: source.citationNumber,
    documentId: source.documentId,
    documentVersionId: source.documentVersionId,
    elementId: source.elementId,
    evidence: source.evidence,
    id: source.id,
    pageNumbers: source.pageNumbers,
    regions: source.regions,
    regionCount: source.regions.length,
    sectionPath: source.sectionPath,
    sourceFile: source.sourceFile,
    stale: false,
  };
}

function readFeedbackResponse(value) {
  const response = readObject(value, "research feedback");
  return {
    negativeCount: readNonNegativeInteger(response.negativeCount, "negative feedback count"),
    positiveCount: readNonNegativeInteger(response.positiveCount, "positive feedback count"),
    rating: readFeedbackRating(response.rating),
  };
}

function readFeedbackRating(value) {
  if (value === -1 || value === 0 || value === 1) {
    return value;
  }
  throw new Error("The current feedback rating is invalid.");
}

function readStreamPart(part, type) {
  if (type === "data-answer") {
    return { answer: readStreamedAnswer(part.data), type };
  }
  if (type === "data-answer-content") {
    return { update: readAnswerContentUpdate(part.data), type };
  }
  return { type };
}

function buildHistoricalAnswer(turn) {
  return {
    answerDocument: turn.answerDocument,
    claims: turn.claims,
    matchedDocuments: turn.retrievedContext,
    runDetails: null,
    sources: turn.sources,
    turn: {
      runId: turn.runId,
      sequence: turn.sequence,
      threadId: turn.threadId,
      turnId: turn.id,
    },
  };
}

function readErrorMessage(error, fallback) {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return fallback;
}

async function readAnswerStream(response, receiveAnswer, receivePreview) {
  let answerReceived = false;
  await readUIMessageStream(response, "Question request", (rawPart, type) => {
    const part = readStreamPart(rawPart, type);
    if (part.type === "data-answer-content") {
      receivePreview(part.update);
      return;
    }
    if (part.type === "data-answer") {
      answerReceived = true;
      receiveAnswer(part.answer);
    }
  });
  if (!answerReceived) {
    throw new Error("The answer stream ended without a completed answer.");
  }
}

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

function readEvidenceInspectorViewport() {
  return {
    height: window.innerHeight,
    width: window.innerWidth,
  };
}

export function registerPage(alpine) {
  alpine.data("citeloomAskPage", () => ({
    answer: null,
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
    creatingThread: false,
    dashboardError: "",
    dashboardRefreshListener: null,
    deletingThread: false,
    deleteThreadConfirmationOpen: false,
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
    mode: "ask",
    newThreadTitle: "",
    operation: null,
    pushToTalkActive: false,
    pushToTalkAltHeld: false,
    pushToTalkBlockedUntilRelease: false,
    pushToTalkBlurListener: null,
    pushToTalkKeyDownListener: null,
    pushToTalkKeyUpListener: null,
    question: "",
    queryableDocumentCount: 0,
    requestAbortController: null,
    requestError: "",
    scopeKind: "all",
    selectedCitation: null,
    selectedDiscoveryDocuments: [],
    selectedTags: [],
    speechAbortController: null,
    speechAudioError: "",
    speechAudioLoading: false,
    speechAudioUrl: "",
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
      this.citationAbortController?.abort();
      this.resetCitationInspectorSize();
      this.dictationController?.destroy();
      this.dictationController = null;
      this.resetSpeechAudio();
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
        this.retainAvailableSelectedTags();
        this.inferenceRuntimeName = snapshot.inferenceRuntimeName;
        this.queryableDocumentCount = snapshot.queryableDocumentCount;
        this.speechToTextEnabled = snapshot.speechToTextEnabled;
        this.textToSpeechEnabled = snapshot.textToSpeechEnabled;
        this.textToSpeechPreloadEnabled = snapshot.textToSpeechPreloadEnabled;
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

    async selectResearchThread(threadId) {
      if (this.operation === "answer") {
        this.stopRequest();
      }
      this.threadId = threadId;
      this.thread = null;
      this.turnId = "";
      this.answer = null;
      this.requestError = "";
      this.closeEvidenceInspector();
      this.resetSpeechAudio();
      if (threadId === "") {
        return;
      }
      await this.loadResearchThread(threadId);
    },

    async loadResearchThread(threadId, preferredTurnId = "") {
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
        this.answer = nextTurn === null ? null : buildHistoricalAnswer(nextTurn);
        this.feedback = { answer: 0, citation: 0, retrieval: 0 };
        this.feedbackCounts = {
          answer: { negative: 0, positive: 0 },
          citation: { negative: 0, positive: 0 },
          retrieval: { negative: 0, positive: 0 },
        };
        await this.loadTurnFeedback();
        this.resetSpeechAudio();
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
      this.answer = turn === null ? null : buildHistoricalAnswer(turn);
      this.feedback = { answer: 0, citation: 0, retrieval: 0 };
      this.feedbackCounts = {
        answer: { negative: 0, positive: 0 },
        citation: { negative: 0, positive: 0 },
        retrieval: { negative: 0, positive: 0 },
      };
      await this.loadTurnFeedback();
      this.closeEvidenceInspector();
      this.resetSpeechAudio();
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
      this.answer = latestTurn === null ? null : buildHistoricalAnswer(latestTurn);
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
      if (this.thread === null || this.operation === "answer") {
        return;
      }
      this.deletingThread = true;
      try {
        const encodedThreadId = encodeURIComponent(this.thread.id);
        const response = await fetch(`/api/research/threads/${encodedThreadId}`, {
          method: "DELETE",
        });
        if (!response.ok) {
          await readJsonResponse(response, "Delete research thread request");
        }
        this.thread = null;
        this.threadId = "";
        this.turnId = "";
        this.answer = null;
        this.deleteThreadConfirmationOpen = false;
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
      this.answer = null;
      this.streamedAnswerContent = createEmptyAnswerContent();
      this.closeEvidenceInspector();
      this.resetSpeechAudio();
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
              this.answer = answer;
            }
          },
          (update) => {
            if (!controller.signal.aborted && this.answer === null) {
              this.streamedAnswerContent = applyAnswerContentUpdate(
                this.streamedAnswerContent,
                update,
              );
            }
          },
        );
        const completedTurnId = this.answer?.turn.turnId ?? "";
        if (!controller.signal.aborted) {
          await this.loadResearchThread(answeringThreadId, completedTurnId);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = readErrorMessage(
            error,
            "The answer could not be generated.",
          );
          dispatchNotice("error", message);
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
      if (
        this.discoveryResult === null
        || this.discoveryScope === null
        || this.operation !== null
        || this.discoveryPageLoading
      ) {
        return;
      }
      const currentPage = this.discoveryResult.keyword.page;
      const pageOffset = direction === "previous" ? -1 : 1;
      const requestedPage = currentPage + pageOffset;
      if (requestedPage < 1 || requestedPage > this.discoveryTotalPages()) {
        return;
      }
      void this.loadDiscoveryPage(requestedPage);
    },

    async loadDiscoveryPage(keywordPage) {
      if (this.discoveryResult === null || this.discoveryScope === null) {
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
          this.discoveryResult = {
            keyword: pageResult.keyword,
            query: completedResult.query,
            related: completedResult.related,
          };
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

    async inspectCitation(source) {
      this.citationAbortController?.abort();
      const controller = new AbortController();
      this.citationAbortController = controller;
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
      this.$root.querySelector(".evidence-inspector")?.focus();
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
        }
      }
    },

    inspectCitationNumber(citationNumber) {
      const source = this.answer?.sources.find((candidate) => {
        return candidate.citationNumber === citationNumber;
      });
      if (source !== undefined) {
        void this.inspectCitation(source);
      }
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

    async loadAnswerSpeech(surfaceError = true) {
      if (this.answer === null || this.speechAudioLoading) {
        return;
      }
      this.speechAbortController?.abort();
      const controller = new AbortController();
      this.speechAbortController = controller;
      this.speechAudioLoading = true;
      this.speechAudioError = "";
      this.revokeSpeechAudio();
      try {
        const audio = await requestAnswerSpeech(
          this.answer.answerDocument,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          this.speechAudioUrl = URL.createObjectURL(audio);
        }
      } catch (error) {
        if (!controller.signal.aborted && surfaceError) {
          this.speechAudioError = readErrorMessage(
            error,
            "The answer audio could not be generated.",
          );
        }
      } finally {
        if (this.speechAbortController === controller) {
          this.speechAbortController = null;
          this.speechAudioLoading = false;
        }
      }
    },

    maybePreloadAnswerSpeech() {
      if (
        this.answer === null
        || !this.textToSpeechEnabled
        || !this.textToSpeechPreloadEnabled
        || this.speechAudioLoading
        || this.speechAudioUrl !== ""
      ) {
        return;
      }
      void this.loadAnswerSpeech(false);
    },

    resetSpeechAudio() {
      this.speechAbortController?.abort();
      this.speechAbortController = null;
      this.speechAudioLoading = false;
      this.speechAudioError = "";
      this.revokeSpeechAudio();
    },

    revokeSpeechAudio() {
      if (this.speechAudioUrl !== "") {
        URL.revokeObjectURL(this.speechAudioUrl);
        this.speechAudioUrl = "";
      }
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
      let content = this.streamedAnswerContent;
      let sources = [];
      if (this.answer !== null) {
        content = createAnswerContentFromDocument(this.answer.answerDocument);
        sources = this.answer.sources;
      }
      return buildAnswerContentSections(content, sources);
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

    discoveryGroups() {
      if (this.discoveryResult === null) {
        return [];
      }
      const groups = [{
        documents: this.discoveryResult.keyword.documents,
        emptyLabel: this.discoveryResult.keyword.status === "complete"
          ? "No keyword matches appeared on this page."
          : "Keyword discovery is unavailable.",
        key: "keyword",
        label: "Keyword matches",
        total: this.discoveryResult.keyword.totalDocuments,
      }];
      if (this.discoveryResult.related.status !== "disabled") {
        const relatedDocuments = this.discoveryResult.related.documents;
        groups.push({
          documents: relatedDocuments,
          emptyLabel: "No semantic matches passed the relevance threshold.",
          key: "related",
          label: relatedDocuments.length >= this.discoveryResult.related.limit
            ? "Top semantic matches"
            : "Semantic matches",
          total: relatedDocuments.length,
        });
      }
      return groups;
    },

    discoveryWarnings() {
      if (this.discoveryResult === null) {
        return [];
      }
      const warnings = [];
      if (this.discoveryResult.keyword.warning !== null) {
        warnings.push(this.discoveryResult.keyword.warning);
      }
      if (this.discoveryResult.related.warning !== null) {
        warnings.push(this.discoveryResult.related.warning);
      }
      return warnings;
    },

    discoveryHasResults() {
      if (this.discoveryResult === null) {
        return false;
      }
      return this.discoveryResult.keyword.documents.length > 0
        || this.discoveryResult.related.documents.length > 0;
    },

    discoverySummary() {
      if (this.discoveryResult === null) {
        return "";
      }
      const keywordCount = this.discoveryResult.keyword.totalDocuments;
      const keywordLabel = keywordCount === 1
        ? "keyword-matched document"
        : "keyword-matched documents";
      if (this.discoveryResult.related.status === "disabled") {
        return `${keywordCount} ${keywordLabel}. Semantic matches were not searched.`;
      }
      const relatedCount = this.discoveryResult.related.documents.length;
      const relatedLabel = relatedCount === 1 ? "semantic match" : "semantic matches";
      return `${keywordCount} ${keywordLabel} and ${relatedCount} ${relatedLabel}.`;
    },

    discoveryTotalPages() {
      if (this.discoveryResult === null) {
        return 1;
      }
      return Math.max(
        1,
        Math.ceil(
          this.discoveryResult.keyword.totalDocuments
          / this.discoveryResult.keyword.pageSize,
        ),
      );
    },

    discoveryDocumentKey(document) {
      return `${document.documentId}\u0000${document.sourceFile}`;
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
        return "loan, mortgage risk, or another topic";
      }
      if (documentCount > 0) {
        return "What would you like to compare across these documents?";
      }
      return "What are the main findings across these documents?";
    },

    questionInputHint() {
      if (this.mode === "ask" && this.speechToTextEnabled) {
        return "Hold Option on Mac or Alt on Windows and Linux to dictate. Press Command or Control + Enter to submit.";
      }
      return "Press Command or Control + Enter to submit.";
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

    citationNavigatorTitle(source) {
      return source.sectionPath.at(-1) ?? this.basename(source.sourceFile);
    },

    citationNavigatorStatusLabel(citationNumber) {
      const status = this.answerCitationStatus(citationNumber);
      if (status === "supported") {
        return "Verified";
      }
      if (status === "partially-supported" || status === "unsupported") {
        return "Review";
      }
      return "Checking";
    },

    answerVerificationState() {
      if (this.answer === null || this.answer.claims.length === 0) {
        return "unavailable";
      }
      let hasPendingCheck = false;
      let hasUnverifiedClaim = false;
      for (const claim of this.answer.claims) {
        if (
          claim.status === "unsupported"
          || claim.status === "partially-supported"
        ) {
          return "review";
        }
        if (claim.status !== "unverified") {
          continue;
        }
        if (claim.rationale === "Automated evidence verification is pending.") {
          hasPendingCheck = true;
        } else {
          hasUnverifiedClaim = true;
        }
      }
      if (hasPendingCheck) {
        return "checking";
      }
      if (hasUnverifiedClaim) {
        return "unavailable";
      }
      return "verified";
    },

    answerVerificationLabel() {
      const state = this.answerVerificationState();
      if (state === "verified") {
        return "Verified";
      }
      if (state === "review") {
        return "Review evidence";
      }
      if (state === "checking") {
        return "Checking evidence";
      }
      return "Verification unavailable";
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
      if (claim === null) {
        return this.answer === null ? "Checking evidence" : "Not verified";
      }
      if (
        claim.status === "unverified"
        && claim.rationale === "Automated evidence verification is pending."
      ) {
        return "Checking evidence";
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
      const status = this.claimStatusLabel(
        this.answerCitationStatus(citation.citationNumber),
      );
      const evidence = this.accessibleEvidenceExcerpt(citation.evidence);
      return `Citation ${citation.citationNumber}, ${status}, ${this.basename(citation.sourceFile)}, ${this.documentLocationLabel(citation.sourceFile, citation.pageNumbers)}, ${evidence}`;
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
      return `${this.basename(this.selectedCitation.sourceFile)} · ${this.documentLocationLabel(this.selectedCitation.sourceFile, this.selectedCitation.pageNumbers)}`;
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
        return `${singular} unavailable`;
      }
      if (pageNumbers.length === 1) {
        return `${singular} ${pageNumbers[0]}`;
      }
      return `${plural} ${pageNumbers.join(", ")}`;
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

    additionalPassageLabel(document) {
      const count = Math.max(0, document.matchingPassageCount - 1);
      const label = count === 1 ? "excerpt" : "excerpts";
      return `${count} additional matching ${label}`;
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
      if (sourceFile.endsWith(".pdf") && this.inspectedCitation.regions.length > 0) {
        const citationId = encodeURIComponent(this.inspectedCitation.id);
        return buildPdfViewerUrl(
          `/api/citations/${citationId}/highlighted-file`,
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
