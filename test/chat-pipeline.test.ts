import { describe, expect, it } from "vitest";

import { createChatRetrievalConfig } from "../src/chat/pipeline.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";

describe("Chat pipeline configuration", () => {
  it("honors enabled retrieval features while applying chat temperature", () => {
    const config = readEqualWeightTestConfig();
    config.retrieval.answerTemperature = 0.2;
    config.retrieval.chatTemperature = 0.1;

    const chatConfig = createChatRetrievalConfig(config);

    expect(chatConfig.retrieval.queryExpansions).toBe(
      config.retrieval.queryExpansions,
    );
    expect(chatConfig.retrieval.queryExpansions).toBeGreaterThan(0);
    expect(chatConfig.retrieval.answerTemperature).toBe(
      config.retrieval.chatTemperature,
    );
    expect(config.retrieval.answerTemperature).not.toBe(
      config.retrieval.chatTemperature,
    );
  });
});
