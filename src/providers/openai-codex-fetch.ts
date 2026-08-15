import { z } from "zod";

import type { CiteLoomDatabase } from "../database/client.js";
import { OpenAICodexCredentialStore } from "./openai-codex-credentials.js";

const codexRequestBodySchema = z.record(z.string(), z.json());
const OPENAI_CODEX_PROTOCOL_CLIENT_VERSION = "0.145.0";

export interface OpenAICodexFetchOptions {
  fetch?: typeof fetch;
  release?: string;
}

interface PreparedOpenAICodexRequest {
  body: string | null;
  headers: Headers;
  method: string;
  responsesRequest: boolean;
  signal: AbortSignal | null;
  url: string;
}

export function createOpenAICodexFetch(
  database: CiteLoomDatabase,
  options: OpenAICodexFetchOptions = {},
): typeof fetch {
  const requestFetch = options.fetch ?? fetch;
  const release = normalizeRelease(options.release);
  return async (input, init): Promise<Response> => {
    const prepared = await prepareRequest(input, init);
    const storeOptions = buildCredentialStoreOptions(
      requestFetch,
      prepared.signal,
    );
    const store = new OpenAICodexCredentialStore(database, storeOptions);
    let credential = await store.readForRequest({
      forceRefresh: false,
      staleVersion: null,
    });
    let response = await requestWithCredential(
      requestFetch,
      prepared,
      credential,
      release,
    );
    if (response.status !== 401 && response.status !== 403) {
      return response;
    }
    await response.body?.cancel();
    credential = await store.readForRequest({
      forceRefresh: true,
      staleVersion: credential.version,
    });
    response = await requestWithCredential(
      requestFetch,
      prepared,
      credential,
      release,
    );
    return response;
  };
}

export function readOpenAICodexClientVersion(
  value: string | undefined = process.env.CITELOOM_OPENAI_CODEX_CLIENT_VERSION,
): string {
  const normalized = value?.trim();
  return normalized === undefined || normalized === ""
    ? OPENAI_CODEX_PROTOCOL_CLIENT_VERSION
    : normalized;
}

async function prepareRequest(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
): Promise<PreparedOpenAICodexRequest> {
  const request = new Request(input, init);
  let body: string | null = null;
  if (request.body !== null) {
    body = await request.text();
  }
  const url = new URL(request.url);
  const responsesRequest =
    request.method === "POST" && url.pathname.endsWith("/responses");
  if (responsesRequest) {
    body = normalizeOpenAICodexResponsesBody(body);
  }
  return {
    body,
    headers: new Headers(request.headers),
    method: request.method,
    responsesRequest,
    signal: request.signal,
    url: request.url,
  };
}

export function normalizeOpenAICodexResponsesBody(
  body: string | null,
): string {
  if (body === null || body.trim() === "") {
    throw new Error("OpenAI Codex Responses requests require a JSON body.");
  }
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw new Error("OpenAI Codex received an invalid Responses request body.");
  }
  const decoded = codexRequestBodySchema.safeParse(value);
  if (!decoded.success) {
    throw new Error("OpenAI Codex received an invalid Responses request body.");
  }
  const normalized = { ...decoded.data };
  delete normalized.max_output_tokens;
  delete normalized.temperature;
  delete normalized.top_p;
  normalized.store = false;
  normalized.stream = true;
  return JSON.stringify(normalized);
}

async function requestWithCredential(
  requestFetch: typeof fetch,
  request: PreparedOpenAICodexRequest,
  credential: {
    accessToken: string;
    accountId: string;
  },
  release: string,
): Promise<Response> {
  const headers = new Headers(request.headers);
  if (request.responsesRequest) {
    headers.set("accept", "text/event-stream");
  }
  headers.set("authorization", `Bearer ${credential.accessToken}`);
  headers.set("chatgpt-account-id", credential.accountId);
  headers.set("originator", "citeloom");
  headers.set("user-agent", `citeloom/${release}`);
  const requestInit = buildRequestInit(request, headers);
  return requestFetch(request.url, requestInit);
}

function buildRequestInit(
  request: PreparedOpenAICodexRequest,
  headers: Headers,
): RequestInit {
  const init: RequestInit = {
    headers,
    method: request.method,
  };
  if (request.body !== null) {
    init.body = request.body;
  }
  if (request.signal !== null) {
    init.signal = request.signal;
  }
  return init;
}

function buildCredentialStoreOptions(
  requestFetch: typeof fetch,
  signal: AbortSignal | null,
): ConstructorParameters<typeof OpenAICodexCredentialStore>[1] {
  const options: NonNullable<
    ConstructorParameters<typeof OpenAICodexCredentialStore>[1]
  > = {
    fetch: requestFetch,
  };
  if (signal !== null) {
    options.signal = signal;
  }
  return options;
}

function normalizeRelease(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? "1.1.0" : normalized;
}
