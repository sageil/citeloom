import type {
  ApplicationStateRevisionSnapshot,
} from "../app/application-state-revisions.js";
import {
  DEFAULT_DOCUMENT_CATALOG_REQUEST,
  type BrowseDocumentCatalogResult,
  type DocumentCatalogFacets,
} from "../documents/catalog/browser.js";
import { SUPPORTED_DOCUMENT_EXTENSIONS } from "../documents/format.js";
import type { SystemStatus } from "../ingestion/worker.js";
import type { DoctorCheck } from "../observability/doctor.js";
import type { TelemetryDashboardSummary } from "../observability/store.js";
import type { RuntimeWebServices } from "./services.js";
import type { AuthenticatedPrincipal } from "../auth/model.js";

export interface DashboardResponse {
  catalog: BrowseDocumentCatalogResult;
  documentSummary: DocumentCatalogFacets;
  embeddingSpace: {
    dimensions: number;
    id: string;
    inputFormatHash: string;
    inputFormatName: string;
    model: string;
    retrievalWindowPolicyFingerprint: string;
    retrievalWindowPolicyId: string;
  };
  features: {
    speechToText: boolean;
    textToSpeech: boolean;
    textToSpeechPreload: boolean;
  };
  generatedAt: string;
  revisions: ApplicationStateRevisionSnapshot;
  inferenceRuntime: {
    answerModel: string;
    claimVerifier: {
      model: string;
      name: string;
      supportThreshold: number;
    };
    name: string;
    queryExpansionModel: string | null;
    reranker: {
      model: string;
      name: string;
    } | null;
    indexingModel: string;
  };
  maximumUploadRequestBytes: number;
  maximumDocumentBytes: number;
  supportedExtensions: readonly string[];
  system: SystemStatus;
  telemetry: TelemetryDashboardSummary;
}

export interface HealthResponse {
  checks: DiagnosticResponseCheck[];
  generatedAt: string;
}

interface DiagnosticResponseCheck extends DoctorCheck {
  id: string;
}

export function buildDiagnosticResponseChecks(
  checks: readonly DoctorCheck[],
): DiagnosticResponseCheck[] {
  const responseChecks: DiagnosticResponseCheck[] = [];
  for (let index = 0; index < checks.length; index += 1) {
    const check = checks[index];
    if (check === undefined) {
      continue;
    }
    responseChecks.push({
      ...check,
      id: `diagnostic-${index + 1}`,
    });
  }
  return responseChecks;
}

export async function buildDashboardResponse(
  runtime: RuntimeWebServices,
  principal: AuthenticatedPrincipal,
  maximumUploadRequestBytes: number,
): Promise<DashboardResponse> {
  const effectiveConfig = runtime.config;
  const [catalog, revisions, system, telemetry] = await Promise.all([
    runtime.browseDocuments(principal, DEFAULT_DOCUMENT_CATALOG_REQUEST),
    runtime.readRevisions(),
    runtime.readStatus(principal),
    runtime.readTelemetry(),
  ]);
  let reranker: DashboardResponse["inferenceRuntime"]["reranker"] = null;
  if (effectiveConfig.retrieval.reranker !== null) {
    reranker = {
      model: effectiveConfig.retrieval.reranker.model,
      name: effectiveConfig.retrieval.reranker.runtimeName,
    };
  }
  return {
    catalog,
    documentSummary: catalog.facets,
    embeddingSpace: {
      dimensions: effectiveConfig.embeddingSpace.dimensions,
      id: effectiveConfig.embeddingSpace.id,
      inputFormatHash:
        effectiveConfig.embeddingSpace.inputFormat.inputFormatHash,
      inputFormatName: effectiveConfig.embeddingSpace.inputFormat.name,
      model: effectiveConfig.embeddingSpace.model,
      retrievalWindowPolicyFingerprint:
        effectiveConfig.embeddingSpace.retrievalWindow.fingerprint,
      retrievalWindowPolicyId:
        effectiveConfig.embeddingSpace.retrievalWindow.policy.id,
    },
    features: {
      speechToText: effectiveConfig.speechToText !== null,
      textToSpeech: effectiveConfig.textToSpeech !== null,
      textToSpeechPreload: effectiveConfig.textToSpeech?.preload ?? false,
    },
    generatedAt: new Date().toISOString(),
    revisions,
    inferenceRuntime: {
      answerModel: effectiveConfig.inference.answer.model,
      claimVerifier: {
        model: effectiveConfig.claimVerifier.model,
        name: effectiveConfig.claimVerifier.runtimeName,
        supportThreshold: effectiveConfig.claimVerifier.supportThreshold,
      },
      name: effectiveConfig.inference.answer.runtimeName,
      queryExpansionModel:
        effectiveConfig.inference.queryExpansion?.model ?? null,
      reranker,
      indexingModel: effectiveConfig.inference.indexing.model,
    },
    maximumDocumentBytes: effectiveConfig.maxDocumentBytes,
    maximumUploadRequestBytes,
    supportedExtensions: SUPPORTED_DOCUMENT_EXTENSIONS,
    system,
    telemetry,
  };
}
