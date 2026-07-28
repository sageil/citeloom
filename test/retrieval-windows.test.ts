import { describe, expect, it } from "vitest";

import type {
  ImageElement,
  TableCell,
  TableElement,
  TextElement,
} from "../src/domain/source-elements.js";
import {
  createRetrievalWindowPolicy,
  createRetrievalWindowPolicyContract,
} from "../src/retrieval/window-policy.js";
import {
  buildRetrievalWindowProviderInput,
  createRetrievalWindows,
} from "../src/retrieval/windows.js";
import { countEmbeddingInputTokens } from "../src/embedding/token-counter.js";
import { buildSourceLocation } from "./source-element-fixture.js";

describe("deterministic retrieval windows", () => {
  it("embeds normalized text directly without overlap or generated text", () => {
    const element = buildTextElement(
      [
        "First paragraph contains exact source language.",
        "Second paragraph preserves another exact statement.",
      ].join("\n\n"),
    );
    const policy = createPolicy(180);

    const first = createRetrievalWindows([element], {
      embeddingProfile: "plain",
      policy,
    });
    const second = createRetrievalWindows([element], {
      embeddingProfile: "plain",
      policy,
    });

    expect(first).toEqual(second);
    expect(first.map((window) => window.content).join("\n\n")).toContain(
      "First paragraph contains exact source language.",
    );
    expect(first.map((window) => window.content).join("\n\n")).toContain(
      "Second paragraph preserves another exact statement.",
    );
    const occurrences = first
      .map((window) => window.content)
      .join("\n")
      .match(/First paragraph/gu);
    expect(occurrences).toHaveLength(1);
  });

  it("counts the complete provider-formatted input including its section", () => {
    const element = buildTextElement("Exact source evidence.");
    const windows = createRetrievalWindows([element], {
      embeddingProfile: "embeddinggemma",
      policy: createPolicy(512),
    });
    const window = windows[0];
    if (window === undefined) {
      throw new Error("Missing retrieval window.");
    }
    const providerInput = buildRetrievalWindowProviderInput(
      window,
      element,
      "embeddinggemma",
    );

    expect(providerInput).toContain("title: none | text: Section: Test section");
    expect(window.effectiveInputTokens).toBe(
      countEmbeddingInputTokens(providerInput),
    );
  });

  it("splits oversized text at stable word boundaries within the provider limit", () => {
    const element = buildTextElement("searchable-term ".repeat(200));
    const policy = createPolicy(160);

    const windows = createRetrievalWindows([element], {
      embeddingProfile: "plain",
      policy,
    });

    expect(windows.length).toBeGreaterThan(1);
    expect(windows.every((window) => {
      return window.effectiveInputTokens <= 160;
    })).toBe(true);
    expect(windows.map((window) => window.content).join(" "))
      .toContain("searchable-term");
    expect(windows[0]?.previousWindowId).toBeNull();
    expect(windows[0]?.nextWindowId).toBe(windows[1]?.id);
    expect(windows.at(-1)?.nextWindowId).toBeNull();
    expect(windows.at(-1)?.previousWindowId).toBe(
      windows.at(-2)?.id,
    );
  });

  it("keeps a sentence intact when it exceeds only the soft target", () => {
    const content = "This complete sentence remains intact even though its token count exceeds the soft target.";
    const windows = createRetrievalWindows([buildTextElement(content)], {
      embeddingProfile: "plain",
      policy: createPolicy(12, 128),
    });

    expect(windows).toHaveLength(1);
    expect(windows[0]?.content).toBe(content);
    expect(windows[0]?.effectiveInputTokens).toBeGreaterThan(12);
  });

  it("preserves source spacing while grouping adjacent sentences", () => {
    const content = [
      "First source sentence.  Second source sentence.",
      "Third source sentence.",
    ].join("   ");
    const windows = createRetrievalWindows([buildTextElement(content)], {
      embeddingProfile: "plain",
      policy: createPolicy(15, 128),
    });

    expect(windows.map((window) => window.content)).toEqual([
      "First source sentence.  Second source sentence.",
      "Third source sentence.",
    ]);
  });

  it("prefers punctuation before word boundaries for one oversized sentence", () => {
    const content = [
      "Alpha evidence has a stable boundary,",
      "beta evidence continues with enough additional words to exceed the limit.",
    ].join(" ");
    const windows = createRetrievalWindows([buildTextElement(content)], {
      embeddingProfile: "plain",
      policy: createPolicy(18),
    });

    expect(windows.length).toBeGreaterThan(1);
    expect(windows[0]?.content.endsWith(",")).toBe(true);
    expect(windows.every((window) => {
      return window.effectiveInputTokens <= 18;
    })).toBe(true);
  });

  it("preserves a fenced code block until its matching closing fence", () => {
    const codeBlock = [
      "````ts",
      "const first = 1;",
      "```",
      "const second = 2;",
      "````",
    ].join("\n");
    const content = [
      "Introductory paragraph.",
      "",
      codeBlock,
      "Following paragraph.",
    ].join("\n");
    const windows = createRetrievalWindows([buildTextElement(content)], {
      embeddingProfile: "plain",
      policy: createPolicy(16, 128),
    });

    expect(windows.some((window) => window.content === codeBlock)).toBe(true);
  });

  it("does not link or group content across parent section boundaries", () => {
    const first = buildTextElement("First section evidence.");
    const second = {
      ...buildTextElement("Second section evidence."),
      id: "c".repeat(64),
      sectionPath: ["Another section"],
    };
    const windows = createRetrievalWindows([first, second], {
      embeddingProfile: "plain",
      policy: createPolicy(512),
    });

    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      nextWindowId: null,
      parentId: first.id,
      previousWindowId: null,
    });
    expect(windows[1]).toMatchObject({
      nextWindowId: null,
      parentId: second.id,
      previousWindowId: null,
    });
  });

  it("creates no raw image window", () => {
    const windows = createRetrievalWindows([buildImageElement()], {
      embeddingProfile: "plain",
      policy: createPolicy(512),
    });

    expect(windows).toEqual([]);
  });

  it("splits a complete logical table into row windows with repeated caption and headers", () => {
    const table = buildTableElement(12);
    const policy = createPolicy(55);

    const windows = createRetrievalWindows([table], {
      embeddingProfile: "plain",
      policy,
    });

    expect(windows.length).toBeGreaterThan(1);
    const coveredRows: number[] = [];
    for (const window of windows) {
      expect(window.content).toContain("Caption: Complaints by province");
      expect(window.content).toContain("| Province | Complaints |");
      expect(window.table?.headerHash).toMatch(/^[a-f0-9]{64}$/u);
      const rowStart = window.table?.rowStart;
      const rowEnd = window.table?.rowEnd;
      if (rowStart === undefined || rowEnd === undefined) {
        throw new Error("Table retrieval window is missing its row range.");
      }
      for (let row = rowStart; row < rowEnd; row += 1) {
        coveredRows.push(row);
      }
    }
    expect(coveredRows).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  });

  it("splits headerless tables while preserving empty structural headers", () => {
    const table = buildHeaderlessTableElement(12);
    const windows = createRetrievalWindows([table], {
      embeddingProfile: "plain",
      policy: createPolicy(45),
    });

    expect(windows.length).toBeGreaterThan(1);
    const coveredRows: number[] = [];
    for (const window of windows) {
      expect(window.content).toContain("|  |  |");
      expect(window.content).not.toMatch(/\bColumn \d+\b/u);
      const rowStart = window.table?.rowStart;
      const rowEnd = window.table?.rowEnd;
      if (rowStart === undefined || rowEnd === undefined) {
        throw new Error("Headerless table window is missing its row range.");
      }
      for (let row = rowStart; row < rowEnd; row += 1) {
        coveredRows.push(row);
      }
    }
    expect(coveredRows).toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    );
  });

  it("includes the input limit in the policy fingerprint and window identity", () => {
    const element = buildTextElement("One exact paragraph.");
    const smallPolicy = createPolicy(512);
    const largePolicy = createPolicy(768);
    const small = createRetrievalWindows([element], {
      embeddingProfile: "plain",
      policy: smallPolicy,
    });
    const large = createRetrievalWindows([element], {
      embeddingProfile: "plain",
      policy: largePolicy,
    });

    expect(smallPolicy.fingerprint).not.toBe(largePolicy.fingerprint);
    expect(small[0]?.id).not.toBe(large[0]?.id);
  });
});

