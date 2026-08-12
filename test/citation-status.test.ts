import { describe, expect, it } from "vitest";

import {
  aggregateCitationStatus,
  formatClaimStatusLabel,
} from "../web/assets/scripts/ask-schema.js";

const citationNumber = 1;

describe("citation status", () => {
  it.each([
    ["supported", "supported"],
    ["partially-supported", "partially-supported"],
    ["unsupported", "unsupported"],
    ["unverified", "unverified"],
  ] as const)("preserves a matching %s claim", (status, expected) => {
    expect(aggregateCitationStatus(
      [buildClaim(status, citationNumber)],
      citationNumber,
    )).toBe(expected);
  });

  it("returns unverified when no claim references the citation", () => {
    expect(aggregateCitationStatus(
      [buildClaim("supported", 2)],
      citationNumber,
    )).toBe("unverified");
  });

  it.each([
    [["supported", "supported"], "supported"],
    [["unsupported", "unsupported"], "unsupported"],
    [["supported", "unsupported"], "partially-supported"],
    [["supported", "partially-supported"], "partially-supported"],
    [["unsupported", "partially-supported"], "partially-supported"],
    [["supported", "unverified"], "unverified"],
    [["unsupported", "unverified"], "unverified"],
    [["partially-supported", "unverified"], "unverified"],
  ] as const)("aggregates %j as %s", (statuses, expected) => {
    const claims = statuses.map((status) => buildClaim(status, citationNumber));

    expect(aggregateCitationStatus(claims, citationNumber)).toBe(expected);
  });

  it.each([
    ["supported", "Supported by verifier"],
    ["partially-supported", "Verifier found mixed support"],
    ["unsupported", "Possible unsupported content"],
    ["unverified", "Verifier uncertain"],
  ] as const)("labels %s as %s", (status, expected) => {
    expect(formatClaimStatusLabel(status)).toBe(expected);
  });
});

function buildClaim(
  status: "partially-supported" | "supported" | "unsupported" | "unverified",
  referencedCitationNumber: number,
) {
  return {
    citationNumbers: [referencedCitationNumber],
    status,
  };
}
