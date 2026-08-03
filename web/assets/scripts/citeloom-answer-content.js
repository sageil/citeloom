import {
  readArray,
  readEnum,
  readNonEmptyString,
  readNonNegativeInteger,
  readPlainObject,
} from "./citeloom-boundaries.js";

const answerSections = Object.freeze([
  "answer",
  "key-points",
  "conflicting-evidence",
]);
const statementPresentations = Object.freeze(["bullet", "paragraph"]);

export function createEmptyAnswerContent() {
  return { statements: [] };
}

export function readAnswerContentUpdate(value) {
  const update = readPlainObject(value, "streamed answer content update");
  const statementCount = readNonNegativeInteger(
    update.statementCount,
    "streamed answer statement count",
  );
  const statementValues = readArray(update.statements, "streamed answer updates");
  const statements = [];
  const indexes = new Set();
  for (let index = 0; index < statementValues.length; index += 1) {
    const label = `streamed answer update ${index + 1}`;
    const statement = readPlainObject(statementValues[index], label);
    const statementIndex = readNonNegativeInteger(
      statement.index,
      `${label} index`,
    );
    if (statementIndex >= statementCount || indexes.has(statementIndex)) {
      throw new Error(`The ${label} index is invalid.`);
    }
    indexes.add(statementIndex);
    statements.push({
      content: readNonEmptyString(statement.content, `${label} content`),
      index: statementIndex,
      mode: readEnum(statement.mode, ["append", "replace"], `${label} mode`),
      presentation: readEnum(
        statement.presentation,
        statementPresentations,
        `${label} presentation`,
      ),
      section: readEnum(
        statement.section,
        answerSections,
        `${label} section`,
      ),
    });
  }
  return { statementCount, statements };
}

export function applyAnswerContentUpdate(content, update) {
  const statements = content.statements.slice(0, update.statementCount);
  for (const statementUpdate of update.statements) {
    const previous = statements[statementUpdate.index];
    if (statementUpdate.mode === "append" && previous === undefined) {
      throw new Error("A streamed answer append has no existing statement.");
    }
    const previousContent = previous?.content ?? "";
    const statementContent = statementUpdate.mode === "append"
      ? previousContent + statementUpdate.content
      : statementUpdate.content;
    statements[statementUpdate.index] = {
      citationIds: [],
      content: statementContent,
      presentation: statementUpdate.presentation,
      section: statementUpdate.section,
    };
  }
  for (let index = 0; index < statements.length; index += 1) {
    if (statements[index] === undefined) {
      throw new Error("A streamed answer update omitted a new statement.");
    }
  }
  return { statements };
}

export function createAnswerContentFromDocument(document) {
  if (document.statements.length === 0) {
    return {
      statements: [{
        citationIds: [],
        content: document.content,
        presentation: "paragraph",
        section: "answer",
      }],
    };
  }
  return { statements: document.statements };
}

export function buildAnswerContentSections(content, citations) {
  const citationsById = new Map();
  for (const citation of citations) {
    citationsById.set(citation.id, citation);
  }
  const sections = [];
  for (const sectionKey of answerSections) {
    const statements = buildSectionStatements(
      content,
      sectionKey,
      citationsById,
    );
    if (statements.length === 0) {
      continue;
    }
    sections.push({
      blocks: buildAnswerContentBlocks(statements),
      key: sectionKey,
      title: answerSectionTitle(sectionKey),
    });
  }
  return sections;
}

function buildSectionStatements(content, sectionKey, citationsById) {
  const statements = [];
  for (let index = 0; index < content.statements.length; index += 1) {
    const statement = content.statements[index];
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
  return statements;
}

function buildAnswerContentBlocks(statements) {
  const blocks = [];
  let bulletStatements = [];
  for (const statement of statements) {
    if (statement.presentation === "bullet") {
      bulletStatements.push(statement);
      continue;
    }
    appendBulletBlock(blocks, bulletStatements);
    bulletStatements = [];
    blocks.push({
      key: `paragraph-${statement.key}`,
      kind: "paragraph",
      statements: [statement],
    });
  }
  appendBulletBlock(blocks, bulletStatements);
  return blocks;
}

function appendBulletBlock(blocks, statements) {
  const first = statements[0];
  if (first === undefined) {
    return;
  }
  blocks.push({
    key: `bullets-${first.key}`,
    kind: "bullets",
    statements,
  });
}

function answerSectionTitle(section) {
  if (section === "conflicting-evidence") {
    return "Conflicting evidence";
  }
  if (section === "key-points") {
    return "Key points";
  }
  return null;
}
