import type {
  AnswerConversationTurn,
  AnswerGenerationPrompt,
  AnswerUserPromptFrame,
} from "../answers/inference.js";
import { ASK_GENERATION_PROMPT } from "../answers/inference.js";
export { createChatSystemPrompt } from "../answers/system-prompt.js";

export const CHAT_GENERATION_PROMPT: AnswerGenerationPrompt = {
  ...ASK_GENERATION_PROMPT,
  buildUserPromptFrame: buildChatUserPromptFrame,
};

function buildChatUserPromptFrame(
  question: string,
  conversationTurns: readonly AnswerConversationTurn[],
): AnswerUserPromptFrame {
  if (conversationTurns.length === 0) {
    return ASK_GENERATION_PROMPT.buildUserPromptFrame(
      question,
      conversationTurns,
    );
  }
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
