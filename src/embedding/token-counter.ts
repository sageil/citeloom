import { Tiktoken } from "js-tiktoken/lite";
import cl100kBase from "js-tiktoken/ranks/cl100k_base";

const embeddingInputEncoder = new Tiktoken(cl100kBase);

export const EMBEDDING_TOKEN_ACCOUNTING = "cl100k-base-tokens-v1";

export function countEmbeddingInputTokens(value: string): number {
  return embeddingInputEncoder.encode(value).length;
}
