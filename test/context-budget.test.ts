import { describe, expect, it } from "vitest";

import {
  AnswerCapacityError,
  planAnswerRequest,
} from "../src/answers/context-budget.js";
import { buildTestModelCapabilities } from "./model-capabilities-fixture.js";
import {
  buildRetrievedElementProvenance,
  buildSourceLocation,
} from "./source-element-fixture.js";
import type { RetrievedElement } from "../src/retrieval/document-retrieval.js";

describe("answer request context budgeting", () => {
  it("reserves output capacity when no evidence was retrieved", () => {
    const budget = planAnswerRequest(
      buildTestModelCapabilities(120),
      {
        maximumOutputTokens: 30,
        minimumOutputTokens: 10,
        providerSafetyMarginTokens: 10,
      },
      [{ text: "system question metadata schema", type: "text" }],
      [],
      [],
    );

    expect(budget.decisions).toEqual([]);
    expect(budget.selected).toEqual([]);
    expect(budget.outputBudgetTokens).toBe(30);
  });

  it("accounts for fixed prompt, complete evidence, output, and safety reserve", () => {
    const retrieved = [
      buildRetrievedElement("a", "b"),
      buildRetrievedElement("c", "d"),
    ];
    const budget = planAnswerRequest(
      buildTestModelCapabilities(120),
      {
        maximumOutputTokens: 30,
        minimumOutputTokens: 10,
        providerSafetyMarginTokens: 10,
      },
      [{ text: "system question metadata schema", type: "text" }],
      [
        buildSourceContent("complete first evidence window"),
        buildSourceContent("complete second evidence window that does not fit"),
      ],
      retrieved,
    );

    expect(budget.contextCapacityTokens).toBe(120);
    expect(budget.outputBudgetTokens).toBe(30);
    expect(budget.providerSafetyMarginTokens).toBe(10);
    expect(budget.selected).toEqual([retrieved[0]]);
    expect(budget.decisions).toEqual([
      expect.objectContaining({ reason: "included", retrievalRank: 1 }),
      expect.objectContaining({ reason: "capacity", retrievalRank: 2 }),
    ]);
  });

  it("changes the available budget with model context capacity", () => {
    const retrieved = [buildRetrievedElement("a", "b")];
    const configuration = {
      maximumOutputTokens: 30,
      minimumOutputTokens: 10,
      providerSafetyMarginTokens: 5,
    };
    const sourceContents = [buildSourceContent("evidence window")];
    const small = planAnswerRequest(
      buildTestModelCapabilities(80),
      configuration,
      [{ text: "prompt", type: "text" }],
      sourceContents,
      retrieved,
    );
    const large = planAnswerRequest(
      buildTestModelCapabilities(160),
      configuration,
      [{ text: "prompt", type: "text" }],
      sourceContents,
      retrieved,
    );

    expect(large.availableInputTokens).toBeGreaterThan(small.availableInputTokens);
  });

  it("reduces output toward the configured minimum to preserve complete windows", () => {
    const retrieved = [
      buildRetrievedElement("a", "b"),
      buildRetrievedElement("c", "d"),
    ];
    const budget = planAnswerRequest(
      buildTestModelCapabilities(70),
      {
        maximumOutputTokens: 30,
        minimumOutputTokens: 10,
        providerSafetyMarginTokens: 5,
      },
      [{ text: "fixed", type: "text" }],
      [
        buildSourceContent("first complete window"),
        buildSourceContent("second complete window"),
      ],
      retrieved,
    );

    expect(budget.selected).toEqual(retrieved);
    expect(budget.outputBudgetTokens).toBe(17);
    expect(budget.outputBudgetTokens).toBeGreaterThanOrEqual(10);
  });

  it("adds optional parent context only when the existing budget can fit it", () => {
    const retrieved = [buildRetrievedElement("a", "b")];
    const sourceContents = [{
      expanded: [{
        text: "short plus additional parent context",
        type: "text" as const,
      }],
      primary: [{ text: "short", type: "text" as const }],
    }];
    const configuration = {
      maximumOutputTokens: 30,
      minimumOutputTokens: 10,
      providerSafetyMarginTokens: 5,
    };
    const constrained = planAnswerRequest(
      buildTestModelCapabilities(30),
      configuration,
      [{ text: "fixed", type: "text" }],
      sourceContents,
      retrieved,
    );
    const roomy = planAnswerRequest(
      buildTestModelCapabilities(100),
      configuration,
      [{ text: "fixed", type: "text" }],
      sourceContents,
      retrieved,
    );

    expect(constrained.expandedRetrievalWindowIds).toEqual([]);
    expect(roomy.expandedRetrievalWindowIds).toEqual([
      retrieved[0]?.provenance.retrievalWindowId,
    ]);
  });

  it("refuses generation when the minimum structured response cannot fit", () => {
    expect(() => planAnswerRequest(
      buildTestModelCapabilities(20),
      {
        maximumOutputTokens: 10,
        minimumOutputTokens: 10,
        providerSafetyMarginTokens: 5,
      },
      [{ text: "fixed prompt is already too large", type: "text" }],
      [buildSourceContent("evidence")],
      [buildRetrievedElement("a", "b")],
    )).toThrow(AnswerCapacityError);
  });
});

function buildSourceContent(text: string) {
  return {
    expanded: null,
    primary: [{ text, type: "text" as const }],
  };
}

function buildRetrievedElement(
  documentCharacter: string,
  elementCharacter: string,
): RetrievedElement {
  const elementId = elementCharacter.repeat(64);
  return {
    distance: 0.1,
    documentVersionId: "00000000-0000-4000-8000-000000000001",
    element: {
      content: "Complete evidence window.",
      documentId: documentCharacter.repeat(64),
      id: elementId,
      detectedTypes: ["paragraph"],
      kind: "text",
      ...buildSourceLocation(1),
      sourceFile: "/tmp/report.pdf",
    },
    evidenceContent: "Complete evidence window.",
    provenance: buildRetrievedElementProvenance(elementId),
  };
}
