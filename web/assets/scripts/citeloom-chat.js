import {
  readArray,
  readBoolean,
  readEnum,
  readFiniteNumber,
  readJsonResponse,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullableNonEmptyString,
  readPlainObject,
  readPositiveInteger,
  readString,
  readUIMessageStream,
} from "./citeloom-boundaries.js";
import {
  applyAnswerContentUpdate,
  createAnswerContentFromDocument,
  createEmptyAnswerContent,
  readAnswerContentUpdate,
} from "./citeloom-answer-content.js";
import { requestAnswerSpeech } from "./citeloom-answer-speech.js";
import { readDocumentCatalog } from "./citeloom-documents.js";
import { buildPdfViewerUrl } from "./citeloom-file-links.js";
import { focusTextArea } from "./citeloom-focus.js";
import { dispatchNotice } from "./citeloom-notices.js";

const chatRunStates = Object.freeze([
  "accepted",
  "embedding",
  "retrieving",
  "generating",
  "verifying",
  "publishing",
  "completed",
  "failed",
  "canceled",
]);
const chatMessageRoles = Object.freeze(["assistant", "user"]);
const evidenceUnitOutcomes = Object.freeze([
  "not-evaluated",
  "supported",
  "unsupported",
  "verifier-incompatible",
]);
const findingSupportStatuses = Object.freeze([
  "collectively-supported",
  "partially-supported",
  "supported",
  "unsupported",
  "unverified",
]);
const chatVerificationStates = Object.freeze([
  "not-applicable",
  "pending",
  "running",
  "completed",
  "failed",
]);
const answerSections = Object.freeze([
  "answer",
  "conflicting-evidence",
  "key-points",
]);
const evidenceKinds = Object.freeze(["image", "table", "text"]);
const statementPresentations = Object.freeze(["bullet", "paragraph"]);
const chatSwitcherRequestEvent = "citeloom:chat-switcher-request";

function readChatSummaries(value) {
  return readArray(value, "chat list").map((item) => {
    const summary = readPlainObject(item, "chat summary");
    return {
      createdAt: readNonEmptyString(summary.createdAt, "chat creation time"),
      id: readNonEmptyString(summary.id, "chat ID"),
      messageCount: readNonNegativeInteger(
        summary.messageCount,
        "chat message count",
      ),
      title: readNonEmptyString(summary.title, "chat title"),
      updatedAt: readNonEmptyString(summary.updatedAt, "chat update time"),
    };
  });
}

