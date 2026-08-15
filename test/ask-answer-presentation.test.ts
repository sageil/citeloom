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

describe("ask answer presentation", () => {
  it("hides aggregate answer citations while retaining finding citations", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/ask.html", import.meta.url),
      "utf8",
    );

    expect(fragment).toContain("section.key !== 'answer'");
    expect(fragment).toContain("block.statements[0].citations");
    expect(fragment).toContain("block.kind === 'bullets'");
    expect(fragment).toContain(':key="citation.key"');
    expect(fragment).toContain(':disabled="citation.preview === true"');
    expect(fragment).not.toContain(':key="citation.id"');
  });

  it("uses the research notebook workspace for Ask", async () => {
    const [fragment, index, stylesheet] = await Promise.all([
      readFile(new URL("../web/fragments/ask.html", import.meta.url), "utf8"),
      readFile(new URL("../web/index.html", import.meta.url), "utf8"),
      readFile(
        new URL("../web/assets/styles/citeloom-ask.css", import.meta.url),
        "utf8",
      ),
    ]);

    expect(fragment).toContain("class=\"ask-composer-scope-chip\"");
    expect(fragment).toContain("class=\"answer-question-title\"");
    expect(fragment).toContain("class=\"source-navigator\"");
    expect(fragment).toContain(
      "<citeloom-evidence-window></citeloom-evidence-window>",
    );
    expect(index).toContain('x-ref="evidencePanel"');
    expect(index).toContain('x-text="citationWindow.pinned ? \'Unpin\' : \'Pin evidence\'"');
    expect(index).toContain(":style=\"evidencePanelStyle()\"");
    expect(index).toContain("beginEvidencePanelDrag($event)");
    expect(index).toContain("HHEM");
    expect(fragment).not.toContain('class="evidence-window"');
    expect(fragment).toContain(':data-evidence-citation-id="citation.id"');
    expect(fragment).toContain('@click="inspectCitationFromNavigator(source)"');
    expect(fragment).toContain("class=\"research-thread-actions\"");
    expect(fragment).not.toContain("class=\"research-context-menu\"");
    expect(fragment).not.toContain("class=\"evidence-sources-pane\"");
    expect(fragment).toContain(
      'x-show="historicalAnswerVisible &amp;&amp; hasAnswerContent()"',
    );
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

  it("keeps finding verification labels accessible without repeating visible status text", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/ask.html", import.meta.url),
      "utf8",
    );

    expect(fragment).toContain(
      ':aria-label="answerStatementStatusLabel(statement)"',
    );
    expect(fragment).not.toContain(
      '<span x-text="answerStatementStatusLabel(statement)"></span>',
    );
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
