import { createHash } from "node:crypto";

import {
  generateText,
  NoOutputGeneratedError,
  type FilePart,
} from "ai";

import type {
  ImageElement,
  SourceElement,
  TableElement,
} from "../domain/source-elements.js";
import {
  imageRetrievalDescriptionSchema,
  type ImageRetrievalDescription,
  type ImageRetrievalDescriptionRecord,
  tableRetrievalDescriptionSchema,
  type RetrievalDescriptionRecord,
  type TableRetrievalDescription,
  type TableRetrievalDescriptionRecord,
} from "../domain/retrieval-descriptions.js";
import type { InferenceModelRegistry } from "../inference/registry.js";
import {
  createInferenceRequestSignal,
  throwInferenceRequestFailure,
} from "../inference/request.js";
import {
  createInferenceTelemetryOptions,
  MAX_SOURCE_CHARACTERS,
} from "../inference/shared.js";
import { createStructuredOutput } from "../inference/structured-output.js";
import type { TaskScheduler } from "../shared/concurrency.js";
import {
  IMAGE_RETRIEVAL_DESCRIPTION_SYSTEM_PROMPT,
  TABLE_RETRIEVAL_DESCRIPTION_SYSTEM_PROMPT,
} from "./retrieval-description-prompts.js";

// This namespace is a fixed part of the persisted fingerprint algorithm.
// Prompt and schema changes must not alter it.
const RETRIEVAL_DESCRIPTION_INPUT_FINGERPRINT_NAMESPACE =
  "citeloom/retrieval-description:v1";

const MAX_NEARBY_TEXT_CHARACTERS = 2_000;
const passiveAbortSignal = new AbortController().signal;

export interface RetrievalDescriptionContext {
  followingText: string | null;
  precedingText: string | null;
}

export function isDescribableElement(
  element: SourceElement,
): element is ImageElement | TableElement {
  return element.kind === "image" || element.kind === "table";
}

export function createRetrievalDescriptionContext(
  elements: readonly SourceElement[],
  index: number,
): RetrievalDescriptionContext {
  const element = elements[index];
  if (element === undefined) {
    throw new Error(`Missing source element at position ${index}.`);
  }
  return {
    followingText: readAdjacentText(elements, index, 1, element),
    precedingText: readAdjacentText(elements, index, -1, element),
  };
}

export async function describeRetrievalElement(
  models: InferenceModelRegistry,
  element: ImageElement | TableElement,
  context: RetrievalDescriptionContext,
  scheduler: TaskScheduler,
  abortSignal: AbortSignal = passiveAbortSignal,
): Promise<RetrievalDescriptionRecord> {
  abortSignal.throwIfAborted();
  if (element.kind === "table") {
    return describeTable(models, element, context, scheduler, abortSignal);
  }
  return describeImage(models, element, scheduler, abortSignal);
}

export function doesRetrievalDescriptionMatchElement(
  description: RetrievalDescriptionRecord,
  element: ImageElement | TableElement,
  context: RetrievalDescriptionContext,
): boolean {
  const inputFingerprint =
    createRetrievalDescriptionInputFingerprint(element, context);
  return description.inputFingerprint === inputFingerprint
    && description.documentId === element.documentId
    && description.kind === element.kind
    && description.pageNumber === element.pageNumber
    && description.parentId === element.id
    && description.sourceFile === element.sourceFile
    && areNumberArraysEqual(description.pageNumbers, element.pageNumbers)
    && areSourceRegionsEqual(description.regions, element.regions)
    && areStringArraysEqual(description.sectionPath, element.sectionPath)
    && areStringArraysEqual(description.sourceRefs, element.sourceRefs);
}

export function createRetrievalDescriptionInputFingerprint(
  element: ImageElement | TableElement,
  context: RetrievalDescriptionContext,
): string {
  if (element.kind === "image") {
    return createImageDescriptionInputFingerprint(element);
  }
  return createTableDescriptionInputFingerprint(element, context);
}

function createImageDescriptionInputFingerprint(
  element: ImageElement,
): string {
  return createHash("sha256")
    .update(RETRIEVAL_DESCRIPTION_INPUT_FINGERPRINT_NAMESPACE)
    .update("\0")
    .update(element.kind)
    .update("\0")
    .update(element.mimeType)
    .update("\0")
    .update(element.content)
    .digest("hex");
}

