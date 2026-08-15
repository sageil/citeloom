import { randomUUID } from "node:crypto";

import type {
  AnswerDraft,
  AnswerDraftConflictGroup,
  AnswerPresentation,
  AnswerSection,
  EvidenceReference,
} from "./draft.js";
import {
  ANSWER_DRAFT_SECTIONS,
  createEvidenceReferences,
  renderAnswerDraftConflictScope,
} from "./draft.js";
import type { RetrievedElement } from "../retrieval/document-retrieval.js";
import {
  createUncitedAnswerDocument,
  decodePublishedAnswerDocument,
  isPublishedUncitedAnswerDocument,
  type PublishedAnswerCitation,
  type PublishedAnswerDocument,
  type PublishedAnswerStatement,
} from "./published-model.js";
import type {
  AnswerClaim,
  CitationEvidence,
} from "../research/types.js";
import { renderAnswerMarkupSpeech } from "./markup.js";

export {
  createUncitedAnswerDocument,
  DEFAULT_UNCITED_ANSWER_TEXT,
  decodePublishedAnswerDocument,
  isPublishedAnsweredDocument,
  isPublishedUncitedAnswerDocument,
  publishedAnswerCitationSchema,
  publishedAnswerDocumentSchema,
  type PublishedAnswerCitation,
  type PublishedAnswerDocument,
  type PublishedAnswerStatement,
} from "./published-model.js";

export class AnswerDraftSourceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AnswerDraftSourceError";
  }
}

interface PreparedDraftStatement {
  evidenceRefs: EvidenceReference[];
  statement: PublishedDraftStatement;
}

interface PublishedDraftStatement {
  content: string;
  presentation: AnswerPresentation;
  section: AnswerSection;
}

interface SelectedSource {
  evidenceRef: EvidenceReference;
  item: RetrievedElement;
}

interface RequestEvidence {
  evidenceRef: EvidenceReference;
  item: RetrievedElement;
}

