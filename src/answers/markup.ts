import type {
  ListItem,
  PhrasingContent,
  RootContent,
  TableCell,
} from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

const VALID_CITATION_MARKER_PATTERN = /^\[[1-9]\d*(?:[\t ]*,[\t ]*[1-9]\d*)*\]$/;
const CITATION_CANDIDATE_PATTERN = /\[[^\]\r\n]*\d[^\]\r\n]*\]/g;
const UNCLOSED_CITATION_PATTERN = /\[(?=[0-9])[^\]\r\n]*(?=$|\r|\n)/g;
const REPAIRABLE_UNCLOSED_CITATION_PATTERN = /\[(?:[1-9]\d*(?:[\t ]*[,;][\t ]*[1-9]\d*)*|[1-9]\d*[\t ]*(?:-|\u2013|\u2014)[\t ]*[1-9]\d*)(?=[.!?]?[\t ]*(?:$|\r|\n))/g;
const CITATION_LIKE_LINK_LABEL_PATTERN = /^\[[\t \d,;\-\u2013\u2014]+\]$/;
const BRACKETED_LEGAL_YEAR_PATTERN = /^\[(?:1[5-9]\d{2}|20\d{2}|21\d{2})\]$/;
const LEGAL_COURT_CITATION_CONTINUATION_PATTERN = new RegExp(
  String.raw`^[\t ]+(?:`
    + String.raw`UKSC|UKPC|EWCA[\t ]+(?:Civ|Crim)|EWHC[\t ]+(?:Admin|Ch|Fam|KB|QB)|UKUT|UKFTT|`
    + String.raw`SCC|BCCA|BCSC|ABCA|ABKB|ABQB|SKCA|SKKB|MBCA|MBKB|ONCA|ONSC|QCCA|QCCS|NBCA|NBKB|NSCA|NSSC|PECA|PESC|NLCA|NLSC|YKCA|YKSC|NWTCA|NWTSC|NUCA|NUCJ|FCA|FC|TCC|`
    + String.raw`HCA|FCAFC|NSWCA|NSWSC|VSCA|VSC|QCA|QSC|SASCA|SASC|WASCA|WASC|TASFC|TASSC|NTCA|NTSC|ACTCA|ACTSC|`
    + String.raw`NZSC|NZCA|NZHC`
    + String.raw`)[\t ]+\d+\b`,
);
const LEGAL_REPORTER_CITATION_CONTINUATION_PATTERN = new RegExp(
  String.raw`^[\t ]+\d+[\t ]+(?:S\.C\.R\.|D\.L\.R\.|F\.C\.R\.|W\.L\.R\.|All[\t ]+E\.R\.|A\.C\.|Q\.B\.|K\.B\.|Ch\.|Fam\.)[\t ]+\d+\b`,
);
const CITATION_RANGE_PATTERN = new RegExp(
  String.raw`\[[^\]\r\n]*\d[^\]\r\n]*(?:-|\u2013|\u2014)[^\]\r\n]*\d[^\]\r\n]*\]`
    + String.raw`|\[[1-9]\d*(?:[\t ]*,[\t ]*[1-9]\d*)*\][\t ]*(?:-|\u2013|\u2014)[\t ]*(?:\[[1-9]\d*(?:[\t ]*,[\t ]*[1-9]\d*)*\]|[1-9]\d*)`,
  "g",
);
export interface AnswerCitationSpan {
  kind: "citation";
  numbers: number[];
  sourceEnd: number;
  sourceStart: number;
}

export interface AnswerTextSpan {
  kind: "text";
  text: string;
}

export type AnswerInlineSpan = AnswerCitationSpan | AnswerTextSpan;

export interface AnswerMarkdownSourceRange {
  removalEnd: number;
  removalStart: number;
  sourceEnd: number;
  sourceStart: number;
}

export type AnswerMarkdownBlock = AnswerMarkdownSourceRange & (
  | {
    boldOnly: boolean;
    kind: "paragraph";
    quoteDepth: number;
    spans: AnswerInlineSpan[];
  }
  | {
    depth: number;
    kind: "heading";
    spans: AnswerInlineSpan[];
  }
  | {
    kind: "list-item";
    leadingLabelLength: number;
    ordered: boolean;
    quoteDepth: number;
    spans: AnswerInlineSpan[];
  }
  | {
    cells: AnswerInlineSpan[][];
    header: boolean;
    kind: "table-row";
  }
  | {
    kind: "code";
    text: string;
  }
  | {
    kind: "thematic-break";
  }
);

export interface ParsedAnswerMarkup {
  blocks: AnswerMarkdownBlock[];
  canonicalMarkdown: string;
  citationNumbers: number[];
  citations: AnswerCitationSpan[];
}

interface AnswerMarkupParseContext {
  blocks: AnswerMarkdownBlock[];
  citations: AnswerCitationSpan[];
  definitions: Map<string, CitationReplacement>;
  markdown: string;
  maximumCitationNumber: number | null;
  preservedLinkReferenceIdentifiers: Set<string>;
  repairedLinkReferenceIdentifiers: Set<string>;
}

interface CitationReplacement {
  end: number;
  replacement: string;
  start: number;
}

interface CitationCandidate {
  end: number;
  escaped: boolean;
  marker: string;
  start: number;
}

interface SourceRange {
  end: number;
  start: number;
}

interface PositionedNode {
  position?: {
    end: { offset?: number | undefined };
    start: { offset?: number | undefined };
  } | null | undefined;
}

export class AnswerMarkupError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AnswerMarkupError";
  }
}

