import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTestModelCapabilities } from "./model-capabilities-fixture.js";

import {
  readAnswerClaims,
  verifyAnswerClaims,
  verifyPublishedAnswer,
  verifyPublishedAnswerClaims,
} from "../src/answers/claim-verification.js";
import { TaskLimiter } from "../src/shared/concurrency.js";
import type { AnswerSource } from "../src/answers/inference.js";
import {
  decodePublishedAnswerDocument,
  type PublishedAnswerDocument,
} from "../src/answers/published.js";
import {
  HHEM_DISPLAY_MODEL,
  HhemClientError,
  type HhemScoreResult,
} from "../src/verification/hhem-client.js";
import { InferenceMetricsReporter } from "../src/inference/metrics.js";
import type { InferenceModelRegistry } from "../src/inference/registry.js";
import {
  noopRunTelemetry,
  type RunTelemetry,
} from "../src/observability/run.js";
import { FakeHhemClient } from "./hhem-fixture.js";
import { buildSourceLocation } from "./source-element-fixture.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("claim verification", () => {
  it("splits factual sentences and preserves their local citations", () => {
    expect(readAnswerClaims([
      "## Findings",
      "Revenue increased by 12 percent [1]. Costs declined [2] [3].",
      "- The outlook remained stable.",
    ].join("\n"))).toEqual([
      {
        citationNumbers: [1],
        claim: "Revenue increased by 12 percent.",
        claimIndex: 0,
      },
      {
        citationNumbers: [2, 3],
        claim: "Costs declined.",
        claimIndex: 1,
      },
      {
        citationNumbers: [],
        claim: "The outlook remained stable.",
        claimIndex: 2,
      },
    ]);
  });

  it("sends every cited claim in one batch with isolated evidence and no question", async () => {
    const verifier = buildProbabilityVerifier(new Map([
      ["claim-0-citation-1", 0.777],
      ["claim-1-citation-2", 0.164],
    ]));
    const forbiddenQuestion = "What are the rules of evidence in Canada?";
    const claims = readAnswerClaims(
      "Evidence law is judge-made [1]. The collateral-fact rule applies [2].",
    );

    const checks = await verifyAnswerClaims(
      buildModels(verifier),
      claims,
      [
        buildSource(1, "The law of evidence is primarily judge-made."),
        buildSource(2, "The source discusses expert evidence only."),
      ],
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verifier.scoreCalls).toHaveLength(1);
    expect(verifier.scoreCalls[0]).toEqual([
      {
        claim: "Evidence law is judge-made.",
        evidence: [
          "[Citation 1]",
          "The law of evidence is primarily judge-made.",
        ].join("\n"),
        id: "claim-0-citation-1",
      },
      {
        claim: "The collateral-fact rule applies.",
        evidence: [
          "[Citation 2]",
          "The source discusses expert evidence only.",
        ].join("\n"),
        id: "claim-1-citation-2",
      },
    ]);
    expect(JSON.stringify(verifier.scoreCalls[0])).not.toContain(forbiddenQuestion);
    expect(checks).toMatchObject([
      { ...claims[0], status: "supported", verifierModel: HHEM_DISPLAY_MODEL },
      { ...claims[1], status: "unsupported", verifierModel: HHEM_DISPLAY_MODEL },
    ]);
    expect(checks[0]?.evidenceUnits).toHaveLength(1);
    expect(checks[1]?.evidenceUnits).toHaveLength(1);
  });

  it("uses stable IDs to restore response order", async () => {
    const verifier = new FakeHhemClient(0.5, async (items) => {
      const results: HhemScoreResult[] = [];
      for (const item of [...items].reverse()) {
        results.push({
          id: item.id,
          outcome: "scored",
          supportProbability: item.id === "claim-0-citation-1" ? 0.9 : 0.1,
        });
      }
      return results;
    });
    const claims = readAnswerClaims("Supported [1]. Unsupported [2].");

    const checks = await verifyAnswerClaims(
      buildModels(verifier),
      claims,
      [buildSource(1), buildSource(2)],
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(checks.map((check) => check.status)).toEqual([
      "supported",
      "unsupported",
    ]);
  });

  it("scores identical claim and evidence pairs once and fans out the result", async () => {
    const verifier = new FakeHhemClient(0.5, async (items) => {
      return items.map((item) => ({
        id: item.id,
        outcome: "scored" as const,
        supportProbability: 0.9,
      }));
    });
    const claims = readAnswerClaims(
      "Revenue increased [1]. Revenue increased [1].",
    );

    const checks = await verifyAnswerClaims(
      buildModels(verifier),
      claims,
      [buildSource(1, "Revenue increased.")],
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verifier.scoreCalls).toHaveLength(1);
    expect(verifier.scoreCalls[0]).toHaveLength(1);
    expect(checks).toHaveLength(2);
    expect(checks.map((check) => check.status)).toEqual([
      "supported",
      "supported",
    ]);
    expect(checks.map((check) => check.claimIndex)).toEqual([0, 1]);
  });

  it("does not merge different claims that cite the same evidence", async () => {
    const verifier = new FakeHhemClient(0.5, async (items) => {
      return items.map((item) => ({
        id: item.id,
        outcome: "scored" as const,
        supportProbability: 0.9,
      }));
    });
    const claims = readAnswerClaims(
      "Revenue increased [1]. Costs decreased [1].",
    );

    await verifyAnswerClaims(
      buildModels(verifier),
      claims,
      [buildSource(1, "Revenue increased while costs decreased.")],
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verifier.scoreCalls).toHaveLength(1);
    expect(verifier.scoreCalls[0]).toHaveLength(2);
  });

  it("verifies every citation independently and reports partial support", async () => {
    const verifier = buildProbabilityVerifier(new Map([
      ["claim-0-citation-1", 0.9],
      ["claim-0-citation-2", 0.1],
    ]));

    const checks = await verifyAnswerClaims(
      buildModels(verifier),
      readAnswerClaims("Revenue changed [1] [2]."),
      [
        buildSource(1, "Revenue changed."),
        buildSource(2, "The report discusses expenses."),
      ],
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verifier.scoreCalls[0]).toHaveLength(2);
    expect(checks[0]?.status).toBe("partially-supported");
    expect(checks[0]?.evidenceUnits.map((unit) => unit.outcome)).toEqual([
      "supported",
      "unsupported",
    ]);
  });

  it("reports partial support without changing the published answer", async () => {
    const verifier = buildProbabilityVerifier(new Map([
      ["claim-0-citation-1", 0.9],
      ["claim-0-citation-2", 0.1],
    ]));
    const document = buildPublishedAnswer(
      [
        buildSource(1, "Revenue changed."),
        buildSource(2, "The report discusses expenses."),
      ],
      [1, 2],
    );

    const verified = await verifyPublishedAnswer(
      buildModels(verifier),
      document,
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verifier.scoreCalls).toHaveLength(1);
    expect(verified.answerDocument).toBe(document);
    expect(verified.answerDocument.citations).toHaveLength(2);
    expect(verified.claims).toMatchObject([{
      citationNumbers: [1, 2],
      claim: "Revenue changed.",
      claimIndex: 0,
      evidenceUnits: [
        {
          citationNumber: 1,
          outcome: "supported",
          unitId: "claim-0-citation-1",
        },
        {
          citationNumber: 2,
          outcome: "unsupported",
          unitId: "claim-0-citation-2",
        },
      ],
      status: "partially-supported",
    }]);
  });

  it("does not run a collective check when individual evidence is partially supported", async () => {
    const verifier = new FakeHhemClient(0.5, async (items) => {
      return items.map((item) => {
        let supportProbability = 0.1;
        if (
          item.id.endsWith("citation-1")
          || item.id.endsWith("citation-2")
        ) {
          supportProbability = 0.9;
        }
        return {
          id: item.id,
          outcome: "scored" as const,
          supportProbability,
        };
      });
    });
    const document = buildPublishedAnswer(
      [
        buildSource(1, "Revenue changed."),
        buildSource(2, "Revenue changed during the reporting period."),
        buildSource(3, "The report discusses expenses."),
      ],
      [1, 2, 3],
    );

    const verified = await verifyPublishedAnswer(
      buildModels(verifier),
      document,
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verifier.scoreCalls).toHaveLength(1);
    expect(verified.answerDocument).toBe(document);
    expect(verified.claims[0]).toMatchObject({
      citationNumbers: [1, 2, 3],
      status: "partially-supported",
    });
  });

  it("does not prune when the complete remaining evidence set fails validation", async () => {
    const verifier = new FakeHhemClient(0.5, async (items) => {
      return items.map((item) => {
        const supportProbability = item.id.endsWith("citation-3") ? 0.1 : 0.9;
        return {
          id: item.id,
          outcome: "scored" as const,
          supportProbability,
        };
      });
    });
    const document = buildPublishedAnswer(
      [
        buildSource(1, "Revenue changed."),
        buildSource(2, "Revenue changed during the reporting period."),
        buildSource(3, "The report discusses expenses."),
      ],
      [1, 2, 3],
    );

    const verified = await verifyPublishedAnswer(
      buildModels(verifier),
      document,
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verified.answerDocument.citations).toHaveLength(3);
    expect(verified.claims[0]).toMatchObject({
      citationNumbers: [1, 2, 3],
      status: "partially-supported",
    });
  });

  it("does not combine individually unsupported citations into collective support", async () => {
    const verifier = new FakeHhemClient(0.5, async (items) => {
      return items.map((item) => ({
        id: item.id,
        outcome: "scored" as const,
        supportProbability: 0.1,
      }));
    });
    const document = buildPublishedAnswer(
      [
        buildSource(1, "Revenue increased."),
        buildSource(2, "Costs decreased."),
      ],
      [1, 2],
      "Profit improved because revenue increased and costs decreased.",
    );

    const verified = await verifyPublishedAnswer(
      buildModels(verifier),
      document,
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verifier.scoreCalls).toHaveLength(1);
    expect(verifier.scoreCalls[0]).toHaveLength(2);
    expect(verified.answerDocument.citations).toHaveLength(2);
    expect(verified.claims[0]).toMatchObject({
      citationNumbers: [1, 2],
      status: "unsupported",
    });
    expect(verified.claims[0]?.evidenceUnits.map((unit) => unit.outcome)).toEqual([
      "unsupported",
      "unsupported",
    ]);
  });

  it("retains a published statement when all of its citations are unsupported", async () => {
    const verifier = new FakeHhemClient(0.5, async (items) => {
      return items.map((item) => ({
        id: item.id,
        outcome: "scored" as const,
        supportProbability: 0.1,
      }));
    });
    const document = buildPublishedAnswer(
      [
        buildSource(1, "The report discusses expenses."),
        buildSource(2, "The report discusses staffing."),
      ],
      [1, 2],
      "Revenue changed.",
    );

    const verified = await verifyPublishedAnswer(
      buildModels(verifier),
      document,
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verifier.scoreCalls).toHaveLength(1);
    expect(verified.answerDocument).toBe(document);
    expect(verified.claims).toMatchObject([{
      citationNumbers: [1, 2],
      status: "unsupported",
    }]);
  });

  it("records unsupported evidence without changing published citations", async () => {
    const verifier = buildProbabilityVerifier(new Map([
      ["claim-0-citation-1", 0.1],
    ]));
    const document = buildPublishedAnswer([buildSource()], [1]);

    const verified = await verifyPublishedAnswer(
      buildModels(verifier),
      document,
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verified.answerDocument).toBe(document);
    expect(verified.claims).toMatchObject([{
      citationNumbers: [1],
      status: "unsupported",
    }]);
  });

  it("returns no checks for a published uncited document", async () => {
    const verifier = new FakeHhemClient();
    const document = decodePublishedAnswerDocument({
      citations: [],
      content: "The supplied source material does not identify the answer.",
      schemaVersion: 2,
      statements: [],
    });

    const verified = await verifyPublishedAnswer(
      buildModels(verifier),
      document,
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verifier.scoreCalls).toHaveLength(0);
    expect(verified).toEqual({ answerDocument: document, claims: [] });
  });

  it("does not start verifier telemetry when no statements were selected", async () => {
    const verifier = new FakeHhemClient();
    const document = buildPublishedAnswer([buildSource()], [1]);
    const startStage = vi.fn();

    const verified = await verifyPublishedAnswerClaims(
      buildModels(verifier),
      document,
      [],
      new TaskLimiter(1),
      new AbortController().signal,
      { ...noopRunTelemetry, startStage },
    );

    expect(verifier.scoreCalls).toHaveLength(0);
    expect(startStage).not.toHaveBeenCalled();
    expect(verified).toEqual({ answerDocument: document, claims: [] });
  });

  it("preserves unsupported and verifier-incompatible evidence as unverified", async () => {
    const verifier = buildProbabilityVerifier(new Map([
      ["claim-0-citation-1", 0.1],
    ]));
    const image = buildSource(2, "unused");
    image.evidence = {
      kind: "image",
      mimeType: "image/png",
    };
    image.kind = "image";
    const document = buildPublishedAnswer(
      [
        buildSource(1, "The report discusses expenses."),
        image,
      ],
      [1, 2],
      "The chart shows that revenue changed.",
    );

    const verified = await verifyPublishedAnswer(
      buildModels(verifier),
      document,
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verifier.scoreCalls).toHaveLength(1);
    expect(verified.answerDocument.citations).toHaveLength(2);
    expect(verified.claims[0]).toMatchObject({
      citationNumbers: [1, 2],
      status: "unsupported",
    });
    expect(verified.claims[0]?.evidenceUnits.map((unit) => unit.outcome)).toEqual([
      "unsupported",
      "verifier-incompatible",
    ]);
  });

  it("reports mixed support while preserving all published evidence", async () => {
    const verifier = buildProbabilityVerifier(new Map([
      ["claim-0-citation-1", 0.9],
      ["claim-0-citation-2", 0.1],
    ]));
    const image = buildSource(3, "unused");
    image.evidence = {
      kind: "image",
      mimeType: "image/png",
    };
    image.kind = "image";
    const document = buildPublishedAnswer(
      [
        buildSource(1, "The chart shows that revenue changed."),
        buildSource(2, "The report discusses expenses."),
        image,
      ],
      [1, 2, 3],
      "The chart shows that revenue changed.",
    );

    const verified = await verifyPublishedAnswer(
      buildModels(verifier),
      document,
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verifier.scoreCalls).toHaveLength(1);
    expect(verified.answerDocument).toBe(document);
    expect(verified.answerDocument.citations).toHaveLength(3);
    expect(verified.claims[0]).toMatchObject({
      citationNumbers: [1, 2, 3],
      evidenceUnits: [
        { citationNumber: 1, outcome: "supported" },
        { citationNumber: 2, outcome: "unsupported" },
        { citationNumber: 3, outcome: "verifier-incompatible" },
      ],
      status: "partially-supported",
    });
    expect(JSON.stringify(verified)).toContain("expenses");
  });

  it("preserves unsupported and not-evaluated evidence as unverified", async () => {
    const verifier = new FakeHhemClient(0.5, async (items) => {
      return items.map((item) => {
        if (item.id.endsWith("citation-2")) {
          return {
            id: item.id,
            outcome: "model-context-capacity" as const,
          };
        }
        return {
          id: item.id,
          outcome: "scored" as const,
          supportProbability: 0.1,
        };
      });
    });
    const document = buildPublishedAnswer(
      [
        buildSource(1, "The report discusses expenses."),
        buildSource(2, "The report contains a very large evidence window."),
      ],
      [1, 2],
    );

    const verified = await verifyPublishedAnswer(
      buildModels(verifier),
      document,
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verifier.scoreCalls).toHaveLength(1);
    expect(verified.answerDocument.citations).toHaveLength(2);
    expect(verified.claims[0]).toMatchObject({
      citationNumbers: [1, 2],
      status: "unsupported",
    });
    expect(verified.claims[0]?.evidenceUnits.map((unit) => unit.outcome)).toEqual([
      "unsupported",
      "not-evaluated",
    ]);
  });

  it("retains a conflict group and records one unsupported position", async () => {
    const verifier = new FakeHhemClient(0.5, async (items) => {
      return items.map((item) => ({
        id: item.id,
        outcome: "scored" as const,
        supportProbability: item.claim === "Revenue decreased." ? 0.1 : 0.9,
      }));
    });
    const document = buildPublishedConflictAnswer();

    const verified = await verifyPublishedAnswer(
      buildModels(verifier),
      document,
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verified.answerDocument).toBe(document);
    expect(verified.claims.map((claim) => claim.status)).toEqual([
      "supported",
      "supported",
      "unsupported",
      "supported",
    ]);
  });

  it("records final fallback counts in claim-verification telemetry", async () => {
    const finishStage = vi.fn(async () => undefined);
    const runTelemetry: RunTelemetry = {
      ...noopRunTelemetry,
      startStage: () => ({
        finish: finishStage,
        timingObserver: {
          completed: () => undefined,
          started: () => undefined,
        },
      }),
    };
    const verifier = buildProbabilityVerifier(new Map([
      ["claim-0-citation-1", 0.1],
    ]));

    await verifyPublishedAnswer(
      buildModels(verifier),
      buildPublishedAnswer([buildSource()], [1]),
      new TaskLimiter(1),
      new AbortController().signal,
      runTelemetry,
    );

    expect(finishStage).toHaveBeenCalledWith({
      inputCount: 1,
      inputTokens: null,
      outcome: "success",
      outputCount: 1,
      outputTokens: null,
    });
  });

  it("does not represent HHEM model capacity as unsupported evidence", async () => {
    const verifier = new FakeHhemClient(0.5, async (items) => items.map((item) => {
      if (item.id === "claim-0-citation-2") {
        return { id: item.id, outcome: "model-context-capacity" as const };
      }
      return {
        id: item.id,
        outcome: "scored" as const,
        supportProbability: 0.9,
      };
    }));

    const checks = await verifyAnswerClaims(
      buildModels(verifier),
      readAnswerClaims("Revenue changed [1] [2]."),
      [buildSource(1), buildSource(2)],
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(checks[0]?.status).toBe("supported");
    expect(checks[0]?.evidenceUnits).toEqual([
      expect.objectContaining({ outcome: "supported", supportProbability: 0.9 }),
      expect.objectContaining({ outcome: "not-evaluated", supportProbability: null }),
    ]);
  });

  it("is invariant to citation ordering when every unit is evaluated", async () => {
    const verifier = new FakeHhemClient(0.5, async (items) => items.map((item) => ({
      id: item.id,
      outcome: "scored" as const,
      supportProbability: item.evidence.includes("supports") ? 0.9 : 0.1,
    })));
    const sources = [
      buildSource(1, "This supports the claim."),
      buildSource(2, "This is unrelated."),
    ];
    const first = await verifyAnswerClaims(
      buildModels(verifier),
      readAnswerClaims("Claim [1] [2]."),
      sources,
      new TaskLimiter(1),
      new AbortController().signal,
    );
    const second = await verifyAnswerClaims(
      buildModels(verifier),
      readAnswerClaims("Claim [2] [1]."),
      sources,
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(first[0]?.status).toBe("partially-supported");
    expect(second[0]?.status).toBe("partially-supported");
  });

  it("includes section headings and preserves complete cited evidence", async () => {
    const verifier = new FakeHhemClient();
    const source = buildSource(1, "x".repeat(16_050));
    source.sectionPath = ["Canadian Evidence Law", "Sources"];

    await verifyAnswerClaims(
      buildModels(verifier),
      readAnswerClaims("Evidence law is judge-made [1]."),
      [source],
      new TaskLimiter(1),
      new AbortController().signal,
    );

    const evidence = verifier.scoreCalls[0]?.[0]?.evidence;
    expect(evidence).toBe([
      "[Citation 1]",
      "Section: Canadian Evidence Law > Sources",
      "x".repeat(16_050),
    ].join("\n"));
  });

  it("allows support late in a complete cited evidence window to affect verification", async () => {
    const verifier = new FakeHhemClient(0.5, async (items) => items.map((item) => ({
      id: item.id,
      outcome: "scored" as const,
      supportProbability: item.evidence.endsWith("late support") ? 0.9 : 0.1,
    })));
    const evidence = `${"unrelated context ".repeat(100)}late support`;

    const checks = await verifyAnswerClaims(
      buildModels(verifier),
      readAnswerClaims("The late fact is supported [1]."),
      [buildSource(1, evidence)],
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verifier.scoreCalls[0]?.[0]?.evidence).toContain("late support");
    expect(checks[0]?.status).toBe("supported");
  });

  it("marks uncited and image-only claims unverified without calling HHEM", async () => {
    const verifier = new FakeHhemClient();
    const imageSource = buildSource();
    imageSource.evidence = {
      kind: "image",
      mimeType: "image/png",
    };

    const checks = await verifyAnswerClaims(
      buildModels(verifier),
      readAnswerClaims("An uncited fact. An image claim [1]."),
      [imageSource],
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verifier.scoreCalls).toHaveLength(0);
    expect(checks.map((check) => check.status)).toEqual([
      "unverified",
      "unverified",
    ]);
    expect(checks[1]?.rationale).toContain("no text or table citation");
  });

  it("uses the configurable threshold deterministically", async () => {
    const verifier = new FakeHhemClient(0.8, async (items) => [{
      id: items[0]?.id ?? "missing",
      outcome: "scored",
      supportProbability: 0.777,
    }]);

    const checks = await verifyAnswerClaims(
      buildModels(verifier),
      readAnswerClaims("Revenue increased [1]."),
      [buildSource()],
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(checks[0]).toMatchObject({
      rationale:
        "HHEM support probability 0.777 is below the configured 0.800 threshold.",
      status: "unsupported",
    });
  });

  it("rejects unavailable citation evidence before making a request", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const verifier = new FakeHhemClient();

    await expect(verifyAnswerClaims(
      buildModels(verifier),
      readAnswerClaims("Revenue increased [2]."),
      [buildSource()],
      new TaskLimiter(1),
      new AbortController().signal,
    )).rejects.toThrow("unavailable citation 2");

    expect(verifier.scoreCalls).toHaveLength(0);
    expect(reportError).toHaveBeenCalledWith(JSON.stringify({
      error: {
        category: "invalid-evidence",
        retryable: false,
        statusCode: null,
      },
      level: "error",
      operation: "claim-verification",
    }));
  });

  it("reports unavailable service failures without logging private evidence", async () => {
    const reportError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const verifier = new FakeHhemClient(0.5, async () => {
      throw new HhemClientError(
        "service-unavailable",
        "HHEM is unavailable.",
        true,
        503,
      );
    });

    await expect(verifyAnswerClaims(
      buildModels(verifier),
      readAnswerClaims("Private revenue increased [1]."),
      [buildSource(1, "Private revenue evidence")],
      new TaskLimiter(1),
      new AbortController().signal,
    )).rejects.toThrow("HHEM is unavailable");

    expect(reportError).toHaveBeenCalledWith(JSON.stringify({
      error: {
        category: "service-unavailable",
        retryable: true,
        statusCode: 503,
      },
      level: "error",
      operation: "claim-verification",
    }));
    expect(reportError.mock.calls[0]?.[0]).not.toContain("Private revenue");
  });

  it("passes every cited claim to the verifier without an answer-level cap", async () => {
    const verifier = new FakeHhemClient();
    const answerParts: string[] = [];
    for (let index = 0; index < 65; index += 1) {
      answerParts.push(`Fact ${index} is stated [1].`);
    }

    const checks = await verifyAnswerClaims(
      buildModels(verifier),
      readAnswerClaims(answerParts.join(" ")),
      [buildSource()],
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verifier.scoreCalls).toHaveLength(1);
    expect(verifier.scoreCalls[0]).toHaveLength(65);
    expect(checks).toHaveLength(65);
  });

  it("marks a claim outside the verifier service input contract as unverified", async () => {
    const verifier = new FakeHhemClient();
    const claim = {
      citationNumbers: [1],
      claim: "a".repeat(2_001),
      claimIndex: 0,
    };

    const checks = await verifyAnswerClaims(
      buildModels(verifier),
      [claim],
      [buildSource()],
      new TaskLimiter(1),
      new AbortController().signal,
    );

    expect(verifier.scoreCalls).toHaveLength(0);
    expect(checks).toMatchObject([{
      ...claim,
      status: "unverified",
      verifierModel: HHEM_DISPLAY_MODEL,
    }]);
    expect(checks[0]?.evidenceUnits).toEqual([{
      citationNumber: 1,
      outcome: "not-evaluated",
      rationale: "The claim exceeds the HHEM service input size.",
      supportProbability: null,
      unitId: "claim-0-citation-1",
    }]);
  });
});

function buildProbabilityVerifier(
  probabilityById: ReadonlyMap<string, number>,
): FakeHhemClient {
  return new FakeHhemClient(0.5, async (items) => {
    const results: HhemScoreResult[] = [];
    for (const item of items) {
      const supportProbability = probabilityById.get(item.id);
      if (supportProbability === undefined) {
        throw new Error(`Missing probability fixture for ${item.id}.`);
      }
      results.push({ id: item.id, outcome: "scored", supportProbability });
    }
    return results;
  });
}

function buildModels(claimVerifier: FakeHhemClient): InferenceModelRegistry {
  const languageModel = new MockLanguageModelV4();
  const embedding = new MockEmbeddingModelV4();
  return {
    answer: languageModel,
    answerBudget: { maximumOutputTokens: 16_384, minimumOutputTokens: 256, providerSafetyMarginTokens: 0 },
    readAnswerCapabilities: async () => buildTestModelCapabilities(),
    claimVerifier,
    documentEmbedding: embedding,
    metrics: new InferenceMetricsReporter({ enabled: false }),
    queryExpansion: languageModel,
    queryEmbedding: embedding,
    reranker: null,
    indexing: languageModel,
    timeouts: {
      answerMs: 900_000,
      embeddingMs: 600_000,
      indexingMs: 900_000,
      queryExpansionMs: 900_000,
    },
  };
}

function buildSource(
  citationNumber = 1,
  excerpt = "Revenue increased.",
): AnswerSource {
  return {
    citationNumber,
    documentId: "a".repeat(64),
    documentVersionId: "00000000-0000-4000-8000-000000000001",
    elementId: "b".repeat(64),
    evidence: { excerpt, kind: "text" },
    id: `00000000-0000-4000-8000-${String(citationNumber).padStart(12, "0")}`,
    kind: "text",
    pageNumbers: [1],
    regions: buildSourceLocation(1).regions,
    sectionPath: [],
    sourceFile: "/documents/report.pdf",
  };
}

function buildPublishedAnswer(
  citations: AnswerSource[],
  citationNumbers: number[],
  content = "Revenue changed.",
): PublishedAnswerDocument {
  const citationByNumber = new Map<number, AnswerSource>();
  for (const citation of citations) {
    citationByNumber.set(citation.citationNumber, citation);
  }
  const citationIds: string[] = [];
  for (const citationNumber of citationNumbers) {
    const citation = citationByNumber.get(citationNumber);
    if (citation === undefined) {
      throw new Error(`Missing test citation ${citationNumber}.`);
    }
    citationIds.push(citation.id);
  }
  return decodePublishedAnswerDocument({
    citations,
    content: "The evidence is summarized below.",
    schemaVersion: 2,
    statements: [{
      citationIds,
      content,
      presentation: "paragraph",
      section: "answer",
    }],
  });
}

function buildPublishedConflictAnswer(): PublishedAnswerDocument {
  const first = buildSource(1, "Revenue increased.");
  const second = buildSource(2, "Revenue decreased.");
  return decodePublishedAnswerDocument({
    citations: [first, second],
    content: "The sources report conflicting revenue directions.",
    schemaVersion: 2,
    statements: [{
      citationIds: [first.id, second.id],
      content:
        "Shared scope - context: the entity; scope: the report; conditions: the same basis; time period: 2025.",
      presentation: "paragraph",
      section: "conflicting-evidence",
    }, {
      citationIds: [first.id],
      content: "Revenue increased.",
      presentation: "bullet",
      section: "conflicting-evidence",
    }, {
      citationIds: [second.id],
      content: "Revenue decreased.",
      presentation: "bullet",
      section: "conflicting-evidence",
    }, {
      citationIds: [first.id, second.id],
      content: "The same revenue cannot both increase and decrease.",
      presentation: "paragraph",
      section: "conflicting-evidence",
    }],
  });
}