function createTableDescriptionInputFingerprint(
  element: TableElement,
  context: RetrievalDescriptionContext,
): string {
  return createHash("sha256")
    .update(RETRIEVAL_DESCRIPTION_INPUT_FINGERPRINT_NAMESPACE)
    .update("\0")
    .update(element.kind)
    .update("\0")
    .update(element.id)
    .update("\0")
    .update(element.caption ?? "")
    .update("\0")
    .update(element.detectedType)
    .update("\0")
    .update(element.sectionPath.join("\0"))
    .update("\0")
    .update(context.precedingText ?? "")
    .update("\0")
    .update(context.followingText ?? "")
    .update("\0")
    .update(element.content)
    .digest("hex");
}

async function describeTable(
  models: InferenceModelRegistry,
  element: TableElement,
  context: RetrievalDescriptionContext,
  scheduler: TaskScheduler,
  abortSignal: AbortSignal,
): Promise<TableRetrievalDescriptionRecord> {
  const prompt = buildTablePrompt(element, context);
  if (prompt.length > MAX_SOURCE_CHARACTERS) {
    return createTableRecord(element, context, {
      reason:
        `The complete table exceeds the ${MAX_SOURCE_CHARACTERS} character description input boundary.`,
      status: "omitted",
    });
  }
  const description = await scheduler.run(
    (requestSignal) => requestTableDescription(models, prompt, requestSignal),
    abortSignal,
  );
  return createTableRecord(element, context, {
    description,
    status: "described",
  });
}

async function describeImage(
  models: InferenceModelRegistry,
  element: ImageElement,
  scheduler: TaskScheduler,
  abortSignal: AbortSignal,
): Promise<ImageRetrievalDescriptionRecord> {
  const description = await scheduler.run(
    (requestSignal) => requestImageDescription(
      models,
      element,
      requestSignal,
    ),
    abortSignal,
  );
  return createImageRecord(element, {
    description,
    status: "described",
  });
}

async function requestTableDescription(
  models: InferenceModelRegistry,
  prompt: string,
  abortSignal: AbortSignal,
): Promise<TableRetrievalDescription> {
  const result = await requestDescription<TableRetrievalDescription>(
    models,
    "describe-table",
    "citeloom.describe-table",
    abortSignal,
    (requestSignal) => generateText({
      abortSignal: requestSignal,
      maxRetries: 1,
      model: models.indexing,
      output: createStructuredOutput({
        description:
          "A concise, factual, self-contained table description for semantic and keyword retrieval.",
        name: "table_retrieval_description",
        schema: tableRetrievalDescriptionSchema,
        validation: "local",
      }),
      prompt,
      system: TABLE_RETRIEVAL_DESCRIPTION_SYSTEM_PROMPT,
      telemetry: createInferenceTelemetryOptions(
        models,
        "citeloom.describe-table",
      ),
    }),
  );
  return result;
}

async function requestImageDescription(
  models: InferenceModelRegistry,
  element: ImageElement,
  abortSignal: AbortSignal,
): Promise<ImageRetrievalDescription> {
  const content: FilePart[] = [{
    data: Buffer.from(element.content, "base64"),
    filename: "document-image",
    mediaType: element.mimeType,
    type: "file",
  }];
  return requestDescription<ImageRetrievalDescription>(
    models,
    "describe-image",
    "citeloom.describe-image",
    abortSignal,
    (requestSignal) => generateText({
      abortSignal: requestSignal,
      maxRetries: 1,
      messages: [{ content, role: "user" }],
      model: models.indexing,
      output: createStructuredOutput({
        description:
          "A factual visual retrieval description and substantive-content classification.",
        name: "image_retrieval_description",
        schema: imageRetrievalDescriptionSchema,
        validation: "local",
      }),
      system: IMAGE_RETRIEVAL_DESCRIPTION_SYSTEM_PROMPT,
      telemetry: createInferenceTelemetryOptions(
        models,
        "citeloom.describe-image",
      ),
    }),
  );
}

