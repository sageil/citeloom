import { createHash } from "node:crypto";

import type { DoclingPartitionResult } from "../../src/docling/index.js";
import type {
  DoclingDocument,
  DoclingProvenance,
  DoclingTableCell,
} from "../../src/docling/protocol/index.js";
import type {
  DoclingQualityComparison,
  DoclingQualityDifference,
} from "./model.js";
import type { SourceElement } from "../../src/domain/source-elements.js";

const MAX_DIFFERENCE_PATHS = 100;

interface CanonicalDoclingOutput {
  availablePageImages: number[];
  documentName: string;
  documentVersion: string;
  elements: CanonicalElement[];
  hierarchy: CanonicalHierarchyItem[];
  pages: CanonicalPage[];
  pictures: CanonicalPicture[];
  schemaName: string;
  tables: CanonicalTable[];
  texts: CanonicalText[];
}

interface CanonicalElement {
  content: string | null;
  id: string;
  imageAvailable: boolean | null;
  kind: "image" | "table" | "text";
  pageNumbers: number[];
  regions: SourceElement["regions"];
  sectionPath: string[];
  sourceRefs: string[];
  table: CanonicalElementTable | null;
}

interface CanonicalElementTable {
  cells: DoclingTableCell[];
  columnCount: number;
  rowCount: number;
  rowEnd: number;
  rowStart: number;
}

interface CanonicalHierarchyItem {
  children: string[];
  contentLayer: string;
  kind: "group" | "picture" | "table" | "text";
  label: string;
  name: string | null;
  parent: string | null;
  selfRef: string;
}

interface CanonicalPage {
  height: number;
  pageNumber: number;
  width: number;
}

interface CanonicalPicture {
  captions: string[];
  children: string[];
  contentLayer: string;
  embeddedAvailable: boolean;
  label: string;
  parent: string | null;
  provenance: DoclingProvenance[];
  selfRef: string;
}

interface CanonicalTable {
  cells: DoclingTableCell[];
  captions: string[];
  children: string[];
  columnCount: number;
  contentLayer: string;
  label: string;
  parent: string | null;
  provenance: DoclingProvenance[];
  rowCount: number;
  selfRef: string;
}

interface CanonicalText {
  children: string[];
  contentLayer: string;
  label: string;
  originalText: string;
  parent: string | null;
  provenance: DoclingProvenance[];
  selfRef: string;
  text: string;
}

export function fingerprintDoclingOutput(
  result: DoclingPartitionResult,
): string {
  return fingerprintCanonicalValue(canonicalizeDoclingOutput(result));
}

export function compareDoclingOutputQuality(
  baseline: DoclingPartitionResult,
  candidate: DoclingPartitionResult,
): DoclingQualityComparison {
  const expected = canonicalizeDoclingOutput(baseline);
  const actual = canonicalizeDoclingOutput(candidate);
  const differencePaths: string[] = [];
  collectDifferencePaths(expected, actual, "output", differencePaths);
  const differences: DoclingQualityDifference[] = [];
  for (const path of differencePaths) {
    differences.push({
      actual: fingerprintCanonicalValue(actual),
      expected: fingerprintCanonicalValue(expected),
      path,
    });
  }
  return { differences, passed: differences.length === 0 };
}

function canonicalizeDoclingOutput(
  result: DoclingPartitionResult,
): CanonicalDoclingOutput {
  const document = result.artifact.document;
  const elements = canonicalizeElements(result.elements);
  const hierarchy = canonicalizeHierarchy(document);
  const pages = canonicalizePages(document.pages);
  const pictures = canonicalizePictures(
    document.pictures,
    result.embeddedPictureRefs,
  );
  const tables = canonicalizeTables(document.tables);
  const texts = canonicalizeTexts(document.texts);
  return {
    availablePageImages: [...result.availablePageImages],
    documentName: document.name,
    documentVersion: document.version,
    elements,
    hierarchy,
    pages,
    pictures,
    schemaName: document.schemaName,
    tables,
    texts,
  };
}

function canonicalizePages(
  pages: DoclingDocument["pages"],
): CanonicalPage[] {
  const canonical: CanonicalPage[] = [];
  for (const page of pages) {
    canonical.push({
      height: page.height,
      pageNumber: page.pageNumber,
      width: page.width,
    });
  }
  return canonical;
}

function canonicalizePictures(
  pictures: DoclingDocument["pictures"],
  embeddedPictureRefs: readonly string[],
): CanonicalPicture[] {
  const canonical: CanonicalPicture[] = [];
  for (const picture of pictures) {
    canonical.push({
      captions: [...picture.captions],
      children: [...picture.children],
      contentLayer: picture.contentLayer,
      embeddedAvailable: embeddedPictureRefs.includes(picture.selfRef),
      label: picture.label,
      parent: picture.parent,
      provenance: picture.provenance,
      selfRef: picture.selfRef,
    });
  }
  return canonical;
}

