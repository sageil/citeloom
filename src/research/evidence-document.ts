import { PDFDocument, rgb } from "pdf-lib";

import type { SourceRegion } from "../domain/source-elements.js";

export async function renderHighlightedPdf(
  content: Buffer,
  regions: readonly SourceRegion[],
): Promise<Buffer> {
  const document = await PDFDocument.load(content, { updateMetadata: false });
  const pages = document.getPages();
  for (const region of regions) {
    const page = pages[region.pageNumber - 1];
    if (page === undefined) {
      throw new Error(
        `Evidence region references missing PDF page ${region.pageNumber}.`,
      );
    }
    const { height, width } = page.getSize();
    const left = clamp(region.boundingBox.left, 0, width);
    const right = clamp(region.boundingBox.right, 0, width);
    const top = clamp(region.boundingBox.top, 0, height);
    const bottom = clamp(region.boundingBox.bottom, 0, height);
    if (right <= left || bottom <= top) {
      throw new Error("Evidence region is outside the PDF page bounds.");
    }
    page.drawRectangle({
      borderColor: rgb(0.78, 0.48, 0.02),
      borderOpacity: 0.95,
      borderWidth: 1.5,
      color: rgb(1, 0.86, 0.24),
      height: bottom - top,
      opacity: 0.28,
      width: right - left,
      x: left,
      y: height - bottom,
    });
  }
  const bytes = await document.save({
    addDefaultPage: false,
    objectsPerTick: 50,
    updateFieldAppearances: false,
    useObjectStreams: false,
  });
  return Buffer.from(bytes);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}
