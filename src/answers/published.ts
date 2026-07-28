import { randomUUID } from "node:crypto";

import type {
  AnswerDraft,
  AnswerDraftConflictGroup,
  AnswerPresentation,
  AnswerSection,
} from "./draft.js";
import {
  ANSWER_DRAFT_SECTIONS,
  renderAnswerDraftConflictScope,
} from "./draft.js";
import type { RetrievedElement } from "../retrieval/document-retrieval.js";
import {
  createNoAnswerDocument,
  decodePublishedAnswerDocument,
  NO_ANSWER_TEXT,
  type PublishedAnswerCitation,
  type PublishedAnswerDocument,
  type PublishedAnswerStatement,
} from "./published-schema.js";
import type {
  AnswerClaim,
  CitationEvidence,
} from "../research/types.js";
import type { RetrievalSourceElement } from "../domain/source-elements.js";

export {
  createNoAnswerDocument,
  decodePublishedAnswerDocument,
  NO_ANSWER_TEXT,
  publishedAnswerCitationSchema,
  publishedAnswerDocumentSchema,
  type PublishedAnswerCitation,
  type PublishedAnswerDocument,
  type PublishedAnswerStatement,
} from "./published-schema.js";

export class AnswerDraftSourceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AnswerDraftSourceError";
  }
}

interface PreparedDraftStatement {
  sourceNumbers: number[];
  statement: PublishedDraftStatement;
}

interface PublishedDraftStatement {
  content: string;
  presentation: AnswerPresentation;
  section: AnswerSection;
}

interface SelectedSource {
  item: RetrievedElement;
  sourceNumber: number;
}

export function compileAnswerDraft(
  draft: AnswerDraft,
  retrieved: readonly RetrievedElement[],
): PublishedAnswerDocument {
  if (draft.status === "no_answer") {
    return createNoAnswerDocument();
  }
  const preparedStatements = prepareDraftStatements(draft, retrieved);
  const referencedNumbers = new Set<number>();
  for (const prepared of preparedStatements) {
    for (const sourceNumber of prepared.sourceNumbers) {
      referencedNumbers.add(sourceNumber);
    }
  }
  const citationBySourceNumber = new Map<number, PublishedAnswerCitation>();
  const citations: PublishedAnswerCitation[] = [];
  for (let index = 0; index < retrieved.length; index += 1) {
    const sourceNumber = index + 1;
    if (!referencedNumbers.has(sourceNumber)) {
      continue;
    }
    const item = requireRetrievedSource(retrieved, sourceNumber);
    const citationNumber = citations.length + 1;
    const citation = createPublishedCitation(item, citationNumber);
    citations.push(citation);
    citationBySourceNumber.set(sourceNumber, citation);
  }
  const statements: PublishedAnswerStatement[] = [];
  for (const section of ANSWER_DRAFT_SECTIONS) {
    for (const prepared of preparedStatements) {
      const draftStatement = prepared.statement;
      if (draftStatement.section !== section) {
        continue;
      }
      const citationIds: string[] = [];
      for (const sourceNumber of prepared.sourceNumbers) {
        const citation = citationBySourceNumber.get(sourceNumber);
        if (citation === undefined) {
          throw new AnswerDraftSourceError(
            `Answer statement references unavailable source ${sourceNumber}.`,
          );
        }
        citationIds.push(citation.id);
      }
      statements.push({
        citationIds,
        content: draftStatement.content,
        presentation: draftStatement.presentation,
        section: draftStatement.section,
      });
    }
  }
  appendConflictStatements(statements, preparedStatements, citationBySourceNumber);
  return decodePublishedAnswerDocument({
    citations,
    schemaVersion: 1,
    statements,
    status: "answered",
  });
}

