import { readJsonResponse } from "./boundary-readers.js";

const pauseIcon = "./assets/images/citeloom-icons.svg#citeloom-pause";
const refreshIcon = "./assets/images/citeloom-icons.svg#citeloom-refresh";
const speakerIcon = "./assets/images/citeloom-icons.svg#citeloom-speaker";

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

function readSpeechPlayer(context, options) {
  const audio = context.$refs[options.audioRefName];
  if (!(audio instanceof HTMLAudioElement)) {
    throw new Error("The answer audio player is unavailable.");
  }
  return audio;
}

function readSpeechTargetId(context, options) {
  return context[options.targetIdProperty];
}

function writeSpeechTargetId(context, options, targetId) {
  context[options.targetIdProperty] = targetId;
}

function readCurrentSpeechTargetId(context, options) {
  const target = options.findPreloadTarget(context);
  if (target === null) {
    return null;
  }
  return options.readTargetId(target);
}

function readSpeechErrorMessage(error, fallback) {
  if (error instanceof Error && error.message !== "") {
    return error.message;
  }
  return fallback;
}

function resetAnswerSpeechState(context, options) {
  context.speechAbortController?.abort();
  context.speechAbortController = null;
  context.speechAudioError = "";
  context.speechAudioLoading = false;
  context.speechAudioPlaying = false;
  writeSpeechTargetId(context, options, null);
  const audioUrl = context.speechAudioUrl;
  context.speechAudioUrl = "";
  const audio = context.$refs[options.audioRefName];
  if (audio instanceof HTMLAudioElement) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  if (audioUrl !== "") {
    URL.revokeObjectURL(audioUrl);
  }
}

function reportAnswerSpeechError(context, options, error, fallback) {
  const message = readSpeechErrorMessage(error, fallback);
  context.speechAudioError = message;
  context.speechAudioPlaying = false;
  options.reportError(context, message);
}

export function createAnswerSpeechControls(options) {
  const controls = {
    speechAbortController: null,
    speechAudioError: "",
    speechAudioLoading: false,
    speechAudioPlaying: false,
    speechAudioUrl: "",

    answerSpeechCurrentTargetId() {
      return readCurrentSpeechTargetId(this, options);
    },

    answerSpeechActionLabel(targetId = this.answerSpeechCurrentTargetId()) {
      const active = readSpeechTargetId(this, options) === targetId;
      if (active && this.speechAudioLoading) {
        return "Preparing answer audio";
      }
      if (active && this.speechAudioPlaying) {
        return "Pause answer";
      }
      return "Listen to answer";
    },

    answerSpeechButtonLabel(targetId = this.answerSpeechCurrentTargetId()) {
      const active = readSpeechTargetId(this, options) === targetId;
      if (active && this.speechAudioLoading) {
        return "Preparing";
      }
      if (active && this.speechAudioPlaying) {
        return "Pause";
      }
      return "Listen";
    },

    answerSpeechIcon(targetId = this.answerSpeechCurrentTargetId()) {
      const active = readSpeechTargetId(this, options) === targetId;
      if (active && this.speechAudioLoading) {
        return refreshIcon;
      }
      if (active && this.speechAudioPlaying) {
        return pauseIcon;
      }
      return speakerIcon;
    },

    answerSpeechLoading(targetId = this.answerSpeechCurrentTargetId()) {
      return readSpeechTargetId(this, options) === targetId
        && this.speechAudioLoading;
    },

    prepareAnswerSpeech() {
      const targetId = readSpeechTargetId(this, options);
      if (targetId === null) {
        return;
      }
      if (options.findTarget(this, targetId) === null) {
        this.resetAnswerSpeechAudio();
      }
    },

    maybePreloadAnswerSpeech() {
      if (
        !this.textToSpeechEnabled
        || !this.textToSpeechPreloadEnabled
        || this.speechAudioLoading
        || this.speechAudioUrl !== ""
      ) {
        return;
      }
      const targetId = this.answerSpeechCurrentTargetId();
      if (targetId !== null) {
        void this.loadAnswerSpeech(targetId, false);
      }
    },

    async loadAnswerSpeech(
      targetId = this.answerSpeechCurrentTargetId(),
      surfaceError = true,
    ) {
      if (targetId === null || this.speechAudioLoading) {
        return false;
      }
      const target = options.findTarget(this, targetId);
      if (target === null) {
        return false;
      }
      if (
        readSpeechTargetId(this, options) === targetId
        && this.speechAudioUrl !== ""
      ) {
        return true;
      }
      resetAnswerSpeechState(this, options);
      const controller = new AbortController();
      this.speechAbortController = controller;
      this.speechAudioLoading = true;
      writeSpeechTargetId(this, options, targetId);
      try {
        const audioBlob = await requestAnswerSpeech(
          target.answerDocument,
          controller.signal,
        );
        const currentTarget = options.findTarget(this, targetId);
        if (
          controller.signal.aborted
          || currentTarget === null
          || options.readTargetId(currentTarget) !== targetId
        ) {
          return false;
        }
        const player = readSpeechPlayer(this, options);
        const audioUrl = URL.createObjectURL(audioBlob);
        this.speechAudioUrl = audioUrl;
        player.src = audioUrl;
        player.load();
        return true;
      } catch (error) {
        if (!controller.signal.aborted && surfaceError) {
          reportAnswerSpeechError(
            this,
            options,
            error,
            "The answer audio could not be generated.",
          );
        }
        return false;
      } finally {
        if (this.speechAbortController === controller) {
          this.speechAbortController = null;
          this.speechAudioLoading = false;
        }
      }
    },

    async toggleAnswerSpeech(targetId = this.answerSpeechCurrentTargetId()) {
      if (targetId === null) {
        return;
      }
      let audio;
      try {
        audio = readSpeechPlayer(this, options);
      } catch (error) {
        reportAnswerSpeechError(
          this,
          options,
          error,
          "The answer audio player is unavailable.",
        );
        return;
      }
      options.beforePlay(this);
      const active = readSpeechTargetId(this, options) === targetId;
      if (active && !audio.paused && !audio.ended) {
        audio.pause();
        return;
      }
      if (!active || this.speechAudioUrl === "") {
        const loaded = await this.loadAnswerSpeech(targetId, true);
        if (!loaded) {
          return;
        }
      }
      if (audio.ended) {
        audio.currentTime = 0;
      }
      try {
        await audio.play();
      } catch (error) {
        reportAnswerSpeechError(
          this,
          options,
          error,
          "The answer audio could not be played.",
        );
      }
    },

    pauseAnswerSpeech() {
      const audio = this.$refs[options.audioRefName];
      if (audio instanceof HTMLAudioElement) {
        audio.pause();
      }
    },

    resetAnswerSpeechAudio() {
      resetAnswerSpeechState(this, options);
    },

    handleAnswerSpeechError() {
      if (this.speechAudioUrl === "") {
        return;
      }
      reportAnswerSpeechError(
        this,
        options,
        new Error("The answer audio could not be played."),
        "The answer audio could not be played.",
      );
    },
  };
  controls[options.targetIdProperty] = null;
  return controls;
}
