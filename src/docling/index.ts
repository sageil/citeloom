import {
  DoclingTaskResultError,
  DoclingTaskTerminalError,
  type DoclingConvertRequester,
  sendDoclingConvertRequest,
} from "./client/index.js";
import type { DoclingConfig } from "../config/index.js";
import {
  requestDoclingConversion,
  buildDoclingConversionOptions,
} from "./client/conversion-request.js";
import {
  createDoclingElements,
  createDoclingElementsAllowingEmpty,
  createStandaloneDoclingImageElement,
  DoclingElementProcessingError,
  DoclingNormalizationError,
} from "./elements/index.js";
import {
  DoclingConversionResponseError,
  stripDoclingImages,
  type DoclingErrorDetail,
  type DoclingConversionResult,
  type DoclingVersionIdentity,
  type StoredDoclingArtifact,
} from "./protocol/index.js";
import type { FileDocumentSource } from "../documents/format.js";
import {
  ephemeralDoclingTaskControlFactory,
  type DoclingTaskControlFactory,
} from "./client/task.js";
import {
  noOpDoclingConversionObserver,
  type DoclingConversionObserver,
} from "./client/observer.js";
import type { SourceElement } from "../domain/source-elements.js";
import {
  isStandaloneImageFormat,
} from "../documents/format.js";

export {
  checkDoclingServiceAvailability,
  completeDoclingAsyncConversion,
  DoclingTaskTerminationError,
  isDoclingTaskDeadlineFailure,
  pauseDoclingTask,
  readDoclingServiceCapabilities,
  readDoclingServiceIdentity,
  terminateDoclingTask,
  uploadDoclingContent,
  readDoclingErrorCategory,
  type DoclingConvertRequest,
  type DoclingConvertRequester,
  type DoclingHttpRequest,
  type DoclingHttpRequester,
  type DoclingJsonRequest,
  type DoclingJsonRequester,
  type DoclingReconnectWaiter,
  type DoclingSubmissionPreparer,
  type DoclingTaskTerminationRequest,
  type DoclingTaskPauseResult,
  type DoclingTaskRecoveryMode,
  type DoclingWebSocketConnection,
  type DoclingWebSocketConnector,
  type DoclingWebSocketReceiveResult,
  verifyDoclingService,
} from "./client/index.js";
export {
  createDoclingElements,
  createDoclingElementsAllowingEmpty,
} from "./elements/index.js";
export {
  calculateDocumentId,
  readDocumentSource,
} from "../documents/source-reader.js";

const passiveAbortSignal = new AbortController().signal;

export interface PartitionResult {
  documentId: string;
  elements: SourceElement[];
}

export interface DoclingPartitionResult extends PartitionResult {
  artifact: StoredDoclingArtifact;
  availablePageImages: number[];
  embeddedPictureRefs: string[];
  pageCount: number | null;
}

export interface DoclingFailureContext {
  errors: DoclingErrorDetail[];
  origin:
    | "docling-conversion"
    | "docling-element"
    | "docling-normalization"
    | "docling-task"
    | "docling-transport";
  requestId: string | null;
  requestSequence: number | null;
  retryable: boolean | null;
  taskId: string | null;
}

