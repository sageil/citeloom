import { afterEach, describe, expect, it, vi } from "vitest";
import { MockRerankingModelV4 } from "ai/test";

import { InferenceMetricsReporter } from "../src/inference/metrics.js";
import type { RerankerConfig } from "../src/config/index.js";
import type { RetrievedElement } from "../src/retrieval/document-retrieval.js";
import {
  buildRetrievedElementProvenance,
  buildSourceLocation,
} from "./source-element-fixture.js";
import {
  createHttpRerankingModel,
  rerankRetrievedElements,
  rerankRetrievedElementsAboveThreshold,
  rerankRetrievedElementsByRelevance,
  rerankRetrievedElementsWithResponse,
} from "../src/retrieval/ranking/reranker.js";

const config: RerankerConfig = {
  adapter: "top-n-rerank",
  apiToken: null,
  baseUrl: "http://127.0.0.1:8012/v1",
  providerId: "local-ai",
  discoveryMinimumScore: 0.5,
  model: "bge-reranker-v2-m3",
  runtimeName: "test reranker",
  timeoutMs: 300_000,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HTTP AI SDK reranker adapter", () => {
  it("normalizes unsorted provider scores into AI SDK ranking order", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      model: "bge-reranker-v2-m3",
      results: [
        { index: 0, relevance_score: -2 },
        { index: 1, relevance_score: 8 },
      ],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const model = createHttpRerankingModel(config);
    const result = await model.doRerank({
      documents: { type: "text", values: ["first", "second"] },
      query: "question",
      topN: 1,
    });

    expect(result.ranking).toEqual([{ index: 1, relevanceScore: 8 }]);
    expect(model.provider).toBe("test reranker");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8012/v1/rerank",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not infer a relevance cliff from only two scores", async () => {
    const model = new MockRerankingModelV4({
      doRerank: async () => ({
        ranking: [
          { index: 1, relevanceScore: 0.41 },
          { index: 0, relevanceScore: 0.01 },
        ],
      }),
    });
    const candidates = [
      buildRetrievedElement("a", "Low relevance"),
      buildRetrievedElement("b", "Directly relevant"),
    ];

    const result = await rerankRetrievedElements(
      {
        metrics: new InferenceMetricsReporter({ enabled: false }),
        model,
        timeoutMs: 1_000,
      },
      "relevant question",
      candidates,
      2,
    );

    expect(result).toEqual([candidates[1], candidates[0]]);
  });

  it("keeps a provider result even when its raw score is small", async () => {
    const model = new MockRerankingModelV4({
      doRerank: async () => ({
        ranking: [{ index: 0, relevanceScore: 0.001 }],
      }),
    });

    const result = await rerankRetrievedElements(
      {
        metrics: new InferenceMetricsReporter({ enabled: false }),
        model,
        timeoutMs: 1_000,
      },
      "unrelated question",
      [buildRetrievedElement("a", "Unrelated")],
      1,
    );

    expect(result).toEqual([buildRetrievedElement("a", "Unrelated")]);
  });

  it("captures the exact reranker ranking used by an evaluation", async () => {
    const model = new MockRerankingModelV4({
      doRerank: async () => ({
        ranking: [
          { index: 1, relevanceScore: 0.8 },
          { index: 0, relevanceScore: 0.2 },
        ],
      }),
    });
    const candidates = [
      buildRetrievedElement("a", "First"),
      buildRetrievedElement("b", "Second"),
    ];

    const result = await rerankRetrievedElementsWithResponse(
      {
        metrics: new InferenceMetricsReporter({ enabled: false }),
        model,
        timeoutMs: 1_000,
      },
      "question",
      candidates,
      2,
    );

    expect(result.ranking).toEqual([
      { originalIndex: 1, relevanceScore: 0.8 },
      { originalIndex: 0, relevanceScore: 0.2 },
    ]);
    expect(result.retrieved).toEqual([candidates[1], candidates[0]]);
  });

  it("breaks equal reranker scores by persistent source identity", async () => {
    const model = new MockRerankingModelV4({
      doRerank: async () => ({
        ranking: [
          { index: 0, relevanceScore: 0.8 },
          { index: 1, relevanceScore: 0.8 },
        ],
      }),
    });
    const candidates = [
      buildRetrievedElement("b", "Second"),
      buildRetrievedElement("a", "First"),
    ];

    const result = await rerankRetrievedElementsWithResponse(
      {
        metrics: new InferenceMetricsReporter({ enabled: false }),
        model,
        timeoutMs: 1_000,
      },
      "question",
      candidates,
      2,
    );

    expect(result.retrieved).toEqual([candidates[1], candidates[0]]);
  });

  it("promotes source diversity beyond a maximum-context prefix", async () => {
    const model = new MockRerankingModelV4({
      doRerank: async (options) => {
        expect(options.topN).toBe(4);
        return {
          ranking: [
            { index: 0, relevanceScore: 0.9 },
            { index: 1, relevanceScore: 0.8 },
            { index: 2, relevanceScore: 0.7 },
            { index: 3, relevanceScore: 0.6 },
          ],
        };
      },
    });
    const candidates = [
      buildRetrievedElement("a", "First", "f"),
      buildRetrievedElement("b", "Second", "f"),
      buildRetrievedElement("c", "Third", "f"),
      buildRetrievedElement("d", "Alternative", "e"),
    ];

    const result = await rerankRetrievedElements(
      {
        metrics: new InferenceMetricsReporter({ enabled: false }),
        model,
        timeoutMs: 1_000,
      },
      "question",
      candidates,
      3,
    );

    expect(result).toEqual([candidates[0], candidates[1], candidates[3]]);
  });

  it("keeps strict relevance order for source discovery", async () => {
    const model = new MockRerankingModelV4({
      doRerank: async () => ({
        ranking: [
          { index: 0, relevanceScore: 0.9 },
          { index: 1, relevanceScore: 0.8 },
          { index: 2, relevanceScore: 0.7 },
        ],
      }),
    });
    const candidates = [
      buildRetrievedElement("a", "First", "f"),
      buildRetrievedElement("b", "Second", "f"),
      buildRetrievedElement("c", "Alternative", "e"),
    ];

    const result = await rerankRetrievedElementsByRelevance(
      {
        metrics: new InferenceMetricsReporter({ enabled: false }),
        model,
        timeoutMs: 1_000,
      },
      "question",
      candidates,
      2,
    );

    expect(result).toEqual([candidates[0], candidates[1]]);
  });

  it("does not call the reranker for an empty discovery candidate pool", async () => {
    const doRerank = vi.fn();
    const model = new MockRerankingModelV4({ doRerank });

    const result = await rerankRetrievedElementsByRelevance(
      {
        metrics: new InferenceMetricsReporter({ enabled: false }),
        model,
        timeoutMs: 1_000,
      },
      "question",
      [],
      2,
    );

    expect(result).toEqual([]);
    expect(doRerank).not.toHaveBeenCalled();
  });

  it("does not call the reranker for an empty answer candidate pool", async () => {
    const doRerank = vi.fn();
    const model = new MockRerankingModelV4({ doRerank });

    const result = await rerankRetrievedElements(
      {
        metrics: new InferenceMetricsReporter({ enabled: false }),
        model,
        timeoutMs: 1_000,
      },
      "question",
      [],
      2,
    );

    expect(result).toEqual([]);
    expect(doRerank).not.toHaveBeenCalled();
  });

  it("filters semantic discovery candidates using the configured provider score", async () => {
    const model = new MockRerankingModelV4({
      doRerank: async () => ({
        ranking: [
          { index: 1, relevanceScore: 0.8 },
          { index: 0, relevanceScore: 0.2 },
        ],
      }),
    });
    const candidates = [
      buildRetrievedElement("a", "Weak semantic match"),
      buildRetrievedElement("b", "Strong semantic match"),
    ];

    const result = await rerankRetrievedElementsAboveThreshold(
      {
        metrics: new InferenceMetricsReporter({ enabled: false }),
        model,
        timeoutMs: 1_000,
      },
      "question",
      candidates,
      2,
      0.5,
    );

    expect(result).toEqual([candidates[1]]);
  });

  it("returns no semantic discovery candidates when every score is below the threshold", async () => {
    const model = new MockRerankingModelV4({
      doRerank: async () => ({
        ranking: [{ index: 0, relevanceScore: -2 }],
      }),
    });

    const result = await rerankRetrievedElementsAboveThreshold(
      {
        metrics: new InferenceMetricsReporter({ enabled: false }),
        model,
        timeoutMs: 1_000,
      },
      "question",
      [buildRetrievedElement("a", "Unrelated")],
      1,
      0,
    );

    expect(result).toEqual([]);
  });

  it("rejects duplicate result indices at the provider boundary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [
        { index: 0, relevance_score: 2 },
        { index: 0, relevance_score: 1 },
      ],
    }), { status: 200 })));

    const model = createHttpRerankingModel(config);
    await expect(model.doRerank({
      documents: { type: "text", values: ["first"] },
      query: "question",
    })).rejects.toThrow("duplicate index 0");
  });

  it("rejects a provider response that omits requested rankings", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      results: [{ index: 0, relevance_score: 1 }],
    }), { status: 200 })));

    const model = createHttpRerankingModel(config);
    await expect(model.doRerank({
      documents: { type: "text", values: ["first", "second"] },
      query: "question",
      topN: 2,
    })).rejects.toThrow("returned 1 results; expected at least 2");
  });
});

function buildRetrievedElement(
  idCharacter: string,
  content: string,
  documentCharacter: string = idCharacter,
): RetrievedElement {
  const elementId = idCharacter.repeat(64);
  return {
    distance: 0.5,
    documentVersionId: "00000000-0000-4000-8000-000000000001",
    element: {
      content,
      documentId: documentCharacter.repeat(64),
      id: elementId,
      detectedTypes: ["paragraph"],
      kind: "text",
      ...buildSourceLocation(1),
      sourceFile: `/tmp/${documentCharacter}.pdf`,
    },
    evidenceContent: content,
    provenance: buildRetrievedElementProvenance(elementId),
  };
}
