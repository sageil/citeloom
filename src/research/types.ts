import type {
  RankFusionConfig,
  RetrievalMode,
} from "../config/index.js";
import type {
  MatchedDocument,
} from "../retrieval/document-retrieval.js";
import type {
  PublishedAnswerDocument,
} from "../answers/published-model.js";
import type { EvidenceVerificationState } from "../answers/verification-state.js";
import type { DocumentFormat } from "../documents/format.js";
import type { QueryScope } from "../domain/query-scope.js";
import type {
  SourceRegion,
  TableStructure,
} from "../domain/source-elements.js";
import type {
  QUESTION_PROCESSING_POLICY_ID,
} from "../domain/question.js";
import type {
  RepresentationHit,
} from "../retrieval/ranking/rank-fusion.js";

export type CitationEvidence =
  | {
    excerpt: string;
    kind: "text";
  }
  | {
    content: string;
    kind: "table";
    table: TableStructure;
  }
  | {
    kind: "image";
    mimeType: string;
  };

export interface StoredCitationRecord {
  citationNumber: number;
  createdAt: string;
  documentId: string;
  documentVersionId: string;
  elementId: string;
  evidence: CitationEvidence;
  id: string;
  pageNumbers: number[];
  regions: SourceRegion[];
  sectionPath: string[];
  sourceFile: string;
  stale: boolean;
  turnId: string;
}

export type ClaimSupportStatus =
  | "partially-supported"
  | "supported"
  | "unsupported"
  | "unverified";

export interface AnswerClaim {
  citationNumbers: number[];
  claim: string;
  claimIndex: number;
}

export interface ClaimVerificationResult extends AnswerClaim {
  evidenceUnits: VerificationEvidenceUnitResult[];
  rationale: string;
  status: ClaimSupportStatus;
  verifierModel: string;
}

export interface VerificationEvidenceUnitResult {
  citationNumber: number;
  outcome:
    | "not-evaluated"
    | "supported"
    | "unsupported"
    | "verifier-incompatible";
  rationale: string;
  supportProbability: number | null;
  unitId: string;
}

export interface StoredClaimCheck {
  citationNumbers: number[];
  claim: string;
  claimIndex: number;
  createdAt: string;
  id: string;
  evidenceUnits: VerificationEvidenceUnitResult[];
  rationale: string;
  status: ClaimSupportStatus;
  turnId: string;
  verifierModel: string;
}

export interface ResearchRunConfiguration {
  embeddingSpaceId: string;
  models: {
    answer: string;
    embedding: string;
    reranker: string | null;
    verifier: string;
  };
  retrieval: {
    answerTemperature: number;
    answerMinimumRerankerScore: number | null;
    candidateK: number;
    fusion: RankFusionConfig;
    mode: RetrievalMode;
    queryExpansions: number;
    queryExpansionTemperature: number;
    rrfK: number;
    tocRoutingEnabled: boolean;
    topK: number;
  };
  settingsVersion: number;
}

interface ResearchRetrievalTraceGeneration {
  generation: {
    answer: { temperature: number };
    queryExpansion: { temperature: number };
  };
}

interface PreviousResearchRetrievalTraceQueries {
  queries: Array<{
    kind: "expansion" | "original";
    text: string;
  }>;
}

interface CurrentResearchRetrievalTraceQueries {
  queries: Array<{
    kind: "conversation" | "expansion" | "original";
    text: string;
  }>;
}

interface ResearchRetrievalTraceSources {
  orderedSources: Array<{
    documentId: string;
    documentVersionId: string;
    evidenceSha256: string;
    elementId: string;
    rank: number;
    representationHits: RepresentationHit[];
    retrievalWindowId: string;
    sourceFile: string;
    descriptionAffected: boolean;
  }>;
}

export interface LegacyResearchRetrievalTrace
  extends ResearchRetrievalTraceGeneration,
    PreviousResearchRetrievalTraceQueries,
    ResearchRetrievalTraceSources {
  version: 3;
}

export interface PreviousResearchRetrievalTrace
  extends ResearchRetrievalTraceGeneration,
    PreviousResearchRetrievalTraceQueries,
    ResearchRetrievalTraceSources {
  question: {
    original: string;
    policyId: typeof QUESTION_PROCESSING_POLICY_ID;
    processing: string;
  };
  version: 4;
}

export interface CurrentResearchRetrievalTrace
  extends ResearchRetrievalTraceGeneration,
    CurrentResearchRetrievalTraceQueries,
    ResearchRetrievalTraceSources {
  question: {
    original: string;
    policyId: typeof QUESTION_PROCESSING_POLICY_ID;
    processing: string;
  };
  version: 5;
}

export type ResearchRetrievalTrace =
  | LegacyResearchRetrievalTrace
  | PreviousResearchRetrievalTrace
  | CurrentResearchRetrievalTrace;

export type StoredResearchRetrievalTrace = ResearchRetrievalTrace;

export interface ResearchReproducibility {
  available: boolean;
  unavailableDependencies: string[];
}

export interface ResearchTurn {
  answerDocument: PublishedAnswerDocument;
  citations: StoredCitationRecord[];
  claims: StoredClaimCheck[];
  completedAt: string;
  id: string;
  question: string;
  reproducibility: ResearchReproducibility;
  retrievedContext: MatchedDocument[];
  retrievalTrace: StoredResearchRetrievalTrace;
  runConfiguration: ResearchRunConfiguration;
  runId: string;
  scope: QueryScope;
  sequence: number;
  threadId: string;
  verificationState: EvidenceVerificationState;
}

export interface ResearchThread {
  createdAt: string;
  id: string;
  title: string;
  turns: ResearchTurn[];
  updatedAt: string;
}

export interface ResearchThreadSummary {
  createdAt: string;
  id: string;
  title: string;
  turnCount: number;
  updatedAt: string;
}

export interface DocumentVersionRecord {
  createdAt: string;
  documentId: string;
  elementCount: number;
  elementSetId: string;
  format: DocumentFormat;
  generationId: string;
  id: string;
  pageCount: number | null;
  sourceFile: string;
  version: number;
}

export interface DocumentVersionDifference {
  addedElementIds: string[];
  currentVersionId: string;
  modified: Array<{ currentElementId: string; previousElementId: string }>;
  previousVersionId: string;
  removedElementIds: string[];
}

export type FeedbackDimension =
  | "answer-usefulness"
  | "citation-correctness"
  | "retrieval-relevance";

export interface ResearchFeedbackSummary {
  negativeCount: number;
  positiveCount: number;
  rating: -1 | 0 | 1;
}
