import type { ZodError } from "zod";

import {
  DOCLING_SERVE_VERSION,
  DOCLING_VERSION,
} from "./model.js";
import type {
  DoclingConversionError,
  DoclingConversionResult,
  DoclingVersionIdentity,
} from "./model.js";
import type { DoclingProfilingSummary } from "./run-metadata.js";
import { normalizeDoclingDocument } from "./response-normalizer.js";
import {
  conversionResponseSchema,
  versionResponseSchema,
} from "./response-boundary.js";
import type { RawConversionError } from "./response-boundary.js";

export class DoclingConversionResponseError extends Error {
  public constructor(
    message: string,
    public readonly conversionErrors: DoclingConversionError[],
    public readonly status: string | null,
  ) {
    super(message);
    this.name = "DoclingConversionResponseError";
  }
}

export function decodeDoclingConversionResponse(
  value: unknown,
): DoclingConversionResult {
  const result = conversionResponseSchema.safeParse(value);
  if (!result.success) {
    throw new DoclingConversionResponseError(
      `Invalid Docling response: ${formatFirstIssue(result.error)}`,
      [],
      null,
    );
  }
  const conversionErrors = normalizeConversionErrors(result.data.errors);
  if (result.data.status !== "success") {
    throw new DoclingConversionResponseError(
      formatConversionFailureMessage(
        result.data.status,
        conversionErrors.length,
      ),
      conversionErrors,
      result.data.status,
    );
  }
  if (conversionErrors.length > 0) {
    throw new DoclingConversionResponseError(
      `Docling conversion reported ${conversionErrors.length} error(s) despite a success status.`,
      conversionErrors,
      result.data.status,
    );
  }
  if (result.data.document.json_content === null) {
    throw new DoclingConversionResponseError(
      "Docling conversion returned no JSON document.",
      [],
      result.data.status,
    );
  }
  if (
    result.data.document.json_content.key_value_items.length > 0 ||
    result.data.document.json_content.form_items.length > 0
  ) {
    throw new DoclingConversionResponseError(
      "Docling returned form or key-value items that the current indexing model cannot represent safely.",
      [],
      result.data.status,
    );
  }

  return {
    document: normalizeDoclingDocument(result.data.document.json_content),
    filename: result.data.document.filename,
    processingTimeMs: Math.round(result.data.processing_time * 1_000),
    profiling: summarizeProfiling(result.data.timings),
  };
}

function summarizeProfiling(
  timings: Record<string, { count: number; scope: "document" | "page"; times: number[] }>,
): DoclingProfilingSummary[] {
  const summaries: DoclingProfilingSummary[] = [];
  const stageNames = Object.keys(timings).sort((left, right) => {
    return left.localeCompare(right);
  });
  for (const stage of stageNames) {
    const item = timings[stage];
    if (item === undefined || item.times.length === 0) {
      continue;
    }
    const durationsMs = item.times
      .map((seconds) => seconds * 1_000)
      .sort((left, right) => left - right);
    summaries.push({
      count: item.count,
      maximumDurationMs: roundDuration(readPercentile(durationsMs, 1)),
      medianDurationMs: roundDuration(readPercentile(durationsMs, 0.5)),
      minimumDurationMs: roundDuration(readPercentile(durationsMs, 0)),
      p95DurationMs: roundDuration(readPercentile(durationsMs, 0.95)),
      scope: item.scope,
      stage,
      totalDurationMs: roundDuration(
        durationsMs.reduce((total, duration) => total + duration, 0),
      ),
    });
  }
  return summaries;
}

function readPercentile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) {
    throw new Error("Cannot calculate a percentile without values.");
  }
  const index = Math.ceil(percentile * sortedValues.length) - 1;
  return sortedValues[Math.max(0, index)] ?? sortedValues[0] ?? 0;
}

function roundDuration(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

export function decodeDoclingVersion(value: unknown): DoclingVersionIdentity {
  const result = versionResponseSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Docling version mismatch: expected Docling Serve ${DOCLING_SERVE_VERSION} with Docling ${DOCLING_VERSION}.`,
    );
  }
  return {
    coreVersion: result.data["docling-core"],
    jobkitVersion: result.data["docling-jobkit"],
    modelsVersion: result.data["docling-ibm-models"],
    parseVersion: result.data["docling-parse"],
    serveVersion: result.data["docling-serve"],
    version: result.data.docling,
  };
}

function normalizeConversionErrors(
  errors: RawConversionError[],
): DoclingConversionError[] {
  const details: DoclingConversionError[] = [];
  for (const error of errors) {
    details.push({
      category: error.category,
      componentType: error.component_type,
      message: error.error_message,
      moduleName: error.module_name,
      pageNumber: error.page_no,
    });
  }
  return details;
}

function formatConversionFailureMessage(
  status: string,
  errorCount: number,
): string {
  if (errorCount === 0) {
    return `Docling conversion ended with ${status} without structured error detail.`;
  }
  return `Docling conversion ended with ${status} and reported ${errorCount} structured error(s).`;
}

function formatFirstIssue(error: ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return "unknown response error";
  }
  const path = issue.path.length === 0 ? "response" : issue.path.join(".");
  return `${path}: ${issue.message}`;
}
