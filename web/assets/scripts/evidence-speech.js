import { requestTextSpeech } from "./answer-speech.js";

const pauseIcon = "./assets/images/citeloom-icons.svg#citeloom-pause";
const refreshIcon = "./assets/images/citeloom-icons.svg#citeloom-refresh";
const speakerIcon = "./assets/images/citeloom-icons.svg#citeloom-speaker";

function readAudioElement(audio) {
  if (!(audio instanceof HTMLAudioElement)) {
    throw new Error("The evidence audio player is unavailable.");
  }
  return audio;
}

function readEvidenceSpeechActionLabel(context) {
  if (context.evidenceSpeechLoading) {
    return "Preparing evidence audio";
  }
  if (context.evidenceSpeechPlaying) {
    return "Pause evidence";
  }
  return "Listen to evidence";
}

function readEvidenceSpeechButtonLabel(context) {
  if (context.evidenceSpeechLoading) {
    return "Preparing";
  }
  if (context.evidenceSpeechPlaying) {
    return "Pause";
  }
  return "Listen";
}

function readEvidenceSpeechIcon(context) {
  if (context.evidenceSpeechLoading) {
    return refreshIcon;
  }
  if (context.evidenceSpeechPlaying) {
    return pauseIcon;
  }
  return speakerIcon;
}

function evidenceSupportsSpeech(citation) {
  return citation !== null && citation.evidence.kind !== "image";
}

function resetEvidenceSpeechPlaybackState(context, audio) {
  context.evidenceSpeechAbortController?.abort();
  context.evidenceSpeechAbortController = null;
  context.evidenceSpeechCitationId = null;
  context.evidenceSpeechLoading = false;
  context.evidenceSpeechPlaying = false;
  const audioUrl = context.evidenceSpeechAudioUrl;
  context.evidenceSpeechAudioUrl = "";
  if (audio instanceof HTMLAudioElement) {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }
  if (audioUrl !== "") {
    URL.revokeObjectURL(audioUrl);
  }
}

function reportEvidenceSpeechError(context, audio, reportError) {
  if (context.evidenceSpeechAudioUrl === "") {
    return;
  }
  resetEvidenceSpeechPlaybackState(context, audio);
  reportError("The evidence audio could not be played.");
}

async function toggleEvidenceSpeechPlayback(
  context,
  audio,
  citationId,
  evidenceText,
  reportError,
) {
  const player = readAudioElement(audio);
  const active = context.evidenceSpeechCitationId === citationId;
  if (active && !player.paused && !player.ended) {
    player.pause();
    return;
  }
  if (!active || context.evidenceSpeechAudioUrl === "") {
    resetEvidenceSpeechPlaybackState(context, player);
    const controller = new AbortController();
    context.evidenceSpeechAbortController = controller;
    context.evidenceSpeechCitationId = citationId;
    context.evidenceSpeechLoading = true;
    try {
      const audioBlob = await requestTextSpeech(
        evidenceText,
        controller.signal,
      );
      if (
        controller.signal.aborted
        || context.evidenceSpeechCitationId !== citationId
      ) {
        return;
      }
      const audioUrl = URL.createObjectURL(audioBlob);
      context.evidenceSpeechAudioUrl = audioUrl;
      player.src = audioUrl;
      player.load();
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error
          ? error.message
          : "The evidence audio could not be generated.";
        reportError(message);
      }
      return;
    } finally {
      if (context.evidenceSpeechAbortController === controller) {
        context.evidenceSpeechAbortController = null;
        context.evidenceSpeechLoading = false;
      }
    }
  }
  if (
    context.evidenceSpeechCitationId !== citationId
    || context.evidenceSpeechAudioUrl === ""
  ) {
    return;
  }
  if (player.ended) {
    player.currentTime = 0;
  }
  try {
    await player.play();
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "The evidence audio could not be played.";
    context.evidenceSpeechPlaying = false;
    reportError(message);
  }
}

export function createEvidenceSpeechControls(options) {
  return {
    evidenceSpeechAbortController: null,
    evidenceSpeechAudioUrl: "",
    evidenceSpeechCitationId: null,
    evidenceSpeechLoading: false,
    evidenceSpeechPlaying: false,

    evidenceCanSpeak() {
      return evidenceSupportsSpeech(options.readCitation(this));
    },

    evidenceSpeechActionLabel() {
      return readEvidenceSpeechActionLabel(this);
    },

    evidenceSpeechButtonLabel() {
      return readEvidenceSpeechButtonLabel(this);
    },

    evidenceSpeechIcon() {
      return readEvidenceSpeechIcon(this);
    },

    async toggleEvidenceSpeech() {
      const citation = options.readCitation(this);
      if (!evidenceSupportsSpeech(citation)) {
        return;
      }
      options.beforePlay(this);
      try {
        await toggleEvidenceSpeechPlayback(
          this,
          this.$refs[options.audioRefName],
          citation.id,
          options.readEvidenceText(this, citation),
          (message) => options.reportError(this, message),
        );
      } catch (error) {
        const message = error instanceof Error
          ? error.message
          : "The evidence audio could not be played.";
        options.reportError(this, message);
      }
    },

    resetEvidenceSpeechPlayback() {
      resetEvidenceSpeechPlaybackState(
        this,
        this.$refs[options.audioRefName],
      );
    },

    handleEvidenceSpeechPlaybackError() {
      reportEvidenceSpeechError(
        this,
        this.$refs[options.audioRefName],
        (message) => options.reportError(this, message),
      );
    },
  };
}
