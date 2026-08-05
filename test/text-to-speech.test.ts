import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/config/index.js";
import {
  generateTextToSpeech,
  probeTextToSpeechProvider,
  type SpeechRequest,
  TextToSpeechTimeoutError,
  TextToSpeechUnavailableError,
} from "../src/providers/text-to-speech.js";
import { readEqualWeightTestConfig } from "./config-fixture.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generateTextToSpeech", () => {
  it("projects a structured answer and requests WAV audio", async () => {
    const audioBytes = Buffer.from("RIFF test audio");
    const fetchMock = vi.fn().mockResolvedValue(new Response(audioBytes, {
      headers: { "content-type": "audio/wav" },
      status: 200,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateTextToSpeech(
      buildEnabledConfig(),
      buildSpeechRequest("The answer is supported by the document."),
      new AbortController().signal,
    );

    await expect(readAudio(result.audio)).resolves.toEqual(audioBytes);
    await expect(result.completion).resolves.toBeUndefined();
    expect(result.contentType).toBe("audio/wav");
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:9000/v1/audio/speech");
    expect(request.method).toBe("POST");
    expect(request.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(request.headers);
    expect(headers.get("accept")).toBe("audio/wav");
    expect(headers.get("authorization")).toBe("Bearer speech-token");
    expect(JSON.parse(String(request.body))).toEqual({
      input: "The answer is supported by the document.",
      model: "Kokoro-82M-bf16",
      response_format: "wav",
      speed: 1.1,
      voice: "af_heart",
    });
  });

  it("fails without calling a provider when text-to-speech is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(generateTextToSpeech(
      buildDisabledConfig(),
      buildSpeechRequest("An answer."),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(TextToSpeechUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates caller cancellation to the provider request", async () => {
    const providerSignals: AbortSignal[] = [];
    const fetchMock = vi.fn((
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const requestSignal = init?.signal;
      if (!(requestSignal instanceof AbortSignal)) {
        throw new Error("Expected a provider abort signal.");
      }
      providerSignals.push(requestSignal);
      return new Promise((_resolve, reject) => {
        requestSignal.addEventListener(
          "abort",
          () => reject(requestSignal.reason),
          { once: true },
        );
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const abortController = new AbortController();

    const result = generateTextToSpeech(
      buildEnabledConfig(),
      buildSpeechRequest("An answer."),
      abortController.signal,
    );
    abortController.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(providerSignals).toHaveLength(1);
    expect(providerSignals[0]?.aborted).toBe(true);
  });

  it("preserves provider failures as errors", async () => {
    const providerDetail = "x".repeat(3_000);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(providerDetail, { status: 503 }),
    ));

    await expect(generateTextToSpeech(
      buildEnabledConfig(),
      buildSpeechRequest("An answer."),
      new AbortController().signal,
    )).rejects.toThrow(
      `Text-to-speech provider returned HTTP 503: ${"x".repeat(2_000)}`,
    );
  });

  it("classifies the configured provider deadline", async () => {
    vi.stubGlobal("fetch", vi.fn((
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const signal = init?.signal;
      if (!(signal instanceof AbortSignal)) {
        throw new Error("Expected a provider abort signal.");
      }
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    }));
    const config = buildEnabledConfig();
    if (config.textToSpeech === null) {
      throw new Error("Expected enabled text-to-speech configuration.");
    }
    config.textToSpeech.timeoutMs = 1;

    await expect(generateTextToSpeech(
      config,
      buildSpeechRequest("An answer."),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(TextToSpeechTimeoutError);
  });

  it("normalizes OpenAI octet-stream WAV responses inside its adapter", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("wav-audio", {
        headers: { "content-type": "application/octet-stream" },
      }),
    ));
    const config = buildEnabledConfig();
    if (config.textToSpeech === null) {
      throw new Error("Expected enabled text-to-speech configuration.");
    }
    config.textToSpeech.adapter = "openai-speech";

    const result = await generateTextToSpeech(
      config,
      buildSpeechRequest("An answer."),
      new AbortController().signal,
    );

    expect(result.contentType).toBe("audio/wav");
  });

  it("requests and accepts MP3 audio through OpenRouter", async () => {
    const audioBytes = Buffer.from([0xff, 0xfb, 0x90, 0xc4]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(audioBytes, {
      headers: { "content-type": "audio/mpeg" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const config = buildEnabledConfig();
    if (config.textToSpeech === null) {
      throw new Error("Expected enabled text-to-speech configuration.");
    }
    config.textToSpeech.adapter = "openrouter-speech";

    const result = await generateTextToSpeech(
      config,
      buildSpeechRequest("An answer."),
      new AbortController().signal,
    );

    await expect(readAudio(result.audio)).resolves.toEqual(audioBytes);
    await expect(result.completion).resolves.toBeUndefined();
    expect(result.contentType).toBe("audio/mpeg");
    const request = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(request?.headers);
    expect(headers.get("accept")).toBe("audio/mpeg");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      response_format: "mp3",
    });
  });

  it("keeps completion pending until the provider audio body ends", async () => {
    const providerBody = new TransformStream<Uint8Array, Uint8Array>();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(providerBody.readable, {
        headers: { "content-type": "audio/wav" },
      }),
    ));

    const result = await generateTextToSpeech(
      buildEnabledConfig(),
      buildSpeechRequest("An answer."),
      new AbortController().signal,
    );
    let completed = false;
    void result.completion.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);

    const audio = readAudio(result.audio);
    const writer = providerBody.writable.getWriter();
    await writer.write(Buffer.from("RIFF test audio"));
    await writer.close();

    await expect(audio).resolves.toEqual(Buffer.from("RIFF test audio"));
    await expect(result.completion).resolves.toBeUndefined();
    expect(completed).toBe(true);
  });

  it("classifies a provider deadline after response headers", async () => {
    const providerBody = new ReadableStream<Uint8Array>();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(providerBody, {
        headers: { "content-type": "audio/wav" },
      }),
    ));
    const config = buildEnabledConfig();
    if (config.textToSpeech === null) {
      throw new Error("Expected enabled text-to-speech configuration.");
    }
    config.textToSpeech.timeoutMs = 10;

    const result = await generateTextToSpeech(
      config,
      buildSpeechRequest("An answer."),
      new AbortController().signal,
    );

    await expect(result.completion).rejects.toBeInstanceOf(
      TextToSpeechTimeoutError,
    );
  });

  it("rejects unsupported or empty audio responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      Response.json({ error: "unexpected" }),
    ));
    await expect(generateTextToSpeech(
      buildEnabledConfig(),
      buildSpeechRequest("An answer."),
      new AbortController().signal,
    )).rejects.toThrow("unsupported content type: application/json");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(null, {
        headers: { "content-type": "audio/wav" },
        status: 200,
      }),
    ));
    await expect(generateTextToSpeech(
      buildEnabledConfig(),
      buildSpeechRequest("An answer."),
      new AbortController().signal,
    )).rejects.toThrow("returned an empty audio response");
  });
});

