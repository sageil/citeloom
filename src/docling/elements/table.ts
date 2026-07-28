import type { DoclingDocumentIndex } from "./document-index.js";
import { readDoclingCaption } from "./document-index.js";
import {
  createDoclingElementId,
  createDoclingSourceLocation,
  uniqueDoclingStrings,
} from "./metadata.js";
import type { DoclingTableCell, DoclingTableItem } from "../protocol/index.js";
import type { TableCell, TableElement } from "../../domain/source-elements.js";

export interface CreateDoclingTableElementRequest {
  documentId: string;
  index: DoclingDocumentIndex;
  item: DoclingTableItem;
  sectionPath: string[];
  sourceFile: string;
  position: number;
}

export function createDoclingTableElement(
  request: CreateDoclingTableElementRequest,
): TableElement {
  const item = request.item;
  if (item.rowCount === 0 || item.columnCount === 0) {
    throw new Error(`Docling table ${item.selfRef} has no rows or columns.`);
  }
  const caption = readDoclingCaption(item.captions, request.index.texts);
  const grid = buildTableGrid(item);
  const headerRowCount = readHeaderRowCount(item.tableCells);
  const header = buildTableHeader(grid, headerRowCount, item.columnCount);
  const rows = grid.slice(headerRowCount);
  const content = serializeTableRows(caption, header, rows);
  const cells: TableCell[] = [];
  for (const cell of item.tableCells) {
    cells.push({ ...cell });
  }
  const sourceRefs = uniqueDoclingStrings([item.selfRef, ...item.captions]);
  return {
    caption,
    content,
    detectedType: item.label,
    documentId: request.documentId,
    id: createDoclingElementId(
      request.documentId,
      "table",
      sourceRefs,
      content,
      request.position,
    ),
    kind: "table",
    ...createDoclingSourceLocation(item.provenance, request.index.pages),
    sectionPath: [...request.sectionPath],
    sourceFile: request.sourceFile,
    sourceRefs,
    table: {
      cells,
      columnCount: item.columnCount,
      rowCount: item.rowCount,
      rowEnd: item.rowCount,
      rowStart: 0,
    },
  };
}

function buildTableGrid(item: DoclingTableItem): string[][] {
  const grid: string[][] = [];
  for (let rowIndex = 0; rowIndex < item.rowCount; rowIndex += 1) {
    grid.push(Array.from({ length: item.columnCount }, () => ""));
  }
  for (const cell of item.tableCells) {
    const row = grid[cell.startRow];
    if (row === undefined || cell.startColumn >= item.columnCount) {
      throw new Error(`Docling table ${item.selfRef} contains an invalid cell.`);
    }
    row[cell.startColumn] = normalizeTableText(cell.text);
  }
  return grid;
}

function readHeaderRowCount(cells: DoclingTableCell[]): number {
  let headerRowCount = 0;
  for (const cell of cells) {
    if (cell.columnHeader) {
      headerRowCount = Math.max(headerRowCount, cell.endRow);
    }
  }
  return headerRowCount;
}

function buildTableHeader(
  grid: string[][],
  headerRowCount: number,
  columnCount: number,
): string[] {
  const header: string[] = [];
  for (let column = 0; column < columnCount; column += 1) {
    const values: string[] = [];
    for (let row = 0; row < headerRowCount; row += 1) {
      const value = grid[row]?.[column]?.trim() ?? "";
      if (value !== "" && !values.includes(value)) {
        values.push(value);
      }
    }
    header.push(values.join(" - "));
  }
  return header;
}

function serializeTableRows(
  caption: string | null,
  header: string[],
  rows: string[][],
): string {
  const lines: string[] = [];
  if (caption !== null) {
    lines.push(`Caption: ${caption}`, "");
  }
  lines.push(serializeMarkdownRow(header));
  lines.push(serializeMarkdownRow(header.map(() => "---")));
  for (const row of rows) {
    lines.push(serializeMarkdownRow(row));
  }
  return lines.join("\n");
}

function serializeMarkdownRow(values: string[]): string {
  const escaped: string[] = [];
  for (const value of values) {
    escaped.push(value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim());
  }
  return `| ${escaped.join(" | ")} |`;
}

function normalizeTableText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
