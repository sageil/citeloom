import type { LanguageModelV4 } from "@ai-sdk/provider";
import {
  defaultSettingsMiddleware,
  wrapLanguageModel,
} from "ai";

import type { AppConfig } from "../../src/config/index.js";
import {
  createInferenceModelRegistry,
  type InferenceModelRegistry,
} from "../../src/inference/registry.js";

export interface EvaluationModelRegistry extends InferenceModelRegistry {
  evaluation: LanguageModelV4;
}

export function createEvaluationModelRegistry(
  config: AppConfig,
): EvaluationModelRegistry {
  const models = createInferenceModelRegistry(config);
  const evaluation = wrapLanguageModel({
    middleware: defaultSettingsMiddleware({
      settings: {
        maxOutputTokens: 128,
        temperature: 0.2,
      },
    }),
    model: models.answer,
    modelId: `${config.inference.answer.model}:evaluation`,
  });
  return {
    ...models,
    evaluation,
  };
}
