import { describe, expect, it } from "vitest";

import {
  readAnswerVerificationClaims,
  readStoredAnswerVerificationClaims,
} from "../web/assets/scripts/verification.js";

const answerDocument = {
  statements: [{ content: "Revenue increased." }],
};

function buildClaim() {
  return {
    citationNumbers: [1],
    claim: "Revenue increased.",
    claimIndex: 0,
    evidenceUnits: [{
      citationNumber: 1,
      outcome: "supported",
      rationale: "The evidence directly supports the statement.",
      supportProbability: 0.91,
      unitId: "claim-0-citation-1",
    }],
    rationale: "The cited evidence supports the answer statement.",
    status: "supported",
  };
}

describe("answer verification boundaries", () => {
  it("preserves the statement index and HHEM score for Chat claims", () => {
    const claims = readAnswerVerificationClaims(
      [buildClaim()],
      answerDocument,
      "chat finding check",
    );

    expect(claims[0]).toMatchObject({
      claim: "Revenue increased.",
      claimIndex: 0,
      evidenceUnits: [{
        citationNumber: 1,
        supportProbability: 0.91,
      }],
    });
  });

  it("preserves the same data and stored ID for Ask claims", () => {
    const claims = readStoredAnswerVerificationClaims(
      [{ ...buildClaim(), id: "claim-check-1" }],
      answerDocument,
      "claim check",
    );

    expect(claims[0]).toMatchObject({
      claimIndex: 0,
      evidenceUnits: [{ supportProbability: 0.91 }],
      id: "claim-check-1",
    });
  });

  it("rejects claims that no longer match their answer statement", () => {
    expect(() => readStoredAnswerVerificationClaims(
      [{ ...buildClaim(), claim: "A different statement.", id: "claim-check-1" }],
      answerDocument,
      "claim check",
    )).toThrow("claim check 1 does not match its answer statement");
  });
});