export function parseAnswerMarkup(markdown: string): ParsedAnswerMarkup {
  return parseAnswerMarkupBoundary(markdown, null);
}

export function parseGeneratedAnswerMarkup(
  markdown: string,
  maximumCitationNumber: number,
): ParsedAnswerMarkup {
  if (!Number.isSafeInteger(maximumCitationNumber) || maximumCitationNumber < 1) {
    throw new Error("Generated answers require at least one available citation source.");
  }
  return parseAnswerMarkupBoundary(markdown, maximumCitationNumber);
}

function parseAnswerMarkupBoundary(
  value: string,
  maximumCitationNumber: number | null,
): ParsedAnswerMarkup {
  const markdown = value.trim();
  if (markdown === "") {
    throw new AnswerMarkupError("The inference runtime returned an empty answer.");
  }
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const context: AnswerMarkupParseContext = {
    blocks: [],
    citations: [],
    definitions: new Map(),
    markdown,
    maximumCitationNumber,
    preservedLinkReferenceIdentifiers: new Set(),
    repairedLinkReferenceIdentifiers: new Set(),
  };
  for (const child of tree.children) {
    appendBlock(child, context, 0, readNodeRange(child, markdown));
  }
  const canonicalMarkdown = canonicalizeCitations(markdown, context);
  const citationNumbers = readUniqueCitationNumbers(context.citations);
  return {
    blocks: context.blocks,
    canonicalMarkdown,
    citationNumbers,
    citations: context.citations,
  };
}

