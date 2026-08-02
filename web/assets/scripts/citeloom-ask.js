import {
  readArray,
  readBoolean,
  readEnum,
  readFiniteNumber,
  readJsonResponse,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullableNonEmptyString,
  readNullableNonNegativeInteger,
  readPlainObject as readObject,
  readPositiveInteger,
  readString,
} from "./citeloom-boundaries.js";
import { dispatchNotice } from "./citeloom-notices.js";

const answerSections = Object.freeze([
  "answer",
  "key-points",
  "conflicting-evidence",
  "limitations",
]);
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
const statementPresentations = Object.freeze(["bullet", "paragraph"]);
const mediaRecorderOptions = Object.freeze([
  { extension: "webm", mimeType: "audio/webm;codecs=opus" },
  { extension: "mp4", mimeType: "audio/mp4" },
  { extension: "ogg", mimeType: "audio/ogg;codecs=opus" },
  { extension: "wav", mimeType: "audio/wav" },
]);
const evidenceInspectorResizeStep = 16;
const minimumEvidenceInspectorHeight = 260;
const minimumEvidenceInspectorWidth = 360;
const maximumRecordingDurationMs = 120_000;

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

function startVerificationFieldAnimation(canvas) {
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error("The answer loading canvas is unavailable.");
  }
  const context = canvas.getContext("2d");
  if (context === null) {
    throw new Error("The answer loading canvas could not be initialized.");
  }

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let animationFrame = null;
  let width = 1;
  let height = 1;
  let colors = readVerificationFieldColors(canvas);

  const resize = () => {
    const bounds = canvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    colors = readVerificationFieldColors(canvas);
  };

  const render = (time = 0) => {
    if (!canvas.isConnected) {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      observer.disconnect();
      reducedMotion.removeEventListener("change", renderStaticFrame);
      return;
    }
    drawVerificationField(
      context,
      width,
      height,
      colors,
      reducedMotion.matches ? 0.28 : (time % 6_000) / 6_000,
    );
    if (!reducedMotion.matches) {
      animationFrame = window.requestAnimationFrame(render);
    }
  };

  const renderStaticFrame = () => {
    if (animationFrame !== null) {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = null;
    }
    render(1_680);
  };
  const observer = new ResizeObserver(() => {
    resize();
    renderStaticFrame();
  });
  observer.observe(canvas);
  reducedMotion.addEventListener("change", renderStaticFrame);
  resize();
  render(performance.now());
}

function readVerificationFieldColors(canvas) {
  const styles = getComputedStyle(canvas);
  return {
    cyan: styles.getPropertyValue("--cyan").trim(),
    muted: styles.getPropertyValue("--muted").trim(),
    purple: styles.getPropertyValue("--purple").trim(),
    text: styles.getPropertyValue("--text").trim(),
  };
}

function drawVerificationField(context, width, height, colors, phase) {
  context.clearRect(0, 0, width, height);
  const columns = Math.max(20, Math.floor(width / 22));
  const rows = 12;
  const focusX = width * 0.64;
  const focusY = height * 0.48;
  const horizontalStep = width * 0.92 / (columns - 1);
  const verticalStep = height * 0.72 / (rows - 1);

  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const baseX = width * 0.04 + column * horizontalStep;
      const baseY = height * 0.12 + row * verticalStep;
      const distance = Math.hypot(baseX - focusX, baseY - focusY);
      const ripple = Math.sin(distance * 0.035 - phase * Math.PI * 4) * 16;
      const drift = Math.sin(column * 0.45 + phase * Math.PI * 2) * 8;
      const y = baseY + ripple + drift;
      const verified = (row * 7 + column * 3) % 29 === 0;
      context.globalAlpha = verified ? 0.9 : 0.13 + (row % 4) * 0.035;
      context.fillStyle = verified ? colors.text : colors.cyan;
      context.beginPath();
      context.arc(baseX, y, verified ? 3.2 : 1.5, 0, Math.PI * 2);
      context.fill();
    }
  }

  for (let index = 0; index < 3; index += 1) {
    const progress = (phase * 1.7 + index / 3) % 1;
    context.beginPath();
    context.arc(
      focusX,
      focusY,
      progress * Math.min(width, height) * 0.34,
      0,
      Math.PI * 2,
    );
    context.globalAlpha = (1 - progress) * 0.28;
    context.strokeStyle = colors.cyan;
    context.lineWidth = 1;
    context.stroke();
  }

  context.globalAlpha = 1;
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

