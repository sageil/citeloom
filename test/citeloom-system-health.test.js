import { afterEach, describe, expect, it, vi } from "vitest";

import { readSystemHealthDashboard } from "../web/assets/scripts/dashboard-extensions.js";
import { registerPage } from "../web/assets/scripts/system-health.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("system health dashboard", () => {
  it("decodes telemetry and exposes correction prompt usage", () => {
    let pageFactory = null;
    registerPage({
      data(name, factory) {
        expect(name).toBe("citeloomSystemHealthPage");
        pageFactory = factory;
      },
    });
    expect(pageFactory).not.toBeNull();

    let snapshotListener = null;
    const windowMock = {
      addEventListener: vi.fn((name, listener) => {
        if (name === "citeloom:system-health-snapshot") {
          snapshotListener = listener;
        }
      }),
      dispatchEvent: vi.fn(),
      removeEventListener: vi.fn(),
    };
    class TestCustomEvent {
      constructor(type, options = {}) {
        this.detail = options.detail;
        this.type = type;
      }
    }
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    vi.stubGlobal("window", windowMock);

    const page = pageFactory();
    page.initialize();

    const dashboard = {
      embeddingSpace: { model: "snowflake-arctic-embed" },
      inferenceRuntime: {
        answerModel: "qwen3",
        claimVerifier: { model: "hhem" },
        queryExpansionModel: null,
        reranker: { model: "modernbert" },
        indexingModel: "qwen3",
      },
      telemetry: {
        corrections: [{
          count: 3,
          provider: "ollama",
          reason: "invalid-structure",
        }],
        enabled: true,
        generatedAt: "2026-08-04T20:00:00.000Z",
        requests: [{
          abortRate: 0.1,
          errorRate: 0.2,
          fallbackRate: 0.3,
          kind: "chat",
          requestLatencyMs: { p50: 200, p95: 1_500, p99: 2_000 },
          sampleCount: 10,
          streamDurationMs: { p50: null, p95: null, p99: null },
          timeToFirstTokenMs: { p50: 50, p95: 75, p99: 100 },
        }],
        scheduling: [{
          abortRate: 0,
          errorRate: 0.25,
          executionDurationMs: { p50: 80, p95: 100, p99: 120 },
          queueWaitMs: { p50: 2, p95: 4, p99: 6 },
          resourceGroup: "ollama",
          sampleCount: 4,
          workload: "interactive-answer",
        }],
        stages: [{
          abortRate: 0,
          durationMs: { p50: 100, p95: 200, p99: 300 },
          errorRate: 0,
          fallbackRate: 0.5,
          modelId: "qwen3",
          name: "answer-generation",
          provider: "ollama",
          providerDurationMs: { p50: 90, p95: 180, p99: 270 },
          sampleCount: 2,
          schedulerWaitMs: { p50: 10, p95: 20, p99: 30 },
        }],
        windowHours: 24,
      },
    };
    const system = {
      inference: [{
        activeSlots: 1,
        capacity: 2,
        name: "Ollama",
        providerId: "ollama",
      }],
      workers: [{ state: "idle" }, { state: "working" }],
    };
    const parsed = readSystemHealthDashboard(dashboard, system, [{}, {}]);

    expect(parsed).toMatchObject({
      models: {
        answer: "qwen3",
        claimVerifier: "hhem",
        embedding: "snowflake-arctic-embed",
        queryExpansion: "Disabled",
        reranker: "modernbert",
        indexing: "qwen3",
      },
      queueLength: 2,
      telemetry: {
        corrections: [{
          count: 3,
          provider: "ollama",
          reason: "invalid-structure",
        }],
      },
      workerCount: 2,
      workerState: "processing",
    });
    expect(parsed.telemetry.requests[0]).toMatchObject({
      label: "chat",
      model: "All models",
      p50: 200,
      p95: 1_500,
      p99: 2_000,
      samples: 10,
    });
    expect(parsed.telemetry.stages[0]).toMatchObject({
      label: "answer-generation",
      model: "ollama/qwen3",
      providerP95: 180,
      queueP95: 20,
    });
    expect(parsed.telemetry.scheduling[0]).toMatchObject({
      label: "interactive-answer",
      model: "ollama",
      providerP95: null,
      queueP95: 4,
    });

    snapshotListener({});
    expect(page.systemHealthHasData).toBe(false);
    snapshotListener(new TestCustomEvent(
      "citeloom:system-health-snapshot",
      { detail: parsed },
    ));
    expect(page.systemHealthHasData).toBe(true);
    expect(page.telemetryHasData).toBe(true);
    expect(page.telemetryTables).toHaveLength(2);
    expect(page.formatProviderLabel("ollama")).toBe("Ollama");
    expect(page.formatProviderLabel("openai-codex")).toBe("Openai codex");
    expect(page.formatSnapshotResourceLabel("document-conversion")).toBe(
      "Conversion",
    );
    expect(page.formatSnapshotResourceLabel("ollama")).toBe("Ollama");
    expect(page.formatCorrectionReason("invalid-structure")).toBe(
      "Invalid structure",
    );
    expect(page.formatTelemetryDuration(null)).toBe("-");
    expect(page.formatTelemetryDuration(250)).toBe("250 ms");
    expect(page.formatTelemetryDuration(1_500)).toBe("1.5 s");
    expect(page.formatTelemetryDuration(90_000)).toBe("90 s");
    expect(page.formatTelemetryRate(0.125)).toBe("12.5%");
    expect(page.providerIconHref("ollama")).toContain("citeloom-brain");
    expect(page.providerIconHref("openai")).toContain("citeloom-database");

    page.destroy();
    expect(windowMock.removeEventListener).toHaveBeenCalledWith(
      "citeloom:system-health-snapshot",
      snapshotListener,
    );
    expect(readSystemHealthDashboard({}, {}, [])).toBeNull();
  });
});
