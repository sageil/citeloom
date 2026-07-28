import type {
  DoclingDocument,
  DoclingGroup,
  DoclingPage,
  DoclingPictureItem,
  DoclingTableItem,
  DoclingTextItem,
} from "../protocol/index.js";

const ignoredLabels = new Set(["page_footer", "page_header"]);
const headingLabels = new Set(["section_header", "title"]);

export type OrderedDoclingItem =
  | { kind: "picture"; value: DoclingPictureItem }
  | { kind: "table"; value: DoclingTableItem }
  | { kind: "text"; value: DoclingTextItem };

export interface DoclingDocumentIndex {
  groups: Map<string, DoclingGroup>;
  pages: Map<number, DoclingPage>;
  pictures: Map<string, DoclingPictureItem>;
  tables: Map<string, DoclingTableItem>;
  texts: Map<string, DoclingTextItem>;
}

export function buildDoclingDocumentIndex(
  document: DoclingDocument,
): DoclingDocumentIndex {
  const groups = new Map<string, DoclingGroup>();
  const pictures = new Map<string, DoclingPictureItem>();
  const tables = new Map<string, DoclingTableItem>();
  const texts = new Map<string, DoclingTextItem>();
  const pages = new Map<number, DoclingPage>();
  for (const group of document.groups) {
    groups.set(group.selfRef, group);
  }
  for (const picture of document.pictures) {
    pictures.set(picture.selfRef, picture);
  }
  for (const table of document.tables) {
    tables.set(table.selfRef, table);
  }
  for (const text of document.texts) {
    texts.set(text.selfRef, text);
  }
  for (const page of document.pages) {
    pages.set(page.pageNumber, page);
  }
  return { groups, pages, pictures, tables, texts };
}

export function readOrderedDoclingItems(
  body: DoclingGroup,
  index: DoclingDocumentIndex,
): OrderedDoclingItem[] {
  const items: OrderedDoclingItem[] = [];
  const activeGroups = new Set<string>();
  const visitedItems = new Set<string>();
  appendReferencedItems(body.children, index, activeGroups, visitedItems, items);
  return items;
}

export function isIndexableDoclingItem(
  contentLayer: string,
  label: string,
): boolean {
  if (ignoredLabels.has(label)) {
    return false;
  }
  return contentLayer === "body" || contentLayer === "notes";
}

export function isDoclingHeadingLabel(label: string): boolean {
  return headingLabels.has(label);
}

export function chooseDoclingItemSectionPath(
  selfRef: string,
  sequentialSectionPath: string[],
  index: DoclingDocumentIndex,
): string[] {
  const hierarchical = readHierarchicalDoclingSectionPath(selfRef, index);
  return hierarchical.length === 0 ? sequentialSectionPath : hierarchical;
}

export function readHierarchicalDoclingSectionPath(
  selfRef: string,
  index: DoclingDocumentIndex,
): string[] {
  const sectionPath: string[] = [];
  const visited = new Set<string>();
  let reference: string | null = selfRef;
  while (reference !== null && reference !== "#/body" && reference !== "#/furniture") {
    if (visited.has(reference)) {
      throw new Error(`Invalid Docling parent hierarchy: cycle at ${reference}.`);
    }
    visited.add(reference);
    const text = index.texts.get(reference);
    if (text !== undefined) {
      if (isDoclingHeadingLabel(text.label) && text.text.trim() !== "") {
        sectionPath.unshift(text.text.trim());
      }
      reference = text.parent;
      continue;
    }
    const group = index.groups.get(reference);
    if (group !== undefined) {
      const sectionName = readGroupSectionName(group, index);
      if (sectionName !== null && sectionPath[0] !== sectionName) {
        sectionPath.unshift(sectionName);
      }
      reference = group.parent;
      continue;
    }
    const table = index.tables.get(reference);
    if (table !== undefined) {
      reference = table.parent;
      continue;
    }
    const picture = index.pictures.get(reference);
    if (picture !== undefined) {
      reference = picture.parent;
      continue;
    }
    throw new Error(`Docling parent reference does not resolve: ${reference}.`);
  }
  return sectionPath;
}

function readGroupSectionName(
  group: DoclingGroup,
  index: DoclingDocumentIndex,
): string | null {
  if (group.label === "sheet") {
    const name = group.name.trim();
    return name === "" ? null : name;
  }
  const slideMatch = /^slide-(\d+)$/.exec(group.name);
  if (group.label !== "chapter" || slideMatch === null) {
    return null;
  }
  for (const childReference of group.children) {
    const child = index.texts.get(childReference);
    if (
      child !== undefined
      && isDoclingHeadingLabel(child.label)
      && child.text.trim() !== ""
    ) {
      return child.text.trim();
    }
  }
  const zeroBasedSlideNumber = Number.parseInt(slideMatch[1] ?? "", 10);
  if (!Number.isSafeInteger(zeroBasedSlideNumber)) {
    return null;
  }
  return `Slide ${zeroBasedSlideNumber + 1}`;
}

export function readDoclingCaption(
  references: string[],
  texts: Map<string, DoclingTextItem>,
): string | null {
  const parts: string[] = [];
  for (const reference of references) {
    const text = texts.get(reference);
    if (text === undefined) {
      throw new Error(`Docling caption reference does not resolve: ${reference}.`);
    }
    const value = text.text.trim();
    if (value !== "") {
      parts.push(value);
    }
  }
  return parts.length === 0 ? null : parts.join(" ");
}

function appendReferencedItems(
  references: string[],
  index: DoclingDocumentIndex,
  activeGroups: Set<string>,
  visitedItems: Set<string>,
  items: OrderedDoclingItem[],
): void {
  for (const reference of references) {
    const group = index.groups.get(reference);
    if (group !== undefined) {
      if (activeGroups.has(reference)) {
        throw new Error(`Invalid Docling document hierarchy: cycle at ${reference}.`);
      }
      activeGroups.add(reference);
      appendReferencedItems(
        group.children,
        index,
        activeGroups,
        visitedItems,
        items,
      );
      activeGroups.delete(reference);
      continue;
    }
    if (visitedItems.has(reference)) {
      throw new Error(`Invalid Docling document hierarchy: duplicate ${reference}.`);
    }
    const text = index.texts.get(reference);
    if (text !== undefined) {
      visitedItems.add(reference);
      items.push({ kind: "text", value: text });
      appendReferencedItems(
        text.children,
        index,
        activeGroups,
        visitedItems,
        items,
      );
      continue;
    }
    const table = index.tables.get(reference);
    if (table !== undefined) {
      visitedItems.add(reference);
      items.push({ kind: "table", value: table });
      appendReferencedItems(
        table.children,
        index,
        activeGroups,
        visitedItems,
        items,
      );
      continue;
    }
    const picture = index.pictures.get(reference);
    if (picture !== undefined) {
      visitedItems.add(reference);
      items.push({ kind: "picture", value: picture });
      appendReferencedItems(
        picture.children,
        index,
        activeGroups,
        visitedItems,
        items,
      );
      continue;
    }
    throw new Error(`Unsupported Docling document reference: ${reference}.`);
  }
}
