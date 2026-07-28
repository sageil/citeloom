import { createHash } from "node:crypto";

import {
  type DoclingPage,
  type DoclingProvenance,
  toTopLeftBoundingBox,
} from "../protocol/index.js";
import type {
  SourceBoundingBox,
  SourceElement,
  SourceRegion,
} from "../../domain/source-elements.js";

export function createDoclingSourceLocation(
  provenance: DoclingProvenance[],
  pages: Map<number, DoclingPage>,
): Pick<SourceElement, "pageNumber" | "pageNumbers" | "regions"> {
  const regions: SourceRegion[] = [];
  const pageNumbers: number[] = [];
  for (const item of provenance) {
    const page = pages.get(item.pageNumber);
    if (page === undefined) {
      throw new Error(`Docling provenance references missing page ${item.pageNumber}.`);
    }
    if (!pageNumbers.includes(item.pageNumber)) {
      pageNumbers.push(item.pageNumber);
    }
    const boundingBox = toTopLeftBoundingBox(item, page);
    if (!hasPositiveArea(boundingBox)) {
      continue;
    }
    regions.push({
      boundingBox,
      characterSpan: { ...item.characterSpan },
      pageNumber: item.pageNumber,
    });
  }
  pageNumbers.sort((left, right) => left - right);
  return {
    pageNumber: pageNumbers[0] ?? null,
    pageNumbers,
    regions,
  };
}

function hasPositiveArea(boundingBox: SourceBoundingBox): boolean {
  return boundingBox.right > boundingBox.left
    && boundingBox.bottom > boundingBox.top;
}

export function createDoclingElementId(
  documentId: string,
  kind: SourceElement["kind"],
  sourceRefs: string[],
  content: string,
  position: number,
): string {
  const hash = createHash("sha256");
  hash.update(documentId);
  hash.update("\0");
  hash.update(kind);
  hash.update("\0");
  hash.update(String(position));
  for (const reference of sourceRefs) {
    hash.update("\0");
    hash.update(reference);
  }
  hash.update("\0");
  hash.update(content);
  return hash.digest("hex");
}

export function uniqueDoclingStrings(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

export function areSameDoclingStrings(
  left: string[],
  right: string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}
