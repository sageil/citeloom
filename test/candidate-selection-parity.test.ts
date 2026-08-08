import { describe, expect, it } from "vitest";

import type { RankFusionConfig } from "../src/config/index.js";
import type { PreparedEvaluationCase } from "../tools/evaluation/artifact.js";
import {
  derivePreparedRerankedSelection,
} from "../tools/evaluation/index.js";
import {
  rankRetrievalCandidates,
  selectPreparedRerankingCandidatesWithTrace,
  selectPreparedRetrievalCandidates,
  selectRerankingCandidatesWithTrace,
  type RetrievalCandidateRankings,
} from "../src/retrieval/indexing/query-store.js";
import {
  partitionCandidateWindowsByParentOccurrence,
} from "../src/retrieval/document-retrieval.js";
import {
  selectRerankedContext,
  type ScoredRerankerCandidate,
} from "../src/retrieval/ranking/candidate-selection.js";
import type {
  DenseCandidate,
  FusedCandidate,
} from "../src/retrieval/ranking/rank-fusion.js";
import { createCandidateSourceAliases } from "../src/retrieval/ranking/rank-fusion.js";
import { createEvidenceSha256 } from "../src/retrieval/evidence-identity.js";
import {
  buildExactCandidateRepresentation,
} from "./source-element-fixture.js";

const fusion: RankFusionConfig = {
  denseWeight: 1,
  expansionDecay: 1,
  expansionQueryWeight: 1,
  lexicalWeight: 1,
  originalQueryWeight: 1,
};