export function readDoclingFailureContext(
  error: unknown,
): DoclingFailureContext {
  const pending: unknown[] = [error];
  const visited = new Set<Error>();
  while (pending.length > 0 && visited.size < 16) {
    const current = pending.pop();
    if (!(current instanceof Error) || visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (current instanceof DoclingTaskResultError) {
      return {
        errors: current.conversionErrors,
        origin: "docling-conversion",
        requestId: current.requestId,
        requestSequence: current.requestSequence,
        retryable: null,
        taskId: current.taskId,
      };
    }
    if (current instanceof DoclingTaskTerminalError) {
      return {
        errors: current.conversionErrors,
        origin: "docling-task",
        requestId: current.requestId,
        requestSequence: current.requestSequence,
        retryable: current.retryable,
        taskId: current.taskId,
      };
    }
    if (current instanceof DoclingElementProcessingError) {
      return {
        errors: current.conversionErrors,
        origin: "docling-element",
        requestId: null,
        requestSequence: null,
        retryable: false,
        taskId: null,
      };
    }
    if (current instanceof DoclingNormalizationError) {
      return {
        errors: current.conversionErrors,
        origin: "docling-normalization",
        requestId: null,
        requestSequence: null,
        retryable: false,
        taskId: null,
      };
    }
    if (current instanceof DoclingConversionResponseError) {
      const details: DoclingErrorDetail[] = [];
      for (const conversionError of current.conversionErrors) {
        details.push({
          ...conversionError,
          doclingLabel: null,
          elementKind: null,
          pageRangeEnd: null,
          pageRangeStart: null,
          sourceRef: null,
        });
      }
      return {
        errors: details,
        origin: "docling-conversion",
        requestId: null,
        requestSequence: null,
        retryable: null,
        taskId: null,
      };
    }
    if (current.cause !== undefined) {
      pending.push(current.cause);
    }
    if (current instanceof AggregateError) {
      pending.push(...current.errors);
    }
  }
  return {
    errors: [],
    origin: "docling-transport",
    requestId: null,
    requestSequence: null,
    retryable: null,
    taskId: null,
  };
}

export async function partitionDocumentContents(
  source: FileDocumentSource,
  config: DoclingConfig,
  version: DoclingVersionIdentity,
  requester: DoclingConvertRequester = sendDoclingConvertRequest,
  abortSignal: AbortSignal = passiveAbortSignal,
  taskControls: DoclingTaskControlFactory = ephemeralDoclingTaskControlFactory,
  observer: DoclingConversionObserver = noOpDoclingConversionObserver,
): Promise<DoclingPartitionResult> {
  abortSignal.throwIfAborted();
  const standaloneImage = isStandaloneImageFormat(source);
  const contentTaskControl = await taskControls.open("content");
  const requestResult = await requestDoclingConversion({
    abortSignal,
    config,
    observer,
    options: buildDoclingConversionOptions(config, source),
    requestKey: "content",
    requester,
    source,
    taskControl: contentTaskControl,
  });
  abortSignal.throwIfAborted();
  const conversion = requestResult.conversion;
  await requestResult.requestObserver.observe({
    at: new Date(),
    kind: "conversion-decoded",
    processingMs: conversion.processingTimeMs,
    profiling: conversion.profiling,
  });
  let elements: SourceElement[];
  if (!standaloneImage) {
    elements = await createDoclingElements(
      conversion.document,
      source.documentId,
      source.sourceFile,
    );
  } else {
    const page = readStandaloneImagePage(
      conversion.document.pages,
      source.sourceFile,
    );
    const doclingElements = await createDoclingElementsAllowingEmpty(
      conversion.document,
      source.documentId,
      source.sourceFile,
    );
    elements = [
      createStandaloneDoclingImageElement(
        source.documentId,
        page,
        source.sourceFile,
      ),
      ...doclingElements,
    ];
  }
  abortSignal.throwIfAborted();
  return {
    artifact: {
      document: stripDoclingImages(conversion.document),
      documentId: source.documentId,
      processingTimeMs: conversion.processingTimeMs,
      version,
    },
    availablePageImages: conversion.document.pages
      .filter((page) => page.image !== null)
      .map((page) => page.pageNumber),
    documentId: source.documentId,
    elements,
    embeddedPictureRefs: conversion.document.pictures
      .filter((picture) => picture.image !== null)
      .map((picture) => picture.selfRef),
    pageCount: readDocumentLocationCount(
      source,
      requestResult.pageCount,
      conversion.document.pages.length,
      standaloneImage,
    ),
  };
}

function readStandaloneImagePage(
  pages: DoclingConversionResult["document"]["pages"],
  sourceFile: string,
): DoclingConversionResult["document"]["pages"][number] {
  const page = pages[0];
  if (pages.length !== 1 || page === undefined || page.pageNumber !== 1) {
    throw new Error(
      `Docling returned ${pages.length} pages for standalone image ${sourceFile}.`,
    );
  }
  if (page.image === null) {
    throw new Error(
      `Docling returned no full-image evidence for ${sourceFile}.`,
    );
  }
  return page;
}

function readDocumentLocationCount(
  source: FileDocumentSource,
  sourcePageCount: number | null,
  doclingPageCount: number,
  standaloneImage: boolean,
): number | null {
  if (standaloneImage) {
    return 1;
  }
  if (source.extension === ".pdf") {
    if (doclingPageCount <= 0) {
      throw new Error(`Docling returned no PDF pages for ${source.sourceFile}.`);
    }
    return sourcePageCount ?? doclingPageCount;
  }
  if (source.extension !== ".xlsx" && source.extension !== ".pptx") {
    return sourcePageCount;
  }
  if (doclingPageCount <= 0) {
    const location = source.extension === ".xlsx" ? "worksheets" : "slides";
    throw new Error(`Docling returned no ${location} for ${source.sourceFile}.`);
  }
  return doclingPageCount;
}
