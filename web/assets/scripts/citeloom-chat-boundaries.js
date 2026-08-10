import {
  readArray,
  readBoolean,
  readEnum,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullableNonEmptyString,
  readPlainObject,
  readPositiveInteger,
  readProbability,
  readUIMessageStream,
} from "./citeloom-boundaries.js";
import {
  createAnswerCitationKey,
  createAnswerContentFromDocument,
  readAnswerContentUpdate,
} from "./citeloom-answer-content.js";
import {
  buildCitationPresentation,
} from "./citeloom-citation-presentation.js";
import {
  readChatAnswerDocument,
  readPublishedAnswerEvidence,
} from "./citeloom-published-answer.js";
import { readAnswerVerificationClaims } from "./citeloom-verification.js";

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

export function readChatDashboard(value) {
  const dashboard = readPlainObject(value, "dashboard");
  const features = readPlainObject(dashboard.features, "dashboard features");
  const inferenceRuntime = readPlainObject(
    dashboard.inferenceRuntime,
    "dashboard inference runtime",
  );
  const claimVerifier = readPlainObject(
    inferenceRuntime.claimVerifier,
    "dashboard claim verifier",
  );
  return {
    claimVerifierSupportThreshold: readProbability(
      claimVerifier.supportThreshold,
      "claim verifier support threshold",
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
    answerContent: createAnswerContentFromDocument(answerDocument),
    answerDocument,
    citations: readArray(message.citations, "chat citations")
      .map(readChatCitation),
    claims: readAnswerVerificationClaims(
      message.claims,
      answerDocument,
      "chat finding check",
    ),
    verificationState: readEnum(
      message.verificationState,
      chatVerificationStates,
      "chat verification state",
    ),
  };
}

function readChatCitation(value) {
  const citation = readPlainObject(value, "chat citation");
  const documentId = readNonEmptyString(
    citation.documentId,
    "citation document ID",
  );
  const documentVersionId = readNonEmptyString(
    citation.documentVersionId,
    "citation document version ID",
  );
  const elementId = readNonEmptyString(
    citation.elementId,
    "citation element ID",
  );
  const normalized = {
    citationNumber: readPositiveInteger(
      citation.citationNumber,
      "citation number",
    ),
    createdAt: readNonEmptyString(
      citation.createdAt,
      "citation creation time",
    ),
    documentId,
    documentVersionId,
    elementId,
    evidence: readPublishedAnswerEvidence(
      citation.evidence,
      "citation evidence",
    ),
    id: readNonEmptyString(citation.id, "citation ID"),
    key: createAnswerCitationKey(documentVersionId, documentId, elementId),
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
    preview: false,
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
