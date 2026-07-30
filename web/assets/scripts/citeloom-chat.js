import {
  readArray,
  readBoolean,
  readEnum,
  readJsonResponse,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullableNonEmptyString,
  readPlainObject,
  readPositiveInteger,
  readString,
} from "./citeloom-boundaries.js";
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
const answerStatuses = Object.freeze(["answered", "no_answer"]);
const evidenceUnitOutcomes = Object.freeze([
  "not-evaluated",
  "supported",
  "unsupported",
  "verifier-incompatible",
]);

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

function readAnswerDocument(value) {
  const answer = readPlainObject(value, "chat answer");
  return {
    citations: readArray(answer.citations, "answer citations").map((item) => {
      const citation = readPlainObject(item, "answer citation");
      return {
        id: readNonEmptyString(citation.id, "answer citation ID"),
      };
    }),
    schemaVersion: readPositiveInteger(
      answer.schemaVersion,
      "answer schema version",
    ),
    statements: readArray(answer.statements, "answer statements").map((item) => {
      const statement = readPlainObject(item, "answer statement");
      return {
        citationIds: readArray(
          statement.citationIds,
          "statement citation IDs",
        ).map((id) => readNonEmptyString(id, "statement citation ID")),
        content: readNonEmptyString(statement.content, "statement content"),
        presentation: readEnum(
          statement.presentation,
          ["bullet", "paragraph"],
          "statement presentation",
        ),
        section: readEnum(
          statement.section,
          ["answer", "conflicting-evidence", "key-points"],
          "statement section",
        ),
      };
    }),
    status: readEnum(answer.status, answerStatuses, "answer status"),
  };
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
  readNonEmptyString(response.conversationId, "chat response conversation ID");
  readNonEmptyString(response.runId, "chat response run ID");
  readPositiveInteger(response.sequence, "chat response sequence");
  const assistantMessage = readChatMessage(response.assistantMessage);
  if (assistantMessage.role !== "assistant") {
    throw new Error("Chat response assistant message has an invalid role.");
  }
  return response;
}

export function registerPage(alpine) {
  alpine.data("citeloomChatPage", () => ({
    busy: false,
    conversation: null,
    conversations: [],
    draft: "",
    errorMessage: "",
    loading: true,
    newChatOpen: false,
    newChatTitle: "",
    pendingContent: "",
    selectedCitation: null,

    async initialize() {
      await this.refreshConversations();
      if (this.conversations.length > 0) {
        await this.selectConversation(this.conversations[0].id);
      }
      this.loading = false;
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
      } catch (error) {
        this.reportError(error, "The chat could not be loaded.");
      }
    },

    openNewChat() {
      this.newChatTitle = "";
      this.newChatOpen = true;
      this.$nextTick(() => this.$refs.newChatTitle?.focus());
    },

    closeNewChat() {
      if (this.busy) {
        return;
      }
      this.newChatOpen = false;
      this.newChatTitle = "";
    },

    async createConversation() {
      const title = this.newChatTitle.trim();
      if (title === "") {
        this.errorMessage = "Enter a chat title.";
        return;
      }
      this.busy = true;
      this.errorMessage = "";
      try {
        const response = await fetch("/api/chat/conversations", {
          body: JSON.stringify({
            scope: { kind: "all" },
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
        this.newChatTitle = "";
        await this.refreshConversations();
        await this.selectConversation(conversation.id);
      } catch (error) {
        this.reportError(error, "The chat could not be created.");
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
        this.selectedCitation = null;
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
      this.busy = true;
      this.errorMessage = "";
      this.pendingContent = content;
      this.draft = "";
      this.$nextTick(() => this.scrollToLatest());
      try {
        const response = await fetch(
          `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
          {
            body: JSON.stringify({
              content,
              requestId: crypto.randomUUID(),
            }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
          },
        );
        await readJsonResponse(response, "Chat response", readMessageResponse);
      } catch (error) {
        this.reportError(error, "The response could not be generated.");
      } finally {
        this.pendingContent = "";
        this.busy = false;
        await this.refreshConversations();
        await this.selectConversation(conversationId);
      }
    },

    citationForId(message, id) {
      return message.citations.find((citation) => citation.id === id) ?? null;
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

    citationVerificationDescription(message, statementIndex, citationId) {
      const status = this.citationVerificationStatus(
        message,
        statementIndex,
        citationId,
      );
      if (status === "supported") {
        return "Automated evidence check: this citation supports the finding.";
      }
      if (status === "unsupported") {
        return "Automated evidence check: this citation does not sufficiently support the finding.";
      }
      if (status === "unverified") {
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

    openCitation(citation) {
      if (citation === null) {
        return;
      }
      this.selectedCitation = citation;
    },

    closeCitation() {
      this.selectedCitation = null;
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

    sourceFileUrl(citation) {
      return `/api/chat/citations/${encodeURIComponent(citation.id)}/file`;
    },

    highlightedFileUrl(citation) {
      return `/api/chat/citations/${encodeURIComponent(citation.id)}/highlighted-file`;
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
        return `${this.conversation.scope.sourceFiles.length} selected files`;
      }
      return `Documents tagged ${this.conversation?.scope.tags.join(", ")}`;
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
