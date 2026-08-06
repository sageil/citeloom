import { createHash } from "node:crypto";

import { DocumentCatalog } from "../../src/documents/catalog/index.js";
import {
  isStandaloneImageFormat,
  readDocumentFormat,
} from "../../src/documents/format.js";
import { SourceDocumentStore } from "../../src/documents/storage/source-document-store.js";
import type { CiteLoomDatabase } from "../../src/database/client.js";
import type { SourceElement } from "../../src/domain/source-elements.js";
import type { ResolvedQueryScopeTarget } from "../../src/domain/query-scope.js";
import type { BenchmarkEvaluationDataset } from "./dataset.js";

export interface LiveEvaluationCorpusReport {
  documentCount: number;
  elementCount: number;
  issues: string[];
  scopeTargets: ResolvedQueryScopeTarget[];
}

export async function inspectLiveEvaluationCorpus(
  database: CiteLoomDatabase,
  embeddingSpaceId: string,
  dataset: BenchmarkEvaluationDataset,
  datasetPath: string,
): Promise<LiveEvaluationCorpusReport> {
  if (dataset.version !== 3 || dataset.corpus === undefined) {
    return {
      documentCount: 0,
      elementCount: 0,
      issues: [`${datasetPath} does not contain version 3 corpus provenance.`],
      scopeTargets: [],
    };
  }

  const catalog = new DocumentCatalog(database);
  const availableDocuments = await catalog.listAvailableDocuments(
    embeddingSpaceId,
  );
  const documentsById = new Map<string, (typeof availableDocuments)[number]>();
  const elementsById = new Map<string, SourceElement>();
  const issues: string[] = [];
  const scopeTargets: ResolvedQueryScopeTarget[] = [];
  const store = new SourceDocumentStore(database);

  for (const expected of dataset.corpus.documents) {
    const actualModality = isStandaloneImageFormat(
      readDocumentFormat(expected.sourceFile),
    )
      ? "image"
      : "document";
    if (actualModality !== expected.modality) {
      issues.push(
        `${datasetPath} corpus source ${expected.sourceFile} declares ${expected.modality} modality but has ${actualModality} format.`,
      );
    }

    const matches = [];
    for (const document of availableDocuments) {
      if (
        document.documentId === expected.documentId
        && areSamePortableSourceFile(document.sourceFile, expected.sourceFile)
      ) {
        matches.push(document);
      }
    }
    if (matches.length !== 1) {
      issues.push(
        `${datasetPath} corpus source ${expected.sourceFile} expected one ready document in embedding space ${embeddingSpaceId}, found ${matches.length}.`,
      );
      continue;
    }

    const document = matches[0];
    if (document === undefined) {
      issues.push(`${datasetPath} corpus source is unavailable: ${expected.sourceFile}.`);
      continue;
    }
    if (documentsById.has(document.documentId)) {
      issues.push(
        `${datasetPath} live corpus repeats document ${document.documentId}.`,
      );
      continue;
    }
    documentsById.set(document.documentId, document);
    scopeTargets.push({
      documentId: document.documentId,
      generationId: document.generationId,
      sourceFile: document.sourceFile,
    });

    const elements = await store.readAllElements(
      document.elementSetId,
      document.sourceFile,
    );
    for (const element of elements) {
      if (elementsById.has(element.id)) {
        issues.push(`${datasetPath} live corpus repeats element ${element.id}.`);
        continue;
      }
      elementsById.set(element.id, element);
    }
  }

  validateEvaluationCases(
    datasetPath,
    dataset,
    documentsById,
    elementsById,
    issues,
  );
  return {
    documentCount: documentsById.size,
    elementCount: elementsById.size,
    issues,
    scopeTargets,
  };
}

export function assertLiveEvaluationCorpus(
  report: LiveEvaluationCorpusReport,
): void {
  if (report.issues.length === 0) {
    return;
  }
  const details = report.issues.map((issue) => `- ${issue}`).join("\n");
  throw new Error(`Live evaluation corpus validation failed:\n${details}`);
}

function validateEvaluationCases(
  datasetPath: string,
  dataset: BenchmarkEvaluationDataset,
  documentsById: ReadonlyMap<string, { documentId: string }>,
  elementsById: ReadonlyMap<string, SourceElement>,
  issues: string[],
): void {
  for (const evaluationCase of dataset.cases) {
    for (const documentId of evaluationCase.relevantDocumentIds) {
      if (!documentsById.has(documentId)) {
        issues.push(
          `${datasetPath} case ${evaluationCase.id} references stale document ${documentId}.`,
        );
      }
    }
    for (const judgment of evaluationCase.judgments) {
      if (
        judgment.target.kind === "document"
        && !documentsById.has(judgment.target.id)
      ) {
        issues.push(
          `${datasetPath} case ${evaluationCase.id} judges stale document ${judgment.target.id}.`,
        );
      }
    }

    const referencedElementIds = new Set(evaluationCase.relevantElementIds);
    if (evaluationCase.origin.kind === "generated") {
      referencedElementIds.add(evaluationCase.origin.elementId);
    }
    for (const judgment of evaluationCase.judgments) {
      if (judgment.target.kind === "element") {
        referencedElementIds.add(judgment.target.id);
      }
    }
    for (const elementId of referencedElementIds) {
      if (!elementsById.has(elementId)) {
        issues.push(
          `${datasetPath} case ${evaluationCase.id} references stale element ${elementId}.`,
        );
      }
    }

    if (evaluationCase.origin.kind !== "generated") {
      continue;
    }
    const origin = elementsById.get(evaluationCase.origin.elementId);
    if (origin === undefined) {
      continue;
    }
    if (origin.documentId !== evaluationCase.origin.documentId) {
      issues.push(`${datasetPath} case ${evaluationCase.id} origin document changed.`);
    }
    if (
      origin.kind !== evaluationCase.origin.sourceKind
      || origin.kind !== evaluationCase.metadata.source.kind
    ) {
      issues.push(`${datasetPath} case ${evaluationCase.id} origin kind changed.`);
    }
    if (!documentsById.has(origin.documentId)) {
      issues.push(
        `${datasetPath} case ${evaluationCase.id} origin document is not current.`,
      );
      continue;
    }
    if (origin.kind !== "image") {
      continue;
    }
    const metadata = evaluationCase.metadata.source;
    if (metadata.kind !== "image") {
      issues.push(`${datasetPath} case ${evaluationCase.id} image metadata is missing.`);
      continue;
    }
    const visualIdentity = createHash("sha256")
      .update(Buffer.from(origin.content, "base64"))
      .digest("hex");
    if (metadata.visualIdentitySha256 !== visualIdentity) {
      issues.push(`${datasetPath} case ${evaluationCase.id} visual identity changed.`);
    }
  }
}

function areSamePortableSourceFile(actual: string, expected: string): boolean {
  const normalizedActual = actual.replaceAll("\\", "/");
  const normalizedExpected = expected.replaceAll("\\", "/");
  return normalizedActual === normalizedExpected
    || normalizedActual.endsWith(`/${normalizedExpected}`);
}
