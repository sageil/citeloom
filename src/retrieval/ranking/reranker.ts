import type {
  RerankingModelV4,
  RerankingModelV4CallOptions,
  RerankingModelV4Result,
} from "@ai-sdk/provider";
import { rerank, type RerankResult } from "ai";
import { z } from "zod";

import type { InferenceMetricsReporter } from "../../inference/metrics.js";
import type { RerankerConfig } from "../../config/index.js";
import { formatDurationMilliseconds } from "../../shared/duration.js";
import { selectTopRetrievedElements } from "../document-retrieval.js";
import type { RetrievedElement } from "../document-retrieval.js";
import { buildRerankDocument } from "../content.js";
import type { AnswerContextSelection } from "./context-selection.js";
import {
  rankRerankerCandidates,
  selectRerankedContext,
  type PostRerankCandidateSelection,
  type RerankerCandidateIdentity,
  type ScoredRerankerCandidate,
} from "./candidate-selection.js";
import {
  readBoundedJsonResponse,
  readBoundedResponseText,
} from "../../providers/http-response.js";
import { createProcessingQuestion } from "../../domain/question.js";

const MAX_RERANK_ERROR_BYTES = 16 * 1_024;
const MAX_RERANK_ERROR_CHARACTERS = 2_000;
const MAX_RERANK_RESPONSE_BYTES = 1_024 * 1_024;
const rerankResponseSchema = z.object({
  model: z.string().min(1).optional(),
  results: z.array(z.object({
    index: z.number().int().nonnegative(),
    relevance_score: z.number(),
  })),
}).loose();

interface HttpRerankRequest {
  documents: string[];
  model: string;
  query: string;
  top_n: number;
}

export interface ResolvedReranker {
  metrics: InferenceMetricsReporter;
  model: RerankingModelV4;
  timeoutMs: number;
}

export interface RerankerRanking {
  originalIndex: number;
  relevanceScore: number;
}

export interface RerankedRetrieval {
  candidateSelection: PostRerankCandidateSelection<RetrievedElement>;
  ranking: RerankerRanking[];
  retrieved: RetrievedElement[];
  selection: AnswerContextSelection;
}

interface RankedRetrieval {
  ranking: RerankerRanking[];
  retrieved: RetrievedElement[];
}

export class RerankingTimeoutError extends Error {
  public constructor(timeoutMs: number) {
    const duration = formatDurationMilliseconds(timeoutMs);
    super(`Reranking timed out after ${duration}.`);
    this.name = "RerankingTimeoutError";
  }
}

export function createHttpRerankingModel(
  config: RerankerConfig,
): RerankingModelV4 {
  if (
    config.adapter !== "cohere-rerank"
    && config.adapter !== "top-n-rerank"
  ) {
    throw new Error(`Unsupported reranking adapter: ${config.adapter}.`);
  }
  return {
    specificationVersion: "v4",
    provider: config.runtimeName,
    modelId: config.model,
    doRerank: async (
      options: RerankingModelV4CallOptions,
    ): Promise<RerankingModelV4Result> => rerankWithHttpProvider(config, options),
  };
}

export async function rerankRetrievedElements(
  reranker: ResolvedReranker,
  query: string,
  candidates: RetrievedElement[],
  topK: number,
  abortSignal?: AbortSignal,
): Promise<RetrievedElement[]> {
  const reranked = await rerankRetrievedElementsWithScores(
    reranker,
    query,
    candidates,
    topK,
    abortSignal,
  );
  return reranked.retrieved;
}

