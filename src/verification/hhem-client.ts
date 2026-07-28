import { z } from "zod";

import type { ClaimVerifierConfig } from "../config/index.js";
import { readBoundedResponseText } from "../providers/http-response.js";

export const HHEM_MODEL_ID = "vectara/hallucination_evaluation_model";
export const HHEM_MODEL_REVISION =
  "8e4a2e6e96c708cc76c2344f7e4757df2515292c";
export const HHEM_DISPLAY_MODEL = `${HHEM_MODEL_ID}@${HHEM_MODEL_REVISION}`;

const MAX_SCORE_ITEMS = 64;
const MAX_HHEM_RESPONSE_BYTES = 256 * 1_024;
const MAX_HHEM_REQUEST_BYTES = 2_000_000;
const MAX_HHEM_CLAIM_CHARACTERS = 2_000;
const MAX_HHEM_EVIDENCE_CHARACTERS = 800_000;
const MAX_HHEM_TOTAL_TEXT_CHARACTERS = 1_000_000;

const hhemScoreResponseSchema = z.object({
  model: z.literal(HHEM_MODEL_ID),
  results: z.array(z.discriminatedUnion("outcome", [
    z.object({
      id: z.string().trim().min(1).max(128),
      outcome: z.literal("scored"),
      supportProbability: z.number().finite().min(0).max(1),
    }).strict(),
    z.object({
      id: z.string().trim().min(1).max(128),
      outcome: z.literal("model-context-capacity"),
    }).strict(),
  ])).min(1).max(MAX_SCORE_ITEMS),
  revision: z.literal(HHEM_MODEL_REVISION),
}).strict();

const hhemReadyResponseSchema = z.object({
  model: z.literal(HHEM_MODEL_ID),
  revision: z.literal(HHEM_MODEL_REVISION),
  status: z.literal("ready"),
}).strict();

export interface HhemScoreItem {
  claim: string;
  evidence: string;
  id: string;
}

export type HhemScoreResult = {
  id: string;
  outcome: "scored";
  supportProbability: number;
} | {
  id: string;
  outcome: "model-context-capacity";
};

interface HhemScoreRequest {
  items: HhemScoreItem[];
}

export function readHhemScoreItemLimitFailure(
  item: HhemScoreItem,
): string | null {
  if (item.claim.length > MAX_HHEM_CLAIM_CHARACTERS) {
    return "The claim exceeds the HHEM service input size.";
  }
  if (item.evidence.length > MAX_HHEM_EVIDENCE_CHARACTERS) {
    return "The cited evidence exceeds the HHEM service input size.";
  }
  const request: HhemScoreRequest = { items: [item] };
  if (readUtf8ByteLength(JSON.stringify(request)) > MAX_HHEM_REQUEST_BYTES) {
    return "The verification item exceeds the HHEM service request size.";
  }
  return null;
}

export type HhemClientFailureCategory =
  | "http-error"
  | "invalid-response"
  | "service-unavailable"
  | "timeout";

export class HhemClientError extends Error {
  public constructor(
    public readonly category: HhemClientFailureCategory,
    message: string,
    public readonly retryable: boolean,
    public readonly statusCode: number | null,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "HhemClientError";
  }
}

export interface HhemClient {
  readonly modelId: string;
  readonly provider: string;
  readonly supportThreshold: number;
  checkReady(abortSignal?: AbortSignal): Promise<void>;
  score(
    items: readonly HhemScoreItem[],
    abortSignal: AbortSignal,
  ): Promise<HhemScoreResult[]>;
}

export class HttpHhemClient implements HhemClient {
  public readonly modelId = HHEM_DISPLAY_MODEL;

  public constructor(private readonly config: ClaimVerifierConfig) {}

  public get provider(): string {
    return this.config.runtimeName;
  }

  public get supportThreshold(): number {
    return this.config.supportThreshold;
  }

  public async checkReady(abortSignal?: AbortSignal): Promise<void> {
    const response = await this.request("/ready", { method: "GET" }, abortSignal);
    const body = await readResponseBody(response, this.config.runtimeName);
    const parsed = decodeReadyResponse(body);
    if (!parsed) {
      throw new HhemClientError(
        "invalid-response",
        `${this.config.runtimeName} returned an invalid readiness response.`,
        false,
        response.status,
      );
    }
  }

  public async score(
    items: readonly HhemScoreItem[],
    abortSignal: AbortSignal,
  ): Promise<HhemScoreResult[]> {
    if (items.length < 1) {
      throw new Error("HHEM scoring requires at least one item.");
    }
    const results: HhemScoreResult[] = [];
    const batches = createScoreBatches(items);
    for (const batch of batches) {
      abortSignal.throwIfAborted();
      const batchResults = await this.scoreBatch(batch, abortSignal);
      results.push(...batchResults);
    }
    return results;
  }

  private async scoreBatch(
    items: readonly HhemScoreItem[],
    abortSignal: AbortSignal,
  ): Promise<HhemScoreResult[]> {
    const requestBody: HhemScoreRequest = { items: [...items] };
    const response = await this.request(
      "/score",
      {
        body: JSON.stringify(requestBody),
        headers: { "content-type": "application/json" },
        method: "POST",
      },
      abortSignal,
    );
    const body = await readResponseBody(response, this.config.runtimeName);
    return decodeScoreResponse(body, items, response.status);
  }

