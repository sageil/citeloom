import {
  readArray,
  readBoolean,
  readEnum,
  readFiniteNumber,
  readNonEmptyString,
  readNonNegativeInteger,
  readPlainObject,
  readPositiveInteger,
  readString,
} from "./citeloom-boundaries.js";

const askAnswerSections = Object.freeze([
  "answer",
  "key-points",
  "conflicting-evidence",
  "limitations",
]);
const chatAnswerSections = Object.freeze([
  "answer",
  "conflicting-evidence",
  "key-points",
]);
const evidenceKinds = Object.freeze(["image", "table", "text"]);
const statementPresentations = Object.freeze(["bullet", "paragraph"]);

export function readAskAnswerDocument(value) {
  return readPublishedAnswerDocument(value, "ask");
}

export function readChatAnswerDocument(value) {
  return readPublishedAnswerDocument(value, "chat");
}

function readPublishedAnswerDocument(value, context) {
  const answerLabel = context === "ask" ? "answer document" : "chat answer";
  const answer = readPlainObject(value, answerLabel);
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
      context,
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
      context === "ask" ? `${label} citations` : `${label} citation IDs`,
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
        context === "ask" ? `${label} content` : "statement content",
      ),
      presentation: readEnum(
        statement.presentation,
        statementPresentations,
        context === "ask" ? `${label} presentation` : "statement presentation",
      ),
      section: readEnum(
        statement.section,
        context === "ask" ? askAnswerSections : chatAnswerSections,
        context === "ask" ? `${label} section` : "statement section",
      ),
    });
  }

  const hasCitations = citations.length > 0;
  const hasStatements = statements.length > 0;
  if (!hasCitations && hasStatements) {
    const message = context === "ask"
      ? "The answer response is incomplete."
      : "The chat answer is incomplete.";
    throw new Error(message);
  }
  if (!hasCitations) {
    return {
      citations,
      content: readNonEmptyString(answer.content, "uncited answer content"),
      schemaVersion,
      statements,
    };
  }
  if (typeof answer.content === "string") {
    return {
      citations,
      content: readNonEmptyString(answer.content, "answer content"),
      schemaVersion,
      statements,
    };
  }
  const legacyDirectAnswer = statements.shift();
  if (
    legacyDirectAnswer === undefined
    || legacyDirectAnswer.section !== "answer"
    || legacyDirectAnswer.presentation !== "paragraph"
  ) {
    throw new Error("The answer response has no direct answer content.");
  }
  return {
    citations,
    content: legacyDirectAnswer.content,
    schemaVersion,
    statements,
  };
}

function readAnswerCitation(value, label, context) {
  const citation = readPlainObject(value, label);
  const kind = readEnum(citation.kind, evidenceKinds, `${label} kind`);
  const evidence = readPublishedAnswerEvidence(
    citation.evidence,
    `${label} evidence`,
  );
  if (evidence.kind !== kind) {
    throw new Error(`The ${label} evidence kind does not match.`);
  }
  const identifierSuffix = context === "ask" ? "id" : "ID";
  return {
    citationNumber: readPositiveInteger(
      citation.citationNumber,
      `${label} number`,
    ),
    documentId: readNonEmptyString(
      citation.documentId,
      `${label} document ${identifierSuffix}`,
    ),
    documentVersionId: readNonEmptyString(
      citation.documentVersionId,
      `${label} document version ${identifierSuffix}`,
    ),
    elementId: readNonEmptyString(
      citation.elementId,
      `${label} element ${identifierSuffix}`,
    ),
    evidence,
    id: readNonEmptyString(citation.id, `${label} ${identifierSuffix}`),
    kind,
    pageNumbers: readPositiveIntegerArray(
      citation.pageNumbers,
      `${label} page numbers`,
    ),
    regions: readPublishedSourceRegions(citation.regions, `${label} regions`),
    sectionPath: readStringArray(citation.sectionPath, `${label} section path`),
    sourceFile: readNonEmptyString(citation.sourceFile, `${label} source file`),
  };
}

export function readPublishedAnswerEvidence(value, label) {
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
      table: readTableStructure(evidence.table, `${label} table structure`),
    };
  }
  return {
    kind,
    mimeType: readNonEmptyString(evidence.mimeType, `${label} media type`),
  };
}

function readTableStructure(value, label) {
  const table = readPlainObject(value, label);
  const cellValues = readArray(table.cells, `${label} cells`);
  const cells = [];
  for (let index = 0; index < cellValues.length; index += 1) {
    cells.push(readTableCell(cellValues[index], `${label} cell ${index + 1}`));
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

function readTableCell(value, label) {
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

export function readPublishedSourceRegions(value, label) {
  const values = readArray(value, label);
  const regions = [];
  for (let index = 0; index < values.length; index += 1) {
    regions.push(readSourceRegion(values[index], `${label} item ${index + 1}`));
  }
  return regions;
}

function readSourceRegion(value, label) {
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
