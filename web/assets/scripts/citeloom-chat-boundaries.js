import {
  readArray,
  readBoolean,
  readEnum,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullableNonEmptyString,
  readPlainObject,
  readPositiveInteger,
  readUIMessageStream,
} from "./citeloom-boundaries.js";
import { readAnswerContentUpdate } from "./citeloom-answer-content.js";
import {
  buildCitationPresentation,
} from "./citeloom-citation-presentation.js";
import {
  readChatAnswerDocument,
  readPublishedAnswerEvidence,
} from "./citeloom-published-answer.js";

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

export function readChatSummaries(value) {
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

export function readChatSpeechFeatures(value) {
  const dashboard = readPlainObject(value, "dashboard");
  const features = readPlainObject(dashboard.features, "dashboard features");
  return {
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

export function readChatConversation(value) {
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

export function readCreatedChat(value) {
  return readChatConversation(value);
}

export async function readChatMessageStream(
  response,
  receiveMessage,
  receivePreview,
) {
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
  const answerDocument = readChatAnswerDocument(message.answerDocument);
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

function readChatCitation(value) {
  const citation = readPlainObject(value, "chat citation");
  const normalized = {
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
    evidence: readPublishedAnswerEvidence(
      citation.evidence,
      "citation evidence",
    ),
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
  return buildCitationPresentation(normalized);
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
