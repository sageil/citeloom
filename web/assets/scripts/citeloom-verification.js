import { readEnum } from "./citeloom-boundaries.js";

const verificationStates = Object.freeze([
  "not-applicable",
  "pending",
  "running",
  "completed",
  "failed",
]);

export function readVerificationState(value, label) {
  return readEnum(value, verificationStates, label);
}

export function isVerificationPending(state) {
  return state === "pending" || state === "running";
}

export function verificationLabel(state) {
  if (state === "pending") {
    return "Evidence validation is queued";
  }
  if (state === "running") {
    return "Validating evidence";
  }
  if (state === "completed") {
    return "Evidence validation complete";
  }
  if (state === "failed") {
    return "Evidence validation could not be completed";
  }
  return "Evidence validation is not required";
}

export function verificationStatusLabel(state) {
  if (state === "pending") {
    return "Queued";
  }
  if (state === "running") {
    return "Checking evidence";
  }
  if (state === "completed") {
    return "Verified";
  }
  if (state === "failed") {
    return "Check failed";
  }
  return "";
}

export function verificationProgressValue(state) {
  return state === "completed" ? 100 : null;
}
