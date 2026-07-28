import {
  createDoclingElementId,
  createDoclingSourceLocation,
  uniqueDoclingStrings,
} from "./metadata.js";
import type {
  DoclingPage,
  DoclingProvenance,
  DoclingTextItem,
} from "../protocol/index.js";
import type { TextElement } from "../../domain/source-elements.js";

const MAX_TEXT_CHUNK_CHARACTERS = 2_400;

export interface DoclingTextAccumulator {
  detectedTypes: string[];
  parts: string[];
  provenance: DoclingProvenance[];
  sectionPath: string[];
  sourceRefs: string[];
}

export interface CreateDoclingTextElementRequest {
  content: string;
  detectedTypes: string[];
  documentId: string;
  pages: Map<number, DoclingPage>;
  position: number;
  provenance: DoclingProvenance[];
  sectionPath: string[];
  sourceFile: string;
  sourceRefs: string[];
}

export function formatDoclingTextItem(item: DoclingTextItem): string {
  const text = item.text.trim();
  if (text === "") {
    return "";
  }
  if (item.label === "list_item") {
    return `- ${text}`;
  }
  if (item.label === "code") {
    return `\`\`\`\n${text}\n\`\`\``;
  }
  if (item.label === "formula") {
    return `Formula: ${text}`;
  }
  return text;
}

export function createDoclingTextAccumulator(
  sectionPath: string[],
): DoclingTextAccumulator {
  return {
    detectedTypes: [],
    parts: [],
    provenance: [],
    sectionPath: [...sectionPath],
    sourceRefs: [],
  };
}

export function readDoclingTextAccumulatorLength(
  accumulator: DoclingTextAccumulator,
): number {
  let length = 0;
  for (const part of accumulator.parts) {
    length += part.length;
  }
  if (accumulator.parts.length > 1) {
    length += (accumulator.parts.length - 1) * 2;
  }
  return length;
}

export function exceedsDoclingTextChunkLimit(
  currentLength: number,
  segmentLength: number,
): boolean {
  return currentLength > 0 &&
    currentLength + segmentLength + 2 > MAX_TEXT_CHUNK_CHARACTERS;
}

export function splitLongDoclingText(content: string): string[] {
  const segments: string[] = [];
  let remaining = content.trim();
  while (remaining.length > MAX_TEXT_CHUNK_CHARACTERS) {
    const splitIndex = findTextSplitIndex(remaining);
    segments.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trimStart();
  }
  if (remaining !== "") {
    segments.push(remaining);
  }
  return segments;
}

export function createDoclingTextElement(
  request: CreateDoclingTextElementRequest,
): TextElement {
  const normalizedSourceRefs = uniqueDoclingStrings(request.sourceRefs);
  return {
    content: request.content,
    detectedTypes: uniqueDoclingStrings(request.detectedTypes),
    documentId: request.documentId,
    id: createDoclingElementId(
      request.documentId,
      "text",
      normalizedSourceRefs,
      request.content,
      request.position,
    ),
    kind: "text",
    ...createDoclingSourceLocation(request.provenance, request.pages),
    sectionPath: [...request.sectionPath],
    sourceFile: request.sourceFile,
    sourceRefs: normalizedSourceRefs,
  };
}

function findTextSplitIndex(content: string): number {
  const newlineIndex = content.lastIndexOf("\n", MAX_TEXT_CHUNK_CHARACTERS);
  const spaceIndex = content.lastIndexOf(" ", MAX_TEXT_CHUNK_CHARACTERS);
  const candidate = Math.max(newlineIndex, spaceIndex);
  if (candidate >= MAX_TEXT_CHUNK_CHARACTERS / 2) {
    return candidate;
  }
  return MAX_TEXT_CHUNK_CHARACTERS;
}
