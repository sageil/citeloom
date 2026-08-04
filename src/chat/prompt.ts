import type {
  AnswerConversationTurn,
  AnswerGenerationPrompt,
  AnswerUserPromptFrame,
} from "../answers/inference.js";
import {
  createChatSystemPrompt,
} from "../answers/system-prompt.js";
export { createChatSystemPrompt } from "../answers/system-prompt.js";
import type {
  RetrievedElement,
} from "../retrieval/document-retrieval.js";
import { CHAT_ANSWER_RESPONSE } from "./answer-response.js";

export const CHAT_GENERATION_PROMPT: AnswerGenerationPrompt = {
  buildUserPromptFrame: buildChatUserPromptFrame,
  createEvidenceReferences: createChatEvidenceReferences,
  responseContract: CHAT_ANSWER_RESPONSE,
  systemPrompt: createChatSystemPrompt(),
};

function createChatEvidenceReferences(
  retrieved: readonly RetrievedElement[],
): string[] {
  const references: string[] = [];
  for (let index = 0; index < retrieved.length; index += 1) {
    references.push(`SOURCE_${index + 1}`);
  }
  return references;
}

function buildChatUserPromptFrame(
  question: string,
  conversationTurns: readonly AnswerConversationTurn[],
): AnswerUserPromptFrame {
  const conversationContext = formatConversationContext(conversationTurns);

  return {
    afterSources: [
      "</retrieved_sources>",
      "",
      "<current_question>",
      question,
      "</current_question>",
    ].join("\n"),

    beforeSources: [
      "USER_PROMPT",
      "---------",
      "<conversation_context>",
      conversationContext,
      "</conversation_context>",
      "",
      "<retrieved_sources>",
    ].join("\n"),

    correctionPlacement: "after-sources",
  };
}

function formatConversationContext(
  conversationTurns: readonly AnswerConversationTurn[],
): string {
  if (conversationTurns.length === 0) {
    return "(no prior conversation turns selected)";
  }

  const lines: string[] = [];

  for (let index = 0; index < conversationTurns.length; index += 1) {
    const turn = conversationTurns[index];

    if (turn === undefined) {
      continue;
    }

    lines.push(
      `<turn index="${index + 1}">`,
      "<user>",
      turn.user,
      "</user>",
      "<assistant>",
      turn.assistant,
      "</assistant>",
      "</turn>",
    );
  }

  return lines.join("\n");
}
