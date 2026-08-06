import { createHash } from "node:crypto";

import type { RetrievalConfig } from "../config/index.js";
import type { ResolvedQueryScopeTarget } from "../domain/query-scope.js";
import { createProcessingQuestion } from "../domain/question.js";

export interface AppliedGenerationSettings {
  seed: number | null;
  temperature: number;
}

export interface TurnGenerationSettings {
  answer: AppliedGenerationSettings;
  queryExpansion: AppliedGenerationSettings;
  seedMode: RetrievalConfig["generationSeedMode"];
}

export function createTurnGenerationSettings(
  retrieval: RetrievalConfig,
  question: string,
  scopeTargets: readonly ResolvedQueryScopeTarget[],
): TurnGenerationSettings {
  const seedInput = createGenerationSeedInput(question, scopeTargets);
  return {
    answer: {
      seed: createGenerationSeed(
        retrieval.generationSeedMode,
        "answer",
        seedInput,
      ),
      temperature: retrieval.answerTemperature,
    },
    queryExpansion: {
      seed: createGenerationSeed(
        retrieval.generationSeedMode,
        "query-expansion",
        seedInput,
      ),
      temperature: retrieval.queryExpansionTemperature,
    },
    seedMode: retrieval.generationSeedMode,
  };
}

function createGenerationSeedInput(
  question: string,
  scopeTargets: readonly ResolvedQueryScopeTarget[],
): string {
  const normalizedQuestion = question.trim().replace(/\s+/gu, " ");
  const seedQuestion = createProcessingQuestion(normalizedQuestion);
  const sortedTargets = [...scopeTargets];
  sortedTargets.sort(compareResolvedTargets);
  return JSON.stringify({ question: seedQuestion, scopeTargets: sortedTargets });
}

function compareResolvedTargets(
  left: ResolvedQueryScopeTarget,
  right: ResolvedQueryScopeTarget,
): number {
  if (left.documentId < right.documentId) {
    return -1;
  }
  if (left.documentId > right.documentId) {
    return 1;
  }
  if (left.generationId < right.generationId) {
    return -1;
  }
  if (left.generationId > right.generationId) {
    return 1;
  }
  return left.sourceFile.localeCompare(right.sourceFile);
}

function createGenerationSeed(
  mode: RetrievalConfig["generationSeedMode"],
  operation: "answer" | "query-expansion",
  seedInput: string,
): number | null {
  if (mode === "random") {
    return null;
  }
  const digest = createHash("sha256")
    .update("citeloom-generation-seed-v1\0")
    .update(operation)
    .update("\0")
    .update(seedInput)
    .digest();
  return digest.readUInt32BE(0) & 0x7fff_ffff;
}
