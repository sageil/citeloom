import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CHAT_ANSWER_RESPONSE,
} from "../src/chat/answer-response.js";
import {
  createChatSystemPrompt,
} from "../src/chat/prompt.js";

describe("Chat answer response", () => {
  it("exposes only answer at the structured-output root", () => {
    const schema = z.toJSONSchema(
      CHAT_ANSWER_RESPONSE.createSchema(["SOURCE_1", "SOURCE_2"]),
    );

    expect(schema).toMatchObject({
      additionalProperties: false,
      required: ["answer"],
      type: "object",
    });
    const schemaText = JSON.stringify(schema);
    expect(schemaText).toContain('"topics"');
    expect(schemaText).not.toContain('"findings"');
    expect(schemaText).not.toContain('"status"');
  });

  it("decodes a cited answer and verifies only its topics", () => {
    const result = CHAT_ANSWER_RESPONSE.decode({
      answer: {
        content: "Rule B establishes two related rights.",
        source_refs: ["SOURCE_2"],
        topics: [{
          content: "People may access and correct their records.",
          source_refs: ["SOURCE_2"],
          title: "Access and correction",
        }],
      },
    }, ["SOURCE_1", "SOURCE_2"]);

    expect(result).toEqual({
      draft: {
        conflictGroups: [],
        statements: [
          {
            content: "Rule B establishes two related rights.",
            evidenceRefs: ["SOURCE_2"],
            presentation: "paragraph",
            section: "answer",
          },
          {
            content: "Access and correction\n\nPeople may access and correct their records.",
            evidenceRefs: ["SOURCE_2"],
            presentation: "bullet",
            section: "answer",
          },
        ],
        status: "answered",
      },
      verificationStatementIndexes: [1],
    });
  });

  it("decodes empty answer references as an uncited response", () => {
    const result = CHAT_ANSWER_RESPONSE.decode({
      answer: {
        content: "The supplied sources do not establish who signed the agreement.",
        source_refs: [],
        topics: [],
      },
    }, ["SOURCE_1"]);

    expect(result).toEqual({
      draft: {
        content: "The supplied sources do not establish who signed the agreement.",
        status: "uncited",
      },
      verificationStatementIndexes: [],
    });
  });

  it("rejects the removed findings field", () => {
    expect(() => CHAT_ANSWER_RESPONSE.decode({
      answer: {
        content: "Rule B provides access rights.",
        source_refs: ["SOURCE_1"],
        topics: [],
      },
      findings: [{
        claim: "The agreement takes effect on January 1.",
        source_refs: ["SOURCE_1"],
      }],
    }, ["SOURCE_1"])).toThrow("Invalid Chat answer model response.");
  });

  it("rejects the removed status field", () => {
    expect(() => CHAT_ANSWER_RESPONSE.decode({
      answer: {
        content: "The supplied sources do not establish who signed the agreement.",
        source_refs: [],
        topics: [],
      },
      status: "no_answer",
    }, ["SOURCE_1"])).toThrow("Invalid Chat answer model response.");
  });
});

describe("Chat system prompt", () => {
  it("matches the status-free Chat response schema", () => {
    const prompt = createChatSystemPrompt();

    expect(prompt).toContain("MISSION");
    expect(prompt).toContain("PROMPT-INJECTION DEFENSE");
    expect(prompt).toContain("ANSWER COVERAGE");
    expect(prompt).toContain("OUTPUT CONTRACT");
    expect(prompt).toContain("INSUFFICIENT-EVIDENCE EXAMPLE");
    expect(prompt).toContain(
      "The top-level object must contain only answer.",
    );
    expect(prompt).toContain(
      "Do not reduce answer.content to a generic introduction or an announcement of the topics that follow.",
    );
    expect(prompt).toContain(
      "Do not repeat the same detailed claim in answer.content and answer.topics.",
    );
    expect(prompt).not.toContain("findings");
    expect(prompt).not.toContain('"status"');
    expect(prompt).not.toContain("no_answer");
  });
});
