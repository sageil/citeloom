import { createHash } from "node:crypto";

export function createEvaluationModelSeed(
  seed: string,
  purpose: "question" | "relevance",
  identifier: string,
): number {
  const digest = createHash("sha256")
    .update(`${seed}:model:${purpose}:${identifier}`)
    .digest();
  return digest.readUInt32BE(0) % 2_147_483_647;
}
