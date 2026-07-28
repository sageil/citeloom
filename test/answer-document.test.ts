import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAnswerModelResponseSchema,
  decodeAnswerDraft,
  decodeAnswerModelResponse,
} from "../src/answers/draft.js";
import type { RetrievedElement } from "../src/retrieval/document-retrieval.js";
import {
  compileAnswerDraft,
  readPublishedAnswerClaims,
  renderPublishedAnswerMarkdown,
  renderPublishedAnswerSpeech,
} from "../src/answers/published.js";
import {
  buildRetrievedElementProvenance,
  buildSourceLocation,
} from "./source-element-fixture.js";

describe("answer draft boundary", () => {
  it("uses an OpenAI-compatible object at the structured-output root", () => {
    const schema = z.toJSONSchema(createAnswerModelResponseSchema(2));

    expect(schema).toMatchObject({
      additionalProperties: false,
      required: ["conflictGroups", "statements", "status"],
      type: "object",
    });
    expect(schema).not.toHaveProperty("oneOf");
    expect(schema).not.toHaveProperty("anyOf");
  });

  it("decodes valid answered and no-answer drafts", () => {
    expect(decodeAnswerDraft({ status: "no_answer" }, 2)).toEqual({
      status: "no_answer",
    });
    expect(decodeAnswerDraft(buildAnsweredDraft([2, 1]), 2)).toEqual(
      buildAnsweredDraft([2, 1]),
    );
  });

  it("normalizes a no-answer model response into the domain draft", () => {
    expect(decodeAnswerModelResponse({
      conflictGroups: [],
      statements: [],
      status: "no_answer",
    }, 2)).toEqual({
      status: "no_answer",
    });
  });

  it("removes model citation decorations independently of placement", () => {
    const value = {
      conflictGroups: [{
        explanation: "The claims cannot both describe the same result (Sources 1, 2).",
        positions: [
          { claim: "Revenue increased [1].", sourceNumbers: [1] },
          { claim: "Revenue [2] decreased.", sourceNumbers: [2] },
        ],
        sharedScope: {
          conditions: "the same accounting basis【1】",
          context: "the reporting entity",
          scope: "the annual report",
          timePeriod: "the same reporting period",
        },
      }],
      statements: [{
        content: "Revenue was reported by both sources. [1, 2]",
        presentation: "paragraph",
        section: "answer",
        sourceNumbers: [1, 2],
      }],
      status: "answered",
    };

    expect(decodeAnswerModelResponse(value, 2)).toEqual({
      ...value,
      conflictGroups: [{
        ...value.conflictGroups[0],
        explanation: "The claims cannot both describe the same result.",
        positions: [
          { claim: "Revenue increased.", sourceNumbers: [1] },
          { claim: "Revenue decreased.", sourceNumbers: [2] },
        ],
        sharedScope: {
          conditions: "the same accounting basis",
          context: "the reporting entity",
          scope: "the annual report",
          timePeriod: "the same reporting period",
        },
      }],
      statements: [{
        ...value.statements[0],
        content: "Revenue was reported by both sources.",
      }],
    });
  });

  it.each([
    ["Revenue increased. [2]", "Revenue increased."],
    ["Revenue increased [1].", "Revenue increased."],
    ["Revenue [1] increased.", "Revenue increased."],
    ["Revenue increased【1】.", "Revenue increased."],
    ["Revenue increased [1-2].", "Revenue increased."],
    ["Revenue increased (Source 1).", "Revenue increased."],
    ["Revenue increased, source #1.", "Revenue increased."],
  ])("normalizes model citation decoration in %s", (content, expected) => {
    const draft = decodeAnswerModelResponse(buildDraftWithContent(content), 2);
    if (draft.status !== "answered") {
      throw new Error("Expected an answered draft.");
    }
    expect(draft.statements[0]?.content).toBe(expected);
  });

  it("preserves unrecognized model annotations as plain content", () => {
    const draft = decodeAnswerModelResponse(
      buildDraftWithContent("Revenue increased (see ref. A)."),
      2,
    );
    if (draft.status !== "answered") {
      throw new Error("Expected an answered draft.");
    }
    expect(draft.statements[0]?.content).toBe("Revenue increased (see ref. A).");
  });

  it.each([
    {
      label: "an empty answered draft",
      value: { conflictGroups: [], statements: [], status: "answered" },
    },
    { label: "empty statement content", value: buildDraftWithContent("") },
    { label: "an unknown top-level property", value: { extra: true, status: "no_answer" } },
    {
      label: "an unknown statement property",
      value: {
        conflictGroups: [],
        statements: [{
          content: "Revenue increased.",
          extra: true,
          presentation: "paragraph",
          section: "answer",
          sourceNumbers: [1],
        }],
        status: "answered",
      },
    },
    {
      label: "the removed limitations section",
      value: {
        conflictGroups: [],
        statements: [{
          content: "The estimate remains limited.",
          presentation: "paragraph",
          section: "limitations",
          sourceNumbers: [1],
        }],
        status: "answered",
      },
    },
    {
      label: "model-authored Markdown",
      value: buildDraftWithContent("**Revenue increased.**"),
    },
    {
      label: "model-authored HTML",
      value: buildDraftWithContent("<strong>Revenue increased.</strong>"),
    },
  ])("rejects $label", ({ value }) => {
    expect(() => decodeAnswerDraft(value, 2)).toThrow("Invalid answer draft");
  });

  it("rejects independent conflicting-evidence statement classification", () => {
    expect(() => decodeAnswerDraft({
      conflictGroups: [],
      statements: [{
        content: "The sources disagree.",
        presentation: "paragraph",
        section: "conflicting-evidence",
        sourceNumbers: [1],
      }],
      status: "answered",
    }, 1)).toThrow("Invalid answer draft");
  });

  it.each([
    {
      label: "one position",
      value: buildConflictDraft([{ claim: "Revenue increased.", sourceNumbers: [1] }]),
    },
    {
      label: "a missing shared scope field",
      value: {
        ...buildConflictDraft([
          { claim: "Revenue increased.", sourceNumbers: [1] },
          { claim: "Revenue decreased.", sourceNumbers: [2] },
        ]),
        conflictGroups: [{
          explanation: "The claims cannot both describe the same result.",
          positions: [
            { claim: "Revenue increased.", sourceNumbers: [1] },
            { claim: "Revenue decreased.", sourceNumbers: [2] },
          ],
          scope: {
            conditions: "the same accounting basis",
            jurisdiction: "the reporting entity",
            proceeding: "the annual report",
          },
        }],
      },
    },
    {
      label: "duplicate positions",
      value: buildConflictDraft([
        { claim: "Revenue increased.", sourceNumbers: [1] },
        { claim: "REVENUE INCREASED.", sourceNumbers: [2] },
      ]),
    },
    {
      label: "an unsupported position",
      value: buildConflictDraft([
        { claim: "Revenue increased.", sourceNumbers: [1] },
        { claim: "Revenue decreased.", sourceNumbers: [] },
      ]),
    },
  ])("rejects an incomplete conflict group with $label", ({ value }) => {
    expect(() => decodeAnswerDraft(value, 2)).toThrow("Invalid answer draft");
  });

  it("accepts complete long, numerous, and broadly sourced statements", () => {
    const sourceNumbers = Array.from({ length: 12 }, (_value, index) => index + 1);
    const statements = [];
    for (let index = 0; index < 65; index += 1) {
      statements.push({
        content: `${"a".repeat(1_000)} ${index}`,
        presentation: "paragraph",
        section: "answer",
        sourceNumbers,
      });
    }
    const draft = decodeAnswerDraft({ conflictGroups: [], statements, status: "answered" }, 12);
    expect(draft).toMatchObject({ status: "answered" });
    if (draft.status !== "answered") {
      throw new Error("Expected an answered draft.");
    }
    expect(draft.statements).toHaveLength(65);
    expect(draft.statements[0]?.sourceNumbers).toEqual(sourceNumbers);

    const retrieved: RetrievedElement[] = [];
    for (let index = 0; index < 12; index += 1) {
      const fixture = buildRetrievedElement("a", "b", index + 1);
      const documentId = (index + 1).toString(16).padStart(64, "0");
      const elementId = (index + 13).toString(16).padStart(64, "0");
      retrieved.push({
        ...fixture,
        element: {
          ...fixture.element,
          documentId,
          id: elementId,
          sourceFile: `/tmp/report-${index}.pdf`,
        },
      });
    }
    const document = compileAnswerDraft(draft, retrieved);
    expect(document.status).toBe("answered");
    expect(document.statements).toHaveLength(65);
    expect(document.citations).toHaveLength(12);
  });

  it.each([
    { label: "zero", sourceNumbers: [0] },
    { label: "negative", sourceNumbers: [-1] },
    { label: "out-of-range", sourceNumbers: [3] },
  ])("rejects $label source references", ({ sourceNumbers }) => {
    expect(() => decodeAnswerDraft(buildAnsweredDraft(sourceNumbers), 2))
      .toThrow("Invalid answer draft");
  });

  it("normalizes duplicate model source numbers", () => {
    const draft = decodeAnswerModelResponse(buildAnsweredDraft([2, 1, 2, 1]), 2);
    if (draft.status !== "answered") {
      throw new Error("Expected an answered draft.");
    }
    expect(draft.statements[0]?.sourceNumbers).toEqual([2, 1]);
  });

  it("omits statements emptied by model-text normalization", () => {
    const value = {
      conflictGroups: [],
      statements: [
        {
          content: "",
          presentation: "paragraph",
          section: "answer",
          sourceNumbers: [1],
        },
        {
          content: "  \n  ",
          presentation: "paragraph",
          section: "answer",
          sourceNumbers: [1],
        },
        {
          content: "**Model formatting**",
          presentation: "paragraph",
          section: "answer",
          sourceNumbers: [1],
        },
        {
          content: "[1]",
          presentation: "paragraph",
          section: "answer",
          sourceNumbers: [1],
        },
        {
          content: "Revenue increased [1].",
          presentation: "paragraph",
          section: "answer",
          sourceNumbers: [1],
        },
      ],
      status: "answered",
    };
    const draft = decodeAnswerModelResponse(value, 1);
    if (draft.status !== "answered") {
      throw new Error("Expected an answered draft.");
    }
    expect(draft.statements).toEqual([{
      content: "Revenue increased.",
      presentation: "paragraph",
      section: "answer",
      sourceNumbers: [1],
    }]);
  });

  it("omits a conflict group invalidated by model-text normalization", () => {
    const value = {
      conflictGroups: [{
        explanation: "The claims cannot both be true.",
        positions: [
          { claim: "Revenue increased [1].", sourceNumbers: [1] },
          { claim: "Revenue increased [2].", sourceNumbers: [2] },
        ],
        sharedScope: {
          conditions: "the same basis",
          context: "the same entity",
          scope: "the same report",
          timePeriod: "the same period",
        },
      }],
      statements: [{
        content: "Revenue was reported [1].",
        presentation: "paragraph",
        section: "answer",
        sourceNumbers: [1],
      }],
      status: "answered",
    };
    const draft = decodeAnswerModelResponse(value, 2);
    if (draft.status !== "answered") {
      throw new Error("Expected an answered draft.");
    }
    expect(draft.conflictGroups).toEqual([]);
    expect(draft.statements).toHaveLength(1);
  });
});

