import { describe, expect, it } from "vitest";

import {
  applyAnswerContentUpdate,
  createEmptyAnswerContent,
  readAnswerContentUpdate,
} from "../web/assets/scripts/citeloom-answer-content.js";

describe("CiteLoom answer content updates", () => {
  it("applies citation metadata without redrawing streamed statement content", () => {
    const initial = readAnswerContentUpdate({
      citations: [],
      statementCount: 1,
      statements: [{
        citationKeys: [],
        content: "Revenue increased.",
        index: 0,
        mode: "replace",
        presentation: "paragraph",
        section: "answer",
      }],
    });
    const rendered = applyAnswerContentUpdate(
      createEmptyAnswerContent(),
      initial,
    );
    const metadata = readAnswerContentUpdate({
      citations: [{
        key: "citation-1",
        pageNumbers: [7],
        sourceFile: "report.pdf",
      }],
      statementCount: 1,
      statements: [{
        citationKeys: ["citation-1"],
        index: 0,
        mode: "metadata",
      }],
    });
    const updated = applyAnswerContentUpdate(rendered, metadata);

    expect(updated.statements[0]).toEqual({
      ...rendered.statements[0],
      citationKeys: ["citation-1"],
    });
    expect(updated.statements[0].content).toBe("Revenue increased.");
    expect(updated.statements[0].contentHtml).toBe(
      rendered.statements[0].contentHtml,
    );
  });

  it("rejects metadata updates for statements that have not been rendered", () => {
    const update = readAnswerContentUpdate({
      citations: [],
      statementCount: 1,
      statements: [{ citationKeys: [], index: 0, mode: "metadata" }],
    });

    expect(() => applyAnswerContentUpdate(
      createEmptyAnswerContent(),
      update,
    )).toThrow("A streamed answer metadata update has no existing statement.");
  });
});