async function requestDescription<Result>(
  models: InferenceModelRegistry,
  operation: "describe-image" | "describe-table",
  telemetryFunctionId: string,
  abortSignal: AbortSignal,
  request: (requestSignal: AbortSignal) => Promise<{
    finishReason: string;
    output: Result;
    usage: {
      inputTokens: number | undefined;
      outputTokens: number | undefined;
    };
  }>,
): Promise<Result> {
  const finishMetric = models.metrics.start(
    operation,
    models.indexing.provider,
    models.indexing.modelId,
  );
  const timeoutMs = models.timeouts.indexingMs;
  const signals = createInferenceRequestSignal(timeoutMs, abortSignal);
  try {
    const result = await request(signals.requestSignal);
    finishMetric({
      finishReason: result.finishReason,
      inputTokens: result.usage.inputTokens ?? null,
      outputTokens: result.usage.outputTokens ?? null,
    });
    if (result.finishReason !== "stop") {
      throw new Error(
        `${telemetryFunctionId} finished with ${result.finishReason} instead of stop.`,
      );
    }
    return result.output;
  } catch (error: unknown) {
    finishMetric({
      finishReason: "error",
      inputTokens: null,
      outputTokens: null,
    });
    if (NoOutputGeneratedError.isInstance(error)) {
      throw new Error(
        `${telemetryFunctionId} did not produce a complete structured response.`,
        { cause: error },
      );
    }
    throwInferenceRequestFailure(
      error,
      "indexing",
      timeoutMs,
      signals.timeoutSignal,
      abortSignal,
    );
  }
}

function buildTablePrompt(
  element: TableElement,
  context: RetrievalDescriptionContext,
): string {
  const suppliedContext = {
    caption: element.caption,
    detectedType: element.detectedType,
    followingText: context.followingText,
    pageNumber: element.pageNumber,
    precedingText: context.precedingText,
    sectionHeading: element.sectionPath.at(-1) ?? null,
    sectionPath: element.sectionPath,
    title: null,
  };
  return [
    "Supplied document context:",
    JSON.stringify(suppliedContext, null, 2),
    "",
    "Supplied complete table:",
    element.content,
  ].join("\n");
}

function createTableRecord(
  element: TableElement,
  context: RetrievalDescriptionContext,
  result: TableRetrievalDescriptionRecord["result"],
): TableRetrievalDescriptionRecord {
  return {
    ...createRecordBase(
      element,
      createTableDescriptionInputFingerprint(element, context),
    ),
    kind: "table",
    result,
  };
}

function createImageRecord(
  element: ImageElement,
  result: ImageRetrievalDescriptionRecord["result"],
): ImageRetrievalDescriptionRecord {
  return {
    ...createRecordBase(
      element,
      createImageDescriptionInputFingerprint(element),
    ),
    kind: "image",
    result,
  };
}

function createRecordBase(
  element: ImageElement | TableElement,
  inputFingerprint: string,
) {
  return {
    documentId: element.documentId,
    id: `${element.id}-description`,
    inputFingerprint,
    pageNumber: element.pageNumber,
    pageNumbers: [...element.pageNumbers],
    parentId: element.id,
    regions: [...element.regions],
    sectionPath: [...element.sectionPath],
    sourceFile: element.sourceFile,
    sourceRefs: [...element.sourceRefs],
  };
}

function readAdjacentText(
  elements: readonly SourceElement[],
  index: number,
  direction: -1 | 1,
  element: SourceElement,
): string | null {
  const adjacent = elements[index + direction];
  if (
    adjacent === undefined
    || adjacent.kind !== "text"
    || !areStringArraysEqual(adjacent.sectionPath, element.sectionPath)
  ) {
    return null;
  }
  const content = adjacent.content.trim();
  if (content === "") {
    return null;
  }
  if (direction < 0) {
    return content.slice(-MAX_NEARBY_TEXT_CHARACTERS);
  }
  return content.slice(0, MAX_NEARBY_TEXT_CHARACTERS);
}

function areStringArraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function areNumberArraysEqual(
  left: readonly number[],
  right: readonly number[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function areSourceRegionsEqual(
  left: readonly SourceElement["regions"][number][],
  right: readonly SourceElement["regions"][number][],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
