import { createHash } from "node:crypto";

import type {
  SourceElement,
  TableElement,
} from "../domain/source-elements.js";
import {
  formatDocumentEmbeddingText,
  type EmbeddingInputFormatContract,
} from "../embedding/input-format.js";
import { countEmbeddingInputTokens } from "../embedding/token-counter.js";
import type {
  RetrievalWindowPolicyContract,
} from "./window-policy.js";

export interface RetrievalTableWindow {
  headerHash: string;
  rowEnd: number;
  rowStart: number;
}

export interface RetrievalWindow {
  content: string;
  contentCharacterCount: number;
  contentHash: string;
  documentId: string;
  effectiveInputTokens: number;
  id: string;
  kind: SourceElement["kind"];
  nextWindowId: string | null;
  ordinal: number;
  pageNumber: number | null;
  parentId: string;
  policyFingerprint: string;
  policyId: string;
  previousWindowId: string | null;
  sourceFile: string;
  table: RetrievalTableWindow | null;
}

export interface RetrievalWindowConstructionConfig {
  embeddingInputFormat: EmbeddingInputFormatContract;
  policy: RetrievalWindowPolicyContract;
}

interface WindowContent {
  content: string;
  table: RetrievalTableWindow | null;
}

interface StructuredTextUnit {
  content: string;
  joiner: string;
}

export function createRetrievalWindows(
  elements: readonly SourceElement[],
  config: RetrievalWindowConstructionConfig,
): RetrievalWindow[] {
  const windows: RetrievalWindow[] = [];
  for (const element of elements) {
    const contents = createElementWindowContents(element, config);
    const elementWindows: RetrievalWindow[] = [];
    for (let ordinal = 0; ordinal < contents.length; ordinal += 1) {
      const windowContent = contents[ordinal];
      if (windowContent === undefined || windowContent.content === "") {
        continue;
      }
      elementWindows.push(
        createRetrievalWindow(element, windowContent, ordinal, config),
      );
    }
    windows.push(...linkNeighboringWindows(elementWindows));
  }
  return windows;
}

export function buildRetrievalWindowEmbeddingText(
  window: RetrievalWindow,
  element: SourceElement,
): string {
  if (window.parentId !== element.id) {
    throw new Error(`Retrieval window ${window.id} has the wrong parent element.`);
  }
  return buildRetrievalElementEmbeddingText(window.content, element);
}

export function buildRetrievalElementEmbeddingText(
  content: string,
  element: SourceElement,
): string {
  const parts: string[] = [];
  if (element.sectionPath.length > 0) {
    parts.push(`Section: ${element.sectionPath.join(" > ")}`);
  }
  parts.push(content);
  return parts.join("\n");
}

export function buildRetrievalWindowProviderInput(
  window: RetrievalWindow,
  element: SourceElement,
  inputFormat: EmbeddingInputFormatContract,
): string {
  const embeddingText = buildRetrievalWindowEmbeddingText(window, element);
  return formatDocumentEmbeddingText(inputFormat, embeddingText);
}

export function countRetrievalEmbeddingInputTokens(
  content: string,
  element: SourceElement,
  inputFormat: EmbeddingInputFormatContract,
): number {
  const embeddingText = buildRetrievalElementEmbeddingText(content, element);
  const providerInput = formatDocumentEmbeddingText(inputFormat, embeddingText);
  return countEmbeddingInputTokens(providerInput);
}

export function splitRetrievalContentAtTokenLimit(
  content: string,
  element: SourceElement,
  inputFormat: EmbeddingInputFormatContract,
  maximumInputTokens: number,
): string[] {
  if (!Number.isInteger(maximumInputTokens) || maximumInputTokens < 1) {
    throw new Error("The embedding input limit must be a positive integer.");
  }
  const countTokens = (candidate: string): number => (
    countRetrievalEmbeddingInputTokens(candidate, element, inputFormat)
  );
  const units = readStructuredTextUnits(
    content,
    maximumInputTokens,
    maximumInputTokens,
    countTokens,
    element,
  );
  return groupStructuredTextUnits(units, maximumInputTokens, countTokens)
    .map((window) => window.content);
}

