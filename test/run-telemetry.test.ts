import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createTelemetryStageResult,
  startRunTelemetry,
  type RunTelemetrySink,
  type TelemetryRunCompletionRecord,
  type TelemetryRunStartRecord,
  type TelemetryStageRecord,
} from "../src/observability/run.js";
import {
  decodeTelemetryStageSamples,
  summarizeTelemetry,
  type TelemetryRunSample,
  type TelemetrySchedulingSample,
  type TelemetryStageSample,
} from "../src/observability/store.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("run telemetry", () => {
  it("decodes persisted claim-verification stages for the dashboard", () => {
    const stages = decodeTelemetryStageSamples([{
      durationMs: 83_402,
      modelId: "gemma4:26b:claim-verifier",
      name: "claim-verification",
      outcome: "error",
      provider: "citeloomInference.chat",
      providerDurationMs: 83_400,
      schedulerWaitMs: 2,
    }]);

    expect(stages).toEqual([{
      durationMs: 83_402,
      modelId: "gemma4:26b:claim-verifier",
      name: "claim-verification",
      outcome: "error",
      provider: "citeloomInference.chat",
      providerDurationMs: 83_400,
      schedulerWaitMs: 2,
    }]);
  });

  it("persists one privacy-safe trace with scheduler and provider timing", async () => {
    const now = vi.spyOn(performance, "now");
    for (const value of [0, 10, 20, 70, 80, 90, 120, 160, 200]) {
      now.mockReturnValueOnce(value);
    }
    const config = buildConfig();
    const sink = new RecordingTelemetrySink();
    const telemetry = await startRunTelemetry(
      config,
      "answer",
      sink,
    );
    telemetry.setScopeSize(12);
    telemetry.setQueryVariantCount(3);
    telemetry.setCandidateCount(50);
    telemetry.setHydratedContextCount(10);
    telemetry.recordRerankerRankingScore("reranker-model", 0.01);
    telemetry.recordAnswerBudget({
      availableInputTokens: 12_000,
      contextCapacityTokens: 16_384,
      failureReason: null,
      inputTokenUpperBound: 3_000,
      outputBudgetTokens: 1_384,
      providerSafetyMarginTokens: 2_000,
      requests: [],
      responseDiagnostics: [],
      windows: [{
        evidenceSha256: "f".repeat(64),
        elementId: "b".repeat(64),
        reason: "included",
        retrievalRank: 1,
        retrievalWindowId: "c".repeat(64),
        tokenUpperBound: 500,
      }],
    });
    telemetry.recordAnswerRequest({
      evidence: [{
        evidenceSha256: "f".repeat(64),
        elementId: "b".repeat(64),
        retrievalWindowId: "c".repeat(64),
      }],
      phase: "initial",
    });
    telemetry.recordAnswerRequest({
      evidence: [{
        evidenceSha256: "9".repeat(64),
        elementId: "c".repeat(64),
        retrievalWindowId: "d".repeat(64),
      }],
      phase: "correction",
    });
    telemetry.recordAnswerResponseDiagnostic({
      correctionOutcome: "succeeded",
      failureCategory: "unknown-evidence-reference",
      invalidFieldPaths: ["statements[0].evidenceRefs[0]"],
      modelId: "answer-model",
      phase: "initial",
      provider: "local-runtime",
      responseSha256: "8".repeat(64),
      unknownReferenceCount: 1,
    });
    telemetry.recordAnswerResponseDiagnostic({
      correctionOutcome: "succeeded",
      failureCategory: null,
      invalidFieldPaths: [],
      modelId: "answer-model",
      phase: "correction",
      provider: "local-runtime",
      responseSha256: "7".repeat(64),
      unknownReferenceCount: 0,
    });
    telemetry.recordContextSelection({
      candidateBudget: {
        allocationPolicy: "document-round-robin",
        admittedCandidates: [{
          admissionRank: 1,
          documentId: "a".repeat(64),
          fusedRank: 2,
          highestFusedRankForParent: 2,
          hydrated: true,
          isParentRepresentative: true,
          parentElementId: "b".repeat(64),
          representationHits: [buildRepresentationHit()],
          rerankerInputRank: 1,
          retrievalWindowId: "c".repeat(64),
          sourceFile: "/documents/source.pdf",
          descriptionAffected: true,
        }],
        admittedDistinctParentCount: 1,
        admittedWindowCount: 1,
        candidateK: 1,
        fusedCandidates: [{
          admissionRank: 1,
          documentId: "a".repeat(64),
          exclusionReason: null,
          fusedRank: 2,
          fusion: {
            bm25Score: 2.5,
            denseDistance: 0.2,
            fusedScore: 0.04,
          },
          parentElementId: "b".repeat(64),
          representationHits: [buildRepresentationHit()],
          representativeRetrievalWindowId: "c".repeat(64),
          retrievalWindowId: "c".repeat(64),
          sourceFile: "/documents/source.pdf",
          descriptionAffected: true,
        }],
        fusedDistinctParentCount: 2,
        fusedWindowCount: 3,
        hydratedDistinctParentCount: 1,
        hydratedWindowCount: 1,
        queries: [{
          channels: [{
            candidateLimit: 1,
            candidates: [{
              channelRank: 1,
              documentId: "a".repeat(64),
              fusionInputPosition: 1,
              limitDecision: "admitted",
              parentElementId: "b".repeat(64),
              representationId: `${"b".repeat(64)}-description`,
              representationType: "table-description",
              retrievalWindowId: "c".repeat(64),
              score: 0.2,
              sourceFile: "/documents/source.pdf",
            }],
            channel: "dense",
            orderingPolicy: "channel-score-then-retrieval-id-v1",
            scoreDirection: "ascending",
            scoreKind: "cosine-distance",
          }],
          denseDistinctParentCount: 2,
          denseWindowCount: 3,
          embeddingSha256: "e".repeat(64),
          lexicalDistinctParentCount: 1,
          lexicalWindowCount: 1,
          queryFingerprintSha256: "d".repeat(64),
          queryIndex: 0,
          queryKind: "original",
        }],
        retrievalWindowPolicy: config.embeddingSpace.retrievalWindow,
      },
      candidates: [{
        documentId: "a".repeat(64),
        documentVersionId: "00000000-0000-4000-8000-000000000001",
        evidenceSha256: "f".repeat(64),
        finalContextRank: 1,
        fusedRank: 2,
        fusion: { bm25Score: 2.5, denseDistance: 0.2, fusedScore: 0.04 },
        parentElementId: "b".repeat(64),
        rerankerInputRank: 1,
        reason: "relevance-cliff",
        representationHits: [buildRepresentationHit()],
        rerankerRank: 1,
        rerankerScore: 0.91,
        retrievalWindowId: "c".repeat(64),
        selected: true,
        sourceFile: "/documents/source.pdf",
        descriptionAffected: true,
      }],
      configuration: {
        maximumContextSize: 10,
        minimumLogGapMedianMultiplier: 3,
        minimumScoreRatio: 3,
      },
      cutoff: {
        rank: 1,
        reason: "relevance-cliff",
      },
      policy: "relative-relevance-cliff-v2",
      recovery: { attempted: false, result: "not-applicable" },
    });
    const stage = telemetry.startStage({
      model: { modelId: "answer-model", provider: "local-runtime" },
      name: "answer",
      retrievalMode: "hybrid-reranked",
    });

    stage.timingObserver.started();
    stage.timingObserver.completed();
    await stage.finish(createTelemetryStageResult("success", {
      inputCount: 10,
      inputTokens: 120,
      outputCount: 2,
      outputTokens: 30,
    }));
    telemetry.markStreamStarted();
    telemetry.markFirstToken();
    telemetry.markStreamCompleted();
    const snapshot = await telemetry.finish("success");

    expect(sink.starts).toHaveLength(1);
    expect(sink.stages).toHaveLength(1);
    expect(sink.completions).toHaveLength(1);
    expect(sink.stages[0]).toMatchObject({
      durationMs: 70,
      inputTokens: 120,
      modelId: "answer-model",
      outputTokens: 30,
      providerDurationMs: 50,
      schedulerWaitMs: 10,
    });
    expect(sink.completions[0]).toMatchObject({
      answerBudget: {
        contextCapacityTokens: 16_384,
        outputBudgetTokens: 1_384,
        requests: [{
          evidence: [{
            evidenceSha256: "f".repeat(64),
            elementId: "b".repeat(64),
            retrievalWindowId: "c".repeat(64),
          }],
          phase: "initial",
        }, {
          evidence: [{
            evidenceSha256: "9".repeat(64),
            elementId: "c".repeat(64),
            retrievalWindowId: "d".repeat(64),
          }],
          phase: "correction",
        }],
        responseDiagnostics: [{
          correctionOutcome: "succeeded",
          failureCategory: "unknown-evidence-reference",
          invalidFieldPaths: ["statements[0].evidenceRefs[0]"],
          modelId: "answer-model",
          phase: "initial",
          provider: "local-runtime",
          responseSha256: "8".repeat(64),
          unknownReferenceCount: 1,
        }, {
          correctionOutcome: "succeeded",
          failureCategory: null,
          invalidFieldPaths: [],
          modelId: "answer-model",
          phase: "correction",
          provider: "local-runtime",
          responseSha256: "7".repeat(64),
          unknownReferenceCount: 0,
        }],
        windows: [{ reason: "included", retrievalRank: 1 }],
      },
      candidateCount: 50,
      contextSelection: {
        candidateBudget: {
          admittedCandidates: [{
            admissionRank: 1,
            retrievalWindowId: "c".repeat(64),
          }],
          admittedDistinctParentCount: 1,
          fusedDistinctParentCount: 2,
        },
        candidates: [{
          finalContextRank: 1,
          retrievalWindowId: "c".repeat(64),
          selected: true,
        }],
        policy: "relative-relevance-cliff-v2",
      },
      durationMs: 200,
      hydratedContextCount: 10,
      inputTokens: 120,
      outputTokens: 30,
      queryVariantCount: 3,
      rerankerRanking: {
        modelId: "reranker-model",
        outcome: "not-assessed",
        reason: "ranking-only",
        strongestScore: 0.01,
        threshold: null,
      },
      scopeSize: 12,
      streamDurationMs: 70,
      timeToFirstTokenMs: 120,
    });
    expect(snapshot).toMatchObject({
      durationMs: 200,
      streamDurationMs: 70,
      timeToFirstTokenMs: 120,
    });
    const persisted = JSON.stringify({
      completions: sink.completions,
      stages: sink.stages,
      starts: sink.starts,
    });
    expect(persisted).not.toContain("private question");
    expect(persisted).not.toContain("source content");
  });

  it("persists retrieval candidate provenance without requiring reranking", async () => {
    const config = buildConfig();
    const sink = new RecordingTelemetrySink();
    const telemetry = await startRunTelemetry(config, "search", sink);
    telemetry.recordCandidateBudget({
      allocationPolicy: "fused-order",
      admittedCandidates: [],
      admittedDistinctParentCount: 0,
      admittedWindowCount: 0,
      candidateK: 5,
      fusedCandidates: [],
      fusedDistinctParentCount: 0,
      fusedWindowCount: 0,
      hydratedDistinctParentCount: 0,
      hydratedWindowCount: 0,
      queries: [],
      retrievalWindowPolicy: config.embeddingSpace.retrievalWindow,
    });

    await telemetry.finish("success");

    expect(sink.completions[0]).toMatchObject({
      candidateBudget: {
        allocationPolicy: "fused-order",
        candidateK: 5,
        retrievalWindowPolicy: config.embeddingSpace.retrievalWindow,
      },
      contextSelection: null,
    });
  });

  it("reports latency percentiles and outcome rates by stage and model", () => {
    const runs: TelemetryRunSample[] = [
      buildRunSample(10, "success", 0),
      buildRunSample(20, "error", 0),
      buildRunSample(30, "abort", 1),
      buildRunSample(40, "success", 0),
    ];
    const stages: TelemetryStageSample[] = [
      buildStageSample(10, "success"),
      buildStageSample(20, "error"),
      buildStageSample(30, "abort"),
      buildStageSample(40, "fallback"),
    ];
    const scheduling: TelemetrySchedulingSample[] = [
      buildSchedulingSample(12, 100, "success"),
      buildSchedulingSample(4, 80, "abort"),
    ];

    const summary = summarizeTelemetry(
      runs,
      stages,
      new Date("2026-07-15T12:00:00.000Z"),
      scheduling,
    );

    expect(summary.requests[0]).toMatchObject({
      abortRate: 0.25,
      errorRate: 0.25,
      fallbackRate: 0.25,
      requestLatencyMs: { p50: 20, p95: 40, p99: 40 },
      sampleCount: 4,
    });
    expect(summary.stages[0]).toMatchObject({
      abortRate: 0.25,
      durationMs: { p50: 20, p95: 40, p99: 40 },
      errorRate: 0.25,
      fallbackRate: 0.25,
      modelId: "query-model",
      name: "query-embedding",
      providerDurationMs: { p50: 18, p95: 38, p99: 38 },
      schedulerWaitMs: { p50: 2, p95: 2, p99: 2 },
    });
    expect(summary.scheduling[0]).toEqual({
      abortRate: 0.5,
      errorRate: 0,
      executionDurationMs: { p50: 80, p95: 100, p99: 100 },
      queueWaitMs: { p50: 4, p95: 12, p99: 12 },
      resourceGroup: "shared-accelerator",
      sampleCount: 2,
      workload: "interactive-answer",
    });
  });
});

