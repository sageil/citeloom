import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSpeechProviderChecks } from "../src/observability/doctor.js";
import { TaskLimiter } from "../src/shared/concurrency.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("explicit speech provider diagnostics", () => {
  it("tests active transcription and speech providers when diagnostics run", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/audio/transcriptions")) {
        return Promise.resolve(Response.json({ text: "" }));
      }
      if (url.endsWith("/audio/speech")) {
        return Promise.resolve(new Response("RIFF\u0000\u0000\u0000\u0000WAVEaudio", {
          headers: { "content-type": "audio/wav" },
        }));
      }
      throw new Error(`Unexpected diagnostic URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const config = readEqualWeightTestConfig({
      providerOptions: {
        speechToTextBaseUrl: "http://localhost:9001/v1",
        speechToTextEnabled: true,
        speechToTextModel: "transcription-model",
        textToSpeechBaseUrl: "http://localhost:9002/v1",
        textToSpeechEnabled: true,
        textToSpeechModel: "speech-model",
        textToSpeechVoice: "speech-voice",
      },
    });

    const scheduler = new TaskLimiter(1);
    const pendingChecks = buildSpeechProviderChecks(config, () => scheduler);
    const checks = await Promise.all(pendingChecks);

    expect(checks).toEqual([
      {
        detail: "model transcription-model accepted a transcription capability probe",
        name: "Speech-to-text provider",
        ok: true,
      },
      {
        detail: "model speech-model returned an audio capability probe",
        name: "Text-to-speech provider",
        ok: true,
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
