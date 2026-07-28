import type { LanguageInferenceConfig } from "../config/index.js";

export interface ModelTokenCounter {
  contract: "utf8-byte-upper-bound";
  countTextTokens: (text: string) => number;
}

export interface LanguageModelCapabilities {
  contextCapacityTokens: number;
  modelId: string;
  source: "configured";
  tokenCounter: ModelTokenCounter;
}

export function readLanguageModelCapabilities(
  config: LanguageInferenceConfig,
  _abortSignal: AbortSignal,
): Promise<LanguageModelCapabilities> {
  return Promise.resolve({
    contextCapacityTokens: config.contextCapacityTokens,
    modelId: config.model,
    source: "configured",
    tokenCounter: createUtf8ByteUpperBoundTokenCounter(),
  });
}

export function createUtf8ByteUpperBoundTokenCounter(): ModelTokenCounter {
  return {
    contract: "utf8-byte-upper-bound",
    countTextTokens: (text) => new TextEncoder().encode(text).byteLength,
  };
}
