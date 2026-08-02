import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CHAT_ANSWER_RESPONSE,
} from "../src/chat/answer-response.js";
import {
  createChatSystemPrompt,
} from "../src/chat/prompt.js";

describe("Chat answer response", () => {
  it("exposes only answer and findings at the structured-output root", () => {
    const schema = z.toJSONSchema(
      CHAT_ANSWER_RESPONSE.createSchema(["SOURCE_1", "SOURCE_2"]),
    );

    expect(schema).toMatchObject({
      additionalProperties: false,
      required: ["answer", "findings"],
      type: "object",
    });
    expect(JSON.stringify(schema)).not.toContain('"status"');
  });

  it("decodes a cited response without a status field", () => {
    const result = CHAT_ANSWER_RESPONSE.decode({
      answer: {
        content: "Rule B provides access and correction rights.",
        source_refs: ["SOURCE_2"],
      },
      findings: [{
        claim: "Rule B provides access and correction rights.",
        source_refs: ["SOURCE_2"],
      }],
    }, ["SOURCE_1", "SOURCE_2"]);

    expect(result).toEqual({
      draft: {
        conflictGroups: [],
        statements: [
          {
            content: "Rule B provides access and correction rights.",
            evidenceRefs: ["SOURCE_2"],
            presentation: "paragraph",
            section: "answer",
          },
          {
            content: "Rule B provides access and correction rights.",
            evidenceRefs: ["SOURCE_2"],
            presentation: "bullet",
            section: "key-points",
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
      },
      findings: [],
    }, ["SOURCE_1"]);

    expect(result).toEqual({
      draft: {
        content: "The supplied sources do not establish who signed the agreement.",
        status: "uncited",
      },
      verificationStatementIndexes: [],
    });
  });

  it("rejects findings on an uncited response", () => {
    expect(() => CHAT_ANSWER_RESPONSE.decode({
      answer: {
        content: "The supplied sources do not establish who signed the agreement.",
        source_refs: [],
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
      },
      findings: [],
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
      "The top-level object must contain only:\n  - answer;\n  - findings.",
    );
    expect(prompt).not.toContain('"status"');
    expect(prompt).not.toContain("no_answer");
  });
});
