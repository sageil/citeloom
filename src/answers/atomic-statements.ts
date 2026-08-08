import { readClaimsFromAnswerMarkup } from "./claims.js";
import { parseStructuredAnswerMarkup } from "./markup.js";

export function readAtomicAnswerStatements(content: string): string[] {
  const markup = parseStructuredAnswerMarkup(content);
  const claims = readClaimsFromAnswerMarkup(markup);
  const statements: string[] = [];
  for (const claim of claims) {
    statements.push(claim.claim);
  }
  if (statements.length === 0 && content.trim() !== "") {
    statements.push(content);
  }
  return statements;
}
