import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  evaluateAuditedClaims,
  writeClaimEvaluationReport,
} from "../tools/evaluation/claim-evaluation.js";
import { parseEvaluationCommand } from "../tools/evaluation/command-parser.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("audited claim evaluation", () => {
  it("reports distinct claim-status rates overall and by domain", async () => {
    const directory = await mkdtemp(join(tmpdir(), "citeloom-claims-"));
    directories.push(directory);
    const datasetPath = join(directory, "audited.json");
    await writeFile(datasetPath, JSON.stringify({
      answers: [
        {
          answerId: "legal-1",
          claims: [
            {
              citations: [
                { citationNumber: 1, humanSupports: true, verifierSupports: true },
                { citationNumber: 2, humanSupports: false, verifierSupports: true },
              ],
              claimIndex: 0,
              expectedStatus: "supported",
              predictedStatus: "supported",
            },
            {
              citations: [
                { citationNumber: 3, humanSupports: true, verifierSupports: false },
              ],
              claimIndex: 1,
              expectedStatus: "supported",
              predictedStatus: "partially-supported",
            },
          ],
          domain: "legal",
        },
        {
          answerId: "veterinary-1",
          claims: [
            {
              citations: [],
              claimIndex: 0,
              expectedStatus: "unsupported",
              predictedStatus: "unsupported",
            },
            {
              citations: [],
              claimIndex: 1,
              expectedStatus: "unsupported",
              predictedStatus: "unsupported",
            },
            {
              citations: [],
              claimIndex: 2,
              expectedStatus: "unverified",
              predictedStatus: "unverified",
            },
          ],
          domain: "veterinary",
        },
      ],
      audit: {
        auditedAt: "2026-07-15T12:00:00.000Z",
        reviewerProcess: "Two-person blinded citation review",
        status: "approved",
      },
      name: "claim-verifier-audit",
      version: 1,
    }), "utf8");

    const report = await evaluateAuditedClaims(datasetPath);
    expect(report).toMatchObject({
      answerCount: 2,
      claimCount: 5,
      datasetName: "claim-verifier-audit",
      metrics: {
        citationPrecision: 0.5,
        citationRecall: 0.5,
        claimCoverage: 4 / 5,
        unsupportedClaimRate: 2 / 5,
        unverifiedClaimRate: 1 / 5,
        verifierErrorRate: 1 / 5,
      },
      version: 2,
    });
    expect(report.domains).toMatchObject([
      {
        answerCount: 1,
        claimCount: 2,
        domain: "legal",
        metrics: {
          claimCoverage: 1,
          unsupportedClaimRate: 0,
          unverifiedClaimRate: 0,
        },
      },
      {
        answerCount: 1,
        claimCount: 3,
        domain: "veterinary",
        metrics: {
          claimCoverage: 2 / 3,
          unsupportedClaimRate: 2 / 3,
          unverifiedClaimRate: 1 / 3,
        },
      },
    ]);

    const outputPath = join(directory, "nested", "report.json");
    await writeClaimEvaluationReport(outputPath, report);
    expect(JSON.parse(await readFile(outputPath, "utf8"))).toMatchObject({
      datasetName: "claim-verifier-audit",
      version: 2,
    });
  });

  it("requires an approved audited answer set", async () => {
    const directory = await mkdtemp(join(tmpdir(), "citeloom-claims-"));
    directories.push(directory);
    const datasetPath = join(directory, "invalid.json");
    await writeFile(datasetPath, JSON.stringify({
      answers: [],
      audit: {
        auditedAt: "2026-07-15T12:00:00.000Z",
        reviewerProcess: "",
        status: "draft",
      },
      name: "invalid",
      version: 1,
    }), "utf8");
    await expect(evaluateAuditedClaims(datasetPath)).rejects.toThrow(
      "audited answer set is invalid",
    );
  });

  it("rejects duplicate audited identities before calculating metrics", async () => {
    const directory = await mkdtemp(join(tmpdir(), "citeloom-claims-"));
    directories.push(directory);
    const datasetPath = join(directory, "duplicate.json");
    const answer = {
      answerId: "duplicate-answer",
      claims: [{
        citations: [
          { citationNumber: 1, humanSupports: true, verifierSupports: true },
          { citationNumber: 1, humanSupports: true, verifierSupports: true },
        ],
        claimIndex: 0,
        expectedStatus: "supported",
        predictedStatus: "supported",
      }],
      domain: "legal",
    };
    await writeFile(datasetPath, JSON.stringify({
      answers: [answer, answer],
      audit: {
        auditedAt: "2026-07-15T12:00:00.000Z",
        reviewerProcess: "Two-person blinded citation review",
        status: "approved",
      },
      name: "duplicate-audit",
      version: 1,
    }), "utf8");

    await expect(evaluateAuditedClaims(datasetPath)).rejects.toThrow(
      "answer IDs must be unique",
    );
  });

  it("parses the claim evaluation CLI without implicit paths", () => {
    expect(parseEvaluationCommand([
      "--claims",
      "--dataset",
      "audit.json",
      "--output",
      "report.json",
    ], "/workspace")).toEqual({
      datasetPath: "/workspace/audit.json",
      name: "evaluate-claims",
      outputPath: "/workspace/report.json",
    });
    expect(() => parseEvaluationCommand([
      "--claims",
      "--dataset",
      "audit.json",
    ], "/workspace")).toThrow("Usage: citeloom evaluate");
  });
});