function appendBlock(
  node: RootContent,
  context: AnswerMarkupParseContext,
  quoteDepth: number,
  removalRange: SourceRange,
): void {
  const sourceRange = readNodeRange(node, context.markdown);
  const ranges: AnswerMarkdownSourceRange = {
    removalEnd: removalRange.end,
    removalStart: removalRange.start,
    sourceEnd: sourceRange.end,
    sourceStart: sourceRange.start,
  };
  switch (node.type) {
    case "paragraph":
      context.blocks.push({
        boldOnly: isBoldOnlyParagraph(node.children),
        kind: "paragraph",
        quoteDepth,
        ...ranges,
        spans: parseInlineChildren(node.children, context, true),
      });
      return;
    case "heading":
      context.blocks.push({
        depth: node.depth,
        kind: "heading",
        ...ranges,
        spans: parseInlineChildren(node.children, context, true),
      });
      return;
    case "list":
      appendListBlocks(node.children, node.ordered === true, context, quoteDepth);
      return;
    case "blockquote":
      for (const child of node.children) {
        appendBlock(
          child,
          context,
          quoteDepth + 1,
          readNodeRange(child, context.markdown),
        );
      }
      return;
    case "table":
      for (let rowIndex = 0; rowIndex < node.children.length; rowIndex += 1) {
        const row = node.children[rowIndex];
        if (row === undefined) {
          continue;
        }
        const cells: AnswerInlineSpan[][] = [];
        for (const cell of row.children) {
          cells.push(parseTableCell(cell, context));
        }
        const rowRemovalRange = readLineRemovalRange(row, context.markdown);
        const rowSourceRange = readNodeRange(row, context.markdown);
        context.blocks.push({
          cells,
          header: rowIndex === 0,
          kind: "table-row",
          removalEnd: rowRemovalRange.end,
          removalStart: rowRemovalRange.start,
          sourceEnd: rowSourceRange.end,
          sourceStart: rowSourceRange.start,
        });
      }
      return;
    case "code":
      context.blocks.push({ kind: "code", ...ranges, text: node.value });
      return;
    case "thematicBreak":
      context.blocks.push({ kind: "thematic-break", ...ranges });
      return;
    case "footnoteDefinition":
      for (const child of node.children) {
        appendBlock(
          child,
          context,
          quoteDepth,
          readNodeRange(child, context.markdown),
        );
      }
      return;
    case "definition": {
      const source = readNodeSource(node, context.markdown);
      context.definitions.set(node.identifier, {
        end: source.start + source.text.length,
        replacement: "",
        start: source.start,
      });
      return;
    }
    case "html":
    case "yaml":
      return;
  }
}

function appendListBlocks(
  items: readonly ListItem[],
  ordered: boolean,
  context: AnswerMarkupParseContext,
  quoteDepth: number,
): void {
  for (const item of items) {
    const itemRemovalRange = readLineRemovalRange(item, context.markdown);
    for (const child of item.children) {
      if (child.type === "paragraph") {
        const sourceRange = readNodeRange(child, context.markdown);
        context.blocks.push({
          kind: "list-item",
          leadingLabelLength: readLeadingBoldListLabelLength(child.children),
          ordered,
          quoteDepth,
          removalEnd: itemRemovalRange.end,
          removalStart: itemRemovalRange.start,
          sourceEnd: sourceRange.end,
          sourceStart: sourceRange.start,
          spans: parseInlineChildren(child.children, context, true),
        });
        continue;
      }
      appendBlock(
        child,
        context,
        quoteDepth,
        readNodeRange(child, context.markdown),
      );
    }
  }
}

function parseTableCell(
  cell: TableCell,
  context: AnswerMarkupParseContext,
): AnswerInlineSpan[] {
  return parseInlineChildren(cell.children, context, true);
}

function parseInlineChildren(
  children: readonly PhrasingContent[],
  context: AnswerMarkupParseContext,
  citationsEnabled: boolean,
): AnswerInlineSpan[] {
  const spans: AnswerInlineSpan[] = [];
  for (const child of children) {
    appendInlineNode(child, context, citationsEnabled, spans);
  }
  return spans;
}

function appendInlineNode(
  node: PhrasingContent,
  context: AnswerMarkupParseContext,
  citationsEnabled: boolean,
  spans: AnswerInlineSpan[],
): void {
  switch (node.type) {
    case "text":
      if (citationsEnabled) {
        appendCitationAwareText(node, context, spans);
      } else {
        appendTextSpan(spans, node.value);
      }
      return;
    case "break":
      appendTextSpan(spans, "\n");
      return;
    case "inlineCode":
      appendTextSpan(spans, node.value);
      return;
    case "image":
      appendTextSpan(spans, node.alt ?? "");
      return;
    case "imageReference":
      appendTextSpan(spans, node.alt ?? "");
      return;
    case "footnoteReference":
      appendTextSpan(spans, node.label ?? node.identifier);
      return;
    case "delete":
    case "emphasis":
    case "strong":
      for (const child of node.children) {
        appendInlineNode(child, context, citationsEnabled, spans);
      }
      return;
    case "link":
    case "linkReference":
      if (
        citationsEnabled
        && appendRepairedCitationLink(node, context, spans)
      ) {
        return;
      }
      if (node.type === "linkReference") {
        context.preservedLinkReferenceIdentifiers.add(node.identifier);
      }
      rejectCitationLikeLink(node, context);
      for (const child of node.children) {
        appendInlineNode(child, context, false, spans);
      }
      return;
    case "html":
      return;
  }
}

