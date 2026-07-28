import { createHash } from "node:crypto";

import type { RetrievalConfig } from "../config/index.js";
import type { ResolvedQueryScopeTarget } from "../domain/query-scope.js";

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
  const requestIdentity = createRequestIdentity(question, scopeTargets);
  return {
    answer: {
      seed: createGenerationSeed(retrieval.generationSeedMode, "answer", requestIdentity),
      temperature: retrieval.answerTemperature,
    },
    queryExpansion: {
      seed: createGenerationSeed(
        retrieval.generationSeedMode,
        "query-expansion",
        requestIdentity,
      ),
      temperature: retrieval.queryExpansionTemperature,
    },
    seedMode: retrieval.generationSeedMode,
  };
}

function createRequestIdentity(
  question: string,
  scopeTargets: readonly ResolvedQueryScopeTarget[],
): string {
  const normalizedQuestion = question.trim().replace(/\s+/gu, " ");
  const sortedTargets = [...scopeTargets];
  sortedTargets.sort(compareResolvedTargets);
  return JSON.stringify({ question: normalizedQuestion, scopeTargets: sortedTargets });
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
  return left.sourceFile.localeCompare(right.sourceFile);
}

function createGenerationSeed(
  mode: RetrievalConfig["generationSeedMode"],
  operation: "answer" | "query-expansion",
  requestIdentity: string,
): number | null {
  if (mode === "random") {
    return null;
  }
  const digest = createHash("sha256")
    .update("citeloom-generation-seed-v1\0")
    .update(operation)
    .update("\0")
    .update(requestIdentity)
    .digest();
  return digest.readUInt32BE(0) & 0x7fff_ffff;
}
