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
  mode: "hybrid",
  queryExpansions: 2,
  queryExpansionTemperature: 0,
  reranker: null,
  rrfK: 60,
  topK: 10,
};

describe("turn generation settings", () => {
  it("applies answer and query-expansion temperatures", () => {
    const settings = createTurnGenerationSettings({
      ...retrieval,
      answerTemperature: 0.2,
      queryExpansionTemperature: 0.4,
    });

    expect(settings).toEqual({
      answer: { temperature: 0.2 },
      queryExpansion: { temperature: 0.4 },
    });
  });
});
