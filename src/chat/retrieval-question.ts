import type { AnswerConversationTurn } from "../answers/inference.js";
import type { EmbeddingInputFormatContract } from "../embedding/input-format-model.js";
import { formatQueryEmbeddingText } from "../embedding/input-format.js";
import { countEmbeddingInputTokens } from "../embedding/token-counter.js";
import {
  createConversationQuestionInput,
  createQuestionInput,
  type QuestionInput,
} from "../domain/question.js";

interface ChatRetrievalQuestionConfig {
  inputFormat: EmbeddingInputFormatContract;
  maximumInputTokens: number;
}

export function createChatRetrievalQuestionInput(
  question: string,
  conversationTurns: readonly AnswerConversationTurn[],
  config: ChatRetrievalQuestionConfig,
): QuestionInput {
  const previousTurn = conversationTurns.at(-1);
  if (previousTurn === undefined) {
    return createQuestionInput(question);
  }
  const contextQuery = buildBoundedContextQuery(
    question,
    previousTurn,
    config,
  );
  if (contextQuery === null) {
    return createQuestionInput(question);
  }
  return createConversationQuestionInput(question, contextQuery);
}

function buildBoundedContextQuery(
  question: string,
  previousTurn: AnswerConversationTurn,
  config: ChatRetrievalQuestionConfig,
): string | null {
  const currentOnly = formatContextQuery(question, null, null);
  if (!queryFits(currentOnly, config)) {
    return null;
  }

  const complete = formatContextQuery(
    question,
    previousTurn.user,
    previousTurn.assistant,
  );
  if (queryFits(complete, config)) {
    return complete;
  }

  const previousUserOnly = formatContextQuery(
    question,
    previousTurn.user,
    null,
  );
  if (queryFits(previousUserOnly, config)) {
    return addAssistantPrefixThatFits(
      question,
      previousTurn.user,
      previousTurn.assistant,
      config,
    );
  }

  return addAssistantPrefixThatFits(
    question,
    null,
    previousTurn.assistant,
    config,
  );
}

function addAssistantPrefixThatFits(
  question: string,
  previousUser: string | null,
  previousAssistant: string,
  config: ChatRetrievalQuestionConfig,
): string {
  let low = 0;
  let high = previousAssistant.length;
  let best = formatContextQuery(question, previousUser, null);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const assistantPrefix = previousAssistant.slice(0, middle).trimEnd();
    const candidate = formatContextQuery(
      question,
      previousUser,
      assistantPrefix === "" ? null : assistantPrefix,
    );
    if (queryFits(candidate, config)) {
      best = candidate;
      low = middle + 1;
      continue;
    }
    high = middle - 1;
  }
  return best;
}

function formatContextQuery(
  question: string,
  previousUser: string | null,
  previousAssistant: string | null,
): string {
  const lines: string[] = [];
  if (previousUser !== null) {
    lines.push("Previous user message:", previousUser, "");
  }
  if (previousAssistant !== null) {
    lines.push(
      "Previous assistant response for conversation reference only:",
      previousAssistant,
      "",
    );
  }
  lines.push("Current user message:", question);
  return lines.join("\n");
}

function queryFits(
  question: string,
  config: ChatRetrievalQuestionConfig,
): boolean {
  const providerInput = formatQueryEmbeddingText(config.inputFormat, question);
  return countEmbeddingInputTokens(providerInput) <= config.maximumInputTokens;
}
