import {
  readLocatedClaimsFromAnswerMarkup,
  type LocatedAnswerClaim,
} from "./claims.js";
import {
  parseGeneratedAnswerMarkup,
  type AnswerMarkdownBlock,
} from "./markup.js";

export const PARTIAL_ANSWER_HEADING = "## Partial answer from cited information";

interface AnswerMarkdownEdit {
  blockIndex: number;
  end: number;
  replacement: string;
  start: number;
}

export function pruneUncitedGeneratedAnswer(
  answer: string,
  maximumCitationNumber: number,
): string | null {
  const markup = parseGeneratedAnswerMarkup(answer, maximumCitationNumber);
  const claims = readLocatedClaimsFromAnswerMarkup(markup);
  const claimsByBlock = groupClaimsByBlock(claims);
  const edits: AnswerMarkdownEdit[] = [];

  for (const [blockIndex, blockClaims] of claimsByBlock) {
    const block = markup.blocks[blockIndex];
    if (block === undefined) {
      throw new Error(`Missing answer block at index ${blockIndex}.`);
    }
    const citedClaims: LocatedAnswerClaim[] = [];
    let hasUncitedClaim = false;
    for (const claim of blockClaims) {
      if (claim.citationNumbers.length === 0) {
        hasUncitedClaim = true;
      } else {
        citedClaims.push(claim);
      }
    }
    if (!hasUncitedClaim) {
      continue;
    }
    if (block.kind === "table-row" || citedClaims.length === 0) {
      edits.push({
        blockIndex,
        end: block.removalEnd,
        replacement: "",
        start: block.removalStart,
      });
      continue;
    }
    edits.push({
      blockIndex,
      end: block.sourceEnd,
      replacement: renderCitedClaims(citedClaims),
      start: block.sourceStart,
    });
  }

  if (edits.length === 0 || removesGroundedBlock(edits, claims, markup.blocks)) {
    return null;
  }
  const safeEdits = normalizeAnswerMarkdownEdits(edits);
  if (safeEdits === null) {
    return null;
  }
  const prunedBody = applyAnswerMarkdownEdits(markup.canonicalMarkdown, safeEdits);
  if (prunedBody.trim() === "") {
    return null;
  }
  const trimmedBody = prunedBody.trim();
  if (
    trimmedBody === PARTIAL_ANSWER_HEADING
    || trimmedBody.startsWith(`${PARTIAL_ANSWER_HEADING}\n`)
  ) {
    return trimmedBody;
  }
  return `${PARTIAL_ANSWER_HEADING}\n\n${trimmedBody}`;
}

function groupClaimsByBlock(
  claims: readonly LocatedAnswerClaim[],
): Map<number, LocatedAnswerClaim[]> {
  const groups = new Map<number, LocatedAnswerClaim[]>();
  for (const claim of claims) {
    const existing = groups.get(claim.blockIndex);
    if (existing === undefined) {
      groups.set(claim.blockIndex, [claim]);
    } else {
      existing.push(claim);
    }
  }
  return groups;
}

function renderCitedClaims(claims: readonly LocatedAnswerClaim[]): string {
  const rendered: string[] = [];
  for (const claim of claims) {
    const citations: string[] = [];
    for (const citationNumber of claim.citationNumbers) {
      citations.push(`[${citationNumber}]`);
    }
    rendered.push(`${claim.claim} ${citations.join(" ")}`);
  }
  return rendered.join(" ");
}

function removesGroundedBlock(
  edits: readonly AnswerMarkdownEdit[],
  claims: readonly LocatedAnswerClaim[],
  blocks: readonly AnswerMarkdownBlock[],
): boolean {
  for (const edit of edits) {
    if (edit.replacement !== "") {
      continue;
    }
    for (const claim of claims) {
      if (
        claim.blockIndex === edit.blockIndex
        || claim.citationNumbers.length === 0
      ) {
        continue;
      }
      const groundedBlock = blocks[claim.blockIndex];
      if (groundedBlock === undefined) {
        throw new Error(`Missing answer block at index ${claim.blockIndex}.`);
      }
      if (
        groundedBlock.sourceStart >= edit.start
        && groundedBlock.sourceEnd <= edit.end
      ) {
        return true;
      }
    }
  }
  return false;
}

function normalizeAnswerMarkdownEdits(
  edits: readonly AnswerMarkdownEdit[],
): AnswerMarkdownEdit[] | null {
  const sorted = [...edits].sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }
    return right.end - left.end;
  });
  const normalized: AnswerMarkdownEdit[] = [];
  for (const edit of sorted) {
    const previous = normalized.at(-1);
    if (previous === undefined || edit.start >= previous.end) {
      normalized.push(edit);
      continue;
    }
    const isDuplicate = edit.start === previous.start
      && edit.end === previous.end
      && edit.replacement === previous.replacement;
    if (isDuplicate) {
      continue;
    }
    const isCoveredRemoval = previous.replacement === ""
      && edit.end <= previous.end;
    if (isCoveredRemoval) {
      continue;
    }
    return null;
  }
  return normalized;
}

function applyAnswerMarkdownEdits(
  answer: string,
  edits: readonly AnswerMarkdownEdit[],
): string {
  let edited = answer;
  for (let index = edits.length - 1; index >= 0; index -= 1) {
    const edit = edits[index];
    if (edit === undefined) {
      continue;
    }
    edited = edited.slice(0, edit.start)
      + edit.replacement
      + edited.slice(edit.end);
  }
  return edited;
}
