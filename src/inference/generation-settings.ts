import type { RetrievalConfig } from "../config/index.js";

export interface AppliedGenerationSettings {
  temperature: number;
}

export interface TurnGenerationSettings {
  answer: AppliedGenerationSettings;
  queryExpansion: AppliedGenerationSettings;
}

export function createTurnGenerationSettings(
  retrieval: RetrievalConfig,
): TurnGenerationSettings {
  return {
    answer: {
      temperature: retrieval.answerTemperature,
    },
    queryExpansion: {
      temperature: retrieval.queryExpansionTemperature,
    },
  };
}
