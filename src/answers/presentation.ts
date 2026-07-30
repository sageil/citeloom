import type {
  AnswerDraftSection,
  AnswerPresentation,
} from "./draft.js";

export interface AnswerPresentationPolicy {
  presentation: AnswerPresentation;
  section: AnswerDraftSection;
}

export function readAnswerPresentationPolicy(
  statementCount: number,
): AnswerPresentationPolicy {
  if (!Number.isInteger(statementCount) || statementCount < 1) {
    throw new Error(
      "Answered presentation requires at least one valid statement.",
    );
  }
  return {
    presentation: "paragraph",
    section: "answer",
  };
}
