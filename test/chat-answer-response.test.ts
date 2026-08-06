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

  it("allows only an uncited response when no evidence was retrieved", () => {
    const schema = CHAT_ANSWER_RESPONSE.createSchema([]);

    expect(schema.safeParse({
      answer: {
        content: "Hello! How can I help you today?",
        topics: [],
      },
    }).success).toBe(true);
    expect(schema.safeParse({
      answer: {
        content: "The policy applies.",
        topics: [{
          content: "The policy applies.",
          source_refs: ["SOURCE_1"],
          title: "Application",
        }],
      },
    }).success).toBe(false);
  });

  it("decodes a cited answer and verifies only its topics", () => {
    const result = CHAT_ANSWER_RESPONSE.decode({
      answer: {
        content: "Rule B establishes two related rights.",
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
            evidenceRefs: [],
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
      verificationStatementIndexes: null,
    });
  });

  it.each([
    ["greeting", "Hello! How can I help?"],
    ["clarification", "Which policy are you referring to?"],
    ["evidence limitation", "The supplied sources do not establish who signed the agreement."],
  ])("decodes an uncited %s", (_kind, content) => {
    const result = CHAT_ANSWER_RESPONSE.decode({
      answer: {
        content,
        topics: [],
      },
    }, ["SOURCE_1"]);

    expect(result).toEqual({
      draft: {
        content,
        status: "uncited",
      },
      verificationStatementIndexes: [],
    });
  });

  it("rejects the removed findings field", () => {
    expect(() => CHAT_ANSWER_RESPONSE.decode({
      answer: {
        content: "Rule B provides access rights.",
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
        topics: [],
      },
      status: "no_answer",
    }, ["SOURCE_1"])).toThrow("Invalid Chat answer model response.");
  });
});

describe("Chat system prompt", () => {
  it("matches the status-free Chat response schema", () => {
    const prompt = createChatSystemPrompt();

    expect(prompt).toContain("ROLE");
    expect(prompt).toContain("EVIDENCE RULES");
    expect(prompt).toContain("ANSWER RULES");
    expect(prompt).toContain("SOURCE REFERENCES");
    expect(prompt).toContain("STRUCTURE EXAMPLE");
    expect(prompt).toContain("OUTPUT");
    expect(prompt).toContain("REQUEST MODE");
    expect(prompt).toContain(
      "Every grounded answer must include at least one finding in answer.topics.",
    );
    expect(prompt).toContain(
      "Use an empty answer.topics array only for a greeting, clarification, or wholly unsupported response.",
    );
    expect(prompt).toContain(
      "the intended subject cannot be determined from the current message, selected conversation context, and retrieved evidence",
    );
    expect(prompt).toContain(
      "A message remains an information request when it begins with a greeting",
    );
    expect(prompt).toContain(
      "If the request is clear but the supplied evidence cannot answer it, do not ask for clarification.",
    );
    expect(prompt).toContain("Return answer.topics as an empty array.");
    expect(prompt).toContain("GREETING EXAMPLE");
    expect(prompt).toContain("Hello! How can I help you today?");
    expect(prompt).toContain("CLARIFICATION EXAMPLE");
    expect(prompt).toContain("Could you clarify which policy you are referring to?");
    expect(prompt).toContain(
      "Do not duplicate detailed topic statements in answer.content.",
    );
    expect(prompt).not.toContain("findings");
    expect(prompt).not.toContain('"status"');
    expect(prompt).not.toContain("no_answer");
  });
});
