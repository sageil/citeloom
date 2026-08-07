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
  const label = normalizedTitle.replace(/[:.]+$/u, "");
  if (label === "") {
    return normalizedContent;
  }
  return `${label}: ${normalizedContent}`;
}
