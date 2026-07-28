import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClaimVerifierConfig } from "../src/config/index.js";
import {
  HHEM_MODEL_ID,
  HHEM_MODEL_REVISION,
  HhemClientError,
  HttpHhemClient,
  type HhemScoreItem,
} from "../src/verification/hhem-client.js";

const config: ClaimVerifierConfig = {
  baseUrl: "http://hhem.test",
  model: `${HHEM_MODEL_ID}@${HHEM_MODEL_REVISION}`,
  runtimeName: "HHEM test runtime",
  supportThreshold: 0.5,
  timeoutMs: 1_000,
};

const scoreItems: HhemScoreItem[] = [
  { id: "claim-0", evidence: "Alpha evidence", claim: "Alpha claim" },
  { id: "claim-1", evidence: "Beta evidence", claim: "Beta claim" },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("HHEM HTTP client", () => {
  it("sends one strict batch request and restores stable item order", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({ items: scoreItems });
      return scoreResponse([
        { id: "claim-1", supportProbability: 0.2 },
        { id: "claim-0", supportProbability: 0.9 },
      ]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HttpHhemClient(config);
    const results = await client.score(
      scoreItems,
      new AbortController().signal,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      { id: "claim-0", outcome: "scored", supportProbability: 0.9 },
      { id: "claim-1", outcome: "scored", supportProbability: 0.2 },
    ]);
  });

  it("splits large verification workloads across the service request limit", async () => {
    const items: HhemScoreItem[] = [];
    for (let index = 0; index < 65; index += 1) {
      items.push({
        claim: `Claim ${index}`,
        evidence: `Evidence ${index}`,
        id: `claim-${index}`,
      });
    }
    const requestSizes: number[] = [];
    vi.stubGlobal("fetch", vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const body = JSON.parse(String(init?.body)) as { items: HhemScoreItem[] };
      requestSizes.push(body.items.length);
      const results = [];
      for (const item of body.items) {
        results.push({ id: item.id, supportProbability: 0.9 });
      }
      return scoreResponse(results);
    }));

    const results = await new HttpHhemClient(config).score(
      items,
      new AbortController().signal,
    );

    expect(requestSizes).toEqual([64, 1]);
    expect(results).toHaveLength(65);
    expect(results.map((result) => result.id)).toEqual(
      items.map((item) => item.id),
    );
  });

  it("validates readiness model and revision", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      model: HHEM_MODEL_ID,
      revision: HHEM_MODEL_REVISION,
      status: "ready",
    }), { status: 200 })));

    await expect(new HttpHhemClient(config).checkReady()).resolves.toBeUndefined();
  });

  it("rejects readiness from an unpinned model revision", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      model: HHEM_MODEL_ID,
      revision: "unpinned",
      status: "ready",
    }), { status: 200 })));

    await expect(new HttpHhemClient(config).checkReady()).rejects.toMatchObject({
      category: "invalid-response",
    });
  });

  it.each([
    ["invalid JSON", "not-json"],
    [
      "wrong revision",
      JSON.stringify({
        model: HHEM_MODEL_ID,
        results: [
          { id: "claim-0", supportProbability: 0.9 },
          { id: "claim-1", supportProbability: 0.2 },
        ],
        revision: "unpinned",
      }),
    ],
    [
      "missing result",
      JSON.stringify({
        model: HHEM_MODEL_ID,
        results: [{ id: "claim-0", supportProbability: 0.9 }],
        revision: HHEM_MODEL_REVISION,
      }),
    ],
    [
      "unknown result ID",
      JSON.stringify({
        model: HHEM_MODEL_ID,
        results: [
          { id: "claim-0", supportProbability: 0.9 },
          { id: "unknown", supportProbability: 0.2 },
        ],
        revision: HHEM_MODEL_REVISION,
      }),
    ],
    [
      "duplicate result ID",
      JSON.stringify({
        model: HHEM_MODEL_ID,
        results: [
          { id: "claim-0", supportProbability: 0.9 },
          { id: "claim-0", supportProbability: 0.2 },
        ],
        revision: HHEM_MODEL_REVISION,
      }),
    ],
    [
      "out-of-range probability",
      JSON.stringify({
        model: HHEM_MODEL_ID,
        results: [
          { id: "claim-0", supportProbability: 1.1 },
          { id: "claim-1", supportProbability: 0.2 },
        ],
        revision: HHEM_MODEL_REVISION,
      }),
    ],
  ])("rejects %s responses", async (_name, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 200 })));

    await expect(new HttpHhemClient(config).score(
      scoreItems,
      new AbortController().signal,
    )).rejects.toMatchObject({ category: "invalid-response" });
  });

  it("classifies HTTP 503 as retryable service unavailability", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "loading" }),
      { status: 503 },
    )));

    await expect(new HttpHhemClient(config).score(
      scoreItems,
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining({
      category: "service-unavailable",
      retryable: true,
      statusCode: 503,
    }));
  });

  it("classifies a connection failure as service unavailability", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("connection refused");
    }));

    await expect(new HttpHhemClient(config).score(
      scoreItems,
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining({
      category: "service-unavailable",
      retryable: true,
      statusCode: null,
    }));
  });

  it("enforces the configured request timeout", async () => {
    const timeoutConfig = { ...config, timeoutMs: 10 };
    vi.stubGlobal("fetch", vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason);
      }, { once: true });
    })));

    await expect(new HttpHhemClient(timeoutConfig).score(
      scoreItems,
      new AbortController().signal,
    )).rejects.toEqual(expect.objectContaining({
      category: "timeout",
      retryable: true,
      statusCode: null,
    }));
  });

  it("preserves caller aborts instead of relabeling them as timeouts", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason);
      }, { once: true });
    })));
    const request = new HttpHhemClient(config).score(scoreItems, controller.signal);
    controller.abort(new Error("caller aborted"));

    await expect(request).rejects.not.toBeInstanceOf(HhemClientError);
  });
});

function scoreResponse(
  results: Array<{ id: string; supportProbability: number }>,
): Response {
  return new Response(JSON.stringify({
    model: HHEM_MODEL_ID,
    results: results.map((result) => ({ ...result, outcome: "scored" })),
    revision: HHEM_MODEL_REVISION,
  }), { status: 200 });
}
