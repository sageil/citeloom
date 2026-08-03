import { describe, expect, it } from "vitest";

import {
  readAnswerClaims,
  verifyAnswerClaims,
} from "../src/answers/claim-verification.js";
import type { AnswerSource } from "../src/answers/inference.js";
import { TaskLimiter } from "../src/shared/concurrency.js";
import {
  HHEM_MODEL_ID,
  HHEM_MODEL_REVISION,
  HttpHhemClient,
  type HhemClient,
  type HhemScoreItem,
  type HhemScoreResult,
} from "../src/verification/hhem-client.js";
import { createInferenceModelRegistry } from "../src/inference/registry.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";
import { buildSourceLocation } from "./source-element-fixture.js";

const runLiveIntegration = process.env.HHEM_LIVE_TEST === "true";

describe.skipIf(!runLiveIntegration)("live HHEM integration", () => {
  const config = readEqualWeightTestConfig({
    database: {
      url: process.env.DATABASE_URL
        ?? "postgresql://citeloom:citeloom@127.0.0.1:5432/citeloom",
    },
    providerOptions: {
      inferenceBaseUrl: "http://127.0.0.1:11434/v1",
    },
    runtime: {
      claimVerifierBaseUrl:
        process.env.HHEM_BASE_URL ?? "http://127.0.0.1:8088",
      claimVerifierTimeoutSeconds: 180,
    },
  });
  it("reproduces the six pinned validation cases and exact reorder invariance", async () => {
    const client = new HttpHhemClient(config.claimVerifier);
    const items: HhemScoreItem[] = [
      {
        claim: "The law of evidence is primarily judge-made.",
        evidence: "The law of evidence is primarily judge-made.",
        id: "validation-0",
      },
      {
        claim: "The claim concerns Canadian law.",
        evidence: "The law of evidence is primarily judge-made.",
        id: "validation-1",
      },
      {
        claim: "The claim concerns Canadian law.",
        evidence:
          "Section: Canadian Evidence Law. The law of evidence is primarily judge-made.",
        id: "validation-2",
      },
      {
        claim: "Judges may exclude any evidence for any reason.",
        evidence:
          "Trial judges may exclude evidence when its prejudicial effect exceeds its probative value.",
        id: "validation-3",
      },
      {
        claim: "The capital of France is Paris.",
        evidence: "The capital of France is Berlin.",
        id: "validation-4",
      },
      {
        claim: "Trial judges determine whether expert evidence is admissible.",
        evidence:
          "The trial judge acts as gatekeeper when deciding whether expert evidence is admissible.",
        id: "validation-5",
      },
    ];

    const scores = await client.score(items, AbortSignal.timeout(180_000));
    const reversedScores = await client.score(
      [...items].reverse(),
      AbortSignal.timeout(180_000),
    );
    const scoreById = new Map(scores.map((score) => [score.id, readScoredProbability(score)]));
    const reversedScoreById = new Map(
      reversedScores.map((score) => [score.id, readScoredProbability(score)]),
    );

    expect(scores.map(readScoredProbability)).toEqual([
      expect.closeTo(0.7769169211, 6),
      expect.closeTo(0.0878118277, 6),
      expect.closeTo(0.9376132488, 6),
      expect.closeTo(0.1002428383, 6),
      expect.closeTo(0.0110615138, 6),
      expect.closeTo(0.8745192289, 6),
    ]);
    let maximumDelta = 0;
    for (const item of items) {
      const score = scoreById.get(item.id);
      const reversedScore = reversedScoreById.get(item.id);
      if (score === undefined || reversedScore === undefined) {
        throw new Error(`Missing validation score for ${item.id}.`);
      }
      maximumDelta = Math.max(maximumDelta, Math.abs(score - reversedScore));
    }
    expect(maximumDelta).toBe(0);
  }, 240_000);

  it("scores twenty isolated claims in one batch with one unsupported claim", async () => {
    const fixture = buildBatchVerificationFixture();
    const recordingClient = new RecordingHhemClient(
      new HttpHhemClient(config.claimVerifier),
    );
    const models = {
      ...createInferenceModelRegistry(config),
      claimVerifier: recordingClient,
    };

    const checks = await verifyAnswerClaims(
      models,
      fixture.claims,
      fixture.sources,
      new TaskLimiter(1),
      AbortSignal.timeout(180_000),
    );

    expect(recordingClient.scoreCalls).toHaveLength(1);
    expect(recordingClient.scoreCalls[0]).toHaveLength(20);
    expect(recordingClient.scoreCalls[0]?.every((item) => {
      return Object.keys(item).sort().join(",") === "claim,evidence,id";
    })).toBe(true);
    expect(checks).toHaveLength(20);
    const scores = recordingClient.scoreResults[0] ?? [];
    expect(scores.filter((score) => readScoredProbability(score) < 0.5)).toEqual([
      {
        id: "claim-16-citation-17",
        outcome: "scored",
        supportProbability: expect.closeTo(0.010, 3),
      },
    ]);
    expect(checks.filter((check) => check.status === "supported")).toHaveLength(19);
    expect(checks.find((check) => check.claimIndex === 16)).toMatchObject({
      rationale:
        "HHEM support probability 0.010 is below the configured 0.500 threshold.",
      status: "unsupported",
    });
    for (const result of scores) {
      if (result.id === "claim-16-citation-17") {
        expect(readScoredProbability(result)).toBeCloseTo(0.010, 3);
      } else {
        expect(readScoredProbability(result)).toBeGreaterThan(0.72);
      }
    }
    expect(JSON.stringify(recordingClient.scoreCalls[0])).not.toContain(
      "What are the rules of evidence in Canada?",
    );
  }, 240_000);
});

