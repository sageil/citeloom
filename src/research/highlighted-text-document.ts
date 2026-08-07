import { TextDecoder } from "node:util";

import sniffHtmlEncoding from "html-encoding-sniffer";
import {
  parse,
  type DefaultTreeAdapterTypes,
} from "parse5";

import type { DocumentMediaType } from "../documents/format.js";
import { decodePlainTextDocument } from "../documents/plain-text.js";
import type { CitationEvidence } from "./types.js";

type HtmlChildNode = DefaultTreeAdapterTypes.ChildNode;
type HtmlElement = DefaultTreeAdapterTypes.Element;
type HtmlParentNode = DefaultTreeAdapterTypes.ParentNode;
type HtmlTextNode = DefaultTreeAdapterTypes.TextNode;

type HighlightableTextMediaType = Extract<
  DocumentMediaType,
  "text/html" | "text/plain"
>;

interface CanonicalTextSegment {
  canonicalEnd: number;
  canonicalStart: number;
  node: HtmlTextNode;
  sourceEnd: number;
  sourceStart: number;
}

interface CanonicalHtmlDocument {
  body: HtmlParentNode;
  segments: CanonicalTextSegment[];
  text: string;
}

interface HighlightRange {
  end: number;
  start: number;
}

interface TextMatch {
  end: number;
  start: number;
}

export interface HighlightedTextDocumentInput {
  content: Buffer;
  evidence: CitationEvidence;
  filename: string;
  mediaType: HighlightableTextMediaType;
  originalFileUrl: string;
}

export interface HighlightedTextDocumentResult {
  content: Buffer;
  highlighted: boolean;
}

const skippedHtmlElements = new Set([
  "base",
  "canvas",
  "embed",
  "frame",
  "frameset",
  "iframe",
  "link",
  "meta",
  "noscript",
  "object",
  "script",
  "style",
  "template",
]);

const blockHtmlElements = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "body",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const renderedHtmlElements = new Set([
  "abbr",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "dd",
  "del",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "ins",
  "kbd",
  "li",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
  "var",
]);

const voidHtmlElements = new Set(["br", "hr"]);
const htmlWhitespacePattern = /\s/u;

export function renderHighlightedTextDocument(
  input: HighlightedTextDocumentInput,
): HighlightedTextDocumentResult {
  if (input.mediaType === "text/plain") {
    return renderHighlightedPlainText(input);
  }
  return renderHighlightedHtml(input);
}

function renderHighlightedPlainText(
  input: HighlightedTextDocumentInput,
): HighlightedTextDocumentResult {
  const source = decodePlainTextDocument(input.content, input.filename);
  const selectors = readPlainTextEvidenceSelectors(input.evidence);
  const match = findUniqueTextMatch(source, selectors);
  let renderedSource = escapeHtml(source);
  if (match !== null) {
    const before = escapeHtml(source.slice(0, match.start));
    const evidence = escapeHtml(source.slice(match.start, match.end));
    const after = escapeHtml(source.slice(match.end));
    renderedSource = `${before}<mark class="citeloom-evidence-highlight" id="citeloom-evidence">${evidence}</mark>${after}`;
  }
  const body = `<pre class="plain-text-source">${renderedSource}</pre>`;
  return buildViewerDocument(input, body, match !== null);
}

function renderHighlightedHtml(
  input: HighlightedTextDocumentInput,
): HighlightedTextDocumentResult {
  const source = decodeHtmlDocument(input.content, input.filename);
  const document = parse(source);
  const canonical = createCanonicalHtmlDocument(document);
  const selectors = readHtmlEvidenceSelectors(input.evidence);
  const match = findUniqueTextMatch(canonical.text, selectors);
  const highlights = match === null
    ? new Map<HtmlTextNode, HighlightRange>()
    : createHtmlHighlightRanges(canonical.segments, match);
  const rendered = renderSafeHtmlChildren(canonical.body, highlights);
  return buildViewerDocument(input, rendered, match !== null);
}

