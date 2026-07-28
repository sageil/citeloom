import { z } from "zod";

import type { CiteLoomDatabase } from "../database/client.js";
import {
  createOpenAICodexFetch,
  readOpenAICodexClientVersion,
  type OpenAICodexFetchOptions,
} from "./openai-codex-fetch.js";
import { OPENAI_CODEX_BACKEND_BASE_URL } from "./openai-codex-oauth.js";

const codexModelsResponseSchema = z.object({
  models: z.array(z.object({
    default_reasoning_level: z.string().trim().optional(),
    display_name: z.string().trim().optional(),
    slug: z.string().trim().min(1),
    supported_in_api: z.boolean(),
    supported_reasoning_levels: z.array(z.object({
      effort: z.string().trim().min(1),
    }).loose()).optional(),
    visibility: z.string().trim().optional(),
  }).loose()),
}).loose();

export interface OpenAICodexModel {
  defaultReasoningLevel: string | null;
  id: string;
  name: string;
  reasoning: boolean;
  supportedReasoningLevels: string[];
}

export interface ReadOpenAICodexModelsOptions extends OpenAICodexFetchOptions {
  baseUrl?: string;
  clientVersion?: string;
  signal?: AbortSignal;
}

export async function readOpenAICodexModels(
  database: CiteLoomDatabase,
  options: ReadOpenAICodexModelsOptions = {},
): Promise<OpenAICodexModel[]> {
  const authorizedFetch = createOpenAICodexFetch(database, options);
  const baseUrl = normalizeCodexBaseUrl(options.baseUrl);
  const url = new URL(`${baseUrl}/models`);
  url.searchParams.set(
    "client_version",
    readOpenAICodexClientVersion(options.clientVersion),
  );
  const response = await authorizedFetch(url, buildModelsRequest(options.signal));
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `OpenAI Codex model discovery failed with status ${response.status}.`,
    );
  }
  const value: unknown = await response.json();
  return decodeOpenAICodexModels(value);
}

export function decodeOpenAICodexModels(
  value: unknown,
): OpenAICodexModel[] {
  const decoded = codexModelsResponseSchema.safeParse(value);
  if (!decoded.success) {
    throw new Error("OpenAI Codex returned an invalid model catalog.");
  }
  const models: OpenAICodexModel[] = [];
  for (const entry of decoded.data.models) {
    const visibility = entry.visibility?.toLowerCase() ?? "";
    if (!entry.supported_in_api || (visibility !== "" && visibility !== "list")) {
      continue;
    }
    const levels = entry.supported_reasoning_levels ?? [];
    const supportedReasoningLevels = levels.map((level) => level.effort);
    const defaultReasoningLevel = readNonEmpty(entry.default_reasoning_level);
    models.push({
      defaultReasoningLevel,
      id: entry.slug,
      name: readNonEmpty(entry.display_name) ?? entry.slug,
      reasoning:
        supportedReasoningLevels.length > 0 || defaultReasoningLevel !== null,
      supportedReasoningLevels,
    });
  }
  if (models.length === 0) {
    throw new Error("OpenAI Codex returned an empty model catalog.");
  }
  models.sort((left, right) => left.name.localeCompare(right.name));
  return models;
}

function normalizeCodexBaseUrl(value: string | undefined): string {
  let normalized = value?.trim() ?? OPENAI_CODEX_BACKEND_BASE_URL;
  normalized = normalized.replace(/\/+$/u, "");
  normalized = normalized.replace(/\/responses$/u, "");
  if (!normalized.endsWith("/codex")) {
    return OPENAI_CODEX_BACKEND_BASE_URL;
  }
  return normalized;
}

function buildModelsRequest(signal: AbortSignal | undefined): RequestInit {
  const request: RequestInit = {
    headers: { accept: "application/json" },
    method: "GET",
  };
  if (signal !== undefined) {
    request.signal = signal;
  }
  return request;
}

function readNonEmpty(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}
