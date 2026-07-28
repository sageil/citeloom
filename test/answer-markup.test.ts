import { describe, expect, it } from "vitest";

import {
  readClaimsFromAnswerMarkup,
} from "../src/answers/claims.js";
import {
  parseAnswerMarkup,
  parseGeneratedAnswerMarkup,
} from "../src/answers/markup.js";

const REGRESSION_ANSWER = [
  "The provided documents describe the rules of evidence through several different lenses:",
  "",
  "**General Principles and Purpose**",
  "",
  "**Admissibility vs. Weight:** All relevant evidence is generally admissible [4, 9].",
].join("\n");

describe("answer markup boundary", () => {
  it("canonicalizes grouped citations and extracts only the substantive claim", () => {
    const markup = parseGeneratedAnswerMarkup(REGRESSION_ANSWER, 9);

    expect(markup.canonicalMarkdown).toBe(REGRESSION_ANSWER.replace(
      "[4, 9]",
      "[4] [9]",
    ));
    expect(markup.citationNumbers).toEqual([4, 9]);
    expect(readClaimsFromAnswerMarkup(markup)).toEqual([{
      citationNumbers: [4, 9],
      claim: "Admissibility vs. Weight: All relevant evidence is generally admissible.",
      claimIndex: 0,
    }]);
  });

  it("supports adjacent individual citation markers", () => {
    const markup = parseGeneratedAnswerMarkup(
      "The authorities agree [1] [3].",
      3,
    );

    expect(markup.canonicalMarkdown).toBe("The authorities agree [1] [3].");
    expect(markup.citationNumbers).toEqual([1, 3]);
    expect(readClaimsFromAnswerMarkup(markup)[0]?.citationNumbers).toEqual([1, 3]);
  });

  it("excludes only a leading bold list label ending in a colon from claims", () => {
    const answer = [
      "- **Business Records:** Records made in the ordinary course may be admissible [1].",
      "- **Probative value** remains part of this claim [2].",
      "- Plain label: This prefix remains part of the claim [3].",
      "- **:** An empty prefix remains part of the claim [4].",
    ].join("\n");
    const markup = parseGeneratedAnswerMarkup(answer, 4);

    expect(markup.canonicalMarkdown).toBe(answer);
    expect(readClaimsFromAnswerMarkup(markup)).toEqual([
      {
        citationNumbers: [1],
        claim: "Records made in the ordinary course may be admissible.",
        claimIndex: 0,
      },
      {
        citationNumbers: [2],
        claim: "Probative value remains part of this claim.",
        claimIndex: 1,
      },
      {
        citationNumbers: [3],
        claim: "Plain label: This prefix remains part of the claim.",
        claimIndex: 2,
      },
      {
        citationNumbers: [4],
        claim: ": An empty prefix remains part of the claim.",
        claimIndex: 3,
      },
    ]);
  });

  it("keeps escaped bracketed numbers as prose instead of citation spans", () => {
    const markup = parseGeneratedAnswerMarkup(
      "The literal marker \\[1] is discussed before the supported fact [2].",
      2,
    );

    expect(markup.citationNumbers).toEqual([2]);
    expect(readClaimsFromAnswerMarkup(markup)[0]).toMatchObject({
      citationNumbers: [2],
      claim: "The literal marker [1] is discussed before the supported fact.",
    });
  });

  it("does not repair escaped or code citation-like text", () => {
    const answer = "The literal \\[1-3] and code `[1-3]` are described [1].";
    const markup = parseGeneratedAnswerMarkup(answer, 3);

    expect(markup.canonicalMarkdown).toBe(answer);
    expect(markup.citationNumbers).toEqual([1]);
  });

  it("repairs unambiguous generated citation syntax", () => {
    expect(parseGeneratedAnswerMarkup(
      "A range claim [1-3].",
      3,
    ).canonicalMarkdown).toBe("A range claim [1] [2] [3].");
    expect(parseGeneratedAnswerMarkup(
      "A separated range claim [1]-[3].",
      3,
    ).canonicalMarkdown).toBe("A separated range claim [1] [2] [3].");
    expect(parseGeneratedAnswerMarkup(
      "A trailing separator claim [1,].",
      3,
    ).canonicalMarkdown).toBe("A trailing separator claim [1].");
    expect(parseGeneratedAnswerMarkup(
      "A semicolon claim [1; 3].",
      3,
    ).canonicalMarkdown).toBe("A semicolon claim [1] [3].");
    expect(parseGeneratedAnswerMarkup(
      "An unclosed claim [1",
      3,
    ).canonicalMarkdown).toBe("An unclosed claim [1]");
  });

  it("rejects ambiguous and unavailable generated citations clearly", () => {
    expect(() => parseGeneratedAnswerMarkup("A claim [0].", 3)).toThrow(
      "Invalid citation marker",
    );
    expect(() => parseGeneratedAnswerMarkup("A claim [3-1].", 3)).toThrow(
      "Citation ranges are not supported",
    );
    expect(() => parseGeneratedAnswerMarkup("A claim [1 source", 3)).toThrow(
      "Citation markers must end with ]",
    );
    expect(() => parseGeneratedAnswerMarkup("A claim [4].", 3)).toThrow(
      "only source numbers 1 through 3 are available",
    );
    expect(() => parseGeneratedAnswerMarkup(
      "A claim [1-999999999].",
      3,
    )).toThrow("only source numbers 1 through 3 are available");
  });

  it("repairs numeric generated citations formatted as Markdown links", () => {
    expect(parseGeneratedAnswerMarkup(
      "A claim [1-3](https://example.com).",
      3,
    ).canonicalMarkdown).toBe("A claim [1] [2] [3].");
    expect(parseGeneratedAnswerMarkup(
      "A claim [1,](https://example.com).",
      3,
    ).canonicalMarkdown).toBe("A claim [1].");
    expect(() => parseGeneratedAnswerMarkup(
      "A claim [4](https://example.com).",
      3,
    )).toThrow("only source numbers 1 through 3 are available");
    expect(parseGeneratedAnswerMarkup(
      "A claim [1](https://example.com).",
      3,
    ).canonicalMarkdown).toBe("A claim [1].");
    expect(parseGeneratedAnswerMarkup([
      "A claim [1][source].",
      "",
      "[source]: https://example.com",
    ].join("\n"), 3).canonicalMarkdown).toBe("A claim [1].");
    expect(parseGeneratedAnswerMarkup([
      "A claim [1][source] and [documentation][source] remain available [2].",
      "",
      "[source]: https://example.com",
    ].join("\n"), 3).canonicalMarkdown).toBe([
      "A claim [1] and [documentation][source] remain available [2].",
      "",
      "[source]: https://example.com",
    ].join("\n"));
    expect(parseGeneratedAnswerMarkup(
      "The numbered [Section 1](https://example.com) is discussed [1].",
      3,
    ).citationNumbers).toEqual([1]);
  });

  it("preserves bracketed-year legal citations as substantive text", () => {
    const markup = parseGeneratedAnswerMarkup(
      "In R. v. Smith, [2020] 1 S.C.R. 1, the court affirmed the order [1].",
      3,
    );

    expect(markup.citationNumbers).toEqual([1]);
    expect(markup.canonicalMarkdown).toBe(
      "In R. v. Smith, [2020] 1 S.C.R. 1, the court affirmed the order [1].",
    );
    expect(readClaimsFromAnswerMarkup(markup)).toEqual([{
      citationNumbers: [1],
      claim: "In R. v. Smith, [2020] 1 S.C.R. 1, the court affirmed the order.",
      claimIndex: 0,
    }]);
    expect(() => parseGeneratedAnswerMarkup(
      "The unsupported source marker is [2020].",
      3,
    )).toThrow("only source numbers 1 through 3 are available");
    expect(() => parseGeneratedAnswerMarkup(
      "The unsupported source marker is [2020] Source 1.",
      3,
    )).toThrow("only source numbers 1 through 3 are available");
    expect(parseGeneratedAnswerMarkup(
      "R. v. Smith followed [2020] UKSC 1 and reached the same result [1].",
      3,
    ).citationNumbers).toEqual([1]);
  });

  it("keeps citations with sentences on either side of terminal punctuation", () => {
    const markup = parseAnswerMarkup(
      "First fact. [1] Second fact [2]. Third fact [3]",
    );

    expect(readClaimsFromAnswerMarkup(markup)).toEqual([
      { citationNumbers: [1], claim: "First fact.", claimIndex: 0 },
      { citationNumbers: [2], claim: "Second fact.", claimIndex: 1 },
      { citationNumbers: [3], claim: "Third fact", claimIndex: 2 },
    ]);
  });

  it("does not fragment sentences at reviewed abbreviations or initials", () => {
    const markup = parseAnswerMarkup(
      "Admissibility vs. Weight: J. Smith cited Acme Inc. filings, e.g., Exhibit A, i.e., the original, under 410 U.S. 113 [1].",
    );

    expect(readClaimsFromAnswerMarkup(markup)).toEqual([{
      citationNumbers: [1],
      claim: "Admissibility vs. Weight: J. Smith cited Acme Inc. filings, e.g., Exhibit A, i.e., the original, under 410 U.S. 113.",
      claimIndex: 0,
    }]);
  });

  it("distinguishes sentence-final abbreviations from continuing abbreviations", () => {
    const markup = parseAnswerMarkup([
      "The court sits in the U.S. Revenue rose [1].",
      "The U.S. Supreme Court decided the appeal [2].",
      "Smith is reported at 1 S.C.R. 1 [3].",
    ].join(" "));

    expect(readClaimsFromAnswerMarkup(markup)).toEqual([
      {
        citationNumbers: [],
        claim: "The court sits in the U.S.",
        claimIndex: 0,
      },
      {
        citationNumbers: [1],
        claim: "Revenue rose.",
        claimIndex: 1,
      },
      {
        citationNumbers: [2],
        claim: "The U.S. Supreme Court decided the appeal.",
        claimIndex: 2,
      },
      {
        citationNumbers: [3],
        claim: "Smith is reported at 1 S.C.R. 1.",
        claimIndex: 3,
      },
    ]);
  });

  it("preserves genuine uncited factual sentences as unverified claims", () => {
    const markup = parseAnswerMarkup([
      "## Findings",
      "",
      "Revenue increased without a supplied citation.",
    ].join("\n"));

    expect(readClaimsFromAnswerMarkup(markup)).toEqual([{
      citationNumbers: [],
      claim: "Revenue increased without a supplied citation.",
      claimIndex: 0,
    }]);
  });

  it("excludes only a trailing structural lead-in from a mixed paragraph", () => {
    const markup = parseAnswerMarkup([
      "Revenue increased without a supplied citation. Supporting details:",
      "",
      "- Costs declined [1].",
    ].join("\n"));

    expect(readClaimsFromAnswerMarkup(markup)).toEqual([
      {
        citationNumbers: [],
        claim: "Revenue increased without a supplied citation.",
        claimIndex: 0,
      },
      {
        citationNumbers: [1],
        claim: "Costs declined.",
        claimIndex: 1,
      },
    ]);
  });

  it("excludes cited pseudo-headings and period-ended structural lead-ins", () => {
    const markup = parseAnswerMarkup([
      "**General Principles [1]**",
      "",
      "The findings are as follows.",
      "",
      "- Revenue rose [2].",
    ].join("\n"));

    expect(readClaimsFromAnswerMarkup(markup)).toEqual([{
      citationNumbers: [2],
      claim: "Revenue rose.",
      claimIndex: 0,
    }]);
  });
});
