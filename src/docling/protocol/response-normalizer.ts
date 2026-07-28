import type { SourceCharacterSpan } from "../../domain/source-elements.js";
import type {
  DoclingDocument,
  DoclingGroup,
  DoclingImageReference,
  DoclingPage,
  DoclingPictureItem,
  DoclingProvenance,
  DoclingSourceBoundingBox,
  DoclingTableCell,
  DoclingTableItem,
  DoclingTextItem,
} from "./model.js";
import type {
  RawBoundingBox,
  RawCharacterSpan,
  RawDoclingDocument,
  RawGroup,
  RawImageReference,
  RawPage,
  RawPictureItem,
  RawProvenance,
  RawTableCell,
  RawTableItem,
  RawTextItem,
} from "./response-schemas.js";

const BASE64_CONTENT_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const MAXIMUM_IMAGE_BYTES = 32 * 1_024 * 1_024;

export function normalizeDoclingDocument(
  document: RawDoclingDocument,
): DoclingDocument {
  const groups: DoclingGroup[] = [];
  for (const group of document.groups) {
    groups.push(normalizeGroup(group));
  }
  const texts: DoclingTextItem[] = [];
  for (const text of document.texts) {
    texts.push(normalizeTextItem(text));
  }
  const pictures: DoclingPictureItem[] = [];
  for (const picture of document.pictures) {
    pictures.push(normalizePictureItem(picture));
  }
  const tables: DoclingTableItem[] = [];
  for (const table of document.tables) {
    tables.push(normalizeTableItem(table));
  }
  const pages: DoclingPage[] = [];
  for (const page of Object.values(document.pages)) {
    pages.push(normalizePage(page));
  }
  pages.sort((left, right) => left.pageNumber - right.pageNumber);
  requireUniqueSelfReferences(groups, texts, pictures, tables);
  requireUniquePageNumbers(pages);
  return {
    body: normalizeGroup(document.body),
    furniture: normalizeGroup(document.furniture),
    groups,
    name: document.name,
    pages,
    pictures,
    schemaName: document.schema_name,
    tables,
    texts,
    version: document.version,
  };
}

function normalizeGroup(group: RawGroup): DoclingGroup {
  return {
    children: normalizeReferences(group.children),
    contentLayer: group.content_layer,
    label: group.label,
    name: group.name,
    parent: normalizeParent(group.parent),
    selfRef: group.self_ref,
  };
}

function normalizeTextItem(item: RawTextItem): DoclingTextItem {
  return {
    children: normalizeReferences(item.children),
    contentLayer: item.content_layer,
    label: item.label,
    originalText: item.orig,
    parent: normalizeParent(item.parent),
    provenance: normalizeProvenance(item.prov),
    selfRef: item.self_ref,
    text: item.text,
  };
}

function normalizePictureItem(item: RawPictureItem): DoclingPictureItem {
  return {
    captions: normalizeReferences(item.captions),
    children: normalizeReferences(item.children),
    contentLayer: item.content_layer,
    image: normalizeImageReference(item.image),
    label: item.label,
    parent: normalizeParent(item.parent),
    provenance: normalizeProvenance(item.prov),
    selfRef: item.self_ref,
  };
}

function normalizeTableItem(item: RawTableItem): DoclingTableItem {
  const cells: DoclingTableCell[] = [];
  for (const cell of item.data.table_cells) {
    cells.push(normalizeTableCell(cell, item.data.num_rows, item.data.num_cols));
  }
  return {
    captions: normalizeReferences(item.captions),
    children: normalizeReferences(item.children),
    columnCount: item.data.num_cols,
    contentLayer: item.content_layer,
    label: item.label,
    parent: normalizeParent(item.parent),
    provenance: normalizeProvenance(item.prov),
    rowCount: item.data.num_rows,
    selfRef: item.self_ref,
    tableCells: cells,
  };
}