function prepareDraftStatements(
  draft: Extract<AnswerDraft, { status: "answered" }>,
  retrieved: readonly RetrievedElement[],
): PreparedDraftStatement[] {
  const canonicalSourceNumbers = createCanonicalSourceNumbers(retrieved);
  const preparedStatements: PreparedDraftStatement[] = [];
  for (const statement of draft.statements) {
    preparedStatements.push({
      sourceNumbers: compactStatementSources(
        statement.sourceNumbers,
        retrieved,
        canonicalSourceNumbers,
      ),
      statement,
    });
  }
  const seenConflictGroups = new Set<string>();
  for (const group of draft.conflictGroups) {
    const groupKey = createConflictGroupKey(group);
    if (seenConflictGroups.has(groupKey)) {
      continue;
    }
    seenConflictGroups.add(groupKey);
    appendPreparedConflictGroup(
      preparedStatements,
      group,
      retrieved,
      canonicalSourceNumbers,
    );
  }
  return preparedStatements;
}

function createConflictGroupKey(group: AnswerDraftConflictGroup): string {
  const positions = [];
  for (const position of group.positions) {
    positions.push({
      claim: position.claim.toLowerCase(),
      sourceNumbers: [...position.sourceNumbers].sort((left, right) => left - right),
    });
  }
  positions.sort((left, right) => left.claim.localeCompare(right.claim));
  return JSON.stringify({
    positions,
    sharedScope: {
      conditions: group.sharedScope.conditions.toLowerCase(),
      context: group.sharedScope.context.toLowerCase(),
      scope: group.sharedScope.scope.toLowerCase(),
      timePeriod: group.sharedScope.timePeriod.toLowerCase(),
    },
  });
}

function appendPreparedConflictGroup(
  preparedStatements: PreparedDraftStatement[],
  group: AnswerDraftConflictGroup,
  retrieved: readonly RetrievedElement[],
  canonicalSourceNumbers: ReadonlyMap<string, number>,
): void {
  const groupSourceNumbers: number[] = [];
  const seenGroupSources = new Set<number>();
  for (const position of group.positions) {
    const sourceNumbers = compactStatementSources(
      position.sourceNumbers,
      retrieved,
      canonicalSourceNumbers,
    );
    for (const sourceNumber of sourceNumbers) {
      if (!seenGroupSources.has(sourceNumber)) {
        seenGroupSources.add(sourceNumber);
        groupSourceNumbers.push(sourceNumber);
      }
    }
  }
  preparedStatements.push({
    sourceNumbers: groupSourceNumbers,
    statement: {
      content: renderAnswerDraftConflictScope(group.sharedScope),
      presentation: "paragraph",
      section: "conflicting-evidence",
    },
  });
  for (const position of group.positions) {
    preparedStatements.push({
      sourceNumbers: compactStatementSources(
        position.sourceNumbers,
        retrieved,
        canonicalSourceNumbers,
      ),
      statement: {
        content: position.claim,
        presentation: "bullet",
        section: "conflicting-evidence",
      },
    });
  }
  preparedStatements.push({
    sourceNumbers: groupSourceNumbers,
    statement: {
      content: group.explanation,
      presentation: "paragraph",
      section: "conflicting-evidence",
    },
  });
}

function appendConflictStatements(
  statements: PublishedAnswerStatement[],
  preparedStatements: readonly PreparedDraftStatement[],
  citationBySourceNumber: ReadonlyMap<number, PublishedAnswerCitation>,
): void {
  for (const prepared of preparedStatements) {
    if (prepared.statement.section !== "conflicting-evidence") {
      continue;
    }
    const citationIds: string[] = [];
    for (const sourceNumber of prepared.sourceNumbers) {
      const citation = citationBySourceNumber.get(sourceNumber);
      if (citation === undefined) {
        throw new AnswerDraftSourceError(
          `Answer statement references unavailable source ${sourceNumber}.`,
        );
      }
      citationIds.push(citation.id);
    }
    statements.push({
      citationIds,
      content: prepared.statement.content,
      presentation: prepared.statement.presentation,
      section: prepared.statement.section,
    });
  }
}

