import { describe, expect, it } from "vitest";

import type { RetrievalConfig } from "../src/config/index.js";
import { createTurnGenerationSettings } from "../src/inference/generation-settings.js";

const retrieval: RetrievalConfig = {
  answerTemperature: 0,
  candidateK: 50,
  chatTemperature: 0,
  fusion: {
    denseWeight: 1,
    expansionDecay: 1,
    expansionQueryWeight: 1,
    lexicalWeight: 1,
    originalQueryWeight: 1,
  },
  generationSeedMode: "stable",
  mode: "hybrid",
  queryExpansions: 2,
  queryExpansionTemperature: 0,
  reranker: null,
  rrfK: 60,
  topK: 10,
};

const generationA = "00000000-0000-4000-8000-000000000001";
const generationB = "00000000-0000-4000-8000-000000000002";

describe("turn generation settings", () => {
  it("derives stable operation-specific seeds independent of scope order", () => {
    const first = createTurnGenerationSettings(
      retrieval,
      "  What   changed? ",
      [
        {
          documentId: "document-b",
          generationId: generationB,
          sourceFile: "/documents/b.pdf",
        },
        {
          documentId: "document-a",
          generationId: generationA,
          sourceFile: "/documents/a.pdf",
        },
      ],
    );
    const second = createTurnGenerationSettings(
      retrieval,
      "What changed?",
      [
        {
          documentId: "document-a",
          generationId: generationA,
          sourceFile: "/documents/a.pdf",
        },
        {
          documentId: "document-b",
          generationId: generationB,
          sourceFile: "/documents/b.pdf",
        },
      ],
    );

    expect(first).toEqual(second);
    expect(first.answer.seed).not.toBe(first.queryExpansion.seed);
  });

  it("omits seeds in random mode while preserving temperatures", () => {
    const settings = createTurnGenerationSettings(
      {
        ...retrieval,
        answerTemperature: 0.2,
        generationSeedMode: "random",
        queryExpansionTemperature: 0.4,
      },
      "What changed?",
      [{
        documentId: "document-a",
        generationId: generationA,
        sourceFile: "/documents/a.pdf",
      }],
    );

    expect(settings).toEqual({
      answer: { seed: null, temperature: 0.2 },
      queryExpansion: { seed: null, temperature: 0.4 },
      seedMode: "random",
    });
  });
});
