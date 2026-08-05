import { describe, expect, it, vi } from "vitest";
import type { UIMessageStreamWriter } from "ai";

import {
  createAnswerContentWriter,
  type CiteLoomUIMessage,
} from "../src/answers/stream.js";
import type { AnswerContentSnapshot } from "../src/answers/content-snapshot.js";

describe("answer content streaming", () => {
  it("publishes citation-only changes as metadata without replacing content", () => {
    const writes: unknown[] = [];
    const writer = {
      write: vi.fn((part: unknown) => {
        writes.push(part);
      }),
    } as unknown as UIMessageStreamWriter<CiteLoomUIMessage>;
    const receiveFirstContent = vi.fn();
    const receive = createAnswerContentWriter(writer, receiveFirstContent);
    const initial = buildSnapshot([]);
    const cited = buildSnapshot(["citation-1"]);
    cited.citations.push({
      key: "citation-1",
      pageNumbers: [7],
      sourceFile: "report.pdf",
    });

    receive(initial);
    receive(cited);
    receive(cited);

    expect(receiveFirstContent).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({
      data: {
        statementCount: 1,
        statements: [{
          citationKeys: [],
          content: "Revenue increased.",
          index: 0,
          mode: "replace",
        }],
      },
      id: "answer-content",
      type: "data-answer-content",
    });
    expect(writes[1]).toEqual({
      data: {
        citations: [{
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
      },
      id: "answer-content",
      type: "data-answer-content",
    });
  });

  it("uses append updates only when presentation and section remain stable", () => {
    const writes: unknown[] = [];
    const writer = {
      write: (part: unknown) => {
        writes.push(part);
      },
    } as unknown as UIMessageStreamWriter<CiteLoomUIMessage>;
    const receive = createAnswerContentWriter(writer);

    receive(buildSnapshot([], "Revenue"));
    receive(buildSnapshot([], "Revenue increased."));

    expect(writes[1]).toMatchObject({
      data: {
        statements: [{
          content: " increased.",
          index: 0,
          mode: "append",
        }],
      },
    });
  });
});

function buildSnapshot(
  citationKeys: string[],
  content = "Revenue increased.",
): AnswerContentSnapshot {
  return {
    citations: [],
    statements: [{
      citationKeys,
      content,
      presentation: "paragraph",
      section: "answer",
    }],
  };
}
