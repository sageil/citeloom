import type { IndexedDocument } from "./model.js";
import { QueryScopeNotResolvedError } from "./model.js";
import { normalizeCatalogTags, uniqueCatalogStrings } from "./records.js";
import type {
  QueryScope,
  ResolvedQueryScopeTarget,
} from "../../domain/query-scope.js";

export function resolveDocumentQueryScope(
  scope: QueryScope,
  embeddingSpaceId: string,
  availableDocuments: IndexedDocument[],
): ResolvedQueryScopeTarget[] {
  const availableIds = new Set<string>();
  for (const document of availableDocuments) {
    availableIds.add(document.documentId);
  }

  if (scope.kind === "all") {
    return uniqueScopeTargets(availableDocuments);
  }

  if (scope.kind === "documentIds") {
    const requestedIds = uniqueCatalogStrings(scope.documentIds);
    const missingIds = requestedIds.filter((id) => !availableIds.has(id));
    if (missingIds.length > 0) {
      throw new QueryScopeNotResolvedError(
        `Document is not indexed in embedding space ${embeddingSpaceId}: ${missingIds.join(", ")}`,
      );
    }
    const documentsById = new Map<string, IndexedDocument[]>();
    for (const document of availableDocuments) {
      const documents = documentsById.get(document.documentId);
      if (documents === undefined) {
        documentsById.set(document.documentId, [document]);
      } else {
        documents.push(document);
      }
    }
    const documents: IndexedDocument[] = [];
    for (const requestedId of requestedIds) {
      documents.push(...documentsById.get(requestedId) ?? []);
    }
    return uniqueScopeTargets(documents);
  }

  if (scope.kind === "sourceFiles") {
    return resolveSourceFileScope(scope.sourceFiles, embeddingSpaceId, availableDocuments);
  }

  return resolveTagScope(scope.tags, embeddingSpaceId, availableDocuments);
}

function resolveSourceFileScope(
  sourceFiles: string[],
  embeddingSpaceId: string,
  availableDocuments: IndexedDocument[],
): ResolvedQueryScopeTarget[] {
  const requestedFiles = uniqueCatalogStrings(sourceFiles);
  const documentBySource = new Map<string, IndexedDocument>();
  for (const document of availableDocuments) {
    documentBySource.set(document.sourceFile, document);
  }
  const missingFiles = requestedFiles.filter(
    (sourceFile) => !documentBySource.has(sourceFile),
  );
  if (missingFiles.length > 0) {
    throw new QueryScopeNotResolvedError(
      `Source is not indexed in embedding space ${embeddingSpaceId}: ${missingFiles.join(", ")}`,
    );
  }
  const documents: IndexedDocument[] = [];
  for (const sourceFile of requestedFiles) {
    const document = documentBySource.get(sourceFile);
    if (document !== undefined) {
      documents.push(document);
    }
  }
  return uniqueScopeTargets(documents);
}

function resolveTagScope(
  tags: string[],
  embeddingSpaceId: string,
  availableDocuments: IndexedDocument[],
): ResolvedQueryScopeTarget[] {
  const requestedTags = normalizeCatalogTags(tags);
  if (requestedTags.length === 0) {
    throw new QueryScopeNotResolvedError("At least one non-empty tag is required.");
  }
  const documents: IndexedDocument[] = [];
  for (const document of availableDocuments) {
    if (document.tags.some((tag) => requestedTags.includes(tag))) {
      documents.push(document);
    }
  }
  if (documents.length === 0) {
    throw new QueryScopeNotResolvedError(
      `No documents in embedding space ${embeddingSpaceId} match tags: ${tags.join(", ")}`,
    );
  }
  return uniqueScopeTargets(documents);
}

function uniqueScopeTargets(
  documents: readonly IndexedDocument[],
): ResolvedQueryScopeTarget[] {
  const sourceFiles = new Set<string>();
  const targets: ResolvedQueryScopeTarget[] = [];
  for (const document of documents) {
    if (sourceFiles.has(document.sourceFile)) {
      continue;
    }
    sourceFiles.add(document.sourceFile);
    targets.push({
      documentId: document.documentId,
      generationId: document.generationId,
      sourceFile: document.sourceFile,
    });
  }
  return targets;
}
