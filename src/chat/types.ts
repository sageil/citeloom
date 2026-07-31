import type { PublishedAnswerDocument } from "../answers/published.js";
import type { QueryScope } from "../domain/query-scope.js";
import type { SourceRegion } from "../domain/source-elements.js";
import type {
  CitationEvidence,
  ClaimVerificationResult,
  ResearchRunConfiguration,
} from "../research/types.js";

export type ChatRunState =
  | "accepted"
  | "embedding"
  | "retrieving"
  | "generating"
  | "verifying"
  | "publishing"
  | "completed"
  | "failed"
  | "canceled";

export type ChatMessageRole = "assistant" | "user";

export type ChatVerificationState =
  | "not-applicable"
  | "pending"
  | "running"
  | "completed"
  | "failed";

export interface ChatClaimVerificationResult
  extends Omit<ClaimVerificationResult, "status"> {
  status: ClaimVerificationResult["status"] | "collectively-supported";
}

export interface ChatMemorySelection {
  assistantMessageId: string;
  reason: "recent" | "semantic";
  runId: string;
  score: number | null;
  sequence: number;
  userMessageId: string;
}

export interface ChatMemoryTrace {
  embeddingSpaceId: string;
  maximumTokens: number;
  policyId: "citeloom/chat-memory:recent-semantic-v1";
  queryMessageId: string;
  selectedTurns: ChatMemorySelection[];
  version: 1;
}

export interface ChatRunConfiguration
  extends Omit<ResearchRunConfiguration, "models"> {
  models: {
    chat: string;
    embedding: string;
    reranker: string | null;
    verifier: string;
  };
}

export interface StoredChatCitation {
  citationNumber: number;
  createdAt: string;
  documentId: string;
  documentVersionId: string;
  elementId: string;
  evidence: CitationEvidence;
  id: string;
  mediaType: string;
  pageNumbers: number[];
  regions: SourceRegion[];
  sectionPath: string[];
  sourceAvailable: boolean;
  sourceFile: string;
}

export interface ChatUserMessage {
  content: string;
  createdAt: string;
  id: string;
  role: "user";
  runId: string;
}

export interface ChatAssistantMessage {
  answerDocument: PublishedAnswerDocument;
  citations: StoredChatCitation[];
  claims: ChatClaimVerificationResult[];
  content: string;
  createdAt: string;
  id: string;
  role: "assistant";
  runId: string;
  verificationState: ChatVerificationState;
}

export type ChatMessage = ChatAssistantMessage | ChatUserMessage;

export interface ChatRun {
  attemptCount: number;
  completedAt: string | null;
  errorMessage: string | null;
  id: string;
  messages: ChatMessage[];
  sequence: number;
  state: ChatRunState;
}

export interface ChatConversation {
  createdAt: string;
  id: string;
  ownerUserId: string;
  runs: ChatRun[];
  scope: QueryScope;
  title: string;
  updatedAt: string;
  workspaceId: string;
}

export interface ChatConversationSummary {
  createdAt: string;
  id: string;
  messageCount: number;
  title: string;
  updatedAt: string;
}

export interface ChatCitationEvidenceRecord {
  citation: StoredChatCitation;
  imageContent: Buffer | null;
}
