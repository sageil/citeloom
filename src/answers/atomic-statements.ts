import { readClaimsFromAnswerMarkup } from "./claims.js";
import { parseAnswerMarkup } from "./markup.js";

export function readAtomicAnswerStatements(content: string): string[] {
  const claims = readClaimsFromAnswerMarkup(parseAnswerMarkup(content));
  const statements: string[] = [];
  for (const claim of claims) {
    statements.push(claim.claim);
  }
  if (statements.length === 0 && content.trim() !== "") {
    statements.push(content);
  }
  return statements;
}
