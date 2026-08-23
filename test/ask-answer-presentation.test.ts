import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { publishedAnswerDocumentSchema } from "../src/answers/published-model.js";
import {
  formatDocumentLocationLabel,
  readAskEvidencePanelPlacement,
} from "../web/assets/scripts/ask.js";
import { readAnswerPresentation } from "../web/assets/scripts/ask-boundary.js";
import {
  buildSourceLocation,
  buildTableStructure,
} from "./source-element-fixture.js";
import {
  findHtmlElementByAttribute,
  findHtmlElementByTagName,
  htmlElementHasClass,
  readHtmlAttribute,
  readHtmlElements,
} from "./html-test-helpers.js";

describe("ask answer presentation", () => {
  it("declares finding citations without aggregate answer citations", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/ask.html", import.meta.url),
      "utf8",
    );
    const elements = readHtmlElements(fragment);
    const answerSectionFilter = findHtmlElementByAttribute(
      elements,
      "x-if",
      "section.key !== 'answer'",
    );
    const bulletBlock = findHtmlElementByAttribute(
      elements,
      "x-if",
      "block.kind === 'bullets'",
    );
    const citationTemplate = findHtmlElementByAttribute(
      elements,
      ":key",
      "citation.key",
    );
    const citationButton = findHtmlElementByAttribute(
      elements,
      ":disabled",
      "citation.preview === true",
    );
    const findingCitations = findHtmlElementByAttribute(
      elements,
      "x-for",
      "citation in block.statements[0].citations",
    );

    expect(answerSectionFilter.tagName).toBe("template");
    expect(bulletBlock.tagName).toBe("template");
    expect(citationTemplate.tagName).toBe("template");
    expect(citationButton.tagName).toBe("button");
    expect(findingCitations.tagName).toBe("template");
    expect(elements.some((element) => {
      return readHtmlAttribute(element, ":key") === "citation.id";
    })).toBe(false);
  });

  it("declares the research notebook template for Ask", async () => {
    const [fragment, index, stylesheet] = await Promise.all([
      readFile(new URL("../web/fragments/ask.html", import.meta.url), "utf8"),
      readFile(new URL("../web/index.html", import.meta.url), "utf8"),
      readFile(
        new URL("../web/assets/styles/citeloom-ask.css", import.meta.url),
        "utf8",
      ),
    ]);
    const fragmentElements = readHtmlElements(fragment);
    const indexElements = readHtmlElements(index);
    const evidenceDialog = indexElements.find((element) => {
      return htmlElementHasClass(element, "evidence-window");
    });
    const citationTarget = findHtmlElementByAttribute(
      fragmentElements,
      ":data-evidence-citation-id",
      "citation.id",
    );
    const dragHandle = findHtmlElementByAttribute(
      indexElements,
      "@pointerdown",
      "beginEvidencePanelDrag($event)",
    );
    const pinButton = findHtmlElementByAttribute(
      indexElements,
      "x-text",
      "citationWindow.pinned ? 'Unpin' : 'Pin evidence'",
    );

    for (const className of [
      "ask-composer-scope-chip",
      "answer-question-title",
      "source-navigator",
      "research-thread-actions",
    ]) {
      expect(fragmentElements.some((element) => {
        return htmlElementHasClass(element, className);
      })).toBe(true);
    }
    expect(findHtmlElementByTagName(
      fragmentElements,
      "citeloom-evidence-window",
    ).tagName).toBe("citeloom-evidence-window");
    expect(findHtmlElementByAttribute(
      indexElements,
      "x-ref",
      "evidencePanel",
    )).toBe(evidenceDialog);
    expect(readHtmlAttribute(evidenceDialog, "role")).toBe("dialog");
    expect(citationTarget.tagName).toBe("button");
    expect(dragHandle.tagName).toBe("header");
    expect(pinButton.tagName).toBe("button");
    expect(findHtmlElementByAttribute(
      fragmentElements,
      "@click",
      "inspectCitationFromNavigator(source)",
    ).tagName).toBe("button");
    expect(findHtmlElementByAttribute(
      fragmentElements,
      "x-show",
      "historicalAnswerVisible && hasAnswerContent()",
    ).tagName).toBe("div");
    expect(fragmentElements.some((element) => {
      return htmlElementHasClass(element, "evidence-window");
    })).toBe(false);
    expect(fragmentElements.some((element) => {
      return htmlElementHasClass(element, "research-context-menu")
        || htmlElementHasClass(element, "evidence-sources-pane");
    })).toBe(false);
    expect(stylesheet).toContain(
      "grid-template-columns: 220px minmax(0, 1fr) 290px;",
    );
  });

  it("places exact evidence above its citation without covering it", () => {
    const placement = readAskEvidencePanelPlacement(
      { height: 22, left: 640, top: 700, width: 28 },
      { height: 460, width: 760 },
      { height: 900, width: 1440 },
    );

    expect(placement.top + placement.maxHeight).toBeLessThanOrEqual(690);
    expect(placement.left).toBe(640);
    expect(placement.left + placement.width).toBeLessThanOrEqual(1424);
  });

  it("preserves evidence panel height while its citation scrolls", () => {
    const panel = { height: 274, width: 760 };
    const viewport = { height: 900, width: 1440 };
    const beforeScroll = readAskEvidencePanelPlacement(
      { height: 22, left: 500, top: 300, width: 24 },
      panel,
      viewport,
    );
    const afterScroll = readAskEvidencePanelPlacement(
      { height: 22, left: 500, top: 100, width: 24 },
      panel,
      viewport,
    );

    expect(afterScroll.maxHeight).toBe(beforeScroll.maxHeight);
    expect(afterScroll.top).toBe(beforeScroll.top - 200);
  });

  it("omits unavailable page labels", () => {
    expect(formatDocumentLocationLabel("source.html", [])).toBe("");
    expect(formatDocumentLocationLabel("source.pdf", [4])).toBe("Page 4");
  });

  it("declares an accessible label for finding verification", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/ask.html", import.meta.url),
      "utf8",
    );
    const elements = readHtmlElements(fragment);
    const status = findHtmlElementByAttribute(
      elements,
      ":aria-label",
      "answerStatementStatusLabel(statement)",
    );

    expect(status.tagName).toBe("span");
    expect(readHtmlAttribute(status, "x-text")).toBeNull();
  });

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
      content: "The answer cites a table.",
      schemaVersion: 2,
      statements: [{
        citationIds: [citationId],
        content: "The table supports the finding.",
        presentation: "paragraph" as const,
        section: "key-points" as const,
      }],
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
