import { describe, expect, it } from "vitest";

import type {
  ImageElement,
  TableElement,
  TextElement,
} from "../src/domain/source-elements.js";
import {
  imageRetrievalDescriptionSchema,
} from "../src/domain/retrieval-descriptions.js";
import {
  addContextToImageRetrievalRepresentations,
  createRetrievalRepresentations,
} from "../src/retrieval/representations.js";
import {
  createRetrievalWindowPolicy,
  createRetrievalWindowPolicyContract,
} from "../src/retrieval/window-policy.js";
import { createRetrievalWindows } from "../src/retrieval/windows.js";
import {
  buildRetrievalDescriptionRecord,
  buildSourceLocation,
  buildTableStructure,
} from "./source-element-fixture.js";
import { TEST_PLAIN_EMBEDDING_INPUT_FORMAT } from "./config-fixture.js";

const policy = createRetrievalWindowPolicyContract(
  createRetrievalWindowPolicy("structured-token-v3", 512, 2_048),
);

describe("retrieval representations", () => {
  it("classifies visual form independently from retrieval relevance", () => {
    const description = {
      imageType: "photograph",
      isSubstantive: false,
      keyFacts: [],
      keywords: ["decorative image"],
      retrievalText: "A solid dark gray background image.",
      visibleText: [],
    };

    expect(imageRetrievalDescriptionSchema.parse(description))
      .toEqual(description);
  });

  it("creates exact representations only for ordinary text", () => {
    const text = buildTextElement();
    const windows = createRetrievalWindows([text], {
      embeddingInputFormat: TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
      policy,
    });

    const representations = createRetrievalRepresentations(
      [text],
      [],
      windows,
      policy,
    );

    expect(representations).toHaveLength(1);
    expect(representations[0]).toMatchObject({
      content: text.content,
      type: "exact-window",
    });
  });

  it("indexes a table description separately from exact table-row evidence", () => {
    const table = buildTableElement();
    const description = buildRetrievalDescriptionRecord(
      table,
      "Complaints by province: Ontario recorded 120 and Alberta recorded 42.",
    );
    const windows = createRetrievalWindows([table], {
      embeddingInputFormat: TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
      policy,
    });

    const representations = createRetrievalRepresentations(
      [table],
      [description],
      windows,
      policy,
    );

    expect(representations.map((representation) => representation.type))
      .toEqual(["exact-window", "table-description"]);
    expect(representations[1]).toMatchObject({
      content:
        "Complaints by province: Ontario recorded 120 and Alberta recorded 42.",
      id: `${table.id}-description`,
      parentId: table.id,
    });
  });

  it("indexes a substantive image description without embedding image bytes", () => {
    const image = buildImageElement();
    const description = buildRetrievalDescriptionRecord(
      image,
      "Architecture diagram showing documents entering a processing stage.",
    );

    const representations = createRetrievalRepresentations(
      [image],
      [description],
      [],
      policy,
    );

    expect(representations).toHaveLength(1);
    expect(representations[0]).toMatchObject({
      content:
        "Visual summary: Architecture diagram showing documents entering a processing stage.\nImage type: diagram",
      kind: "image",
      parentId: image.id,
      type: "image-description",
    });
    expect(representations[0]?.id).toBe(`${image.id}-description`);
    expect(representations[0]?.embeddingText).not.toContain(image.content);
  });

  it("keeps image context in search text and out of answer evidence", () => {
    const image = buildImageElement();
    const retrievalText =
      "Architecture diagram showing documents entering a processing stage.";
    const description = buildRetrievalDescriptionRecord(image, retrievalText);
    const base = createRetrievalRepresentations(
      [image],
      [description],
      [],
      policy,
    );

    const representations = addContextToImageRetrievalRepresentations(
      base,
      [image],
      [{
        followingText: "The index stores searchable representations.",
        precedingText: "Documents enter the ingestion pipeline.",
      }],
    );

    expect(representations).toHaveLength(1);
    expect(representations[0]?.content).toBe(
      `Visual summary: ${retrievalText}\nImage type: diagram`,
    );
    expect(representations[0]?.embeddingText).toContain(
      `Section: Test section\n${retrievalText}`,
    );
    expect(representations[0]?.embeddingText).toContain(
      "Caption: Document ingestion architecture",
    );
    expect(representations[0]?.embeddingText).toContain(
      "Preceding text:\nDocuments enter the ingestion pipeline.",
    );
    expect(representations[0]?.embeddingText).toContain(
      "Following text:\nThe index stores searchable representations.",
    );
    expect(representations[0]?.content).not.toContain("Preceding text");
    expect(representations[0]?.content).not.toContain("Following text");
  });

  it("skips non-substantive and omitted media descriptions", () => {
    const image = buildImageElement();
    const nonSubstantive = buildRetrievalDescriptionRecord(
      image,
      "Decorative divider with no substantive document information.",
    );
    if (nonSubstantive.kind !== "image") {
      throw new Error("Expected an image description fixture.");
    }
    nonSubstantive.result = {
      description: {
        imageType: "illustration",
        isSubstantive: false,
        keyFacts: [],
        keywords: [],
        retrievalText:
          "Decorative divider with no substantive document information.",
        visibleText: [],
      },
      status: "described",
    };

    expect(createRetrievalRepresentations(
      [image],
      [nonSubstantive],
      [],
      policy,
    )).toEqual([]);
  });

  it("fails when canonical media lacks a terminal description record", () => {
    const table = buildTableElement();
    const windows = createRetrievalWindows([table], {
      embeddingInputFormat: TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
      policy,
    });

    expect(() => createRetrievalRepresentations(
      [table],
      [],
      windows,
      policy,
    )).toThrow(`Missing retrieval description for table element ${table.id}`);
  });
});

function buildTextElement(): TextElement {
  return {
    content: "Ontario recorded 120 privacy complaints.",
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
    content: [
      "Caption: Complaints by province",
      "",
      "| Province | Complaints |",
      "| --- | --- |",
      "| Ontario | 120 |",
    ].join("\n"),
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
    caption: "Document ingestion architecture",
    content: Buffer.from("image bytes").toString("base64"),
    detectedType: "picture",
    documentId: "a".repeat(64),
    id: "d".repeat(64),
    kind: "image",
    mimeType: "image/png",
    ...buildSourceLocation(3),
    sourceFile: "/tmp/report.pdf",
  };
}
