import { basename } from "node:path";

import type { DoclingConvertRequester } from "./index.js";
import type {
  DoclingConfig,
  DoclingPdfBackend,
  DoclingProcessingPipeline,
  DoclingTableMode,
  DoclingVlmConfig,
  DoclingVlmEngineType,
} from "../../config/index.js";
import { calculateDoclingConversionDeadline } from "./deadline.js";
import {
  noOpDoclingConversionObserver,
  type DoclingConversionObserver,
  type DoclingRequestObserver,
} from "./observer.js";
import {
  prepareDoclingTask,
  type DoclingTaskControl,
} from "./task.js";
import {
  isStandaloneImageFormat,
  type DocumentFormat,
  type FileDocumentSource,
} from "../../documents/format.js";
import {
  decodeDoclingConversionResponse,
  type DoclingConversionResult,
} from "../protocol/index.js";
import type {
  DoclingEffectiveRequestOptions,
  DoclingRequestConfiguration,
} from "../protocol/run-metadata.js";
import { DOCLING_OCR_PRESET } from "../protocol/model.js";

const SERVER_TIMEOUT_BUFFER_MS = 5_000;

export interface DoclingConversionRequestOptions {
  doOcr: boolean;
  doTableStructure: boolean;
  imageExportMode: "embedded";
  imagesScale: number;
  includeImages: true;
  includePageImages: boolean;
  kind: DoclingRequestKind;
  pipeline: DoclingProcessingPipeline;
  pdfBackend: DoclingPdfBackend;
  tableMode: DoclingTableMode;
  vlm: DoclingVlmConfig | null;
  vlmRequestTimeoutMs: number;
}

export type DoclingRequestKind = "content";

export interface RequestDoclingConversionInput {
  abortSignal: AbortSignal;
  config: DoclingConfig;
  observer?: DoclingConversionObserver;
  options: DoclingConversionRequestOptions;
  requestKey: string;
  requester: DoclingConvertRequester;
  source: FileDocumentSource;
  taskControl: DoclingTaskControl;
}

export interface RequestDoclingConversionResult {
  conversion: DoclingConversionResult;
  pageCount: number | null;
  requestObserver: DoclingRequestObserver;
}

interface DoclingConvertOptionsBaseDto {
  abort_on_error: true;
  do_ocr: boolean;
  do_table_structure: boolean;
  document_timeout: number;
  force_ocr: false;
  from_formats: [string];
  image_export_mode: "embedded";
  images_scale: number;
  include_images: true;
  include_page_images: boolean;
  ocr_preset: string;
  pdf_backend: DoclingPdfBackend;
  table_cell_matching: true;
  table_mode: DoclingTableMode;
  to_formats: ["json"];
}

interface DoclingStandardConvertOptionsDto extends DoclingConvertOptionsBaseDto {
  pipeline: "standard";
}

interface DoclingVlmConvertOptionsDto extends DoclingConvertOptionsBaseDto {
  pipeline: "vlm";
  vlm_pipeline_custom_config: DoclingVlmCustomConfigDto;
}

type DoclingConvertOptionsDto =
  | DoclingStandardConvertOptionsDto
  | DoclingVlmConvertOptionsDto;

interface DoclingVlmCustomConfigDto {
  batch_size: 1;
  engine_options: DoclingVlmEngineOptionsDto;
  force_backend_text: false;
  model_spec: DoclingVlmModelSpecDto;
  scale: number;
}

interface DoclingVlmEngineOptionsDto {
  concurrency: 1;
  engine_type: DoclingVlmEngineType;
  headers: { [key: string]: string };
  params: DoclingVlmParametersDto;
  timeout: number;
  url: string;
}

interface DoclingVlmParametersDto {
  model: string;
}

interface DoclingVlmModelSpecDto {
  default_repo_id: string;
  max_new_tokens: number;
  name: string;
  prompt: string;
  response_format: "markdown";
  supported_engines: [DoclingVlmEngineType];
  temperature: 0;
}

interface DoclingContentRequestDto {
  byte_length: number;
  document_id: string;
  filename: string;
  options: DoclingConvertOptionsDto;
  task_id: string;
}

export function buildDoclingConversionOptions(
  config: DoclingConfig,
  format: DocumentFormat,
): DoclingConversionRequestOptions {
  return {
    doOcr: config.ocrEnabled,
    doTableStructure: config.tableStructureEnabled,
    imageExportMode: "embedded",
    imagesScale: config.secondaryImageScale,
    includeImages: true,
    includePageImages: isStandaloneImageFormat(format),
    kind: "content",
    pipeline: config.pipeline,
    pdfBackend: config.pdfBackend,
    tableMode: config.tableMode,
    vlm: config.vlm,
    vlmRequestTimeoutMs: config.requestTimeoutMs,
  };
}

export async function requestDoclingConversion(
  input: RequestDoclingConversionInput,
): Promise<RequestDoclingConversionResult> {
  const conversionObserver = input.observer ?? noOpDoclingConversionObserver;
  const requestObserver = await conversionObserver.openRequest({
    kind: input.options.kind,
    options: readDoclingEffectiveRequestOptions(input.source, input.options),
    requestKey: input.requestKey,
  });
  const deadline = await calculateDoclingConversionDeadline(
    input.source,
    input.config,
  );
  const serverTimeoutMs = Math.max(
    1_000,
    deadline.processingTimeoutMs - SERVER_TIMEOUT_BUFFER_MS,
  );
  const preparedTask = await prepareDoclingTask(
    input.taskControl,
    deadline.taskTimeoutMs,
  );
  const body = buildDoclingContentRequest(
    input.source,
    input.options,
    serverTimeoutMs,
    preparedTask.task.id,
  );
  const conversion = await input.requester({
    abortSignal: input.abortSignal,
    apiKey: input.config.apiKey,
    baseUrl: input.config.baseUrl,
    body: JSON.stringify(body),
    decodeResponse: decodeDoclingConversionResponse,
    observer: requestObserver,
    requestTimeoutMs: input.config.requestTimeoutMs,
    retainTaskAfterTerminalFailure: input.source.extension === ".pdf",
    resumedSubmission: preparedTask.kind === "resumed",
    task: preparedTask.task,
    taskControl: input.taskControl,
    url: `${input.config.baseUrl}/v1/convert/content/async`,
  });
  return {
    conversion,
    pageCount: deadline.pageCount,
    requestObserver,
  };
}