describe("production and prepared candidate-selection parity", () => {
  it("replays broad-question fused order and representative windows", () => {
    const rankings = buildRepeatedParentRankings();
    const question = "What is Alpha Guide?";
    const production = selectRerankingCandidatesWithTrace(
      question,
      rankRetrievalCandidates("hybrid", rankings, 60, fusion),
      3,
    );
    const preparedCase = buildPreparedCase(
      "broad-case",
      question,
      rankings,
      3,
    );
    const replay = derivePreparedRerankedSelection(
      preparedCase,
      rankings,
      buildScoringConfig(3, 3),
    );
    const preparedCandidates = selectPreparedRetrievalCandidates(
      "hybrid",
      question,
      rankings,
      3,
      3,
      60,
      fusion,
    );

    expect(production.allocationPolicy).toBe("fused-order");
    expect(readSelectedWindows(production.selected)).toEqual([
      retrievalId("1"),
      retrievalId("3"),
      retrievalId("4"),
    ]);
    expect(readSelectedWindows(replay.preRerank.selected))
      .toEqual(readSelectedWindows(production.selected));
    expect(readSelectedWindows(preparedCandidates))
      .toEqual(readSelectedWindows(production.selected));
    expect(replay.preRerank.decisions).toEqual(production.decisions);
    expect(production.decisions.map((decision) => decision.exclusionReason))
      .toEqual([null, null, null, "candidate-budget"]);
  });

  it("replays fused ordering for other questions", () => {
    const rankings = buildRepeatedParentRankings();
    const question = "Which passages explain the subject?";
    const production = selectRerankingCandidatesWithTrace(
      question,
      rankRetrievalCandidates("hybrid", rankings, 60, fusion),
      3,
    );
    const prepared = selectPreparedRerankingCandidatesWithTrace(
      question,
      rankings,
      3,
      60,
      fusion,
    );

    expect(production.allocationPolicy).toBe("fused-order");
    expect(readSelectedWindows(production.selected)).toEqual([
      retrievalId("1"),
      retrievalId("3"),
      retrievalId("4"),
    ]);
    expect(prepared).toEqual(production);
  });

  it("reuses the same structural trace for comparative, tuning, context, and threshold paths", () => {
    const rankings = buildRepeatedParentRankings();
    const question = "Which passages explain the subject?";
    const preparedCase = buildPreparedCase(
      "consumer-parity-case",
      question,
      rankings,
      3,
      new Map([
        [parentId("a"), 5],
        [parentId("b"), 4],
        [parentId("c"), 3],
        [parentId("d"), 2],
      ]),
    );
    const config = buildScoringConfig(3, 3);
    const comparative = derivePreparedRerankedSelection(
      preparedCase,
      rankings,
      config,
    );
    const tuning = derivePreparedRerankedSelection(
      preparedCase,
      rankings,
      config,
      "relevance-cliff",
      "tuning-universe",
    );
    const contextComparison = derivePreparedRerankedSelection(
      preparedCase,
      rankings,
      config,
      "top-k",
    );
    const threshold = selectPreparedRerankingCandidatesWithTrace(
      question,
      rankings,
      config.candidateK,
      config.rrfK,
      config.fusion,
    );

    expect(tuning.preRerank).toEqual(comparative.preRerank);
    expect(tuning.postRerank).toEqual(comparative.postRerank);
    expect(contextComparison.preRerank).toEqual(comparative.preRerank);
    expect(contextComparison.postRerank.ranking)
      .toEqual(comparative.postRerank.ranking);
    expect(contextComparison.postRerank.selected)
      .toEqual(comparative.postRerank.selected);
    expect(threshold).toEqual(comparative.preRerank);
  });

  it("uses persistent source identity for equal-score replay ordering", () => {
    const rankings: RetrievalCandidateRankings = {
      dense: [[
        buildDenseCandidate("b", "b", "1", 0.1, "Beta Notes.pdf"),
        buildDenseCandidate("a", "a", "2", 0.2, "Alpha Notes.pdf"),
      ]],
      lexical: [[]],
    };
    const question = "Which notes answer the question?";
    const preparedCase = buildPreparedCase(
      "tie-case",
      question,
      rankings,
      2,
      new Map([
        [parentId("a"), 0.8],
        [parentId("b"), 0.8],
      ]),
    );
    const replay = derivePreparedRerankedSelection(
      preparedCase,
      rankings,
      buildScoringConfig(2, 2),
    );

    expect(replay.preRerank.selected.map((candidate) => candidate.parentId))
      .toEqual([parentId("b"), parentId("a")]);
    expect(replay.postRerank.ranking.map((candidate) => candidate.item.parentId))
      .toEqual([parentId("a"), parentId("b")]);
    expect(replay.postRerank.selected.map((candidate) => candidate.item.parentId))
      .toEqual([parentId("a"), parentId("b")]);
  });

  it("replays relative cutoff rank, reason, and final context order", () => {
    const rankings: RetrievalCandidateRankings = {
      dense: [[
        buildDenseCandidate("a", "a", "1", 0.1, "A.pdf"),
        buildDenseCandidate("b", "b", "2", 0.2, "B.pdf"),
        buildDenseCandidate("c", "c", "3", 0.3, "C.pdf"),
        buildDenseCandidate("d", "d", "4", 0.4, "D.pdf"),
      ]],
      lexical: [[]],
    };
    const scores = new Map([
      [parentId("a"), 0.9],
      [parentId("b"), 0.8],
      [parentId("c"), 0.005],
      [parentId("d"), 0.004],
    ]);
    const preparedCase = buildPreparedCase(
      "cutoff-case",
      "Which passages answer the question?",
      rankings,
      4,
      scores,
    );

    const replay = derivePreparedRerankedSelection(
      preparedCase,
      rankings,
      buildScoringConfig(4, 4),
    );

    expect(replay.postRerank.cutoff).toEqual({
      cutoffRank: 2,
      reason: "relevance-cliff",
    });
    expect(replay.postRerank.selected.map((candidate) => candidate.item.parentId))
      .toEqual([parentId("a"), parentId("b")]);
    expect(replay.postRerank.excluded.map((decision) => ({
      parentId: decision.candidate.item.parentId,
      reason: decision.exclusionReason,
    }))).toEqual([
      { parentId: parentId("c"), reason: "relevance-cliff" },
      { parentId: parentId("d"), reason: "relevance-cliff" },
    ]);
  });

  it("returns one deterministic primary reason for every post-rerank exclusion", () => {
    const candidates: ScoredRerankerCandidate<string>[] = [
      buildScoredCandidate("first", "a", "a", "1", 0.9, 1),
      buildScoredCandidate("duplicate", "a", "a", "2", 0.8, 2),
      buildScoredCandidate("third", "b", "b", "3", 0.7, 3),
      buildScoredCandidate("tail", "c", "c", "4", 0.6, 4),
    ];

    const selection = selectRerankedContext(candidates, 3, "top-k");

    expect(selection.selected.map((candidate) => candidate.item))
      .toEqual(["first", "duplicate", "third"]);
    expect(selection.excluded.map((decision) => ({
      item: decision.candidate.item,
      reason: decision.exclusionReason,
    }))).toEqual([
      { item: "tail", reason: "maximum-context" },
    ]);
    expect(selection.decisions.every((decision) => (
      decision.selectedContextRank !== null
        ? decision.exclusionReason === null
        : decision.exclusionReason !== null
    ))).toBe(true);
  });

  it("removes exact publication aliases after reranking and backfills context", () => {
    const first = buildScoredCandidate(
      "exact evidence",
      "a",
      "a",
      "1",
      0.9,
      1,
    );
    const alias = buildScoredCandidate(
      "exact evidence",
      "a",
      "a",
      "2",
      0.8,
      2,
    );
    alias.identity = {
      ...alias.identity,
      documentVersionId: documentVersionId("z"),
      sourceFile: "alias.pdf",
    };
    const distinct = buildScoredCandidate(
      "distinct evidence",
      "b",
      "a",
      "3",
      0.7,
      3,
    );

    const selection = selectRerankedContext(
      [first, alias, distinct],
      2,
      "top-k",
    );

    expect(selection.selected.map((candidate) => candidate.item))
      .toEqual(["exact evidence", "distinct evidence"]);
    expect(selection.excluded.map((decision) => ({
      reason: decision.exclusionReason,
      sourceFile: decision.candidate.identity.sourceFile,
    }))).toContainEqual({
      reason: "duplicate-evidence",
      sourceFile: "alias.pdf",
    });
  });

  it("preserves exact evidence from different element sets after reranking", () => {
    const first = buildScoredCandidate(
      "exact evidence",
      "a",
      "a",
      "1",
      0.9,
      1,
    );
    const differentElementSet = buildScoredCandidate(
      "exact evidence",
      "a",
      "a",
      "2",
      0.8,
      2,
    );
    differentElementSet.identity = {
      ...differentElementSet.identity,
      elementSetId: elementSetId("z"),
    };

    const selection = selectRerankedContext(
      [first, differentElementSet],
      2,
      "top-k",
    );

    expect(selection.selected).toHaveLength(2);
  });
});

