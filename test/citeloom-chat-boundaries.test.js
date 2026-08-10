import { describe, expect, it } from "vitest";

import {
  readChatConversation,
  readChatDashboard,
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

  it("reads the chat dashboard contract", () => {
    expect(readChatDashboard({
      features: {
        speechToText: true,
        textToSpeech: true,
        textToSpeechPreload: false,
      },
      inferenceRuntime: {
        claimVerifier: { supportThreshold: 0.7 },
      },
    })).toEqual({
      claimVerifierSupportThreshold: 0.7,
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

  it("assigns the same stable identity to persisted chat citations", () => {
    const conversation = readChatConversation(buildCitedConversation());
    const citation = conversation.runs[0].messages[0].citations[0];

    expect(citation).toMatchObject({
      key: JSON.stringify(["version-1", "document-1", "element-1"]),
      preview: false,
    });
    expect(conversation.runs[0].messages[0].answerContent).toMatchObject({
      statements: [{
        citationKeys: [],
        content: "The report describes a revenue change.",
      }, {
        citationKeys: [
          JSON.stringify(["version-1", "document-1", "element-1"]),
        ],
        content: "Revenue increased.",
      }],
    });
    expect(conversation.runs[0].messages[0].claims[0]).toMatchObject({
      claimIndex: 0,
      evidenceUnits: [{
        citationNumber: 1,
        supportProbability: 0.9,
      }],
    });
  });

  it("rejects malformed chat feature and scope values at the boundary", () => {
    expect(() => readChatDashboard({
      features: {
        speechToText: "yes",
        textToSpeech: true,
        textToSpeechPreload: false,
      },
      inferenceRuntime: {
        claimVerifier: { supportThreshold: 0.7 },
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

function buildCitedConversation() {
  const answerCitation = {
    citationNumber: 1,
    documentId: "document-1",
    documentVersionId: "version-1",
    elementId: "element-1",
    evidence: { excerpt: "Revenue increased.", kind: "text" },
    id: "citation-1",
    kind: "text",
    pageNumbers: [7],
    regions: [],
    sectionPath: [],
    sourceFile: "report.pdf",
  };
  return {
    createdAt: "2026-08-04T00:00:00.000Z",
    id: "chat-1",
    ownerUserId: "user-1",
    runs: [{
      attemptCount: 1,
      completedAt: "2026-08-04T00:01:00.000Z",
      errorMessage: null,
      id: "run-1",
      messages: [{
        answerDocument: {
          citations: [answerCitation],
          content: "The report describes a revenue change.",
          schemaVersion: 2,
          statements: [{
            citationIds: ["citation-1"],
            content: "Revenue increased.",
            presentation: "bullet",
            section: "answer",
          }],
        },
        citations: [{
          ...answerCitation,
          createdAt: "2026-08-04T00:01:00.000Z",
          mediaType: "application/pdf",
          sourceAvailable: true,
        }],
        claims: [{
          citationNumbers: [1],
          claim: "Revenue increased.",
          claimIndex: 0,
          evidenceUnits: [{
            citationNumber: 1,
            outcome: "supported",
            rationale: "The cited evidence directly supports the claim.",
            supportProbability: 0.9,
            unitId: "claim-0-citation-1",
          }],
          rationale: "The cited evidence supports the answer statement.",
          status: "supported",
        }],
        content: "Revenue increased.",
        createdAt: "2026-08-04T00:01:00.000Z",
        id: "message-1",
        role: "assistant",
        runId: "run-1",
        verificationState: "completed",
      }],
      sequence: 1,
      state: "completed",
    }],
    scope: { kind: "all" },
    title: "Quarterly results",
    updatedAt: "2026-08-04T00:01:00.000Z",
    workspaceId: "workspace-1",
  };
}
