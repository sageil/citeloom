import type { AuthenticatedPrincipal } from "../auth/model.js";
import { countEmbeddingInputTokens } from "../embedding/token-counter.js";
import { formatDocumentEmbeddingText } from "../embedding/input-format.js";
import {
  embedDocumentInputs,
  embedQuestions,
  type DocumentEmbeddingInput,
} from "../embedding/inference.js";
import type { ApplicationRuntime } from "../app/runtime.js";
import type { AnswerConversationTurn } from "../answers/inference.js";
import type {
  ChatMemorySelection,
  ChatMemoryTrace,
} from "./types.js";
import type {
  ChatMemoryTurnRecord,
  ChatMessageEmbeddingPart,
  ChatMessageEmbeddingRecord,
  ChatStore,
} from "./store.js";

const RECENT_TURN_COUNT = 4;
const SEMANTIC_TURN_LIMIT = 8;
const MAXIMUM_MEMORY_TOKENS = 8_000;
const MINIMUM_MEMORY_TOKENS = 512;

interface EmbeddingSource {
  content: string;
  messageId: string;
}

export interface SelectedChatMemory {
  conversationTurns: AnswerConversationTurn[];
  questionContextTurns: AnswerConversationTurn[];
  trace: ChatMemoryTrace;
}

export async function prepareChatMemory(
  runtime: ApplicationRuntime,
  store: ChatStore,
  principal: AuthenticatedPrincipal,
  conversationId: string,
  runId: string,
  queryMessageId: string,
  question: string,
  abortSignal: AbortSignal,
): Promise<SelectedChatMemory> {
  const embeddingScheduler = runtime.scheduler(
    "embedding",
    "interactive-answer",
  );
  const missing = await store.readMessagesMissingEmbeddings(
    principal,
    conversationId,
    runtime.config.embeddingSpace.id,
    runtime.config.embeddingSpace.dimensions,
  );
  const missingParts = await embedMissingMessages(
    runtime,
    missing,
    embeddingScheduler,
    abortSignal,
  );
  await store.saveMessageEmbeddings(
    runtime.config.embeddingSpace.id,
    runtime.config.embeddingSpace.dimensions,
    missingParts,
  );
  abortSignal.throwIfAborted();

  const turns = await store.readCompletedMemoryTurns(
    principal,
    conversationId,
    runId,
  );
  const readCapabilities = runtime.models.readChatCapabilities
    ?? runtime.models.readAnswerCapabilities;
  const capabilities = await readCapabilities(abortSignal);
  const maximumTokens = Math.max(
    MINIMUM_MEMORY_TOKENS,
    Math.min(
      MAXIMUM_MEMORY_TOKENS,
      Math.floor(capabilities.contextCapacityTokens * 0.2),
    ),
  );
  const fullHistory = selectWholeTurns(
    turns,
    turns.map((turn) => ({
      reason: "recent" as const,
      runId: turn.runId,
      score: null,
    })),
    maximumTokens,
    capabilities.tokenCounter.countTextTokens,
  );
  if (fullHistory.selected.length === turns.length) {
    return buildSelectedMemory(
      fullHistory.selected,
      queryMessageId,
      runtime.config.embeddingSpace.id,
      maximumTokens,
    );
  }

  const queryEmbeddings = await embedQuestions(
    runtime.models,
    [question],
    embeddingScheduler,
    abortSignal,
  );
  const queryEmbedding = queryEmbeddings[0];
  if (queryEmbedding === undefined) {
    throw new Error("Chat memory query did not produce an embedding.");
  }
  const semanticHits = await store.searchSemanticMemory(
    principal,
    conversationId,
    runId,
    runtime.config.embeddingSpace.id,
    runtime.config.embeddingSpace.dimensions,
    queryEmbedding,
    SEMANTIC_TURN_LIMIT,
  );
  const recent = turns.slice(-RECENT_TURN_COUNT);
  const recentIds = new Set(recent.map((turn) => turn.runId));
  const candidates: Array<{
    reason: "recent" | "semantic";
    runId: string;
    score: number | null;
  }> = [];
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const turn = recent[index];
    if (turn === undefined) {
      continue;
    }
    candidates.push({
      reason: "recent",
      runId: turn.runId,
      score: null,
    });
  }
  for (const hit of semanticHits) {
    if (recentIds.has(hit.runId)) {
      continue;
    }
    candidates.push({
      reason: "semantic",
      runId: hit.runId,
      score: hit.score,
    });
  }
  const selected = selectWholeTurns(
    turns,
    candidates,
    maximumTokens,
    capabilities.tokenCounter.countTextTokens,
  );
  return buildSelectedMemory(
    selected.selected,
    queryMessageId,
    runtime.config.embeddingSpace.id,
    maximumTokens,
  );
}

