import { describe, expect, it } from "vitest";

import { publishedAnswerDocumentSchema } from "../src/answers/published-schema.js";
import { readAnswerPresentation } from "../web/assets/scripts/citeloom-ask.js";
import {
  buildSourceLocation,
  buildTableStructure,
} from "./source-element-fixture.js";

describe("ask answer presentation", () => {
  it("keeps table presentation rows out of the canonical speech document", () => {
    const citationId = "00000000-0000-4000-8000-000000000001";
    const answerDocument = {
      citations: [{
        citationNumber: 1,
        documentId: "a".repeat(64),
        documentVersionId: "00000000-0000-4000-8000-000000000002",
        elementId: "b".repeat(64),
        evidence: {
          content: "A table citation.",
          kind: "table",
          table: buildTableStructure(),
        },
        id: citationId,
        kind: "table",
        pageNumbers: [1],
        regions: buildSourceLocation().regions,
        sectionPath: ["Test section"],
        sourceFile: "source.pdf",
      }],
      schemaVersion: 1,
      statements: [{
        citationIds: [citationId],
        content: "The answer cites a table.",
        presentation: "paragraph",
        section: "answer",
      }],
      status: "answered",
    };

    const answer = readAnswerPresentation(
      answerDocument,
      "answer citation table",
    );

    expect(publishedAnswerDocumentSchema.safeParse(
      JSON.parse(JSON.stringify(answer.answerDocument)),
    ).success).toBe(true);
    expect(answer.answerDocument).toEqual(answerDocument);
    const canonicalCitation = answer.answerDocument.citations[0];
    if (
      canonicalCitation === undefined
      || canonicalCitation.evidence.kind !== "table"
    ) {
      throw new Error("Expected canonical table evidence.");
    }
    expect(canonicalCitation.evidence.table).not.toHaveProperty("headerRows");
    expect(canonicalCitation.evidence.table).not.toHaveProperty("bodyRows");
    expect(answer.sources[0]).toHaveProperty(
      "evidence.table.headerRows",
      [expect.any(Object)],
    );
    expect(answer.sources[0]).toHaveProperty("evidence.table.bodyRows", []);
  });
});
