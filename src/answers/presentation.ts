import type {
  AnswerDraftSection,
  AnswerPresentation,
} from "./draft.js";

export interface AnswerPresentationPolicy {
  presentation: AnswerPresentation;
  section: AnswerDraftSection;
}

export type AnswerSemanticShape = "prose" | "set";

export function readAnswerPresentationPolicy(
  statementCount: number,
  semanticShape: AnswerSemanticShape | null = null,
): AnswerPresentationPolicy {
  if (!Number.isInteger(statementCount) || statementCount < 1) {
    throw new Error(
      "Answered presentation requires at least one valid statement.",
    );
  }
  let presentation: AnswerPresentation;
  if (semanticShape === "set") {
    presentation = "bullet";
  } else if (semanticShape === "prose") {
    presentation = "paragraph";
  } else {
    presentation = statementCount > 1 ? "bullet" : "paragraph";
  }
  return {
    presentation,
    section: "answer",
  };
}

export function readAnswerSemanticShape(
  value: string,
): AnswerSemanticShape | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "prose" || normalized === "set") {
    return normalized;
  }
  return null;
}

export function createAnswerSemanticShapeSystemPrompt(): string {
  return [
    "Classify the semantic answer shape implied by the original question.",
    "",
    'Return "set" only when a complete answer consists of distinct requested members, categories, options, or named entities that can stand as separate answer items.',
    "",
    'A request for the recognized kinds, forms, categories, or members of something has the "set" shape even when it is not phrased as a command to make a list.',
    "",
    'Return "prose" for explanations, causes, definitions, comparisons, procedures, locations, errors, and other answers whose facts form one explanation even when several statements may be needed.',
    "",
    "Classify the question's requested answer shape without answering the question.",
    "",
    "Do not infer presentation from any proposed answer text.",
    "",
    'Return exactly one token: "prose" or "set".',
  ].join("\n");
}
