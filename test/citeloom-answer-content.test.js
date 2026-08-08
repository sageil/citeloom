import { describe, expect, it } from "vitest";

import {
  applyAnswerContentUpdate,
  buildAnswerContentSections,
  createEmptyAnswerContent,
  linkAnswerContentCitations,
  linkAnswerContentVerification,
  readAnswerContentUpdate,
} from "../web/assets/scripts/citeloom-answer-content.js";
import { registerPage } from "../web/assets/scripts/citeloom-ask.js";

describe("CiteLoom answer content updates", () => {
  it("shows Ask sources while evidence verification is pending", () => {
    let createPage;
    registerPage({
      data(_name, factory) {
        createPage = factory;
      },
    });
    if (createPage === undefined) {
      throw new Error("Ask page registration did not provide a page factory.");
    }
    const page = createPage();
    page.answer = {
      claims: [{
        citationNumbers: [1],
        status: "unverified",
      }],
      sources: [{ citationNumber: 1 }],
      verificationState: "pending",
    };

    expect(page.answer.sources).toHaveLength(1);
    expect(page.answerVerificationState()).toBe("pending");
    expect(page.answerVerificationStatusLabel()).toBe("Queued");
    expect(page.answerVerificationProgressValue()).toBeNull();
    expect(page.citationNavigatorStatus(1)).toBe("pending");
    expect(page.citationNavigatorStatusLabel(1)).toBe("Checking");

    page.answer.verificationState = "completed";
    page.answer.claims[0].status = "supported";
    expect(page.answerVerificationStatusLabel()).toBe("Verified");
    expect(page.answerVerificationProgressValue()).toBe(100);
    expect(page.citationNavigatorStatusLabel(1)).toBe("Verified");
  });

  it("shows question titles only for historical answers", () => {
    let createPage;
    registerPage({
      data(_name, factory) {
        createPage = factory;
      },
    });
    if (createPage === undefined) {
      throw new Error("Ask page registration did not provide a page factory.");
    }
    const page = createPage();
    page.presentHistoricalAnswer({
      answerDocument: {
        citations: [],
        content: "A historical answer.",
        schemaVersion: 2,
        statements: [],
      },
      sources: [],
    });

    expect(page.historicalAnswerVisible).toBe(true);

    page.clearAnswerPresentation();
    page.applyStreamedAnswerUpdate(readAnswerContentUpdate({
      citations: [],
      statementCount: 1,
      statements: [{
        citationKeys: [],
        content: "A new streamed answer.",
        index: 0,
        mode: "replace",
        presentation: "paragraph",
        section: "answer",
      }],
    }));

    expect(page.historicalAnswerVisible).toBe(false);
  });

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
        citationNumber: 1,
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

  it("keeps streamed citation nodes stable when persisted evidence is linked", () => {
    const update = readAnswerContentUpdate({
      citations: [{
        citationNumber: 1,
        key: "citation-1",
        pageNumbers: [7],
        sourceFile: "report.pdf",
      }],
      statementCount: 1,
      statements: [{
        citationKeys: ["citation-1"],
        content: "Revenue increased.",
        index: 0,
        mode: "replace",
        presentation: "bullet",
        section: "key-points",
      }],
    });
    const content = applyAnswerContentUpdate(createEmptyAnswerContent(), update);
    const sections = buildAnswerContentSections(content);
    const citation = sections[0].blocks[0].statements[0].citations[0];

    expect(citation).toMatchObject({
      citationNumber: 1,
      key: "citation-1",
      preview: true,
    });

    linkAnswerContentCitations(content, [{
      citationNumber: 1,
      evidence: { excerpt: "Revenue increased.", kind: "text" },
      id: "stored-citation-1",
      key: "citation-1",
      pageNumbers: [7],
      preview: false,
      sourceFile: "report.pdf",
    }]);

    expect(sections[0].blocks[0].statements[0].citations[0]).toBe(citation);
    expect(citation).toMatchObject({
      id: "stored-citation-1",
      preview: false,
    });
  });

  it("completes Ask verification without rebuilding streamed sections", () => {
    let createPage;
    registerPage({
      data(_name, factory) {
        createPage = factory;
      },
    });
    if (createPage === undefined) {
      throw new Error("Ask page registration did not provide a page factory.");
    }
    const page = createPage();
    const citationKey = JSON.stringify([
      "00000000-0000-4000-8000-000000000002",
      "a".repeat(64),
      "b".repeat(64),
    ]);
    page.applyStreamedAnswerUpdate(readAnswerContentUpdate({
      citations: [{
        citationNumber: 1,
        key: citationKey,
        pageNumbers: [7],
        sourceFile: "report.pdf",
      }],
      statementCount: 2,
      statements: [{
        citationKeys: [],
        content: "The report describes a revenue change.",
        index: 0,
        mode: "replace",
        presentation: "paragraph",
        section: "answer",
      }, {
        citationKeys: [citationKey],
        content: "Revenue increased.",
        index: 1,
        mode: "replace",
        presentation: "bullet",
        section: "key-points",
      }],
    }));
    const sections = page.answerContentSections;
    const statement = sections[1].blocks[0].statements[0];
    const citation = statement.citations[0];

    page.completeStreamedAnswer({
      answerDocument: {
        citations: [{ id: "stored-citation-1" }],
        content: "The report describes a revenue change.",
        statements: [{
          citationIds: ["stored-citation-1"],
          content: "Revenue increased.",
          presentation: "bullet",
          section: "key-points",
        }],
      },
      sources: [{
        citationNumber: 1,
        evidence: { excerpt: "Revenue increased.", kind: "text" },
        id: "stored-citation-1",
        key: citationKey,
        pageNumbers: [7],
        preview: false,
        sourceFile: "report.pdf",
      }],
    });

    expect(page.answerContentSections).toBe(sections);
    expect(page.answerContentSections[1].blocks[0].statements[0]).toBe(statement);
    expect(page.answerContentSections[1].blocks[0].statements[0].citations[0]).toBe(citation);
    expect(citation).toMatchObject({
      id: "stored-citation-1",
      preview: false,
    });
    expect(statement.verificationIndex).toBe(0);
  });

  it("rejects verification metadata for mismatched streamed content", () => {
    const content = applyAnswerContentUpdate(
      createEmptyAnswerContent(),
      readAnswerContentUpdate({
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
      }),
    );

    expect(() => linkAnswerContentVerification(
      content,
      buildAnswerContentSections(content),
      {
        citations: [],
        content: "Revenue decreased.",
        statements: [],
      },
    )).toThrow("The streamed and completed direct answers do not match.");
  });

  it("rejects a completed answer that omits streamed citation evidence", () => {
    const content = applyAnswerContentUpdate(
      createEmptyAnswerContent(),
      readAnswerContentUpdate({
        citations: [{
          citationNumber: 1,
          key: "citation-1",
          pageNumbers: [7],
          sourceFile: "report.pdf",
        }],
        statementCount: 1,
        statements: [{
          citationKeys: ["citation-1"],
          content: "Revenue increased.",
          index: 0,
          mode: "replace",
          presentation: "bullet",
          section: "key-points",
        }],
      }),
    );

    expect(() => linkAnswerContentCitations(content, [])).toThrow(
      "Completed answer citation citation-1 is unavailable.",
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