function createCanonicalSourceNumbers(
  retrieved: readonly RetrievedElement[],
): ReadonlyMap<string, number> {
  const canonicalSourceNumbers = new Map<string, number>();
  for (let index = 0; index < retrieved.length; index += 1) {
    const item = retrieved[index];
    if (item === undefined) {
      throw new AnswerDraftSourceError(`Missing retrieved source ${index + 1}.`);
    }
    const key = createRetrievedElementKey(item);
    if (!canonicalSourceNumbers.has(key)) {
      canonicalSourceNumbers.set(key, index + 1);
    }
  }
  return canonicalSourceNumbers;
}

function compactStatementSources(
  sourceNumbers: readonly number[],
  retrieved: readonly RetrievedElement[],
  canonicalSourceNumbers: ReadonlyMap<string, number>,
): number[] {
  const selectedSources: SelectedSource[] = [];
  const seenSourceNumbers = new Set<number>();
  for (const sourceNumber of sourceNumbers) {
    const item = requireRetrievedSource(retrieved, sourceNumber);
    const key = createRetrievedElementKey(item);
    const canonicalSourceNumber = canonicalSourceNumbers.get(key);
    if (canonicalSourceNumber === undefined) {
      throw new AnswerDraftSourceError(
        `Answer statement references unavailable source ${sourceNumber}.`,
      );
    }
    if (seenSourceNumbers.has(canonicalSourceNumber)) {
      continue;
    }
    seenSourceNumbers.add(canonicalSourceNumber);
    selectedSources.push({
      item: requireRetrievedSource(retrieved, canonicalSourceNumber),
      sourceNumber: canonicalSourceNumber,
    });
  }

  const compacted: number[] = [];
  for (const selected of selectedSources) {
    if (isRedundantStandaloneImage(selected, selectedSources)) {
      continue;
    }
    compacted.push(selected.sourceNumber);
  }
  return compacted;
}

function isRedundantStandaloneImage(
  selected: SelectedSource,
  allSelected: readonly SelectedSource[],
): boolean {
  const element = selected.item.element;
  if (element.kind !== "image" || !element.sourceRefs.includes("source-image")) {
    return false;
  }
  for (const candidate of allSelected) {
    if (candidate.sourceNumber === selected.sourceNumber) {
      continue;
    }
    if (candidate.item.element.kind === "image") {
      continue;
    }
    if (!areSourcesFromSameVersion(selected.item, candidate.item)) {
      continue;
    }
    if (haveSharedPage(element, candidate.item.element)) {
      return true;
    }
  }
  return false;
}

function areSourcesFromSameVersion(
  left: RetrievedElement,
  right: RetrievedElement,
): boolean {
  return left.documentVersionId === right.documentVersionId
    && left.element.documentId === right.element.documentId;
}

function haveSharedPage(
  left: RetrievalSourceElement,
  right: RetrievalSourceElement,
): boolean {
  const rightPages = new Set(right.pageNumbers);
  for (const pageNumber of left.pageNumbers) {
    if (rightPages.has(pageNumber)) {
      return true;
    }
  }
  return false;
}

function createRetrievedElementKey(item: RetrievedElement): string {
  return `${item.documentVersionId}\0${item.element.documentId}\0${item.element.id}`;
}

export function readPublishedAnswerClaims(
  document: PublishedAnswerDocument,
): AnswerClaim[] {
  if (document.status === "no_answer") {
    return [];
  }
  const citationNumberById = new Map<string, number>();
  for (const citation of document.citations) {
    citationNumberById.set(citation.id, citation.citationNumber);
  }
  const claims: AnswerClaim[] = [];
  for (let claimIndex = 0; claimIndex < document.statements.length; claimIndex += 1) {
    const statement = document.statements[claimIndex];
    if (statement === undefined) {
      throw new Error(`Missing published statement at index ${claimIndex}.`);
    }
    const citationNumbers: number[] = [];
    for (const citationId of statement.citationIds) {
      const citationNumber = citationNumberById.get(citationId);
      if (citationNumber === undefined) {
        throw new Error(`Published statement references missing citation ${citationId}.`);
      }
      citationNumbers.push(citationNumber);
    }
    claims.push({
      citationNumbers,
      claim: statement.content,
      claimIndex,
    });
  }
  return claims;
}

