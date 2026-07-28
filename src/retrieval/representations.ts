import { createHash } from "node:crypto";

import type {
  ImageRetrievalDescription,
  RetrievalDescriptionRecord,
} from "../domain/retrieval-descriptions.js";
import type {
  ImageElement,
  SourceElement,
} from "../domain/source-elements.js";
import {
  buildRetrievalElementEmbeddingText,
  buildRetrievalWindowEmbeddingText,
  countRetrievalEmbeddingInputTokens,
  splitRetrievalContentAtTokenLimit,
  type RetrievalWindow,
} from "./windows.js";
import type {
  EmbeddingInputFormatContract,
} from "../embedding/input-format.js";
import type {
  RetrievalWindowPolicyContract,
} from "./window-policy.js";

export type RetrievalRepresentationType =
  | "exact-window"
  | "table-description"
  | "image-description";

export interface RetrievalRepresentation {
  content: string;
  documentId: string;
  embeddingContent: string;
  embeddingText: string;
  id: string;
  kind: SourceElement["kind"];
  nextRetrievalId: string | null;
  pageNumber: number | null;
  parentOrdinal: number | null;
  parentId: string;
  partOrdinal: number;
  policyFingerprint: string;
  policyId: string;
  previousRetrievalId: string | null;
  sourceFile: string;
  type: RetrievalRepresentationType;
}

export interface RetrievalRepresentationContext {
  followingText: string | null;
  precedingText: string | null;
}

export function createRetrievalRepresentations(
  elements: readonly SourceElement[],
  descriptions: readonly RetrievalDescriptionRecord[],
  windows: readonly RetrievalWindow[],
  policy: RetrievalWindowPolicyContract,
): RetrievalRepresentation[] {
  const elementsById = indexElements(elements);
  const descriptionsByParentId = indexDescriptions(descriptions);
  const representations: RetrievalRepresentation[] = [];

  for (const window of windows) {
    const element = elementsById.get(window.parentId);
    if (element === undefined) {
      throw new Error(
        `Missing parent element for retrieval window ${window.id}.`,
      );
    }
    if (
      window.policyFingerprint !== policy.fingerprint
      || window.policyId !== policy.policy.id
    ) {
      throw new Error(
        `Retrieval window ${window.id} uses a different policy.`,
      );
    }
    representations.push({
      content: window.content,
      documentId: window.documentId,
      embeddingContent: window.content,
      embeddingText: buildRetrievalWindowEmbeddingText(window, element),
      id: window.id,
      kind: window.kind,
      nextRetrievalId: window.nextWindowId,
      pageNumber: window.pageNumber,
      parentOrdinal: window.ordinal,
      parentId: window.parentId,
      partOrdinal: 0,
      policyFingerprint: window.policyFingerprint,
      policyId: window.policyId,
      previousRetrievalId: window.previousWindowId,
      sourceFile: window.sourceFile,
      type: "exact-window",
    });
  }

  for (const element of elements) {
    if (element.kind === "text") {
      if (descriptionsByParentId.has(element.id)) {
        throw new Error(
          `Ordinary text element ${element.id} has a generated description.`,
        );
      }
      continue;
    }
    const description = descriptionsByParentId.get(element.id);
    if (description === undefined) {
      throw new Error(
        `Missing retrieval description for ${element.kind} element ${element.id}.`,
      );
    }
    assertDescriptionMatchesElement(description, element);
    if (description.result.status === "omitted") {
      continue;
    }
    if (
      description.kind === "image"
      && !description.result.description.isSubstantive
    ) {
      continue;
    }
    const retrievalText = description.result.description.retrievalText;
    const type = description.kind === "table"
      ? "table-description"
      : "image-description";
    let evidenceContent = retrievalText;
    if (description.kind === "image") {
      evidenceContent = buildImageEvidenceContent(
        description.result.description,
      );
    }
    representations.push({
      content: evidenceContent,
      documentId: element.documentId,
      embeddingContent: retrievalText,
      embeddingText: buildRetrievalElementEmbeddingText(retrievalText, element),
      id: description.id,
      kind: element.kind,
      nextRetrievalId: null,
      pageNumber: element.pageNumber,
      parentOrdinal: null,
      parentId: element.id,
      partOrdinal: 0,
      policyFingerprint: policy.fingerprint,
      policyId: policy.policy.id,
      previousRetrievalId: null,
      sourceFile: element.sourceFile,
      type,
    });
  }

  return representations;
}

