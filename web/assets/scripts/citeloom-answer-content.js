import {
  readArray,
  readEnum,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullablePositiveInteger,
  readPlainObject,
  readPositiveInteger,
} from "./citeloom-boundaries.js";

const answerSections = Object.freeze([
  "answer",
  "key-points",
  "conflicting-evidence",
]);
const statementPresentations = Object.freeze(["bullet", "paragraph"]);
const answerMarkdownAllowedAttributes = Object.freeze([
  "align",
  "checked",
  "class",
  "disabled",
  "href",
  "start",
  "title",
  "type",
]);
const answerMarkdownAllowedTags = Object.freeze([
  "a",
  "blockquote",
  "br",
  "code",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "span",
  "strong",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

let answerMarkdownRuntime = null;

export function createEmptyAnswerContent() {
  return { citations: [], statements: [] };
}

export function createAnswerCitationKey(
  documentVersionId,
  documentId,
  elementId,
) {
  return JSON.stringify([documentVersionId, documentId, elementId]);
}

export function renderAnswerMarkdown(content) {
  const fallbackHtml = renderAnswerPlainText(content);
  try {
    const runtime = readAnswerMarkdownRuntime();
    if (runtime === null) {
      return fallbackHtml;
    }
    const renderedHtml = readMarkdownHtml(
      runtime.parse(content),
      "rendered Markdown",
    );
    return readMarkdownHtml(
      runtime.sanitize(renderedHtml),
      "sanitized Markdown",
    );
  } catch {
    return fallbackHtml;
  }
}

export function readAnswerContentUpdate(value) {
  const update = readPlainObject(value, "streamed answer content update");
  const citationValues = readArray(
    update.citations,
    "streamed answer citation previews",
  );
  const citations = [];
  const availableCitationKeys = new Set();
  for (let index = 0; index < citationValues.length; index += 1) {
    const label = `streamed answer citation preview ${index + 1}`;
    const citation = readPlainObject(citationValues[index], label);
    const key = readNonEmptyString(citation.key, `${label} key`);
    if (availableCitationKeys.has(key)) {
      throw new Error(`${label} duplicates citation key ${key}.`);
    }
    const pageNumberValues = readArray(
      citation.pageNumbers,
      `${label} page numbers`,
    );
    const pageNumbers = [];
    for (const pageNumber of pageNumberValues) {
      pageNumbers.push(readPositiveInteger(pageNumber, `${label} page number`));
    }
    availableCitationKeys.add(key);
    citations.push({
      citationNumber: readNullablePositiveInteger(
        citation.citationNumber,
        `${label} number`,
      ),
      key,
      pageNumbers,
      sourceFile: readNonEmptyString(citation.sourceFile, `${label} source file`),
    });
  }
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
    const citationKeyValues = readArray(
      statement.citationKeys,
      `${label} citation keys`,
    );
    const citationKeys = [];
    const seenCitationKeys = new Set();
    for (const citationKeyValue of citationKeyValues) {
      const citationKey = readNonEmptyString(
        citationKeyValue,
        `${label} citation key`,
      );
      if (
        seenCitationKeys.has(citationKey)
        || !availableCitationKeys.has(citationKey)
      ) {
        throw new Error(`${label} has an invalid citation key.`);
      }
      seenCitationKeys.add(citationKey);
      citationKeys.push(citationKey);
    }
    const mode = readEnum(
      statement.mode,
      ["append", "metadata", "replace"],
      `${label} mode`,
    );
    indexes.add(statementIndex);
    if (mode === "metadata") {
      statements.push({ citationKeys, index: statementIndex, mode });
      continue;
    }
    statements.push({
      citationKeys,
      content: readNonEmptyString(statement.content, `${label} content`),
      index: statementIndex,
      mode,
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
  return { citations, statementCount, statements };
}

export function applyAnswerContentUpdate(content, update) {
  const statements = content.statements.slice(0, update.statementCount);
  for (const statementUpdate of update.statements) {
    const previous = statements[statementUpdate.index];
    if (statementUpdate.mode === "metadata") {
      if (previous === undefined) {
        throw new Error("A streamed answer metadata update has no existing statement.");
      }
      statements[statementUpdate.index] = {
        ...previous,
        citationKeys: [...statementUpdate.citationKeys],
      };
      continue;
    }
    if (statementUpdate.mode === "append" && previous === undefined) {
      throw new Error("A streamed answer append has no existing statement.");
    }
    const previousContent = previous?.content ?? "";
    const statementContent = statementUpdate.mode === "append"
      ? previousContent + statementUpdate.content
      : statementUpdate.content;
    statements[statementUpdate.index] = {
      citationIds: [],
      citationKeys: [...statementUpdate.citationKeys],
      content: statementContent,
      contentHtml: renderAnswerMarkdown(statementContent),
      presentation: statementUpdate.presentation,
      section: statementUpdate.section,
      verificationIndex: null,
    };
  }
  for (let index = 0; index < statements.length; index += 1) {
    if (statements[index] === undefined) {
      throw new Error("A streamed answer update omitted a new statement.");
    }
  }
  const citations = update.citations.map((citation) => ({
    citationNumber: citation.citationNumber,
    key: citation.key,
    pageNumbers: [...citation.pageNumbers],
    preview: true,
    sourceFile: citation.sourceFile,
  }));
  return { citations, statements };
}

export function createAnswerContentFromDocument(document) {
  const citationKeyById = new Map();
  const citations = [];
  for (const citation of document.citations) {
    const key = createAnswerCitationKey(
      citation.documentVersionId,
      citation.documentId,
      citation.elementId,
    );
    citationKeyById.set(citation.id, key);
    citations.push({
      citationNumber: citation.citationNumber,
      key,
      pageNumbers: [...citation.pageNumbers],
      preview: true,
      sourceFile: citation.sourceFile,
    });
  }
  const statements = [{
    citationIds: [],
    citationKeys: [],
    content: document.content,
    contentHtml: renderAnswerMarkdown(document.content),
    presentation: "paragraph",
    section: "answer",
    verificationIndex: null,
  }];
  for (let statementIndex = 0; statementIndex < document.statements.length; statementIndex += 1) {
    const statement = document.statements[statementIndex];
    if (statement === undefined) {
      continue;
    }
    const citationKeys = [];
    for (const citationId of statement.citationIds) {
      const citationKey = citationKeyById.get(citationId);
      if (citationKey === undefined) {
        throw new Error(`Answer statement citation ${citationId} is unavailable.`);
      }
      citationKeys.push(citationKey);
    }
    statements.push({
      citationIds: statement.citationIds,
      citationKeys,
      content: statement.content,
      contentHtml: renderAnswerMarkdown(statement.content),
      presentation: statement.presentation,
      section: statement.section,
      verificationIndex: statementIndex,
    });
  }
  return { citations, statements };
}

export function linkAnswerContentCitations(content, sources) {
  const sourcesByKey = new Map();
  for (const source of sources) {
    if (sourcesByKey.has(source.key)) {
      throw new Error(`Completed answer citation ${source.key} is duplicated.`);
    }
    sourcesByKey.set(source.key, source);
  }
  const linkedSources = [];
  for (const citation of content.citations) {
    const source = sourcesByKey.get(citation.key);
    if (source === undefined) {
      throw new Error(`Completed answer citation ${citation.key} is unavailable.`);
    }
    linkedSources.push({ citation, source });
  }
  for (const { citation, source } of linkedSources) {
    Object.assign(citation, source, {
      key: citation.key,
      preview: false,
    });
  }
}

export function linkAnswerContentVerification(content, sections, document) {
  const expectedStatementCount = document.statements.length + 1;
  if (content.statements.length !== expectedStatementCount) {
    throw new Error("The streamed and completed answer statements do not match.");
  }
  const answerStatement = content.statements[0];
  if (
    answerStatement === undefined
    || answerStatement.content !== document.content
    || answerStatement.section !== "answer"
  ) {
    throw new Error("The streamed and completed direct answers do not match.");
  }
  for (let index = 0; index < document.statements.length; index += 1) {
    const streamedStatement = content.statements[index + 1];
    const completedStatement = document.statements[index];
    if (
      streamedStatement === undefined
      || completedStatement === undefined
      || streamedStatement.content !== completedStatement.content
      || streamedStatement.presentation !== completedStatement.presentation
      || streamedStatement.section !== completedStatement.section
    ) {
      throw new Error("The streamed and completed answer findings do not match.");
    }
  }
  const presentationStatementsByKey = new Map();
  for (const section of sections) {
    for (const block of section.blocks) {
      for (const statement of block.statements) {
        presentationStatementsByKey.set(statement.key, statement);
      }
    }
  }
  const presentationStatements = [];
  for (let index = 0; index < document.statements.length; index += 1) {
    const completedStatement = document.statements[index];
    if (completedStatement === undefined) {
      throw new Error("The completed answer finding is unavailable.");
    }
    const key = `${completedStatement.section}-${index + 1}`;
    const presentationStatement = presentationStatementsByKey.get(key);
    if (presentationStatement === undefined) {
      throw new Error("The rendered and completed answer findings do not match.");
    }
    presentationStatements.push(presentationStatement);
  }
  for (let index = 0; index < document.statements.length; index += 1) {
    const streamedStatement = content.statements[index + 1];
    const presentationStatement = presentationStatements[index];
    if (streamedStatement !== undefined) {
      streamedStatement.verificationIndex = index;
    }
    if (presentationStatement !== undefined) {
      presentationStatement.verificationIndex = index;
    }
  }
}

export function buildAnswerContentSections(content) {
  const citationsByKey = new Map();
  for (const citation of content.citations) {
    citationsByKey.set(citation.key, citation);
  }
  const sections = [];
  for (const sectionKey of answerSections) {
    const statements = buildSectionStatements(
      content,
      sectionKey,
      citationsByKey,
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

function buildSectionStatements(content, sectionKey, citationsByKey) {
  const statements = [];
  for (let index = 0; index < content.statements.length; index += 1) {
    const statement = content.statements[index];
    if (statement.section !== sectionKey) {
      continue;
    }
    const citations = [];
    for (const citationKey of statement.citationKeys) {
      const citation = citationsByKey.get(citationKey);
      if (citation !== undefined) {
        citations.push(citation);
      }
    }
    statements.push({
      citations,
      content: statement.content,
      contentHtml: renderAnswerMarkdown(statement.content),
      key: `${sectionKey}-${index}`,
      presentation: statement.presentation,
      verificationIndex: statement.verificationIndex,
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

function readAnswerMarkdownRuntime() {
  if (answerMarkdownRuntime !== null) {
    return answerMarkdownRuntime;
  }
  const markedNamespace = globalThis.marked;
  const sanitizer = globalThis.DOMPurify;
  if (
    !isObjectOrFunction(markedNamespace)
    || !isObjectOrFunction(sanitizer)
  ) {
    return null;
  }
  const parse = Reflect.get(markedNamespace, "parse");
  const Renderer = Reflect.get(markedNamespace, "Renderer");
  const sanitize = Reflect.get(sanitizer, "sanitize");
  if (
    typeof parse !== "function"
    || typeof Renderer !== "function"
    || typeof sanitize !== "function"
  ) {
    return null;
  }
  const renderer = new Renderer();
  renderer.html = (token) => {
    return escapeAnswerHtml(readMarkdownTokenText(token));
  };
  renderer.image = (token) => {
    const alternativeText = readMarkdownTokenText(token).trim();
    const label = alternativeText === ""
      ? "Image"
      : `Image: ${alternativeText}`;
    return `<span class="answer-markdown-image-reference">${escapeAnswerHtml(label)}</span>`;
  };
  answerMarkdownRuntime = {
    parse(content) {
      return parse.call(markedNamespace, content, {
        async: false,
        gfm: true,
        renderer,
      });
    },
    sanitize(html) {
      return sanitize.call(sanitizer, html, {
        ALLOWED_ATTR: answerMarkdownAllowedAttributes,
        ALLOWED_TAGS: answerMarkdownAllowedTags,
        ALLOW_DATA_ATTR: false,
        ALLOW_UNKNOWN_PROTOCOLS: false,
      });
    },
  };
  return answerMarkdownRuntime;
}

function readMarkdownTokenText(value) {
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const text = Reflect.get(value, "text");
  return typeof text === "string" ? text : "";
}

function readMarkdownHtml(value, label) {
  if (typeof value !== "string") {
    throw new Error(`The ${label} is invalid.`);
  }
  return value;
}

function isObjectOrFunction(value) {
  return (
    (typeof value === "object" && value !== null)
    || typeof value === "function"
  );
}

function renderAnswerPlainText(content) {
  const escapedContent = escapeAnswerHtml(content);
  const contentWithBreaks = escapedContent.replace(/\r\n?|\n/gu, "<br>");
  return `<p>${contentWithBreaks}</p>`;
}

function escapeAnswerHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
