import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

const claimStatusSchema = z.enum([
  "supported",
  "partially-supported",
  "unsupported",
  "unverified",
]);
const auditedAnswerSetSchema = z.object({
  answers: z.array(z.object({
    answerId: z.string().trim().min(1),
    claims: z.array(z.object({
      citations: z.array(z.object({
        citationNumber: z.number().int().positive(),
        humanSupports: z.boolean(),
        verifierSupports: z.boolean(),
      }).strict()),
      claimIndex: z.number().int().nonnegative(),
      expectedStatus: claimStatusSchema,
      predictedStatus: claimStatusSchema,
    }).strict()).min(1),
    domain: z.string().trim().min(1),
  }).strict()).min(1),
  audit: z.object({
    auditedAt: z.iso.datetime({ offset: true }),
    reviewerProcess: z.string().trim().min(1),
    status: z.literal("approved"),
  }).strict(),
  name: z.string().trim().min(1),
  version: z.literal(1),
}).strict().superRefine((dataset, context) => {
  const answerIds = new Set<string>();
  for (let answerIndex = 0; answerIndex < dataset.answers.length; answerIndex += 1) {
    const answer = dataset.answers[answerIndex];
    if (answer === undefined) {
      continue;
    }
    if (answerIds.has(answer.answerId)) {
      context.addIssue({
        code: "custom",
        message: "answer IDs must be unique",
        path: ["answers", answerIndex, "answerId"],
      });
    }
    answerIds.add(answer.answerId);
    const claimIndexes = new Set<number>();
    for (let claimOffset = 0; claimOffset < answer.claims.length; claimOffset += 1) {
      const claim = answer.claims[claimOffset];
      if (claim === undefined) {
        continue;
      }
      if (claimIndexes.has(claim.claimIndex)) {
        context.addIssue({
          code: "custom",
          message: "claim indexes must be unique within an answer",
          path: ["answers", answerIndex, "claims", claimOffset, "claimIndex"],
        });
      }
      claimIndexes.add(claim.claimIndex);
      const citationNumbers = new Set<number>();
      for (
        let citationOffset = 0;
        citationOffset < claim.citations.length;
        citationOffset += 1
      ) {
        const citation = claim.citations[citationOffset];
        if (citation === undefined) {
          continue;
        }
        if (citationNumbers.has(citation.citationNumber)) {
          context.addIssue({
            code: "custom",
            message: "citation numbers must be unique within a claim",
            path: [
              "answers",
              answerIndex,
              "claims",
              claimOffset,
              "citations",
              citationOffset,
              "citationNumber",
            ],
          });
        }
        citationNumbers.add(citation.citationNumber);
      }
    }
  }
});

export type AuditedAnswerSet = z.output<typeof auditedAnswerSetSchema>;

export interface ClaimEvaluationMetrics {
  citationPrecision: number | null;
  citationRecall: number | null;
  claimCoverage: number;
  unsupportedClaimRate: number;
  unverifiedClaimRate: number;
  verifierErrorRate: number;
}

export interface ClaimEvaluationReport {
  answerCount: number;
  audit: AuditedAnswerSet["audit"];
  claimCount: number;
  datasetName: string;
  datasetSha256: string;
  domains: Array<{
    answerCount: number;
    claimCount: number;
    domain: string;
    metrics: ClaimEvaluationMetrics;
  }>;
  generatedAt: string;
  metrics: ClaimEvaluationMetrics;
  version: 2;
}

export async function evaluateAuditedClaims(
  datasetPath: string,
): Promise<ClaimEvaluationReport> {
  const content = await readFile(datasetPath, "utf8");
  const dataset = decodeAuditedAnswerSet(content);
  const domains = new Map<string, AuditedAnswerSet["answers"]>();
  for (const answer of dataset.answers) {
    const current = domains.get(answer.domain) ?? [];
    current.push(answer);
    domains.set(answer.domain, current);
  }
  const domainReports: ClaimEvaluationReport["domains"] = [];
  for (const [domain, answers] of [...domains.entries()].sort(([left], [right]) => {
    return left.localeCompare(right);
  })) {
    domainReports.push({
      answerCount: answers.length,
      claimCount: countClaims(answers),
      domain,
      metrics: calculateClaimEvaluationMetrics(answers),
    });
  }
  return {
    answerCount: dataset.answers.length,
    audit: dataset.audit,
    claimCount: countClaims(dataset.answers),
    datasetName: dataset.name,
    datasetSha256: createHash("sha256").update(content).digest("hex"),
    domains: domainReports,
    generatedAt: new Date().toISOString(),
    metrics: calculateClaimEvaluationMetrics(dataset.answers),
    version: 2,
  };
}

export async function writeClaimEvaluationReport(
  outputPath: string,
  report: ClaimEvaluationReport,
): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
}

export function calculateClaimEvaluationMetrics(
  answers: AuditedAnswerSet["answers"],
): ClaimEvaluationMetrics {
  let claimCount = 0;
  let coveredClaims = 0;
  let humanSupportingCitations = 0;
  let predictedSupportingCitations = 0;
  let trueSupportingCitations = 0;
  let unsupportedClaims = 0;
  let unverifiedClaims = 0;
  let verifierErrors = 0;
  for (const answer of answers) {
    for (const claim of answer.claims) {
      claimCount += 1;
      if (claim.predictedStatus === "unsupported") {
        unsupportedClaims += 1;
      }
      if (claim.predictedStatus === "unverified") {
        unverifiedClaims += 1;
      } else {
        coveredClaims += 1;
      }
      if (claim.predictedStatus !== claim.expectedStatus) {
        verifierErrors += 1;
      }
      for (const citation of claim.citations) {
        if (citation.humanSupports) {
          humanSupportingCitations += 1;
        }
        if (citation.verifierSupports) {
          predictedSupportingCitations += 1;
        }
        if (citation.humanSupports && citation.verifierSupports) {
          trueSupportingCitations += 1;
        }
      }
    }
  }
  if (claimCount === 0) {
    throw new Error("An audited answer set must contain at least one claim.");
  }
  return {
    citationPrecision: divideOrNull(
      trueSupportingCitations,
      predictedSupportingCitations,
    ),
    citationRecall: divideOrNull(
      trueSupportingCitations,
      humanSupportingCitations,
    ),
    claimCoverage: coveredClaims / claimCount,
    unsupportedClaimRate: unsupportedClaims / claimCount,
    unverifiedClaimRate: unverifiedClaims / claimCount,
    verifierErrorRate: verifierErrors / claimCount,
  };
}

function decodeAuditedAnswerSet(content: string): AuditedAnswerSet {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error("The audited answer set is not valid JSON.");
  }
  const result = auditedAnswerSetSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`The audited answer set is invalid: ${result.error.message}`);
  }
  return result.data;
}

function countClaims(answers: AuditedAnswerSet["answers"]): number {
  let count = 0;
  for (const answer of answers) {
    count += answer.claims.length;
  }
  return count;
}

function divideOrNull(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}
