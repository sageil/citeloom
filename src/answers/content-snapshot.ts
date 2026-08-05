import {
  isPublishedUncitedAnswerDocument,
  type PublishedAnswerDocument,
} from "./published-schema.js";
import {
  normalizeAnswerModelText,
  type AnswerPresentation,
  type AnswerSection,
  type EvidenceReference,
} from "./draft.js";
import { formatAnswerTopicContent } from "./topic-content.js";
import type { RetrievedElement } from "../retrieval/document-retrieval.js";

export interface AnswerContentCitationPreview {
  key: string;
  pageNumbers: number[];
  sourceFile: string;
}

export type AnswerContentCitationCatalog = ReadonlyMap<
  EvidenceReference,
  AnswerContentCitationPreview
>;

export interface AnswerContentStatement {
  citationKeys: string[];
  content: string;
  presentation: AnswerPresentation;
  section: AnswerSection;
}

export interface AnswerContentSnapshot {
  citations: AnswerContentCitationPreview[];
  statements: AnswerContentStatement[];
}

export function createAnswerContentCitationCatalog(
  retrieved: readonly RetrievedElement[],
  evidenceRefs: readonly EvidenceReference[],
): AnswerContentCitationCatalog {
  if (retrieved.length !== evidenceRefs.length) {
    throw new Error("Answer preview evidence references do not match retrieved evidence.");
  }
  const catalog = new Map<EvidenceReference, AnswerContentCitationPreview>();
  for (let index = 0; index < retrieved.length; index += 1) {
    const item = retrieved[index];
    const evidenceRef = evidenceRefs[index];
    if (item === undefined || evidenceRef === undefined) {
      throw new Error(`Answer preview evidence ${index} is unavailable.`);
    }
    if (catalog.has(evidenceRef)) {
      throw new Error(`Answer preview evidence reference ${evidenceRef} is duplicated.`);
    }
    catalog.set(evidenceRef, {
      key: createAnswerContentCitationKey(
        item.documentVersionId,
        item.element.documentId,
        item.element.id,
      ),
      pageNumbers: [...item.element.pageNumbers],
      sourceFile: item.element.sourceFile,
    });
  }
  return catalog;
}

export function createAnswerContentCitationKey(
  documentVersionId: string,
  documentId: string,
  elementId: string,
): string {
  return JSON.stringify([documentVersionId, documentId, elementId]);
}

export function decodePartialAnswerContentSnapshot(
  value: unknown,
  citationCatalog: AnswerContentCitationCatalog,
): AnswerContentSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const answer = Reflect.get(value, "answer");
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    return null;
  }
  const answerContent = Reflect.get(answer, "content");
  if (typeof answerContent !== "string" || answerContent === "") {
    return null;
  }
  const normalizedAnswerContent = normalizeAnswerModelText(answerContent);
  if (normalizedAnswerContent === "") {
    return null;
  }
  const citationsByKey = new Map<string, AnswerContentCitationPreview>();
  const statements: AnswerContentStatement[] = [{
    citationKeys: [],
    content: normalizedAnswerContent,
    presentation: "paragraph",
    section: "answer",
  }];
  appendPartialAnswerTopics(
    statements,
    answer,
    citationCatalog,
    citationsByKey,
  );
  const findings = Reflect.get(value, "findings");
  if (!Array.isArray(findings)) {
    return { citations: [...citationsByKey.values()], statements };
  }
  for (const finding of findings) {
    const content = readPartialFindingContent(finding);
    if (content === null) {
      continue;
    }
    statements.push({
      citationKeys: readPartialCitationKeys(
        finding,
        citationCatalog,
        citationsByKey,
      ),
      content,
      presentation: "bullet",
      section: "key-points",
    });
  }
  return { citations: [...citationsByKey.values()], statements };
}

