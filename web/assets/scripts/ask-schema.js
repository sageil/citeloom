import {
  readArray,
  readBoolean,
  readEnum,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullableNonEmptyString,
  readNullableNonNegativeInteger,
  readPlainObject as readObject,
  readPositiveInteger,
  readProbability,
  readUIMessageStream,
} from "./boundary-readers.js";
import {
  createAnswerCitationKey,
  readAnswerContentUpdate,
} from "./answer-content.js";
import {
  buildCitationPresentation,
  buildCitationPresentations,
} from "./citation-presentation.js";
import {
  readStoredAnswerVerificationClaims,
  readVerificationState,
} from "./verification.js";
import {
  readAskAnswerDocument,
  readPublishedAnswerEvidence,
  readPublishedSourceRegions,
} from "./published-answer.js";

const discoveryMatchKinds = Object.freeze(["keyword", "semantic"]);
const discoveryResultKinds = Object.freeze(["exact", "exact-and-related"]);

export function readAskAnswerSpeechTarget(answer) {
  if (answer === null) {
    return null;
  }
  return {
    answerDocument: answer.answerDocument,
    turnId: answer.turn.turnId,
  };
}
const evidenceKinds = Object.freeze(["image", "table", "text"]);
export const feedbackDimensions = Object.freeze([
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

export function readAskDashboard(value) {
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
  const claimVerifier = readObject(
    inferenceRuntime.claimVerifier,
    "claim verifier",
  );
  return {
    availableTagFacets,
    claimVerifierSupportThreshold: readProbability(
      claimVerifier.supportThreshold,
      "claim verifier support threshold",
    ),
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

export function readResearchThreadSummaries(value) {
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
    sources: buildAnswerSources(answerDocument.citations),
  };
}

function buildAnswerSources(citations) {
  const presentations = buildCitationPresentations(citations);
  const sources = [];
  for (const presentation of presentations) {
    sources.push({
      ...presentation,
      key: createAnswerCitationKey(
        presentation.documentVersionId,
        presentation.documentId,
        presentation.elementId,
      ),
      preview: false,
    });
  }
  return sources;
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
    claims: readStoredAnswerVerificationClaims(
      answer.claims,
      presentation.answerDocument,
      "claim check",
    ),
    matchedDocuments: readMatchedDocuments(answer.matchedDocuments),
    runDetails: readRunDetails(answer.runDetails),
    turn: readAnswerTurn(answer.turn),
    verificationState: readVerificationState(
      answer.verificationState,
      "answer verification state",
    ),
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
    claims: readStoredAnswerVerificationClaims(
      turn.claims,
      presentation.answerDocument,
      `${label} claim check`,
    ),
    completedAt: readNonEmptyString(turn.completedAt, `${label} completed time`),
    id: readNonEmptyString(turn.id, `${label} id`),
    question: readNonEmptyString(turn.question, `${label} question`),
    retrievedContext: readMatchedDocuments(turn.retrievedContext),
    runId: readNonEmptyString(turn.runId, `${label} run id`),
    scope: readScope(turn.scope),
    sequence: readPositiveInteger(turn.sequence, `${label} sequence`),
    threadId: readNonEmptyString(turn.threadId, `${label} thread id`),
    verificationState: readVerificationState(
      turn.verificationState,
      `${label} verification state`,
    ),
  };
}

export function readResearchThread(value) {
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
    matchKind: readEnum(
      passage.matchKind,
      discoveryMatchKinds,
      `${label} match kind`,
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

function readExactDiscoveryPage(value, label) {
  const exact = readObject(value, label);
  return {
    documents: readDiscoveryDocuments(exact.documents, `${label} documents`),
    page: readPositiveInteger(exact.page, `${label} page`),
    pageSize: readPositiveInteger(exact.pageSize, `${label} page size`),
    totalDocuments: readNonNegativeInteger(
      exact.totalDocuments,
      `${label} total`,
    ),
  };
}

function readRelatedDiscoveryResults(value) {
  const related = readObject(value, "related discovery results");
  return {
    documents: readDiscoveryDocuments(
      related.documents,
      "related discovery documents",
    ),
    limit: readPositiveInteger(related.limit, "related discovery limit"),
    matchedPassageCount: readNonNegativeInteger(
      related.matchedPassageCount,
      "related discovery matched passage count",
    ),
    reviewedPassageCount: readNonNegativeInteger(
      related.reviewedPassageCount,
      "related discovery reviewed passage count",
    ),
  };
}

export function readDiscoveryResponse(value) {
  const response = readObject(value, "source discovery");
  const results = readObject(response.results, "source discovery results");
  const kind = readEnum(
    results.kind,
    discoveryResultKinds,
    "source discovery result kind",
  );
  const query = readNonEmptyString(response.query, "source discovery query");
  if (kind === "exact") {
    const exact = readExactDiscoveryPage(results, "exact discovery");
    return {
      query,
      results: {
        ...exact,
        kind,
      },
    };
  }
  return {
    query,
    results: {
      exact: readExactDiscoveryPage(results.exact, "exact discovery"),
      kind,
      related: readRelatedDiscoveryResults(results.related),
    },
  };
}

export function readStoredCitation(value) {
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

export function buildStoredCitationPreview(source) {
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

export function readFeedbackResponse(value) {
  const response = readObject(value, "research feedback");
  return {
    negativeCount: readNonNegativeInteger(response.negativeCount, "negative feedback count"),
    positiveCount: readNonNegativeInteger(response.positiveCount, "positive feedback count"),
    rating: readFeedbackRating(response.rating),
  };
}

export function readFeedbackRating(value) {
  if (value === -1 || value === 0 || value === 1) {
    return value;
  }
  throw new Error("The current feedback rating is invalid.");
}

export function readStreamPart(part, type) {
  if (type === "data-answer") {
    return { answer: readStreamedAnswer(part.data), type };
  }
  if (type === "data-answer-content") {
    return { update: readAnswerContentUpdate(part.data), type };
  }
  return { type };
}

export function buildHistoricalAnswer(turn) {
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
    verificationState: turn.verificationState,
  };
}

export function applyResearchVerificationUpdate(answer, turn) {
  if (answer.turn.turnId !== turn.id) {
    return;
  }
  answer.verificationState = turn.verificationState;
  if (
    turn.verificationState === "completed"
    || turn.verificationState === "failed"
  ) {
    answer.claims = turn.claims;
  }
}

export function readErrorMessage(error, fallback) {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return fallback;
}

export async function readAnswerStream(response, receiveAnswer, receivePreview) {
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