async function embedMissingMessages(
  runtime: ApplicationRuntime,
  messages: readonly ChatMessageEmbeddingRecord[],
  scheduler: ReturnType<ApplicationRuntime["scheduler"]>,
  abortSignal: AbortSignal,
): Promise<ChatMessageEmbeddingPart[]> {
  const inputs: Array<DocumentEmbeddingInput<EmbeddingSource>> = [];
  for (const message of messages) {
    const content = formatChatEmbeddingContent(message.role, message.content);
    inputs.push(createEmbeddingInput(runtime, message.id, content));
  }
  const embedded = await embedDocumentInputs(
    runtime.models,
    inputs,
    scheduler,
    abortSignal,
    (input, maximumInputTokens) => {
      return splitEmbeddingInput(runtime, input, maximumInputTokens);
    },
  );
  const ordinalByMessage = new Map<string, number>();
  const parts: ChatMessageEmbeddingPart[] = [];
  for (const result of embedded) {
    const ordinal = ordinalByMessage.get(result.source.messageId) ?? 0;
    ordinalByMessage.set(result.source.messageId, ordinal + 1);
    parts.push({
      content: result.source.content,
      embedding: result.embedding,
      inputTokens: countProviderInputTokens(runtime, result.source.content),
      messageId: result.source.messageId,
      partOrdinal: ordinal,
    });
  }
  const embeddedMessageIds = new Set(parts.map((part) => part.messageId));
  for (const message of messages) {
    if (!embeddedMessageIds.has(message.id)) {
      throw new Error(`Chat message ${message.id} did not produce an embedding.`);
    }
  }
  return parts;
}

export async function embedChatMessageParts(
  runtime: ApplicationRuntime,
  messageId: string,
  role: "assistant" | "user",
  content: string,
  abortSignal: AbortSignal,
): Promise<ChatMessageEmbeddingPart[]> {
  const embeddingContent = formatChatEmbeddingContent(role, content);
  const input = createEmbeddingInput(runtime, messageId, embeddingContent);
  const embedded = await embedDocumentInputs(
    runtime.models,
    [input],
    runtime.scheduler("embedding", "interactive-answer"),
    abortSignal,
    (rejected, maximumInputTokens) => {
      return splitEmbeddingInput(runtime, rejected, maximumInputTokens);
    },
  );
  const parts: ChatMessageEmbeddingPart[] = [];
  for (let index = 0; index < embedded.length; index += 1) {
    const result = embedded[index];
    if (result === undefined) {
      continue;
    }
    parts.push({
      content: result.source.content,
      embedding: result.embedding,
      inputTokens: countProviderInputTokens(runtime, result.source.content),
      messageId,
      partOrdinal: index,
    });
  }
  if (parts.length === 0) {
    throw new Error(`Chat ${role} message did not produce an embedding.`);
  }
  return parts;
}

function createEmbeddingInput(
  runtime: ApplicationRuntime,
  messageId: string,
  content: string,
): DocumentEmbeddingInput<EmbeddingSource> {
  return {
    inputTokens: countProviderInputTokens(runtime, content),
    source: { content, messageId },
    value: content,
  };
}

function splitEmbeddingInput(
  runtime: ApplicationRuntime,
  input: DocumentEmbeddingInput<EmbeddingSource>,
  maximumInputTokens: number,
): Array<DocumentEmbeddingInput<EmbeddingSource>> {
  const pieces = splitText(input.source.content, maximumInputTokens, (value) => {
    return countProviderInputTokens(runtime, value);
  });
  return pieces.map((content) => {
    return createEmbeddingInput(runtime, input.source.messageId, content);
  });
}

function splitText(
  content: string,
  maximumTokens: number,
  countTokens: (content: string) => number,
): string[] {
  if (countTokens(content) <= maximumTokens) {
    return [content];
  }
  const pieces: string[] = [];
  let remaining = content;
  while (countTokens(remaining) > maximumTokens) {
    const splitIndex = findSplitIndex(remaining, maximumTokens, countTokens);
    const piece = remaining.slice(0, splitIndex).trim();
    if (piece === "") {
      throw new Error("Chat message could not be split for embedding.");
    }
    pieces.push(piece);
    remaining = remaining.slice(splitIndex).trimStart();
  }
  if (remaining !== "") {
    pieces.push(remaining);
  }
  return pieces;
}