function buildRepresentationHit() {
  return {
    channel: "dense" as const,
    queryIndex: 0,
    rank: 1,
    representationId: `${"b".repeat(64)}-description`,
    representationType: "table-description" as const,
  };
}

class RecordingTelemetrySink implements RunTelemetrySink {
  public readonly completions: TelemetryRunCompletionRecord[] = [];
  public readonly stages: TelemetryStageRecord[] = [];
  public readonly starts: TelemetryRunStartRecord[] = [];

  public async startRun(record: TelemetryRunStartRecord): Promise<void> {
    this.starts.push(record);
  }

  public async recordStage(record: TelemetryStageRecord): Promise<void> {
    this.stages.push(record);
  }

  public async completeRun(
    record: TelemetryRunCompletionRecord,
  ): Promise<void> {
    this.completions.push(record);
  }
}

function buildConfig() {
  return readEqualWeightTestConfig({
    providerOptions: {
      rerankBaseUrl: "http://localhost:9000/v1",
      rerankEnabled: true,
    },
  });
}

function buildRunSample(
  durationMs: number,
  outcome: TelemetryRunSample["outcome"],
  fallbackCount: number,
): TelemetryRunSample {
  return {
    durationMs,
    fallbackCount,
    kind: "answer",
    outcome,
    streamDurationMs: durationMs - 2,
    timeToFirstTokenMs: durationMs - 5,
  };
}

function buildStageSample(
  durationMs: number,
  outcome: TelemetryStageSample["outcome"],
): TelemetryStageSample {
  return {
    durationMs,
    modelId: "query-model",
    name: "query-embedding",
    outcome,
    provider: "local-runtime",
    providerDurationMs: durationMs - 2,
    schedulerWaitMs: 2,
  };
}

function buildSchedulingSample(
  queueWaitMs: number,
  executionDurationMs: number,
  outcome: TelemetrySchedulingSample["outcome"],
): TelemetrySchedulingSample {
  return {
    executionDurationMs,
    outcome,
    queueWaitMs,
    resourceGroup: "shared-accelerator",
    workload: "interactive-answer",
  };
}
