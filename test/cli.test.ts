import { describe, expect, it } from "vitest";

import { parseCliCommand } from "../src/cli/index.js";
import { parseEvaluationCommand } from "../tools/evaluation/cli.js";

describe("parseCliCommand", () => {
  it("parses host authentication recovery as report-only unless applied", () => {
    expect(parseCliCommand(["auth", "recover-local"])).toEqual({
      apply: false,
      name: "auth-recover-local",
    });
    expect(parseCliCommand(["auth", "recover-local", "--apply"])).toEqual({
      apply: true,
      name: "auth-recover-local",
    });
    expect(() => parseCliCommand([
      "auth",
      "recover-local",
      "--force",
    ])).toThrow("auth recover-local [--apply]");
  });

  it("parses multiple ingestion inputs and options", () => {
    expect(
      parseCliCommand([
        "ingest",
        "--enqueue",
        "--recursive",
        "--force",
        "--tag",
        "finance",
        "reports",
        "appendix.pdf",
      ]),
    ).toEqual({
      enqueue: true,
      force: true,
      inputPaths: ["reports", "appendix.pdf"],
      name: "ingest",
      recursive: true,
      tags: ["finance"],
    });
  });

  it("parses worker modes", () => {
    expect(parseCliCommand(["worker"])).toEqual({ name: "worker", once: false });
    expect(parseCliCommand(["worker", "--once"])).toEqual({
      name: "worker",
      once: true,
    });
  });

  it("parses a failed job retry without normalizing its stored source path", () => {
    expect(
      parseCliCommand([
        "jobs",
        "retry",
        "--file",
        "/app/documents/uploads/group/handbook.pdf",
      ]),
    ).toEqual({
      name: "retry-job",
      sourceFile: "/app/documents/uploads/group/handbook.pdf",
    });
  });

  it("requires an explicit embedding-space GC mode and retention window", () => {
    expect(parseCliCommand([
      "embedding-spaces",
      "gc",
      "--retention-days",
      "30",
      "--dry-run",
    ])).toEqual({
      action: "dry-run",
      name: "embedding-space-gc",
      retentionDays: 30,
      runId: null,
    });
    expect(parseCliCommand([
      "embedding-spaces",
      "gc",
      "--apply",
      "--resume",
      "00000000-0000-4000-8000-000000000001",
    ])).toEqual({
      action: "resume",
      name: "embedding-space-gc",
      retentionDays: null,
      runId: "00000000-0000-4000-8000-000000000001",
    });
    expect(() => parseCliCommand([
      "embedding-spaces",
      "gc",
      "--retention-days",
      "30",
    ])).toThrow("--dry-run|--apply");
  });

  it("parses explicit embedding-space pin lifecycle commands", () => {
    expect(parseCliCommand([
      "embedding-spaces",
      "pin",
      "--space",
      "model:plain:768",
      "--reason",
      "known-good rollback",
    ])).toEqual({
      name: "embedding-space-pin",
      reason: "known-good rollback",
      spaceId: "model:plain:768",
    });
    expect(parseCliCommand([
      "embedding-spaces",
      "unpin",
      "--space",
      "model:plain:768",
    ])).toEqual({
      name: "embedding-space-unpin",
      spaceId: "model:plain:768",
    });
  });

  it("requires explicit application of a source-content migration", () => {
    expect(parseCliCommand([
      "source-content",
      "migrate",
      "--apply",
    ])).toEqual({ name: "source-content-migrate" });
    expect(() => parseCliCommand([
      "source-content",
      "migrate",
    ])).toThrow("source-content migrate --apply");
  });

  it("parses source-content archive paths", () => {
    expect(parseCliCommand([
      "source-content",
      "export",
      "--directory",
      "backup/source-content",
    ], "/workspace")).toEqual({
      directory: "/workspace/backup/source-content",
      name: "source-content-export",
    });
    expect(parseCliCommand([
      "source-content",
      "import",
      "--directory",
      "/restore/source-content",
      "--apply",
    ], "/workspace")).toEqual({
      directory: "/restore/source-content",
      name: "source-content-import",
    });
    expect(() => parseCliCommand([
      "source-content",
      "import",
      "--directory",
      "/restore/source-content",
    ], "/workspace")).toThrow("--apply");
  });

  it("rejects an incomplete failed job retry command", () => {
    expect(() => parseCliCommand(["jobs", "retry"])).toThrow(
      "Usage: citeloom jobs retry --file <stored-source-file>",
    );
  });

  it("requires a preparation artifact for an evaluation run", () => {
    expect(() => parseEvaluationCommand([
      "evaluation.json",
    ], "/workspace")).toThrow("--preparation-output");
  });

  it("normalizes evaluation dataset and preparation paths", () => {
    expect(parseEvaluationCommand([
      "evaluation.json",
      "--preparation-output",
      "results/preparation.json",
    ], "/workspace")).toEqual({
      datasetPath: "/workspace/evaluation.json",
      frozenConfigurationPath: null,
      name: "evaluate",
      outputPath: null,
      preparationOutputPath: "/workspace/results/preparation.json",
      tuningSelectionPath: null,
    });
  });

  it("normalizes an evaluation result output path", () => {
    expect(parseEvaluationCommand([
      "evaluation.json",
      "--output",
      "results/baseline.json",
      "--preparation-output",
      "results/preparation.json",
    ], "/workspace")).toEqual({
      datasetPath: "/workspace/evaluation.json",
      frozenConfigurationPath: null,
      name: "evaluate",
      outputPath: "/workspace/results/baseline.json",
      preparationOutputPath: "/workspace/results/preparation.json",
      tuningSelectionPath: null,
    });
  });

  it("parses offline scoring from a saved preparation", () => {
    expect(parseEvaluationCommand([
      "--from-preparation",
      "results/preparation.json",
      "--output",
      "results/baseline.json",
    ], "/workspace")).toEqual({
      name: "score-evaluation",
      outputPath: "/workspace/results/baseline.json",
      preparationPath: "/workspace/results/preparation.json",
    });
  });

  it("normalizes a frozen configuration for a sealed evaluation", () => {
    expect(parseEvaluationCommand([
      "evaluation.json",
      "--frozen-configuration",
      "results/frozen.json",
      "--preparation-output",
      "results/preparation.json",
    ], "/workspace")).toEqual({
      datasetPath: "/workspace/evaluation.json",
      frozenConfigurationPath: "/workspace/results/frozen.json",
      name: "evaluate",
      outputPath: null,
      preparationOutputPath: "/workspace/results/preparation.json",
      tuningSelectionPath: null,
    });
  });

  it("parses development tuning with repeated fixed preparations", () => {
    expect(parseEvaluationCommand([
      "--tune",
      "--specification",
      "results/search.json",
      "--from-preparation",
      "results/legal.json",
      "--from-preparation",
      "results/veterinary.json",
      "--output",
      "results/selection.json",
      "--freeze-output",
      "results/selected.freeze.json",
    ], "/workspace")).toEqual({
      freezeOutputPath: "/workspace/results/selected.freeze.json",
      name: "tune-evaluation",
      outputPath: "/workspace/results/selection.json",
      preparationPaths: [
        "/workspace/results/legal.json",
        "/workspace/results/veterinary.json",
      ],
      specificationPath: "/workspace/results/search.json",
    });
  });

  it("requires distinct tuning paths", () => {
    expect(() => parseEvaluationCommand([
      "--tune",
      "--specification",
      "results/search.json",
      "--from-preparation",
      "results/search.json",
      "--output",
      "results/selection.json",
      "--freeze-output",
      "results/selected.freeze.json",
    ], "/workspace")).toThrow("distinct paths");
  });

  it("parses answer-threshold preparation", () => {
    expect(parseEvaluationCommand([
      "--prepare-answer-threshold",
      "evaluations/legal.development.json",
      "--negative-domain",
      "veterinary",
      "--output",
      "results/legal.answer-threshold.json",
    ], "/workspace")).toEqual({
      datasetPath: "/workspace/evaluations/legal.development.json",
      name: "prepare-answer-threshold-calibration",
      negativeDomain: "veterinary",
      outputPath: "/workspace/results/legal.answer-threshold.json",
    });
  });

  it("parses answer-threshold selection with repeated preparations", () => {
    expect(parseEvaluationCommand([
      "--select-answer-threshold",
      "--maximum-false-acceptance-rate",
      "0.05",
      "--from-preparation",
      "results/legal.answer-threshold.json",
      "--from-preparation",
      "results/veterinary.answer-threshold.json",
      "--output",
      "results/answer-threshold.selection.json",
    ], "/workspace")).toEqual({
      maximumFalseAcceptanceRate: 0.05,
      name: "select-answer-threshold",
      outputPath: "/workspace/results/answer-threshold.selection.json",
      preparationPaths: [
        "/workspace/results/legal.answer-threshold.json",
        "/workspace/results/veterinary.answer-threshold.json",
      ],
    });
  });

  it("binds a tuning selection to a frozen sealed configuration", () => {
    expect(parseEvaluationCommand([
      "sealed.json",
      "--tuning-selection",
      "results/selection.json",
      "--frozen-configuration",
      "results/selected.freeze.json",
      "--preparation-output",
      "results/sealed.preparation.json",
    ], "/workspace")).toMatchObject({
      frozenConfigurationPath: "/workspace/results/selected.freeze.json",
      tuningSelectionPath: "/workspace/results/selection.json",
    });

    expect(() => parseEvaluationCommand([
      "sealed.json",
      "--tuning-selection",
      "results/selection.json",
      "--preparation-output",
      "results/sealed.preparation.json",
    ], "/workspace")).toThrow("must be used with its frozen configuration");
  });

  it("normalizes a frozen evaluation configuration output", () => {
    expect(parseEvaluationCommand([
      "--freeze-configuration",
      "--output",
      "results/frozen.json",
    ], "/workspace")).toEqual({
      name: "freeze-evaluation-configuration",
      outputPath: "/workspace/results/frozen.json",
    });
  });

  it("does not allow an evaluation result to overwrite its preparation", () => {
    expect(() => parseEvaluationCommand([
      "evaluation.json",
      "--output",
      "results/run.json",
      "--preparation-output",
      "results/run.json",
    ], "/workspace")).toThrow("must use different paths");

    expect(() => parseEvaluationCommand([
      "--from-preparation",
      "results/run.json",
      "--output",
      "results/run.json",
    ], "/workspace")).toThrow("must not overwrite");
  });

  it("parses local domain evaluation generation", () => {
    expect(parseEvaluationCommand([
      "--generate",
      "--domain",
      "legal",
      "--language",
      "en",
      "--question-type",
      "factoid",
      "--split",
      "development",
      "--minimum-detectable-ndcg-delta",
      "0.1",
      "--assumed-paired-ndcg-stddev",
      "0.25",
      "--cases",
      "120",
      "--output",
      "evaluations/legal.development.json",
      "--enrich",
    ], "/workspace")).toEqual({
      atK: 10,
      caseCount: 120,
      domain: "legal",
      enrich: true,
      language: "en",
      name: "generate-evaluation",
      outputPath: "/workspace/evaluations/legal.development.json",
      overwrite: false,
      scope: { kind: "tags", tags: ["legal"] },
      seed: "citeloom-evaluation-v1",
      split: "development",
      statisticalDesign: {
        alpha: 0.05,
        alternative: "two-sided",
        assumedPairedNdcgDeltaStandardDeviation: 0.25,
        method: "normal-approximation-paired-mean",
        minimumDetectableNdcgDelta: 0.1,
        power: 0.8,
        requiredCaseCount: 50,
      },
      questionType: "factoid",
    });
  });

  it("rejects an invalid evaluation split", () => {
    expect(() => parseEvaluationCommand([
      "--generate",
      "--domain",
      "veterinary",
      "--split",
      "training",
      "--output",
      "evaluation.json",
    ])).toThrow("development|holdout");
  });

  it("defaults an unscoped question to all indexed documents", () => {
    expect(parseCliCommand(["ask", "What", "changed?"])).toEqual({
      name: "ask",
      question: "What changed?",
      scope: { kind: "all" },
    });
  });

  it("parses repeated document scope flags", () => {
    const firstId = "a".repeat(64);
    const secondId = "b".repeat(64);
    expect(
      parseCliCommand([
        "ask",
        "--document",
        firstId,
        "--document",
        secondId,
        "--",
        "Compare",
        "them",
      ]),
    ).toEqual({
      name: "ask",
      question: "Compare them",
      scope: { documentIds: [firstId, secondId], kind: "documentIds" },
    });
  });

  it("normalizes file scopes at the CLI boundary", () => {
    expect(
      parseCliCommand(
        ["ask", "--file", "reports/report.pdf", "--", "Revenue?"],
        "/workspace",
      ),
    ).toEqual({
      name: "ask",
      question: "Revenue?",
      scope: {
        kind: "sourceFiles",
        sourceFiles: ["/workspace/reports/report.pdf"],
      },
    });
  });

  it("rejects mixed query scopes", () => {
    expect(() =>
      parseCliCommand([
        "ask",
        "--document",
        "a".repeat(64),
        "--tag",
        "finance",
        "Question?",
      ]),
    ).toThrow("Choose only one query scope");
  });

  it("rejects missing ingestion inputs", () => {
    expect(() => parseCliCommand(["ingest"])).toThrow(
      "Usage: citeloom ingest [options] <path> [...paths]",
    );
  });
});
