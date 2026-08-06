import { describe, expect, it } from "vitest";

import {
  decodePartialAnswerContentSnapshot,
  type AnswerContentCitationCatalog,
} from "../src/answers/content-snapshot.js";

describe("answer content snapshots", () => {
  it("streams Chat topics with stable, deduplicated citation previews", () => {
    const catalog: AnswerContentCitationCatalog = new Map([
      ["SOURCE_1", {
        key: "citation-1",
        pageNumbers: [2],
        sourceFile: "first.pdf",
      }],
      ["SOURCE_2", {
        key: "citation-2",
        pageNumbers: [5],
        sourceFile: "second.pdf",
      }],
    ]);

    const snapshot = decodePartialAnswerContentSnapshot({
      answer: {
        content: "The sources describe two changes.",
        source_refs: ["SOURCE_1"],
        topics: [{
          content: "Revenue increased.",
          source_refs: ["SOURCE_1", "SOURCE_1"],
          title: "Revenue",
        }, {
          content: "Costs decreased.",
          source_refs: ["SOURCE_2"],
          title: "Costs",
        }],
      },
    }, catalog);

    expect(snapshot).toEqual({
      citations: [{
        key: "citation-1",
        pageNumbers: [2],
        sourceFile: "first.pdf",
      }, {
        key: "citation-2",
        pageNumbers: [5],
        sourceFile: "second.pdf",
      }],
      statements: [{
        citationKeys: [],
        content: "The sources describe two changes.",
        presentation: "paragraph",
        section: "answer",
      }, {
        citationKeys: ["citation-1"],
        content: "Revenue\n\nRevenue increased.",
        presentation: "bullet",
        section: "answer",
      }, {
        citationKeys: ["citation-2"],
        content: "Costs\n\nCosts decreased.",
        presentation: "bullet",
        section: "answer",
      }],
    });
  });

  it("keeps Ask findings compatible with the shared preview decoder", () => {
    const catalog: AnswerContentCitationCatalog = new Map([
      ["EVID_A", {
        key: "citation-1",
        pageNumbers: [2],
        sourceFile: "first.pdf",
      }],
    ]);

    const snapshot = decodePartialAnswerContentSnapshot({
      answer: {
        content: "The report describes one change.",
        evidenceRefs: ["EVID_A"],
        findings: [{
          content: "Revenue increased.",
          evidenceRefs: ["EVID_A"],
        }],
      },
    }, catalog);

    expect(snapshot?.statements.map((statement) => statement.section)).toEqual([
      "answer",
      "key-points",
    ]);
    expect(snapshot?.statements[1]?.citationKeys).toEqual(["citation-1"]);
  });
});