function createElementWindowContents(
  element: SourceElement,
  config: RetrievalWindowConstructionConfig,
): WindowContent[] {
  if (element.kind === "image") {
    return [];
  }
  if (element.kind === "table") {
    return splitStructuredTableContent(element, config);
  }
  return splitStructuredTextContent(element.content, element, config);
}

function createRetrievalWindow(
  element: SourceElement,
  windowContent: WindowContent,
  ordinal: number,
  config: RetrievalWindowConstructionConfig,
): RetrievalWindow {
  const contentHash = createHash("sha256")
    .update(windowContent.content)
    .digest("hex");
  const effectiveInputTokens = countRetrievalEmbeddingInputTokens(
    windowContent.content,
    element,
    config.embeddingInputFormat,
  );
  const policy = config.policy.policy;
  if (effectiveInputTokens > policy.maximumInputTokens) {
    throw new Error(
      `Retrieval window ${ordinal} for ${element.id} exceeds `
      + `${policy.maximumInputTokens} embedding input tokens.`,
    );
  }
  return {
    content: windowContent.content,
    contentCharacterCount: windowContent.content.length,
    contentHash,
    documentId: element.documentId,
    effectiveInputTokens,
    id: createRetrievalWindowId(
      element,
      ordinal,
      windowContent.content,
      config.policy,
    ),
    kind: element.kind,
    nextWindowId: null,
    ordinal,
    pageNumber: element.pageNumber,
    parentId: element.id,
    policyFingerprint: config.policy.fingerprint,
    policyId: policy.id,
    previousWindowId: null,
    sourceFile: element.sourceFile,
    table: windowContent.table,
  };
}

function linkNeighboringWindows(
  windows: readonly RetrievalWindow[],
): RetrievalWindow[] {
  const linked: RetrievalWindow[] = [];
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    if (window === undefined) {
      throw new Error(`Missing retrieval window at index ${index}.`);
    }
    linked.push({
      ...window,
      nextWindowId: windows[index + 1]?.id ?? null,
      previousWindowId: windows[index - 1]?.id ?? null,
    });
  }
  return linked;
}

function splitStructuredTextContent(
  content: string,
  element: SourceElement,
  config: RetrievalWindowConstructionConfig,
): WindowContent[] {
  const policy = config.policy.policy;
  const countTokens = (candidate: string): number => (
    countRetrievalEmbeddingInputTokens(
      candidate,
      element,
      config.embeddingInputFormat,
    )
  );
  const units = readStructuredTextUnits(
    content,
    policy.targetInputTokens,
    policy.maximumInputTokens,
    countTokens,
    element,
  );
  return groupStructuredTextUnits(
    units,
    policy.targetInputTokens,
    countTokens,
  );
}

function readStructuredTextUnits(
  content: string,
  targetInputTokens: number,
  maximumInputTokens: number,
  countTokens: (candidate: string) => number,
  element: SourceElement,
): StructuredTextUnit[] {
  const units: StructuredTextUnit[] = [];
  const blocks = readStructuralBlocks(content);
  for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
    const block = blocks[blockIndex];
    if (block === undefined) {
      continue;
    }
    const joiner = blockIndex === 0 ? "\n\n" : block.joiner;
    const blockTokens = countTokens(block.content);
    const keepCompleteCodeBlock = isFencedCodeBlock(block.content)
      && blockTokens <= maximumInputTokens;
    if (blockTokens <= targetInputTokens || keepCompleteCodeBlock) {
      units.push({ content: block.content, joiner });
      continue;
    }
    const blockUnits = splitOversizedStructuralBlock(
      block.content,
      joiner,
      maximumInputTokens,
      countTokens,
      element,
    );
    units.push(...blockUnits);
  }
  return units;
}

