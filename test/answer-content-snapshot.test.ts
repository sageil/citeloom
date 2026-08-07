import { describe, expect, it } from "vitest";

import {
  decodePartialAnswerContentSnapshot,
  type AnswerContentCitationCatalog,
} from "../src/answers/content-snapshot.js";

describe("answer content snapshots", () => {
  it("streams Chat topics with stable, deduplicated citation previews", () => {
    const catalog: AnswerContentCitationCatalog = new Map([
      ["SOURCE_1", {
        citationNumber: null,
        key: "citation-1",
        pageNumbers: [2],
        sourceFile: "first.pdf",
      }],
      ["SOURCE_2", {
        citationNumber: null,
        key: "citation-2",
        pageNumbers: [5],
        sourceFile: "second.pdf",
      }],
    ]);

    const snapshot = decodePartialAnswerContentSnapshot({
      answer: {
        content: "The sources describe two changes.",
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
        citationNumber: 1,
        key: "citation-1",
        pageNumbers: [2],
        sourceFile: "first.pdf",
      }, {
        citationNumber: 2,
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
        content: "Revenue: Revenue increased.",
        presentation: "bullet",
        section: "answer",
      }, {
        citationKeys: ["citation-2"],
        content: "Costs: Costs decreased.",
        presentation: "bullet",
        section: "answer",
      }],
    });
  });

  it("keeps Ask findings compatible with the shared preview decoder", () => {
    const catalog: AnswerContentCitationCatalog = new Map([
      ["EVID_A", {
        citationNumber: null,
        key: "citation-1",
        pageNumbers: [2],
        sourceFile: "first.pdf",
      }],
    ]);

    const snapshot = decodePartialAnswerContentSnapshot({
      answer: {
        content: "The report describes one change.",
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
    expect(snapshot?.statements[0]?.citationKeys).toEqual([]);
    expect(snapshot?.citations[0]?.citationNumber).toBe(1);
  });

  it("numbers partial citations by retrieved evidence order", () => {
    const catalog: AnswerContentCitationCatalog = new Map([
      ["EVID_A", {
        citationNumber: null,
        key: "citation-a",
        pageNumbers: [2],
        sourceFile: "first.pdf",
      }],
      ["EVID_B", {
        citationNumber: null,
        key: "citation-b",
        pageNumbers: [5],
        sourceFile: "second.pdf",
      }],
    ]);

    const snapshot = decodePartialAnswerContentSnapshot({
      answer: {
        content: "The report describes two changes.",
        findings: [{
          content: "The second source supports this finding.",
          evidenceRefs: ["EVID_B"],
        }, {
          content: "The first source supports this finding.",
          evidenceRefs: ["EVID_A"],
        }],
      },
    }, catalog);

    expect(snapshot?.citations).toEqual([
      expect.objectContaining({ citationNumber: 1, key: "citation-a" }),
      expect.objectContaining({ citationNumber: 2, key: "citation-b" }),
    ]);
  });
});
