import {
  type DoclingDocumentIndex,
  readDoclingCaption,
} from "./document-index.js";
import {
  createDoclingElementId,
  createDoclingSourceLocation,
  uniqueDoclingStrings,
} from "./metadata.js";
import type {
  DoclingPage,
  DoclingPictureItem,
} from "../protocol/index.js";
import type { ImageElement } from "../../domain/source-elements.js";

export interface CreateDoclingImageElementRequest {
  documentId: string;
  index: DoclingDocumentIndex;
  item: DoclingPictureItem;
  position: number;
  sectionPath: string[];
  sourceFile: string;
}

export async function createDoclingImageElement(
  request: CreateDoclingImageElementRequest,
): Promise<ImageElement> {
  const item = request.item;
  if (item.image === null) {
    throw new Error(`Docling picture ${item.selfRef} has no extracted image.`);
  }
  const content = item.image.content;
  const mimeType = item.image.mimeType;
  const caption = readDoclingCaption(item.captions, request.index.texts);
  const sourceRefs = uniqueDoclingStrings([item.selfRef, ...item.captions]);
  const idContent = caption === null ? content : `${caption}\0${content}`;
  return {
    caption,
    content,
    detectedType: item.label,
    documentId: request.documentId,
    id: createDoclingElementId(
      request.documentId,
      "image",
      sourceRefs,
      idContent,
      request.position,
    ),
    kind: "image",
    mimeType,
    ...createDoclingSourceLocation(item.provenance, request.index.pages),
    sectionPath: [...request.sectionPath],
    sourceFile: request.sourceFile,
    sourceRefs,
  };
}

export function createStandaloneDoclingImageElement(
  documentId: string,
  page: DoclingPage,
  sourceFile: string,
): ImageElement {
  if (page.pageNumber !== 1 || page.image === null) {
    throw new Error(
      `Docling returned no full-image evidence for ${sourceFile}.`,
    );
  }
  const sourceRefs = ["source-image"];
  return {
    caption: null,
    content: page.image.content,
    detectedType: "standalone_image",
    documentId,
    id: createDoclingElementId(
      documentId,
      "image",
      sourceRefs,
      page.image.content,
      0,
    ),
    kind: "image",
    mimeType: page.image.mimeType,
    pageNumber: 1,
    pageNumbers: [1],
    regions: [{
      boundingBox: {
        bottom: page.height,
        left: 0,
        right: page.width,
        top: 0,
      },
      characterSpan: { end: 0, start: 0 },
      pageNumber: 1,
    }],
    sectionPath: [],
    sourceFile,
    sourceRefs,
  };
}
