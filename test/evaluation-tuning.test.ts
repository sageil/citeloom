import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { AppConfig } from "../src/config/index.js";
import {
  calculateJsonSha256,
  decodeEvaluationPreparationArtifact,
  type EvaluationPreparationArtifact,
} from "../tools/evaluation/artifact.js";
import { createEvaluationConfigurationFreeze } from "../tools/evaluation/freeze.js";
import {
  applyEvaluationTuningSelection,
  decodeEvaluationTuningSelection,
  decodeEvaluationTuningSpecification,
  readEvaluationTuningSelection,
  runEvaluationTuning,
  writeEvaluationTuningSelection,
  type EvaluationTuningSpecification,
} from "../tools/evaluation/tuning.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";
import { buildExactCandidateRepresentation } from "./source-element-fixture.js";

describe("development retrieval tuning", () => {
  it("searches every declared dimension and selects a constrained winner", () => {
    const config = buildConfig();
    const preparations = buildPreparations(config);
    const specification = buildSpecification();
    const before = calculateJsonSha256(preparations);

    const run = runEvaluationTuning(
      config,
      "commit:working-tree",
      7,
      preparations,
      specification,
    );

    expect(calculateJsonSha256(preparations)).toBe(before);
    expect(run.selection.candidateAssessments).toHaveLength(384);
    const searchedConfigurations = run.selection.candidateAssessments.map(
      (assessment) => assessment.configuration,
    );
    expect(new Set(searchedConfigurations.map((entry) => entry.fusion.denseWeight)))
      .toEqual(new Set([1, 2]));
    expect(new Set(searchedConfigurations.map((entry) => entry.fusion.lexicalWeight)))
      .toEqual(new Set([1, 2]));
    expect(new Set(searchedConfigurations.map((entry) => (
      entry.fusion.originalQueryWeight
    )))).toEqual(new Set([1, 2]));
    expect(new Set(searchedConfigurations.map((entry) => (
      entry.fusion.expansionQueryWeight
    )))).toEqual(new Set([1, 2]));
    expect(new Set(searchedConfigurations.map((entry) => entry.fusion.expansionDecay)))
      .toEqual(new Set([0.5, 1]));
    expect(new Set(searchedConfigurations.map((entry) => entry.queryExpansions)))
      .toEqual(new Set([0, 1, 2]));
    expect(new Set(searchedConfigurations.map((entry) => entry.rrfK)))
      .toEqual(new Set([1, 60]));
    expect(new Set(searchedConfigurations.map((entry) => (
      entry.rerankerCandidateDepth
    )))).toEqual(new Set([1, 2]));
    expect(run.selection.selected.configuration).toMatchObject({
      queryExpansions: 0,
      rerankerCandidateDepth: 2,
    });
    expect(run.selection.selected.metrics.domainMacroMeanNdcg).toBe(1);
    expect(run.selection.selected.objectiveImprovement).toBe(0.5);
    expect(run.selection.selected.metrics.estimatedP95LatencyMs).toBe(30);
    expect(run.selection.ablations.map((entry) => entry.mode)).toEqual([
      "bm25",
      "dense",
      "hybrid",
      "hybrid-reranked",
    ]);
    expect(run.selection.ablations.map((entry) => (
      entry.metrics.domainMacroMeanNdcg
    ))).toEqual([0.5, 0.5, 0.5, 1]);
    expect(run.freeze.payload.retrieval).toMatchObject({
      candidateK: 2,
      queryExpansions: 0,
    });

    const twoExpansionAssessment = run.selection.candidateAssessments.find(
      (assessment) => {
        const candidate = assessment.configuration;
        return candidate.fusion.denseWeight === 1
          && candidate.fusion.lexicalWeight === 1
          && candidate.fusion.originalQueryWeight === 1
          && candidate.fusion.expansionQueryWeight === 1
          && candidate.fusion.expansionDecay === 1
          && candidate.queryExpansions === 2
          && candidate.rerankerCandidateDepth === 2
          && candidate.rrfK === 60;
      },
    );
    expect(twoExpansionAssessment?.metrics.estimatedP95LatencyMs).toBe(60);
  });

  it("reports objective and per-domain rejection reasons for every candidate", () => {
    const config = buildConfig();
    const run = runEvaluationTuning(
      config,
      "commit:working-tree",
      7,
      buildPreparations(config),
      buildSpecification(),
    );
    const regressing = run.selection.candidateAssessments.find((assessment) => {
      const candidate = assessment.configuration;
      return candidate.fusion.denseWeight === 1
        && candidate.fusion.lexicalWeight === 2
        && candidate.fusion.originalQueryWeight === 1
        && candidate.fusion.expansionQueryWeight === 1
        && candidate.fusion.expansionDecay === 0.5
        && candidate.queryExpansions === 0
        && candidate.rerankerCandidateDepth === 1
        && candidate.rrfK === 1;
    });

    expect(regressing).toBeDefined();
    expect(regressing?.eligible).toBe(false);
    expect(regressing?.rejectionReasons).toContain("objective-not-improved");
    expect(regressing?.rejectionReasons).toContain("domain-regression-limit");
    expect(regressing?.domainRegressions).toEqual([
      { domain: "legal", ndcgRegression: 1 },
      { domain: "veterinary", ndcgRegression: -1 },
    ]);
  });

  it("fails without persisting a winner when latency limits reject improvements", () => {
    const config = buildConfig();
    const specification = buildSpecification();
    specification.constraints.maximumEstimatedP95LatencyMs = 29;

    expect(() => runEvaluationTuning(
      config,
      "commit:working-tree",
      7,
      buildPreparations(config),
      specification,
    )).toThrow("found no configuration");
  });

  it("enforces the p95 latency regression limit independently", () => {
    const config = buildConfig();
    const specification = buildSpecification();
    specification.constraints.maximumEstimatedP95LatencyRegressionMs = 5;

    expect(() => runEvaluationTuning(
      config,
      "commit:working-tree",
      7,
      buildPreparations(config),
      specification,
    )).toThrow("found no configuration");
  });

  it("rejects batched embedding telemetry that omits a fixed query variant", () => {
    const config = buildConfig();
    const preparations = buildPreparations(config);
    const firstPreparation = preparations[0];
    const firstTrace = firstPreparation?.telemetry[0]?.trace;
    const embeddingStage = firstTrace?.stages.find((candidate) => (
      candidate.name === "query-embedding"
    ));
    if (embeddingStage === undefined) {
      throw new Error("Missing test query-embedding stage.");
    }
    embeddingStage.inputCount = 2;

    expect(() => runEvaluationTuning(
      config,
      "commit:working-tree",
      7,
      preparations,
      buildSpecification(),
    )).toThrow("does not contain the selected fixed query variants");
  });

  it("rejects regression and sealed data before search", () => {
    const config = buildConfig();
    const preparations = buildPreparations(config);
    const regression = structuredClone(preparations[0]);
    if (regression === undefined) {
      throw new Error("Missing test preparation.");
    }
    regression.provenance.dataset.access = "regression";
    regression.provenance.dataset.split = "holdout";

    expect(() => runEvaluationTuning(
      config,
      "commit:working-tree",
      7,
      [regression],
      buildSpecification(),
    )).toThrow("accepts development data only");

    const sealed = structuredClone(regression);
    sealed.provenance.dataset.access = "sealed";
    expect(() => runEvaluationTuning(
      config,
      "commit:working-tree",
      7,
      [sealed],
      buildSpecification(),
    )).toThrow("accepts development data only");
  });

  it("requires at least two development domains", () => {
    const config = buildConfig();
    const legal = buildPreparations(config)[0];
    if (legal === undefined) {
      throw new Error("Missing legal preparation.");
    }
    expect(() => runEvaluationTuning(
      config,
      "commit:working-tree",
      7,
      [legal],
      buildSpecification(),
    )).toThrow("at least two development domains");
  });

  it("requires an explicit search over zero, one, and two expansions", () => {
    const candidate = structuredClone(buildSpecification());
    candidate.searchSpace.expansionCounts = [0, 1, 1];
    expect(() => decodeEvaluationTuningSpecification(
      candidate,
      "test specification",
    )).toThrow("exactly 0, 1, and 2");

    const withUnknownField = {
      ...buildSpecification(),
      implicitDefault: true,
    };
    expect(() => decodeEvaluationTuningSpecification(
      withUnknownField,
      "test specification",
    )).toThrow("Unrecognized key");
  });

  it("binds the persisted selection to the selected freeze", () => {
    const config = buildConfig();
    const run = runEvaluationTuning(
      config,
      "commit:working-tree",
      7,
      buildPreparations(config),
      buildSpecification(),
    );

    const selectedConfig = applyEvaluationTuningSelection(
      config,
      "commit:working-tree",
      7,
      run.selection,
      run.freeze,
    );
    expect(selectedConfig.retrieval.candidateK).toBe(2);
    expect(selectedConfig.retrieval.mode).toBe("hybrid-reranked");

    const changed = structuredClone(run.selection);
    const selectedIndex = changed.candidateAssessments.findIndex((entry) => (
      JSON.stringify(entry) === JSON.stringify(changed.selected)
    ));
    if (selectedIndex < 0) {
      throw new Error("Missing selected candidate assessment.");
    }
    changed.selected.configuration.rrfK += 1;
    const changedAssessment = changed.candidateAssessments[selectedIndex];
    if (changedAssessment === undefined) {
      throw new Error("Missing changed candidate assessment.");
    }
    changedAssessment.configuration.rrfK += 1;
    expect(() => decodeEvaluationTuningSelection(
      changed,
      "changed selection",
    )).toThrow("fingerprint does not match");
  });

  it("persists a strict selection without overwriting an existing result", async () => {
    const config = buildConfig();
    const run = runEvaluationTuning(
      config,
      "commit:working-tree",
      7,
      buildPreparations(config),
      buildSpecification(),
    );
    const directory = await mkdtemp(join(tmpdir(), "citeloom-tuning-"));
    const outputPath = join(directory, "selection.json");
    try {
      await writeEvaluationTuningSelection(outputPath, run.selection);
      expect(await readEvaluationTuningSelection(outputPath)).toEqual(
        run.selection,
      );
      await expect(writeEvaluationTuningSelection(outputPath, run.selection))
        .rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

function buildConfig(): AppConfig {
  const config = readEqualWeightTestConfig({
    providerOptions: {
      rerankBaseUrl: "http://localhost:9000/v1",
      rerankEnabled: true,
    },
  });
  return {
    ...config,
    settingsVersion: 7,
    retrieval: {
      ...config.retrieval,
      candidateK: 2,
      mode: "hybrid-reranked",
      queryExpansions: 2,
      topK: 1,
    },
  };
}

function buildSpecification(): EvaluationTuningSpecification {
  return decodeEvaluationTuningSpecification({
    constraints: {
      maximumDomainNdcgRegression: 0,
      maximumEstimatedP95LatencyMs: 100,
      maximumEstimatedP95LatencyRegressionMs: 50,
    },
    objective: {
      metric: "domain-macro-mean-ndcg",
      minimumImprovement: 0.1,
    },
    referenceConfiguration: {
      fusion: {
        denseWeight: 1,
        expansionDecay: 1,
        expansionQueryWeight: 1,
        lexicalWeight: 1,
        originalQueryWeight: 1,
      },
      queryExpansions: 0,
      rerankerCandidateDepth: 1,
      rrfK: 60,
    },
    searchSpace: {
      denseWeights: [1, 2],
      expansionCounts: [0, 1, 2],
      expansionDecays: [0.5, 1],
      expansionWeights: [1, 2],
      lexicalWeights: [1, 2],
      originalQuestionWeights: [1, 2],
      rerankerCandidateDepths: [1, 2],
      rrfConstants: [1, 60],
    },
    version: 1,
  }, "test specification");
}

function buildPreparations(config: AppConfig): EvaluationPreparationArtifact[] {
  return [
    buildPreparation(config, "legal", "c"),
    buildPreparation(config, "veterinary", "d"),
  ];
}

function buildPreparation(
  config: AppConfig,
  domain: "legal" | "veterinary",
  datasetHashCharacter: string,
): EvaluationPreparationArtifact {
  const freeze = createEvaluationConfigurationFreeze(
    config,
    "commit:working-tree",
    7,
  );
  const documentIds = [id("1"), id("2")];
  const first = buildCandidate("a", "1", 0.1, 9);
  const second = buildCandidate("b", "2", 0.2, 10);
  const dense = [first.dense, second.dense];
  const lexical = [second.lexical, first.lexical];
  const relevantElementId = domain === "legal" ? id("a") : id("b");
  const candidateRankings = {
    dense: [structuredClone(dense), structuredClone(dense), structuredClone(dense)],
    lexical: [
      structuredClone(lexical),
      structuredClone(lexical),
      structuredClone(lexical),
    ],
  };
  const caseId = `${domain}-case`;
  const candidateSelection = buildCandidateSelection(first, second);
  const rerankerScores = buildRerankerScores(domain, first, second);
  return decodeEvaluationPreparationArtifact({
    cases: [{
      candidateRankings,
      candidateSelection,
      domain,
      id: caseId,
      judgments: [{
        provenance: { kind: "pooled", methods: ["hybrid-reranked"] },
        relevance: "direct",
        review: {
          auditStatus: "accepted",
          rationale: "The selected element directly answers the test question.",
          reviewedAt: "2026-07-15T12:00:00.000Z",
          reviewer: { id: "reviewer-1", kind: "human" },
        },
        target: { id: relevantElementId, kind: "element" },
      }],
      metadata: {
        language: "en",
        questionType: "factoid",
        source: { kind: "text" },
      },
      queries: [
        { embeddingSha256: calculateJsonSha256([1]), text: `${domain} question` },
        { embeddingSha256: calculateJsonSha256([2]), text: `${domain} expansion one` },
        { embeddingSha256: calculateJsonSha256([3]), text: `${domain} expansion two` },
      ],
      queryGenerationSeed: 1,
      question: `${domain} question`,
      relevantDocumentIds: [],
      relevantElementIds: [relevantElementId],
      rerankerScores,
      tuningRerankerScores: rerankerScores,
    }],
    provenance: {
      codeRevision: "commit:working-tree",
      corpus: {
        documentIds,
        sha256: calculateJsonSha256(documentIds),
      },
      dataset: {
        access: "development",
        atK: 1,
        configurationFreezeSha256: null,
        name: `${domain}-development`,
        sha256: datasetHashCharacter.repeat(64),
        split: "development",
        statisticalDesign: {
          alpha: 0.05,
          alternative: "two-sided",
          assumedPairedNdcgDeltaStandardDeviation: 0.1,
          method: "normal-approximation-paired-mean",
          minimumDetectableNdcgDelta: 1,
          power: 0.8,
          requiredCaseCount: 1,
        },
      },
      embeddingSpace: freeze.payload.embeddingSpace,
      hnsw: freeze.payload.hnsw,
      models: freeze.payload.models,
      retrieval: {
        candidateK: 2,
        channelOrderingPolicy: "channel-score-then-retrieval-id-v1",
        fusion: { ...config.retrieval.fusion },
        queryExpansions: 2,
        rrfK: config.retrieval.rrfK,
        topK: 1,
        variantConcurrency: config.retrieval.variantConcurrency,
      },
      settingsVersion: 7,
    },
    skippedModes: [],
    telemetry: [{ caseId, trace: buildTrace(domain) }],
    version: 10,
  }, `${domain} tuning preparation`);
}

function buildCandidateSelection(
  first: ReturnType<typeof buildCandidate>,
  second: ReturnType<typeof buildCandidate>,
) {
  const candidates = [first.dense, second.dense];
  const decisions = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) {
      continue;
    }
    decisions.push({
      admissionRank: index + 1,
      documentId: candidate.documentId,
      elementId: candidate.elementId,
      exclusionReason: null,
      fusedRank: index + 1,
      representativeRetrievalWindowId: candidate.evidenceRetrievalId,
      retrievalId: candidate.evidenceRetrievalId,
      sourceFile: candidate.sourceFile,
    });
  }
  return {
    allocationPolicy: "document-round-robin" as const,
    candidateK: 2,
    decisions,
    rerankerInputRetrievalIds: candidates.map((candidate) => (
      candidate.evidenceRetrievalId
    )),
  };
}

function buildRerankerScores(
  domain: "legal" | "veterinary",
  first: ReturnType<typeof buildCandidate>,
  second: ReturnType<typeof buildCandidate>,
) {
  const firstScore = domain === "legal" ? 2 : 1;
  const secondScore = domain === "legal" ? 1 : 2;
  return [
    {
      documentId: first.dense.documentId,
      documentVersionId: "00000000-0000-4000-8000-000000000001",
      elementId: first.dense.elementId,
      relevanceScore: firstScore,
      retrievalId: first.dense.evidenceRetrievalId,
      scoringBatchIndex: 1,
      scoringBatchRank: 1,
      sourceFile: first.dense.sourceFile,
    },
    {
      documentId: second.dense.documentId,
      documentVersionId: "00000000-0000-4000-8000-000000000002",
      elementId: second.dense.elementId,
      relevanceScore: secondScore,
      retrievalId: second.dense.evidenceRetrievalId,
      scoringBatchIndex: 1,
      scoringBatchRank: 2,
      sourceFile: second.dense.sourceFile,
    },
  ];
}

function buildCandidate(
  elementCharacter: string,
  documentCharacter: string,
  distance: number,
  bm25Score: number,
) {
  const evidenceRetrievalId = id(elementCharacter);
  const evidenceContent = `Summary ${elementCharacter}`;
  const shared = {
    documentId: id(documentCharacter),
    evidenceContent,
    evidenceRetrievalId,
    elementId: id(elementCharacter),
    representation: buildExactCandidateRepresentation(
      evidenceRetrievalId,
      evidenceContent,
    ),
    sourceFile: `/documents/${documentCharacter}.pdf`,
  };
  return {
    dense: { ...shared, distance },
    lexical: { ...shared, bm25Score },
  };
}

function buildTrace(domain: string) {
  const stages = [];
  stages.push(stage("query-expansion", 15, 0, 1, 2));
  stages.push(stage("query-embedding", 15, stages.length, 3, 3));
  for (let index = 0; index < 3; index += 1) {
    stages.push(stage("dense-retrieval", 5, stages.length, 2));
  }
  for (let index = 0; index < 3; index += 1) {
    stages.push(stage("lexical-retrieval", 5, stages.length, 2));
  }
  stages.push(stage("hydration", 10, stages.length, 2));
  stages.push(stage("reranking", 10, stages.length, 2));
  return {
    durationMs: 75,
    fallbackCount: 0,
    outcome: "success" as const,
    runId: domain === "legal"
      ? "11111111-1111-4111-8111-111111111111"
      : "22222222-2222-4222-8222-222222222222",
    stages,
    streamDurationMs: null,
    timeToFirstTokenMs: null,
  };
}

function stage(
  name:
    | "dense-retrieval"
    | "hydration"
    | "lexical-retrieval"
    | "query-embedding"
    | "query-expansion"
    | "reranking",
  durationMs: number,
  sequence: number,
  inputCount: number,
  outputCount: number = inputCount,
) {
  return {
    durationMs,
    inputCount,
    inputTokens: null,
    modelId: null,
    name,
    outcome: "success" as const,
    outputCount,
    outputTokens: null,
    provider: null,
    providerDurationMs: null,
    retrievalMode: null,
    schedulerWaitMs: null,
    sequence,
  };
}

function id(character: string): string {
  return character.repeat(64);
}
