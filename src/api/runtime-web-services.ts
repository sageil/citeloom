import type { InferUIMessageChunk } from "ai";

import type { CiteLoomUIMessage } from "../answers/stream.js";
import type { ApplicationStateRevisionSnapshot } from "../app/application-state-revisions.js";
import type { AuthorizationPrincipal } from "../auth/model.js";
import type { ChatMessageRequest } from "../chat/pipeline.js";
import type {
  ChatConversation,
  ChatConversationSummary,
  StoredChatCitation,
} from "../chat/types.js";
import type { AppConfig } from "../config/index.js";
import type { QueryScope } from "../domain/query-scope.js";
import type {
  BrowseDocumentCatalogRequest,
  BrowseDocumentCatalogResult,
} from "../documents/catalog/browser.js";
import type { IngestionControlActor } from "../documents/catalog/index.js";
import type {
  IndexedDocumentFile,
  ReadDocumentFileRequest,
  UpdateIndexedDocumentTagsRequest,
  UpdateIndexedDocumentTagsResult,
} from "../documents/catalog/service.js";
import type {
  BulkIngestResult,
  IngestOptions,
  ReindexDocumentRequest,
  ReindexDocumentResult,
  RetryFailedIngestionResult,
  StagedIngestionDocument,
} from "../ingestion/service.js";
import type { DeleteIndexedDocumentResult } from "../ingestion/deletion.js";
import type { SystemStatus } from "../ingestion/worker.js";
import type { DoctorCheck, DoctorLiveChecks } from "../observability/doctor.js";
import type { TelemetryDashboardSummary } from "../observability/store.js";
import type {
  GeneratedSpeech,
  SpeechRequest,
} from "../providers/text-to-speech.js";
import type {
  TranscriptionAudio,
  TranscriptionResult,
} from "../providers/speech-to-text.js";
import type {
  DocumentVersionDifference,
  DocumentVersionRecord,
  FeedbackDimension,
  ResearchFeedbackSummary,
  ResearchThread,
  ResearchThreadSummary,
  StoredCitationRecord,
} from "../research/types.js";
import type {
  ResearchExport,
  ResearchExportFormat,
} from "../research/store.js";
import type {
  SourceDiscoveryRequest,
  SourceDiscoveryResponse,
} from "../retrieval/discovery/schema.js";
import type {
  QuestionRequest,
} from "./request-boundary.js";
import type {
  requestIngestionControlWithRuntime,
  resumeIngestionWithRuntime,
} from "../ingestion/service.js";

export interface RuntimeDocumentServices {
  browseDocuments: (
    principal: AuthorizationPrincipal,
    request: BrowseDocumentCatalogRequest,
  ) => Promise<BrowseDocumentCatalogResult>;
  compareDocumentVersions: (
    principal: AuthorizationPrincipal,
    previousVersionId: string,
    currentVersionId: string,
  ) => Promise<DocumentVersionDifference | null>;
  deleteIndexedDocument: (
    principal: AuthorizationPrincipal,
    request: ReindexDocumentRequest,
  ) => Promise<DeleteIndexedDocumentResult>;
  ingest: (
    principal: AuthorizationPrincipal,
    documents: readonly StagedIngestionDocument[],
    options: IngestOptions,
    duplicateSourceRoot: string,
    requestedSourceLibraryId: string | null,
  ) => Promise<BulkIngestResult>;
  listDocumentVersions: (
    principal: AuthorizationPrincipal,
    sourceFile: string,
  ) => Promise<DocumentVersionRecord[]>;
  readDocumentFile: (
    principal: AuthorizationPrincipal,
    request: ReadDocumentFileRequest,
  ) => Promise<IndexedDocumentFile | null>;
  readVersionedDocumentFile: (
    principal: AuthorizationPrincipal,
    id: string,
  ) => Promise<IndexedDocumentFile | null>;
  reindexDocument: (
    principal: AuthorizationPrincipal,
    request: ReindexDocumentRequest,
    actor: IngestionControlActor,
  ) => Promise<ReindexDocumentResult>;
  requestIngestionControl: (
    principal: AuthorizationPrincipal,
    sourceFile: string,
    action: "pause" | "cancel",
    actor: IngestionControlActor,
  ) => ReturnType<typeof requestIngestionControlWithRuntime>;
  resumeIngestion: (
    principal: AuthorizationPrincipal,
    sourceFile: string,
    actor: IngestionControlActor,
  ) => ReturnType<typeof resumeIngestionWithRuntime>;
  retryFailedJob: (
    principal: AuthorizationPrincipal,
    sourceFile: string,
  ) => Promise<RetryFailedIngestionResult>;
  updateDocumentTags: (
    principal: AuthorizationPrincipal,
    request: UpdateIndexedDocumentTagsRequest,
  ) => Promise<UpdateIndexedDocumentTagsResult | null>;
}

