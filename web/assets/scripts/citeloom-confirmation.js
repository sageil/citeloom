import {
  readBoolean,
  readEnum,
  readNonEmptyString,
  readPlainObject,
} from "./citeloom-boundaries.js";

const CONFIRMATION_REQUEST_EVENT = "citeloom:confirmation-request";
const CONFIRMATION_RESPONSE_EVENT = "citeloom:confirmation-response";
const confirmationTones = Object.freeze(["danger", "default"]);
let confirmationRequestSequence = 0;

export function requestConfirmation(request) {
  confirmationRequestSequence += 1;
  const requestId = `confirmation-${confirmationRequestSequence}`;
  return new Promise((resolve) => {
    const responseListener = (event) => {
      const response = readConfirmationResponseEvent(event);
      if (response === null || response.requestId !== requestId) {
        return;
      }
      window.removeEventListener(
        CONFIRMATION_RESPONSE_EVENT,
        responseListener,
      );
      resolve(response.confirmed);
    };
    window.addEventListener(CONFIRMATION_RESPONSE_EVENT, responseListener);
    window.dispatchEvent(new CustomEvent(CONFIRMATION_REQUEST_EVENT, {
      detail: {
        cancelLabel: request.cancelLabel,
        confirmLabel: request.confirmLabel,
        description: request.description,
        requestId,
        title: request.title,
        tone: request.tone,
      },
    }));
  });
}

export function readConfirmationRequestEvent(event) {
  if (!(event instanceof CustomEvent)) {
    return null;
  }
  try {
    const request = readPlainObject(event.detail, "confirmation request");
    return {
      cancelLabel: readNonEmptyString(
        request.cancelLabel,
        "confirmation cancel label",
      ),
      confirmLabel: readNonEmptyString(
        request.confirmLabel,
        "confirmation action label",
      ),
      description: readNonEmptyString(
        request.description,
        "confirmation description",
      ),
      requestId: readNonEmptyString(
        request.requestId,
        "confirmation request ID",
      ),
      title: readNonEmptyString(request.title, "confirmation title"),
      tone: readEnum(request.tone, confirmationTones, "confirmation tone"),
    };
  } catch {
    return null;
  }
}

export function dispatchConfirmationResponse(requestId, confirmed) {
  window.dispatchEvent(new CustomEvent(CONFIRMATION_RESPONSE_EVENT, {
    detail: { confirmed, requestId },
  }));
}

function readConfirmationResponseEvent(event) {
  if (!(event instanceof CustomEvent)) {
    return null;
  }
  try {
    const response = readPlainObject(event.detail, "confirmation response");
    return {
      confirmed: readBoolean(
        response.confirmed,
        "confirmation response decision",
      ),
      requestId: readNonEmptyString(
        response.requestId,
        "confirmation response request ID",
      ),
    };
  } catch {
    return null;
  }
}

export { CONFIRMATION_REQUEST_EVENT };