export function compileAnswerDraft(
  draft: AnswerDraft,
  retrieved: readonly RetrievedElement[],
  evidenceRefs: readonly EvidenceReference[] | null = null,
): PublishedAnswerDocument {
  if (draft.status === "uncited") {
    return createUncitedAnswerDocument(draft.content);
  }
  const requestEvidence = createRequestEvidence(
    retrieved,
    evidenceRefs ?? createEvidenceReferences(retrieved.length),
  );
  const preparedStatements = prepareDraftStatements(draft, requestEvidence);
  const directAnswerIndex = readDirectAnswerIndex(preparedStatements);
  const directAnswer = preparedStatements[directAnswerIndex];
  if (directAnswer === undefined) {
    throw new AnswerDraftSourceError("The answer draft has no direct answer content.");
  }
  const referencedEvidence = new Set<EvidenceReference>();
  for (let index = 0; index < preparedStatements.length; index += 1) {
    if (index === directAnswerIndex) {
      continue;
    }
    const prepared = preparedStatements[index];
    if (prepared === undefined) {
      continue;
    }
    for (const evidenceRef of prepared.evidenceRefs) {
      referencedEvidence.add(evidenceRef);
    }
  }
  const citationByEvidenceRef = new Map<
    EvidenceReference,
    PublishedAnswerCitation
  >();
  const citations: PublishedAnswerCitation[] = [];
  for (const evidence of requestEvidence) {
    if (!referencedEvidence.has(evidence.evidenceRef)) {
      continue;
    }
    const citationNumber = citations.length + 1;
    const citation = createPublishedCitation(evidence.item, citationNumber);
    citations.push(citation);
    citationByEvidenceRef.set(evidence.evidenceRef, citation);
  }
  const statements: PublishedAnswerStatement[] = [];
  for (const section of ANSWER_DRAFT_SECTIONS) {
    for (let index = 0; index < preparedStatements.length; index += 1) {
      if (index === directAnswerIndex) {
        continue;
      }
      const prepared = preparedStatements[index];
      if (prepared === undefined) {
        continue;
      }
      const draftStatement = prepared.statement;
      if (draftStatement.section !== section) {
        continue;
      }
      const citationIds: string[] = [];
      for (const evidenceRef of prepared.evidenceRefs) {
        const citation = citationByEvidenceRef.get(evidenceRef);
        if (citation === undefined) {
          throw new AnswerDraftSourceError(
            `Answer statement references unavailable evidence ${evidenceRef}.`,
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
  appendConflictStatements(
    statements,
    preparedStatements,
    citationByEvidenceRef,
  );
  return decodePublishedAnswerDocument({
    citations,
    content: directAnswer.statement.content,
    schemaVersion: 2,
    statements,
  });
}

function readDirectAnswerIndex(
  statements: readonly PreparedDraftStatement[],
): number {
  for (let index = 0; index < statements.length; index += 1) {
    const statement = statements[index]?.statement;
    if (
      statement?.section === "answer"
      && statement.presentation === "paragraph"
    ) {
      return index;
    }
  }
  return -1;
}

function prepareDraftStatements(
  draft: Extract<AnswerDraft, { status: "answered" }>,
  requestEvidence: readonly RequestEvidence[],
): PreparedDraftStatement[] {
  const canonicalEvidenceRefs = createCanonicalEvidenceRefs(requestEvidence);
  const preparedStatements: PreparedDraftStatement[] = [];
  for (const statement of draft.statements) {
    preparedStatements.push({
      evidenceRefs: compactStatementEvidence(
        statement.evidenceRefs,
        requestEvidence,
        canonicalEvidenceRefs,
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
      requestEvidence,
      canonicalEvidenceRefs,
    );
  }
  return preparedStatements;
}

function createConflictGroupKey(group: AnswerDraftConflictGroup): string {
  const positions = [];
  for (const position of group.positions) {
    positions.push({
      claim: position.claim.toLowerCase(),
      evidenceRefs: [...position.evidenceRefs].sort(),
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
  requestEvidence: readonly RequestEvidence[],
  canonicalEvidenceRefs: ReadonlyMap<string, EvidenceReference>,
): void {
  const groupEvidenceRefs: EvidenceReference[] = [];
  const seenGroupEvidence = new Set<EvidenceReference>();
  for (const position of group.positions) {
    const evidenceRefs = compactStatementEvidence(
      position.evidenceRefs,
      requestEvidence,
      canonicalEvidenceRefs,
    );
    for (const evidenceRef of evidenceRefs) {
      if (!seenGroupEvidence.has(evidenceRef)) {
        seenGroupEvidence.add(evidenceRef);
        groupEvidenceRefs.push(evidenceRef);
      }
    }
  }
  preparedStatements.push({
    evidenceRefs: groupEvidenceRefs,
    statement: {
      content: renderAnswerDraftConflictScope(group.sharedScope),
      presentation: "paragraph",
      section: "conflicting-evidence",
    },
  });
  for (const position of group.positions) {
    preparedStatements.push({
      evidenceRefs: compactStatementEvidence(
        position.evidenceRefs,
        requestEvidence,
        canonicalEvidenceRefs,
      ),
      statement: {
        content: position.claim,
        presentation: "bullet",
        section: "conflicting-evidence",
      },
    });
  }
  preparedStatements.push({
    evidenceRefs: groupEvidenceRefs,
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
  citationByEvidenceRef: ReadonlyMap<
    EvidenceReference,
    PublishedAnswerCitation
  >,
): void {
  for (const prepared of preparedStatements) {
    if (prepared.statement.section !== "conflicting-evidence") {
      continue;
    }
    const citationIds: string[] = [];
    for (const evidenceRef of prepared.evidenceRefs) {
      const citation = citationByEvidenceRef.get(evidenceRef);
      if (citation === undefined) {
        throw new AnswerDraftSourceError(
          `Answer statement references unavailable evidence ${evidenceRef}.`,
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

function createRequestEvidence(
  retrieved: readonly RetrievedElement[],
  evidenceRefs: readonly EvidenceReference[],
): RequestEvidence[] {
  if (evidenceRefs.length !== retrieved.length) {
    throw new AnswerDraftSourceError(
      "Answer evidence references must correspond to retrieved evidence.",
    );
  }
  const requestEvidence: RequestEvidence[] = [];
  for (let index = 0; index < retrieved.length; index += 1) {
    const item = retrieved[index];
    const evidenceRef = evidenceRefs[index];
    if (item === undefined) {
      throw new AnswerDraftSourceError(`Missing retrieved evidence at index ${index}.`);
    }
    if (evidenceRef === undefined) {
      throw new AnswerDraftSourceError(
        `Missing evidence reference at index ${index}.`,
      );
    }
    requestEvidence.push({ evidenceRef, item });
  }
  return requestEvidence;
}

function createCanonicalEvidenceRefs(
  requestEvidence: readonly RequestEvidence[],
): ReadonlyMap<string, EvidenceReference> {
  const canonicalEvidenceRefs = new Map<string, EvidenceReference>();
  for (const evidence of requestEvidence) {
    const key = createRetrievedElementKey(evidence.item);
    if (!canonicalEvidenceRefs.has(key)) {
      canonicalEvidenceRefs.set(key, evidence.evidenceRef);
    }
  }
  return canonicalEvidenceRefs;
}

function compactStatementEvidence(
  evidenceRefs: readonly EvidenceReference[],
  requestEvidence: readonly RequestEvidence[],
  canonicalEvidenceRefs: ReadonlyMap<string, EvidenceReference>,
): EvidenceReference[] {
  const evidenceByRef = new Map<EvidenceReference, RetrievedElement>();
  for (const evidence of requestEvidence) {
    evidenceByRef.set(evidence.evidenceRef, evidence.item);
  }
  const selectedSources: SelectedSource[] = [];
  const seenEvidenceRefs = new Set<EvidenceReference>();
  for (const evidenceRef of evidenceRefs) {
    const item = requireRetrievedEvidence(evidenceByRef, evidenceRef);
    const key = createRetrievedElementKey(item);
    const canonicalEvidenceRef = canonicalEvidenceRefs.get(key);
    if (canonicalEvidenceRef === undefined) {
      throw new AnswerDraftSourceError(
        `Answer statement references unavailable evidence ${evidenceRef}.`,
      );
    }
    if (seenEvidenceRefs.has(canonicalEvidenceRef)) {
      continue;
    }
    seenEvidenceRefs.add(canonicalEvidenceRef);
    selectedSources.push({
      evidenceRef: canonicalEvidenceRef,
      item: requireRetrievedEvidence(evidenceByRef, canonicalEvidenceRef),
    });
  }

  const compacted: EvidenceReference[] = [];
  for (const selected of selectedSources) {
    compacted.push(selected.evidenceRef);
  }
  return compacted;
}

function createRetrievedElementKey(item: RetrievedElement): string {
  return `${item.documentVersionId}\0${item.element.documentId}\0${item.element.id}`;
}

export function readPublishedAnswerClaims(
  document: PublishedAnswerDocument,
): AnswerClaim[] {
  if (isPublishedUncitedAnswerDocument(document)) {
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

export function readPublishedDirectAnswerContent(
  document: PublishedAnswerDocument,
): string {
  return document.content;
}

export function renderPublishedAnswerMarkdown(
  document: PublishedAnswerDocument,
): string {
  if (isPublishedUncitedAnswerDocument(document)) {
    return document.content;
  }
  const citationNumberById = createCitationNumberById(document.citations);
  const lines: string[] = [escapeMarkdownText(document.content), ""];
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
    let line = `${prefix}${content}`;
    if (citationText !== "") {
      line += ` ${citationText}`;
    }
    lines.push(line);
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
  if (isPublishedUncitedAnswerDocument(document)) {
    return normalizeTextForSpeech(document.content);
  }
  const directAnswer = normalizeTextForSpeech(document.content);
  const lines: string[] = [ensureTerminalPunctuation(directAnswer)];
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
    lines.push(content);
  }
  return lines.join("\n");
}

export function escapeMarkdownText(value: string): string {
  return value.replace(/[\\`*_{}[\]()<>#+\-.!|]/g, "\\$&");
}

function requireRetrievedEvidence(
  evidenceByRef: ReadonlyMap<EvidenceReference, RetrievedElement>,
  evidenceRef: EvidenceReference,
): RetrievedElement {
  const item = evidenceByRef.get(evidenceRef);
  if (item === undefined) {
    throw new AnswerDraftSourceError(
      `Answer references unavailable evidence ${evidenceRef}.`,
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
  const spokenText = readAnswerMarkupSpeech(value);
  return spokenText.replace(
    /\b(Part|Chapter|Book|Volume|Title|Article|Section|Schedule|Appendix)\s+([IVXLCDM]+)\b/gi,
    replaceStructuralRomanNumeralForSpeech,
  );
}

function readAnswerMarkupSpeech(value: string): string {
  try {
    return renderAnswerMarkupSpeech(value);
  } catch {
    return value;
  }
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