export async function rerankRetrievedElementsWithScores(
  reranker: ResolvedReranker,
  query: string,
  candidates: RetrievedElement[],
  topK: number,
  abortSignal?: AbortSignal,
  candidateIdentities?: readonly RerankerCandidateIdentity[],
): Promise<RerankedRetrieval> {
  const reranked = await rankRetrievedElements(
    reranker,
    query,
    candidates,
    abortSignal,
    candidateIdentities,
  );
  const scored = buildScoredRerankerCandidates(
    candidates,
    reranked.ranking,
    candidateIdentities,
  );
  const contextSelection = selectRerankedContext(
    scored,
    topK,
    "relevance-cliff",
  );
  return {
    candidateSelection: contextSelection,
    ranking: buildRerankerRanking(contextSelection.ranking),
    retrieved: contextSelection.selected.map((candidate) => candidate.item),
    selection: contextSelection.cutoff,
  };
}

export async function rerankRetrievedElementsWithResponse(
  reranker: ResolvedReranker,
  query: string,
  candidates: RetrievedElement[],
  topK: number,
  abortSignal?: AbortSignal,
  candidateIdentities?: readonly RerankerCandidateIdentity[],
): Promise<RerankedRetrieval> {
  const response = await rankRetrievedElements(
    reranker,
    query,
    candidates,
    abortSignal,
    candidateIdentities,
  );
  const scored = buildScoredRerankerCandidates(
    candidates,
    response.ranking,
    candidateIdentities,
  );
  const contextSelection = selectRerankedContext(scored, topK, "top-k");
  return {
    candidateSelection: contextSelection,
    ranking: buildRerankerRanking(contextSelection.ranking),
    retrieved: contextSelection.selected.map((candidate) => candidate.item),
    selection: contextSelection.cutoff,
  };
}

export async function rerankRetrievedElementsByRelevance(
  reranker: ResolvedReranker,
  query: string,
  candidates: RetrievedElement[],
  topK: number,
  abortSignal?: AbortSignal,
): Promise<RetrievedElement[]> {
  const reranked = await rankRetrievedElements(
    reranker,
    query,
    candidates,
    abortSignal,
  );
  return reranked.retrieved.slice(0, topK);
}

export async function rerankRetrievedElementsAboveThreshold(
  reranker: ResolvedReranker,
  query: string,
  candidates: RetrievedElement[],
  topK: number,
  minimumRelevanceScore: number,
  abortSignal?: AbortSignal,
): Promise<RetrievedElement[]> {
  const reranked = await rankRetrievedElements(
    reranker,
    query,
    candidates,
    abortSignal,
  );
  const relevant: RetrievedElement[] = [];
  for (const ranking of reranked.ranking) {
    if (ranking.relevanceScore < minimumRelevanceScore) {
      continue;
    }
    const candidate = candidates[ranking.originalIndex];
    if (candidate === undefined) {
      throw new Error(
        `Reranker returned an unknown document index ${ranking.originalIndex}.`,
      );
    }
    relevant.push(candidate);
  }
  return selectTopRetrievedElements(relevant, topK);
}

