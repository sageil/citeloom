import { describe, expect, it } from "vitest";

import {
  fuseRankedCandidates,
  createCandidateSourceAliases,
  selectStrongestUniqueEvidence,
  type DenseCandidate,
  type LexicalCandidate,
} from "../src/retrieval/ranking/rank-fusion.js";
import {
  buildExactCandidateRepresentation,
} from "./source-element-fixture.js";

function dense(parentId: string, distance: number): DenseCandidate {
  const content = `Evidence ${parentId}`;
  const retrievalWindowId = `${parentId}-window`;
  return {
    distance,
    documentId: `${parentId}-document`,
    elementSetId: `${parentId}-element-set`,
    evidenceContent: content,
    evidenceRetrievalId: retrievalWindowId,
    parentId,
    representation: buildExactCandidateRepresentation(
      retrievalWindowId,
      content,
    ),
    sourceAliases: createCandidateSourceAliases({
      evidenceRetrievalId: retrievalWindowId,
      sourceFile: `${parentId}.pdf`,
    }),
    sourceFile: `${parentId}.pdf`,
  };
}

function lexical(parentId: string, bm25Score: number): LexicalCandidate {
  const content = `Evidence ${parentId}`;
  const retrievalWindowId = `${parentId}-window`;
  return {
    bm25Score,
    documentId: `${parentId}-document`,
    elementSetId: `${parentId}-element-set`,
    evidenceContent: content,
    evidenceRetrievalId: retrievalWindowId,
    parentId,
    representation: buildExactCandidateRepresentation(
      retrievalWindowId,
      content,
    ),
    sourceAliases: createCandidateSourceAliases({
      evidenceRetrievalId: retrievalWindowId,
      sourceFile: `${parentId}.pdf`,
    }),
    sourceFile: `${parentId}.pdf`,
  };
}