function decodeHtmlDocument(content: Buffer, filename: string): string {
  const encoding = sniffHtmlEncoding(content, { defaultEncoding: "UTF-8" });
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(content);
  } catch (error: unknown) {
    throw new Error(`HTML source encoding is invalid for ${filename}: ${encoding}`, {
      cause: error,
    });
  }
}

function createCanonicalHtmlDocument(
  document: DefaultTreeAdapterTypes.Document,
): CanonicalHtmlDocument {
  const body = findHtmlBody(document) ?? document;
  const builder = new CanonicalHtmlTextBuilder();
  builder.appendChildren(body);
  return {
    body,
    segments: builder.segments,
    text: builder.text.trim(),
  };
}

class CanonicalHtmlTextBuilder {
  public readonly segments: CanonicalTextSegment[] = [];
  public text = "";
  private boundaryPending = false;

  public appendChildren(parent: HtmlParentNode): void {
    for (const child of parent.childNodes) {
      this.appendNode(child);
    }
  }

  private appendNode(node: HtmlChildNode): void {
    if (isHtmlTextNode(node)) {
      this.appendText(node);
      return;
    }
    if (!isHtmlElement(node) || skippedHtmlElements.has(node.tagName)) {
      return;
    }
    const block = blockHtmlElements.has(node.tagName);
    if (block || node.tagName === "br") {
      this.requestBoundary();
    }
    this.appendChildren(node);
    if (block || node.tagName === "br") {
      this.requestBoundary();
    }
  }

  private appendText(node: HtmlTextNode): void {
    let runStart: number | null = null;
    for (let index = 0; index < node.value.length; index += 1) {
      const character = node.value[index];
      if (character === undefined) {
        continue;
      }
      if (htmlWhitespacePattern.test(character)) {
        if (runStart !== null) {
          this.appendRun(node, runStart, index);
          runStart = null;
        }
        this.requestBoundary();
        continue;
      }
      if (runStart === null) {
        runStart = index;
      }
    }
    if (runStart !== null) {
      this.appendRun(node, runStart, node.value.length);
    }
  }

  private appendRun(node: HtmlTextNode, start: number, end: number): void {
    if (this.boundaryPending && this.text !== "") {
      this.text += " ";
    }
    this.boundaryPending = false;
    const canonicalStart = this.text.length;
    this.text += normalizeComparablePunctuation(node.value.slice(start, end));
    this.segments.push({
      canonicalEnd: this.text.length,
      canonicalStart,
      node,
      sourceEnd: end,
      sourceStart: start,
    });
  }

  private requestBoundary(): void {
    if (this.text !== "") {
      this.boundaryPending = true;
    }
  }
}

function readHtmlEvidenceSelectors(evidence: CitationEvidence): string[] {
  if (evidence.kind === "image") {
    return [];
  }
  const selectors: string[] = [];
  const primary = evidence.kind === "text" ? evidence.excerpt : evidence.content;
  appendSelector(selectors, primary);
  if (evidence.kind === "table") {
    const cells = [...evidence.table.cells].sort((left, right) => {
      if (left.startRow !== right.startRow) {
        return left.startRow - right.startRow;
      }
      return left.startColumn - right.startColumn;
    });
    appendSelector(selectors, cells.map((cell) => cell.text).join(" "));
  }
  appendSelector(selectors, removeIndexedTextFormatting(primary));
  return selectors;
}

function readPlainTextEvidenceSelectors(evidence: CitationEvidence): string[] {
  if (evidence.kind === "image") {
    return [];
  }
  const selectors = [
    evidence.kind === "text" ? evidence.excerpt : evidence.content,
  ];
  return selectors.filter((selector) => selector !== "");
}

function appendSelector(selectors: string[], value: string): void {
  const normalized = normalizeSelectorText(value);
  if (normalized !== "" && !selectors.includes(normalized)) {
    selectors.push(normalized);
  }
}

function normalizeSelectorText(value: string): string {
  return normalizeComparablePunctuation(value).replace(/\s+/gu, " ").trim();
}

