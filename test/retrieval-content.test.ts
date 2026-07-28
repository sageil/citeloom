import { describe, expect, it } from "vitest";

import type {
  ImageElement,
  TableElement,
  TextElement,
} from "../src/domain/source-elements.js";
import { buildRerankDocument } from "../src/retrieval/content.js";
import {
  buildSourceLocation,
  buildTableStructure,
} from "./source-element-fixture.js";

describe("retrieval rerank content", () => {
  it("uses the exact focused text supplied by retrieval", () => {
    const element = buildTextElement();

    expect(buildRerankDocument(element, "Exact retrieval window.")).toBe(
      [
        "/tmp/report.pdf",
        "Section: Test section",
        "Pages: 1",
        "Exact retrieval window.",
      ].join("\n"),
    );
  });

  it("uses exact table evidence rather than its retrieval description", () => {
    const element = buildTableElement();
    const exactWindow = "| Province | Complaints |\n| --- | --- |\n| Ontario | 120 |";

    const document = buildRerankDocument(element, exactWindow);

    expect(document).toContain(exactWindow);
    expect(document).not.toContain("Ontario had the highest complaint count");
  });

  it("can rerank an image by its generated visual description", () => {
    const element = buildImageElement();
    const description =
      "Architecture diagram showing documents entering a processing stage.";

    const document = buildRerankDocument(element, description);

    expect(document).toContain(description);
    expect(document).not.toContain(element.content);
  });
});

function buildTextElement(): TextElement {
  return {
    content: "Complete normalized text block.",
    documentId: "a".repeat(64),
    id: "b".repeat(64),
    detectedTypes: ["paragraph"],
    kind: "text",
    ...buildSourceLocation(1),
    sourceFile: "/tmp/report.pdf",
  };
}

function buildTableElement(): TableElement {
  return {
    caption: "Complaints by province",
    content: "| Province | Complaints |\n| --- | --- |\n| Ontario | 120 |",
    detectedType: "table",
    documentId: "a".repeat(64),
    id: "c".repeat(64),
    kind: "table",
    ...buildSourceLocation(2),
    sourceFile: "/tmp/report.pdf",
    table: {
      ...buildTableStructure(),
      columnCount: 2,
      rowCount: 2,
      rowEnd: 2,
    },
  };
}

function buildImageElement(): ImageElement {
  return {
    caption: "Document architecture",
    content: Buffer.from("image").toString("base64"),
    detectedType: "picture",
    documentId: "a".repeat(64),
    id: "d".repeat(64),
    kind: "image",
    mimeType: "image/png",
    ...buildSourceLocation(3),
    sourceFile: "/tmp/report.pdf",
  };
}
