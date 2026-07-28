import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import {
  isPlainTextFormat,
  readDocumentFormat,
  type BufferedDocumentSource,
} from "./format.js";
import { decodePlainTextDocument } from "./plain-text.js";

export async function readDocumentSource(
  documentPath: string,
  maximumBytes: number,
): Promise<BufferedDocumentSource> {
  const absolutePath = resolve(documentPath);
  const format = readDocumentFormat(absolutePath);
  const metadata = await stat(absolutePath);
  if (metadata.size <= 0) {
    throw new Error(`Document is empty: ${absolutePath}`);
  }
  if (metadata.size > maximumBytes) {
    throw new Error(
      `Document exceeds the configured ${maximumBytes} byte limit: ${absolutePath}`,
    );
  }
  const content = await readFile(absolutePath);
  if (content.byteLength !== metadata.size) {
    throw new Error(`Document changed while it was being read: ${absolutePath}`);
  }
  const documentId = createHash("sha256").update(content).digest("hex");
  const source: BufferedDocumentSource = {
    content,
    documentId,
    extension: format.extension,
    kind: "buffer",
    mediaType: format.mediaType,
    sourceFile: absolutePath,
  };
  if (isPlainTextFormat(source)) {
    decodePlainTextDocument(content, source.sourceFile);
  }
  return source;
}

export async function calculateDocumentId(documentPath: string): Promise<string> {
  const absolutePath = resolve(documentPath);
  const hash = createHash("sha256");
  await pipeline(createReadStream(absolutePath), hash);
  return hash.digest("hex");
}
