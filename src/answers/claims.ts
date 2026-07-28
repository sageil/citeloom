import type {
  AnswerInlineSpan,
  AnswerMarkdownBlock,
  ParsedAnswerMarkup,
} from "./markup.js";
import type { AnswerClaim } from "../research/types.js";

const ALWAYS_NON_TERMINAL_ABBREVIATIONS = new Set([
  "a.c",
  "art",
  "arts",
  "cf",
  "ch",
  "chs",
  "cir",
  "ct",
  "dept",
  "d.l.r",
  "dr",
  "e.g",
  "ed",
  "eds",
  "e.r",
  "ex",
  "f.c",
  "f.c.r",
  "f.supp",
  "fam",
  "fig",
  "figs",
  "hon",
  "i.e",
  "k.b",
  "l.ed",
  "mr",
  "mrs",
  "ms",
  "no",
  "nos",
  "p",
  "para",
  "paras",
  "pp",
  "prof",
  "q.b",
  "rev",
  "s.c.r",
  "s.ct",
  "sec",
  "secs",
  "supp",
  "u.k",
  "u.s",
  "v",
  "vol",
  "vols",
  "vs",
  "w.l.r",
]);

const NAME_PREFIX_ABBREVIATIONS = new Set([
  "dept",
  "dr",
  "hon",
  "mr",
  "mrs",
  "ms",
  "prof",
  "rev",
]);

const CONNECTOR_ABBREVIATIONS = new Set([
  "cf",
  "ex",
  "v",
  "vs",
]);

const LABEL_ABBREVIATIONS = new Set([
  "art",
  "arts",
  "ch",
  "chs",
  "fig",
  "figs",
  "no",
  "nos",
  "para",
  "paras",
  "sec",
  "secs",
  "vol",
  "vols",
]);

const UPPERCASE_ABBREVIATION_CONTINUATIONS = new Map<string, ReadonlySet<string>>([
  ["cir", new Set(["Court"])],
  ["ct", new Set(["App", "Appeal", "Crim"])],
  ["u.k", new Set(["Constitution", "Court", "Government", "Parliament", "Supreme"])],
  ["u.s", new Set([
    "Code",
    "Congress",
    "Constitution",
    "Court",
    "Department",
    "District",
    "Government",
    "House",
    "Patent",
    "Senate",
    "Supreme",
  ])],
]);

const CONDITIONAL_ABBREVIATIONS = new Set([
  "co",
  "corp",
  "inc",
  "intl",
  "jr",
  "llc",
  "llp",
  "ltd",
  "plc",
  "sr",
]);

interface FlattenedCitation {
  end: number;
  numbers: number[];
  start: number;
}

interface FlattenedInlineSpans {
  citations: FlattenedCitation[];
  text: string;
}

interface SentenceRange {
  end: number;
  start: number;
}

type ClaimBearingBlock = Extract<
  AnswerMarkdownBlock,
  { kind: "list-item" | "paragraph" | "table-row" }
>;

export interface LocatedAnswerClaim extends AnswerClaim {
  blockIndex: number;
}

export function readClaimsFromAnswerMarkup(
  markup: ParsedAnswerMarkup,
): AnswerClaim[] {
  const locatedClaims = readLocatedClaimsFromAnswerMarkup(markup);
  const claims: AnswerClaim[] = [];
  for (const locatedClaim of locatedClaims) {
    claims.push({
      citationNumbers: locatedClaim.citationNumbers,
      claim: locatedClaim.claim,
      claimIndex: locatedClaim.claimIndex,
    });
  }
  return claims;
}

export function readLocatedClaimsFromAnswerMarkup(
  markup: ParsedAnswerMarkup,
): LocatedAnswerClaim[] {
  const claims: LocatedAnswerClaim[] = [];
  for (let blockIndex = 0; blockIndex < markup.blocks.length; blockIndex += 1) {
    const block = markup.blocks[blockIndex];
    if (block === undefined || !isClaimBearingBlock(block)) {
      continue;
    }
    if (isPseudoHeading(block)) {
      continue;
    }
    const spans = readClaimBlockSpans(block);
    const followedByStructure = isFollowedByStructure(markup.blocks, blockIndex);
    appendClaimsFromSpans(claims, spans, followedByStructure, blockIndex);
  }
  return claims;
}

function isClaimBearingBlock(
  block: AnswerMarkdownBlock,
): block is ClaimBearingBlock {
  if (block.kind === "paragraph" || block.kind === "list-item") {
    return true;
  }
  return block.kind === "table-row" && !block.header;
}

function isPseudoHeading(block: ClaimBearingBlock): boolean {
  return block.kind === "paragraph" && block.boldOnly;
}

function isFollowedByStructure(
  blocks: readonly AnswerMarkdownBlock[],
  blockIndex: number,
): boolean {
  const block = blocks[blockIndex];
  if (block?.kind !== "paragraph") {
    return false;
  }
  for (let index = blockIndex + 1; index < blocks.length; index += 1) {
    const next = blocks[index];
    if (next === undefined || next.kind === "thematic-break") {
      continue;
    }
    if (next.kind === "heading" || next.kind === "list-item" || next.kind === "table-row") {
      return true;
    }
    if (next.kind === "paragraph" && next.boldOnly) {
      return true;
    }
    return false;
  }
  return false;
}