function readStructuralBlocks(content: string): StructuredTextUnit[] {
  const lines = content.split("\n");
  const blocks: StructuredTextUnit[] = [];
  let blockLines: string[] = [];
  let blockJoiner = "\n\n";
  let inFence = false;
  let fenceMarker = "";
  let nextBlockJoiner = "\n\n";
  const appendLine = (line: string): void => {
    if (blockLines.length === 0) {
      blockJoiner = nextBlockJoiner;
      nextBlockJoiner = "\n";
    }
    blockLines.push(line);
  };
  const flush = (): void => {
    const block = blockLines.join("\n").trim();
    blockLines = [];
    if (block !== "") {
      blocks.push({
        content: block,
        joiner: blockJoiner,
      });
    }
  };
  for (const line of lines) {
    const fence = line.trimStart().match(/^(`{3,}|~{3,})/u)?.[1];
    if (inFence) {
      appendLine(line);
      if (
        fence?.startsWith(fenceMarker[0] ?? "\0")
        && fence.length >= fenceMarker.length
      ) {
        inFence = false;
        fenceMarker = "";
        flush();
      }
      continue;
    }
    if (fence !== undefined) {
      flush();
      appendLine(line);
      inFence = true;
      fenceMarker = fence;
      continue;
    }
    if (line.trim() === "") {
      flush();
      nextBlockJoiner = nextBlockJoiner === "\n"
        ? "\n\n"
        : `${nextBlockJoiner}\n`;
      continue;
    }
    appendLine(line);
  }
  flush();
  return blocks;
}

function isFencedCodeBlock(content: string): boolean {
  return /^(`{3,}|~{3,})/u.test(content);
}

function splitOversizedStructuralBlock(
  content: string,
  initialJoiner: StructuredTextUnit["joiner"],
  maximumInputTokens: number,
  countTokens: (candidate: string) => number,
  element: SourceElement,
): StructuredTextUnit[] {
  if (content.includes("\n")) {
    return splitMultilineStructuralBlock(
      content,
      initialJoiner,
      maximumInputTokens,
      countTokens,
      element,
    );
  }
  const sentences = splitSentences(content, initialJoiner);
  const units: StructuredTextUnit[] = [];
  for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex += 1) {
    const sentence = sentences[sentenceIndex];
    if (sentence === undefined) {
      continue;
    }
    if (countTokens(sentence.content) <= maximumInputTokens) {
      units.push(sentence);
      continue;
    }
    const pieces = splitOversizedTextUnit(
      sentence.content,
      maximumInputTokens,
      countTokens,
      element,
    );
    for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
      const piece = pieces[pieceIndex];
      if (piece !== undefined) {
        units.push({
          content: piece,
          joiner: pieceIndex === 0 ? sentence.joiner : " ",
        });
      }
    }
  }
  return units;
}

function splitMultilineStructuralBlock(
  content: string,
  initialJoiner: StructuredTextUnit["joiner"],
  maximumInputTokens: number,
  countTokens: (candidate: string) => number,
  element: SourceElement,
): StructuredTextUnit[] {
  const units: StructuredTextUnit[] = [];
  const lines = content.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    if (line === undefined || line === "") {
      continue;
    }
    const joiner = lineIndex === 0 ? initialJoiner : "\n";
    if (countTokens(line) <= maximumInputTokens) {
      units.push({ content: line, joiner });
      continue;
    }
    const pieces = splitOversizedTextUnit(
      line,
      maximumInputTokens,
      countTokens,
      element,
    );
    for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
      const piece = pieces[pieceIndex];
      if (piece !== undefined) {
        units.push({
          content: piece,
          joiner: pieceIndex === 0 ? joiner : " ",
        });
      }
    }
  }
  return units;
}