async function rankRetrievedElements(
  reranker: ResolvedReranker,
  query: string,
  candidates: RetrievedElement[],
  abortSignal: AbortSignal | undefined,
  candidateIdentities?: readonly RerankerCandidateIdentity[],
): Promise<RankedRetrieval> {
  validateCandidateIdentities(candidates, candidateIdentities);
  if (candidates.length === 0) {
    return {
      ranking: [],
      retrieved: [],
    };
  }
  const documents: string[] = [];
  for (const candidate of candidates) {
    documents.push(
      buildRerankDocument(candidate.element, candidate.evidenceContent),
    );
  }
  const finishMetric = reranker.metrics.start(
    "rerank",
    reranker.model.provider,
    reranker.model.modelId,
  );
  let result: RerankResult<string>;
  const processingQuery = createProcessingQuestion(query);
  const timeoutSignal = AbortSignal.timeout(reranker.timeoutMs);
  try {
    const requestSignal = abortSignal === undefined
      ? timeoutSignal
      : AbortSignal.any([abortSignal, timeoutSignal]);
    result = await rerank({
      abortSignal: requestSignal,
      documents,
      maxRetries: 1,
      model: reranker.model,
      onEnd: () => finishMetric(),
      query: processingQuery,
      telemetry: {
        functionId: "citeloom.rerank",
        isEnabled: reranker.metrics.enabled,
        recordInputs: false,
        recordOutputs: false,
      },
      topN: candidates.length,
    });
  } catch (error: unknown) {
    finishMetric({
      finishReason: "error",
      inputTokens: null,
      outputTokens: null,
    });
    if (abortSignal?.aborted === true) {
      throw abortSignal.reason;
    }
    if (timeoutSignal.aborted) {
      throw new RerankingTimeoutError(reranker.timeoutMs);
    }
    throw error;
  }

  const scored: ScoredRerankerCandidate<number>[] = [];
  for (const entry of result.ranking) {
    const candidate = readRerankerCandidate(candidates, entry.originalIndex);
    const identity = readRerankerCandidateIdentity(
      candidate,
      entry.originalIndex,
      candidateIdentities,
    );
    scored.push({
      identity,
      item: entry.originalIndex,
      relevanceScore: entry.score,
      rerankerInputRank: entry.originalIndex + 1,
    });
  }
  const stableRanking = rankRerankerCandidates(scored);
  const reranked: RetrievedElement[] = [];
  const ranking: RerankerRanking[] = [];
  for (const entry of stableRanking) {
    const candidate = readRerankerCandidate(candidates, entry.item);
    reranked.push(candidate);
    ranking.push({
      originalIndex: entry.item,
      relevanceScore: entry.relevanceScore,
    });
  }
  return {
    ranking,
    retrieved: reranked,
  };
}

function readRerankerCandidate(
  candidates: readonly RetrievedElement[],
  index: number,
): RetrievedElement {
  const candidate = candidates[index];
  if (candidate === undefined) {
    throw new Error(`Reranker returned an unknown document index ${index}.`);
  }
  return candidate;
}

function validateCandidateIdentities(
  candidates: readonly RetrievedElement[],
  identities: readonly RerankerCandidateIdentity[] | undefined,
): void {
  if (identities !== undefined && identities.length !== candidates.length) {
    throw new Error(
      "Reranker candidate identity count must match the candidate count.",
    );
  }
}

function buildScoredRerankerCandidates(
  candidates: readonly RetrievedElement[],
  ranking: readonly RerankerRanking[],
  identities: readonly RerankerCandidateIdentity[] | undefined,
): ScoredRerankerCandidate<RetrievedElement>[] {
  const scored: ScoredRerankerCandidate<RetrievedElement>[] = [];
  for (const entry of ranking) {
    const candidate = readRerankerCandidate(candidates, entry.originalIndex);
    const identity = readRerankerCandidateIdentity(
      candidate,
      entry.originalIndex,
      identities,
    );
    scored.push({
      identity,
      item: candidate,
      relevanceScore: entry.relevanceScore,
      rerankerInputRank: entry.originalIndex + 1,
    });
  }
  return scored;
}

function buildRerankerRanking<Item>(
  ranking: readonly {
    item: Item;
    relevanceScore: number;
    rerankerInputRank: number;
  }[],
): RerankerRanking[] {
  const result: RerankerRanking[] = [];
  for (const candidate of ranking) {
    result.push({
      originalIndex: candidate.rerankerInputRank - 1,
      relevanceScore: candidate.relevanceScore,
    });
  }
  return result;
}

function readRerankerCandidateIdentity(
  candidate: RetrievedElement,
  index: number,
  identities: readonly RerankerCandidateIdentity[] | undefined,
): RerankerCandidateIdentity {
  const provided = identities?.[index];
  if (provided !== undefined) {
    validateProvidedCandidateIdentity(candidate, provided);
    return provided;
  }
  return {
    documentId: candidate.element.documentId,
    documentVersionId: candidate.documentVersionId,
    elementId: candidate.element.id,
    representativeRetrievalWindowId: candidate.element.id,
    sourceFile: candidate.element.sourceFile,
  };
}

