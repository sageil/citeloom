import type { DoclingConfig } from "../../config/index.js";
import {
  readDocumentSourceByteLength,
  type FileDocumentSource,
} from "../../documents/format.js";

const MEBIBYTE_BYTES = 1_024 * 1_024;

export interface DoclingConversionDeadline {
  byteLength: number;
  pageCount: number | null;
  processingTimeoutMs: number;
  taskTimeoutMs: number;
}

export async function calculateDoclingConversionDeadline(
  source: FileDocumentSource,
  config: DoclingConfig,
): Promise<DoclingConversionDeadline> {
  const pageCount = null;
  const byteLength = readDocumentSourceByteLength(source);
  const mebibytes = Math.ceil(byteLength / MEBIBYTE_BYTES);
  const sizeBudgetMs = mebibytes * config.megabyteTimeoutMs;
  const requestedTimeoutMs = config.baseTimeoutMs + sizeBudgetMs;
  const processingTimeoutMs = source.extension === ".pdf"
    ? config.maxTimeoutMs
    : Math.min(requestedTimeoutMs, config.maxTimeoutMs);
  return {
    byteLength,
    pageCount,
    processingTimeoutMs,
    taskTimeoutMs: config.maxTimeoutMs,
  };
}