function appendPartialAnswerTopics(
  statements: AnswerContentStatement[],
  answer: object,
  citationCatalog: AnswerContentCitationCatalog,
  citationsByKey: Map<string, AnswerContentCitationPreview>,
): void {
  const topics = Reflect.get(answer, "topics");
  if (!Array.isArray(topics)) {
    return;
  }
  for (const topic of topics) {
    const content = readPartialAnswerTopicContent(topic);
    if (content === null) {
      continue;
    }
    statements.push({
      citationKeys: readPartialCitationKeys(
        topic,
        citationCatalog,
        citationsByKey,
      ),
      content,
      presentation: "bullet",
      section: "answer",
    });
  }
}

function readPartialAnswerTopicContent(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const title = Reflect.get(value, "title");
  if (typeof title !== "string" || title === "") {
    return null;
  }
  const content = Reflect.get(value, "content");
  if (typeof content !== "string") {
    return null;
  }
  const formatted = formatAnswerTopicContent(title, content);
  return formatted === "" ? null : formatted;
}

function readPartialCitationKeys(
  value: object,
  citationCatalog: AnswerContentCitationCatalog,
  citationsByKey: Map<string, AnswerContentCitationPreview>,
): string[] {
  const sourceReferences = readPartialSourceReferences(value);
  const citationKeys: string[] = [];
  const seen = new Set<string>();
  for (const sourceReference of sourceReferences) {
    const citation = citationCatalog.get(sourceReference);
    if (citation === undefined || seen.has(citation.key)) {
      continue;
    }
    seen.add(citation.key);
    citationKeys.push(citation.key);
    citationsByKey.set(citation.key, citation);
  }
  return citationKeys;
}

function readPartialSourceReferences(value: object): string[] {
  const sourceRefs = Reflect.get(value, "source_refs");
  if (Array.isArray(sourceRefs)) {
    return sourceRefs.filter((sourceRef): sourceRef is string => {
      return typeof sourceRef === "string";
    });
  }
  const evidenceRefs = Reflect.get(value, "evidenceRefs");
  if (!Array.isArray(evidenceRefs)) {
    return [];
  }
  return evidenceRefs.filter((evidenceRef): evidenceRef is string => {
    return typeof evidenceRef === "string";
  });
}

export function createPublishedAnswerContentSnapshot(
  document: PublishedAnswerDocument,
): AnswerContentSnapshot {
  if (isPublishedUncitedAnswerDocument(document)) {
    return {
      citations: [],
      statements: [{
        citationKeys: [],
        content: document.content,
        presentation: "paragraph",
        section: "answer",
      }],
    };
  }
  const citationKeyById = new Map<string, string>();
  const citations: AnswerContentCitationPreview[] = [];
  for (const citation of document.citations) {
    const key = createAnswerContentCitationKey(
      citation.documentVersionId,
      citation.documentId,
      citation.elementId,
    );
    citationKeyById.set(citation.id, key);
    citations.push({
      key,
      pageNumbers: [...citation.pageNumbers],
      sourceFile: citation.sourceFile,
    });
  }
  const statements: AnswerContentStatement[] = [];
  statements.push({
    citationKeys: [],
    content: document.content,
    presentation: "paragraph",
    section: "answer",
  });
  for (const statement of document.statements) {
    const citationKeys: string[] = [];
    for (const citationId of statement.citationIds) {
      const citationKey = citationKeyById.get(citationId);
      if (citationKey === undefined) {
        throw new Error(`Published answer citation ${citationId} is unavailable.`);
      }
      citationKeys.push(citationKey);
    }
    statements.push({
      citationKeys,
      content: statement.content,
      presentation: statement.presentation,
      section: statement.section,
    });
  }
  return { citations, statements };
}

export function hasAnswerContent(
  snapshot: AnswerContentSnapshot,
): boolean {
  return snapshot.statements.length > 0;
}

function readPartialFindingContent(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const content = Reflect.get(value, "content");
  if (typeof content === "string" && content !== "") {
    const normalizedContent = normalizeAnswerModelText(content);
    return normalizedContent === "" ? null : normalizedContent;
  }
  const claim = Reflect.get(value, "claim");
  if (typeof claim !== "string" || claim === "") {
    return null;
  }
  const normalizedClaim = normalizeAnswerModelText(claim);
  return normalizedClaim === "" ? null : normalizedClaim;
}