export function buildDoclingContentRequest(
  source: FileDocumentSource,
  options: DoclingConversionRequestOptions,
  serverTimeoutMs: number,
  taskId: string,
): DoclingContentRequestDto {
  const baseOptions: DoclingConvertOptionsBaseDto = {
    abort_on_error: true,
    do_ocr: options.doOcr,
    do_table_structure: options.doTableStructure,
    document_timeout: Math.floor(serverTimeoutMs / 1_000),
    force_ocr: false,
    from_formats: [readDoclingInputFormat(source.extension)],
    image_export_mode: options.imageExportMode,
    images_scale: options.imagesScale,
    include_images: options.includeImages,
    include_page_images: options.includePageImages,
    ocr_preset: DOCLING_OCR_PRESET,
    pdf_backend: options.pdfBackend,
    table_cell_matching: true,
    table_mode: options.tableMode,
    to_formats: ["json"],
  };
  const requestOptions = buildDoclingConvertOptionsDto(
    baseOptions,
    options,
  );
  return {
    byte_length: source.byteLength,
    document_id: source.documentId,
    filename: basename(source.sourceFile),
    options: requestOptions,
    task_id: taskId,
  };
}

export function readDoclingEffectiveRequestOptions(
  source: FileDocumentSource,
  options: DoclingConversionRequestOptions,
): DoclingEffectiveRequestOptions {
  const configuration = readDoclingRequestConfiguration(options);
  return {
    ...configuration,
    pdfBackend: source.extension === ".pdf" ? configuration.pdfBackend : null,
  };
}

export function readDoclingRequestConfiguration(
  options: DoclingConversionRequestOptions,
): DoclingRequestConfiguration {
  return {
    doOcr: options.doOcr,
    doTableStructure: options.doTableStructure,
    imageExportMode: options.imageExportMode,
    imagesScale: options.imagesScale,
    includeImages: options.includeImages,
    includePageImages: options.includePageImages,
    pipeline: options.pipeline,
    pdfBackend: options.pdfBackend,
    tableMode: options.doTableStructure ? options.tableMode : null,
    vlm: readDoclingVlmConfigSnapshot(options.vlm),
  };
}

function buildDoclingConvertOptionsDto(
  baseOptions: DoclingConvertOptionsBaseDto,
  options: DoclingConversionRequestOptions,
): DoclingConvertOptionsDto {
  if (options.pipeline === "standard") {
    return {
      ...baseOptions,
      pipeline: "standard",
    };
  }
  if (options.vlm === null) {
    throw new Error("Docling VLM processing requires a VLM configuration.");
  }
  return {
    ...baseOptions,
    pipeline: "vlm",
    vlm_pipeline_custom_config: buildDoclingVlmCustomConfigDto(
      options.vlm,
      options.imagesScale,
      options.vlmRequestTimeoutMs,
    ),
  };
}

function buildDoclingVlmCustomConfigDto(
  config: DoclingVlmConfig,
  scale: number,
  requestTimeoutMs: number,
): DoclingVlmCustomConfigDto {
  const headers: { [key: string]: string } = {};
  if (config.apiToken !== null) {
    headers.Authorization = `Bearer ${config.apiToken}`;
  }
  return {
    batch_size: 1,
    engine_options: {
      concurrency: 1,
      engine_type: config.engineType,
      headers,
      params: {
        model: config.model,
      },
      timeout: Math.max(1, Math.floor(requestTimeoutMs / 1_000)),
      url: config.endpointUrl,
    },
    force_backend_text: false,
    model_spec: {
      default_repo_id: config.model,
      max_new_tokens: config.maxOutputTokens,
      name: config.runtimeName,
      prompt: config.prompt,
      response_format: "markdown",
      supported_engines: [config.engineType],
      temperature: 0,
    },
    scale,
  };
}

function readDoclingVlmConfigSnapshot(
  config: DoclingVlmConfig | null,
): DoclingRequestConfiguration["vlm"] {
  if (config === null) {
    return null;
  }
  return {
    endpointUrl: config.endpointUrl,
    engineType: config.engineType,
    maxOutputTokens: config.maxOutputTokens,
    model: config.model,
    prompt: config.prompt,
    providerId: config.providerId,
    runtimeName: config.runtimeName,
  };
}

function readDoclingInputFormat(extension: string): string {
  if (extension === ".pdf") {
    return "pdf";
  }
  if (extension === ".docx") {
    return "docx";
  }
  if (extension === ".xlsx") {
    return "xlsx";
  }
  if (extension === ".pptx") {
    return "pptx";
  }
  if (extension === ".html" || extension === ".htm") {
    return "html";
  }
  if (
    extension === ".png"
    || extension === ".jpg"
    || extension === ".jpeg"
    || extension === ".webp"
  ) {
    return "image";
  }
  throw new Error(`Docling does not support document extension ${extension}.`);
}