describe("published answer compilation", () => {
  it("resolves request-local numbers against the exact ordered retrieval", () => {
    const retrieved = [
      buildRetrievedElement("a", "b", 3),
      buildRetrievedElement("c", "d", 7),
    ];
    const document = compileAnswerDraft(
      decodeAnswerDraft(buildAnsweredDraft([2, 1]), retrieved.length),
      retrieved,
    );
    if (document.status !== "answered") {
      throw new Error("Expected an answered document.");
    }

    expect(document.citations.map((citation) => citation.citationNumber)).toEqual([1, 2]);
    expect(document.citations.map((citation) => citation.elementId)).toEqual([
      "b".repeat(64),
      "d".repeat(64),
    ]);
    expect(document.statements[0]?.citationIds).toEqual([
      document.citations[1]?.id,
      document.citations[0]?.id,
    ]);
    expect(readPublishedAnswerClaims(document)).toEqual([{
      citationNumbers: [2, 1],
      claim: "Revenue increased.",
      claimIndex: 0,
    }]);
  });

  it("produces deterministic escaped Markdown and plain speech projections", () => {
    const draft = decodeAnswerDraft({
      conflictGroups: [],
      statements: [{
        content: "Part II says revenue increased by 10% (estimated) [estimate].",
        presentation: "paragraph",
        section: "answer",
        sourceNumbers: [1],
      }, {
        content: "The estimate remains limited.",
        presentation: "paragraph",
        section: "answer",
        sourceNumbers: [1],
      }],
      status: "answered",
    }, 1);
    const document = compileAnswerDraft(
      draft,
      [buildRetrievedElement("a", "b", 3)],
    );

    expect(renderPublishedAnswerMarkdown(document)).toBe([
      "Part II says revenue increased by 10% \\(estimated\\) \\[estimate\\]\\. [1]",
      "",
      "The estimate remains limited\\. [1]",
    ].join("\n"));
    expect(renderPublishedAnswerSpeech(document)).toBe([
      "Part 2 says revenue increased by 10% (estimated) [estimate]. See cited resource 1.",
      "The estimate remains limited. See cited resource 1.",
    ].join("\n"));
  });

  it("compiles validated conflict groups into canonical document order", () => {
    const draft = decodeAnswerDraft({
      conflictGroups: [{
        explanation: "The revenue cannot both have increased and decreased in the same period.",
        positions: [{
          claim: "Revenue increased.",
          sourceNumbers: [1],
        }, {
          claim: "Revenue decreased.",
          sourceNumbers: [2],
        }],
        sharedScope: {
          conditions: "reported revenue under the same accounting basis",
          context: "the reporting entity",
          scope: "the annual financial report",
          timePeriod: "the 2025 fiscal year",
        },
      }],
      statements: [{
        content: "Revenue was reported for 2025.",
        presentation: "paragraph",
        section: "answer",
        sourceNumbers: [1],
      }],
      status: "answered",
    }, 2);
    const document = compileAnswerDraft(
      draft,
      [
        buildRetrievedElement("a", "b", 3),
        buildRetrievedElement("c", "d", 4),
      ],
    );

    expect(document.statements.map((statement) => statement.section)).toEqual([
      "answer",
      "conflicting-evidence",
      "conflicting-evidence",
      "conflicting-evidence",
      "conflicting-evidence",
    ]);
    expect(document.statements[2]?.content).toBe("Revenue increased.");
    expect(document.statements[3]?.content).toBe("Revenue decreased.");
    expect(document.statements[2]?.citationIds).toEqual([
      document.citations[0]?.id,
    ]);
    expect(document.statements[3]?.citationIds).toEqual([
      document.citations[1]?.id,
    ]);
  });

  it("omits an exact duplicate conflict group without dropping either position", () => {
    const conflictDraft = buildConflictDraft([
      { claim: "Revenue increased.", sourceNumbers: [1] },
      { claim: "Revenue decreased.", sourceNumbers: [2] },
    ]);
    const firstGroup = conflictDraft.conflictGroups[0];
    if (firstGroup === undefined) {
      throw new Error("Expected a conflict group fixture.");
    }
    conflictDraft.conflictGroups.push({
      ...firstGroup,
      explanation: "Both revenue directions cannot describe the same result.",
    });
    const draft = decodeAnswerDraft(conflictDraft, 2);

    const document = compileAnswerDraft(draft, [
      buildRetrievedElement("a", "b", 3),
      buildRetrievedElement("c", "d", 4),
    ]);

    expect(document.statements).toHaveLength(4);
    expect(document.statements[1]?.content).toBe("Revenue increased.");
    expect(document.statements[2]?.content).toBe("Revenue decreased.");
  });
});