function readSourceRegion(value, label) {
  const region = readObject(value, label);
  const boundingBox = readObject(
    region.boundingBox,
    `${label} bounding box`,
  );
  const characterSpan = readObject(
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

function readSourceRegions(value, label) {
  const values = readArray(value, label);
  const regions = [];
  for (let index = 0; index < values.length; index += 1) {
    regions.push(readSourceRegion(values[index], `${label} item ${index + 1}`));
  }
  return regions;
}

function readTableCell(value, label) {
  const cell = readObject(value, label);
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

function tryBuildCitationTableRows(cells, rowCount, columnCount) {
  const rows = [];
  const occupiedColumnsByRow = [];
  let headerRowEnd = 0;
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    rows.push({ cells: [], key: `row-${rowIndex}` });
    occupiedColumnsByRow.push(
      Array.from({ length: columnCount }, () => false),
    );
  }
  for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
    const cell = cells[cellIndex];
    if (
      cell.endColumn > columnCount
      || cell.endRow > rowCount
      || cell.endColumn - cell.startColumn !== cell.columnSpan
      || cell.endRow - cell.startRow !== cell.rowSpan
    ) {
      return null;
    }
    for (let rowIndex = cell.startRow; rowIndex < cell.endRow; rowIndex += 1) {
      const occupiedColumns = occupiedColumnsByRow[rowIndex];
      if (occupiedColumns === undefined) {
        return null;
      }
      for (
        let columnIndex = cell.startColumn;
        columnIndex < cell.endColumn;
        columnIndex += 1
      ) {
        if (occupiedColumns[columnIndex] !== false) {
          return null;
        }
        occupiedColumns[columnIndex] = true;
      }
    }
    const row = rows[cell.startRow];
    if (row === undefined) {
      return null;
    }
    row.cells.push({
      columnSpan: cell.columnSpan,
      key: `cell-${cell.startRow}-${cell.startColumn}`,
      rowHeader: cell.rowHeader || cell.rowSection,
      rowSpan: cell.rowSpan,
      startColumn: cell.startColumn,
      text: cell.text,
    });
    if (cell.columnHeader) {
      headerRowEnd = Math.max(headerRowEnd, cell.endRow);
    }
  }
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const occupiedColumns = occupiedColumnsByRow[rowIndex];
    if (row === undefined || occupiedColumns === undefined) {
      return null;
    }
    for (
      let columnIndex = 0;
      columnIndex < occupiedColumns.length;
      columnIndex += 1
    ) {
      if (occupiedColumns[columnIndex] === false) {
        row.cells.push({
          columnSpan: 1,
          key: `placeholder-${rowIndex}-${columnIndex}`,
          rowHeader: false,
          rowSpan: 1,
          startColumn: columnIndex,
          text: "",
        });
      }
    }
    row.cells.sort((left, right) => left.startColumn - right.startColumn);
  }
  return {
    bodyRows: rows.slice(headerRowEnd),
    headerRows: rows.slice(0, headerRowEnd),
  };
}

function readTableStructure(value, label) {
  const table = readObject(value, label);
  const cellValues = readArray(table.cells, `${label} cells`);
  const cells = [];
  for (let index = 0; index < cellValues.length; index += 1) {
    cells.push(readTableCell(cellValues[index], `${label} cell ${index + 1}`));
  }
  const columnCount = readPositiveInteger(
    table.columnCount,
    `${label} column count`,
  );
  const rowCount = readPositiveInteger(table.rowCount, `${label} row count`);
  return {
    cells,
    columnCount,
    rowCount,
    rowEnd: readPositiveInteger(table.rowEnd, `${label} row end`),
    rowStart: readNonNegativeInteger(table.rowStart, `${label} row start`),
  };
}