function appendCitationAwareText(
  node: Extract<PhrasingContent, { type: "text" }>,
  context: AnswerMarkupParseContext,
  spans: AnswerInlineSpan[],
): void {
  const source = readNodeSource(node, context.markdown);
  const repairEnabled = context.maximumCitationNumber !== null;
  rejectUnrepairableCitationRanges(
    source.text,
    context.maximumCitationNumber,
  );
  rejectUnrepairableUnclosedCitations(source.text, repairEnabled);
  const candidates = readCitationCandidates(
    source.text,
    context.maximumCitationNumber,
  );
  let valueCursor = 0;
  for (const candidate of candidates) {
    const valueIndex = node.value.indexOf(candidate.marker, valueCursor);
    if (valueIndex < 0) {
      throw new AnswerMarkupError("The answer citation could not be mapped to parsed Markdown text.");
    }
    if (candidate.escaped) {
      const escapedEnd = valueIndex + candidate.marker.length;
      appendTextSpan(spans, node.value.slice(valueCursor, escapedEnd));
      valueCursor = escapedEnd;
      continue;
    }
    if (isBracketedLegalCitation(candidate, source.start, context.markdown)) {
      const legalCitationEnd = valueIndex + candidate.marker.length;
      appendTextSpan(spans, node.value.slice(valueCursor, legalCitationEnd));
      valueCursor = legalCitationEnd;
      continue;
    }
    appendTextSpan(spans, node.value.slice(valueCursor, valueIndex));
    const numbers = parseGeneratedCitationNumbers(
      candidate.marker,
      context.maximumCitationNumber,
    );
    validateCitationNumbers(numbers, context.maximumCitationNumber);
    const citation: AnswerCitationSpan = {
      kind: "citation",
      numbers,
      sourceEnd: source.start + candidate.end,
      sourceStart: source.start + candidate.start,
    };
    spans.push(citation);
    context.citations.push(citation);
    valueCursor = valueIndex + candidate.marker.length;
  }
  appendTextSpan(spans, node.value.slice(valueCursor));
}

function appendRepairedCitationLink(
  node: Extract<PhrasingContent, { type: "link" | "linkReference" }>,
  context: AnswerMarkupParseContext,
  spans: AnswerInlineSpan[],
): boolean {
  if (context.maximumCitationNumber === null) {
    return false;
  }
  const source = readNodeSource(node, context.markdown);
  const labelEnd = source.text.indexOf("]");
  if (labelEnd < 0) {
    return false;
  }
  const label = source.text.slice(0, labelEnd + 1);
  if (!CITATION_LIKE_LINK_LABEL_PATTERN.test(label)) {
    return false;
  }
  const numbers = parseGeneratedCitationNumbers(
    label,
    context.maximumCitationNumber,
  );
  validateCitationNumbers(numbers, context.maximumCitationNumber);
  const citation: AnswerCitationSpan = {
    kind: "citation",
    numbers,
    sourceEnd: source.start + source.text.length,
    sourceStart: source.start,
  };
  spans.push(citation);
  context.citations.push(citation);
  if (node.type === "linkReference") {
    context.repairedLinkReferenceIdentifiers.add(node.identifier);
  }
  return true;
}

