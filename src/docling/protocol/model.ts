import type { SourceCharacterSpan } from "../../domain/source-elements.js";
import type { DoclingProfilingSummary } from "./run-metadata.js";

export const DOCLING_SERVE_VERSION = "1.27.0";
export const DOCLING_VERSION = "2.113.0";
export const DOCLING_OCR_PRESET = "rapidocr";

export const DOCLING_CONTENT_LAYERS = [
  "background",
  "body",
  "furniture",
  "invisible",
  "notes",
] as const;

export type DoclingContentLayer = (typeof DOCLING_CONTENT_LAYERS)[number];

export interface DoclingConversionError {
  category: string;
  componentType: string;
  message: string;
  moduleName: string;
  pageNumber: number | null;
}

export type DoclingErrorElementKind = "image" | "table" | "text";

export interface DoclingErrorDetail extends DoclingConversionError {
  doclingLabel: string | null;
  elementKind: DoclingErrorElementKind | null;
  pageRangeEnd: number | null;
  pageRangeStart: number | null;
  sourceRef: string | null;
}

export interface DoclingConversionResult {
  document: DoclingDocument;
  filename: string;
  processingTimeMs: number;
  profiling: DoclingProfilingSummary[];
}

export interface DoclingDocument {
  body: DoclingGroup;
  furniture: DoclingGroup;
  groups: DoclingGroup[];
  name: string;
  pages: DoclingPage[];
  pictures: DoclingPictureItem[];
  schemaName: string;
  tables: DoclingTableItem[];
  texts: DoclingTextItem[];
  version: string;
}

export interface DoclingGroup {
  children: string[];
  contentLayer: DoclingContentLayer;
  label: string;
  name: string;
  parent: string | null;
  selfRef: string;
}

export interface DoclingImageReference {
  content: string;
  height: number;
  mimeType: string;
  width: number;
}

export interface DoclingPage {
  height: number;
  image: DoclingImageReference | null;
  pageNumber: number;
  width: number;
}

export interface DoclingPictureItem {
  captions: string[];
  children: string[];
  contentLayer: DoclingContentLayer;
  image: DoclingImageReference | null;
  label: string;
  parent: string | null;
  provenance: DoclingProvenance[];
  selfRef: string;
}

export interface DoclingProvenance {
  boundingBox: DoclingSourceBoundingBox;
  characterSpan: SourceCharacterSpan;
  pageNumber: number;
}

export interface DoclingSourceBoundingBox {
  bottom: number;
  coordinateOrigin: "BOTTOMLEFT" | "TOPLEFT";
  left: number;
  right: number;
  top: number;
}

export interface DoclingTableCell {
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

export interface DoclingTableItem {
  captions: string[];
  children: string[];
  columnCount: number;
  contentLayer: DoclingContentLayer;
  label: string;
  parent: string | null;
  provenance: DoclingProvenance[];
  rowCount: number;
  selfRef: string;
  tableCells: DoclingTableCell[];
}

export interface DoclingTextItem {
  children: string[];
  contentLayer: DoclingContentLayer;
  label: string;
  originalText: string;
  parent: string | null;
  provenance: DoclingProvenance[];
  selfRef: string;
  text: string;
}

export interface DoclingVersionIdentity {
  coreVersion: string;
  jobkitVersion: string;
  modelsVersion: string;
  parseVersion: string;
  serveVersion: typeof DOCLING_SERVE_VERSION;
  version: typeof DOCLING_VERSION;
}

export interface StoredDoclingArtifact {
  document: DoclingDocument;
  documentId: string;
  processingTimeMs: number;
  version: DoclingVersionIdentity;
}