export interface RuntimeResearchServices {
  addResearchFeedback: (principal: AuthorizationPrincipal, input: {
    citationId: string | null;
    comment: string | null;
    dimension: FeedbackDimension;
    rating: -1 | 1;
    turnId: string;
  }) => Promise<ResearchFeedbackSummary>;
  createResearchThread: (
    principal: AuthorizationPrincipal,
    title: string,
  ) => Promise<ResearchThread>;
  deleteResearchThread: (
    principal: AuthorizationPrincipal,
    id: string,
  ) => Promise<void>;
  exportResearchThread: (
    principal: AuthorizationPrincipal,
    id: string,
    format: ResearchExportFormat,
  ) => Promise<ResearchExport | null>;
  listResearchThreads: (
    principal: AuthorizationPrincipal,
  ) => Promise<ResearchThreadSummary[]>;
  processNextResearchVerification: (
    abortSignal: AbortSignal,
  ) => Promise<boolean>;
  readCitationEvidence: (
    principal: AuthorizationPrincipal,
    id: string,
  ) => Promise<StoredCitationRecord | null>;
  readCitationHighlightedFile: (
    principal: AuthorizationPrincipal,
    id: string,
  ) => Promise<IndexedDocumentFile | null>;
  readCitationImage: (principal: AuthorizationPrincipal, id: string) => Promise<{
    content: Buffer;
    mediaType: string;
  } | null>;
  readResearchFeedback: (
    principal: AuthorizationPrincipal,
    turnId: string,
    dimension: FeedbackDimension,
    citationId: string | null,
  ) => Promise<ResearchFeedbackSummary>;
  readResearchThread: (
    principal: AuthorizationPrincipal,
    id: string,
  ) => Promise<ResearchThread | null>;
  searchSources: (
    principal: AuthorizationPrincipal,
    request: SourceDiscoveryRequest,
    abortSignal: AbortSignal,
  ) => Promise<SourceDiscoveryResponse>;
  streamAnswer: (
    principal: AuthorizationPrincipal,
    request: QuestionRequest,
    abortSignal: AbortSignal,
  ) => ReadableStream<InferUIMessageChunk<CiteLoomUIMessage>>;
}

export interface RuntimeChatServices {
  createChatConversation: (
    principal: AuthorizationPrincipal,
    title: string,
    scope: QueryScope,
  ) => Promise<ChatConversation>;
  deleteChatConversation: (
    principal: AuthorizationPrincipal,
    id: string,
  ) => Promise<void>;
  listChatConversations: (
    principal: AuthorizationPrincipal,
  ) => Promise<ChatConversationSummary[]>;
  processNextChatVerification: (
    abortSignal: AbortSignal,
  ) => Promise<boolean>;
  readChatCitationEvidence: (
    principal: AuthorizationPrincipal,
    id: string,
  ) => Promise<StoredChatCitation | null>;
  readChatCitationFile: (
    principal: AuthorizationPrincipal,
    id: string,
  ) => Promise<IndexedDocumentFile | null>;
  readChatCitationHighlightedFile: (
    principal: AuthorizationPrincipal,
    id: string,
  ) => Promise<IndexedDocumentFile | null>;
  readChatCitationImage: (
    principal: AuthorizationPrincipal,
    id: string,
  ) => Promise<{
    content: Buffer;
    mediaType: string;
  } | null>;
  readChatConversation: (
    principal: AuthorizationPrincipal,
    id: string,
  ) => Promise<ChatConversation | null>;
  streamChatMessage: (
    principal: AuthorizationPrincipal,
    request: ChatMessageRequest,
    abortSignal: AbortSignal,
  ) => ReadableStream<InferUIMessageChunk<CiteLoomUIMessage>>;
}

export interface RuntimeOperationalServices {
  generateSpeech: (
    request: SpeechRequest,
    abortSignal: AbortSignal,
  ) => Promise<GeneratedSpeech>;
  readHealth: (liveChecks: DoctorLiveChecks) => Promise<DoctorCheck[]>;
  readRevisions: () => Promise<ApplicationStateRevisionSnapshot>;
  readStatus: (principal: AuthorizationPrincipal) => Promise<SystemStatus>;
  readTelemetry: () => Promise<TelemetryDashboardSummary>;
  reconcileIngestionCancellations: () => Promise<void>;
  reconcileSourceLibraryDeletions: () => Promise<boolean>;
  reconcileUploadedDocuments: (uploadDirectory: string) => Promise<number>;
  transcribeAudio: (
    audio: TranscriptionAudio,
    abortSignal: AbortSignal,
  ) => Promise<TranscriptionResult>;
}

export interface RuntimeWebServices
  extends RuntimeChatServices,
    RuntimeDocumentServices,
    RuntimeOperationalServices,
    RuntimeResearchServices {
  readonly config: AppConfig;
}
