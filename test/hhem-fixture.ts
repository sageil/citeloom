import {
  HHEM_DISPLAY_MODEL,
  type HhemClient,
  type HhemScoreItem,
  type HhemScoreResult,
} from "../src/verification/hhem-client.js";

export class FakeHhemClient implements HhemClient {
  public readonly checkReadyCalls: Array<AbortSignal | undefined> = [];
  public readonly modelId = HHEM_DISPLAY_MODEL;
  public readonly provider = "HHEM test runtime";
  public readonly scoreCalls: Array<readonly HhemScoreItem[]> = [];

  public constructor(
    public readonly supportThreshold = 0.5,
    private readonly scoreHandler: (
      items: readonly HhemScoreItem[],
      abortSignal: AbortSignal,
    ) => Promise<HhemScoreResult[]> = buildSupportedResults,
  ) {}

  public async checkReady(abortSignal?: AbortSignal): Promise<void> {
    this.checkReadyCalls.push(abortSignal);
  }

  public async score(
    items: readonly HhemScoreItem[],
    abortSignal: AbortSignal,
  ): Promise<HhemScoreResult[]> {
    this.scoreCalls.push(items);
    return this.scoreHandler(items, abortSignal);
  }
}

async function buildSupportedResults(
  items: readonly HhemScoreItem[],
): Promise<HhemScoreResult[]> {
  const results: HhemScoreResult[] = [];
  for (const item of items) {
    results.push({ id: item.id, outcome: "scored", supportProbability: 0.9 });
  }
  return results;
}