function readClaimBlockSpans(block: ClaimBearingBlock): AnswerInlineSpan[] {
  if (block.kind === "paragraph") {
    return block.spans;
  }
  if (block.kind === "list-item") {
    return removeLeadingListLabel(block.spans, block.leadingLabelLength);
  }
  const spans: AnswerInlineSpan[] = [];
  for (let cellIndex = 0; cellIndex < block.cells.length; cellIndex += 1) {
    const cell = block.cells[cellIndex];
    if (cell === undefined) {
      continue;
    }
    if (cellIndex > 0) {
      appendTextSpan(spans, "; ");
    }
    for (const span of cell) {
      if (span.kind === "text") {
        appendTextSpan(spans, span.text);
      } else {
        spans.push(span);
      }
    }
  }
  return spans;
}

function removeLeadingListLabel(
  spans: readonly AnswerInlineSpan[],
  leadingLabelLength: number,
): AnswerInlineSpan[] {
  if (leadingLabelLength === 0) {
    return [...spans];
  }
  const claimSpans: AnswerInlineSpan[] = [];
  let remainingLabelLength = leadingLabelLength;
  for (const span of spans) {
    if (remainingLabelLength === 0) {
      claimSpans.push(span);
      continue;
    }
    if (span.kind === "citation") {
      throw new Error("A structural list label cannot contain a citation.");
    }
    if (span.text.length <= remainingLabelLength) {
      remainingLabelLength -= span.text.length;
      continue;
    }
    appendTextSpan(claimSpans, span.text.slice(remainingLabelLength));
    remainingLabelLength = 0;
  }
  if (remainingLabelLength !== 0) {
    throw new Error("A structural list label exceeds its parsed list item.");
  }
  return claimSpans;
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

function appendClaimsFromSpans(
  claims: LocatedAnswerClaim[],
  spans: readonly AnswerInlineSpan[],
  followedByStructure: boolean,
  blockIndex: number,
): void {
  const flattened = flattenInlineSpans(spans);
  const sentenceRanges = readSentenceRanges(flattened);
  for (let index = 0; index < sentenceRanges.length; index += 1) {
    const sentenceRange = sentenceRanges[index];
    if (sentenceRange === undefined) {
      continue;
    }
    const claim = readClaimText(flattened, sentenceRange);
    if (claim === "" || !/[\p{L}\p{N}]/u.test(claim)) {
      continue;
    }
    const citationNumbers = readSentenceCitationNumbers(flattened, sentenceRange);
    const isFinalSentence = index === sentenceRanges.length - 1;
    if (
      followedByStructure
      && isFinalSentence
      && citationNumbers.length === 0
      && isStructuralLeadIn(claim)
    ) {
      continue;
    }
    claims.push({
      blockIndex,
      citationNumbers,
      claim,
      claimIndex: claims.length,
    });
  }
}

function isStructuralLeadIn(claim: string): boolean {
  if (claim.endsWith(":")) {
    return true;
  }
  const normalized = claim
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (/\b(?:is|are|was|were)\s+as\s+follows$/u.test(normalized)) {
    return true;
  }
  if (/\b(?:include|includes|included|comprise|comprises|comprised)\s+the\s+following$/u.test(normalized)) {
    return true;
  }
  return /\b(?:listed|shown|summarized|described|provided|set\s+out)\s+below$/u.test(normalized);
}

function flattenInlineSpans(
  spans: readonly AnswerInlineSpan[],
): FlattenedInlineSpans {
  let text = "";
  const citations: FlattenedCitation[] = [];
  for (const span of spans) {
    if (span.kind === "text") {
      text += span.text;
      continue;
    }
    const marker = span.numbers.map((number) => `[${number}]`).join(" ");
    const start = text.length;
    text += marker;
    citations.push({ end: text.length, numbers: span.numbers, start });
  }
  return { citations, text };
}

function readSentenceRanges(flattened: FlattenedInlineSpans): SentenceRange[] {
  const ranges: SentenceRange[] = [];
  let sentenceStart = 0;
  let index = 0;
  while (index < flattened.text.length) {
    const character = flattened.text[index];
    if (character === undefined || !isTerminalPunctuation(character)) {
      index += 1;
      continue;
    }
    if (character === "." && isNonTerminalPeriod(flattened, index)) {
      index += 1;
      continue;
    }
    const sentenceEnd = readSentenceEndAfterCitations(flattened, index + 1);
    ranges.push({ end: sentenceEnd, start: sentenceStart });
    sentenceStart = sentenceEnd;
    index = sentenceEnd;
  }
  if (sentenceStart < flattened.text.length) {
    ranges.push({ end: flattened.text.length, start: sentenceStart });
  }
  return ranges;
}

function isTerminalPunctuation(character: string): boolean {
  return character === "." || character === "!" || character === "?";
}

function isNonTerminalPeriod(
  flattened: FlattenedInlineSpans,
  periodIndex: number,
): boolean {
  const previous = flattened.text[periodIndex - 1] ?? "";
  const immediateNext = flattened.text[periodIndex + 1] ?? "";
  if (/\d/.test(previous) && /\d/.test(immediateNext)) {
    return true;
  }
  if (/[\p{L}\p{N}]/u.test(immediateNext)) {
    return true;
  }
  if (immediateNext === ".") {
    return true;
  }
  const next = readNextContent(flattened, periodIndex + 1);
  if (next.citationImmediatelyFollows || next.index >= flattened.text.length) {
    return false;
  }
  const token = readTokenBeforePeriod(flattened.text, periodIndex);
  if (/^\p{Lu}$/u.test(token)) {
    return true;
  }
  const normalizedToken = token.toLowerCase();
  const nextCharacter = flattened.text[next.index] ?? "";
  if (CONDITIONAL_ABBREVIATIONS.has(normalizedToken)) {
    return /[\p{Ll}\p{N}]/u.test(nextCharacter);
  }
  if (!ALWAYS_NON_TERMINAL_ABBREVIATIONS.has(normalizedToken)) {
    return false;
  }
  if (/[\p{Ll}\p{N}]/u.test(nextCharacter)) {
    return true;
  }
  if (/[,;:)\]]/u.test(nextCharacter)) {
    return true;
  }
  if (!/\p{Lu}/u.test(nextCharacter)) {
    return false;
  }
  if (
    NAME_PREFIX_ABBREVIATIONS.has(normalizedToken)
    || CONNECTOR_ABBREVIATIONS.has(normalizedToken)
  ) {
    return true;
  }
  const nextToken = readTokenAt(flattened.text, next.index);
  if (LABEL_ABBREVIATIONS.has(normalizedToken) && isRomanNumeral(nextToken)) {
    return true;
  }
  const continuations = UPPERCASE_ABBREVIATION_CONTINUATIONS.get(normalizedToken);
  return continuations?.has(nextToken) === true;
}

