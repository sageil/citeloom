import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config/index.js";
import type {
  BenchmarkEvaluationDataset,
  EvaluationJudgment,
} from "../tools/evaluation/dataset.js";
import {
  assertEvaluationProvenanceMatches,
  calculateJsonSha256,
  decodeEvaluationPreparationArtifact,
  readEvaluationPreparationArtifact,
  type EvaluationPreparationArtifact,
  type EvaluationProvenance,
  writeEvaluationPreparationArtifact,
} from "../tools/evaluation/artifact.js";
import { createEvaluationConfigurationFreeze } from "../tools/evaluation/freeze.js";
import {
  assertEvaluationDatasetAccess,
  type EvaluationRerankingResult,
  type EvaluationPreparationExecutor,
  prepareComparativeEvaluation,
  prepareEvaluationCasesWithExecutor,
  type PreparedCaseInputs,
} from "../tools/evaluation/preparation.js";
import {
  assertEvaluationResultMatchesPreparation,
  derivePreparedEvaluationCandidates,
  scorePreparedEvaluation,
  serializeEvaluationResult,
  writeEvaluationResult,
} from "../tools/evaluation/index.js";
import type { FusedCandidate } from "../src/retrieval/ranking/rank-fusion.js";
import { selectRerankedContext } from "../src/retrieval/ranking/candidate-selection.js";
import type { RerankedRetrieval } from "../src/retrieval/ranking/reranker.js";
import {
  createRetrievalWindowPolicy,
  createRetrievalWindowPolicyContract,
} from "../src/retrieval/window-policy.js";
import {
  EQUAL_WEIGHT_FUSION_CONFIG,
  readEqualWeightTestConfig,
  TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
} from "./config-fixture.js";
import {
  buildExactCandidateRepresentation,
  buildRetrievedElementProvenance,
  buildSourceLocation,
} from "./source-element-fixture.js";

