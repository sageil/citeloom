import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config/index.js";
import {
  SpeechToTextProviderError,
  SpeechToTextTimeoutError,
  SpeechToTextUnavailableError,
  transcribeAudio,
  type TranscriptionAudio,
} from "../src/providers/speech-to-text.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transcribeAudio", () => {
  it("sends the exact configured provider fields with generated audio metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      duration: 1.25,
      language: "English",
      text: "CiteLoom should search the evidence for Section 42.",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const result = await transcribeAudio(
      buildEnabledConfig(),
      buildAudio(),
      controller.signal,
    );

    expect(result).toEqual({
      text: "CiteLoom should search the evidence for Section 42.",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:9000/v1/audio/transcriptions");
    expect(request.method).toBe("POST");
    expect(request.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(request.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer transcription-token");
    expect(headers.get("content-type")).toBeNull();
    const form = request.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) {
      throw new Error("Expected provider request FormData.");
    }
    expect(Array.from(form.keys())).toEqual(["file", "model", "language", "prompt"]);
    const file = form.get("file");
    expect(file).toBeInstanceOf(File);
    if (!(file instanceof File)) {
      throw new Error("Expected provider audio file.");
    }
    expect(file.name).toBe("recording-00000000-0000-4000-8000-000000000001.webm");
    expect(file.type).toBe("audio/webm");
    expect(await file.text()).toBe("recorded audio");
    expect(form.get("model")).toBe("Qwen3-ASR-1.7B-8bit");
    expect(form.get("language")).toBe("English");
    expect(form.get("prompt")).toBe(
      "CiteLoom is the product name. Preserve the exact spelling CiteLoom.",
    );
  });

  it("omits authentication and optional provider fields when they are not configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ text: "Transcript" }));
    vi.stubGlobal("fetch", fetchMock);
    const config = buildEnabledConfig({
      apiToken: null,
      language: null,
      prompt: null,
    });

    await transcribeAudio(config, buildAudio(), new AbortController().signal);

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(request).toBeDefined();
    expect(new Headers(request?.headers).get("authorization")).toBeNull();
    const form = request?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) {
      throw new Error("Expected provider request FormData.");
    }
    expect(Array.from(form.keys())).toEqual(["file", "model"]);
  });

  it.each([
    ["empty transcript", Response.json({ text: "  " })],
    ["oversized transcript", Response.json({ text: "x".repeat(8_001) })],
    ["non-string transcript", Response.json({ text: 42 })],
    ["malformed JSON", new Response("{", {
      headers: { "content-type": "application/json" },
    })],
    ["non-JSON response", new Response("transcript", {
      headers: { "content-type": "text/plain" },
    })],
  ])("rejects an invalid provider %s", async (_name, response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    await expect(transcribeAudio(
      buildEnabledConfig(),
      buildAudio(),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(SpeechToTextProviderError);
  });

  it("rejects an exact configured-prompt echo instead of returning it as speech", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      text: "CiteLoom is the product name. Preserve the exact spelling CiteLoom.",
    })));

    const result = transcribeAudio(
      buildEnabledConfig(),
      buildAudio(),
      new AbortController().signal,
    );

    await expect(result).rejects.toThrow(
      "The recording did not contain enough clear speech. Try recording again.",
    );
  });

  it("keeps provider text when the OpenAI adapter returns the configured prompt", async () => {
    const prompt = "CiteLoom is the product name. Preserve the exact spelling CiteLoom.";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      text: prompt,
    })));
    const config = buildEnabledConfig();
    if (config.speechToText === null) {
      throw new Error("Expected enabled speech-to-text configuration.");
    }
    config.speechToText.adapter = "openai-transcription";

    await expect(transcribeAudio(
      config,
      buildAudio(),
      new AbortController().signal,
    )).resolves.toEqual({ text: prompt });
  });

  it("uses OpenRouter's base64 JSON transcription contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      text: "OpenRouter transcript",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const config = buildEnabledConfig();
    if (config.speechToText === null) {
      throw new Error("Expected enabled speech-to-text configuration.");
    }
    config.speechToText.adapter = "openrouter-transcription";

    await expect(transcribeAudio(
      config,
      buildAudio(),
      new AbortController().signal,
    )).resolves.toEqual({ text: "OpenRouter transcript" });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(request?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(JSON.parse(String(request?.body))).toEqual({
      input_audio: {
        data: Buffer.from("recorded audio").toString("base64"),
        format: "webm",
      },
      language: "en",
      model: "Qwen3-ASR-1.7B-8bit",
    });
  });

  it("uses Mistral's language and context-bias transcription fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      text: "Mistral transcript",
    }));
    vi.stubGlobal("fetch", fetchMock);
    const config = buildEnabledConfig({
      apiToken: "mistral-token",
      language: "English",
      prompt: "CiteLoom, systemic hypertension; chronic kidney disease",
    });
    if (config.speechToText === null) {
      throw new Error("Expected enabled speech-to-text configuration.");
    }
    config.speechToText.adapter = "mistral-transcription";
    config.speechToText.model = "voxtral-mini-latest";

    await expect(transcribeAudio(
      config,
      buildAudio(),
      new AbortController().signal,
    )).resolves.toEqual({ text: "Mistral transcript" });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const form = request?.body;
    expect(form).toBeInstanceOf(FormData);
    if (!(form instanceof FormData)) {
      throw new Error("Expected provider request FormData.");
    }
    expect(form.get("model")).toBe("voxtral-mini-latest");
    expect(form.get("language")).toBe("en");
    expect(form.get("prompt")).toBeNull();
    expect(form.getAll("context_bias")).toEqual([
      "CiteLoom",
      "systemic_hypertension",
      "chronic_kidney_disease",
    ]);
  });

  it("bounds and redacts provider error responses", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      cancel,
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(
          `transcription-token ${"x".repeat(20_000)}`,
        ));
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, {
      status: 503,
    })));

    const result = transcribeAudio(
      buildEnabledConfig(),
      buildAudio(),
      new AbortController().signal,
    );

    await expect(result).rejects.toThrow(
      "The transcription provider could not complete the request.",
    );
    await expect(result).rejects.not.toThrow("transcription-token");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("propagates caller cancellation to the provider", async () => {
    const providerSignals: AbortSignal[] = [];
    vi.stubGlobal("fetch", vi.fn((
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error("Expected a provider abort signal.");
      }
      providerSignals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }));
    const controller = new AbortController();

    const result = transcribeAudio(buildEnabledConfig(), buildAudio(), controller.signal);
    controller.abort(new DOMException("Canceled", "AbortError"));

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(providerSignals).toHaveLength(1);
    expect(providerSignals[0]?.aborted).toBe(true);
  });

  it("maps the configured provider deadline to a timeout error", async () => {
    vi.stubGlobal("fetch", vi.fn((
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error("Expected a provider abort signal.");
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }));
    const config = buildEnabledConfig();
    if (config.speechToText === null) {
      throw new Error("Expected enabled speech-to-text configuration.");
    }
    config.speechToText.timeoutMs = 1;

    await expect(transcribeAudio(
      config,
      buildAudio(),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(SpeechToTextTimeoutError);
  });

  it("fails without calling a provider when speech-to-text is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(transcribeAudio(
      buildDisabledConfig(),
      buildAudio(),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(SpeechToTextUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function buildAudio(): TranscriptionAudio {
  return {
    content: Buffer.from("recorded audio"),
    filename: "recording-00000000-0000-4000-8000-000000000001.webm",
    mediaType: "audio/webm",
  };
}

function buildEnabledConfig(
  overrides?: SpeechConfigOverrides,
): AppConfig {
  const apiToken = overrides === undefined
    ? "transcription-token"
    : overrides.apiToken;
  const language = overrides === undefined ? "English" : overrides.language;
  const prompt = overrides === undefined
    ? "CiteLoom is the product name. Preserve the exact spelling CiteLoom."
    : overrides.prompt;
  return readEqualWeightTestConfig({
    providerOptions: {
      speechToTextApiToken: apiToken,
      speechToTextBaseUrl: "http://localhost:9000/v1",
      speechToTextEnabled: true,
      speechToTextModel: "Qwen3-ASR-1.7B-8bit",
    },
    runtime: {
      sttLanguage: language,
      sttPrompt: prompt,
      sttTimeoutSeconds: 60,
    },
  });
}

function buildDisabledConfig(): AppConfig {
  return readEqualWeightTestConfig();
}

interface SpeechConfigOverrides {
  apiToken: string | null;
  language: string | null;
  prompt: string | null;
}
