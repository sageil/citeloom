import type {
  SourceElement,
  SourceRegion,
  TableStructure,
} from "../src/domain/source-elements.js";
import type {
  RetrievalDescriptionRecord,
} from "../src/domain/retrieval-descriptions.js";
import type {
  RetrievedElementProvenance,
} from "../src/retrieval/document-retrieval.js";
import type {
  CandidateRepresentation,
} from "../src/retrieval/ranking/rank-fusion.js";

export function buildSourceLocation(pageNumber: number | null = 1) {
  const pageNumbers: number[] = [];
  const regions: SourceRegion[] = [];
  if (pageNumber !== null) {
    pageNumbers.push(pageNumber);
    regions.push({
      boundingBox: { bottom: 20, left: 10, right: 100, top: 10 },
      characterSpan: { end: 10, start: 0 },
      pageNumber,
    });
  }
  return {
    pageNumber,
    pageNumbers,
    regions,
    sectionPath: ["Test section"],
    sourceRefs: ["#/texts/0"],
  };
}

export function buildTableStructure(): TableStructure {
  return {
    cells: [{
      columnHeader: true,
      columnSpan: 1,
      endColumn: 1,
      endRow: 1,
      rowHeader: false,
      rowSection: false,
      rowSpan: 1,
      startColumn: 0,
      startRow: 0,
      text: "Column",
    }],
    columnCount: 1,
    rowCount: 1,
    rowEnd: 1,
    rowStart: 0,
  };
}

export function buildRetrievalDescriptionRecord(
  element: Exclude<SourceElement, { kind: "text" }>,
  retrievalText: string,
): RetrievalDescriptionRecord {
  const base = {
    documentId: element.documentId,
    id: `${element.id}-description`,
    inputFingerprint: "f".repeat(64),
    pageNumber: element.pageNumber,
    pageNumbers: element.pageNumbers,
    parentId: element.id,
    regions: element.regions,
    sectionPath: element.sectionPath,
    sourceFile: element.sourceFile,
    sourceRefs: element.sourceRefs,
  };
  if (element.kind === "table") {
    return {
      ...base,
      kind: "table",
      result: {
        description: {
          keyFacts: [],
          keywords: [],
          retrievalText,
        },
        status: "described",
      },
    };
  }
  return {
    ...base,
    kind: "image",
    result: {
      description: {
        imageType: "diagram",
        isSubstantive: true,
        keyFacts: [],
        keywords: [],
        retrievalText,
        visibleText: [],
      },
      status: "described",
    },
  };
}

export function buildExactCandidateRepresentation(
  retrievalWindowId: string,
  content: string,
): CandidateRepresentation {
  return {
    content,
    id: retrievalWindowId,
    type: "exact-window",
  };
}

export function buildRetrievedElementProvenance(
  retrievalWindowId: string,
): RetrievedElementProvenance {
  return {
    evidenceSha256: "e".repeat(64),
    representationHits: [{
      channel: "dense",
      queryIndex: 0,
      rank: 1,
      representationId: retrievalWindowId,
      representationType: "exact-window",
    }],
    retrievalWindowId,
    descriptionAffected: false,
  };
}
