import { readJsonResponse } from "./citeloom-boundaries.js";

function createUncitedSpeechDocument(content) {
  return {
    citations: [],
    content,
    schemaVersion: 2,
    statements: [],
  };
}

async function requestSpeech(answerDocument, signal, requestName) {
  const response = await fetch("/api/speech", {
    body: JSON.stringify({ answerDocument }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal,
  });
  if (!response.ok) {
    await readJsonResponse(response, requestName);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("audio/")) {
    throw new Error("The speech response was not audio.");
  }
  const audio = await response.blob();
  if (audio.size === 0) {
    throw new Error("The speech response was empty.");
  }
  return audio;
}

export async function requestAnswerSpeech(answerDocument, signal) {
  return requestSpeech(answerDocument, signal, "Answer speech request");
}

export async function requestTextSpeech(text, signal) {
  const answerDocument = createUncitedSpeechDocument(text);
  return requestSpeech(answerDocument, signal, "Evidence speech request");
}
