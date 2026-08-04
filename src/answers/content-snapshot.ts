import {
  isPublishedUncitedAnswerDocument,
  type PublishedAnswerDocument,
} from "./published-schema.js";
import {
  normalizeAnswerModelText,
  type AnswerPresentation,
  type AnswerSection,
} from "./draft.js";

export interface AnswerContentStatement {
  content: string;
  presentation: AnswerPresentation;
  section: AnswerSection;
}

export interface AnswerContentSnapshot {
  statements: AnswerContentStatement[];
}

export function decodePartialAnswerContentSnapshot(
  value: unknown,
): AnswerContentSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const answer = Reflect.get(value, "answer");
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
    return null;
  }
  const answerContent = Reflect.get(answer, "content");
  if (typeof answerContent !== "string" || answerContent === "") {
    return null;
  }
  const normalizedAnswerContent = normalizeAnswerModelText(answerContent);
  if (normalizedAnswerContent === "") {
    return null;
  }
  const statements: AnswerContentStatement[] = [{
    content: normalizedAnswerContent,
    presentation: "paragraph",
    section: "answer",
  }];
  const findings = Reflect.get(value, "findings");
  if (!Array.isArray(findings)) {
    return { statements };
  }
  for (const finding of findings) {
    const content = readPartialFindingContent(finding);
    if (content === null) {
      continue;
    }
    statements.push({
      content,
      presentation: "bullet",
      section: "key-points",
    });
  }
  return { statements };
}

export function createPublishedAnswerContentSnapshot(
  document: PublishedAnswerDocument,
): AnswerContentSnapshot {
  if (isPublishedUncitedAnswerDocument(document)) {
    return {
      statements: [{
        content: document.content,
        presentation: "paragraph",
        section: "answer",
      }],
    };
  }
  const statements: AnswerContentStatement[] = [];
  for (const statement of document.statements) {
    statements.push({
      content: statement.content,
      presentation: statement.presentation,
      section: statement.section,
    });
  }
  return { statements };
}

export function hasAnswerContent(
  snapshot: AnswerContentSnapshot,
): boolean {
  return snapshot.statements.length > 0;
}

function readPartialFindingContent(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const content = Reflect.get(value, "content");
  if (typeof content === "string" && content !== "") {
    const normalizedContent = normalizeAnswerModelText(content);
    return normalizedContent === "" ? null : normalizedContent;
  }
  const claim = Reflect.get(value, "claim");
  if (typeof claim !== "string" || claim === "") {
    return null;
  }
  const normalizedClaim = normalizeAnswerModelText(claim);
  return normalizedClaim === "" ? null : normalizedClaim;
}