describe("reciprocal rank fusion", () => {
  it("fills the budget with unique evidence and preserves source aliases", () => {
    const first = dense("a", 0.1);
    const alias = {
      ...first,
      evidenceRetrievalId: "a-alias-window",
      sourceAliases: createCandidateSourceAliases({
        evidenceRetrievalId: "a-alias-window",
        sourceFile: "a-alias.pdf",
      }),
      sourceFile: "a-alias.pdf",
    };

    const selected = selectStrongestUniqueEvidence([
      first,
      alias,
      dense("b", 0.2),
      dense("c", 0.3),
    ], 3);

    expect(selected.map((candidate) => candidate.parentId))
      .toEqual(["a", "b", "c"]);
    expect(selected[0]?.sourceAliases).toEqual([
      { evidenceRetrievalId: "a-window", sourceFile: "a.pdf" },
      { evidenceRetrievalId: "a-alias-window", sourceFile: "a-alias.pdf" },
    ]);
    expect(first.sourceAliases).toEqual([
      { evidenceRetrievalId: "a-window", sourceFile: "a.pdf" },
    ]);
  });

  it("does not collapse evidence from different element sets", () => {
    const first = dense("a", 0.1);
    const differentElementSet = {
      ...first,
      elementSetId: "different-element-set",
    };

    const selected = selectStrongestUniqueEvidence(
      [first, differentElementSet],
      2,
    );

    expect(selected).toHaveLength(2);
  });

  it("fuses exact aliases across channels without losing channel evidence", () => {
    const denseAlias = dense("shared-alias", 0.1);
    const lexicalAlias = lexical("shared-alias", 8);
    lexicalAlias.evidenceRetrievalId = "shared-alias-lexical-window";
    lexicalAlias.sourceFile = "shared-alias-copy.pdf";
    lexicalAlias.sourceAliases = createCandidateSourceAliases(lexicalAlias);

    const results = fuseRankedCandidates([
      {
        candidates: [denseAlias],
        channel: "dense",
        queryIndex: 0,
        weight: 1,
      },
      {
        candidates: [lexicalAlias],
        channel: "lexical",
        queryIndex: 0,
        weight: 1,
      },
    ], 60, 2);

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      bm25Score: 8,
      denseDistance: 0.1,
    });
    expect(results[0]?.sourceAliases).toEqual([
      {
        evidenceRetrievalId: "shared-alias-window",
        sourceFile: "shared-alias.pdf",
      },
      {
        evidenceRetrievalId: "shared-alias-lexical-window",
        sourceFile: "shared-alias-copy.pdf",
      },
    ]);
    expect(results[0]?.representationHits.map((hit) => hit.channel))
      .toEqual(["dense", "lexical"]);
  });

  it("promotes candidates found by both retrievers", () => {
    const results = fuseRankedCandidates(
      [
        {
          candidates: [dense("dense-only", 0.1), dense("both", 0.2)],
          channel: "dense",
          queryIndex: 0,
          weight: 1,
        },
        {
          candidates: [lexical("lexical-only", 8), lexical("both", 4)],
          channel: "lexical",
          queryIndex: 0,
          weight: 1,
        },
      ],
      60,
      3,
    );

    expect(results.map((result) => result.parentId)).toEqual([
      "both",
      "dense-only",
      "lexical-only",
    ]);
    expect(results[0]).toMatchObject({
      bm25Score: 4,
      denseDistance: 0.2,
    });
  });

  it("applies the requested result limit", () => {
    const results = fuseRankedCandidates(
      [
        {
          candidates: [dense("a", 0.1), dense("b", 0.2)],
          channel: "dense",
          queryIndex: 0,
          weight: 1,
        },
        {
          candidates: [lexical("c", 8)],
          channel: "lexical",
          queryIndex: 0,
          weight: 1,
        },
      ],
      60,
      2,
    );

    expect(results).toHaveLength(2);
  });

  it("fuses rankings from the original query and its variants", () => {
    const results = fuseRankedCandidates(
      [
        {
          candidates: [dense("original", 0.1), dense("shared", 0.2)],
          channel: "dense",
          queryIndex: 0,
          weight: 1,
        },
        {
          candidates: [dense("variant", 0.1), dense("shared", 0.3)],
          channel: "dense",
          queryIndex: 1,
          weight: 1,
        },
        {
          candidates: [lexical("shared", 8)],
          channel: "lexical",
          queryIndex: 0,
          weight: 1,
        },
      ],
      60,
      3,
    );

    expect(results[0]?.parentId).toBe("shared");
    expect(results[0]?.denseDistance).toBe(0.2);
    expect(results[0]?.bm25Score).toBe(8);
  });

  it("weights retrieval modalities and query variants independently", () => {
    const results = fuseRankedCandidates(
      [
        {
          candidates: [dense("original-dense", 0.1)],
          channel: "dense",
          queryIndex: 0,
          weight: 4,
        },
        {
          candidates: [lexical("original-lexical", 8)],
          channel: "lexical",
          queryIndex: 0,
          weight: 2,
        },
        {
          candidates: [dense("expansion-dense", 0.1)],
          channel: "dense",
          queryIndex: 1,
          weight: 1,
        },
      ],
      60,
      3,
    );

    expect(results.map((result) => result.parentId)).toEqual([
      "original-dense",
      "original-lexical",
      "expansion-dense",
    ]);
  });

  it("fuses description and exact hits by canonical parent while retaining exact evidence", () => {
    const descriptionHit = dense("shared", 0.1);
    descriptionHit.representation = {
      content: "A table retrieval description for shared.",
      id: "shared-description",
      type: "table-description",
    };
    descriptionHit.evidenceContent = "Exact shared evidence with value 18.";
    descriptionHit.evidenceRetrievalId = "shared-exact-window";
    const exactHit = lexical("shared", 10);
    exactHit.evidenceContent = "Exact shared evidence with value 18.";
    exactHit.evidenceRetrievalId = "shared-exact-window";

    const results = fuseRankedCandidates(
      [
        {
          candidates: [descriptionHit, dense("dense-only", 0.2)],
          channel: "dense",
          queryIndex: 0,
          weight: 1,
        },
        {
          candidates: [exactHit, lexical("lexical-only", 8)],
          channel: "lexical",
          queryIndex: 0,
          weight: 1,
        },
      ],
      60,
      3,
    );

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({
      evidenceContent: "Exact shared evidence with value 18.",
      parentId: "shared",
      retrievalId: "shared-exact-window",
      descriptionAffected: true,
    });
    expect(results[0]?.representationHits.map((hit) => hit.representationType))
      .toEqual(["table-description", "exact-window"]);
  });

  it("rejects invalid fusion parameters", () => {
    expect(() => fuseRankedCandidates([], 0, 10)).toThrow(
      "RRF k must be a positive integer",
    );
    expect(() => fuseRankedCandidates([], 60, 0)).toThrow(
      "RRF result limit must be a positive integer",
    );
    expect(() => fuseRankedCandidates([
      {
        candidates: [],
        channel: "dense",
        queryIndex: 0,
        weight: 0,
      },
    ], 60, 10)).toThrow("RRF ranking weight must be a positive finite number");
  });
});
