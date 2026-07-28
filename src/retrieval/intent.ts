export function isBroadDocumentQuestionForSource(
  query: string,
  sourceFile: string,
): boolean {
  const subjectTokens = readBroadDocumentSubjectTokens(query);
  if (subjectTokens === null) {
    return false;
  }
  const filename = sourceFile.split(/[\\/]/u).at(-1) ?? sourceFile;
  const sourceTokens = new Set(tokenizeDocumentName(filename));
  for (const token of subjectTokens) {
    if (!sourceTokens.has(token)) {
      return false;
    }
  }
  return true;
}

function readBroadDocumentSubjectTokens(query: string): string[] | null {
  const normalized = query.trim().replace(/[?.!]+$/u, "").trim();
  const patterns = [
    /^what\s+(?:is|are|was|were)\s+(.+)$/iu,
    /^tell\s+me\s+about\s+(.+)$/iu,
    /^give\s+me\s+an?\s+overview\s+of\s+(.+)$/iu,
  ];
  let subject: string | null = null;
  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    if (match?.[1] !== undefined) {
      subject = match[1];
      break;
    }
  }
  if (subject === null) {
    return null;
  }
  const tokens = tokenizeDocumentName(subject);
  if (tokens.length < 2) {
    return null;
  }
  return tokens;
}

function tokenizeDocumentName(value: string): string[] {
  const ignoredTokens = new Set(["a", "an", "the"]);
  const tokens: string[] = [];
  for (const match of value.toLocaleLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const token = match[0];
    if (ignoredTokens.has(token)) {
      continue;
    }
    tokens.push(token);
  }
  return tokens;
}
