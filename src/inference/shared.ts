import type { TelemetryOptions } from "ai";

import type { InferenceModelRegistry } from "./registry.js";

export const MAX_SOURCE_CHARACTERS = 16_000;

export function createInferenceTelemetryOptions(
  models: InferenceModelRegistry,
  functionId: string,
): TelemetryOptions {
  return {
    functionId,
    isEnabled: models.metrics.enabled,
    recordInputs: false,
    recordOutputs: false,
  };
}
