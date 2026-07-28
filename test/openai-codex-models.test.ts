import { describe, expect, it } from "vitest";

import {
  decodeOpenAICodexModels,
} from "../src/providers/openai-codex-models.js";

describe("OpenAI Codex model catalog", () => {
  it("keeps API-visible subscription models and their reasoning metadata", () => {
    const models = decodeOpenAICodexModels({
      models: [
        {
          default_reasoning_level: "medium",
          display_name: "GPT-5.6 Terra",
          slug: "gpt-5.6-terra",
          supported_in_api: true,
          supported_reasoning_levels: [
            { effort: "low" },
            { effort: "medium" },
            { effort: "high" },
          ],
          visibility: "list",
        },
        {
          display_name: "Hidden",
          slug: "hidden-model",
          supported_in_api: true,
          visibility: "hidden",
        },
        {
          display_name: "Not in API",
          slug: "unsupported-model",
          supported_in_api: false,
          visibility: "list",
        },
      ],
    });

    expect(models).toEqual([{
      defaultReasoningLevel: "medium",
      id: "gpt-5.6-terra",
      name: "GPT-5.6 Terra",
      reasoning: true,
      supportedReasoningLevels: ["low", "medium", "high"],
    }]);
  });
});