export function renderPublishedAnswerMarkdown(
  document: PublishedAnswerDocument,
): string {
  if (document.status === "no_answer") {
    return NO_ANSWER_TEXT;
  }
  const citationNumberById = createCitationNumberById(document.citations);
  const lines: string[] = [];
  let currentSection: AnswerSection | null = null;
  let previousPresentation: AnswerPresentation | null = null;
  for (const statement of document.statements) {
    if (statement.section !== currentSection) {
      appendSectionHeading(lines, statement.section);
      currentSection = statement.section;
      previousPresentation = null;
    } else if (
      lines.length > 0
      && previousPresentation !== null
      && previousPresentation !== statement.presentation
    ) {
      lines.push("");
    }
    const citationText = renderMarkdownCitations(
      statement.citationIds,
      citationNumberById,
    );
    const content = escapeMarkdownText(statement.content);
    const prefix = statement.presentation === "bullet" ? "- " : "";
    lines.push(`${prefix}${content} ${citationText}`);
    if (statement.presentation === "paragraph") {
      lines.push("");
    }
    previousPresentation = statement.presentation;
  }
  return lines.join("\n").trimEnd();
}

export function renderPublishedAnswerSpeech(
  document: PublishedAnswerDocument,
): string {
  if (document.status === "no_answer") {
    return NO_ANSWER_TEXT;
  }
  const citationNumberById = createCitationNumberById(document.citations);
  const lines: string[] = [];
  let currentSection: AnswerSection | null = null;
  for (const statement of document.statements) {
    if (statement.section !== currentSection) {
      const sectionLabel = readSectionLabel(statement.section);
      if (sectionLabel !== null) {
        lines.push(`${sectionLabel}.`);
      }
      currentSection = statement.section;
    }
    const speechContent = normalizeTextForSpeech(statement.content);
    const content = ensureTerminalPunctuation(speechContent);
    const citationNumbers = readCitationNumbers(
      statement.citationIds,
      citationNumberById,
    );
    lines.push(`${content} ${renderSpeechCitations(citationNumbers)}`);
  }
  return lines.join("\n");
}