function buildRepeatedParentRankings(): RetrievalCandidateRankings {
  return {
    dense: [[
      buildDenseCandidate("a", "a", "1", 0.1, "Alpha Guide.pdf"),
      buildDenseCandidate("b", "a", "3", 0.3, "Alpha Guide.pdf"),
      buildDenseCandidate("c", "b", "4", 0.4, "Beta Manual.pdf"),
      buildDenseCandidate("d", "b", "5", 0.5, "Beta Manual.pdf"),
    ]],
    lexical: [[]],
  };
}

function buildDenseCandidate(
  parentCharacter: string,
  documentCharacter: string,
  retrievalCharacter: string,
  distance: number,
  sourceFile: string,
): DenseCandidate {
  const content = (
    `This English evidence summary explains the relevant policy for section ${retrievalCharacter}.`
  );
  const windowId = retrievalId(retrievalCharacter);
  return {
    distance,
    documentId: documentId(documentCharacter),
    elementSetId: elementSetId(documentCharacter),
    evidenceContent: content,
    evidenceRetrievalId: windowId,
    parentId: parentId(parentCharacter),
    representation: buildExactCandidateRepresentation(windowId, content),
    sourceAliases: createCandidateSourceAliases({
      evidenceRetrievalId: windowId,
      sourceFile,
    }),
    sourceFile,
  };
}