describe("comparative evaluation preparation", () => {
  it("prepares queries and modality rankings once before deriving every mode", async () => {
    const dataset = buildDataset();
    const provenance = buildProvenance(dataset);
    const config = buildConfig();
    const inputs = buildPreparedInputs();
    const prepareCase = vi.fn().mockResolvedValue(inputs);
    const rerank = vi.fn(async (
      _question: string,
      candidates: FusedCandidate[],
    ) => buildEvaluationRerankingResult(candidates));
    const executor: EvaluationPreparationExecutor = { prepareCase, rerank };

    const cases = await prepareEvaluationCasesWithExecutor(
      dataset,
      provenance,
      ["bm25", "dense", "hybrid", "hybrid-reranked"],
      config,
      executor,
      () => undefined,
    );

    expect(prepareCase).toHaveBeenCalledTimes(1);
    expect(rerank).toHaveBeenCalledTimes(1);
    expect(cases[0]?.queries.map((query) => query.text)).toEqual([
      "original question",
      "fixed expansion",
    ]);
    expect(provenance.retrieval.channelOrderingPolicy)
      .toBe("channel-score-then-retrieval-id-v1");
    expect(cases[0]?.candidateRankings.dense[0]?.map((entry) => entry.elementId))
      .toEqual([elementId("a"), elementId("b")]);
    expect(cases[0]?.candidateRankings.lexical[0]?.map((entry) => entry.elementId))
      .toEqual([elementId("c"), elementId("a")]);
    const preparedCase = cases[0];
    if (preparedCase === undefined) {
      throw new Error("Missing prepared case.");
    }
    expect(preparedCase.rerankerScores).toHaveLength(3);
    const modes = ["bm25", "dense", "hybrid", "hybrid-reranked"] as const;
    const derived = modes.map((mode) => derivePreparedEvaluationCandidates(
      preparedCase,
      mode,
      provenance.retrieval,
    ).map((entry) => entry.elementId));
    expect(derived).toEqual([
      [elementId("b"), elementId("c")],
      [elementId("a"), elementId("c")],
      [elementId("c"), elementId("a")],
      [elementId("c"), elementId("a")],
    ]);
  });

  it("preserves tied production channel order for database-free replay", async () => {
    const dataset = buildDataset();
    const provenance = buildProvenance(dataset);
    const config = buildConfig();
    const dense = [
      buildDenseCandidate("b", 0.1),
      buildDenseCandidate("a", 0.1),
    ];
    const lexical = [
      buildLexicalCandidate("c", 4),
      buildLexicalCandidate("a", 4),
    ];
    const inputs: PreparedCaseInputs = {
      queries: [
        { embedding: [1, 0], text: "original question" },
        { embedding: [0, 1], text: "fixed expansion" },
      ],
      rankings: {
        dense: [dense, dense],
        lexical: [lexical, lexical],
      },
    };
    const executor: EvaluationPreparationExecutor = {
      prepareCase: async () => inputs,
      rerank: async (_question, candidates) => (
        buildEvaluationRerankingResult(candidates)
      ),
    };

    const cases = await prepareEvaluationCasesWithExecutor(
      dataset,
      provenance,
      ["hybrid"],
      config,
      executor,
      () => undefined,
    );

    const preparedCase = cases[0];
    if (preparedCase === undefined) {
      throw new Error("Missing tied-order prepared case.");
    }
    expect(preparedCase.candidateRankings.dense.map((ranking) => (
      ranking.map((candidate) => candidate.representation.id)
    ))).toEqual([
      [elementId("b"), elementId("a")],
      [elementId("b"), elementId("a")],
    ]);
    expect(preparedCase.candidateRankings.lexical.map((ranking) => (
      ranking.map((candidate) => candidate.representation.id)
    ))).toEqual([
      [elementId("c"), elementId("a")],
      [elementId("c"), elementId("a")],
    ]);
    expect(derivePreparedEvaluationCandidates(
      preparedCase,
      "hybrid",
      provenance.retrieval,
    ).map((candidate) => candidate.elementId)).toEqual([
      elementId("a"),
      elementId("b"),
    ]);
  });

  it("accepts fewer generated queries than the configured maximum", async () => {
    const dataset = buildDataset();
    const provenance = buildProvenance(dataset);
    const config = buildConfig();
    const denseCandidate = buildDenseCandidate("a", 0.1);
    const lexicalCandidate = buildLexicalCandidate("c", 4);
    const inputs: PreparedCaseInputs = {
      queries: [{ embedding: [1, 0], text: "original question" }],
      rankings: {
        dense: [[denseCandidate]],
        lexical: [[lexicalCandidate]],
      },
    };
    const executor: EvaluationPreparationExecutor = {
      prepareCase: async () => inputs,
      rerank: async (_question, candidates) => (
        buildEvaluationRerankingResult(candidates)
      ),
    };

    const cases = await prepareEvaluationCasesWithExecutor(
      dataset,
      provenance,
      ["hybrid"],
      config,
      executor,
      () => undefined,
    );
    const preparedCase = cases[0];
    if (preparedCase === undefined) {
      throw new Error("Missing prepared case.");
    }
    const retrieved = derivePreparedEvaluationCandidates(
      preparedCase,
      "hybrid",
      provenance.retrieval,
    );

    expect(preparedCase.queries.map((query) => query.text)).toEqual([
      "original question",
    ]);
    expect(retrieved).toHaveLength(2);
  });

  it("keeps distinct prepared evidence from one canonical parent", async () => {
    const dataset = buildDataset();
    const provenance = buildProvenance(dataset);
    const config = buildConfig();
    const first = buildDenseCandidate("a", 0.1);
    const second = {
      ...buildDenseCandidate("a", 0.2),
      evidenceContent: "A distinct window from the same parent element.",
      evidenceRetrievalId: elementId("b"),
      representation: buildExactCandidateRepresentation(
        elementId("b"),
        "A distinct window from the same parent element.",
      ),
    };
    const inputs: PreparedCaseInputs = {
      queries: [
        { embedding: [1, 0], text: "original question" },
        { embedding: [0, 1], text: "fixed expansion" },
      ],
      rankings: {
        dense: [[first, second], [first, second]],
        lexical: [[], []],
      },
    };
    const executor: EvaluationPreparationExecutor = {
      prepareCase: async () => inputs,
      rerank: async (_question, candidates) => (
        buildEvaluationRerankingResult(candidates)
      ),
    };

    const cases = await prepareEvaluationCasesWithExecutor(
      dataset,
      provenance,
      ["hybrid-reranked"],
      config,
      executor,
      () => undefined,
    );

    expect(
      cases[0]?.candidateSelection?.rerankerInputRetrievalIds,
    ).toEqual([
      elementId("a"),
      elementId("b"),
    ]);
  });

  it("fails when a method attempts to mutate fixed candidate rankings", async () => {
    const dataset = buildDataset();
    const provenance = buildProvenance(dataset);
    const config = buildConfig();
    const inputs = buildPreparedInputs();
    const executor: EvaluationPreparationExecutor = {
      prepareCase: async () => inputs,
      rerank: async () => {
        inputs.rankings.dense[0]?.push(buildDenseCandidate("d", 0.4));
        return {
          inputs: [],
          reranked: {
            candidateSelection: selectRerankedContext([], 1, "top-k"),
            ranking: [],
            retrieved: [],
            selection: { cutoffRank: 0, reason: "maximum-context" },
          },
        };
      },
    };

    await expect(prepareEvaluationCasesWithExecutor(
      dataset,
      provenance,
      ["hybrid-reranked"],
      config,
      executor,
      () => undefined,
    )).rejects.toThrow();
  });

  it("scores a saved preparation offline with byte-identical output", async () => {
    const artifact = await buildArtifact();
    const firstResult = scorePreparedEvaluation(artifact);
    const directory = await mkdtemp(join(tmpdir(), "citeloom-preparation-"));
    const preparationPath = join(directory, "run.json");
    const resultPath = join(directory, "result.json");
    try {
      await writeEvaluationPreparationArtifact(preparationPath, artifact);
      const savedArtifact = await readEvaluationPreparationArtifact(
        preparationPath,
      );
      const secondResult = scorePreparedEvaluation(savedArtifact);

      expect(serializeEvaluationResult(secondResult)).toBe(
        serializeEvaluationResult(firstResult),
      );
      expect(() => assertEvaluationResultMatchesPreparation(
        firstResult,
        savedArtifact,
      )).not.toThrow();
      expect(firstResult.coverage).toEqual({
        caseCount: 1,
        domains: [{ count: 1, value: "legal" }],
        languages: [{ count: 1, value: "en" }],
        questionTypes: [{ count: 1, value: "factoid" }],
        sourceKinds: [{ count: 1, value: "text" }],
      });
      expect(firstResult.methods[0]?.meanNdcgInterval).toMatchObject({
        confidenceLevel: 0.95,
        method: "percentile-bootstrap",
        resamples: 10_000,
      });
      expect(firstResult.comparisons).toHaveLength(6);
      expect(firstResult.comparisons[0]?.cases).toEqual([{
        domain: "legal",
        id: "legal-case",
        ndcgDelta: expect.any(Number),
        recallDelta: expect.any(Number),
      }]);
      await expect(writeEvaluationPreparationArtifact(
        preparationPath,
        artifact,
      )).rejects.toMatchObject({ code: "EEXIST" });
      await writeEvaluationResult(resultPath, firstResult);
      await expect(writeEvaluationResult(resultPath, firstResult))
        .rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("links benchmark quality to the persisted trace for the same case", async () => {
    const baseArtifact = await buildArtifact();
    const artifact = decodeEvaluationPreparationArtifact({
      ...baseArtifact,
      telemetry: [{
        caseId: "legal-case",
        trace: {
          durationMs: 125,
          fallbackCount: 0,
          outcome: "success",
          runId: "11111111-1111-4111-8111-111111111111",
          stages: [{
            durationMs: 25,
            inputCount: 4,
            inputTokens: null,
            modelId: null,
            name: "fusion",
            outcome: "success",
            outputCount: 3,
            outputTokens: null,
            provider: null,
            providerDurationMs: null,
            retrievalMode: "hybrid",
            schedulerWaitMs: null,
            sequence: 0,
          }],
          streamDurationMs: null,
          timeToFirstTokenMs: null,
        },
      }],
      version: 11,
    }, "telemetry test artifact");

    const result = scorePreparedEvaluation(artifact);

    expect(result.methods[0]?.cases[0]).toMatchObject({ id: "legal-case" });
    expect(result.benchmarkTelemetry).toEqual(artifact.telemetry);
    expect(result.benchmarkTelemetry[0]?.trace).toMatchObject({
      durationMs: 125,
      runId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("rejects preparation provenance without explicit fusion settings", async () => {
    const artifact = await buildArtifact();
    const retrieval = structuredClone(artifact.provenance.retrieval);
    delete (retrieval as Partial<typeof retrieval>).fusion;
    const missingFusion = {
      ...artifact,
      provenance: {
        ...artifact.provenance,
        retrieval,
      },
    };

    expect(() => decodeEvaluationPreparationArtifact(
      missingFusion,
      "missing fusion test artifact",
    )).toThrow("fusion");
  });

  it("requires the channel-ordering policy at the artifact boundary", async () => {
    const artifact = await buildArtifact();
    const retrieval = structuredClone(artifact.provenance.retrieval);
    delete (retrieval as Partial<typeof retrieval>).channelOrderingPolicy;
    const missingPolicy = {
      ...artifact,
      provenance: {
        ...artifact.provenance,
        retrieval,
      },
    };

    expect(() => decodeEvaluationPreparationArtifact(
      missingPolicy,
      "missing channel-ordering policy artifact",
    )).toThrow("channelOrderingPolicy");

    const incompatiblePolicy = structuredClone(artifact);
    Object.assign(incompatiblePolicy.provenance.retrieval, {
      channelOrderingPolicy: "channel-score-only-provider-order-v0",
    });
    expect(() => decodeEvaluationPreparationArtifact(
      incompatiblePolicy,
      "incompatible channel-ordering policy artifact",
    )).toThrow("channelOrderingPolicy");
  });

  it("requires and validates retrieval-window identity at the artifact boundary", async () => {
    const artifact = await buildArtifact();
    const missingPolicy = structuredClone(artifact);
    delete (
      missingPolicy.provenance.embeddingSpace as Partial<
        typeof missingPolicy.provenance.embeddingSpace
      >
    ).retrievalWindow;

    expect(() => decodeEvaluationPreparationArtifact(
      missingPolicy,
      "missing retrieval-window policy artifact",
    )).toThrow("retrievalWindow");

    const invalidFingerprint = structuredClone(artifact);
    invalidFingerprint.provenance.embeddingSpace.retrievalWindow.fingerprint =
      "f".repeat(64);
    expect(() => decodeEvaluationPreparationArtifact(
      invalidFingerprint,
      "invalid retrieval-window policy artifact",
    )).toThrow("fingerprint");
  });

  it("rejects dataset, corpus, model, settings, and code provenance mismatches", () => {
    const dataset = buildDataset();
    const expected = buildProvenance(dataset);
    const mismatches: Array<{
      label: string;
      mutate: (value: EvaluationProvenance) => void;
    }> = [
      {
        label: "dataset",
        mutate: (value) => {
          value.dataset.sha256 = "f".repeat(64);
        },
      },
      {
        label: "corpus",
        mutate: (value) => {
          value.corpus.sha256 = "e".repeat(64);
        },
      },
      {
        label: "models",
        mutate: (value) => {
          value.models.queryEmbedding.modelId = "replacement-embedding";
        },
      },
      {
        label: "retrieval settings",
        mutate: (value) => {
          value.retrieval.rrfK += 1;
        },
      },
      {
        label: "settings version",
        mutate: (value) => {
          value.settingsVersion += 1;
        },
      },
      {
        label: "code revision",
        mutate: (value) => {
          value.codeRevision = "different-revision";
        },
      },
    ];

    for (const mismatch of mismatches) {
      const actual = structuredClone(expected);
      mismatch.mutate(actual);
      expect(() => assertEvaluationProvenanceMatches(expected, actual))
        .toThrow(`Evaluation preparation ${mismatch.label} does not match.`);
    }
  });

  it("binds a baseline to the exact saved preparation", async () => {
    const artifact = await buildArtifact();
    const result = scorePreparedEvaluation(artifact);
    const changed = structuredClone(artifact);
    const query = changed.cases[0]?.queries[0];
    if (query === undefined) {
      throw new Error("Missing test query.");
    }
    query.text = "regenerated query";

    expect(() => assertEvaluationResultMatchesPreparation(result, changed))
      .toThrow("Evaluation baseline preparation does not match.");
  });

  it("rejects incomplete reranker evidence", async () => {
    const artifact = await buildArtifact();
    const changed = structuredClone(artifact);
    const preparedCase = changed.cases[0];
    if (preparedCase?.rerankerScores === null || preparedCase === undefined) {
      throw new Error("Missing test reranker scores.");
    }
    preparedCase.rerankerScores.pop();

    expect(() => decodeEvaluationPreparationArtifact(
      changed,
      "changed artifact",
    )).toThrow("do not cover its candidate universe");
  });

  it("requires an exact frozen configuration before sealed access", () => {
    const config = buildConfig();
    const dataset = buildDataset();
    dataset.access = "sealed";
    dataset.split = "holdout";
    const context = {
      codeRevision: "commit:working-tree",
      frozenConfiguration: null,
      settingsVersion: 7,
    };

    expect(() => assertEvaluationDatasetAccess(config, dataset, context))
      .toThrow("only be evaluated with a frozen configuration");

    const frozenConfiguration = createEvaluationConfigurationFreeze(
      config,
      context.codeRevision,
      context.settingsVersion,
    );
    expect(() => assertEvaluationDatasetAccess(config, dataset, {
      ...context,
      frozenConfiguration,
    })).not.toThrow();

    const changedConfig = structuredClone(config);
    changedConfig.retrieval.rrfK += 1;
    expect(() => assertEvaluationDatasetAccess(changedConfig, dataset, {
      ...context,
      frozenConfiguration,
    })).toThrow("does not match the frozen configuration");
  });

  it("checks a sealed path freeze before attempting to read the dataset", async () => {
    const config = buildConfig();
    const context = {
      codeRevision: "commit:working-tree",
      frozenConfiguration: null,
      settingsVersion: 7,
    };

    await expect(prepareComparativeEvaluation(
      config,
      "/missing/final.sealed.json",
      context,
      vi.fn(),
    )).rejects.toThrow("cannot be opened before");
  });

  it("rejects an atK that differs from the configuration before runtime", () => {
    const config = buildConfig();
    const dataset = buildDataset();
    dataset.atK = 3;

    expect(() => assertEvaluationDatasetAccess(config, dataset, {
      codeRevision: "commit:working-tree",
      frozenConfiguration: null,
      settingsVersion: 7,
    })).toThrow("does not match the frozen retrieval topK");
  });
});

async function buildArtifact(): Promise<EvaluationPreparationArtifact> {
  const dataset = buildDataset();
  const provenance = buildProvenance(dataset);
  const config = buildConfig();
  const executor: EvaluationPreparationExecutor = {
    prepareCase: async () => buildPreparedInputs(),
    rerank: async (_question, candidates) => (
      buildEvaluationRerankingResult(candidates)
    ),
  };
  const cases = await prepareEvaluationCasesWithExecutor(
    dataset,
    provenance,
    ["bm25", "dense", "hybrid", "hybrid-reranked"],
    config,
    executor,
    () => undefined,
  );
  return decodeEvaluationPreparationArtifact({
    cases,
    provenance,
    skippedModes: [],
    telemetry: [{
      caseId: "legal-case",
      trace: {
        durationMs: 0,
        fallbackCount: 0,
        outcome: "success",
        runId: "11111111-1111-4111-8111-111111111111",
        stages: [],
        streamDurationMs: null,
        timeToFirstTokenMs: null,
      },
    }],
    version: 11,
  }, "test artifact");
}

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
      candidateK: 3,
      mode: "hybrid",
      queryExpansions: 1,
      rrfK: 60,
      topK: 2,
      variantConcurrency: 2,
    },
  };
}

function buildDataset(): BenchmarkEvaluationDataset {
  return {
    access: "development",
    atK: 2,
    cases: [{
      domain: "legal",
      id: "legal-case",
      judgments: [buildAcceptedJudgment(elementId("c"))],
      metadata: {
        language: "en",
        questionType: "factoid",
        source: { kind: "text" },
      },
      origin: { kind: "manual" },
      question: "original question",
      relevantDocumentIds: [],
      relevantElementIds: [elementId("c")],
    }],
    name: "legal-development",
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
    version: 2,
  };
}

function buildAcceptedJudgment(elementIdValue: string): EvaluationJudgment {
  return {
    provenance: { kind: "pooled", methods: ["hybrid"] },
    relevance: "direct",
    review: {
      auditStatus: "accepted",
      rationale: "The element directly answers the test question.",
      reviewedAt: "2026-07-15T12:00:00.000Z",
      reviewer: { id: "reviewer-1", kind: "human" },
    },
    target: { id: elementIdValue, kind: "element" },
  };
}

function buildProvenance(
  dataset: BenchmarkEvaluationDataset,
): EvaluationProvenance {
  const documentIds = [documentId("a"), documentId("b"), documentId("c")];
  return {
    codeRevision: "commit:working-tree",
    corpus: {
      documentIds,
      sha256: calculateJsonSha256(documentIds),
    },
    dataset: {
      access: dataset.access,
      atK: dataset.atK,
      configurationFreezeSha256: null,
      name: dataset.name,
      sha256: "d".repeat(64),
      split: dataset.split,
      statisticalDesign: { ...dataset.statisticalDesign },
    },
    embeddingSpace: {
      dimensions: 768,
      id: "embedding-space",
      inputFormat: TEST_PLAIN_EMBEDDING_INPUT_FORMAT,
      model: "embedding-model",
      retrievalWindow: createRetrievalWindowPolicyContract(
        createRetrievalWindowPolicy("structured-token-v3", 512, 2_048),
      ),
    },
    hnsw: { efSearch: 100, iterativeScan: "strict_order" },
    models: {
      queryEmbedding: {
        modelId: "embedding-model:query",
        provider: "test",
      },
      queryExpansion: {
        modelId: "summary-model:summary",
        provider: "test",
      },
      reranker: {
        modelId: "reranker-model",
        provider: "test",
      },
    },
    retrieval: {
      candidateK: 3,
      channelOrderingPolicy: "channel-score-then-retrieval-id-v1",
      fusion: { ...EQUAL_WEIGHT_FUSION_CONFIG },
      queryExpansions: 1,
      rrfK: 60,
      topK: 2,
      variantConcurrency: 2,
    },
    settingsVersion: 7,
  };
}

function buildPreparedInputs(): PreparedCaseInputs {
  return {
    queries: [
      { embedding: [1, 0], text: "original question" },
      { embedding: [0, 1], text: "fixed expansion" },
    ],
    rankings: {
      dense: [
        [buildDenseCandidate("a", 0.1), buildDenseCandidate("b", 0.2)],
        [buildDenseCandidate("c", 0.3)],
      ],
      lexical: [
        [buildLexicalCandidate("c", 4), buildLexicalCandidate("a", 3)],
        [buildLexicalCandidate("b", 2)],
      ],
    },
  };
}

function buildDenseCandidate(character: string, distance: number) {
  const content = buildEnglishEvidence(character);
  const retrievalWindowId = elementId(character);
  return {
    distance,
    documentId: documentId(character),
    evidenceContent: content,
    evidenceRetrievalId: retrievalWindowId,
    parentId: elementId(character),
    representation: buildExactCandidateRepresentation(
      retrievalWindowId,
      content,
    ),
    sourceFile: `/documents/${character}.pdf`,
  };
}

function buildLexicalCandidate(character: string, bm25Score: number) {
  const content = buildEnglishEvidence(character);
  const retrievalWindowId = elementId(character);
  return {
    bm25Score,
    documentId: documentId(character),
    evidenceContent: content,
    evidenceRetrievalId: retrievalWindowId,
    parentId: elementId(character),
    representation: buildExactCandidateRepresentation(
      retrievalWindowId,
      content,
    ),
    sourceFile: `/documents/${character}.pdf`,
  };
}

function buildEnglishEvidence(character: string): string {
  return (
    `This English evidence summary explains the relevant policy for section ${character}.`
  );
}

function buildRerankedRetrieval(
  candidates: FusedCandidate[],
): RerankedRetrieval {
  const ranking = [];
  const retrieved = [];
  const inputs = buildRerankerInputs(candidates);
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index];
    const input = inputs[index];
    if (candidate === undefined || input === undefined) {
      continue;
    }
    ranking.push({
      originalIndex: index,
      relevanceScore: candidates.length - index,
    });
    if (retrieved.length < 2) {
      retrieved.push(input);
    }
  }
  const scored = [];
  for (const entry of ranking) {
    const candidate = candidates[entry.originalIndex];
    const input = inputs[entry.originalIndex];
    if (candidate === undefined || input === undefined) {
      continue;
    }
    scored.push({
      identity: {
        documentId: candidate.documentId,
        documentVersionId: input.documentVersionId,
        elementId: candidate.parentId,
        representativeRetrievalWindowId: candidate.retrievalId,
        sourceFile: candidate.sourceFile,
      },
      item: input,
      relevanceScore: entry.relevanceScore,
      rerankerInputRank: entry.originalIndex + 1,
    });
  }
  const candidateSelection = selectRerankedContext(scored, 2, "top-k");
  return {
    candidateSelection,
    ranking,
    retrieved,
    selection: {
      cutoffRank: retrieved.length,
      reason: "maximum-context",
    },
  };
}

function buildEvaluationRerankingResult(
  candidates: FusedCandidate[],
): EvaluationRerankingResult {
  return {
    inputs: buildRerankerInputs(candidates),
    reranked: buildRerankedRetrieval(candidates),
  };
}

function buildRerankerInputs(candidates: FusedCandidate[]) {
  return candidates.map((candidate) => ({
    distance: candidate.denseDistance,
    documentVersionId: "00000000-0000-4000-8000-000000000001",
    element: {
      content: candidate.evidenceContent,
      documentId: candidate.documentId,
      id: candidate.parentId,
      detectedTypes: ["paragraph"],
      kind: "text" as const,
      ...buildSourceLocation(1),
      sourceFile: candidate.sourceFile,
    },
    evidenceContent: candidate.evidenceContent,
    provenance: buildRetrievedElementProvenance(candidate.retrievalId),
  }));
}

function documentId(character: string): string {
  return character.repeat(64);
}

function elementId(character: string): string {
  return character.repeat(64);
}
