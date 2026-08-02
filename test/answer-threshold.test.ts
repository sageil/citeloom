import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  decodeAnswerThresholdPreparation,
  selectAnswerThreshold,
  type AnswerThresholdPreparation,
  writeAnswerThresholdPreparation,
} from "../tools/evaluation/answer-threshold.js";
import { calculateJsonSha256 } from "../tools/evaluation/artifact.js";
import {
  createRetrievalWindowPolicy,
  createRetrievalWindowPolicyContract,
} from "../src/retrieval/window-policy.js";
import { TEST_PLAIN_EMBEDDING_INPUT_FORMAT } from "./config-fixture.js";

const supportingDocumentId = "a".repeat(64);
const remainingDocumentId = "b".repeat(64);
const negativeDocumentId = "c".repeat(64);

describe("answer threshold calibration", () => {
  it("selects the midpoint of the best-performing eligible interval", () => {
    const preparation = buildPreparation([
      { domain: "legal", id: "case-one", negative: 0.4, positive: 0.7 },
      { domain: "legal", id: "case-two", negative: 0.8, positive: 0.9 },
    ]);

    const selection = selectAnswerThreshold([preparation], 0.5);

    expect(selection.version).toBe(4);
    expect(selection.scoringConfiguration.retrieval.channelOrderingPolicy)
      .toBe("channel-score-then-retrieval-id-v1");
    expect(selection.selectedThreshold).toBeCloseTo(0.55);
    expect(selection.metrics.answerablePassRate).toMatchObject({
      count: 2,
      rate: 1,
      total: 2,
    });
    expect(selection.metrics.falseAcceptanceRate).toMatchObject({
      count: 1,
      rate: 0.5,
      total: 2,
    });
  });

  it("raises the threshold when the false-acceptance constraint is strict", () => {
    const preparation = buildPreparation([
      { domain: "legal", id: "case-one", negative: 0.4, positive: 0.7 },
      { domain: "legal", id: "case-two", negative: 0.8, positive: 0.9 },
    ]);

    const selection = selectAnswerThreshold([preparation], 0);

    expect(selection.selectedThreshold).toBeCloseTo(0.85);
    expect(selection.metrics.answerablePassRate.rate).toBe(0.5);
    expect(selection.metrics.falseAcceptanceRate.rate).toBe(0);
  });

  it("reports regression cases without using them to select the threshold", () => {
    const development = buildPreparation([
      { domain: "legal", id: "development-case", negative: 0.4, positive: 0.7 },
    ]);
    const regression = buildPreparation([
      { domain: "legal", id: "regression-case", negative: 0.95, positive: 0.96 },
    ], "regression");

    const selection = selectAnswerThreshold([development, regression], 0);

    expect(selection.selectedThreshold).toBeCloseTo(0.55);
    expect(selection.metrics.falseAcceptanceRate.rate).toBe(0);
    expect(selection.regressionMetrics?.falseAcceptanceRate.rate).toBe(1);
  });

  it("enforces the false-acceptance constraint within every domain", () => {
    const preparation = buildPreparation([
      { domain: "legal", id: "legal-case", negative: 0.8, positive: 0.9 },
      { domain: "veterinary", id: "veterinary-case", negative: 0.1, positive: 0.7 },
    ]);

    const selection = selectAnswerThreshold([preparation], 0.5);

    expect(selection.selectedThreshold).toBeCloseTo(0.85);
    expect(selection.metrics.falseAcceptanceRate.rate).toBe(0);
  });

  it("rejects a negative scope that retains supporting evidence", () => {
    const preparation = buildPreparation([
      { domain: "legal", id: "case-one", negative: 0.4, positive: 0.7 },
    ]);
    preparation.cases[0]?.negative.documentIds.push(supportingDocumentId);

    expect(() => decodeAnswerThresholdPreparation(preparation, "test"))
      .toThrow("negative scope must exclude every supporting document");
  });

  it("rejects preparations from different scoring configurations", () => {
    const first = buildPreparation([
      { domain: "legal", id: "case-one", negative: 0.4, positive: 0.7 },
    ]);
    const second = buildPreparation([
      { domain: "veterinary", id: "case-two", negative: 0.2, positive: 0.8 },
    ]);
    second.provenance.models.reranker = {
      modelId: "replacement-reranker",
      provider: "test-provider",
    };

    expect(() => selectAnswerThreshold([first, second], 0.1))
      .toThrow("different models or retrieval configurations");
  });

  it("publishes complete preparations without overwriting existing output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "citeloom-answer-threshold-"));
    const outputPath = join(directory, "preparation.json");
    const preparation = buildPreparation([
      { domain: "legal", id: "case-one", negative: 0.4, positive: 0.7 },
    ]);
    try {
      await writeAnswerThresholdPreparation(outputPath, preparation);
      const firstContent = await readFile(outputPath, "utf8");

      await expect(writeAnswerThresholdPreparation(outputPath, preparation))
        .rejects.toMatchObject({ code: "EEXIST" });

      expect(await readFile(outputPath, "utf8")).toBe(firstContent);
      expect(await readdir(directory)).toEqual(["preparation.json"]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

interface CaseScores {
  domain: string;
  id: string;
  negative: number | null;
  positive: number | null;
}

function buildPreparation(
  cases: CaseScores[],
  access: "development" | "regression" = "development",
): AnswerThresholdPreparation {
  const value = {
    cases: cases.map((entry, index) => ({
      domain: entry.domain,
      excludedDocumentIds: [supportingDocumentId],
      familyId: entry.id,
      negative: buildAssessment(entry.negative, index * 2 + 1, [negativeDocumentId]),
      positive: buildAssessment(
        entry.positive,
        index * 2,
        [supportingDocumentId, remainingDocumentId],
        true,
      ),
      question: `Question ${index + 1}?`,
    })),
    negativeCorpus: {
      documentIds: [negativeDocumentId],
      domain: "negative-domain",
      sha256: calculateJsonSha256({
        documentIds: [negativeDocumentId],
        domain: "negative-domain",
      }),
    },
    provenance: {
      codeRevision: "commit:test",
      corpus: {
        documentIds: [supportingDocumentId, remainingDocumentId],
        sha256: "c".repeat(64),
      },
      dataset: {
        access,
        atK: 10,
        configurationFreezeSha256: null,
        name: `calibration-${access}`,
        sha256: "d".repeat(64),
        split: access === "development" ? "development" : "holdout",
        statisticalDesign: {
          alpha: 0.05,
          alternative: "two-sided",
          assumedPairedNdcgDeltaStandardDeviation: 0.25,
          method: "normal-approximation-paired-mean",
          minimumDetectableNdcgDelta: 0.2,
          power: 0.8,
          requiredCaseCount: 13,
        },
      },
      embeddingSpace: {
        dimensions: 768,
        id: "embedding:test:768",
        inputFormat: TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
        model: "embedding-model",
        retrievalWindow: createRetrievalWindowPolicyContract(
          createRetrievalWindowPolicy("structured-token-v3", 512, 2_048),
        ),
      },
      hnsw: { efSearch: 100, iterativeScan: "strict_order" },
      models: {
        queryEmbedding: { modelId: "embedding-model", provider: "test-provider" },
        queryExpansion: { modelId: "summary-model", provider: "test-provider" },
        reranker: { modelId: "reranker-model", provider: "test-provider" },
      },
      retrieval: {
        candidateK: 50,
        channelOrderingPolicy: "channel-score-then-retrieval-id-v1",
        fusion: {
          denseWeight: 1,
          expansionDecay: 0.7,
          expansionQueryWeight: 1,
          lexicalWeight: 1,
          originalQueryWeight: 1,
        },
        queryExpansions: 2,
        rrfK: 60,
        topK: 10,
      },
      settingsVersion: 1,
    },
    version: 7 as const,
  };
  return decodeAnswerThresholdPreparation(value, "test fixture");
}

function buildAssessment(
  strongestScore: number | null,
  sequence: number,
  documentIds: string[],
  acceptedEvidenceRetrieved = false,
) {
  return {
    acceptedEvidenceRetrieved,
    candidateCount: 10,
    documentIds,
    strongestScore,
    trace: {
      durationMs: 10,
      fallbackCount: 0,
      outcome: "success" as const,
      runId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      stages: [],
      streamDurationMs: null,
      timeToFirstTokenMs: null,
    },
  };
}
