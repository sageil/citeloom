import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import type { TextElement } from "../domain/source-elements.js";
import type { DocumentSource } from "./format.js";
import { isPlainTextFormat } from "./format.js";

const MAXIMUM_TEXT_CHUNK_CHARACTERS = 2_400;
const BINARY_SIGNATURE_PREFIX_BYTES = 2_048;
const disallowedControlCharacterPattern = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/u;
const pdfSignature = Buffer.from("%PDF-");
const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);

interface BinarySignature {
  bytes: Buffer;
  label: string;
  offset: number;
}

class PlainTextContentError extends Error {}

const binarySignatures: readonly BinarySignature[] = [
  { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), label: "PNG", offset: 0 },
  { bytes: Buffer.from([0xff, 0xd8, 0xff]), label: "JPEG", offset: 0 },
  { bytes: Buffer.from("RIFF"), label: "RIFF", offset: 0 },
  { bytes: Buffer.from([0x50, 0x4b, 0x03, 0x04]), label: "ZIP", offset: 0 },
  { bytes: Buffer.from([0x50, 0x4b, 0x05, 0x06]), label: "ZIP", offset: 0 },
  { bytes: Buffer.from([0x50, 0x4b, 0x07, 0x08]), label: "ZIP", offset: 0 },
  { bytes: Buffer.from([0x1f, 0x8b]), label: "gzip", offset: 0 },
  { bytes: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), label: "ELF", offset: 0 },
  { bytes: Buffer.from([0x4d, 0x5a]), label: "executable", offset: 0 },
  {
    bytes: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    label: "compound binary",
    offset: 0,
  },
];

export function decodePlainTextDocument(content: Buffer, sourceFile: string): string {
  const binaryType = readBinarySignature(content);
  if (binaryType !== null) {
    throw new Error(
      `Plain-text candidate contains ${binaryType} binary content: ${sourceFile}`,
    );
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error: unknown) {
    throw new Error(`Plain-text candidate is not valid UTF-8: ${sourceFile}`, {
      cause: error,
    });
  }
  if (text.startsWith("\uFEFF")) {
    text = text.slice(1);
  }
  if (disallowedControlCharacterPattern.test(text)) {
    throw new Error(
      `Plain-text candidate contains disallowed control characters: ${sourceFile}`,
    );
  }
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (normalized === "") {
    throw new Error(`Plain-text candidate contains no readable text: ${sourceFile}`);
  }
  return normalized;
}

export async function createPlainTextElements(
  source: DocumentSource,
  abortSignal?: AbortSignal,
): Promise<TextElement[]> {
  if (!isPlainTextFormat(source)) {
    throw new Error(`Document is not a plain-text source: ${source.sourceFile}`);
  }
  let chunks: string[];
  if (source.kind === "buffer") {
    const actualDocumentId = createHash("sha256")
      .update(source.content)
      .digest("hex");
    if (actualDocumentId !== source.documentId) {
      throw new Error(
        `Stored document content does not match document id ${source.documentId}.`,
      );
    }
    const text = decodePlainTextDocument(source.content, source.sourceFile);
    chunks = splitPlainTextDocument(text);
  } else {
    chunks = await readPlainTextChunks(source, abortSignal);
  }

  const elements: TextElement[] = [];
  for (let position = 0; position < chunks.length; position += 1) {
    const content = chunks[position];
    if (content === undefined) {
      continue;
    }
    const sourceRef = `plain-text/chunk/${position + 1}`;
    const id = createHash("sha256")
      .update(source.documentId)
      .update("\0")
      .update(sourceRef)
      .update("\0")
      .update(content)
      .digest("hex");
    elements.push({
      content,
      detectedTypes: ["plain_text"],
      documentId: source.documentId,
      id,
      kind: "text",
      pageNumber: null,
      pageNumbers: [],
      regions: [],
      sectionPath: [],
      sourceFile: source.sourceFile,
      sourceRefs: [sourceRef],
    });
  }
  return elements;
}

