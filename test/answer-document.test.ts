import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createAnswerModelResponseSchema,
  createEvidenceReferences,
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
    const schema = z.toJSONSchema(
      createAnswerModelResponseSchema(createEvidenceReferences(2)),
    );

    expect(schema).toMatchObject({
      additionalProperties: false,
      required: ["answer", "findings"],
      type: "object",
    });
    expect(schema).not.toHaveProperty("oneOf");
    expect(schema).not.toHaveProperty("anyOf");
    const schemaText = JSON.stringify(schema);
    expect(schemaText).toContain("EVID_A");
    expect(schemaText).toContain("EVID_B");
    expect(schemaText).not.toContain("presentation");
    expect(schemaText).not.toContain('"section"');
  });

  it("decodes valid cited and uncited drafts", () => {
    const allowedEvidenceRefs = createEvidenceReferences(2);
    expect(decodeAnswerDraft({
      content: "The source material does not establish the requested information.",
      status: "uncited",
    }, allowedEvidenceRefs)).toEqual({
      content: "The source material does not establish the requested information.",
      status: "uncited",
    });
    expect(decodeAnswerDraft(
      buildAnsweredDraft(["EVID_B", "EVID_A"]),
      allowedEvidenceRefs,
    )).toEqual(
      buildAnsweredDraft(["EVID_B", "EVID_A"]),
    );
  });

  it("fills missing presentation metadata at the model boundary", () => {
    const draft = decodeAnswerModelResponse({
      answer: {
        content: "Revenue increased.",
        evidenceRefs: ["EVID_A"],
      },
      findings: [],
    }, createEvidenceReferences(1));

    expect(draft).toEqual({
      conflictGroups: [],
      statements: [{
        content: "Revenue increased.",
        evidenceRefs: ["EVID_A"],
        presentation: "paragraph",
        section: "answer",
      }],
      status: "answered",
    });
  });

  it("owns direct-answer presentation metadata", () => {
    const draft = decodeAnswerModelResponse({
      answer: {
        content: "A supported cause is configuration failure.",
        evidenceRefs: ["EVID_A"],
      },
      findings: [],
    }, createEvidenceReferences(1));

    expect(draft).toMatchObject({
      statements: [{
        presentation: "paragraph",
        section: "answer",
      }],
      status: "answered",
    });
  });

  it.each([
    ["two", ["regional", "global"]],
    ["three", ["regional", "global", "local"]],
    ["four", ["regional", "global", "local", "isolated"]],
  ])(
    "uses one direct answer and supporting findings for %s supported items",
    (_label, deploymentModes) => {
      const evidenceRefs = createEvidenceReferences(deploymentModes.length);
      const statements = deploymentModes.map((mode, index) => ({
        content: `The service supports a ${mode} deployment.`,
        evidenceRefs: [evidenceRefs[index]],
      }));
      const answer = statements[0];
      if (answer === undefined) {
        throw new Error("Expected an answer fixture.");
      }
      const draft = decodeAnswerModelResponse({
        answer,
        findings: statements.slice(1),
      }, evidenceRefs);

      expect(draft).toMatchObject({
        statements: [
          { presentation: "paragraph", section: "answer" },
          ...deploymentModes.slice(1).map(() => ({
            presentation: "bullet",
            section: "key-points",
          })),
        ],
        status: "answered",
      });
    },
  );

  it("keeps a multi-statement answer in prose", () => {
    const draft = decodeAnswerModelResponse({
      answer: {
        content: "The first mechanism blocks the receptor.",
        evidenceRefs: ["EVID_A"],
      },
      findings: [{
          content: "The second mechanism blocks the proton pump.",
          evidenceRefs: ["EVID_B"],
      }],
    }, createEvidenceReferences(2));

    expect(draft).toMatchObject({
      statements: [
        { presentation: "paragraph", section: "answer" },
        { presentation: "bullet", section: "key-points" },
      ],
      status: "answered",
    });
  });

  it("normalizes an uncited model response into the domain draft", () => {
    expect(decodeAnswerModelResponse({
      answer: {
        content: "The supplied source material does not identify the requested information.",
        evidenceRefs: [],
      },
      findings: [],
    }, createEvidenceReferences(2))).toEqual({
      content: "The supplied source material does not identify the requested information.",
      status: "uncited",
    });
  });

  it("removes model citation decorations independently of placement", () => {
    const value = {
      answer: {
        content: "Revenue was reported by both sources. [1, 2]",
        evidenceRefs: ["EVID_A", "EVID_B"],
      },
      findings: [
        { content: "Revenue increased [EVID_A].", evidenceRefs: ["EVID_A"] },
        { content: "Revenue [EVID_B] decreased.", evidenceRefs: ["EVID_B"] },
      ],
    };

    expect(decodeAnswerModelResponse(value, createEvidenceReferences(2))).toEqual({
      statements: [{
        content: "Revenue was reported by both sources.",
        evidenceRefs: ["EVID_A", "EVID_B"],
        presentation: "paragraph",
        section: "answer",
      }, {
        content: "Revenue increased.",
        evidenceRefs: ["EVID_A"],
        presentation: "bullet",
        section: "key-points",
      }, {
        content: "Revenue decreased.",
        evidenceRefs: ["EVID_B"],
        presentation: "bullet",
        section: "key-points",
      }],
      conflictGroups: [],
      status: "answered",
    });
  });

  it.each([
    ["Revenue increased. [EVID_B]", "Revenue increased."],
    ["Revenue increased [EVID_A].", "Revenue increased."],
    ["Revenue [EVID_A] increased.", "Revenue increased."],
    ["Revenue increased. [2]", "Revenue increased."],
    ["Revenue increased [1].", "Revenue increased."],
    ["Revenue [1] increased.", "Revenue increased."],
    ["Revenue increased【1】.", "Revenue increased."],
    ["Revenue increased [1-2].", "Revenue increased."],
    ["Revenue increased (Source 1).", "Revenue increased."],
    ["Revenue increased, source #1.", "Revenue increased."],
  ])("normalizes model citation decoration in %s", (content, expected) => {
    const draft = decodeAnswerModelResponse(
      buildAnswerModelResponse(content),
      createEvidenceReferences(2),
    );
    if (draft.status !== "answered") {
      throw new Error("Expected an answered draft.");
    }
    expect(draft.statements[0]?.content).toBe(expected);
  });

  it("preserves unrecognized model annotations as plain content", () => {
    const draft = decodeAnswerModelResponse(
      buildAnswerModelResponse("Revenue increased (see ref. A)."),
      createEvidenceReferences(2),
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
    {
      label: "an unknown top-level property",
      value: { content: "Unsupported.", extra: true, status: "uncited" },
    },
    {
      label: "an unknown statement property",
      value: {
        conflictGroups: [],
        statements: [{
          content: "Revenue increased.",
          extra: true,
          evidenceRefs: ["EVID_A"],
          presentation: "paragraph",
          section: "answer",
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
          evidenceRefs: ["EVID_A"],
          presentation: "paragraph",
          section: "limitations",
        }],
        status: "answered",
      },
    },
  ])("rejects $label", ({ value }) => {
    expect(() => decodeAnswerDraft(value, createEvidenceReferences(2)))
      .toThrow("Invalid answer draft");
  });

  it.each([
    {
      content: "**Revenue increased.**",
      label: "model-authored Markdown",
    },
    {
      content: "<strong>Revenue increased.</strong>",
      label: "model-authored HTML",
    },
  ])("preserves $label as answer content", ({ content }) => {
    const draft = decodeAnswerDraft(
      buildDraftWithContent(content),
      createEvidenceReferences(2),
    );
    if (draft.status !== "answered") {
      throw new Error("Expected an answered draft.");
    }
    expect(draft.statements[0]?.content).toBe(content);
  });

  it("rejects independent conflicting-evidence statement classification", () => {
    expect(() => decodeAnswerDraft({
      conflictGroups: [],
      statements: [{
        content: "The sources disagree.",
        evidenceRefs: ["EVID_A"],
        presentation: "paragraph",
        section: "conflicting-evidence",
      }],
      status: "answered",
    }, createEvidenceReferences(1))).toThrow("Invalid answer draft");
  });

  it.each([
    {
      label: "one position",
      value: buildConflictDraft([{
        claim: "Revenue increased.",
        evidenceRefs: ["EVID_A"],
      }]),
    },
    {
      label: "a missing shared scope field",
      value: {
        ...buildConflictDraft([
          { claim: "Revenue increased.", evidenceRefs: ["EVID_A"] },
          { claim: "Revenue decreased.", evidenceRefs: ["EVID_B"] },
        ]),
        conflictGroups: [{
          explanation: "The claims cannot both describe the same result.",
          positions: [
            { claim: "Revenue increased.", evidenceRefs: ["EVID_A"] },
            { claim: "Revenue decreased.", evidenceRefs: ["EVID_B"] },
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
        { claim: "Revenue increased.", evidenceRefs: ["EVID_A"] },
        { claim: "REVENUE INCREASED.", evidenceRefs: ["EVID_B"] },
      ]),
    },
    {
      label: "an unsupported position",
      value: buildConflictDraft([
        { claim: "Revenue increased.", evidenceRefs: ["EVID_A"] },
        { claim: "Revenue decreased.", evidenceRefs: [] },
      ]),
    },
  ])("rejects an incomplete conflict group with $label", ({ value }) => {
    expect(() => decodeAnswerDraft(value, createEvidenceReferences(2)))
      .toThrow("Invalid answer draft");
  });

  it("accepts complete long, numerous, and broadly sourced statements", () => {
    const evidenceRefs = createEvidenceReferences(12);
    const statements = [];
    for (let index = 0; index < 65; index += 1) {
      statements.push({
        content: `${"a".repeat(1_000)} ${index}`,
        evidenceRefs,
        presentation: "paragraph",
        section: "answer",
      });
    }
    const draft = decodeAnswerDraft(
      { conflictGroups: [], statements, status: "answered" },
      evidenceRefs,
    );
    expect(draft).toMatchObject({ status: "answered" });
    if (draft.status !== "answered") {
      throw new Error("Expected an answered draft.");
    }
    expect(draft.statements).toHaveLength(65);
    expect(draft.statements[0]?.evidenceRefs).toEqual(evidenceRefs);

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
    expect(document).not.toHaveProperty("status");
    expect(document.statements).toHaveLength(65);
    expect(document.citations).toHaveLength(12);
  });

  it.each([
    { evidenceRefs: ["EVID_C"], label: "unknown" },
    { evidenceRefs: ["evid_a"], label: "wrong-case" },
    { evidenceRefs: ["EVID_A "], label: "modified" },
  ])("rejects $label evidence references", ({ evidenceRefs }) => {
    expect(() => decodeAnswerDraft(
      buildAnsweredDraft(evidenceRefs),
      createEvidenceReferences(2),
    ))
      .toThrow("Invalid answer draft");
  });

  it("normalizes duplicate model evidence references", () => {
    const draft = decodeAnswerModelResponse(
      buildAnswerModelResponse(
        "Revenue increased.",
        ["EVID_B", "EVID_A", "EVID_B", "EVID_A"],
      ),
      createEvidenceReferences(2),
    );
    if (draft.status !== "answered") {
      throw new Error("Expected an answered draft.");
    }
    expect(draft.statements[0]?.evidenceRefs).toEqual(["EVID_B", "EVID_A"]);
  });

  it("omits only statements emptied by model-text normalization", () => {
    const value = {
      answer: {
        content: "Revenue increased [1].",
        evidenceRefs: ["EVID_A"],
      },
      findings: [
        {
          content: "",
          evidenceRefs: ["EVID_A"],
        },
        {
          content: "  \n  ",
          evidenceRefs: ["EVID_A"],
        },
        {
          content: "**Model formatting**",
          evidenceRefs: ["EVID_A"],
        },
        {
          content: "[1]",
          evidenceRefs: ["EVID_A"],
        },
      ],
    };
    const draft = decodeAnswerModelResponse(value, createEvidenceReferences(1));
    if (draft.status !== "answered") {
      throw new Error("Expected an answered draft.");
    }
    expect(draft.statements).toEqual([
      {
        content: "Revenue increased.",
        evidenceRefs: ["EVID_A"],
        presentation: "paragraph",
        section: "answer",
      },
      {
        content: "**Model formatting**",
        evidenceRefs: ["EVID_A"],
        presentation: "bullet",
        section: "key-points",
      },
    ]);
  });

  it("rejects removed model-authored conflict groups", () => {
    const value = {
      conflictGroups: [{
        explanation: "The claims cannot both be true.",
        positions: [
          { claim: "Revenue increased [1].", evidenceRefs: ["EVID_A"] },
          { claim: "Revenue increased [2].", evidenceRefs: ["EVID_B"] },
        ],
        sharedScope: {
          conditions: "the same basis",
          context: "the same entity",
          scope: "the same report",
          timePeriod: "the same period",
        },
      }],
      answer: {
        content: "Revenue was reported.",
        evidenceRefs: ["EVID_A"],
      },
      findings: [],
    };
    expect(() => decodeAnswerModelResponse(value, createEvidenceReferences(2)))
      .toThrow("contains fields that are not allowed");
  });
});

describe("published answer compilation", () => {
  it("resolves evidence references against the exact ordered retrieval", () => {
    const retrieved = [
      buildRetrievedElement("a", "b", 3),
      buildRetrievedElement("c", "d", 7),
    ];
    const document = compileAnswerDraft(
      decodeAnswerDraft(
        buildAnsweredDraft(["EVID_B", "EVID_A"]),
        createEvidenceReferences(retrieved.length),
      ),
      retrieved,
    );
    if (document.citations.length === 0) {
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
        evidenceRefs: ["EVID_A"],
        presentation: "paragraph",
        section: "answer",
      }, {
        content: "The estimate remains limited.",
        evidenceRefs: ["EVID_A"],
        presentation: "paragraph",
        section: "answer",
      }],
      status: "answered",
    }, createEvidenceReferences(1));
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

  it("continues to render historical key-points presentation", () => {
    const draft = decodeAnswerDraft({
      conflictGroups: [],
      statements: [{
        content: "Revenue increased.",
        evidenceRefs: ["EVID_A"],
        presentation: "bullet",
        section: "key-points",
      }],
      status: "answered",
    }, createEvidenceReferences(1));
    const document = compileAnswerDraft(
      draft,
      [buildRetrievedElement("a", "b", 3)],
    );

    expect(renderPublishedAnswerMarkdown(document)).toBe([
      "## Key points",
      "",
      "- Revenue increased\\. [1]",
    ].join("\n"));
  });

  it("compiles validated conflict groups into canonical document order", () => {
    const draft = decodeAnswerDraft({
      conflictGroups: [{
        explanation: "The revenue cannot both have increased and decreased in the same period.",
        positions: [{
          claim: "Revenue increased.",
          evidenceRefs: ["EVID_A"],
        }, {
          claim: "Revenue decreased.",
          evidenceRefs: ["EVID_B"],
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
        evidenceRefs: ["EVID_A"],
        presentation: "paragraph",
        section: "answer",
      }],
      status: "answered",
    }, createEvidenceReferences(2));
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
      { claim: "Revenue increased.", evidenceRefs: ["EVID_A"] },
      { claim: "Revenue decreased.", evidenceRefs: ["EVID_B"] },
    ]);
    const firstGroup = conflictDraft.conflictGroups[0];
    if (firstGroup === undefined) {
      throw new Error("Expected a conflict group fixture.");
    }
    conflictDraft.conflictGroups.push({
      ...firstGroup,
      explanation: "Both revenue directions cannot describe the same result.",
    });
    const draft = decodeAnswerDraft(
      conflictDraft,
      createEvidenceReferences(2),
    );

    const document = compileAnswerDraft(draft, [
      buildRetrievedElement("a", "b", 3),
      buildRetrievedElement("c", "d", 4),
    ]);

    expect(document.statements).toHaveLength(4);
    expect(document.statements[1]?.content).toBe("Revenue increased.");
    expect(document.statements[2]?.content).toBe("Revenue decreased.");
  });
});

function buildAnsweredDraft(evidenceRefs: string[]) {
  return {
    conflictGroups: [],
    statements: [{
      content: "Revenue increased.",
      evidenceRefs,
      presentation: "paragraph",
      section: "answer",
    }],
    status: "answered",
  };
}

function buildDraftWithContent(content: string) {
  return {
    conflictGroups: [],
    statements: [{
      content,
      evidenceRefs: ["EVID_A"],
      presentation: "paragraph",
      section: "answer",
    }],
    status: "answered",
  };
}

function buildAnswerModelResponse(
  content: string,
  evidenceRefs: string[] = ["EVID_A"],
) {
  return {
    answer: { content, evidenceRefs },
    findings: [],
  };
}

function buildConflictDraft(
  positions: Array<{ claim: string; evidenceRefs: string[] }>,
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
