import type { RetrievedElement } from "../document-retrieval.js";
import type { SourceDiscoveryConfig } from "../../config/index.js";
import type {
  RetrievalSourceElement,
  SourceElement,
} from "../../domain/source-elements.js";
import type {
  DiscoveryMatchKind,
  SourceDiscoveryDocument,
  SourceDiscoveryPassage,
  SourceDiscoveryRequest,
  SourceDiscoveryResponse,
} from "./boundary.js";

const MAX_EXCERPT_CHARACTERS = 360;
export interface KeywordDiscoveryMatch {
  element: SourceElement;
  evidenceContent: string;
  matchingPassageCount: number;
}

export interface KeywordDiscoveryPage {
  matches: KeywordDiscoveryMatch[];
  totalDocuments: number;
}

export interface BuildKeywordSourceDiscoveryResponseInput {
  keywordPage: KeywordDiscoveryPage;
  request: SourceDiscoveryRequest;
  settings: SourceDiscoveryConfig;
}

export interface BuildExactAndRelatedSourceDiscoveryResponseInput {
  keywordPage: KeywordDiscoveryPage;
  matchedElements: RetrievedElement[];
  request: SourceDiscoveryRequest;
  reviewedPassageCount: number;
  settings: SourceDiscoveryConfig;
}

interface MutableDiscoveryDocument {
  documentId: string;
  matchingPassageCount: number;
  passages: SourceDiscoveryPassage[];
  sourceFile: string;
}

export function buildKeywordSourceDiscoveryResponse(
  input: BuildKeywordSourceDiscoveryResponseInput,
): SourceDiscoveryResponse {
  const keywordDocuments = buildKeywordDocuments(
    input.keywordPage.matches,
    input.request.query,
  );

  return {
    query: input.request.query,
    results: {
      documents: keywordDocuments,
      kind: "exact",
      page: input.request.keywordPage,
      pageSize: input.settings.resultsPerGroup,
      totalDocuments: input.keywordPage.totalDocuments,
    },
  };
}

export function buildExactAndRelatedSourceDiscoveryResponse(
  input: BuildExactAndRelatedSourceDiscoveryResponseInput,
): SourceDiscoveryResponse {
  const exactDocuments = buildKeywordDocuments(
    input.keywordPage.matches,
    input.request.query,
  );
  const exactPassageKeys = readPassageKeys(exactDocuments);
  const related = buildRelatedDocuments(
    input.matchedElements,
    input.request.query,
    input.settings.resultsPerGroup,
    input.settings.passagesPerDocument,
    exactPassageKeys,
  );
  return {
    query: input.request.query,
    results: {
      exact: {
        documents: exactDocuments,
        page: input.request.keywordPage,
        pageSize: input.settings.resultsPerGroup,
        totalDocuments: input.keywordPage.totalDocuments,
      },
      kind: "exact-and-related",
      related: {
        documents: related.documents,
        limit: input.settings.resultsPerGroup,
        matchedPassageCount: related.matchedPassageCount,
        reviewedPassageCount: input.reviewedPassageCount,
      },
    },
  };
}

export function createSourceExcerpt(
  element: RetrievalSourceElement,
  evidenceContent: string,
  query: string,
): string {
  const sourceText = element.kind === "image"
    ? evidenceContent
    : element.content;
  let normalized = sourceText.replaceAll(/\s+/g, " ").trim();
  if (normalized === "") {
    normalized = evidenceContent.replaceAll(/\s+/g, " ").trim();
  }
  if (normalized === "") {
    return "Source excerpt unavailable.";
  }
  if (normalized.length <= MAX_EXCERPT_CHARACTERS) {
    return normalized;
  }

  const matchIndex = findQueryMatchIndex(normalized, query);
  if (matchIndex < 0) {
    return `${normalized.slice(0, MAX_EXCERPT_CHARACTERS - 3).trimEnd()}...`;
  }

  const contextBeforeMatch = Math.floor(MAX_EXCERPT_CHARACTERS / 3);
  const maximumStart = normalized.length - MAX_EXCERPT_CHARACTERS;
  const start = Math.min(Math.max(0, matchIndex - contextBeforeMatch), maximumStart);
  const end = start + MAX_EXCERPT_CHARACTERS;
  const prefix = start === 0 ? "" : "...";
  const suffix = end === normalized.length ? "" : "...";
  const excerpt = normalized.slice(start, end).trim();
  return `${prefix}${excerpt}${suffix}`;
}

export function createDiscoveryDocumentKey(
  documentId: string,
  sourceFile: string,
): string {
  return `${documentId}\u0000${sourceFile}`;
}

