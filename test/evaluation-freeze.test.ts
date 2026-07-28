import { describe, expect, it } from "vitest";

import {
  assertEvaluationConfigurationFrozen,
  createEvaluationConfigurationFreeze,
  decodeEvaluationConfigurationFreeze,
} from "../tools/evaluation/freeze.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";

describe("frozen evaluation configuration", () => {
  it("accepts only the exact code, settings, model, and retrieval configuration", () => {
    const config = readEqualWeightTestConfig({
      providerOptions: {
        rerankBaseUrl: "http://localhost:9000/v1",
        rerankEnabled: true,
      },
    });
    const freeze = createEvaluationConfigurationFreeze(
      config,
      "commit:working-tree",
      7,
    );
    expect(freeze).toMatchObject({
      payload: {
        retrieval: {
          channelOrderingPolicy: "channel-score-then-retrieval-id-v1",
        },
      },
      version: 5,
    });

    expect(() => assertEvaluationConfigurationFrozen(
      config,
      "commit:working-tree",
      7,
      freeze,
    )).not.toThrow();
    expect(() => assertEvaluationConfigurationFrozen(
      config,
      "different-revision",
      7,
      freeze,
    )).toThrow("does not match the frozen configuration");
    expect(() => assertEvaluationConfigurationFrozen(
      config,
      "commit:working-tree",
      8,
      freeze,
    )).toThrow("does not match the frozen configuration");

    const changedFusion = structuredClone(config);
    changedFusion.retrieval.fusion.denseWeight = 2;
    expect(() => assertEvaluationConfigurationFrozen(
      changedFusion,
      "commit:working-tree",
      7,
      freeze,
    )).toThrow("does not match the frozen configuration");
  });

  it("rejects a freeze whose payload was changed after fingerprinting", () => {
    const config = readEqualWeightTestConfig();
    const freeze = createEvaluationConfigurationFreeze(config, "commit", 1);
    const changed = structuredClone(freeze);
    changed.payload.retrieval.rrfK += 1;

    expect(() => decodeEvaluationConfigurationFreeze(changed, "test input"))
      .toThrow("fingerprint does not match");
  });
});