function canonicalizeTables(
  tables: DoclingDocument["tables"],
): CanonicalTable[] {
  const canonical: CanonicalTable[] = [];
  for (const table of tables) {
    canonical.push({
      cells: canonicalizeTableCells(table.tableCells),
      captions: [...table.captions],
      children: [...table.children],
      columnCount: table.columnCount,
      contentLayer: table.contentLayer,
      label: table.label,
      parent: table.parent,
      provenance: table.provenance,
      rowCount: table.rowCount,
      selfRef: table.selfRef,
    });
  }
  return canonical;
}

function canonicalizeTexts(
  texts: DoclingDocument["texts"],
): CanonicalText[] {
  const canonical: CanonicalText[] = [];
  for (const text of texts) {
    canonical.push({
      children: [...text.children],
      contentLayer: text.contentLayer,
      label: text.label,
      originalText: normalizeText(text.originalText),
      parent: text.parent,
      provenance: text.provenance,
      selfRef: text.selfRef,
      text: normalizeText(text.text),
    });
  }
  return canonical;
}

function canonicalizeElements(elements: SourceElement[]): CanonicalElement[] {
  const canonical: CanonicalElement[] = [];
  for (const element of elements) {
    let table: CanonicalElementTable | null = null;
    if (element.kind === "table") {
      table = {
        cells: canonicalizeTableCells(element.table.cells),
        columnCount: element.table.columnCount,
        rowCount: element.table.rowCount,
        rowEnd: element.table.rowEnd,
        rowStart: element.table.rowStart,
      };
    }
    canonical.push({
      content: element.kind === "image" ? null : normalizeText(element.content),
      id: element.id,
      imageAvailable: element.kind === "image" ? element.content.length > 0 : null,
      kind: element.kind,
      pageNumbers: [...element.pageNumbers],
      regions: element.regions,
      sectionPath: element.sectionPath.map(normalizeText),
      sourceRefs: [...element.sourceRefs],
      table,
    });
  }
  return canonical;
}

function canonicalizeHierarchy(
  document: DoclingDocument,
): CanonicalHierarchyItem[] {
  const hierarchy: CanonicalHierarchyItem[] = [];
  const groups = [document.body, document.furniture, ...document.groups];
  for (const group of groups) {
    hierarchy.push({
      children: [...group.children],
      contentLayer: group.contentLayer,
      kind: "group",
      label: group.label,
      name: group.name,
      parent: group.parent,
      selfRef: group.selfRef,
    });
  }
  for (const text of document.texts) {
    hierarchy.push(readHierarchyItem(text, "text"));
  }
  for (const table of document.tables) {
    hierarchy.push(readHierarchyItem(table, "table"));
  }
  for (const picture of document.pictures) {
    hierarchy.push(readHierarchyItem(picture, "picture"));
  }
  return hierarchy;
}

function readHierarchyItem(
  item: {
    children: string[];
    contentLayer: string;
    label: string;
    parent: string | null;
    selfRef: string;
  },
  kind: CanonicalHierarchyItem["kind"],
): CanonicalHierarchyItem {
  return {
    children: [...item.children],
    contentLayer: item.contentLayer,
    kind,
    label: item.label,
    name: null,
    parent: item.parent,
    selfRef: item.selfRef,
  };
}

function canonicalizeTableCell(cell: DoclingTableCell): DoclingTableCell {
  return { ...cell, text: normalizeText(cell.text) };
}

function canonicalizeTableCells(
  cells: readonly DoclingTableCell[],
): DoclingTableCell[] {
  const canonical: DoclingTableCell[] = [];
  for (const cell of cells) {
    canonical.push(canonicalizeTableCell(cell));
  }
  return canonical;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/g, ""))
    .join("\n");
}

function collectDifferencePaths(
  expected: unknown,
  actual: unknown,
  path: string,
  differences: string[],
): void {
  if (differences.length >= MAX_DIFFERENCE_PATHS || Object.is(expected, actual)) {
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      differences.push(`${path}.length`);
    }
    const length = Math.min(expected.length, actual.length);
    for (let index = 0; index < length; index += 1) {
      collectDifferencePaths(
        expected[index],
        actual[index],
        `${path}[${index}]`,
        differences,
      );
    }
    return;
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    const sortedKeys = [...keys].sort((left, right) => left.localeCompare(right));
    for (const key of sortedKeys) {
      collectDifferencePaths(
        expected[key],
        actual[key],
        `${path}.${key}`,
        differences,
      );
    }
    return;
  }
  differences.push(path);
}

function isPlainObject(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fingerprintCanonicalValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