function buildPreparedCase(
  caseId: string,
  question: string,
  rankings: RetrievalCandidateRankings,
  candidateK: number,
  scoreByParent: ReadonlyMap<string, number> = new Map(),
): PreparedEvaluationCase {
  const selection = selectPreparedRerankingCandidatesWithTrace(
    question,
    rankings,
    candidateK,
    60,
    fusion,
  );
  const fused = selection.decisions.map((decision) => decision.candidate);
  const tuningBatches = partitionCandidateWindowsByParentOccurrence(fused);
  const rerankerScores = buildScores(
    selection.selected,
    scoreByParent,
  );
  const tuningRerankerScores: NonNullable<
    PreparedEvaluationCase["tuningRerankerScores"]
  > = [];
  for (let index = 0; index < tuningBatches.length; index += 1) {
    const tuningBatch = tuningBatches[index];
    if (tuningBatch === undefined) {
      continue;
    }
    tuningRerankerScores.push(...buildScores(
      tuningBatch,
      scoreByParent,
      index + 1,
    ));
  }
  return {
    candidateRankings: {
      dense: rankings.dense.map((ranking) => ranking.map((candidate) => ({
        distance: candidate.distance,
        documentId: candidate.documentId,
        elementId: candidate.parentId,
        elementSetId: candidate.elementSetId,
        evidenceContent: candidate.evidenceContent,
        evidenceRetrievalId: candidate.evidenceRetrievalId,
        representation: candidate.representation,
        sourceFile: candidate.sourceFile,
      }))),
      lexical: rankings.lexical.map((ranking) => ranking.map((candidate) => ({
        bm25Score: candidate.bm25Score,
        documentId: candidate.documentId,
        elementId: candidate.parentId,
        elementSetId: candidate.elementSetId,
        evidenceContent: candidate.evidenceContent,
        evidenceRetrievalId: candidate.evidenceRetrievalId,
        representation: candidate.representation,
        sourceFile: candidate.sourceFile,
      }))),
    },
    candidateSelection: {
      allocationPolicy: selection.allocationPolicy,
      candidateK,
      decisions: selection.decisions.map((decision) => ({
        admissionRank: decision.admissionRank,
        documentId: decision.candidate.documentId,
        elementId: decision.candidate.parentId,
        exclusionReason: decision.exclusionReason,
        fusedRank: decision.fusedRank,
        representativeRetrievalWindowId:
          decision.representativeRetrievalWindowId,
        retrievalId: decision.candidate.retrievalId,
        sourceFile: decision.candidate.sourceFile,
      })),
      rerankerInputRetrievalIds: readSelectedWindows(selection.selected),
    },
    domain: "structural",
    id: caseId,
    judgments: [{
      provenance: {
        kind: "pooled",
        methods: ["hybrid-reranked"],
      },
      relevance: "direct",
      review: {
        auditStatus: "accepted",
        rationale: "Structural fixture target.",
        reviewedAt: "2026-07-23T12:00:00.000Z",
        reviewer: {
          id: "structural-fixture",
          kind: "human",
        },
      },
      target: {
        id: selection.selected[0]?.parentId ?? parentId("f"),
        kind: "element",
      },
    }],
    metadata: {
      language: "en",
      questionType: "factoid",
      source: {
        kind: "text",
      },
    },
    queries: [{
      embeddingSha256: "0".repeat(64),
      text: question,
    }],
    question,
    relevantDocumentIds: [],
    relevantElementIds: [selection.selected[0]?.parentId ?? parentId("f")],
    rerankerScores,
    tuningRerankerScores,
  };
}

function buildScores(
  candidates: readonly FusedCandidate[],
  scoreByParent: ReadonlyMap<string, number>,
  scoringBatchIndex: number = 1,
): NonNullable<PreparedEvaluationCase["rerankerScores"]> {
  const scores: NonNullable<PreparedEvaluationCase["rerankerScores"]> = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (candidate === undefined) {
      continue;
    }
    const configuredScore = scoreByParent.get(candidate.parentId);
    scores.push({
      documentId: candidate.documentId,
      documentVersionId: documentVersionId(candidate.documentId[0] ?? "1"),
      elementId: candidate.parentId,
      relevanceScore: configuredScore ?? candidates.length - index,
      retrievalId: candidate.retrievalId,
      scoringBatchIndex,
      scoringBatchRank: index + 1,
      sourceFile: candidate.sourceFile,
    });
  }
  return scores;
}

function buildScoredCandidate(
  item: string,
  parentCharacter: string,
  documentCharacter: string,
  retrievalCharacter: string,
  relevanceScore: number,
  rerankerInputRank: number,
): ScoredRerankerCandidate<string> {
  return {
    identity: {
      documentId: documentId(documentCharacter),
      documentVersionId: documentVersionId(documentCharacter),
      elementId: parentId(parentCharacter),
      elementSetId: elementSetId(documentCharacter),
      evidenceSha256: createEvidenceSha256(item),
      representativeRetrievalWindowId: retrievalId(retrievalCharacter),
      sourceFile: `${documentCharacter}.pdf`,
    },
    item,
    relevanceScore,
    rerankerInputRank,
  };
}

function buildScoringConfig(candidateK: number, topK: number) {
  return {
    candidateK,
    fusion,
    queryExpansions: 0,
    rrfK: 60,
    topK,
  };
}

function readSelectedWindows(candidates: readonly FusedCandidate[]): string[] {
  return candidates.map((candidate) => candidate.retrievalId);
}

function documentId(character: string): string {
  return character.repeat(64);
}

function parentId(character: string): string {
  return character.repeat(64);
}

function elementSetId(character: string): string {
  return character.repeat(64);
}

function retrievalId(character: string): string {
  return character.repeat(64);
}

function documentVersionId(character: string): string {
  const suffix = character.charCodeAt(0).toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${suffix}`;
}