function findSplitIndex(
  content: string,
  maximumTokens: number,
  countTokens: (content: string) => number,
): number {
  const boundaries: number[] = [];
  for (const match of content.matchAll(/(?:\p{P}+\s+|\s+)/gu)) {
    if (match.index === undefined || match[0] === undefined) {
      continue;
    }
    boundaries.push(match.index + match[0].length);
  }
  for (let index = boundaries.length - 1; index >= 0; index -= 1) {
    const boundary = boundaries[index];
    if (
      boundary !== undefined
      && countTokens(content.slice(0, boundary)) <= maximumTokens
    ) {
      return boundary;
    }
  }
  let low = 1;
  let high = content.length;
  let best = 0;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (countTokens(content.slice(0, middle)) <= maximumTokens) {
      best = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best < 1) {
    throw new Error("Embedding input format leaves no room for message content.");
  }
  return best;
}

function countProviderInputTokens(
  runtime: ApplicationRuntime,
  content: string,
): number {
  const providerInput = formatDocumentEmbeddingText(
    runtime.config.embeddingSpace.inputFormat,
    content,
  );
  return countEmbeddingInputTokens(providerInput);
}

function formatChatEmbeddingContent(
  role: "assistant" | "user",
  content: string,
): string {
  const label = role === "user" ? "User message" : "Assistant answer";
  return `${label}:\n${content}`;
}

function selectWholeTurns(
  turns: readonly ChatMemoryTurnRecord[],
  candidates: readonly {
    reason: "recent" | "semantic";
    runId: string;
    score: number | null;
  }[],
  maximumTokens: number,
  countTokens: (content: string) => number,
): {
  selected: Array<{
    selection: ChatMemorySelection;
    turn: ChatMemoryTurnRecord;
  }>;
} {
  const turnById = new Map(turns.map((turn) => [turn.runId, turn]));
  const selected: Array<{
    selection: ChatMemorySelection;
    turn: ChatMemoryTurnRecord;
  }> = [];
  const selectedIds = new Set<string>();
  let usedTokens = 0;
  for (const candidate of candidates) {
    if (selectedIds.has(candidate.runId)) {
      continue;
    }
    const turn = turnById.get(candidate.runId);
    if (turn === undefined) {
      continue;
    }
    const content = formatConversationTurn(turn);
    const tokens = countTokens(content);
    if (usedTokens + tokens > maximumTokens) {
      continue;
    }
    selectedIds.add(candidate.runId);
    usedTokens += tokens;
    selected.push({
      selection: {
        assistantMessageId: turn.assistantMessageId,
        reason: candidate.reason,
        runId: turn.runId,
        score: candidate.score,
        sequence: turn.sequence,
        userMessageId: turn.userMessageId,
      },
      turn,
    });
  }
  selected.sort((left, right) => {
    return left.turn.sequence - right.turn.sequence;
  });
  return { selected };
}

function buildSelectedMemory(
  selected: readonly {
    selection: ChatMemorySelection;
    turn: ChatMemoryTurnRecord;
  }[],
  queryMessageId: string,
  embeddingSpaceId: string,
  maximumTokens: number,
): SelectedChatMemory {
  const conversationTurns: AnswerConversationTurn[] = [];
  const questionContextTurns: AnswerConversationTurn[] = [];
  for (const item of selected) {
    conversationTurns.push({
      assistant: formatAssistantMemoryContext(item.turn),
      user: item.turn.userContent,
    });
    questionContextTurns.push({
      assistant: item.turn.assistantContent,
      user: item.turn.userContent,
    });
  }
  return {
    conversationTurns,
    questionContextTurns,
    trace: {
      embeddingSpaceId,
      maximumTokens,
      policyId: "citeloom/chat-memory:recent-semantic-v1",
      queryMessageId,
      selectedTurns: selected.map((item) => item.selection),
      version: 1,
    },
  };
}

function formatConversationTurn(turn: ChatMemoryTurnRecord): string {
  const assistant = formatAssistantMemoryContext(turn);
  return `User:\n${turn.userContent}\n\nAssistant:\n${assistant}\n`;
}

function formatAssistantMemoryContext(turn: ChatMemoryTurnRecord): string {
  if (turn.citationSources.length === 0) {
    return turn.assistantContent;
  }
  const citationSources: string[] = [];
  for (const citation of turn.citationSources) {
    citationSources.push(JSON.stringify({
      citationNumber: citation.citationNumber,
      pageNumbers: citation.pageNumbers,
      sectionPath: citation.sectionPath,
      sourceFile: citation.sourceFile,
    }));
  }
  return [
    turn.assistantContent,
    "",
    "Citation source map for the prior assistant answer:",
    ...citationSources,
  ].join("\n");
}