function splitSentences(
  content: string,
  initialJoiner: string,
): StructuredTextUnit[] {
  const matches = content.match(/[^.!?]+(?:[.!?]+["')\]]*|$)/gu) ?? [];
  const sentences: StructuredTextUnit[] = [];
  for (const match of matches) {
    const sentence = match.trim();
    if (sentence !== "") {
      const contentStart = match.indexOf(sentence);
      const joiner = sentences.length === 0
        ? initialJoiner
        : match.slice(0, contentStart);
      sentences.push({ content: sentence, joiner });
    }
  }
  if (sentences.length === 0) {
    return [{ content, joiner: initialJoiner }];
  }
  return sentences;
}

function splitOversizedTextUnit(
  content: string,
  maximumInputTokens: number,
  countTokens: (candidate: string) => number,
  element: SourceElement,
): string[] {
  const chunks: string[] = [];
  let remaining = content;
  while (countTokens(remaining) > maximumInputTokens) {
    const splitIndex = findBoundarySplitIndex(
      remaining,
      maximumInputTokens,
      countTokens,
      element,
    );
    const chunk = remaining.slice(0, splitIndex).trim();
    if (chunk === "") {
      throw createOversizedUnitError(element, maximumInputTokens);
    }
    chunks.push(chunk);
    remaining = remaining.slice(splitIndex).trimStart();
  }
  if (remaining !== "") {
    chunks.push(remaining);
  }
  return chunks;
}

function findBoundarySplitIndex(
  content: string,
  maximumInputTokens: number,
  countTokens: (candidate: string) => number,
  element: SourceElement,
): number {
  const punctuationBoundary = findLastFittingBoundary(
    content,
    readPunctuationBoundaries(content),
    maximumInputTokens,
    countTokens,
  );
  if (punctuationBoundary > 0) {
    return punctuationBoundary;
  }
  const wordBoundary = findLastFittingBoundary(
    content,
    readWordBoundaries(content),
    maximumInputTokens,
    countTokens,
  );
  if (wordBoundary > 0) {
    return wordBoundary;
  }
  throw createOversizedUnitError(element, maximumInputTokens);
}

function findLastFittingBoundary(
  content: string,
  boundaries: readonly number[],
  maximumInputTokens: number,
  countTokens: (candidate: string) => number,
): number {
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index];
    if (boundary === undefined) {
      continue;
    }
    const candidate = content.slice(0, boundary).trimEnd();
    if (candidate !== "" && countTokens(candidate) <= maximumInputTokens) {
      return boundary;
    }
  }
  return -1;
}

function readPunctuationBoundaries(content: string): number[] {
  const boundaries: number[] = [];
  const matches = content.matchAll(/\p{P}+\s+/gu);
  for (const match of matches) {
    if (match.index !== undefined && match[0] !== undefined) {
      boundaries.push(match.index + match[0].trimEnd().length);
    }
  }
  return boundaries;
}

function readWordBoundaries(content: string): number[] {
  const boundaries: number[] = [];
  const matches = content.matchAll(/\s+/gu);
  for (const match of matches) {
    if (match.index !== undefined) {
      boundaries.push(match.index);
    }
  }
  return boundaries;
}

function groupStructuredTextUnits(
  units: readonly StructuredTextUnit[],
  targetInputTokens: number,
  countTokens: (candidate: string) => number,
): WindowContent[] {
  const windows: WindowContent[] = [];
  let content = "";
  for (const unit of units) {
    const candidate = content === ""
      ? unit.content
      : `${content}${unit.joiner}${unit.content}`;
    if (content !== "" && countTokens(candidate) > targetInputTokens) {
      windows.push({ content, table: null });
      content = unit.content;
      continue;
    }
    content = candidate;
  }
  if (content !== "") {
    windows.push({ content, table: null });
  }
  return windows;
}

function splitStructuredTableContent(
  element: TableElement,
  config: RetrievalWindowConstructionConfig,
): WindowContent[] {
  const policy = config.policy.policy;
  const table = readSerializedTable(element);
  const headerHash = createHash("sha256").update(table.prefix).digest("hex");
  const countTokens = (candidate: string): number => (
    countRetrievalEmbeddingInputTokens(
      candidate,
      element,
      config.embeddingInputFormat,
    )
  );
  if (countTokens(table.prefix) > policy.maximumInputTokens) {
    return createFallbackTableWindows(element, config, headerHash);
  }
  if (table.rows.length === 0) {
    return [{
      content: table.prefix,
      table: {
        headerHash,
        rowEnd: element.table.rowEnd,
        rowStart: element.table.rowStart,
      },
    }];
  }
  const windows: WindowContent[] = [];
  let rows: string[] = [];
  let rowStart = readTableDataStart(element);
  for (let index = 0; index < table.rows.length; index += 1) {
    const row = table.rows[index];
    if (row === undefined) {
      throw new Error(`Table element ${element.id} is missing row ${index}.`);
    }
    const singleRowContent = serializeRetrievalTableWindow(table.prefix, [row]);
    if (countTokens(singleRowContent) > policy.maximumInputTokens) {
      if (rows.length > 0) {
        windows.push(
          createTableWindowContent(table.prefix, rows, headerHash, rowStart),
        );
        rowStart += rows.length;
        rows = [];
      }
      windows.push(...splitOversizedTableRow(
        table.prefix,
        row,
        headerHash,
        rowStart,
        policy.maximumInputTokens,
        countTokens,
        element,
      ));
      rowStart += 1;
      continue;
    }
    const candidate = serializeRetrievalTableWindow(
      table.prefix,
      [...rows, row],
    );
    if (
      rows.length > 0
      && countTokens(candidate) > policy.targetInputTokens
    ) {
      windows.push(
        createTableWindowContent(table.prefix, rows, headerHash, rowStart),
      );
      rowStart += rows.length;
      rows = [];
    }
    rows.push(row);
  }
  if (rows.length > 0) {
    windows.push(
      createTableWindowContent(table.prefix, rows, headerHash, rowStart),
    );
  }
  return windows;
}

function createFallbackTableWindows(
  element: TableElement,
  config: RetrievalWindowConstructionConfig,
  headerHash: string,
): WindowContent[] {
  const contents = splitRetrievalContentAtTokenLimit(
    element.content,
    element,
    config.embeddingInputFormat,
    config.policy.policy.maximumInputTokens,
  );
  return contents.map((content) => ({
    content,
    table: {
      headerHash,
      rowEnd: element.table.rowEnd,
      rowStart: element.table.rowStart,
    },
  }));
}

function splitOversizedTableRow(
  prefix: string,
  row: string,
  headerHash: string,
  rowStart: number,
  maximumInputTokens: number,
  countTokens: (candidate: string) => number,
  element: TableElement,
): WindowContent[] {
  const countRowPiece = (piece: string): number => (
    countTokens(serializeRetrievalTableWindow(prefix, [piece]))
  );
  const pieces = splitOversizedTextUnit(
    row,
    maximumInputTokens,
    countRowPiece,
    element,
  );
  return pieces.map((piece) => ({
    content: serializeRetrievalTableWindow(prefix, [piece]),
    table: {
      headerHash,
      rowEnd: rowStart + 1,
      rowStart,
    },
  }));
}

function readSerializedTable(element: TableElement): {
  prefix: string;
  rows: string[];
} {
  const lines = element.content.split("\n");
  const headerIndex = lines.findIndex((line) => line.startsWith("| "));
  const divider = lines[headerIndex + 1];
  if (
    headerIndex < 0
    || divider === undefined
    || !/^\|(?:\s*:?-{3,}:?\s*\|)+$/u.test(divider)
  ) {
    throw new Error(`Table element ${element.id} has invalid serialized headers.`);
  }
  const prefix = lines.slice(0, headerIndex + 2).join("\n");
  const rows = lines.slice(headerIndex + 2);
  const expectedRows = element.table.rowEnd - readTableDataStart(element);
  if (rows.length !== expectedRows) {
    throw new Error(
      `Table element ${element.id} contains ${rows.length} serialized rows; `
      + `expected ${expectedRows}.`,
    );
  }
  return { prefix, rows };
}

function readTableDataStart(element: TableElement): number {
  let headerRowCount = 0;
  for (const cell of element.table.cells) {
    if (cell.columnHeader) {
      headerRowCount = Math.max(headerRowCount, cell.endRow);
    }
  }
  return Math.max(element.table.rowStart, headerRowCount);
}

function serializeRetrievalTableWindow(
  prefix: string,
  rows: readonly string[],
): string {
  return rows.length === 0 ? prefix : `${prefix}\n${rows.join("\n")}`;
}

function createTableWindowContent(
  prefix: string,
  rows: readonly string[],
  headerHash: string,
  rowStart: number,
): WindowContent {
  return {
    content: serializeRetrievalTableWindow(prefix, rows),
    table: {
      headerHash,
      rowEnd: rowStart + rows.length,
      rowStart,
    },
  };
}

function createOversizedUnitError(
  element: SourceElement,
  maximumInputTokens: number,
): Error {
  return new Error(
    `Retrieval ${element.kind} for ${element.id} has no punctuation or word `
    + `boundary that fits within ${maximumInputTokens} embedding input tokens.`,
  );
}

function createRetrievalWindowId(
  element: SourceElement,
  ordinal: number,
  content: string,
  policy: RetrievalWindowPolicyContract,
): string {
  return createHash("sha256")
    .update(policy.policy.id)
    .update("\0")
    .update(policy.fingerprint)
    .update("\0")
    .update(element.documentId)
    .update("\0")
    .update(element.sourceFile)
    .update("\0")
    .update(element.id)
    .update("\0")
    .update(String(ordinal))
    .update("\0")
    .update(content)
    .digest("hex");
}
