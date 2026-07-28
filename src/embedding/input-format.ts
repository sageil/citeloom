import type { EmbeddingInferenceConfig } from "../config/index.js";

export type EmbeddingProfile = EmbeddingInferenceConfig["profile"];

export function formatDocumentEmbeddingText(
  profile: EmbeddingProfile,
  content: string,
): string {
  if (profile === "embeddinggemma") {
    return `title: none | text: ${content}`;
  }
  return content;
}

export function formatQueryEmbeddingText(
  profile: EmbeddingProfile,
  query: string,
): string {
  if (profile === "embeddinggemma") {
    return `task: search result | query: ${query}`;
  }
  return query;
}
