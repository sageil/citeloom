function readPlainObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`The ${label} response is invalid.`);
  }
  return value;
}

function readArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`The ${label} response is invalid.`);
  }
  return value;
}

function readString(value, label) {
  if (typeof value !== "string") {
    throw new Error(`The ${label} response is invalid.`);
  }
  return value;
}

function readNonEmptyString(value, label) {
  const text = readString(value, label);
  if (text === "") {
    throw new Error(`The ${label} response is invalid.`);
  }
  return text;
}

function readNullableNonEmptyString(value, label) {
  if (value === null) {
    return null;
  }
  return readNonEmptyString(value, label);
}

function readNullableString(value, label) {
  if (value === null) {
    return null;
  }
  return readString(value, label);
}

function readBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new Error(`The ${label} response is invalid.`);
  }
  return value;
}

function readNullableBoolean(value, label) {
  if (value === null) {
    return null;
  }
  return readBoolean(value, label);
}

function readFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`The ${label} response is invalid.`);
  }
  return value;
}

function readNullableFiniteNumber(value, label) {
  if (value === null) {
    return null;
  }
  return readFiniteNumber(value, label);
}

function readNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`The ${label} response is invalid.`);
  }
  return value;
}

function readNullableNonNegativeInteger(value, label) {
  if (value === null) {
    return null;
  }
  return readNonNegativeInteger(value, label);
}

function readPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`The ${label} response is invalid.`);
  }
  return value;
}

function readNullablePositiveInteger(value, label) {
  if (value === null) {
    return null;
  }
  return readPositiveInteger(value, label);
}

function readTimestamp(value, label) {
  const timestamp = readNonEmptyString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`The ${label} response is invalid.`);
  }
  return timestamp;
}

function readNullableTimestamp(value, label) {
  if (value === null) {
    return null;
  }
  return readTimestamp(value, label);
}

function readEnum(value, allowedValues, label) {
  if (typeof value !== "string" || !allowedValues.includes(value)) {
    throw new Error(`The ${label} response is invalid.`);
  }
  return value;
}

function readApiErrorMessage(value) {
  try {
    const response = readPlainObject(value, "API error");
    const error = readPlainObject(response.error, "API error detail");
    return readNonEmptyString(error.message, "API error message");
  } catch {
    return null;
  }
}

async function readJsonResponse(response, label, decoder = null) {
  let value;
  try {
    value = await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
  if (!response.ok) {
    const message = readApiErrorMessage(value);
    throw new Error(message ?? `${label} failed with status ${response.status}.`);
  }
  return decoder === null ? value : decoder(value);
}

async function readUIMessageStream(response, label, receivePart) {
  if (!response.ok) {
    await readJsonResponse(response, label);
    return;
  }
  if (response.body === null) {
    throw new Error(`${label} did not contain a response stream.`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    buffer += decoder.decode(chunk.value, { stream: !chunk.done });
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      receiveUIMessageStreamLine(line, label, receivePart);
    }
    if (chunk.done) {
      break;
    }
  }
  receiveUIMessageStreamLine(buffer, label, receivePart);
}

function receiveUIMessageStreamLine(line, label, receivePart) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) {
    return;
  }
  const data = trimmed.slice(5).trim();
  if (data === "" || data === "[DONE]") {
    return;
  }
  let value;
  try {
    value = JSON.parse(data);
  } catch {
    throw new Error(`${label} contained invalid streamed JSON.`);
  }
  const part = readPlainObject(value, `${label} stream part`);
  const type = readNonEmptyString(part.type, `${label} stream part type`);
  if (type === "error") {
    throw new Error(readNonEmptyString(part.errorText, `${label} stream error`));
  }
  receivePart(part, type);
}

export {
  readArray,
  readBoolean,
  readEnum,
  readFiniteNumber,
  readJsonResponse,
  readNonEmptyString,
  readNonNegativeInteger,
  readNullableBoolean,
  readNullableFiniteNumber,
  readNullableNonEmptyString,
  readNullableNonNegativeInteger,
  readNullablePositiveInteger,
  readNullableString,
  readNullableTimestamp,
  readPlainObject,
  readPositiveInteger,
  readString,
  readTimestamp,
  readUIMessageStream,
};
