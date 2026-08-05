import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { registerPage } from "../web/assets/scripts/citeloom-chat.js";

describe("CiteLoom chat page", () => {
  it("offers speech controls for every completed assistant response", () => {
    const page = createChatPage();
    const firstMessage = buildAssistantMessage("answer-1", "completed");
    const secondMessage = buildAssistantMessage("answer-2", "completed");
    page.conversation = buildConversation(firstMessage, secondMessage);
    page.textToSpeechEnabled = true;

    expect(page.canUseMessageSpeech(firstMessage)).toBe(true);
    expect(page.canUseMessageSpeech(secondMessage)).toBe(true);
    page.speechAnswerMessageId = firstMessage.id;
    page.speechAudioPlaying = true;
    expect(page.messageSpeechButtonLabel(firstMessage)).toBe("Pause");
    expect(page.messageSpeechButtonLabel(secondMessage)).toBe("Listen");
  });

  it("keeps the latest evidence-validation state in the fixed context bar", () => {
    const page = createChatPage();
    page.conversation = buildConversation(
      buildAssistantMessage("answer-1", "completed"),
      buildAssistantMessage("answer-2", "running"),
    );

    expect(page.conversationVerificationState()).toBe("running");
    expect(page.conversationVerificationVisible()).toBe(true);
    expect(page.conversationVerificationStatusLabel()).toBe(
      "Checking evidence",
    );
    expect(page.conversationVerificationProgressValue()).toBeNull();
  });

  it("renders preview citations without claiming verification is complete", () => {
    const page = createChatPage();
    const message = buildAssistantMessage("answer-1", "pending");
    message.citations = [{
      citationNumber: null,
      key: "citation-1",
      pageNumbers: [7],
      preview: true,
      sourceFile: "report.pdf",
    }];

    expect(page.citationLabel(message.citations[0])).toBe("p. 7");
    expect(page.citationVerificationDescription(
      message,
      0,
      "citation-1",
    )).toBe(
      "Source identified from report.pdf. Evidence verification starts when the answer is complete.",
    );
  });

  it("places verification in the context bar and speech on each response", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/chat.html", import.meta.url),
      "utf8",
    );

    expect(fragment).toContain("chat-context-verification");
    expect(fragment).toContain("conversationVerificationState()");
    expect(fragment).toContain("toggleMessageSpeech(message)");
    expect(fragment).not.toContain("toggleChatSpeech()");
  });
});

function createChatPage() {
  let pageFactory = null;
  registerPage({
    data(name, factory) {
      expect(name).toBe("citeloomChatPage");
      pageFactory = factory;
    },
  });
  return pageFactory();
}

function buildAssistantMessage(id, verificationState) {
  return {
    answerContent: { citations: [], statements: [] },
    answerDocument: { citations: [], content: "Answer", schemaVersion: 1, statements: [] },
    citations: [],
    claims: [],
    content: "Answer",
    createdAt: "2026-08-04T00:01:00.000Z",
    id,
    role: "assistant",
    runId: `${id}-run`,
    verificationState,
  };
}

function buildConversation(...messages) {
  const runs = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    runs.push({
      id: message.runId,
      messages: [message],
      sequence: index + 1,
      state: "completed",
    });
  }
  return { id: "chat-1", runs };
}
