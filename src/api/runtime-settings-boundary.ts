import { z } from "zod";

import {
  decodeRuntimeSettingValue,
  runtimeSettingDefinitions,
  type RuntimeSettingDefinition,
} from "../app/settings.js";
import type {
  RuntimeSettingKey,
  RuntimeSettings,
  RuntimeSettingValue,
} from "../config/index.js";

type MillisecondRuntimeSettingKey =
  | "backgroundProgressIntervalMs"
  | "retryBaseMs"
  | "workerFallbackPollMs";

type SecondRuntimeSettingKey =
  | "backgroundProgressIntervalSeconds"
  | "retryBaseSeconds"
  | "workerFallbackPollSeconds";

export interface RuntimeSettingBoundaryReference {
  browserKey: string;
  definition: RuntimeSettingDefinition;
  storageKey: RuntimeSettingKey;
}

export interface RuntimeSettingFieldPresentation {
  key: string;
  max: number | null;
  min: number | null;
  step: number | null;
  unit: string | null;
}

const browserKeyByMillisecondSetting = {
  backgroundProgressIntervalMs: "backgroundProgressIntervalSeconds",
  retryBaseMs: "retryBaseSeconds",
  workerFallbackPollMs: "workerFallbackPollSeconds",
} satisfies Record<MillisecondRuntimeSettingKey, SecondRuntimeSettingKey>;

const boundaryReferenceByBrowserKey =
  new Map<string, RuntimeSettingBoundaryReference>();
const boundaryReferenceByStorageKey =
  new Map<RuntimeSettingKey, RuntimeSettingBoundaryReference>();

for (const definition of runtimeSettingDefinitions) {
  const browserKey = readBrowserKey(definition.key);
  const reference: RuntimeSettingBoundaryReference = {
    browserKey,
    definition,
    storageKey: definition.key,
  };
  if (boundaryReferenceByBrowserKey.has(browserKey)) {
    throw new Error(`Duplicate browser runtime setting key: ${browserKey}.`);
  }
  boundaryReferenceByBrowserKey.set(browserKey, reference);
  boundaryReferenceByStorageKey.set(definition.key, reference);
}

export function presentRuntimeSettingField(
  definition: RuntimeSettingDefinition,
): RuntimeSettingFieldPresentation {
  const reference = readBoundaryReferenceByStorageKey(definition.key);
  if (!isMillisecondRuntimeSettingKey(definition.key)) {
    return {
      key: reference.browserKey,
      max: definition.max ?? null,
      min: definition.min ?? null,
      step: definition.step ?? null,
      unit: definition.unit ?? null,
    };
  }
  return {
    key: reference.browserKey,
    max: millisecondsToSeconds(definition.max ?? null),
    min: millisecondsToSeconds(definition.min ?? null),
    step: millisecondsToSeconds(definition.step ?? null),
    unit: "seconds",
  };
}

export function presentRuntimeSettingValue(
  settings: RuntimeSettings,
  key: RuntimeSettingKey,
): RuntimeSettingValue {
  if (isMillisecondRuntimeSettingKey(key)) {
    return millisecondsToSeconds(settings[key]);
  }
  return settings[key];
}

export function readRuntimeSettingBoundaryReference(
  value: unknown,
): RuntimeSettingBoundaryReference {
  const keyResult = z.string().min(1).safeParse(value);
  if (!keyResult.success) {
    throw new Error("Unknown runtime setting.");
  }
  const reference = boundaryReferenceByBrowserKey.get(keyResult.data);
  if (reference === undefined) {
    throw new Error("Unknown runtime setting.");
  }
  return reference;
}

export function decodeRuntimeSettingBoundaryValue(
  reference: RuntimeSettingBoundaryReference,
  value: unknown,
): RuntimeSettingValue {
  if (!isMillisecondRuntimeSettingKey(reference.storageKey)) {
    return decodeRuntimeSettingValue(reference.storageKey, value);
  }
  const secondsResult = z.number().finite().safeParse(value);
  if (!secondsResult.success) {
    throw new Error(
      `Invalid value for ${reference.definition.label}: expected a finite number of seconds.`,
    );
  }
  const unroundedMilliseconds = secondsResult.data * 1_000;
  const milliseconds = Math.round(unroundedMilliseconds);
  const roundingError = Math.abs(unroundedMilliseconds - milliseconds);
  const roundingTolerance = Number.EPSILON
    * Math.max(1, Math.abs(unroundedMilliseconds))
    * 4;
  if (!Number.isSafeInteger(milliseconds) || roundingError > roundingTolerance) {
    throw new Error(
      `Invalid value for ${reference.definition.label}: seconds must resolve to a whole number of milliseconds.`,
    );
  }
  return decodeRuntimeSettingValue(reference.storageKey, milliseconds);
}

function readBoundaryReferenceByStorageKey(
  key: RuntimeSettingKey,
): RuntimeSettingBoundaryReference {
  const reference = boundaryReferenceByStorageKey.get(key);
  if (reference === undefined) {
    throw new Error(`Runtime setting definition is missing: ${key}.`);
  }
  return reference;
}

function readBrowserKey(key: RuntimeSettingKey): string {
  if (isMillisecondRuntimeSettingKey(key)) {
    return browserKeyByMillisecondSetting[key];
  }
  return key;
}

function isMillisecondRuntimeSettingKey(
  key: RuntimeSettingKey,
): key is MillisecondRuntimeSettingKey {
  return key === "backgroundProgressIntervalMs"
    || key === "retryBaseMs"
    || key === "workerFallbackPollMs";
}

function millisecondsToSeconds(value: number): number;
function millisecondsToSeconds(value: number | null): number | null;
function millisecondsToSeconds(value: number | null): number | null {
  return value === null ? null : value / 1_000;
}