function readChatSpeechFeatures(value) {
  const dashboard = readPlainObject(value, "dashboard");
  const features = readPlainObject(dashboard.features, "dashboard features");
  return {
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

function readChatConversation(value) {
  const conversation = readPlainObject(value, "chat");
  return {
    createdAt: readNonEmptyString(conversation.createdAt, "chat creation time"),
    id: readNonEmptyString(conversation.id, "chat ID"),
    ownerUserId: readNonEmptyString(
      conversation.ownerUserId,
      "chat owner ID",
    ),
    runs: readArray(conversation.runs, "chat runs").map(readChatRun),
    scope: readChatScope(conversation.scope),
    title: readNonEmptyString(conversation.title, "chat title"),
    updatedAt: readNonEmptyString(conversation.updatedAt, "chat update time"),
    workspaceId: readNonEmptyString(
      conversation.workspaceId,
      "chat workspace ID",
    ),
  };
}

function readChatScope(value) {
  const scope = readPlainObject(value, "chat document scope");
  const kind = readEnum(
    scope.kind,
    ["all", "documentIds", "sourceFiles", "tags"],
    "scope kind",
  );
  if (kind === "all") {
    return { kind };
  }
  if (kind === "documentIds") {
    return {
      documentIds: readArray(scope.documentIds, "scope document IDs")
        .map((id) => readNonEmptyString(id, "scope document ID")),
      kind,
    };
  }
  if (kind === "sourceFiles") {
    return {
      kind,
      sourceFiles: readArray(scope.sourceFiles, "scope source files")
        .map((sourceFile) => {
          return readNonEmptyString(sourceFile, "scope source file");
        }),
    };
  }
  return {
    kind,
    tags: readArray(scope.tags, "scope tags")
      .map((tag) => readNonEmptyString(tag, "scope tag")),
  };
}

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

function readChatRun(value) {
  const run = readPlainObject(value, "chat run");
  return {
    attemptCount: readPositiveInteger(run.attemptCount, "chat attempt count"),
    completedAt: readNullableNonEmptyString(
      run.completedAt,
      "chat completion time",
    ),
    errorMessage: readNullableNonEmptyString(
      run.errorMessage,
      "chat error message",
    ),
    id: readNonEmptyString(run.id, "chat run ID"),
    messages: readArray(run.messages, "chat messages").map(readChatMessage),
    sequence: readPositiveInteger(run.sequence, "chat run sequence"),
    state: readEnum(run.state, chatRunStates, "chat run state"),
  };
}

function readChatMessage(value) {
  const message = readPlainObject(value, "chat message");
  const role = readEnum(message.role, chatMessageRoles, "chat message role");
  const normalized = {
    content: readNonEmptyString(message.content, "chat message content"),
    createdAt: readNonEmptyString(
      message.createdAt,
      "chat message creation time",
    ),
    id: readNonEmptyString(message.id, "chat message ID"),
    role,
    runId: readNonEmptyString(message.runId, "chat run ID"),
  };
  if (role === "user") {
    return normalized;
  }
  const answerDocument = readAnswerDocument(message.answerDocument);
  return {
    ...normalized,
    answerDocument,
    citations: readArray(message.citations, "chat citations")
      .map(readChatCitation),
    claims: readChatFindingChecks(message.claims, answerDocument),
    verificationState: readEnum(
      message.verificationState,
      chatVerificationStates,
      "chat verification state",
    ),
  };
}

function readChatFindingChecks(value, answerDocument) {
  const values = readArray(value, "chat finding checks");
  const checks = [];
  const checkedStatementIndexes = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const label = `chat finding check ${index + 1}`;
    const candidate = readPlainObject(values[index], label);
    const claimIndex = readNonNegativeInteger(
      candidate.claimIndex,
      `${label} statement index`,
    );
    if (checkedStatementIndexes.has(claimIndex)) {
      throw new Error(`${label} duplicates statement index ${claimIndex}.`);
    }
    const statement = answerDocument.statements[claimIndex];
    if (statement === undefined) {
      throw new Error(`${label} refers to an unavailable statement.`);
    }
    const claim = readNonEmptyString(candidate.claim, `${label} text`);
    if (claim !== statement.content) {
      throw new Error(`${label} does not match its answer statement.`);
    }
    checkedStatementIndexes.add(claimIndex);
    checks.push({
      evidenceUnits: readChatEvidenceUnits(
        candidate.evidenceUnits,
        candidate.citationNumbers,
        label,
      ),
      claimIndex,
      status: readEnum(
        candidate.status,
        findingSupportStatuses,
        `${label} status`,
      ),
    });
  }
  return checks;
}

function readChatEvidenceUnits(value, citationNumberValue, label) {
  const citationNumberValues = readArray(
    citationNumberValue,
    `${label} citation numbers`,
  );
  const citationNumbers = citationNumberValues.map((citationNumber) => {
    return readPositiveInteger(citationNumber, `${label} citation number`);
  });
  const values = readArray(value, `${label} evidence units`);
  const evidenceUnits = [];
  const seenCitationNumbers = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const unitLabel = `${label} evidence unit ${index + 1}`;
    const candidate = readPlainObject(values[index], unitLabel);
    const citationNumber = readPositiveInteger(
      candidate.citationNumber,
      `${unitLabel} citation number`,
    );
    if (
      seenCitationNumbers.has(citationNumber)
      || !citationNumbers.includes(citationNumber)
    ) {
      throw new Error(`${unitLabel} has an invalid citation number.`);
    }
    seenCitationNumbers.add(citationNumber);
    evidenceUnits.push({
      citationNumber,
      outcome: readEnum(
        candidate.outcome,
        evidenceUnitOutcomes,
        `${unitLabel} outcome`,
      ),
    });
  }
  if (seenCitationNumbers.size !== citationNumbers.length) {
    throw new Error(`${label} is missing citation evidence results.`);
  }
  return evidenceUnits;
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

function readAnswerSourceRegion(value, label) {
  const region = readPlainObject(value, label);
  const boundingBox = readPlainObject(
    region.boundingBox,
    `${label} bounding box`,
  );
  const characterSpan = readPlainObject(
    region.characterSpan,
    `${label} character span`,
  );
  return {
    boundingBox: {
      bottom: readFiniteNumber(
        boundingBox.bottom,
        `${label} bounding box bottom`,
      ),
      left: readFiniteNumber(
        boundingBox.left,
        `${label} bounding box left`,
      ),
      right: readFiniteNumber(
        boundingBox.right,
        `${label} bounding box right`,
      ),
      top: readFiniteNumber(
        boundingBox.top,
        `${label} bounding box top`,
      ),
    },
    characterSpan: {
      end: readNonNegativeInteger(
        characterSpan.end,
        `${label} character span end`,
      ),
      start: readNonNegativeInteger(
        characterSpan.start,
        `${label} character span start`,
      ),
    },
    pageNumber: readPositiveInteger(region.pageNumber, `${label} page number`),
  };
}

function readAnswerSourceRegions(value, label) {
  const values = readArray(value, label);
  const regions = [];
  for (let index = 0; index < values.length; index += 1) {
    regions.push(
      readAnswerSourceRegion(values[index], `${label} item ${index + 1}`),
    );
  }
  return regions;
}

function readAnswerTableCell(value, label) {
  const cell = readPlainObject(value, label);
  return {
    columnHeader: readBoolean(cell.columnHeader, `${label} column header`),
    columnSpan: readPositiveInteger(cell.columnSpan, `${label} column span`),
    endColumn: readPositiveInteger(cell.endColumn, `${label} end column`),
    endRow: readPositiveInteger(cell.endRow, `${label} end row`),
    rowHeader: readBoolean(cell.rowHeader, `${label} row header`),
    rowSection: readBoolean(cell.rowSection, `${label} row section`),
    rowSpan: readPositiveInteger(cell.rowSpan, `${label} row span`),
    startColumn: readNonNegativeInteger(
      cell.startColumn,
      `${label} start column`,
    ),
    startRow: readNonNegativeInteger(cell.startRow, `${label} start row`),
    text: readString(cell.text, `${label} text`),
  };
}

function readAnswerTableStructure(value, label) {
  const table = readPlainObject(value, label);
  const cellValues = readArray(table.cells, `${label} cells`);
  const cells = [];
  for (let index = 0; index < cellValues.length; index += 1) {
    cells.push(
      readAnswerTableCell(cellValues[index], `${label} cell ${index + 1}`),
    );
  }
  return {
    cells,
    columnCount: readPositiveInteger(
      table.columnCount,
      `${label} column count`,
    ),
    rowCount: readPositiveInteger(table.rowCount, `${label} row count`),
    rowEnd: readPositiveInteger(table.rowEnd, `${label} row end`),
    rowStart: readNonNegativeInteger(table.rowStart, `${label} row start`),
  };
}

function readAnswerEvidence(value, label) {
  const evidence = readPlainObject(value, label);
  const kind = readEnum(evidence.kind, evidenceKinds, `${label} kind`);
  if (kind === "text") {
    return {
      excerpt: readNonEmptyString(evidence.excerpt, `${label} excerpt`),
      kind,
    };
  }
  if (kind === "table") {
    return {
      content: readNonEmptyString(evidence.content, `${label} content`),
      kind,
      table: readAnswerTableStructure(
        evidence.table,
        `${label} table structure`,
      ),
    };
  }
  return {
    kind,
    mimeType: readNonEmptyString(evidence.mimeType, `${label} media type`),
  };
}

function readAnswerCitation(value, label) {
  const citation = readPlainObject(value, label);
  const kind = readEnum(citation.kind, evidenceKinds, `${label} kind`);
  const evidence = readAnswerEvidence(citation.evidence, `${label} evidence`);
  if (evidence.kind !== kind) {
    throw new Error(`The ${label} evidence kind does not match.`);
  }
  return {
    citationNumber: readPositiveInteger(
      citation.citationNumber,
      `${label} number`,
    ),
    documentId: readNonEmptyString(citation.documentId, `${label} document ID`),
    documentVersionId: readNonEmptyString(
      citation.documentVersionId,
      `${label} document version ID`,
    ),
    elementId: readNonEmptyString(citation.elementId, `${label} element ID`),
    evidence,
    id: readNonEmptyString(citation.id, `${label} ID`),
    kind,
    pageNumbers: readPositiveIntegerArray(
      citation.pageNumbers,
      `${label} page numbers`,
    ),
    regions: readAnswerSourceRegions(citation.regions, `${label} regions`),
    sectionPath: readStringArray(citation.sectionPath, `${label} section path`),
    sourceFile: readNonEmptyString(citation.sourceFile, `${label} source file`),
  };
}

function readAnswerDocument(value) {
  const answer = readPlainObject(value, "chat answer");
  const schemaVersion = readPositiveInteger(
    answer.schemaVersion,
    "answer schema version",
  );
  if (schemaVersion !== 1) {
    throw new Error("The answer schema version is unsupported.");
  }
  const citationValues = readArray(answer.citations, "answer citations");
  const citations = [];
  const citationIds = new Set();
  const citationNumbers = new Set();
  for (let index = 0; index < citationValues.length; index += 1) {
    const citation = readAnswerCitation(
      citationValues[index],
      `answer citation ${index + 1}`,
    );
    if (citationIds.has(citation.id)) {
      throw new Error("The answer contains a duplicate citation.");
    }
    if (citationNumbers.has(citation.citationNumber)) {
      throw new Error("The answer contains a duplicate citation number.");
    }
    citationIds.add(citation.id);
    citationNumbers.add(citation.citationNumber);
    citations.push(citation);
  }
  const statementValues = readArray(answer.statements, "answer statements");
  const statements = [];
  for (let index = 0; index < statementValues.length; index += 1) {
    const label = `answer statement ${index + 1}`;
    const statement = readPlainObject(statementValues[index], label);
    const statementCitationIds = readStringArray(
      statement.citationIds,
      `${label} citation IDs`,
    );
    for (const citationId of statementCitationIds) {
      if (!citationIds.has(citationId)) {
        throw new Error("The answer references an unavailable citation.");
      }
    }
    statements.push({
      citationIds: statementCitationIds,
      content: readNonEmptyString(statement.content, "statement content"),
      presentation: readEnum(
        statement.presentation,
        statementPresentations,
        "statement presentation",
      ),
      section: readEnum(
        statement.section,
        answerSections,
        "statement section",
      ),
    });
  }
  const hasCitations = citations.length > 0;
  const hasStatements = statements.length > 0;
  if (hasCitations !== hasStatements) {
    throw new Error("The chat answer is incomplete.");
  }
  if (!hasCitations) {
    return {
      citations,
      content: readNonEmptyString(answer.content, "uncited answer content"),
      schemaVersion,
      statements,
    };
  }
  return { citations, schemaVersion, statements };
}

function readChatCitation(value) {
  const citation = readPlainObject(value, "chat citation");
  return {
    citationNumber: readPositiveInteger(
      citation.citationNumber,
      "citation number",
    ),
    createdAt: readNonEmptyString(
      citation.createdAt,
      "citation creation time",
    ),
    documentId: readNonEmptyString(citation.documentId, "citation document ID"),
    documentVersionId: readNonEmptyString(
      citation.documentVersionId,
      "citation document version ID",
    ),
    elementId: readNonEmptyString(citation.elementId, "citation element ID"),
    evidence: readCitationEvidence(citation.evidence),
    id: readNonEmptyString(citation.id, "citation ID"),
    mediaType: readNonEmptyString(citation.mediaType, "citation media type"),
    pageNumbers: readArray(citation.pageNumbers, "citation page numbers")
      .map((page) => readPositiveInteger(page, "citation page number")),
    regions: readArray(citation.regions, "citation regions"),
    sectionPath: readArray(citation.sectionPath, "citation section path")
      .map((section) => readNonEmptyString(section, "citation section")),
    sourceAvailable: readBoolean(
      citation.sourceAvailable,
      "citation source availability",
    ),
    sourceFile: readNonEmptyString(citation.sourceFile, "citation source file"),
  };
}

function readCitationEvidence(value) {
  const evidence = readPlainObject(value, "citation evidence");
  const kind = readEnum(evidence.kind, ["image", "table", "text"], "evidence kind");
  if (kind === "text") {
    return {
      excerpt: readNonEmptyString(evidence.excerpt, "citation excerpt"),
      kind,
    };
  }
  if (kind === "table") {
    readPlainObject(evidence.table, "citation table structure");
    return {
      content: readNonEmptyString(evidence.content, "citation table content"),
      kind,
    };
  }
  return {
    kind,
    mimeType: readNonEmptyString(evidence.mimeType, "citation image type"),
  };
}

function readCreatedChat(value) {
  return readChatConversation(value);
}

function readMessageResponse(value) {
  const response = readPlainObject(value, "chat response");
  const conversationId = readNonEmptyString(
    response.conversationId,
    "chat response conversation ID",
  );
  const run = readChatRun(response.run);
  if (run.state !== "completed") {
    throw new Error("Chat response run is not completed.");
  }
  return { conversationId, run };
}

async function readChatMessageStream(response, receiveMessage, receivePreview) {
  let messageReceived = false;
  await readUIMessageStream(response, "Chat response", (part, type) => {
    if (type === "data-answer-content") {
      receivePreview(readAnswerContentUpdate(part.data));
      return;
    }
    if (type === "data-chat") {
      messageReceived = true;
      receiveMessage(readMessageResponse(part.data));
    }
  });
  if (!messageReceived) {
    throw new Error("The chat stream ended without a completed response.");
  }
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
        this.textToSpeechEnabled = features.textToSpeechEnabled;
        this.textToSpeechPreloadEnabled =
          features.textToSpeechPreloadEnabled;
        if (!this.textToSpeechEnabled) {
          this.resetChatSpeechAudio();
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
      const confirmed = window.confirm(
        `Delete "${this.conversation.title}" and its retained evidence?`,
      );
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