describe("probeTextToSpeechProvider", () => {
  it("requires a delivered WAV header", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response("not wav audio", {
        headers: { "content-type": "audio/wav" },
      }),
    ));
    const config = buildEnabledConfig().textToSpeech;
    if (config === null) {
      throw new Error("Expected enabled text-to-speech configuration.");
    }

    await expect(probeTextToSpeechProvider(
      config,
      new AbortController().signal,
    )).rejects.toThrow("returned invalid WAV audio");
  });

  it("accepts an MP3 frame header from OpenRouter", async () => {
    const audioBytes = Buffer.from([
      0xff,
      0xfb,
      0x90,
      0xc4,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(audioBytes, {
        headers: { "content-type": "audio/mpeg" },
      }),
    ));
    const config = buildEnabledConfig().textToSpeech;
    if (config === null) {
      throw new Error("Expected enabled text-to-speech configuration.");
    }
    config.adapter = "openrouter-speech";

    await expect(probeTextToSpeechProvider(
      config,
      new AbortController().signal,
    )).resolves.toBeUndefined();
  });
});

function buildSpeechRequest(content: string): SpeechRequest {
  const citationId = "00000000-0000-4000-8000-000000000001";
  return {
    answerDocument: {
      citations: [{
        citationNumber: 1,
        documentId: "a".repeat(64),
        documentVersionId: "00000000-0000-4000-8000-000000000002",
        elementId: "b".repeat(64),
        evidence: { excerpt: "Supporting evidence.", kind: "text" },
        id: citationId,
        kind: "text",
        pageNumbers: [1],
        regions: [],
        sectionPath: [],
        sourceFile: "/tmp/report.pdf",
      }],
      content,
      schemaVersion: 1,
      statements: [],
    },
  };
}

function buildEnabledConfig(): AppConfig {
  return readEqualWeightTestConfig({
    providerOptions: {
      textToSpeechApiToken: "speech-token",
      textToSpeechBaseUrl: "http://localhost:9000/v1",
      textToSpeechEnabled: true,
      textToSpeechModel: "Kokoro-82M-bf16",
      textToSpeechVoice: "af_heart",
    },
    runtime: {
      ttsSpeed: 1.1,
      ttsTimeoutSeconds: 30,
    },
  });
}

function buildDisabledConfig(): AppConfig {
  return readEqualWeightTestConfig();
}

async function readAudio(audio: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of audio) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
