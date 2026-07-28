import {
  readEnum,
  readNonEmptyString,
  readPlainObject,
} from "./citeloom-boundaries.js";

const NOTICE_EVENT = "citeloom:notice";
const noticeKinds = Object.freeze(["error", "success"]);

function dispatchNotice(kind, message) {
  window.dispatchEvent(new CustomEvent(NOTICE_EVENT, {
    detail: { kind, message },
  }));
}

function readNoticeEvent(event) {
  if (!(event instanceof CustomEvent)) {
    return null;
  }
  try {
    const detail = readPlainObject(event.detail, "notice");
    return {
      kind: readNoticeKind(detail.kind, "notice kind"),
      message: readNonEmptyString(detail.message, "notice message"),
    };
  } catch {
    return null;
  }
}

function readNoticeKind(value, label) {
  return readEnum(value, noticeKinds, label);
}

export {
  NOTICE_EVENT,
  dispatchNotice,
  readNoticeEvent,
  readNoticeKind,
};