async function readPlainTextChunks(
  source: DocumentSource & { kind: "file" },
  abortSignal?: AbortSignal,
): Promise<string[]> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const hash = createHash("sha256");
  const parser = new StreamingPlainTextParser(source.sourceFile);
  let prefix = Buffer.alloc(0);
  const stream = await source.openContent(abortSignal);
  try {
    for await (const value of stream) {
      const content = Buffer.isBuffer(value) ? value : Buffer.from(value);
      hash.update(content);
      if (prefix.byteLength < BINARY_SIGNATURE_PREFIX_BYTES) {
        const remaining = BINARY_SIGNATURE_PREFIX_BYTES - prefix.byteLength;
        prefix = Buffer.concat([prefix, content.subarray(0, remaining)]);
      }
      requirePlainTextPrefix(prefix, source.sourceFile);
      parser.write(decoder.decode(content, { stream: true }));
    }
    parser.write(decoder.decode());
  } catch (error: unknown) {
    if (abortSignal?.aborted === true) {
      throw abortSignal.reason;
    }
    if (error instanceof PlainTextContentError) {
      throw error;
    }
    if (error instanceof TypeError) {
      throw new Error(
        `Plain-text candidate is not valid UTF-8: ${source.sourceFile}`,
        { cause: error },
      );
    }
    throw new Error(`Could not read plain text from ${source.sourceFile}.`, {
      cause: error,
    });
  }
  requirePlainTextPrefix(prefix, source.sourceFile);
  const actualDocumentId = hash.digest("hex");
  if (actualDocumentId !== source.documentId) {
    throw new Error(
      `Stored document content does not match document id ${source.documentId}.`,
    );
  }
  return parser.finish();
}

function requirePlainTextPrefix(prefix: Buffer, sourceFile: string): void {
  const binaryType = readBinarySignature(prefix);
  if (binaryType !== null) {
    throw new PlainTextContentError(
      `Plain-text candidate contains ${binaryType} binary content: ${sourceFile}`,
    );
  }
}

class StreamingPlainTextParser {
  private atStart = true;
  private currentChunk = "";
  private lineContainsText = false;
  private pendingCarriageReturn = false;
  private pendingLineWhitespace = "";
  private pendingNewline = false;
  private paragraph = "";
  private readonly chunks: string[] = [];

  public constructor(private readonly sourceFile: string) {}

  public write(value: string): void {
    let decoded = value;
    if (this.atStart) {
      this.atStart = false;
      if (decoded.startsWith("\uFEFF")) {
        decoded = decoded.slice(1);
      }
    }
    if (disallowedControlCharacterPattern.test(decoded)) {
      throw new PlainTextContentError(
        `Plain-text candidate contains disallowed control characters: ${this.sourceFile}`,
      );
    }
    if (this.pendingCarriageReturn) {
      decoded = `\r${decoded}`;
      this.pendingCarriageReturn = false;
    }
    if (decoded.endsWith("\r")) {
      decoded = decoded.slice(0, -1);
      this.pendingCarriageReturn = true;
    }
    const normalized = decoded.replace(/\r\n?/gu, "\n");
    let start = 0;
    while (start < normalized.length) {
      const newline = normalized.indexOf("\n", start);
      if (newline < 0) {
        this.writeLinePart(normalized.slice(start));
        return;
      }
      this.writeLinePart(normalized.slice(start, newline));
      this.finishLine();
      start = newline + 1;
    }
  }

  public finish(): string[] {
    if (this.pendingCarriageReturn) {
      this.pendingCarriageReturn = false;
      this.finishLine();
    }
    if (this.lineContainsText) {
      this.finishParagraph();
    } else {
      this.pendingLineWhitespace = "";
      this.finishParagraph();
    }
    if (this.currentChunk !== "") {
      this.chunks.push(this.currentChunk);
      this.currentChunk = "";
    }
    if (this.chunks.length === 0) {
      throw new Error(
        `Plain-text candidate contains no readable text: ${this.sourceFile}`,
      );
    }
    return this.chunks;
  }

  private writeLinePart(value: string): void {
    if (value === "") {
      return;
    }
    if (this.lineContainsText) {
      this.appendParagraphContent(value);
      return;
    }
    const firstTextIndex = value.search(/[^ \t]/u);
    if (firstTextIndex < 0) {
      this.pendingLineWhitespace += value;
      return;
    }
    this.lineContainsText = true;
    const content = this.pendingLineWhitespace + value;
    this.pendingLineWhitespace = "";
    this.appendParagraphContent(content);
  }

  private finishLine(): void {
    if (!this.lineContainsText) {
      this.pendingLineWhitespace = "";
      this.finishParagraph();
      return;
    }
    this.lineContainsText = false;
    this.pendingLineWhitespace = "";
    this.pendingNewline = true;
  }

  private appendParagraphContent(value: string): void {
    const paragraphWasEmpty = this.paragraph === "" && !this.pendingNewline;
    if (this.pendingNewline) {
      this.paragraph += "\n";
      this.pendingNewline = false;
    }
    this.paragraph += value;
    if (paragraphWasEmpty) {
      this.paragraph = this.paragraph.trimStart();
    }
    while (this.paragraph.length > MAXIMUM_TEXT_CHUNK_CHARACTERS) {
      const splitIndex = findPlainTextSplitIndex(this.paragraph);
      const segment = this.paragraph.slice(0, splitIndex).trim();
      if (segment !== "") {
        this.appendSegment(segment);
      }
      this.paragraph = this.paragraph.slice(splitIndex).trimStart();
    }
  }

