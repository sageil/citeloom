import type { ContentBlock } from "@modelcontextprotocol/server";
import type { InferUIMessageChunk } from "ai";

import type {
  CiteLoomUIMessage,
  StreamedAnswer,
} from "../../answers/stream.js";
import type { AuthorizationPrincipal } from "../../auth/model.js";
import type { WebServices } from "../../api/services.js";
import {
  buildMcpAnswerTaskResult,
  type McpAnswerTaskRequest,
  type McpAnswerTaskResult,
} from "./model.js";

export async function executeMcpAnswerTask(
  services: WebServices,
  principals: readonly AuthorizationPrincipal[],
  request: McpAnswerTaskRequest,
  abortSignal: AbortSignal,
): Promise<McpAnswerTaskResult> {
  const principal = readFirstPrincipal(principals);
  const workspaceIds = principals.map((workspacePrincipal) => {
    return workspacePrincipal.workspaceId;
  });
  const combinedPrincipal: AuthorizationPrincipal = {
    ...principal,
    dataScope: "all",
  };
  const answer = await services.run(
    async (runtime) => {
      const thread = await runtime.createResearchThread(
        combinedPrincipal,
        request.threadTitle,
      );
      const stream = runtime.streamAnswer(
        combinedPrincipal,
        {
          question: request.question,
          scope: request.scope,
          threadId: thread.id,
        },
        abortSignal,
        workspaceIds,
      );
      return readStreamedAnswer(stream);
    },
  );
  return buildMcpAnswerTaskResult(
    answer,
    buildAnswerContent(answer),
    workspaceIds,
  );
}

function readFirstPrincipal(
  principals: readonly AuthorizationPrincipal[],
): AuthorizationPrincipal {
  const principal = principals[0];
  if (principal === undefined) {
    throw new Error("The MCP user has no available workspace.");
  }
  return principal;
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

function buildAnswerContent(
  answer: StreamedAnswer,
): ContentBlock[] {
  return [{
    text: answer.answerDocument.content,
    type: "text",
  }];
}