function readTokenAt(value: string, start: number): string {
  let end = start;
  while (/\p{L}/u.test(value[end] ?? "")) {
    end += 1;
  }
  return value.slice(start, end);
}

function isRomanNumeral(value: string): boolean {
  return value !== "" && /^[IVXLCDM]+$/u.test(value);
}

function readNextContent(
  flattened: FlattenedInlineSpans,
  start: number,
): { citationImmediatelyFollows: boolean; index: number } {
  let index = start;
  while (/\s/.test(flattened.text[index] ?? "")) {
    index += 1;
  }
  let citationImmediatelyFollows = false;
  for (const citation of flattened.citations) {
    if (citation.start === index) {
      citationImmediatelyFollows = true;
      break;
    }
  }
  return { citationImmediatelyFollows, index };
}

function readTokenBeforePeriod(value: string, periodIndex: number): string {
  let start = periodIndex - 1;
  while (start >= 0 && /[\p{L}\p{N}.]/u.test(value[start] ?? "")) {
    start -= 1;
  }
  return value.slice(start + 1, periodIndex);
}

function readSentenceEndAfterCitations(
  flattened: FlattenedInlineSpans,
  start: number,
): number {
  let end = start;
  while (/["'\u2019\u201d]/u.test(flattened.text[end] ?? "")) {
    end += 1;
  }
  let cursor = end;
  while (/[\t ]/.test(flattened.text[cursor] ?? "")) {
    cursor += 1;
  }
  let foundCitation = false;
  while (true) {
    let matchingCitation: FlattenedCitation | null = null;
    for (const citation of flattened.citations) {
      if (citation.start === cursor) {
        matchingCitation = citation;
        break;
      }
    }
    if (matchingCitation === null) {
      break;
    }
    foundCitation = true;
    end = matchingCitation.end;
    cursor = matchingCitation.end;
    while (/[\t ]/.test(flattened.text[cursor] ?? "")) {
      cursor += 1;
    }
  }
  if (foundCitation) {
    return cursor;
  }
  while (/\s/.test(flattened.text[end] ?? "")) {
    end += 1;
  }
  return end;
}

function readClaimText(
  flattened: FlattenedInlineSpans,
  sentence: SentenceRange,
): string {
  let text = flattened.text.slice(sentence.start, sentence.end);
  const citations = flattened.citations
    .filter((citation) => citation.start >= sentence.start && citation.end <= sentence.end)
    .sort((left, right) => right.start - left.start);
  for (const citation of citations) {
    const relativeStart = citation.start - sentence.start;
    const relativeEnd = citation.end - sentence.start;
    text = text.slice(0, relativeStart) + text.slice(relativeEnd);
  }
  return normalizeProjectedText(text);
}

function readSentenceCitationNumbers(
  flattened: FlattenedInlineSpans,
  sentence: SentenceRange,
): number[] {
  const numbers: number[] = [];
  const seen = new Set<number>();
  for (const citation of flattened.citations) {
    if (citation.start < sentence.start || citation.end > sentence.end) {
      continue;
    }
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

function normalizeProjectedText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/[\t ]+([,.;:!?])/g, "$1")
    .trim();
}