  private finishParagraph(): void {
    this.pendingNewline = false;
    const segments = splitLongPlainText(this.paragraph.trim());
    for (const segment of segments) {
      this.appendSegment(segment);
    }
    this.paragraph = "";
  }

  private appendSegment(segment: string): void {
    if (this.currentChunk === "") {
      this.currentChunk = segment;
      return;
    }
    if (
      this.currentChunk.length + segment.length + 2
      <= MAXIMUM_TEXT_CHUNK_CHARACTERS
    ) {
      this.currentChunk = `${this.currentChunk}\n\n${segment}`;
      return;
    }
    this.chunks.push(this.currentChunk);
    this.currentChunk = segment;
  }
}

function readBinarySignature(content: Buffer): string | null {
  const startsWithUtf8Bom = content.subarray(0, utf8Bom.byteLength).equals(utf8Bom);
  let contentStart = startsWithUtf8Bom ? utf8Bom.byteLength : 0;
  const contentSearchLimit = Math.min(content.byteLength, contentStart + 1_024);
  while (contentStart < contentSearchLimit && isAsciiWhitespace(content[contentStart])) {
    contentStart += 1;
  }
  const pdfEnd = contentStart + pdfSignature.byteLength;
  if (
    pdfEnd <= content.byteLength
    && content.subarray(contentStart, pdfEnd).equals(pdfSignature)
  ) {
    return "PDF";
  }
  for (const signature of binarySignatures) {
    const end = signature.offset + signature.bytes.byteLength;
    if (
      end <= content.byteLength
      && content.subarray(signature.offset, end).equals(signature.bytes)
    ) {
      return signature.label;
    }
    const bomOffset = signature.offset + 3;
    const bomEnd = bomOffset + signature.bytes.byteLength;
    if (
      startsWithUtf8Bom
      && bomEnd <= content.byteLength
      && content.subarray(bomOffset, bomEnd).equals(signature.bytes)
    ) {
      return signature.label;
    }
  }
  return null;
}

function isAsciiWhitespace(value: number | undefined): boolean {
  return value === 0x09
    || value === 0x0a
    || value === 0x0c
    || value === 0x0d
    || value === 0x20;
}

function splitPlainTextDocument(text: string): string[] {
  const chunks: string[] = [];
  let current = "";
  const paragraphs = text.split(/\n[ \t]*\n+/u);
  for (const paragraph of paragraphs) {
    const segments = splitLongPlainText(paragraph.trim());
    for (const segment of segments) {
      if (current === "") {
        current = segment;
        continue;
      }
      if (current.length + segment.length + 2 <= MAXIMUM_TEXT_CHUNK_CHARACTERS) {
        current = `${current}\n\n${segment}`;
        continue;
      }
      chunks.push(current);
      current = segment;
    }
  }
  if (current !== "") {
    chunks.push(current);
  }
  return chunks;
}

function splitLongPlainText(content: string): string[] {
  const segments: string[] = [];
  let remaining = content;
  while (remaining.length > MAXIMUM_TEXT_CHUNK_CHARACTERS) {
    const splitIndex = findPlainTextSplitIndex(remaining);
    const segment = remaining.slice(0, splitIndex).trim();
    if (segment !== "") {
      segments.push(segment);
    }
    remaining = remaining.slice(splitIndex).trimStart();
  }
  if (remaining !== "") {
    segments.push(remaining);
  }
  return segments;
}

function findPlainTextSplitIndex(content: string): number {
  const newlineIndex = content.lastIndexOf("\n", MAXIMUM_TEXT_CHUNK_CHARACTERS);
  const spaceIndex = content.lastIndexOf(" ", MAXIMUM_TEXT_CHUNK_CHARACTERS);
  const candidate = Math.max(newlineIndex, spaceIndex);
  if (candidate >= MAXIMUM_TEXT_CHUNK_CHARACTERS / 2) {
    return candidate;
  }
  const previousCodeUnit = content.charCodeAt(MAXIMUM_TEXT_CHUNK_CHARACTERS - 1);
  const nextCodeUnit = content.charCodeAt(MAXIMUM_TEXT_CHUNK_CHARACTERS);
  const splitsSurrogatePair = previousCodeUnit >= 0xd800
    && previousCodeUnit <= 0xdbff
    && nextCodeUnit >= 0xdc00
    && nextCodeUnit <= 0xdfff;
  return splitsSurrogatePair
    ? MAXIMUM_TEXT_CHUNK_CHARACTERS - 1
    : MAXIMUM_TEXT_CHUNK_CHARACTERS;
}
