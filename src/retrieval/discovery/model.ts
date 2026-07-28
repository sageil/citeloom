import type { RetrievedElement } from "../document-retrieval.js";
import type {
  RetrievalSourceElement,
  SourceElement,
} from "../../domain/source-elements.js";
import type {
  DiscoveryMatchKind,
  DiscoverySearchStatus,
  SourceDiscoveryDocument,
  SourceDiscoveryPassage,
  SourceDiscoveryRequest,
  SourceDiscoveryResponse,
} from "./schema.js";

const MAX_EXCERPT_CHARACTERS = 360;
const MAX_PASSAGES_PER_DOCUMENT = 3;

export interface KeywordDiscoveryMatch {
  element: SourceElement;
  evidenceContent: string;
  matchingPassageCount: number;
}

export interface KeywordDiscoveryPage {
  matches: KeywordDiscoveryMatch[];
  totalDocuments: number;
}

export interface DiscoverySectionState {
  status: DiscoverySearchStatus;
  warning: string | null;
}

export interface BuildSourceDiscoveryResponseInput {
  keyword: DiscoverySectionState;
  keywordPage: KeywordDiscoveryPage;
  lexicalDocumentKeys: Set<string>;
  related: DiscoverySectionState;
  relatedElements: RetrievedElement[];
  request: SourceDiscoveryRequest;
}

interface MutableDiscoveryDocument {
  documentId: string;
  matchKinds: Set<DiscoveryMatchKind>;
  matchingPassageCount: number;
  passages: SourceDiscoveryPassage[];
  sourceFile: string;
}

export function buildSourceDiscoveryResponse(
  input: BuildSourceDiscoveryResponseInput,
): SourceDiscoveryResponse {
  const semanticElementIds = readSemanticElementIds(input.relatedElements);
  const semanticDocumentKeys = readSemanticDocumentKeys(input.relatedElements);
  const keywordDocuments = buildKeywordDocuments(
    input.keywordPage.matches,
    input.request.query,
    semanticElementIds,
    semanticDocumentKeys,
  );
  const relatedDocuments = buildRelatedDocuments(
    input.relatedElements,
    input.lexicalDocumentKeys,
    input.request.query,
    input.request.relatedLimit,
  );

  return {
    keyword: {
      documents: keywordDocuments,
      page: input.request.keywordPage,
      pageSize: input.request.keywordPageSize,
      status: input.keyword.status,
      totalDocuments: input.keywordPage.totalDocuments,
      warning: input.keyword.warning,
    },
    query: input.request.query,
    related: {
      documents: relatedDocuments,
      limit: input.request.relatedLimit,
      status: input.related.status,
      warning: input.related.warning,
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
  semanticElementIds: Set<string>,
  semanticDocumentKeys: Set<string>,
): SourceDiscoveryDocument[] {
  const documents = new Map<string, MutableDiscoveryDocument>();
  for (const match of matches) {
    const element = match.element;
    const documentKey = createDiscoveryDocumentKey(
      element.documentId,
      element.sourceFile,
    );
    const document = readOrCreateDocument(documents, element, "keyword");
    document.matchingPassageCount = Math.max(
      document.matchingPassageCount,
      match.matchingPassageCount,
    );
    const passageMatchKinds: DiscoveryMatchKind[] = ["keyword"];
    if (semanticElementIds.has(element.id)) {
      passageMatchKinds.push("semantic");
    }
    document.passages.push(buildPassage(
      element,
      match.evidenceContent,
      query,
      passageMatchKinds,
    ));
    if (semanticDocumentKeys.has(documentKey)) {
      document.matchKinds.add("semantic");
    }
  }
  return finalizeDocuments(documents);
}

function buildRelatedDocuments(
  elements: RetrievedElement[],
  lexicalDocumentKeys: Set<string>,
  query: string,
  limit: number,
): SourceDiscoveryDocument[] {
  const documents = new Map<string, MutableDiscoveryDocument>();
  for (const item of elements) {
    const element = item.element;
    const documentKey = createDiscoveryDocumentKey(
      element.documentId,
      element.sourceFile,
    );
    if (lexicalDocumentKeys.has(documentKey)) {
      continue;
    }
    let document = documents.get(documentKey);
    if (document === undefined) {
      if (documents.size === limit) {
        continue;
      }
      document = readOrCreateDocument(documents, element, "semantic");
    }
    document.matchingPassageCount += 1;
    if (document.passages.length < MAX_PASSAGES_PER_DOCUMENT) {
      document.passages.push(buildPassage(
        element,
        item.evidenceContent,
        query,
        ["semantic"],
      ));
    }
  }
  return finalizeDocuments(documents);
}

function readOrCreateDocument(
  documents: Map<string, MutableDiscoveryDocument>,
  element: RetrievalSourceElement,
  matchKind: DiscoveryMatchKind,
): MutableDiscoveryDocument {
  const documentKey = createDiscoveryDocumentKey(
    element.documentId,
    element.sourceFile,
  );
  const existing = documents.get(documentKey);
  if (existing !== undefined) {
    existing.matchKinds.add(matchKind);
    return existing;
  }
  const created: MutableDiscoveryDocument = {
    documentId: element.documentId,
    matchKinds: new Set([matchKind]),
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
  matchKinds: DiscoveryMatchKind[],
): SourceDiscoveryPassage {
  return {
    excerpt: createSourceExcerpt(element, evidenceContent, query),
    id: element.id,
    kind: element.kind,
    matchKinds,
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
      matchKinds: [...document.matchKinds],
      matchingPassageCount: document.matchingPassageCount,
      passages: document.passages,
      sourceFile: document.sourceFile,
    });
  }
  return finalized;
}

function readSemanticElementIds(elements: RetrievedElement[]): Set<string> {
  const elementIds = new Set<string>();
  for (const item of elements) {
    elementIds.add(item.element.id);
  }
  return elementIds;
}

function readSemanticDocumentKeys(elements: RetrievedElement[]): Set<string> {
  const documentKeys = new Set<string>();
  for (const item of elements) {
    documentKeys.add(createDiscoveryDocumentKey(
      item.element.documentId,
      item.element.sourceFile,
    ));
  }
  return documentKeys;
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
