import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted((): string[] => []);
const askIndexedDocumentsMock = vi.hoisted(() => vi.fn());
const readHostRecoveryStatusMock = vi.hoisted(() => vi.fn());
const recoverLocalAuthenticationMock = vi.hoisted(() => vi.fn());

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
  readDatabaseConfig: (): object => {
    events.push("database-config-read");
    return {};
  },
  readStartupConfig: (): { database: object } => {
    events.push("startup-config-read");
    return {
      database: {},
    };
  },
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

vi.mock("../src/oauth/application-store.js", () => ({
  OAuthApplicationStore: class {
    public readHostRecoveryStatus = readHostRecoveryStatusMock;
    public recoverLocalAuthentication = recoverLocalAuthenticationMock;
  },
}));

import { main } from "../src/cli/command-runner.js";

describe("CLI database session lifetime", () => {
  beforeEach(() => {
    events.length = 0;
    askIndexedDocumentsMock.mockReset();
    askIndexedDocumentsMock.mockResolvedValue(buildValidatedCliAnswer());
    readHostRecoveryStatusMock.mockReset();
    readHostRecoveryStatusMock.mockResolvedValue({
      changed: false,
      hostRecoveryEnabled: true,
      mode: "oauth",
      version: 4,
    });
    recoverLocalAuthenticationMock.mockReset();
    recoverLocalAuthenticationMock.mockResolvedValue({
      changed: true,
      hostRecoveryEnabled: true,
      mode: "local",
      version: 5,
    });
  });

  it("waits for application settings before closing the database session", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await main(["status"]);
    } finally {
      consoleLog.mockRestore();
    }

    expect(events).toEqual([
      "startup-config-read",
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

  it("runs host recovery using only startup database configuration", async () => {
    const lines: string[] = [];
    const consoleLog = vi.spyOn(console, "log").mockImplementation((...values) => {
      lines.push(values.join(" "));
    });
    try {
      await main(["auth", "recover-local"]);
    } finally {
      consoleLog.mockRestore();
    }

    expect(events).toEqual(["database-config-read", "database-closed"]);
    expect(readHostRecoveryStatusMock).toHaveBeenCalledOnce();
    expect(recoverLocalAuthenticationMock).not.toHaveBeenCalled();
    expect(lines).toContain("Authentication mode: oauth");
    expect(lines.at(-1)).toContain("Run with --apply");
  });

  it("applies host recovery through the same database-only path", async () => {
    const lines: string[] = [];
    const consoleLog = vi.spyOn(console, "log").mockImplementation((...values) => {
      lines.push(values.join(" "));
    });
    try {
      await main(["auth", "recover-local", "--apply"]);
    } finally {
      consoleLog.mockRestore();
    }

    expect(events).toEqual(["database-config-read", "database-closed"]);
    expect(recoverLocalAuthenticationMock).toHaveBeenCalledOnce();
    expect(readHostRecoveryStatusMock).not.toHaveBeenCalled();
    expect(lines.at(-1)).toContain("Users can now sign in");
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
