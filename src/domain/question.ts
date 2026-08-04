declare const processingQuestionBrand: unique symbol;

export const QUESTION_PROCESSING_POLICY_ID =
  "citeloom/question-processing:terminal-sentence-punctuation-v1";

export type ProcessingQuestion = string & {
  readonly [processingQuestionBrand]: true;
};

export type QuestionRetrievalQueryKind = "conversation" | "original";

export interface QuestionRetrievalQuery {
  kind: QuestionRetrievalQueryKind;
  text: ProcessingQuestion;
}

export interface QuestionInput {
  original: string;
  policyId: typeof QUESTION_PROCESSING_POLICY_ID;
  processing: ProcessingQuestion;
  retrievalQueries: QuestionRetrievalQuery[];
}

export function createQuestionInput(question: string): QuestionInput {
  const processing = createProcessingQuestion(question);
  return {
    original: question,
    policyId: QUESTION_PROCESSING_POLICY_ID,
    processing,
    retrievalQueries: [{ kind: "original", text: processing }],
  };
}

export function createConversationQuestionInput(
  question: string,
  conversationQuestion: string,
): QuestionInput {
  const input = createQuestionInput(question);
  const conversation = createProcessingQuestion(conversationQuestion);
  if (
    conversation.trim() !== ""
    && conversation.localeCompare(input.processing, undefined, {
      sensitivity: "base",
    }) !== 0
  ) {
    input.retrievalQueries.push({
      kind: "conversation",
      text: conversation,
    });
  }
  return input;
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
