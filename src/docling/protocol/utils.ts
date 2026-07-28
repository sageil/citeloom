import type { SourceBoundingBox } from "../../domain/source-elements.js";
import type {
  DoclingDocument,
  DoclingPage,
  DoclingPictureItem,
  DoclingProvenance,
} from "./model.js";

export function stripDoclingImages(document: DoclingDocument): DoclingDocument {
  const pages: DoclingPage[] = [];
  for (const page of document.pages) {
    pages.push({
      height: page.height,
      image: null,
      pageNumber: page.pageNumber,
      width: page.width,
    });
  }
  const pictures: DoclingPictureItem[] = [];
  for (const picture of document.pictures) {
    pictures.push({ ...picture, image: null });
  }
  return { ...document, pages, pictures };
}

export function toTopLeftBoundingBox(
  provenance: DoclingProvenance,
  page: DoclingPage,
): SourceBoundingBox {
  const source = provenance.boundingBox;
  const horizontalStart = Math.min(source.left, source.right);
  const horizontalEnd = Math.max(source.left, source.right);
  const verticalStart = Math.min(source.top, source.bottom);
  const verticalEnd = Math.max(source.top, source.bottom);
  if (source.coordinateOrigin === "TOPLEFT") {
    return {
      bottom: verticalEnd,
      left: horizontalStart,
      right: horizontalEnd,
      top: verticalStart,
    };
  }
  return {
    bottom: page.height - verticalStart,
    left: horizontalStart,
    right: horizontalEnd,
    top: page.height - verticalEnd,
  };
}