function createPolicy(
  targetInputTokens: number,
  maximumInputTokens = targetInputTokens,
) {
  return createRetrievalWindowPolicyContract(
    createRetrievalWindowPolicy(
      "structured-token-v3",
      targetInputTokens,
      maximumInputTokens,
    ),
  );
}

function buildTextElement(content: string): TextElement {
  return {
    content,
    documentId: "a".repeat(64),
    id: "b".repeat(64),
    detectedTypes: ["paragraph"],
    kind: "text",
    ...buildSourceLocation(1),
    sourceFile: "/tmp/retrieval.txt",
  };
}

function buildImageElement(): ImageElement {
  return {
    caption: "Architecture",
    content: Buffer.from("image").toString("base64"),
    detectedType: "picture",
    documentId: "a".repeat(64),
    id: "c".repeat(64),
    kind: "image",
    mimeType: "image/png",
    ...buildSourceLocation(2),
    sourceFile: "/tmp/retrieval.pdf",
  };
}

function buildTableElement(dataRowCount: number): TableElement {
  const header = "| Province | Complaints |\n| --- | --- |";
  const rows: string[] = [];
  for (let index = 0; index < dataRowCount; index += 1) {
    rows.push(`| Province ${index + 1} | ${(index + 1) * 10} |`);
  }
  const cells: TableCell[] = [{
    columnHeader: true,
    columnSpan: 1,
    endColumn: 1,
    endRow: 1,
    rowHeader: false,
    rowSection: false,
    rowSpan: 1,
    startColumn: 0,
    startRow: 0,
    text: "Province",
  }, {
    columnHeader: true,
    columnSpan: 1,
    endColumn: 2,
    endRow: 1,
    rowHeader: false,
    rowSection: false,
    rowSpan: 1,
    startColumn: 1,
    startRow: 0,
    text: "Complaints",
  }];
  return {
    caption: "Complaints by province",
    content: [
      "Caption: Complaints by province",
      "",
      header,
      ...rows,
    ].join("\n"),
    detectedType: "table",
    documentId: "a".repeat(64),
    id: "d".repeat(64),
    kind: "table",
    ...buildSourceLocation(3),
    sourceFile: "/tmp/retrieval.pdf",
    table: {
      cells,
      columnCount: 2,
      rowCount: dataRowCount + 1,
      rowEnd: dataRowCount + 1,
      rowStart: 0,
    },
  };
}