function buildCitationPresentation(citation) {
  if (citation.evidence.kind !== "table") {
    return citation;
  }
  const table = citation.evidence.table;
  const rows = tryBuildCitationTableRows(
    table.cells,
    table.rowCount,
    table.columnCount,
  );
  let bodyRows = [];
  let headerRows = [];
  let renderMode = "text";
  if (rows !== null) {
    bodyRows = rows.bodyRows;
    headerRows = rows.headerRows;
    renderMode = "grid";
  }
  return {
    ...citation,
    evidence: {
      ...citation.evidence,
      table: {
        ...table,
        bodyRows,
        headerRows,
        renderMode,
      },
    },
  };
}

function buildCitationPresentations(citations) {
  const presentations = [];
  for (let index = 0; index < citations.length; index += 1) {
    presentations.push(buildCitationPresentation(citations[index]));
  }
  return presentations;
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

function readEvidence(value, label) {
  const evidence = readObject(value, label);
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
      table: readTableStructure(evidence.table, `${label} table structure`),
    };
  }
  return {
    kind,
    mimeType: readNonEmptyString(evidence.mimeType, `${label} media type`),
  };
}

function readAnswerCitation(value, label) {
  const citation = readObject(value, label);
  const kind = readEnum(citation.kind, evidenceKinds, `${label} kind`);
  const evidence = readEvidence(citation.evidence, `${label} evidence`);
  if (evidence.kind !== kind) {
    throw new Error(`The ${label} evidence kind does not match.`);
  }
  const regions = readSourceRegions(citation.regions, `${label} regions`);
  return {
    citationNumber: readPositiveInteger(
      citation.citationNumber,
      `${label} number`,
    ),
    documentId: readNonEmptyString(citation.documentId, `${label} document id`),
    documentVersionId: readNonEmptyString(
      citation.documentVersionId,
      `${label} document version id`,
    ),
    elementId: readNonEmptyString(citation.elementId, `${label} element id`),
    evidence,
    id: readNonEmptyString(citation.id, `${label} id`),
    kind,
    pageNumbers: readPositiveIntegerArray(
      citation.pageNumbers,
      `${label} page numbers`,
    ),
    regions,
    sectionPath: readStringArray(citation.sectionPath, `${label} section path`),
    sourceFile: readNonEmptyString(citation.sourceFile, `${label} source file`),
  };
}

function readAnswerDocument(value) {
  const document = readObject(value, "answer document");
  const schemaVersion = readPositiveInteger(
    document.schemaVersion,
    "answer schema version",
  );
  if (schemaVersion !== 1) {
    throw new Error("The answer schema version is unsupported.");
  }
  const citationValues = readArray(document.citations, "answer citations");
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
  const statementValues = readArray(document.statements, "answer statements");
  const statements = [];
  for (let index = 0; index < statementValues.length; index += 1) {
    const statement = readObject(
      statementValues[index],
      `answer statement ${index + 1}`,
    );
    const statementCitationIds = readStringArray(
      statement.citationIds,
      `answer statement ${index + 1} citations`,
    );
    for (const citationId of statementCitationIds) {
      if (!citationIds.has(citationId)) {
        throw new Error("The answer references an unavailable citation.");
      }
    }
    statements.push({
      citationIds: statementCitationIds,
      content: readNonEmptyString(
        statement.content,
        `answer statement ${index + 1} content`,
      ),
      presentation: readEnum(
        statement.presentation,
        statementPresentations,
        `answer statement ${index + 1} presentation`,
      ),
      section: readEnum(
        statement.section,
        answerSections,
        `answer statement ${index + 1} section`,
      ),
    });
  }
  const hasCitations = citations.length > 0;
  const hasStatements = statements.length > 0;
  if (hasCitations !== hasStatements) {
    throw new Error("The answer response is incomplete.");
  }
  if (!hasCitations) {
    return {
      citations,
      content: readNonEmptyString(document.content, "uncited answer content"),
      schemaVersion,
      statements,
    };
  }
  return { citations, schemaVersion, statements };
}

