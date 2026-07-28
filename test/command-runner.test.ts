import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted((): string[] => []);
const askIndexedDocumentsMock = vi.hoisted(() => vi.fn());

vi.mock("../src/app/settings.js", () => ({
  ApplicationSettingsRepository: class {
    public read(): Promise<{
      config: object;
      defaults: object;
      overrides: object;
      runtimeSettings: object;
      updatedAt: null;
      version: number;
    }> {
      events.push("settings-read-started");
      return new Promise((resolve) => {
        queueMicrotask(() => {
          events.push("settings-read-completed");
          resolve({
            config: {},
            defaults: {},
            overrides: {},
            runtimeSettings: {},
            updatedAt: null,
            version: 0,
          });
        });
      });
    }
  },
}));

vi.mock("../src/config/index.js", () => ({
  readStartupConfig: (): { database: object; doclingTopology: object } => ({
    database: {},
    doclingTopology: {},
  }),
}));

vi.mock("../src/database/client.js", () => ({
  openDatabase: async (): Promise<{
    close: () => Promise<void>;
    database: object;
  }> => ({
    close: async (): Promise<void> => {
      events.push("database-closed");
    },
    database: {},
  }),
}));

vi.mock("../src/ingestion/worker.js", () => ({
  readSystemStatus: async (): Promise<{
    inference: never[];
    queue: never[];
    workers: never[];
  }> => {
    events.push("status-read");
    return { inference: [], queue: [], workers: [] };
  },
}));

vi.mock("../src/retrieval/pipeline.js", () => ({
  askIndexedDocuments: askIndexedDocumentsMock,
}));

import { main } from "../src/cli/command-runner.js";

describe("CLI database session lifetime", () => {
  beforeEach(() => {
    events.length = 0;
    askIndexedDocumentsMock.mockReset();
    askIndexedDocumentsMock.mockResolvedValue(buildValidatedCliAnswer());
  });

  it("waits for application settings before closing the database session", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main(["status"]);
    } finally {
      consoleLog.mockRestore();
    }

    expect(events).toEqual([
      "settings-read-started",
      "settings-read-completed",
      "database-closed",
      "status-read",
    ]);
  });

  it("prints only the final validated answer and citation set", async () => {
    const lines: string[] = [];
    const consoleLog = vi.spyOn(console, "log").mockImplementation((...values) => {
      lines.push(values.join(" "));
    });
    try {
      await main(["ask", "What", "changed?"]);
    } finally {
      consoleLog.mockRestore();
    }

    expect(askIndexedDocumentsMock).toHaveBeenCalledOnce();
    expect(lines.join("\n")).toContain("Revenue decreased. [1]");
    expect(lines.join("\n")).toContain(
      "[1] text, pages 4, /tmp/contradicting-report.pdf",
    );
    expect(lines.join("\n")).not.toContain("/tmp/report.pdf");
  });
});

function buildValidatedCliAnswer() {
  const citation = {
    citationNumber: 1,
    documentId: "c".repeat(64),
    documentVersionId: "00000000-0000-4000-8000-000000000004",
    elementId: "d".repeat(64),
    evidence: {
      excerpt: "Revenue decreased during the reporting period.",
      kind: "text" as const,
    },
    id: "00000000-0000-4000-8000-000000000005",
    kind: "text" as const,
    pageNumbers: [4],
    regions: [],
    sectionPath: [],
    sourceFile: "/tmp/contradicting-report.pdf",
  };
  return {
    answer: "Revenue decreased. [1]",
    answerDocument: {
      citations: [citation],
      schemaVersion: 1 as const,
      statements: [{
        citationIds: [citation.id],
        content: "Revenue decreased.",
        presentation: "paragraph" as const,
        section: "answer" as const,
      }],
      status: "answered" as const,
    },
    matchedDocuments: [{
      documentId: "c".repeat(64),
      retrievedElementCount: 1,
      sourceFile: "/tmp/contradicting-report.pdf",
    }],
    runDetails: {
      durationMs: 1,
      finishReason: "stop",
      inputTokens: 1,
      modelId: "answer-model",
      outputTokens: 1,
      runId: null,
    },
    sources: [citation],
  };
}
