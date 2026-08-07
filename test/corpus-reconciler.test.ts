import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { IngestionJob } from "../src/documents/catalog/index.js";
import { parseCorpusReconcileCommand } from "../tools/evaluation/corpus/reconcile-cli.js";
import {
  decodeProofCorpusManifest,
  type ProofCorpus,
} from "../tools/evaluation/corpus/proof.js";
import {
  buildCorpusQueueReconciliationPlan,
  isSourceWithinCorpus,
} from "../tools/evaluation/corpus/reconciler.js";

describe("proof corpus manifest boundary", () => {
  it("requires every domain and split", () => {
    expect(() => decodeProofCorpusManifest({
      caseCountPerSplit: 15,
      documents: [{
        domain: "legal",
        fileName: "privacy-act.pdf",
        modality: "document",
        split: "development",
      }],
      seed: "test-seed",
      version: 2,
    }, "test manifest")).toThrow("legal holdout");
  });

  it("rejects duplicate selected documents", () => {
    const document = {
      domain: "legal",
      fileName: "privacy-act.pdf",
      modality: "document",
      split: "development",
    } as const;
    expect(() => decodeProofCorpusManifest({
      caseCountPerSplit: 15,
      documents: [
        document,
        document,
        { ...document, fileName: "interpretation-act.pdf", split: "holdout" },
        { ...document, domain: "veterinary", fileName: "seizure.html" },
        {
          ...document,
          domain: "veterinary",
          fileName: "hypertension.html",
          split: "holdout",
        },
      ],
      seed: "test-seed",
      version: 2,
    }, "test manifest")).toThrow("duplicates document");
  });
});

describe("corpus reconciliation command boundary", () => {
  it("defaults to a non-mutating dry run", () => {
    expect(parseCorpusReconcileCommand([], "/workspace")).toEqual({
      apply: false,
      corpusRoot: "/workspace/documents/evaluation-corpora",
      forceSelected: false,
      manifestPath: "/workspace/corpora/proof.json",
    });
  });

  it("parses explicit reconciliation options", () => {
    expect(parseCorpusReconcileCommand([
      "--apply",
      "--force-selected",
      "--manifest",
      "proof.json",
      "--corpus-root",
      "sources",
    ], "/workspace")).toEqual({
      apply: true,
      corpusRoot: "/workspace/sources",
      forceSelected: true,
      manifestPath: "/workspace/proof.json",
    });
  });
});

describe("corpus queue planning", () => {
  it("cancels only unselected corpus jobs without active leases", () => {
    const corpusRoot = resolve("/workspace/documents/evaluation-corpora");
    const selectedSourceFile = resolve(corpusRoot, "legal/privacy-act.pdf");
    const corpus: ProofCorpus = {
      caseCountPerSplit: 15,
      corpusRoot,
      documents: [{
        documentId: "a".repeat(64),
        domain: "legal",
        fileName: "privacy-act.pdf",
        modality: "document",
        sourceFile: selectedSourceFile,
        split: "development",
      }],
      seed: "test-seed",
    };
    const currentTime = new Date("2026-07-14T12:00:00.000Z");
    const selected = buildPendingJob(selectedSourceFile);
    const cancellable = buildPendingJob(
      resolve(corpusRoot, "legal/criminal-code.pdf"),
    );
    const protectedJob = buildRunningJob(
      resolve(corpusRoot, "veterinary/active.html"),
      "2026-07-14T12:01:00.000Z",
    );
    const expired = buildRunningJob(
      resolve(corpusRoot, "veterinary/expired.html"),
      "2026-07-14T11:59:00.000Z",
    );
    const outside = buildPendingJob("/workspace/documents/uploads/scorecard.pdf");

    const plan = buildCorpusQueueReconciliationPlan(
      [selected, cancellable, protectedJob, expired, outside],
      corpus,
      currentTime,
    );

    expect(plan.cancellable.map((job) => job.sourceFile)).toEqual([
      cancellable.sourceFile,
      expired.sourceFile,
    ]);
    expect(plan.protected.map((job) => job.sourceFile)).toEqual([
      protectedJob.sourceFile,
    ]);
    expect(plan.retained.map((job) => job.sourceFile)).toEqual([
      selected.sourceFile,
      outside.sourceFile,
    ]);
  });

  it("does not treat sibling directory names as corpus paths", () => {
    expect(isSourceWithinCorpus(
      "/workspace/documents/evaluation-corpora-copy/report.pdf",
      "/workspace/documents/evaluation-corpora",
    )).toBe(false);
  });
});

function buildPendingJob(sourceFile: string): IngestionJob {
  return {
    attemptCount: 0,
    documentId: "b".repeat(64),
    doclingAttemptConfig: null,
    doclingRunId: null,
    elementSetId: null,
    embeddingSpaceId: "test:768",
    controlError: null,
    controlState: "active",
    errorMessage: null,
    format: {
      extension: ".pdf",
      mediaType: "application/pdf",
    },
    generationId: "00000000-0000-4000-8000-000000000001",
    images: 0,
    indexingActivity: null,
    leaseExpiresAt: null,
    maxAttempts: 3,
    nextAttemptAt: "2026-07-14T11:00:00.000Z",
    ownerId: null,
    pageCount: null,
    phase: "discovered",
    sourceFile,
    state: "pending",
    tables: 0,
    tags: [],
    textChunks: 0,
    totalElements: 0,
    updatedAt: "2026-07-14T11:00:00.000Z",
    uploadedByUserId: null,
  };
}

function buildRunningJob(
  sourceFile: string,
  leaseExpiresAt: string,
): IngestionJob {
  return {
    ...buildPendingJob(sourceFile),
    leaseExpiresAt,
    ownerId: "00000000-0000-4000-8000-000000000001",
    state: "running",
  };
}
