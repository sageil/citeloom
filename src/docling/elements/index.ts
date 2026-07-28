import {
  buildDoclingDocumentIndex,
  chooseDoclingItemSectionPath,
  isDoclingHeadingLabel,
  isIndexableDoclingItem,
  readHierarchicalDoclingSectionPath,
  readOrderedDoclingItems,
} from "./document-index.js";
import { areSameDoclingStrings } from "./metadata.js";
import { createDoclingImageElement } from "./image.js";
import type { DoclingDocument } from "../protocol/index.js";
import { createDoclingTableElement } from "./table.js";
import {
  createDoclingTextAccumulator,
  createDoclingTextElement,
  type DoclingTextAccumulator,
  exceedsDoclingTextChunkLimit,
  formatDoclingTextItem,
  readDoclingTextAccumulatorLength,
  splitLongDoclingText,
} from "./text.js";
import {
  DoclingElementProcessingError,
  DoclingNormalizationError,
} from "./errors.js";
import type { SourceElement } from "../../domain/source-elements.js";

export { createStandaloneDoclingImageElement } from "./image.js";
export {
  DoclingElementProcessingError,
  DoclingNormalizationError,
} from "./errors.js";

export async function createDoclingElements(
  document: DoclingDocument,
  documentId: string,
  sourceFile: string,
): Promise<SourceElement[]> {
  let elements: SourceElement[];
  try {
    elements = await createDoclingElementsAllowingEmpty(
      document,
      documentId,
      sourceFile,
    );
  } catch (error: unknown) {
    if (
      error instanceof DoclingElementProcessingError
      || error instanceof DoclingNormalizationError
    ) {
      throw error;
    }
    throw new DoclingNormalizationError(error);
  }
  if (elements.length === 0) {
    throw new DoclingNormalizationError(
      new Error("Docling returned no indexable document elements."),
    );
  }
  return elements;
}

export async function createDoclingElementsAllowingEmpty(
  document: DoclingDocument,
  documentId: string,
  sourceFile: string,
): Promise<SourceElement[]> {
  let index: ReturnType<typeof buildDoclingDocumentIndex>;
  let orderedItems: ReturnType<typeof readOrderedDoclingItems>;
  try {
    index = buildDoclingDocumentIndex(document);
    orderedItems = readOrderedDoclingItems(document.body, index);
  } catch (error: unknown) {
    throw new DoclingNormalizationError(error);
  }
  const elements: SourceElement[] = [];
  let sectionPath: string[] = [];
  let accumulator: DoclingTextAccumulator | null = null;

  const flushText = (): void => {
    if (accumulator === null) {
      return;
    }
    const content = accumulator.parts.join("\n\n").trim();
    if (content !== "") {
      const element = createDoclingTextElement({
        content,
        detectedTypes: accumulator.detectedTypes,
        documentId,
        pages: index.pages,
        position: elements.length,
        provenance: accumulator.provenance,
        sectionPath: accumulator.sectionPath,
        sourceFile,
        sourceRefs: accumulator.sourceRefs,
      });
      elements.push(element);
    }
    accumulator = null;
  };

  for (const orderedItem of orderedItems) {
    if (orderedItem.kind === "text") {
      const item = orderedItem.value;
      if (!isIndexableDoclingItem(item.contentLayer, item.label)) {
        continue;
      }
      const formattedText = formatDoclingTextItem(item);
      if (formattedText === "") {
        continue;
      }
      const hierarchicalSectionPath = readHierarchicalDoclingSectionPath(
        item.selfRef,
        index,
      );
      if (isDoclingHeadingLabel(item.label)) {
        flushText();
        sectionPath = hierarchicalSectionPath.length === 0
          ? [item.text.trim()]
          : hierarchicalSectionPath;
      }
      const itemSectionPath = hierarchicalSectionPath.length === 0
        ? sectionPath
        : hierarchicalSectionPath;
      const segments = splitLongDoclingText(formattedText);
      for (const segment of segments) {
        if (
          accumulator !== null &&
          !areSameDoclingStrings(accumulator.sectionPath, itemSectionPath)
        ) {
          flushText();
        }
        if (accumulator === null) {
          accumulator = createDoclingTextAccumulator(itemSectionPath);
        }
        const currentLength = readDoclingTextAccumulatorLength(accumulator);
        if (exceedsDoclingTextChunkLimit(currentLength, segment.length)) {
          flushText();
          accumulator = createDoclingTextAccumulator(itemSectionPath);
        }
        if (!accumulator.detectedTypes.includes(item.label)) {
          accumulator.detectedTypes.push(item.label);
        }
        accumulator.parts.push(segment);
        accumulator.sourceRefs.push(item.selfRef);
        accumulator.provenance.push(...item.provenance);
      }
      continue;
    }

    flushText();
    if (!isIndexableDoclingItem(
      orderedItem.value.contentLayer,
      orderedItem.value.label,
    )) {
      continue;
    }
    if (orderedItem.kind === "table") {
      const tableSectionPath = chooseDoclingItemSectionPath(
        orderedItem.value.selfRef,
        sectionPath,
        index,
      );
      let tableElement: ReturnType<typeof createDoclingTableElement>;
      try {
        tableElement = createDoclingTableElement({
          documentId,
          index,
          item: orderedItem.value,
          position: elements.length,
          sectionPath: tableSectionPath,
          sourceFile,
        });
      } catch (error: unknown) {
        throw new DoclingElementProcessingError(
          "table",
          orderedItem.value,
          error,
        );
      }
      elements.push(tableElement);
      continue;
    }
    const pictureSectionPath = chooseDoclingItemSectionPath(
      orderedItem.value.selfRef,
      sectionPath,
      index,
    );
    let image: Awaited<ReturnType<typeof createDoclingImageElement>>;
    try {
      image = await createDoclingImageElement({
        documentId,
        index,
        item: orderedItem.value,
        position: elements.length,
        sectionPath: pictureSectionPath,
        sourceFile,
      });
    } catch (error: unknown) {
      throw new DoclingElementProcessingError(
        "image",
        orderedItem.value,
        error,
      );
    }
    elements.push(image);
  }

  flushText();
  return elements;
}
