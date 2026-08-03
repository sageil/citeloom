import { readJsonResponse } from "./citeloom-boundaries.js";

export async function requestAnswerSpeech(answerDocument, signal) {
  const response = await fetch("/api/speech", {
    body: JSON.stringify({ answerDocument }),
    headers: { "content-type": "application/json" },
    method: "POST",
    signal,
  });
  if (!response.ok) {
    await readJsonResponse(response, "Answer speech request");
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