function buildAnsweredDraft(sourceNumbers: number[]) {
  return {
    conflictGroups: [],
    statements: [{
      content: "Revenue increased.",
      presentation: "paragraph",
      section: "answer",
      sourceNumbers,
    }],
    status: "answered",
  };
}

function buildDraftWithContent(content: string) {
  return {
    conflictGroups: [],
    statements: [{
      content,
      presentation: "paragraph",
      section: "answer",
      sourceNumbers: [1],
    }],
    status: "answered",
  };
}

function buildConflictDraft(
  positions: Array<{ claim: string; sourceNumbers: number[] }>,
) {
  return {
    conflictGroups: [{
      explanation: "The claims cannot both describe the same result.",
      positions,
      sharedScope: {
        conditions: "the same accounting basis",
        context: "the reporting entity",
        scope: "the annual report",
        timePeriod: "the 2025 fiscal year",
      },
    }],
    statements: [],
    status: "answered",
  };
}

function buildRetrievedElement(
  documentCharacter: string,
  elementCharacter: string,
  page: number,
): RetrievedElement {
  const elementId = elementCharacter.repeat(64);
  return {
    distance: 0.1,
    documentVersionId: "00000000-0000-4000-8000-000000000001",
    element: {
      content: "Revenue increased.",
      documentId: documentCharacter.repeat(64),
      id: elementId,
      detectedTypes: ["paragraph"],
      kind: "text",
      ...buildSourceLocation(page),
      sourceFile: `/tmp/report-${documentCharacter}.pdf`,
    },
    evidenceContent: "Revenue growth",
    provenance: buildRetrievedElementProvenance(elementId),
  };
}