function buildKeywordDocuments(
  matches: KeywordDiscoveryMatch[],
  query: string,
): SourceDiscoveryDocument[] {
  const documents = new Map<string, MutableDiscoveryDocument>();
  for (const match of matches) {
    const element = match.element;
    const document = readOrCreateDocument(documents, element);
    document.matchingPassageCount = Math.max(
      document.matchingPassageCount,
      match.matchingPassageCount,
    );
    document.passages.push(buildPassage(
      element,
      match.evidenceContent,
      query,
      "keyword",
    ));
  }
  return finalizeDocuments(documents);
}

interface RelatedDocuments {
  documents: SourceDiscoveryDocument[];
  matchedPassageCount: number;
}

function buildRelatedDocuments(
  elements: RetrievedElement[],
  query: string,
  limit: number,
  passagesPerDocument: number,
  excludedPassageKeys: Set<string>,
): RelatedDocuments {
  const documents = new Map<string, MutableDiscoveryDocument>();
  const includedPassageKeys = new Set<string>();
  let matchedPassageCount = 0;
  for (const item of elements) {
    const element = item.element;
    const passageKey = createDiscoveryPassageKey(element);
    if (
      excludedPassageKeys.has(passageKey)
      || includedPassageKeys.has(passageKey)
    ) {
      continue;
    }
    const documentKey = createDiscoveryDocumentKey(
      element.documentId,
      element.sourceFile,
    );
    let document = documents.get(documentKey);
    if (document === undefined) {
      if (documents.size === limit) {
        continue;
      }
      document = readOrCreateDocument(documents, element);
    }
    includedPassageKeys.add(passageKey);
    matchedPassageCount += 1;
    document.matchingPassageCount += 1;
    if (document.passages.length < passagesPerDocument) {
      document.passages.push(buildPassage(
        element,
        item.evidenceContent,
        query,
        "semantic",
      ));
    }
  }
  return {
    documents: finalizeDocuments(documents),
    matchedPassageCount,
  };
}

function readOrCreateDocument(
  documents: Map<string, MutableDiscoveryDocument>,
  element: RetrievalSourceElement,
): MutableDiscoveryDocument {
  const documentKey = createDiscoveryDocumentKey(
    element.documentId,
    element.sourceFile,
  );
  const existing = documents.get(documentKey);
  if (existing !== undefined) {
    return existing;
  }
  const created: MutableDiscoveryDocument = {
    documentId: element.documentId,
    matchingPassageCount: 0,
    passages: [],
    sourceFile: element.sourceFile,
  };
  documents.set(documentKey, created);
  return created;
}

function buildPassage(
  element: RetrievalSourceElement,
  evidenceContent: string,
  query: string,
  matchKind: DiscoveryMatchKind,
): SourceDiscoveryPassage {
  return {
    excerpt: createSourceExcerpt(element, evidenceContent, query),
    id: element.id,
    kind: element.kind,
    matchKind,
    pageNumbers: element.pageNumbers,
    regions: element.regions,
    sectionPath: element.sectionPath,
  };
}

function finalizeDocuments(
  documents: Map<string, MutableDiscoveryDocument>,
): SourceDiscoveryDocument[] {
  const finalized: SourceDiscoveryDocument[] = [];
  for (const document of documents.values()) {
    finalized.push({
      documentId: document.documentId,
      matchingPassageCount: document.matchingPassageCount,
      passages: document.passages,
      sourceFile: document.sourceFile,
    });
  }
  return finalized;
}

function readPassageKeys(
  documents: SourceDiscoveryDocument[],
): Set<string> {
  const passageKeys = new Set<string>();
  for (const document of documents) {
    for (const passage of document.passages) {
      passageKeys.add(createDiscoveryPassageKey({
        documentId: document.documentId,
        id: passage.id,
        sourceFile: document.sourceFile,
      }));
    }
  }
  return passageKeys;
}

interface DiscoveryPassageIdentity {
  documentId: string;
  id: string;
  sourceFile: string;
}

function createDiscoveryPassageKey(
  passage: DiscoveryPassageIdentity,
): string {
  return `${createDiscoveryDocumentKey(passage.documentId, passage.sourceFile)}\u0000${passage.id}`;
}

function findQueryMatchIndex(content: string, query: string): number {
  const normalizedQuery = query.replaceAll(/\s+/g, " ").trim().toLocaleLowerCase();
  const normalizedContent = content.toLocaleLowerCase();
  const queryIndex = normalizedContent.indexOf(normalizedQuery);
  if (queryIndex >= 0) {
    return queryIndex;
  }

  const queryTerms = normalizedQuery.split(" ");
  queryTerms.sort((left, right) => right.length - left.length);
  for (const term of queryTerms) {
    if (term.length < 2) {
      continue;
    }
    const termIndex = normalizedContent.indexOf(term);
    if (termIndex >= 0) {
      return termIndex;
    }
  }
  return -1;
}
