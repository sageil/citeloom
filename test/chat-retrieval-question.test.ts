import { describe, expect, it } from "vitest";

import { createChatRetrievalQuestionInput } from "../src/chat/retrieval-question.js";
import { formatQueryEmbeddingText } from "../src/embedding/input-format.js";
import { countEmbeddingInputTokens } from "../src/embedding/token-counter.js";
import { TEST_PLAIN_EMBEDDING_INPUT_FORMAT } from "./config-fixture.js";

describe("chat retrieval question", () => {
  it("uses only the current question when there is no prior turn", () => {
    const input = createChatRetrievalQuestionInput(
      "What changed?",
      [],
      buildConfig(100),
    );

    expect(input.original).toBe("What changed?");
    expect(input.retrievalQueries).toEqual([{
      kind: "original",
      text: "What changed",
    }]);
  });

  it("adds the complete previous turn when it fits", () => {
    const input = createChatRetrievalQuestionInput(
      "Did it improve?",
      [{
        assistant: "Revenue was 10 percent.",
        user: "What was revenue?",
      }],
      buildConfig(100),
    );

    expect(input.retrievalQueries).toHaveLength(2);
    expect(input.retrievalQueries[1]).toEqual({
      kind: "conversation",
      text: [
        "Previous user message:",
        "What was revenue?",
        "",
        "Previous assistant response for conversation reference only:",
        "Revenue was 10 percent.",
        "",
        "Current user message:",
        "Did it improve",
      ].join("\n"),
    });
  });

  it("omits conversation context when the current question exceeds capacity", () => {
    const input = createChatRetrievalQuestionInput(
      "Explain the complete result?",
      [{ assistant: "Prior answer.", user: "Prior question?" }],
      buildConfig(1),
    );

    expect(input.retrievalQueries).toEqual([{
      kind: "original",
      text: "Explain the complete result",
    }]);
  });

  it("keeps the previous user message and truncates the assistant response", () => {
    const assistant = "Revenue increased steadily. ".repeat(100);
    const config = buildConfig(40);
    const input = createChatRetrievalQuestionInput(
      "Did it continue?",
      [{ assistant, user: "What changed?" }],
      config,
    );
    const conversation = input.retrievalQueries[1];

    expect(conversation?.kind).toBe("conversation");
    expect(conversation?.text).toContain("Previous user message:\nWhat changed?");
    expect(conversation?.text).toContain(
      "Previous assistant response for conversation reference only:",
    );
    expect(conversation?.text).not.toContain(assistant.trimEnd());
    expect(readProviderTokenCount(conversation?.text ?? "")).toBeLessThanOrEqual(
      config.maximumInputTokens,
    );
  });

  it("drops an oversized previous user message before retaining assistant context", () => {
    const config = buildConfig(30);
    const input = createChatRetrievalQuestionInput(
      "What followed?",
      [{
        assistant: "Revenue increased.",
        user: "Earlier details ".repeat(100),
      }],
      config,
    );
    const conversation = input.retrievalQueries[1];

    expect(conversation?.kind).toBe("conversation");
    expect(conversation?.text).not.toContain("Previous user message:");
    expect(conversation?.text).toContain("Revenue increased.");
    expect(readProviderTokenCount(conversation?.text ?? "")).toBeLessThanOrEqual(
      config.maximumInputTokens,
    );
  });
});

function buildConfig(maximumInputTokens: number) {
  return {
    inputFormat: TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
    maximumInputTokens,
  };
}

function readProviderTokenCount(question: string): number {
  const providerInput = formatQueryEmbeddingText(
    TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
    question,
  );
  return countEmbeddingInputTokens(providerInput);
}