function normalizeComparablePunctuation(value: string): string {
  return value
    .replace(/[\u2010-\u2015\u2212]/gu, "-")
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201c\u201d]/gu, '"');
}

function removeIndexedTextFormatting(value: string): string {
  const lines = value.split("\n");
  const normalized: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "```") {
      continue;
    }
    normalized.push(line.replace(/^\s*-\s+/u, ""));
  }
  return normalized.join("\n");
}

function findUniqueTextMatch(source: string, selectors: readonly string[]): TextMatch | null {
  for (const selector of selectors) {
    const start = source.indexOf(selector);
    if (start < 0) {
      continue;
    }
    if (source.indexOf(selector, start + 1) >= 0) {
      return null;
    }
    return { end: start + selector.length, start };
  }
  return null;
}

function createHtmlHighlightRanges(
  segments: readonly CanonicalTextSegment[],
  match: TextMatch,
): Map<HtmlTextNode, HighlightRange> {
  const ranges = new Map<HtmlTextNode, HighlightRange>();
  for (const segment of segments) {
    const overlapStart = Math.max(match.start, segment.canonicalStart);
    const overlapEnd = Math.min(match.end, segment.canonicalEnd);
    if (overlapEnd <= overlapStart) {
      continue;
    }
    const sourceStart = segment.sourceStart
      + overlapStart
      - segment.canonicalStart;
    const sourceEnd = segment.sourceStart
      + overlapEnd
      - segment.canonicalStart;
    const current = ranges.get(segment.node);
    if (current === undefined) {
      ranges.set(segment.node, { end: sourceEnd, start: sourceStart });
      continue;
    }
    current.start = Math.min(current.start, sourceStart);
    current.end = Math.max(current.end, sourceEnd);
  }
  return ranges;
}

function renderSafeHtmlChildren(
  parent: HtmlParentNode,
  highlights: ReadonlyMap<HtmlTextNode, HighlightRange>,
): string {
  const renderer = new SafeHtmlRenderer(highlights);
  return renderer.renderChildren(parent);
}

class SafeHtmlRenderer {
  private highlightAnchorWritten = false;
  private readonly parts: string[] = [];

  public constructor(
    private readonly highlights: ReadonlyMap<HtmlTextNode, HighlightRange>,
  ) {}

  public renderChildren(parent: HtmlParentNode): string {
    for (const child of parent.childNodes) {
      this.renderNode(child);
    }
    return this.parts.join("");
  }

  private renderNode(node: HtmlChildNode): void {
    if (isHtmlTextNode(node)) {
      this.renderText(node);
      return;
    }
    if (!isHtmlElement(node) || skippedHtmlElements.has(node.tagName)) {
      return;
    }
    if (!renderedHtmlElements.has(node.tagName)) {
      for (const child of node.childNodes) {
        this.renderNode(child);
      }
      return;
    }
    this.parts.push(`<${node.tagName}${renderSafeAttributes(node)}>`);
    if (!voidHtmlElements.has(node.tagName)) {
      for (const child of node.childNodes) {
        this.renderNode(child);
      }
      this.parts.push(`</${node.tagName}>`);
    }
  }

  private renderText(node: HtmlTextNode): void {
    const range = this.highlights.get(node);
    if (range === undefined) {
      this.parts.push(escapeHtml(node.value));
      return;
    }
    this.parts.push(escapeHtml(node.value.slice(0, range.start)));
    const anchor = this.highlightAnchorWritten
      ? ""
      : ' id="citeloom-evidence"';
    this.highlightAnchorWritten = true;
    this.parts.push(`<mark class="citeloom-evidence-highlight"${anchor}>`);
    this.parts.push(escapeHtml(node.value.slice(range.start, range.end)));
    this.parts.push("</mark>");
    this.parts.push(escapeHtml(node.value.slice(range.end)));
  }
}