export function addContextToImageRetrievalRepresentations(
  representations: readonly RetrievalRepresentation[],
  elements: readonly SourceElement[],
  contexts: readonly RetrievalRepresentationContext[],
): RetrievalRepresentation[] {
  if (elements.length !== contexts.length) {
    throw new Error(
      `Cannot apply ${contexts.length} retrieval contexts to ${elements.length} elements.`,
    );
  }
  const elementsById = indexElements(elements);
  const contextsByElementId = new Map<string, RetrievalRepresentationContext>();
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index];
    const context = contexts[index];
    if (element === undefined || context === undefined) {
      throw new Error(`Missing retrieval context at element index ${index}.`);
    }
    contextsByElementId.set(element.id, context);
  }

  const contextualized: RetrievalRepresentation[] = [];
  for (const representation of representations) {
    if (representation.type !== "image-description") {
      contextualized.push(representation);
      continue;
    }
    const element = elementsById.get(representation.parentId);
    if (element === undefined || element.kind !== "image") {
      throw new Error(
        `Missing image parent for retrieval description ${representation.id}.`,
      );
    }
    const context = contextsByElementId.get(element.id);
    if (context === undefined) {
      throw new Error(
        `Missing retrieval context for image ${element.id}.`,
      );
    }
    const searchContent = buildImageSearchContent(
      representation.embeddingContent,
      element,
      context,
    );
    contextualized.push({
      ...representation,
      embeddingContent: searchContent,
      embeddingText: buildRetrievalElementEmbeddingText(searchContent, element),
    });
  }
  return contextualized;
}

export function splitRetrievalRepresentationsAtTokenLimit(
  representations: readonly RetrievalRepresentation[],
  elements: readonly SourceElement[],
  embeddingInputFormat: EmbeddingInputFormatContract,
  maximumInputTokens: number,
): RetrievalRepresentation[] {
  const elementsById = indexElements(elements);
  const split: RetrievalRepresentation[] = [];
  for (const representation of representations) {
    const element = elementsById.get(representation.parentId);
    if (element === undefined) {
      throw new Error(
        `Missing parent element for retrieval representation ${representation.id}.`,
      );
    }
    split.push(...splitRetrievalRepresentationAtTokenLimit(
      representation,
      element,
      embeddingInputFormat,
      maximumInputTokens,
    ));
  }
  return linkRetrievalRepresentationNeighbors(split);
}

export function splitRetrievalRepresentationAtTokenLimit(
  representation: RetrievalRepresentation,
  element: SourceElement,
  embeddingInputFormat: EmbeddingInputFormatContract,
  maximumInputTokens: number,
): RetrievalRepresentation[] {
  if (representation.parentId !== element.id) {
    throw new Error(
      `Retrieval representation ${representation.id} has the wrong parent element.`,
    );
  }
  const inputTokens = countRetrievalEmbeddingInputTokens(
    representation.embeddingContent,
    element,
    embeddingInputFormat,
  );
  if (inputTokens <= maximumInputTokens) {
    return [representation];
  }
  const pieces = splitRetrievalContentAtTokenLimit(
    representation.embeddingContent,
    element,
    embeddingInputFormat,
    maximumInputTokens,
  );
  if (pieces.length < 2) {
    throw new Error(
      `Oversized retrieval representation ${representation.id} did not split.`,
    );
  }
  const split: RetrievalRepresentation[] = [];
  for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex += 1) {
    const piece = pieces[pieceIndex];
    if (piece === undefined) {
      throw new Error(
        `Missing split retrieval representation piece ${pieceIndex}.`,
      );
    }
    const pieceInputTokens = countRetrievalEmbeddingInputTokens(
      piece,
      element,
      embeddingInputFormat,
    );
    if (pieceInputTokens >= inputTokens) {
      throw new Error(
        `Split retrieval representation ${representation.id} is not smaller.`,
      );
    }
    let evidenceContent = piece;
    if (representation.type === "image-description") {
      evidenceContent = representation.content;
    }
    split.push({
      ...representation,
      content: evidenceContent,
      embeddingContent: piece,
      embeddingText: buildRetrievalElementEmbeddingText(piece, element),
      id: createSplitRepresentationId(
        representation.id,
        piece,
        pieceIndex,
      ),
      nextRetrievalId: null,
      partOrdinal: pieceIndex,
      previousRetrievalId: null,
    });
  }
  return split;
}

