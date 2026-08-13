import type { ContentBlock } from "@modelcontextprotocol/server";
import type { InferUIMessageChunk } from "ai";

import type {
  CiteLoomUIMessage,
  StreamedAnswer,
} from "../../answers/stream.js";
import type { AuthorizationPrincipal } from "../../auth/model.js";
import type { WebServices } from "../../api/services.js";
import {
  MCP_CITATION_RESOURCE_TEMPLATE,
  MCP_THREAD_RESOURCE_TEMPLATE,
} from "../contract.js";
import {
  buildMcpAnswerTaskResult,
  type McpAnswerTaskRequest,
  type McpAnswerTaskResult,
} from "./model.js";

export async function executeMcpAnswerTask(
  services: WebServices,
  principal: AuthorizationPrincipal,
  request: McpAnswerTaskRequest,
  abortSignal: AbortSignal,
): Promise<McpAnswerTaskResult> {
  const answer = await services.runInWorkspace(
    principal,
    async (runtime) => {
      const thread = await runtime.createResearchThread(
        principal,
        request.threadTitle,
      );
      const stream = runtime.streamAnswer(
        principal,
        {
          question: request.question,
          scope: request.scope,
          threadId: thread.id,
        },
        abortSignal,
      );
      return readStreamedAnswer(stream);
    },
  );
  return buildMcpAnswerTaskResult(answer, buildAnswerContent(answer));
}

async function readStreamedAnswer(
  stream: ReadableStream<InferUIMessageChunk<CiteLoomUIMessage>>,
): Promise<StreamedAnswer> {
  let answer: StreamedAnswer | null = null;
  for await (const part of stream) {
    if (part.type === "data-answer") {
      answer = part.data;
    }
  }
  if (answer === null) {
    throw new Error("The answer stream completed without a final answer.");
  }
  return answer;
}

function buildAnswerContent(answer: StreamedAnswer): ContentBlock[] {
  const content: ContentBlock[] = [{
    text: answer.answerDocument.content,
    type: "text",
  }, {
    description: "The saved research thread containing this answer.",
    mimeType: "application/json",
    name: "research-thread",
    title: "Saved research thread",
    type: "resource_link",
    uri: buildResearchThreadResourceUri(answer.turn.threadId),
  }];
  for (const citation of answer.answerDocument.citations) {
    content.push({
      description: `Citation ${citation.citationNumber} from ${citation.sourceFile}.`,
      mimeType: "application/json",
      name: `citation-${citation.citationNumber}`,
      title: `Citation ${citation.citationNumber}`,
      type: "resource_link",
      uri: buildCitationResourceUri(citation.id),
    });
  }
  return content;
}

function buildResearchThreadResourceUri(threadId: string): string {
  return MCP_THREAD_RESOURCE_TEMPLATE.replace("{threadId}", threadId);
}

function buildCitationResourceUri(citationId: string): string {
  return MCP_CITATION_RESOURCE_TEMPLATE.replace("{citationId}", citationId);
}