function renderSafeAttributes(element: HtmlElement): string {
  if (element.tagName !== "td" && element.tagName !== "th") {
    return "";
  }
  const parts: string[] = [];
  for (const attribute of element.attrs) {
    if (
      (attribute.name === "colspan" || attribute.name === "rowspan")
      && /^[1-9][0-9]{0,2}$/u.test(attribute.value)
    ) {
      parts.push(` ${attribute.name}="${attribute.value}"`);
    }
  }
  return parts.join("");
}

function findHtmlBody(
  parent: HtmlParentNode,
): HtmlElement | null {
  for (const child of parent.childNodes) {
    if (!isHtmlElement(child)) {
      continue;
    }
    if (child.tagName === "body") {
      return child;
    }
    const nested = findHtmlBody(child);
    if (nested !== null) {
      return nested;
    }
  }
  return null;
}

function isHtmlTextNode(node: HtmlChildNode): node is HtmlTextNode {
  return node.nodeName === "#text";
}

function isHtmlElement(node: HtmlChildNode): node is HtmlElement {
  return "tagName" in node;
}

function buildViewerDocument(
  input: HighlightedTextDocumentInput,
  renderedSource: string,
  highlighted: boolean,
): HighlightedTextDocumentResult {
  const status = highlighted
    ? "The exact indexed evidence is highlighted below."
    : "The indexed evidence did not have one unambiguous match in this stored version. The complete inert source is shown without a highlight.";
  const document = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Evidence in ${escapeHtml(input.filename)}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    html { scroll-padding-top: 6rem; }
    body { background: #0a1020; color: #dbe5f5; line-height: 1.6; margin: 0; }
    .evidence-header { align-items: center; backdrop-filter: blur(12px); background: rgba(10, 16, 32, .96); border-bottom: 1px solid #334155; display: flex; gap: 1rem; justify-content: space-between; padding: 1rem 1.5rem; position: sticky; top: 0; z-index: 10; }
    .evidence-header-copy { min-width: 0; }
    .evidence-header strong, .evidence-header span { display: block; }
    .evidence-header span { color: #94a3b8; font-size: .875rem; overflow-wrap: anywhere; }
    .evidence-header a { border: 1px solid #475569; border-radius: .4rem; color: #67e8f9; padding: .45rem .75rem; text-decoration: none; white-space: nowrap; }
    .evidence-status { background: ${highlighted ? "#12372d" : "#3b2a13"}; border-bottom: 1px solid ${highlighted ? "#1f765d" : "#8a5a18"}; color: ${highlighted ? "#a7f3d0" : "#fde68a"}; margin: 0; padding: .7rem 1.5rem; }
    .source-document { margin: 0 auto; max-width: 78rem; overflow-wrap: anywhere; padding: 2rem; }
    .source-document table { border-collapse: collapse; max-width: 100%; }
    .source-document td, .source-document th { border: 1px solid #475569; padding: .45rem .6rem; text-align: left; }
    .source-document pre, .source-document code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }
    .source-document pre { overflow-x: auto; white-space: pre-wrap; }
    .source-document .citeloom-evidence-highlight { background: #facc15; box-decoration-break: clone; color: #111827; outline: .12rem solid #f59e0b; scroll-margin-top: 7rem; }
    .plain-text-source { margin: 0; }
    @media (prefers-color-scheme: light) {
      body { background: #f8fafc; color: #172033; }
      .evidence-header { background: rgba(248, 250, 252, .96); border-color: #cbd5e1; }
      .evidence-header a { border-color: #94a3b8; color: #0369a1; }
      .source-document td, .source-document th { border-color: #cbd5e1; }
    }
  </style>
</head>
<body>
  <header class="evidence-header">
    <div class="evidence-header-copy"><strong>Exact evidence</strong><span>${escapeHtml(input.filename)}</span></div>
    <a href="${escapeHtmlAttribute(input.originalFileUrl)}" rel="noopener noreferrer">Open original</a>
  </header>
  <p class="evidence-status">${escapeHtml(status)}</p>
  <main class="source-document">${renderedSource}</main>
</body>
</html>`;
  return {
    content: Buffer.from(document, "utf8"),
    highlighted,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}