export function linkRetrievalRepresentationNeighbors(
  representations: readonly RetrievalRepresentation[],
): RetrievalRepresentation[] {
  const exactIndexesByParent = new Map<string, number[]>();
  for (let index = 0; index < representations.length; index += 1) {
    const representation = representations[index];
    if (representation === undefined || representation.type !== "exact-window") {
      continue;
    }
    const indexes = exactIndexesByParent.get(representation.parentId) ?? [];
    indexes.push(index);
    exactIndexesByParent.set(representation.parentId, indexes);
  }
  const linked = representations.map((representation) => ({ ...representation }));
  for (const indexes of exactIndexesByParent.values()) {
    let currentParentOrdinal: number | null = null;
    let partOrdinal = 0;
    for (let position = 0; position < indexes.length; position += 1) {
      const index = indexes[position];
      if (index === undefined) {
        continue;
      }
      const representation = linked[index];
      if (representation === undefined) {
        throw new Error(`Missing exact representation at index ${index}.`);
      }
      if (representation.parentOrdinal !== currentParentOrdinal) {
        currentParentOrdinal = representation.parentOrdinal;
        partOrdinal = 0;
      }
      const previousIndex = indexes[position - 1];
      const nextIndex = indexes[position + 1];
      linked[index] = {
        ...representation,
        nextRetrievalId: nextIndex === undefined
          ? null
          : linked[nextIndex]?.id ?? null,
        partOrdinal,
        previousRetrievalId: previousIndex === undefined
          ? null
          : linked[previousIndex]?.id ?? null,
      };
      partOrdinal += 1;
    }
  }
  return linked;
}

function createSplitRepresentationId(
  originalId: string,
  content: string,
  pieceIndex: number,
): string {
  return createHash("sha256")
    .update(originalId)
    .update("\0split\0")
    .update(String(pieceIndex))
    .update("\0")
    .update(content)
    .digest("hex");
}

function buildImageEvidenceContent(
  description: ImageRetrievalDescription,
): string {
  const lines = [
    `Visual summary: ${description.retrievalText}`,
    `Image type: ${description.imageType}`,
  ];
  if (description.visibleText.length > 0) {
    lines.push("Visible text:");
    for (const text of description.visibleText) {
      lines.push(`- ${text}`);
    }
  }
  if (description.keyFacts.length > 0) {
    lines.push("Key facts:");
    for (const fact of description.keyFacts) {
      lines.push(`- ${fact}`);
    }
  }
  return lines.join("\n");
}

function buildImageSearchContent(
  imageDescription: string,
  element: ImageElement,
  context: RetrievalRepresentationContext,
): string {
  const parts = [imageDescription];
  const caption = element.caption?.trim();
  if (caption !== undefined && caption !== "") {
    parts.push(`Caption: ${caption}`);
  }
  if (context.precedingText !== null) {
    parts.push(`Preceding text:\n${context.precedingText}`);
  }
  if (context.followingText !== null) {
    parts.push(`Following text:\n${context.followingText}`);
  }
  return parts.join("\n\n");
}

function assertDescriptionMatchesElement(
  description: RetrievalDescriptionRecord,
  element: Exclude<SourceElement, { kind: "text" }>,
): void {
  if (
    description.documentId !== element.documentId
    || description.kind !== element.kind
    || description.parentId !== element.id
    || description.sourceFile !== element.sourceFile
  ) {
    throw new Error(
      `Retrieval description ${description.id} does not match its canonical element.`,
    );
  }
}

function indexElements(
  elements: readonly SourceElement[],
): Map<string, SourceElement> {
  const elementsById = new Map<string, SourceElement>();
  for (const element of elements) {
    if (elementsById.has(element.id)) {
      throw new Error(`Duplicate retrieval element ${element.id}.`);
    }
    elementsById.set(element.id, element);
  }
  return elementsById;
}

function indexDescriptions(
  descriptions: readonly RetrievalDescriptionRecord[],
): Map<string, RetrievalDescriptionRecord> {
  const descriptionsByParentId = new Map<string, RetrievalDescriptionRecord>();
  for (const description of descriptions) {
    if (descriptionsByParentId.has(description.parentId)) {
      throw new Error(
        `Duplicate retrieval description for ${description.parentId}.`,
      );
    }
    descriptionsByParentId.set(description.parentId, description);
  }
  return descriptionsByParentId;
}