export function escapeMarkdownText(value: string): string {
  return value.replace(/[\\`*_{}\[\]()<>#+\-.!|]/g, "\\$&");
}

function requireRetrievedSource(
  retrieved: readonly RetrievedElement[],
  sourceNumber: number,
): RetrievedElement {
  if (!Number.isInteger(sourceNumber) || sourceNumber < 1) {
    throw new AnswerDraftSourceError(`Invalid answer source number ${sourceNumber}.`);
  }
  const item = retrieved[sourceNumber - 1];
  if (item === undefined) {
    throw new AnswerDraftSourceError(
      `Answer references source ${sourceNumber}, but only ${retrieved.length} sources were retrieved.`,
    );
  }
  return item;
}

function createPublishedCitation(
  item: RetrievedElement,
  citationNumber: number,
): PublishedAnswerCitation {
  return {
    citationNumber,
    documentId: item.element.documentId,
    documentVersionId: item.documentVersionId,
    elementId: item.element.id,
    evidence: createCitationEvidence(item),
    id: randomUUID(),
    kind: item.element.kind,
    pageNumbers: item.element.pageNumbers,
    regions: item.element.regions,
    sectionPath: item.element.sectionPath,
    sourceFile: item.element.sourceFile,
  };
}

function createCitationEvidence(item: RetrievedElement): CitationEvidence {
  const element = item.element;
  if (element.kind === "text") {
    return { excerpt: element.content, kind: "text" };
  }
  if (element.kind === "table") {
    return { content: element.content, kind: "table", table: element.table };
  }
  return {
    kind: "image",
    mimeType: element.mimeType,
  };
}

function createCitationNumberById(
  citations: readonly PublishedAnswerCitation[],
): Map<string, number> {
  const citationNumberById = new Map<string, number>();
  for (const citation of citations) {
    citationNumberById.set(citation.id, citation.citationNumber);
  }
  return citationNumberById;
}

function readCitationNumbers(
  citationIds: readonly string[],
  citationNumberById: ReadonlyMap<string, number>,
): number[] {
  const citationNumbers: number[] = [];
  for (const citationId of citationIds) {
    const citationNumber = citationNumberById.get(citationId);
    if (citationNumber === undefined) {
      throw new Error(`Published statement references missing citation ${citationId}.`);
    }
    citationNumbers.push(citationNumber);
  }
  return citationNumbers;
}

function renderMarkdownCitations(
  citationIds: readonly string[],
  citationNumberById: ReadonlyMap<string, number>,
): string {
  const citationNumbers = readCitationNumbers(citationIds, citationNumberById);
  return citationNumbers.map((citationNumber) => `[${citationNumber}]`).join(" ");
}

function appendSectionHeading(lines: string[], section: AnswerSection): void {
  const label = readSectionLabel(section);
  if (label === null) {
    return;
  }
  if (lines.length > 0 && lines.at(-1) !== "") {
    lines.push("");
  }
  lines.push(`## ${label}`, "");
}

function readSectionLabel(section: AnswerSection): string | null {
  if (section === "answer") {
    return null;
  }
  if (section === "key-points") {
    return "Key points";
  }
  return "Conflicting evidence";
}

function ensureTerminalPunctuation(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

function normalizeTextForSpeech(value: string): string {
  return value.replace(
    /\b(Part|Chapter|Book|Volume|Title|Article|Section|Schedule|Appendix)\s+([IVXLCDM]+)\b/gi,
    replaceStructuralRomanNumeralForSpeech,
  );
}

function replaceStructuralRomanNumeralForSpeech(
  match: string,
  label: string,
  romanNumeral: string,
): string {
  if (romanNumeral !== romanNumeral.toUpperCase()) {
    return match;
  }
  const value = readRomanNumeral(romanNumeral);
  if (value === null) {
    return match;
  }
  return `${label} ${value}`;
}

function readRomanNumeral(value: string): number | null {
  const normalizedValue = value.toUpperCase();
  const canonicalRomanNumeralPattern =
    /^(?=[IVXLCDM])M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;
  if (!canonicalRomanNumeralPattern.test(normalizedValue)) {
    return null;
  }
  const numeralValues: Readonly<Record<string, number>> = {
    C: 100,
    D: 500,
    I: 1,
    L: 50,
    M: 1_000,
    V: 5,
    X: 10,
  };
  let result = 0;
  for (let index = 0; index < normalizedValue.length; index += 1) {
    const currentValue = numeralValues[normalizedValue[index] ?? ""];
    const nextValue = numeralValues[normalizedValue[index + 1] ?? ""];
    if (currentValue === undefined) {
      return null;
    }
    if (nextValue !== undefined && currentValue < nextValue) {
      result -= currentValue;
      continue;
    }
    result += currentValue;
  }
  return result;
}

function renderSpeechCitations(citationNumbers: readonly number[]): string {
  if (citationNumbers.length === 1) {
    return `See cited resource ${citationNumbers[0]}.`;
  }
  const finalNumber = citationNumbers.at(-1);
  const leadingNumbers = citationNumbers.slice(0, -1);
  return `See cited resources ${leadingNumbers.join(", ")}, and ${finalNumber}.`;
}
