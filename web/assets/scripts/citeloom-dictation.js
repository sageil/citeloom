import {
  readJsonResponse,
  readNonEmptyString,
  readPlainObject,
} from "./citeloom-boundaries.js";

const mediaRecorderOptions = Object.freeze([
  { extension: "webm", mimeType: "audio/webm;codecs=opus" },
  { extension: "mp4", mimeType: "audio/mp4" },
  { extension: "ogg", mimeType: "audio/ogg;codecs=opus" },
  { extension: "wav", mimeType: "audio/wav" },
]);
const maximumRecordingDurationMs = 120_000;
const readyStatus = "Voice input is ready. Audio is sent to the configured transcription provider.";

function readTranscription(value) {
  const response = readPlainObject(value, "transcription");
  return {
    text: readNonEmptyString(response.text, "transcription text"),
  };
}

function readErrorMessage(error, fallback) {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return fallback;
}

function selectMediaRecorderOption() {
  if (
    typeof MediaRecorder !== "function"
    || typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return null;
  }
  for (const option of mediaRecorderOptions) {
    if (MediaRecorder.isTypeSupported(option.mimeType)) {
      return option;
    }
  }
  return null;
}

export function formatDictationElapsedTime(elapsedSeconds) {
  const minutes = Math.floor(elapsedSeconds / 60);
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function createDictationController({
  onStart,
  onStateChange,
  onTranscript,
}) {
  let elapsedIntervalId = null;
  let mediaRecorder = null;
  let mediaRecorderChunks = [];
  let mediaRecorderOption = null;
  let mediaStream = null;
  let recordingGeneration = 0;
  let recordingStartedAt = 0;
  let recordingTimerId = null;
  let transcriptionAbortController = null;

  function publishState(state, status, elapsedSeconds = 0) {
    onStateChange({ elapsedSeconds, state, status });
  }

  function clearRecordingClock() {
    if (elapsedIntervalId !== null) {
      window.clearInterval(elapsedIntervalId);
      elapsedIntervalId = null;
    }
    if (recordingTimerId !== null) {
      window.clearTimeout(recordingTimerId);
      recordingTimerId = null;
    }
    recordingStartedAt = 0;
  }

  function releaseMediaStream() {
    if (mediaStream !== null) {
      for (const track of mediaStream.getTracks()) {
        track.stop();
      }
    }
    mediaStream = null;
  }

  function resetResources() {
    transcriptionAbortController?.abort();
    transcriptionAbortController = null;
    clearRecordingClock();
    if (mediaRecorder?.state === "recording") {
      mediaRecorder.stop();
    }
    mediaRecorder = null;
    mediaRecorderChunks = [];
    mediaRecorderOption = null;
    releaseMediaStream();
  }

  function cancel() {
    recordingGeneration += 1;
    resetResources();
    publishState("idle", readyStatus);
  }

  function startRecordingClock(generation) {
    recordingStartedAt = Date.now();
    elapsedIntervalId = window.setInterval(() => {
      if (recordingGeneration !== generation) {
        return;
      }
      const elapsedMilliseconds = Date.now() - recordingStartedAt;
      const elapsedSeconds = Math.floor(elapsedMilliseconds / 1_000);
      publishState(
        "recording",
        "Recording. Select Stop when you finish speaking.",
        elapsedSeconds,
      );
    }, 1_000);
    recordingTimerId = window.setTimeout(() => {
      stop();
    }, maximumRecordingDurationMs);
  }

  async function transcribeRecording(generation) {
    clearRecordingClock();
    releaseMediaStream();
    const option = mediaRecorderOption;
    const chunks = mediaRecorderChunks;
    mediaRecorder = null;
    mediaRecorderChunks = [];
    mediaRecorderOption = null;
    if (recordingGeneration !== generation || option === null) {
      return;
    }
    const controller = new AbortController();
    transcriptionAbortController = controller;
    try {
      const audio = new Blob(chunks, { type: option.mimeType });
      const body = new FormData();
      body.append("file", audio, `recording.${option.extension}`);
      const response = await fetch("/api/transcriptions", {
        body,
        method: "POST",
        signal: controller.signal,
      });
      const transcription = await readJsonResponse(
        response,
        "Transcription request",
        readTranscription,
      );
      if (controller.signal.aborted || recordingGeneration !== generation) {
        return;
      }
      onTranscript(transcription.text);
      publishState(
        "idle",
        "Transcript is ready. Review it before submitting.",
      );
    } catch (error) {
      if (!controller.signal.aborted && recordingGeneration === generation) {
        publishState(
          "error",
          readErrorMessage(error, "The recording could not be transcribed."),
        );
      }
    } finally {
      if (transcriptionAbortController === controller) {
        transcriptionAbortController = null;
      }
    }
  }

  async function start() {
    const option = selectMediaRecorderOption();
    if (option === null || navigator.mediaDevices?.getUserMedia === undefined) {
      publishState(
        "error",
        "Voice input is not supported by this browser.",
      );
      return;
    }
    cancel();
    onStart();
    const generation = recordingGeneration + 1;
    recordingGeneration = generation;
    publishState("requesting", "Waiting for microphone permission.");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (recordingGeneration !== generation) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
        return;
      }
      mediaStream = stream;
      const recorder = new MediaRecorder(stream, { mimeType: option.mimeType });
      mediaRecorder = recorder;
      mediaRecorderChunks = [];
      mediaRecorderOption = option;
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          mediaRecorderChunks.push(event.data);
        }
      });
      recorder.addEventListener("stop", () => {
        void transcribeRecording(generation);
      }, { once: true });
      recorder.start(250);
      publishState(
        "recording",
        "Recording. Select Stop when you finish speaking.",
      );
      startRecordingClock(generation);
    } catch (error) {
      releaseMediaStream();
      publishState(
        "error",
        readErrorMessage(error, "Microphone access was not available."),
      );
    }
  }

  function stop() {
    if (mediaRecorder?.state !== "recording") {
      return;
    }
    clearRecordingClock();
    publishState("transcribing", "Transcribing the recording.");
    mediaRecorder.stop();
  }

  publishState("idle", readyStatus);
  return Object.freeze({
    cancel,
    destroy: cancel,
    start,
    stop,
  });
}
