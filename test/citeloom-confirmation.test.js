import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONFIRMATION_REQUEST_EVENT,
  dispatchConfirmationResponse,
  readConfirmationRequestEvent,
  showMessage,
} from "../web/assets/scripts/confirmation.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CiteLoom message dialog", () => {
  it("uses the shared dialog with one action and no cancel action", async () => {
    const browserWindow = new EventTarget();
    let message = null;
    vi.stubGlobal("window", browserWindow);
    browserWindow.addEventListener(CONFIRMATION_REQUEST_EVENT, (event) => {
      message = readConfirmationRequestEvent(event);
      dispatchConfirmationResponse(event.detail.requestId, true);
    });

    await showMessage({
      actionLabel: "Close",
      description: "Open https://citeloom.example and try again.",
      title: "OAuth activation could not start",
      tone: "danger",
    });

    expect(message).toEqual({
      cancelLabel: null,
      confirmLabel: "Close",
      description: "Open https://citeloom.example and try again.",
      requestId: expect.stringMatching(/^confirmation-/u),
      title: "OAuth activation could not start",
      tone: "danger",
    });
  });
});