function rejectCitationLikeLink(
  node: Extract<PhrasingContent, { type: "link" | "linkReference" }>,
  context: AnswerMarkupParseContext,
): void {
  const source = readNodeSource(node, context.markdown);
  const labelEnd = source.text.indexOf("]");
  if (labelEnd < 0) {
    return;
  }
  const label = source.text.slice(0, labelEnd + 1);
  if (!CITATION_LIKE_LINK_LABEL_PATTERN.test(label)) {
    return;
  }
  rejectUnrepairableCitationRanges(label, null);
  if (!VALID_CITATION_MARKER_PATTERN.test(label)) {
    throw new AnswerMarkupError(
      `Invalid citation marker ${JSON.stringify(label)}. Citation markers cannot be Markdown links.`,
    );
  }
  const numbers = parseCitationNumbers(label);
  validateCitationNumbers(numbers, context.maximumCitationNumber);
  throw new AnswerMarkupError(
    `Invalid citation marker ${JSON.stringify(label)}. Citation markers cannot be Markdown links; use ${numbers.map((number) => `[${number}]`).join(" ")} instead.`,
  );
}

function isBracketedLegalCitation(
  candidate: { end: number; marker: string },
  sourceStart: number,
  markdown: string,
): boolean {
  if (!BRACKETED_LEGAL_YEAR_PATTERN.test(candidate.marker)) {
    return false;
  }
  const sourceEnd = sourceStart + candidate.end;
  const followingText = markdown.slice(sourceEnd);
  return LEGAL_COURT_CITATION_CONTINUATION_PATTERN.test(followingText)
    || LEGAL_REPORTER_CITATION_CONTINUATION_PATTERN.test(followingText);
}

function readNodeSource(
  node: PositionedNode,
  markdown: string,
): { start: number; text: string } {
  const range = readNodeRange(node, markdown);
  return { start: range.start, text: markdown.slice(range.start, range.end) };
}

function readNodeRange(node: PositionedNode, markdown: string): SourceRange {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (
    start === undefined
    || end === undefined
    || start < 0
    || end < start
    || end > markdown.length
  ) {
    throw new AnswerMarkupError("The Markdown parser did not provide valid answer source positions.");
  }
  return { end, start };
}

function readLineRemovalRange(
  node: PositionedNode,
  markdown: string,
): SourceRange {
  const range = readNodeRange(node, markdown);
  let end = range.end;
  if (markdown.startsWith("\r\n", end)) {
    end += 2;
  } else if (markdown[end] === "\n" || markdown[end] === "\r") {
    end += 1;
  }
  return { end, start: range.start };
}

function rejectUnrepairableCitationRanges(
  value: string,
  maximumCitationNumber: number | null,
): void {
  for (const match of value.matchAll(CITATION_RANGE_PATTERN)) {
    if (match.index === undefined || isEscaped(value, match.index)) {
      continue;
    }
    if (
      maximumCitationNumber !== null
      && parseRepairableCitationNumbers(
        match[0],
        maximumCitationNumber,
      ) !== null
    ) {
      continue;
    }
    throw new AnswerMarkupError(
      "Citation ranges are not supported. Cite every source with an individual marker such as [1] [2].",
    );
  }
}

function rejectUnrepairableUnclosedCitations(
  value: string,
  repairEnabled: boolean,
): void {
  const repairableStarts = new Set<number>();
  if (repairEnabled) {
    for (const match of value.matchAll(REPAIRABLE_UNCLOSED_CITATION_PATTERN)) {
      if (match.index !== undefined && !isEscaped(value, match.index)) {
        repairableStarts.add(match.index);
      }
    }
  }
  for (const match of value.matchAll(UNCLOSED_CITATION_PATTERN)) {
    if (match.index === undefined || isEscaped(value, match.index)) {
      continue;
    }
    if (repairableStarts.has(match.index)) {
      continue;
    }
    throw new AnswerMarkupError(
      `Invalid citation marker ${JSON.stringify(match[0])}. Citation markers must end with ].`,
    );
  }
}

