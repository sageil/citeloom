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

  it("uses the shared source navigator and movable evidence window", async () => {
    const fragment = await readFile(
      new URL("../web/fragments/chat.html", import.meta.url),
      "utf8",
    );

    expect(fragment).toContain(
      'class="source-navigator chat-source-navigator"',
    );
    expect(fragment).toContain(
      'class="evidence-window chat-evidence-panel"',
    );
    expect(fragment).toContain(
      ':data-evidence-citation-id="citationForKey(message, citationKey)?.id"',
    );
    expect(fragment).toContain("openCitationFromNavigator(citation)");
    expect(fragment).toContain("beginCitationPanelDrag($event)");
    expect(fragment).toContain(
      'x-text="citationWindow.pinned ? \'Unpin\' : \'Pin evidence\'"',
    );
    expect(fragment).not.toContain("toggleCitationExpanded()");
  });

  it("shows sources for the latest answer unless an older answer is active", () => {
    const page = createChatPage();
    const firstMessage = buildAssistantMessage("answer-1", "completed");
    const secondMessage = buildAssistantMessage("answer-2", "completed");
    firstMessage.citations = [buildCitation("citation-1", 1)];
    secondMessage.citations = [buildCitation("citation-2", 2)];
    page.conversation = buildConversation(firstMessage, secondMessage);

    expect(page.sourceSidebarCitations().map((citation) => citation.id)).toEqual([
      "citation-2",
    ]);

    page.activeEvidenceMessageId = firstMessage.id;
    expect(page.sourceSidebarCitations().map((citation) => citation.id)).toEqual([
      "citation-1",
    ]);
  });

  it("derives sidebar verification from the same per-citation checks", () => {
    const page = createChatPage();
    const message = buildAssistantMessage("answer-1", "completed");
    const citation = buildCitation("citation-1", 1);
    message.citations = [citation];
    message.answerContent.statements = [{
      citationKeys: [citation.key],
      verificationIndex: 0,
    }];
    message.claims = [{
      claimIndex: 0,
      evidenceUnits: [{ citationNumber: 1, outcome: "supported" }],
    }];
    page.conversation = buildConversation(message);

    expect(page.sourceNavigatorStatus(citation)).toBe("supported");
    expect(page.sourceNavigatorStatusLabel(citation)).toBe("Verified");
  });

  it("omits unavailable page labels from Chat evidence", () => {
    const page = createChatPage();

    expect(page.sourcePageLabel({ pageNumbers: [] })).toBe("");
    expect(page.sourcePageLabel({ pageNumbers: [4] })).toBe("p. 4");
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
    answerDocument: { citations: [], content: "Answer", schemaVersion: 2, statements: [] },
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

function buildCitation(id, citationNumber) {
  return {
    citationNumber,
    id,
    key: id,
    pageNumbers: [],
    preview: false,
    sectionPath: ["Findings"],
    sourceFile: "report.pdf",
  };
}
