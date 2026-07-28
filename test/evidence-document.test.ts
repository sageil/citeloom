import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import { renderHighlightedPdf } from "../src/research/evidence-document.js";

describe("highlighted evidence PDF", () => {
  it("draws a deterministic highlight using top-left source coordinates", async () => {
    const document = await PDFDocument.create();
    document.addPage([200, 300]);
    const original = Buffer.from(await document.save({ useObjectStreams: false }));
    const first = await renderHighlightedPdf(original, [{
      boundingBox: { bottom: 60, left: 20, right: 120, top: 30 },
      characterSpan: { end: 12, start: 0 },
      pageNumber: 1,
    }]);
    const second = await renderHighlightedPdf(original, [{
      boundingBox: { bottom: 60, left: 20, right: 120, top: 30 },
      characterSpan: { end: 12, start: 0 },
      pageNumber: 1,
    }]);

    expect(first.equals(second)).toBe(true);
    expect(first.byteLength).toBeGreaterThan(original.byteLength);
    const highlighted = await PDFDocument.load(first);
    expect(highlighted.getPageCount()).toBe(1);
  });

  it("rejects a region that cannot resolve to a PDF page", async () => {
    const document = await PDFDocument.create();
    document.addPage([200, 300]);
    const original = Buffer.from(await document.save());
    await expect(renderHighlightedPdf(original, [{
      boundingBox: { bottom: 60, left: 20, right: 120, top: 30 },
      characterSpan: { end: 12, start: 0 },
      pageNumber: 2,
    }])).rejects.toThrow("missing PDF page 2");
  });
});