function readCitationCandidates(
  value: string,
  maximumCitationNumber: number | null = null,
): CitationCandidate[] {
  const candidates: CitationCandidate[] = [];
  if (maximumCitationNumber !== null) {
    appendRepairableRangeCandidates(
      candidates,
      value,
      maximumCitationNumber,
    );
  }
  for (const match of value.matchAll(CITATION_CANDIDATE_PATTERN)) {
    if (match.index === undefined) {
      continue;
    }
    const end = match.index + match[0].length;
    if (overlapsCitationCandidate(candidates, match.index, end)) {
      continue;
    }
    candidates.push({
      end,
      escaped: isEscaped(value, match.index),
      marker: match[0],
      start: match.index,
    });
  }
  if (maximumCitationNumber !== null) {
    for (const match of value.matchAll(REPAIRABLE_UNCLOSED_CITATION_PATTERN)) {
      if (match.index === undefined) {
        continue;
      }
      const end = match.index + match[0].length;
      if (overlapsCitationCandidate(candidates, match.index, end)) {
        continue;
      }
      candidates.push({
        end,
        escaped: isEscaped(value, match.index),
        marker: match[0],
        start: match.index,
      });
    }
  }
  candidates.sort((left, right) => left.start - right.start);
  return candidates;
}

function appendRepairableRangeCandidates(
  candidates: CitationCandidate[],
  value: string,
  maximumCitationNumber: number,
): void {
  for (const match of value.matchAll(CITATION_RANGE_PATTERN)) {
    if (match.index === undefined) {
      continue;
    }
    const numbers = parseRepairableCitationNumbers(
      match[0],
      maximumCitationNumber,
    );
    if (numbers === null) {
      continue;
    }
    candidates.push({
      end: match.index + match[0].length,
      escaped: isEscaped(value, match.index),
      marker: match[0],
      start: match.index,
    });
  }
}

function overlapsCitationCandidate(
  candidates: readonly CitationCandidate[],
  start: number,
  end: number,
): boolean {
  for (const candidate of candidates) {
    if (start < candidate.end && end > candidate.start) {
      return true;
    }
  }
  return false;
}

function isEscaped(value: string, index: number): boolean {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (value[cursor] !== "\\") {
      break;
    }
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function parseCitationNumbers(marker: string): number[] {
  const numbers: number[] = [];
  const content = marker.slice(1, -1);
  for (const rawNumber of content.split(",")) {
    numbers.push(Number.parseInt(rawNumber.trim(), 10));
  }
  return numbers;
}

function parseGeneratedCitationNumbers(
  marker: string,
  maximumCitationNumber: number | null,
): number[] {
  if (VALID_CITATION_MARKER_PATTERN.test(marker)) {
    return parseCitationNumbers(marker);
  }
  if (maximumCitationNumber !== null) {
    const repaired = parseRepairableCitationNumbers(
      marker,
      maximumCitationNumber,
    );
    if (repaired !== null) {
      return repaired;
    }
  }
  throw new AnswerMarkupError(
    `Invalid citation marker ${JSON.stringify(marker)}. Use individual markers such as [1] [3], or a grouped marker such as [1, 3].`,
  );
}

function parseRepairableCitationNumbers(
  marker: string,
  maximumCitationNumber: number,
): number[] | null {
  const separatedRange = /^\[([1-9]\d*)\][\t ]*(?:-|\u2013|\u2014)[\t ]*(?:\[([1-9]\d*)\]|([1-9]\d*))$/u.exec(marker);
  if (separatedRange !== null) {
    const start = Number.parseInt(separatedRange[1] ?? "", 10);
    const rawEnd = separatedRange[2] ?? separatedRange[3] ?? "";
    const end = Number.parseInt(rawEnd, 10);
    return expandCitationRange(start, end, maximumCitationNumber);
  }

  let content = marker;
  if (content.startsWith("[")) {
    content = content.slice(1);
  }
  if (content.endsWith("]")) {
    content = content.slice(0, -1);
  }
  const rawParts = content.split(/[,;]/u);
  const numbers: number[] = [];
  for (let index = 0; index < rawParts.length; index += 1) {
    const rawPart = rawParts[index];
    if (rawPart === undefined) {
      return null;
    }
    const part = rawPart.trim();
    const finalPart = index === rawParts.length - 1;
    if (part === "" && finalPart) {
      continue;
    }
    if (/^[1-9]\d*$/u.test(part)) {
      numbers.push(Number.parseInt(part, 10));
      continue;
    }
    const range = /^([1-9]\d*)[\t ]*(?:-|\u2013|\u2014)[\t ]*([1-9]\d*)$/u.exec(part);
    if (range === null) {
      return null;
    }
    const start = Number.parseInt(range[1] ?? "", 10);
    const end = Number.parseInt(range[2] ?? "", 10);
    const expanded = expandCitationRange(
      start,
      end,
      maximumCitationNumber,
    );
    if (expanded === null) {
      return null;
    }
    numbers.push(...expanded);
  }
  if (numbers.length === 0) {
    return null;
  }
  return readUniqueNumbers(numbers);
}

function expandCitationRange(
  start: number,
  end: number,
  maximumCitationNumber: number,
): number[] | null {
  if (start > end) {
    return null;
  }
  validateCitationNumbers([start, end], maximumCitationNumber);
  const numbers: number[] = [];
  for (let number = start; number <= end; number += 1) {
    numbers.push(number);
  }
  return numbers;
}

function readUniqueNumbers(values: readonly number[]): number[] {
  const numbers: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    numbers.push(value);
  }
  return numbers;
}

