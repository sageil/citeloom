import {
  createUtf8ByteUpperBoundTokenCounter,
  type LanguageModelCapabilities,
} from "../src/inference/model-capabilities.js";

export function buildTestModelCapabilities(
  contextCapacityTokens = 1_000_000,
): LanguageModelCapabilities {
  return {
    contextCapacityTokens,
    modelId: "test-model",
    source: "configured",
    tokenCounter: createUtf8ByteUpperBoundTokenCounter(),
  };
}