export function readAnswerPresentation(value) {
  const answerDocument = readAnswerDocument(value);
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
  const evidence = readEvidence(citation.evidence, "stored citation evidence");
  const regions = readSourceRegions(citation.regions, "stored citation regions");
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

function readTranscription(value) {
  const response = readObject(value, "transcription");
  return {
    text: readNonEmptyString(response.text, "transcription text"),
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

function readStreamPart(value) {
  const part = readObject(value, "answer stream part");
  const type = readNonEmptyString(part.type, "answer stream part type");
  if (type === "data-answer") {
    return { answer: readStreamedAnswer(part.data), type };
  }
  if (type === "error") {
    return {
      errorText: readNonEmptyString(part.errorText, "answer stream error"),
      type,
    };
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

async function readAnswerStream(response, receiveAnswer) {
  if (!response.ok) {
    await readJsonResponse(response, "Question request");
    return;
  }
  if (response.body === null) {
    throw new Error("The question response did not contain an answer stream.");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let answerReceived = false;
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const part = readAnswerStreamLine(line);
      if (part === null) {
        continue;
      }
      if (part.type === "error") {
        throw new Error(part.errorText);
      }
      if (part.type === "data-answer") {
        answerReceived = true;
        receiveAnswer(part.answer);
      }
    }
    if (chunk.done) {
      break;
    }
  }
  const finalPart = readAnswerStreamLine(buffer);
  if (finalPart?.type === "error") {
    throw new Error(finalPart.errorText);
  }
  if (finalPart?.type === "data-answer") {
    answerReceived = true;
    receiveAnswer(finalPart.answer);
  }
  if (!answerReceived) {
    throw new Error("The answer stream ended without a verified answer.");
  }
}

function readAnswerStreamLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return null;
  }
  const data = trimmed.slice(5).trim();
  if (data === "" || data === "[DONE]") {
    return null;
  }
  let value;
  try {
    value = JSON.parse(data);
  } catch {
    throw new Error("The answer stream contained invalid JSON.");
  }
  return readStreamPart(value);
}

function selectMediaRecorderOption() {
  if (
    typeof MediaRecorder !== "function"
    || typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return null;
  }
  for (const option of mediaRecorderOptions) {
    if (MediaRecorder.isTypeSupported(option.mimeType)) {
      return option;
    }
  }
  return null;
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
    feedback: { answer: 0, citation: 0, retrieval: 0 },
    feedbackCounts: {
      answer: { negative: 0, positive: 0 },
      citation: { negative: 0, positive: 0 },
      retrieval: { negative: 0, positive: 0 },
    },
    includeRelated: false,
    inferenceRuntimeName: "the configured inference runtime",
    inspectedCitation: null,
    mediaRecorder: null,
    mediaRecorderChunks: [],
    mediaRecorderOption: null,
    mediaStream: null,
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
    recordingGeneration: 0,
    recordingTimerId: null,
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
    speechStatus: "Voice input is ready. Audio is sent to the configured transcription provider.",
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
    transcriptionAbortController: null,
    turnId: "",

    async initialize() {
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
      this.cancelDictation();
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
        await readAnswerStream(response, (answer) => {
          if (!controller.signal.aborted) {
            this.answer = answer;
          }
        });
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
      }
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
        const response = await fetch("/api/speech", {
          body: JSON.stringify({ answerDocument: this.answer.answerDocument }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: controller.signal,
        });
        if (!response.ok) {
          await readJsonResponse(response, "Answer speech request");
        }
        const contentType = response.headers.get("content-type") ?? "";
        if (!contentType.toLowerCase().startsWith("audio/")) {
          throw new Error("The speech response was not audio.");
        }
        const audio = await response.blob();
        if (audio.size === 0) {
          throw new Error("The speech response was empty.");
        }
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

    async startDictation() {
      const option = selectMediaRecorderOption();
      if (option === null || navigator.mediaDevices?.getUserMedia === undefined) {
        this.speechState = "error";
        this.speechStatus = "Voice input is not supported by this browser.";
        return;
      }
      this.cancelDictation();
      const generation = this.recordingGeneration + 1;
      this.recordingGeneration = generation;
      this.speechState = "requesting";
      this.speechStatus = "Waiting for microphone permission.";
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (this.recordingGeneration !== generation) {
          for (const track of stream.getTracks()) {
            track.stop();
          }
          return;
        }
        const recorder = new MediaRecorder(stream, { mimeType: option.mimeType });
        this.mediaRecorder = recorder;
        this.mediaRecorderChunks = [];
        this.mediaRecorderOption = option;
        this.mediaStream = stream;
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size > 0) {
            this.mediaRecorderChunks.push(event.data);
          }
        });
        recorder.addEventListener("stop", () => {
          void this.transcribeRecording(generation);
        }, { once: true });
        recorder.start(250);
        this.speechState = "recording";
        this.speechStatus = "Recording. Select Stop when you finish speaking.";
        this.recordingTimerId = window.setTimeout(() => {
          this.stopDictation();
        }, maximumRecordingDurationMs);
      } catch (error) {
        this.releaseMediaStream();
        this.speechState = "error";
        this.speechStatus = readErrorMessage(
          error,
          "Microphone access was not available.",
        );
      }
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
      if (this.mediaRecorder?.state === "recording") {
        this.speechState = "transcribing";
        this.speechStatus = "Transcribing the recording.";
        this.mediaRecorder.stop();
      }
    },

    cancelDictation() {
      this.recordingGeneration += 1;
      this.transcriptionAbortController?.abort();
      this.transcriptionAbortController = null;
      if (this.recordingTimerId !== null) {
        window.clearTimeout(this.recordingTimerId);
        this.recordingTimerId = null;
      }
      if (this.mediaRecorder?.state === "recording") {
        this.mediaRecorder.onstop = null;
        this.mediaRecorder.stop();
      }
      this.mediaRecorder = null;
      this.mediaRecorderChunks = [];
      this.mediaRecorderOption = null;
      this.releaseMediaStream();
      this.speechState = "idle";
      this.speechStatus = "Voice input is ready. Audio is sent to the configured transcription provider.";
    },

    releaseMediaStream() {
      if (this.mediaStream !== null) {
        for (const track of this.mediaStream.getTracks()) {
          track.stop();
        }
      }
      this.mediaStream = null;
    },

    async transcribeRecording(generation) {
      if (this.recordingTimerId !== null) {
        window.clearTimeout(this.recordingTimerId);
        this.recordingTimerId = null;
      }
      this.releaseMediaStream();
      const option = this.mediaRecorderOption;
      const chunks = this.mediaRecorderChunks;
      this.mediaRecorder = null;
      this.mediaRecorderChunks = [];
      this.mediaRecorderOption = null;
      if (this.recordingGeneration !== generation || option === null) {
        return;
      }
      const controller = new AbortController();
      this.transcriptionAbortController = controller;
      try {
        const audio = new Blob(chunks, { type: option.mimeType });
        const body = new FormData();
        body.append("file", audio, `recording.${option.extension}`);
        const response = await fetch("/api/transcriptions", {
          body,
          method: "POST",
          signal: controller.signal,
        });
        const transcription = await readJsonResponse(
          response,
          "Transcription request",
          readTranscription,
        );
        if (controller.signal.aborted || this.recordingGeneration !== generation) {
          return;
        }
        this.insertTranscript(transcription.text);
        this.speechState = "idle";
        this.speechStatus = "Transcript added to the draft. Review it before submitting.";
      } catch (error) {
        if (!controller.signal.aborted && this.recordingGeneration === generation) {
          this.speechState = "error";
          this.speechStatus = readErrorMessage(
            error,
            "The recording could not be transcribed.",
          );
        }
      } finally {
        if (this.transcriptionAbortController === controller) {
          this.transcriptionAbortController = null;
        }
      }
    },

    insertTranscript(transcript) {
      const input = this.$refs.questionInput;
      const start = input?.selectionStart ?? this.question.length;
      const end = input?.selectionEnd ?? this.question.length;
      const prefix = this.question.slice(0, start);
      const suffix = this.question.slice(end);
      const needsLeadingSpace = prefix !== "" && !/\s$/u.test(prefix);
      const needsTrailingSpace = suffix !== "" && !/^\s/u.test(suffix);
      const insertion = `${needsLeadingSpace ? " " : ""}${transcript}${needsTrailingSpace ? " " : ""}`;
      this.question = `${prefix}${insertion}${suffix}`;
      const cursor = prefix.length + insertion.length;
      this.$nextTick(() => {
        input?.focus();
        input?.setSelectionRange(cursor, cursor);
      });
    },

    answerSections() {
      if (
        this.answer === null
        || this.answer.answerDocument.statements.length === 0
      ) {
        return [];
      }
      const citationsById = new Map();
      for (const citation of this.answer.sources) {
        citationsById.set(citation.id, citation);
      }
      const sections = [];
      for (const sectionKey of answerSections) {
        const statements = [];
        for (let index = 0; index < this.answer.answerDocument.statements.length; index += 1) {
          const statement = this.answer.answerDocument.statements[index];
          if (statement.section !== sectionKey) {
            continue;
          }
          const citations = [];
          for (const citationId of statement.citationIds) {
            const citation = citationsById.get(citationId);
            if (citation !== undefined) {
              citations.push(citation);
            }
          }
          statements.push({
            citations,
            content: statement.content,
            key: `${sectionKey}-${index}`,
            presentation: statement.presentation,
          });
        }
        if (statements.length === 0) {
          continue;
        }
        const blocks = [];
        let bulletStatements = [];
        for (const statement of statements) {
          if (statement.presentation === "bullet") {
            bulletStatements.push(statement);
            continue;
          }
          if (bulletStatements.length > 0) {
            blocks.push({
              key: `bullets-${bulletStatements[0].key}`,
              kind: "bullets",
              statements: bulletStatements,
            });
            bulletStatements = [];
          }
          blocks.push({
            key: `paragraph-${statement.key}`,
            kind: "paragraph",
            statements: [statement],
          });
        }
        if (bulletStatements.length > 0) {
          blocks.push({
            key: `bullets-${bulletStatements[0].key}`,
            kind: "bullets",
            statements: bulletStatements,
          });
        }
        let title = null;
        if (sectionKey === "conflicting-evidence") {
          title = "Conflicting evidence";
        } else if (sectionKey === "key-points") {
          title = "Key points";
        } else if (sectionKey === "limitations") {
          title = "Limitations";
        }
        sections.push({ blocks, key: sectionKey, title });
      }
      return sections;
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

    startAnswerLoadingAnimation(canvas) {
      startVerificationFieldAnimation(canvas);
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

    selectedCitationStatus() {
      if (this.selectedCitation === null) {
        return "unverified";
      }
      return this.answerCitationStatus(this.selectedCitation.citationNumber);
    },

    claimStatusLabel(status) {
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
      const pageNumber = source.pageNumbers[0];
      if (pageNumber === undefined || !source.sourceFile.toLowerCase().endsWith(".pdf")) {
        return url;
      }
      return `${url}#page=${pageNumber}`;
    },

    discoverySourceUrl(document, passage) {
      const url = this.documentFileUrl(document.documentId, document.sourceFile);
      const pageNumber = passage.pageNumbers[0];
      if (pageNumber === undefined || !document.sourceFile.toLowerCase().endsWith(".pdf")) {
        return url;
      }
      return `${url}#page=${pageNumber}`;
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
        const pageNumber = this.inspectedCitation.pageNumbers[0] ?? 1;
        return `/api/citations/${citationId}/highlighted-file#page=${pageNumber}`;
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
