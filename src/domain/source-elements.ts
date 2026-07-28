export type SourceElement = ImageElement | TableElement | TextElement;
export type RetrievalSourceElement =
  | Omit<ImageElement, "content">
  | TableElement
  | TextElement;

interface SourceElementBase {
  documentId: string;
  id: string;
  pageNumber: number | null;
  pageNumbers: number[];
  regions: SourceRegion[];
  sectionPath: string[];
  sourceFile: string;
  sourceRefs: string[];
}

export interface SourceBoundingBox {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface SourceCharacterSpan {
  end: number;
  start: number;
}

export interface SourceRegion {
  boundingBox: SourceBoundingBox;
  characterSpan: SourceCharacterSpan;
  pageNumber: number;
}

export interface ImageElement extends SourceElementBase {
  caption: string | null;
  content: string;
  detectedType: string;
  kind: "image";
  mimeType: string;
}

export interface TableElement extends SourceElementBase {
  caption: string | null;
  content: string;
  detectedType: string;
  kind: "table";
  table: TableStructure;
}

export interface TableCell {
  columnHeader: boolean;
  columnSpan: number;
  endColumn: number;
  endRow: number;
  rowHeader: boolean;
  rowSection: boolean;
  rowSpan: number;
  startColumn: number;
  startRow: number;
  text: string;
}

export interface TableStructure {
  cells: TableCell[];
  columnCount: number;
  rowCount: number;
  rowEnd: number;
  rowStart: number;
}

export interface TextElement extends SourceElementBase {
  content: string;
  detectedTypes: string[];
  kind: "text";
}
