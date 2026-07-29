declare const processingQuestionBrand: unique symbol;

export const QUESTION_PROCESSING_POLICY_ID =
  "citeloom/question-processing:terminal-sentence-punctuation-v1";

export type ProcessingQuestion = string & {
  readonly [processingQuestionBrand]: true;
};

export interface QuestionInput {
  original: string;
  policyId: typeof QUESTION_PROCESSING_POLICY_ID;
  processing: ProcessingQuestion;
}

export function createQuestionInput(question: string): QuestionInput {
  return {
    original: question,
    policyId: QUESTION_PROCESSING_POLICY_ID,
    processing: createProcessingQuestion(question),
  };
}

export function createProcessingQuestion(
  question: string,
): ProcessingQuestion {
  const trimmedQuestion = question.trimEnd();
  const processingQuestion = trimmedQuestion.replace(/[.?!]+$/u, "");
  if (processingQuestion.trim() === "") {
    return trimmedQuestion as ProcessingQuestion;
  }
  return processingQuestion as ProcessingQuestion;
}
