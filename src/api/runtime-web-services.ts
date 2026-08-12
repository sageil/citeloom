import type { InferUIMessageChunk } from "ai";

import type { CiteLoomUIMessage } from "../answers/stream.js";
import type { ApplicationStateRevisionSnapshot } from "../app/application-state-revisions.js";
import type { AuthenticatedPrincipal } from "../auth/model.js";
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
    principal: AuthenticatedPrincipal,
    request: BrowseDocumentCatalogRequest,
  ) => Promise<BrowseDocumentCatalogResult>;
  compareDocumentVersions: (
    principal: AuthenticatedPrincipal,
    previousVersionId: string,
    currentVersionId: string,
  ) => Promise<DocumentVersionDifference | null>;
  deleteIndexedDocument: (
    principal: AuthenticatedPrincipal,
    request: ReindexDocumentRequest,
  ) => Promise<DeleteIndexedDocumentResult>;
  ingest: (
    principal: AuthenticatedPrincipal,
    documents: readonly StagedIngestionDocument[],
    options: IngestOptions,
    duplicateSourceRoot: string,
    requestedSourceLibraryId: string | null,
  ) => Promise<BulkIngestResult>;
  listDocumentVersions: (
    principal: AuthenticatedPrincipal,
    sourceFile: string,
  ) => Promise<DocumentVersionRecord[]>;
  readDocumentFile: (
    principal: AuthenticatedPrincipal,
    request: ReadDocumentFileRequest,
  ) => Promise<IndexedDocumentFile | null>;
  readVersionedDocumentFile: (
    principal: AuthenticatedPrincipal,
    id: string,
  ) => Promise<IndexedDocumentFile | null>;
  reindexDocument: (
    principal: AuthenticatedPrincipal,
    request: ReindexDocumentRequest,
    actor: IngestionControlActor,
  ) => Promise<ReindexDocumentResult>;
  requestIngestionControl: (
    principal: AuthenticatedPrincipal,
    sourceFile: string,
    action: "pause" | "cancel",
    actor: IngestionControlActor,
  ) => ReturnType<typeof requestIngestionControlWithRuntime>;
  resumeIngestion: (
    principal: AuthenticatedPrincipal,
    sourceFile: string,
    actor: IngestionControlActor,
  ) => ReturnType<typeof resumeIngestionWithRuntime>;
  retryFailedJob: (
    principal: AuthenticatedPrincipal,
    sourceFile: string,
  ) => Promise<RetryFailedIngestionResult>;
  updateDocumentTags: (
    principal: AuthenticatedPrincipal,
    request: UpdateIndexedDocumentTagsRequest,
  ) => Promise<UpdateIndexedDocumentTagsResult | null>;
}

export interface RuntimeResearchServices {
  addResearchFeedback: (principal: AuthenticatedPrincipal, input: {
    citationId: string | null;
    comment: string | null;
    dimension: FeedbackDimension;
    rating: -1 | 1;
    turnId: string;
  }) => Promise<ResearchFeedbackSummary>;
  createResearchThread: (
    principal: AuthenticatedPrincipal,
    title: string,
  ) => Promise<ResearchThread>;
  deleteResearchThread: (
    principal: AuthenticatedPrincipal,
    id: string,
  ) => Promise<void>;
  exportResearchThread: (
    principal: AuthenticatedPrincipal,
    id: string,
    format: ResearchExportFormat,
  ) => Promise<ResearchExport | null>;
  listResearchThreads: (
    principal: AuthenticatedPrincipal,
  ) => Promise<ResearchThreadSummary[]>;
  processNextResearchVerification: (
    abortSignal: AbortSignal,
  ) => Promise<boolean>;
  readCitationEvidence: (
    principal: AuthenticatedPrincipal,
    id: string,
  ) => Promise<StoredCitationRecord | null>;
  readCitationHighlightedFile: (
    principal: AuthenticatedPrincipal,
    id: string,
  ) => Promise<IndexedDocumentFile | null>;
  readCitationImage: (principal: AuthenticatedPrincipal, id: string) => Promise<{
    content: Buffer;
    mediaType: string;
  } | null>;
  readResearchFeedback: (
    principal: AuthenticatedPrincipal,
    turnId: string,
    dimension: FeedbackDimension,
    citationId: string | null,
  ) => Promise<ResearchFeedbackSummary>;
  readResearchThread: (
    principal: AuthenticatedPrincipal,
    id: string,
  ) => Promise<ResearchThread | null>;
  searchSources: (
    principal: AuthenticatedPrincipal,
    request: SourceDiscoveryRequest,
    abortSignal: AbortSignal,
  ) => Promise<SourceDiscoveryResponse>;
  streamAnswer: (
    principal: AuthenticatedPrincipal,
    request: QuestionRequest,
    abortSignal: AbortSignal,
  ) => ReadableStream<InferUIMessageChunk<CiteLoomUIMessage>>;
}

export interface RuntimeChatServices {
  createChatConversation: (
    principal: AuthenticatedPrincipal,
    title: string,
    scope: QueryScope,
  ) => Promise<ChatConversation>;
  deleteChatConversation: (
    principal: AuthenticatedPrincipal,
    id: string,
  ) => Promise<void>;
  listChatConversations: (
    principal: AuthenticatedPrincipal,
  ) => Promise<ChatConversationSummary[]>;
  processNextChatVerification: (
    abortSignal: AbortSignal,
  ) => Promise<boolean>;
  readChatCitationEvidence: (
    principal: AuthenticatedPrincipal,
    id: string,
  ) => Promise<StoredChatCitation | null>;
  readChatCitationFile: (
    principal: AuthenticatedPrincipal,
    id: string,
  ) => Promise<IndexedDocumentFile | null>;
  readChatCitationHighlightedFile: (
    principal: AuthenticatedPrincipal,
    id: string,
  ) => Promise<IndexedDocumentFile | null>;
  readChatCitationImage: (
    principal: AuthenticatedPrincipal,
    id: string,
  ) => Promise<{
    content: Buffer;
    mediaType: string;
  } | null>;
  readChatConversation: (
    principal: AuthenticatedPrincipal,
    id: string,
  ) => Promise<ChatConversation | null>;
  streamChatMessage: (
    principal: AuthenticatedPrincipal,
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
  readStatus: (principal: AuthenticatedPrincipal) => Promise<SystemStatus>;
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