function normalizeTableCell(
  cell: RawTableCell,
  rowCount: number,
  columnCount: number,
): DoclingTableCell {
  if (
    cell.end_row_offset_idx > rowCount ||
    cell.end_col_offset_idx > columnCount ||
    cell.end_row_offset_idx <= cell.start_row_offset_idx ||
    cell.end_col_offset_idx <= cell.start_col_offset_idx
  ) {
    throw new Error("Invalid Docling response: table cell range is out of bounds.");
  }
  return {
    columnHeader: cell.column_header,
    columnSpan: cell.col_span,
    endColumn: cell.end_col_offset_idx,
    endRow: cell.end_row_offset_idx,
    rowHeader: cell.row_header,
    rowSection: cell.row_section,
    rowSpan: cell.row_span,
    startColumn: cell.start_col_offset_idx,
    startRow: cell.start_row_offset_idx,
    text: cell.text,
  };
}

function normalizePage(page: RawPage): DoclingPage {
  return {
    height: page.size.height,
    image: normalizeImageReference(page.image),
    pageNumber: page.page_no,
    width: page.size.width,
  };
}

function normalizeImageReference(
  image: RawImageReference | null,
): DoclingImageReference | null {
  if (image === null) {
    return null;
  }
  const prefix = `data:${image.mimetype};base64,`;
  if (!image.uri.startsWith(prefix)) {
    throw new Error("Invalid Docling response: expected an embedded image data URI.");
  }
  const content = image.uri.slice(prefix.length);
  if (content === "" || !BASE64_CONTENT_PATTERN.test(content)) {
    throw new Error("Invalid Docling response: embedded image data is invalid.");
  }
  if (readBase64ByteLength(content) > MAXIMUM_IMAGE_BYTES) {
    throw new Error(
      `Invalid Docling response: embedded image exceeds ${MAXIMUM_IMAGE_BYTES} bytes.`,
    );
  }
  return {
    content,
    height: image.size.height,
    mimeType: image.mimetype,
    width: image.size.width,
  };
}

function readBase64ByteLength(content: string): number {
  let padding = 0;
  if (content.endsWith("==")) {
    padding = 2;
  } else if (content.endsWith("=")) {
    padding = 1;
  }
  return Math.floor(content.length * 3 / 4) - padding;
}

function normalizeProvenance(values: RawProvenance[]): DoclingProvenance[] {
  const provenance: DoclingProvenance[] = [];
  for (const value of values) {
    provenance.push({
      boundingBox: normalizeBoundingBox(value.bbox),
      characterSpan: normalizeCharacterSpan(value.charspan),
      pageNumber: value.page_no,
    });
  }
  return provenance;
}

function normalizeBoundingBox(value: RawBoundingBox): DoclingSourceBoundingBox {
  return {
    bottom: value.b,
    coordinateOrigin: value.coord_origin,
    left: value.l,
    right: value.r,
    top: value.t,
  };
}

function normalizeCharacterSpan(value: RawCharacterSpan): SourceCharacterSpan {
  return { end: value[1], start: value[0] };
}

function normalizeReferences(values: Array<{ $ref: string }>): string[] {
  const references: string[] = [];
  for (const value of values) {
    references.push(value.$ref);
  }
  return references;
}

function normalizeParent(value: { $ref: string } | null): string | null {
  return value?.$ref ?? null;
}

function requireUniqueSelfReferences(
  groups: DoclingGroup[],
  texts: DoclingTextItem[],
  pictures: DoclingPictureItem[],
  tables: DoclingTableItem[],
): void {
  const references = new Set<string>();
  const items = [...groups, ...texts, ...pictures, ...tables];
  for (const item of items) {
    if (references.has(item.selfRef)) {
      throw new Error(`Invalid Docling response: duplicate reference ${item.selfRef}.`);
    }
    references.add(item.selfRef);
  }
}

function requireUniquePageNumbers(pages: DoclingPage[]): void {
  const pageNumbers = new Set<number>();
  for (const page of pages) {
    if (pageNumbers.has(page.pageNumber)) {
      throw new Error(
        `Invalid Docling response: duplicate page number ${page.pageNumber}.`,
      );
    }
    pageNumbers.add(page.pageNumber);
  }
}