function validateProvidedCandidateIdentity(
  candidate: RetrievedElement,
  identity: RerankerCandidateIdentity,
): void {
  if (
    identity.documentId !== candidate.element.documentId
    || identity.documentVersionId !== candidate.documentVersionId
    || identity.elementId !== candidate.element.id
    || identity.sourceFile !== candidate.element.sourceFile
  ) {
    throw new Error(
      "Reranker candidate identity does not match its hydrated element.",
    );
  }
}

async function rerankWithHttpProvider(
  config: RerankerConfig,
  options: RerankingModelV4CallOptions,
): Promise<RerankingModelV4Result> {
  if (options.documents.type !== "text") {
    throw new Error(`${config.runtimeName} only accepts text documents.`);
  }
  const topN = options.topN ?? options.documents.values.length;
  const requestBody: HttpRerankRequest = {
    documents: options.documents.values,
    model: config.model,
    query: options.query,
    top_n: topN,
  };
  const headers = buildHeaders(config, options);
  const requestedAt = new Date();
  const requestInit: RequestInit = {
    body: JSON.stringify(requestBody),
    headers,
    method: "POST",
  };
  if (options.abortSignal !== undefined) {
    requestInit.signal = options.abortSignal;
  }
  const response = await fetch(`${config.baseUrl}/rerank`, requestInit);
  if (!response.ok) {
    const detail = await readBoundedResponseText(
      response,
      MAX_RERANK_ERROR_BYTES,
    );
    throw new Error(
      `${config.runtimeName} returned HTTP ${response.status}: ${detail.slice(0, MAX_RERANK_ERROR_CHARACTERS)}`,
    );
  }

  let responseBody: unknown;
  try {
    responseBody = await readBoundedJsonResponse(
      response,
      MAX_RERANK_RESPONSE_BYTES,
    );
  } catch (error: unknown) {
    throw new Error(`${config.runtimeName} returned an unreadable response.`, {
      cause: error,
    });
  }
  const parsed = rerankResponseSchema.safeParse(responseBody);
  if (!parsed.success) {
    throw new Error(
      `${config.runtimeName} returned an invalid response: ${parsed.error.message}`,
    );
  }
  const ranking = readRanking(
    parsed.data.results,
    options.documents.values.length,
    topN,
  );
  return {
    ranking,
    response: {
      body: responseBody,
      modelId: parsed.data.model ?? config.model,
      timestamp: requestedAt,
    },
  };
}

function buildHeaders(
  config: RerankerConfig,
  options: RerankingModelV4CallOptions,
): Headers {
  const headers = new Headers(options.headers);
  headers.set("content-type", "application/json");
  if (config.apiToken !== null) {
    headers.set("authorization", `Bearer ${config.apiToken}`);
  }
  return headers;
}

function readRanking(
  results: Array<{ index: number; relevance_score: number }>,
  documentCount: number,
  topN: number,
): RerankingModelV4Result["ranking"] {
  const seenIndices = new Set<number>();
  const ranking: RerankingModelV4Result["ranking"] = [];
  for (const result of results) {
    if (result.index >= documentCount) {
      throw new Error(`Reranker returned out-of-range index ${result.index}.`);
    }
    if (seenIndices.has(result.index)) {
      throw new Error(`Reranker returned duplicate index ${result.index}.`);
    }
    seenIndices.add(result.index);
    ranking.push({
      index: result.index,
      relevanceScore: result.relevance_score,
    });
  }
  const expectedResultCount = Math.min(topN, documentCount);
  if (ranking.length < expectedResultCount) {
    throw new Error(
      `Reranker returned ${ranking.length} results; expected at least ${expectedResultCount}.`,
    );
  }
  ranking.sort((left, right) => {
    const scoreDifference = right.relevanceScore - left.relevanceScore;
    if (scoreDifference !== 0) {
      return scoreDifference;
    }
    return left.index - right.index;
  });
  return ranking.slice(0, topN);
}
