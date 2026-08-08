import { describe, expect, it } from "vitest";

import {
  normalizeOpenAICodexResponsesBody,
  readOpenAICodexClientVersion,
} from "../src/providers/openai-codex-fetch.js";

describe("OpenAI Codex Responses transport", () => {
  it("advertises the supported Codex protocol version independently of the app release", () => {
    expect(readOpenAICodexClientVersion()).toBe("0.145.0");
    expect(readOpenAICodexClientVersion("0.146.0")).toBe("0.146.0");
  });

  it("forces the subscription streaming contract and removes unsupported controls", () => {
    const normalized = JSON.parse(normalizeOpenAICodexResponsesBody(
      JSON.stringify({
        input: [{ content: "Question", role: "user" }],
        max_output_tokens: 1_000,
        model: "gpt-5.6-terra",
        store: true,
        stream: false,
        temperature: 0.2,
        top_p: 0.9,
      }),
    ));

    expect(normalized).toEqual({
      input: [{ content: "Question", role: "user" }],
      model: "gpt-5.6-terra",
      store: false,
      stream: true,
    });
  });

  it("rejects missing and non-object bodies at the transport boundary", () => {
    expect(() => normalizeOpenAICodexResponsesBody(null)).toThrow(
      "require a JSON body",
    );
    expect(() => normalizeOpenAICodexResponsesBody("[]")).toThrow(
      "invalid Responses request body",
    );
  });
});