function buildHeaderlessTableElement(dataRowCount: number): TableElement {
  const rows: string[] = [];
  const cells: TableCell[] = [];
  for (let index = 0; index < dataRowCount; index += 1) {
    const section = String(index + 1);
    const title = `Section ${index + 1}`;
    rows.push(`| ${section} | ${title} |`);
    cells.push(
      buildTableCell(section, index, 0, false),
      buildTableCell(title, index, 1, false),
    );
  }
  return {
    caption: null,
    content: [
      "|  |  |",
      "| --- | --- |",
      ...rows,
    ].join("\n"),
    detectedType: "table",
    documentId: "a".repeat(64),
    id: "e".repeat(64),
    kind: "table",
    ...buildSourceLocation(4),
    sourceFile: "/tmp/retrieval.pdf",
    table: {
      cells,
      columnCount: 2,
      rowCount: dataRowCount,
      rowEnd: dataRowCount,
      rowStart: 0,
    },
  };
}

function buildTableCell(
  text: string,
  row: number,
  column: number,
  columnHeader: boolean,
): TableCell {
  return {
    columnHeader,
    columnSpan: 1,
    endColumn: column + 1,
    endRow: row + 1,
    rowHeader: false,
    rowSection: false,
    rowSpan: 1,
    startColumn: column,
    startRow: row,
    text,
  };
}