function validateCitationNumbers(
  numbers: readonly number[],
  maximumCitationNumber: number | null,
): void {
  for (const citationNumber of numbers) {
    if (!Number.isSafeInteger(citationNumber) || citationNumber < 1) {
      throw new AnswerMarkupError(
        "Citation numbers must be positive integers within the supported numeric range.",
      );
    }
    if (maximumCitationNumber !== null && citationNumber > maximumCitationNumber) {
      throw new AnswerMarkupError(
        `The answer cited source number ${citationNumber}, but only source numbers 1 through ${maximumCitationNumber} are available.`,
      );
    }
  }
}

function appendTextSpan(spans: AnswerInlineSpan[], text: string): void {
  if (text === "") {
    return;
  }
  const last = spans.at(-1);
  if (last?.kind === "text") {
    last.text += text;
    return;
  }
  spans.push({ kind: "text", text });
}

function canonicalizeCitations(
  markdown: string,
  context: AnswerMarkupParseContext,
): string {
  const replacements: CitationReplacement[] = [];
  for (const citation of context.citations) {
    const replacement = citation.numbers.map((number) => `[${number}]`).join(" ");
    replacements.push({
      end: citation.sourceEnd,
      replacement,
      start: citation.sourceStart,
    });
  }
  for (const identifier of context.repairedLinkReferenceIdentifiers) {
    if (context.preservedLinkReferenceIdentifiers.has(identifier)) {
      continue;
    }
    const definition = context.definitions.get(identifier);
    if (definition !== undefined) {
      replacements.push(definition);
    }
  }
  replacements.sort((left, right) => right.start - left.start);
  let canonical = markdown;
  for (const replacement of replacements) {
    canonical = canonical.slice(0, replacement.start)
      + replacement.replacement
      + canonical.slice(replacement.end);
  }
  return canonical.trim();
}

function readUniqueCitationNumbers(
  citations: readonly AnswerCitationSpan[],
): number[] {
  const numbers: number[] = [];
  const seen = new Set<number>();
  for (const citation of citations) {
    for (const citationNumber of citation.numbers) {
      if (seen.has(citationNumber)) {
        continue;
      }
      seen.add(citationNumber);
      numbers.push(citationNumber);
    }
  }
  return numbers;
}

function isBoldOnlyParagraph(children: readonly PhrasingContent[]): boolean {
  let foundStrongContent = false;
  for (const child of children) {
    if (child.type === "text" && child.value.trim() === "") {
      continue;
    }
    if (child.type !== "strong") {
      return false;
    }
    foundStrongContent = true;
  }
  return foundStrongContent;
}

function readLeadingBoldListLabelLength(
  children: readonly PhrasingContent[],
): number {
  const firstChild = children[0];
  if (firstChild?.type !== "strong") {
    return 0;
  }
  let label = "";
  for (const child of firstChild.children) {
    if (child.type !== "text") {
      return 0;
    }
    label += child.value;
  }
  const normalizedLabel = label.trimEnd();
  if (
    normalizedLabel === ":"
    || !normalizedLabel.endsWith(":")
    || readCitationCandidates(label).length > 0
  ) {
    return 0;
  }
  return label.length;
}
