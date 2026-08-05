import { normalizeAnswerModelText } from "./draft.js";

export function formatAnswerTopicContent(
  title: string,
  content: string,
): string {
  const normalizedTitle = normalizeAnswerModelText(title);
  const normalizedContent = normalizeAnswerModelText(content);
  if (normalizedContent === "") {
    return normalizedTitle;
  }
  return `${normalizedTitle}\n\n${normalizedContent}`;
}
