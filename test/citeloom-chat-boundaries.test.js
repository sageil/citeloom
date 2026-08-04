import { describe, expect, it } from "vitest";

import {
  readChatConversation,
  readChatSpeechFeatures,
  readChatSummaries,
} from "../web/assets/scripts/citeloom-chat-boundaries.js";

describe("CiteLoom chat boundaries", () => {
  it("normalizes chat summaries", () => {
    expect(readChatSummaries([{
      createdAt: "2026-08-04T00:00:00.000Z",
      id: "chat-1",
      messageCount: 2,
      title: "Quarterly results",
      updatedAt: "2026-08-04T00:01:00.000Z",
    }])).toEqual([{
      createdAt: "2026-08-04T00:00:00.000Z",
      id: "chat-1",
      messageCount: 2,
      title: "Quarterly results",
      updatedAt: "2026-08-04T00:01:00.000Z",
    }]);
  });

  it("reads the chat speech feature contract", () => {
    expect(readChatSpeechFeatures({
      features: {
        speechToText: true,
        textToSpeech: true,
        textToSpeechPreload: false,
      },
    })).toEqual({
      speechToTextEnabled: true,
      textToSpeechEnabled: true,
      textToSpeechPreloadEnabled: false,
    });
  });

  it("reads a user-only chat run without requiring answer fields", () => {
    expect(readChatConversation({
      createdAt: "2026-08-04T00:00:00.000Z",
      id: "chat-1",
      ownerUserId: "user-1",
      runs: [{
        attemptCount: 1,
        completedAt: null,
        errorMessage: null,
        id: "run-1",
        messages: [{
          content: "What changed?",
          createdAt: "2026-08-04T00:00:01.000Z",
          id: "message-1",
          role: "user",
          runId: "run-1",
        }],
        sequence: 1,
        state: "accepted",
      }],
      scope: { kind: "tags", tags: ["finance"] },
      title: "Quarterly results",
      updatedAt: "2026-08-04T00:00:01.000Z",
      workspaceId: "workspace-1",
    })).toEqual({
      createdAt: "2026-08-04T00:00:00.000Z",
      id: "chat-1",
      ownerUserId: "user-1",
      runs: [{
        attemptCount: 1,
        completedAt: null,
        errorMessage: null,
        id: "run-1",
        messages: [{
          content: "What changed?",
          createdAt: "2026-08-04T00:00:01.000Z",
          id: "message-1",
          role: "user",
          runId: "run-1",
        }],
        sequence: 1,
        state: "accepted",
      }],
      scope: { kind: "tags", tags: ["finance"] },
      title: "Quarterly results",
      updatedAt: "2026-08-04T00:00:01.000Z",
      workspaceId: "workspace-1",
    });
  });

  it("rejects malformed chat feature and scope values at the boundary", () => {
    expect(() => readChatSpeechFeatures({
      features: {
        speechToText: "yes",
        textToSpeech: true,
        textToSpeechPreload: false,
      },
    })).toThrow("The speech-to-text feature response is invalid.");
    expect(() => readChatConversation({
      createdAt: "2026-08-04T00:00:00.000Z",
      id: "chat-1",
      ownerUserId: "user-1",
      runs: [],
      scope: { kind: "unknown" },
      title: "Quarterly results",
      updatedAt: "2026-08-04T00:00:01.000Z",
      workspaceId: "workspace-1",
    })).toThrow("The scope kind response is invalid.");
  });
});