  private async request(
    path: string,
    init: RequestInit,
    abortSignal?: AbortSignal,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
    const requestSignal = abortSignal === undefined
      ? timeoutSignal
      : AbortSignal.any([abortSignal, timeoutSignal]);
    try {
      const response = await fetch(`${this.config.baseUrl}${path}`, {
        ...init,
        signal: requestSignal,
      });
      if (!response.ok) {
        throw buildHttpError(response, this.config.runtimeName);
      }
      return response;
    } catch (error: unknown) {
      if (error instanceof HhemClientError) {
        throw error;
      }
      if (abortSignal?.aborted === true) {
        throw error;
      }
      if (timeoutSignal.aborted) {
        throw new HhemClientError(
          "timeout",
          `${this.config.runtimeName} timed out after ${this.config.timeoutMs} ms.`,
          true,
          null,
          error,
        );
      }
      throw new HhemClientError(
        "service-unavailable",
        `${this.config.runtimeName} is unavailable.`,
        true,
        null,
        error,
      );
    }
  }
}

function createScoreBatches(
  items: readonly HhemScoreItem[],
): HhemScoreItem[][] {
  const batches: HhemScoreItem[][] = [];
  let batch: HhemScoreItem[] = [];
  let textCharacters = 0;
  for (const item of items) {
    const failure = readHhemScoreItemLimitFailure(item);
    if (failure !== null) {
      throw new Error(failure);
    }
    const itemTextCharacters = item.claim.length + item.evidence.length;
    const candidate = [...batch, item];
    const request: HhemScoreRequest = { items: candidate };
    const exceedsServiceLimit = candidate.length > MAX_SCORE_ITEMS
      || textCharacters + itemTextCharacters > MAX_HHEM_TOTAL_TEXT_CHARACTERS
      || readUtf8ByteLength(JSON.stringify(request)) > MAX_HHEM_REQUEST_BYTES;
    if (exceedsServiceLimit && batch.length > 0) {
      batches.push(batch);
      batch = [item];
      textCharacters = itemTextCharacters;
      continue;
    }
    batch = candidate;
    textCharacters += itemTextCharacters;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

function readUtf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function buildHttpError(response: Response, runtimeName: string): HhemClientError {
  const unavailable = response.status === 502
    || response.status === 503
    || response.status === 504;
  const category = unavailable ? "service-unavailable" : "http-error";
  return new HhemClientError(
    category,
    `${runtimeName} returned HTTP ${response.status}.`,
    unavailable || response.status >= 500,
    response.status,
  );
}

async function readResponseBody(
  response: Response,
  runtimeName: string,
): Promise<string> {
  try {
    return await readBoundedResponseText(response, MAX_HHEM_RESPONSE_BYTES);
  } catch (error: unknown) {
    throw new HhemClientError(
      "invalid-response",
      `${runtimeName} returned an unreadable response.`,
      false,
      response.status,
      error,
    );
  }
}

function decodeReadyResponse(body: string): boolean {
  const value = parseJsonBody(body, "readiness");
  return hhemReadyResponseSchema.safeParse(value).success;
}

function decodeScoreResponse(
  body: string,
  expectedItems: readonly HhemScoreItem[],
  statusCode: number,
): HhemScoreResult[] {
  const value = parseJsonBody(body, "score");
  const parsed = hhemScoreResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new HhemClientError(
      "invalid-response",
      "HHEM returned an invalid score response.",
      false,
      statusCode,
      parsed.error,
    );
  }
  const expectedIds = new Set<string>();
  for (const item of expectedItems) {
    if (expectedIds.has(item.id)) {
      throw new Error(`HHEM request contains duplicate item ID ${item.id}.`);
    }
    expectedIds.add(item.id);
  }
  const resultById = new Map<string, HhemScoreResult>();
  for (const result of parsed.data.results) {
    if (!expectedIds.has(result.id)) {
      throw new HhemClientError(
        "invalid-response",
        `HHEM returned unknown item ID ${result.id}.`,
        false,
        statusCode,
      );
    }
    if (resultById.has(result.id)) {
      throw new HhemClientError(
        "invalid-response",
        `HHEM returned duplicate item ID ${result.id}.`,
        false,
        statusCode,
      );
    }
    resultById.set(result.id, result);
  }
  if (resultById.size !== expectedItems.length) {
    throw new HhemClientError(
      "invalid-response",
      `HHEM returned ${resultById.size} scores for ${expectedItems.length} items.`,
      false,
      statusCode,
    );
  }
  const orderedResults: HhemScoreResult[] = [];
  for (const item of expectedItems) {
    const result = resultById.get(item.id);
    if (result === undefined) {
      throw new HhemClientError(
        "invalid-response",
        `HHEM omitted item ID ${item.id}.`,
        false,
        statusCode,
      );
    }
    orderedResults.push(result);
  }
  return orderedResults;
}

function parseJsonBody(body: string, responseKind: string): unknown {
  try {
    return JSON.parse(body);
  } catch (error: unknown) {
    throw new HhemClientError(
      "invalid-response",
      `HHEM returned invalid JSON for its ${responseKind} response.`,
      false,
      200,
      error,
    );
  }
}