function buildBatchVerificationFixture(): {
  claims: ReturnType<typeof readAnswerClaims>;
  sources: AnswerSource[];
} {
  const answerSentences: string[] = [];
  const sources: AnswerSource[] = [];
  for (let index = 0; index < 20; index += 1) {
    const citationNumber = index + 1;
    const claim = index === 16
      ? "The capital of France is Paris."
      : `Validation fact ${citationNumber} is supported.`;
    const evidence = index === 16
      ? "The capital of France is Berlin."
      : claim;
    answerSentences.push(`${claim.slice(0, -1)} [${citationNumber}].`);
    sources.push(buildAnswerSource(citationNumber, evidence));
  }
  return {
    claims: readAnswerClaims(answerSentences.join(" ")),
    sources,
  };
}

function buildAnswerSource(
  citationNumber: number,
  excerpt: string,
): AnswerSource {
  return {
    citationNumber,
    documentId: "a".repeat(64),
    documentVersionId: "00000000-0000-4000-8000-000000000001",
    elementId: String(citationNumber).padStart(64, "0"),
    evidence: { excerpt, kind: "text" },
    id: `00000000-0000-4000-8000-${String(citationNumber).padStart(12, "0")}`,
    kind: "text",
    pageNumbers: [citationNumber],
    regions: buildSourceLocation(citationNumber).regions,
    sectionPath: [],
    sourceFile: "/documents/hhem-batch-fixture.pdf",
  };
}

class RecordingHhemClient implements HhemClient {
  public readonly scoreCalls: Array<readonly HhemScoreItem[]> = [];
  public readonly scoreResults: HhemScoreResult[][] = [];

  public constructor(private readonly delegate: HhemClient) {}

  public get modelId(): string {
    return `${HHEM_MODEL_ID}@${HHEM_MODEL_REVISION}`;
  }

  public get provider(): string {
    return this.delegate.provider;
  }

  public get supportThreshold(): number {
    return this.delegate.supportThreshold;
  }

  public async checkReady(abortSignal?: AbortSignal): Promise<void> {
    await this.delegate.checkReady(abortSignal);
  }

  public async score(
    items: readonly HhemScoreItem[],
    abortSignal: AbortSignal,
  ): Promise<HhemScoreResult[]> {
    this.scoreCalls.push(items);
    const results = await this.delegate.score(items, abortSignal);
    this.scoreResults.push(results);
    return results;
  }
}

function readScoredProbability(result: HhemScoreResult): number {
  if (result.outcome !== "scored") {
    throw new Error(`Expected a scored HHEM result, received ${result.outcome}.`);
  }
  return result.supportProbability;
}
