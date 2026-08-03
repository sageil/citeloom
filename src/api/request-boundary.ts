import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { FastifyRequest } from "fastify";
import { z } from "zod";

import {
  isProviderManagedRuntimeSetting,
  type NormalizedRuntimeSettingChange,
} from "../app/settings.js";
import type {
  BrowseDocumentCatalogRequest,
  DocumentCollection,
} from "../documents/catalog/browser.js";
import {
  type DocumentExtension,
  readDocumentFormat,
} from "../documents/format.js";
import type {
  ReadDocumentFileRequest,
} from "../documents/catalog/service.js";
import type {
  IngestOptions,
  ReindexDocumentRequest,
  StagedIngestionDocument,
} from "../ingestion/service.js";
import { publishedAnswerDocumentSchema } from "../answers/published.js";
import {
  queryScopeSchema,
  type QueryScope,
} from "../domain/query-scope.js";
import {
  decodeSourceDiscoveryRequest,
  type SourceDiscoveryRequest,
} from "../retrieval/discovery/schema.js";
import type { SpeechRequest } from "../providers/text-to-speech.js";
import type {
  NormalizedProviderSettingsChange,
  ProviderCapability,
  ProviderId,
} from "../providers/profiles.js";
import {
  providerCapabilitySchema,
  providerConfigurationTextSchema,
  providerConnectionConfigurationSchema,
  providerCredentialSchema,
  providerIdSchema,
  languageThinkingModeSchema,
  providerSupportsCapability,
} from "../providers/profiles.js";
import type {
  TranscriptionAudio,
  TranscriptionMediaType,
} from "../providers/speech-to-text.js";
import type {
  ApplicationErrorPageRequest,
  ApplicationErrorPageSize,
} from "../observability/application-error-store.js";
import type { ResearchExportFormat } from "../research/store.js";
import {
  ResearchInputConflictError,
  ResearchRecordNotFoundError,
  ResearchThreadNotFoundError,
} from "../research/store.js";
import {
  ChatConflictError,
  ChatNotFoundError,
} from "../chat/store.js";
import { contentIdSchema, tagSchema } from "../domain/validation.js";
import {
  readEmbeddingInputFormatDefinition,
  type EmbeddingInputFormatDefinition,
} from "../embedding/input-format-model.js";
import {
  decodeRuntimeSettingBoundaryValue,
  readRuntimeSettingBoundaryReference,
  type RuntimeSettingBoundaryReference,
} from "./runtime-settings-boundary.js";

export interface QuestionRequest {
  question: string;
  scope: QueryScope;
  threadId: string;
}

export interface CreateChatConversationRequest {
  scope: QueryScope;
  title: string;
}

export interface CreateChatMessageRequest {
  content: string;
  requestId: string;
}

export interface RetryIngestionRequest {
  sourceFile: string;
}

export interface IngestionControlRequest {
  sourceFile: string;
}

export interface UpdateDocumentTagsRequest {
  documentId: string;
  sourceFile: string;
  tags: string[];
}

export interface UpdateApplicationSettingsRequest {
  changes: NormalizedRuntimeSettingChange[];
  expectedVersion: number;
  providerChanges: NormalizedProviderSettingsChange[];
}

export interface CopyEmbeddingInputFormatRequest {
  name: string;
}

const MINIMUM_MP4_AUDIO_BYTES = 1_500;
const questionRequestSchema = z.object({
  question: z.string().trim().min(1).max(8_000),
  scope: queryScopeSchema,
  threadId: z.uuid(),
}).strict();
const sourceFileSchema = z.string()
  .min(1)
  .max(8_192)
  .refine((value) => value.trim() !== "");
const researchThreadTitleSchema = z.object({
  title: z.string().trim().min(1).max(500),
}).strict();
const createChatConversationSchema = z.object({
  scope: queryScopeSchema,
  title: z.string().trim().min(1).max(500),
}).strict();
const createChatMessageSchema = z.object({
  content: z.string().trim().min(1).max(8_000),
  requestId: z.uuid(),
}).strict();
const chatParamsSchema = z.object({ conversationId: z.uuid() }).strict();
const uuidParamsSchema = z.object({ id: z.uuid() }).strict();
const threadParamsSchema = z.object({ threadId: z.uuid() }).strict();
const researchExportQuerySchema = z.object({
  format: z.enum(["citations", "json", "markdown"]),
}).strict();
const versionListQuerySchema = z.object({
  sourceFile: sourceFileSchema,
}).strict();
const versionComparisonQuerySchema = z.object({
  current: z.uuid(),
  previous: z.uuid(),
}).strict().refine((value) => value.current !== value.previous);
const researchFeedbackSchema = z.object({
  citationId: z.uuid().nullable(),
  comment: z.string().trim().min(1).max(4_000).nullable(),
  dimension: z.enum([
    "answer-usefulness",
    "citation-correctness",
    "retrieval-relevance",
  ]),
  rating: z.union([z.literal(-1), z.literal(1)]),
  turnId: z.uuid(),
}).strict();
const researchFeedbackSummarySchema = researchFeedbackSchema.pick({
  citationId: true,
  dimension: true,
  turnId: true,
}).strict();
const speechRequestSchema = z.object({
  answerDocument: publishedAnswerDocumentSchema,
}).strict();
const retryIngestionRequestSchema = z.object({
  sourceFile: sourceFileSchema,
}).strict();
const ingestionControlRequestSchema = z.object({
  sourceFile: sourceFileSchema,
}).strict();
const reindexDocumentParamsSchema = z.object({
  documentId: contentIdSchema,
}).strict();
const reindexDocumentBodySchema = z.object({
  sourceFile: sourceFileSchema,
}).strict();
const updateDocumentTagsBodySchema = z.object({
  sourceFile: sourceFileSchema,
  tags: z.array(tagSchema).max(20),
}).strict();
const documentFileQuerySchema = z.object({
  sourceFile: sourceFileSchema,
}).strict();
const documentCatalogQuerySchema = z.object({
  collection: z.string().min(1).max(8_000).default("all"),
  page: z.coerce.number().int().positive().max(1_000_000).default(1),
  pageSize: z.enum(["25", "50", "100"]).default("25"),
  search: z.string().max(500).default(""),
  sort: z.enum([
    "name-asc",
    "name-desc",
    "updated-asc",
    "updated-desc",
  ]).default("updated-desc"),
  status: z.enum([
    "all",
    "failed",
    "processing",
    "queryable",
    "ready",
    "reindex-required",
  ]).default("all"),
  tag: z.string().max(64).default(""),
}).strict();
const applicationErrorQuerySchema = z.object({
  area: z.enum(["all", "ingestion", "application", "general"]).default("all"),
  page: z.coerce.number().int().positive().max(1_000_000).default(1),
  pageSize: z.enum(["25", "50", "100"]).default("50"),
}).strict();
const multipartFieldSchema = z.string().max(2_000);
const booleanFieldSchema = z.enum(["false", "true"]);
const runtimeSettingPrimitiveSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);
const runtimeSettingChangeSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("reset"),
    key: z.string().min(1),
  }).strict(),
  z.object({
    action: z.literal("set"),
    key: z.string().min(1),
    value: runtimeSettingPrimitiveSchema,
  }).strict(),
]);
const providerSettingsChangeSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("configure"),
    configuration: providerConnectionConfigurationSchema,
    providerId: providerIdSchema,
  }).strict(),
  z.object({
    action: z.literal("credential"),
    providerId: providerIdSchema,
    target: z.union([z.literal("shared"), providerCapabilitySchema]),
    value: providerCredentialSchema,
  }).strict(),
  z.object({
    action: z.literal("feature"),
    configuration: z.discriminatedUnion("capability", [
      z.object({
        capability: z.enum([
          "answer",
          "chat",
          "queryExpansion",
          "summarization",
        ]),
        contextCapacityTokensOverride: z.number().int().positive().nullable(),
        modelOverride: providerConfigurationTextSchema,
        providerId: providerIdSchema.nullable(),
        thinkingModeOverride: languageThinkingModeSchema.nullable(),
      }).strict(),
      z.object({
        capability: z.literal("embedding"),
        contextCapacityTokensOverride: z.number().int().positive().nullable(),
        modelOverride: providerConfigurationTextSchema,
        providerId: providerIdSchema.nullable(),
      }).strict(),
      z.object({
        capability: z.enum([
          "reranking",
          "speechToText",
        ]),
        modelOverride: providerConfigurationTextSchema,
        providerId: providerIdSchema.nullable(),
      }).strict(),
      z.object({
        capability: z.literal("textToSpeech"),
        modelOverride: providerConfigurationTextSchema,
        providerId: providerIdSchema.nullable(),
        voiceOverride: providerConfigurationTextSchema,
      }).strict(),
    ]),
  }).strict(),
  z.object({
    action: z.literal("reset"),
  }).strict(),
  z.object({
    action: z.literal("reset-feature"),
    capability: providerCapabilitySchema,
  }).strict(),
  z.object({
    action: z.literal("reset-provider"),
    providerId: providerIdSchema,
  }).strict(),
  z.object({
    action: z.literal("route"),
    capability: providerCapabilitySchema,
    providerId: providerIdSchema.nullable(),
  }).strict(),
]);
const updateApplicationSettingsSchema = z.object({
  changes: z.array(runtimeSettingChangeSchema).max(100).default([]),
  expectedVersion: z.number().int().nonnegative(),
  providerChanges: z.array(providerSettingsChangeSchema).max(50).default([]),
}).strict().superRefine((request, context) => {
  if (request.changes.length === 0 && request.providerChanges.length === 0) {
    context.addIssue({
      code: "custom",
      message: "At least one settings change is required.",
      path: ["changes"],
    });
  }
  const resetsAllProviders = request.providerChanges.some((change) => {
    return change.action === "reset";
  });
  if (resetsAllProviders && request.providerChanges.length !== 1) {
    context.addIssue({
      code: "custom",
      message: "Provider reset cannot be combined with other provider changes.",
      path: ["providerChanges"],
    });
  }
});
const copyEmbeddingInputFormatSchema = z.object({
  name: z.string().trim().min(1).max(100),
}).strict();

export interface UploadedDocuments {
  documents: StagedIngestionDocument[];
  groupDirectory: string;
  options: IngestOptions;
}

const multipartBoundaryErrorSchema = z.object({
  code: z.string().optional(),
  statusCode: z.number().int().optional(),
});

interface MultipartFields {
  force: string | null;
  tags: string | null;
}

export class WebRequestError extends Error {
  public constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "WebRequestError";
  }
}

export async function readUploadedDocuments(
  request: FastifyRequest,
  uploadRoot: string,
  maximumDocumentBytes: number,
  maximumUploadRequestBytes: number,
): Promise<UploadedDocuments> {
  if (!request.isMultipart()) {
    throw new WebRequestError(415, "Document ingestion requires multipart form data.");
  }

  const groupDirectory = join(uploadRoot, randomUUID());
  await mkdir(groupDirectory, { recursive: true });
  const fields: MultipartFields = { force: null, tags: null };
  const documents: StagedIngestionDocument[] = [];
  const filenames = new Set<string>();
  let aggregateByteLength = 0;
  let uploadComplete = false;

  try {
    for await (const part of request.parts({
      limits: { fileSize: maximumDocumentBytes },
    })) {
      if (part.type === "field") {
        writeMultipartField(fields, part.fieldname, part.value);
        continue;
      }
      if (part.fieldname !== "documents") {
        part.file.resume();
        throw new WebRequestError(400, `Unexpected file field: ${part.fieldname}`);
      }
      const filename = readUploadedFilename(part.filename);
      if (filenames.has(filename)) {
        part.file.resume();
        throw new WebRequestError(400, `Duplicate uploaded filename: ${filename}`);
      }
      filenames.add(filename);
      const destination = join(groupDirectory, filename);
      const format = readDocumentFormat(filename);
      const hash = createHash("sha256");
      let byteLength = 0;
      const meter = new Transform({
        transform(chunk: unknown, _encoding, callback): void {
          if (!Buffer.isBuffer(chunk)) {
            callback(new Error("Upload stream produced a non-buffer chunk."));
            return;
          }
          byteLength += chunk.byteLength;
          aggregateByteLength += chunk.byteLength;
          if (aggregateByteLength > maximumUploadRequestBytes) {
            callback(new WebRequestError(
              413,
              `Upload exceeds the configured ${maximumUploadRequestBytes} byte request limit.`,
            ));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        part.file,
        meter,
        createWriteStream(destination, { flags: "wx", mode: 0o600 }),
      );
      if (part.file.truncated) {
        throw new WebRequestError(
          413,
          `${filename} exceeds the configured document size limit.`,
        );
      }
      if (byteLength === 0) {
        throw new WebRequestError(400, `Document is empty: ${filename}`);
      }
      documents.push({
        byteLength,
        documentId: hash.digest("hex"),
        extension: format.extension,
        mediaType: format.mediaType,
        sourceFile: destination,
      });
    }
    if (documents.length === 0) {
      throw new WebRequestError(400, "Select at least one document.");
    }
    uploadComplete = true;
    return {
      documents,
      groupDirectory,
      options: decodeIngestOptions(fields),
    };
  } finally {
    if (!uploadComplete) {
      await rm(groupDirectory, { force: true, recursive: true });
    }
  }
}

export async function removeUploadedDocumentStaging(
  upload: UploadedDocuments,
): Promise<void> {
  await rm(upload.groupDirectory, { force: true, recursive: true });
}

export async function readTranscriptionRequest(
  request: FastifyRequest,
  maximumAudioBytes: number,
): Promise<TranscriptionAudio> {
  if (!request.isMultipart()) {
    throw new WebRequestError(415, "Transcription requires multipart form data.");
  }

  let audio: TranscriptionAudio | null = null;
  try {
    for await (const part of request.parts({
      limits: {
        fields: 1,
        fileSize: maximumAudioBytes,
        files: 2,
        parts: 2,
      },
    })) {
      if (part.type === "field") {
        throw new WebRequestError(400, `Unexpected transcription field: ${part.fieldname}.`);
      }
      if (part.fieldname !== "file") {
        part.file.resume();
        throw new WebRequestError(400, `Unexpected transcription file field: ${part.fieldname}.`);
      }
      if (audio !== null) {
        part.file.resume();
        throw new WebRequestError(400, "Provide exactly one transcription audio file.");
      }
      const mediaType = readTranscriptionMediaType(part.mimetype);
      const content = await readTranscriptionAudioBytes(
        part.file,
        maximumAudioBytes,
      );
      validateTranscriptionAudioContent(mediaType, content);
      audio = {
        content,
        filename: buildTranscriptionFilename(mediaType),
        mediaType,
      };
    }
  } catch (error: unknown) {
    if (error instanceof WebRequestError) {
      throw error;
    }
    throw readTranscriptionMultipartError(error);
  }

  if (audio === null) {
    throw new WebRequestError(400, "Provide one transcription audio file.");
  }
  return audio;
}

function validateTranscriptionAudioContent(
  mediaType: TranscriptionMediaType,
  content: Buffer,
): void {
  if (mediaType === "audio/mp4" && content.byteLength < MINIMUM_MP4_AUDIO_BYTES) {
    throw new WebRequestError(
      400,
      "The recorded audio did not contain enough data. Try recording again.",
    );
  }
}

export function decodeQuestionRequest(value: unknown): QuestionRequest {
  const result = questionRequestSchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "Question or document scope is invalid.");
  }
  return result.data;
}

export function decodeCreateResearchThreadRequest(value: unknown): string {
  const result = researchThreadTitleSchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "A valid research thread title is required.");
  }
  return result.data.title;
}

export function decodeCreateChatConversationRequest(
  value: unknown,
): CreateChatConversationRequest {
  const result = createChatConversationSchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "A valid chat title and document scope are required.");
  }
  return result.data;
}

export function decodeCreateChatMessageRequest(
  value: unknown,
): CreateChatMessageRequest {
  const result = createChatMessageSchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "A valid chat message and request ID are required.");
  }
  return result.data;
}

export function decodeChatConversationId(value: unknown): string {
  const result = chatParamsSchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "A valid chat ID is required.");
  }
  return result.data.conversationId;
}

export function decodeResearchThreadId(value: unknown): string {
  const result = threadParamsSchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "A valid research thread id is required.");
  }
  return result.data.threadId;
}

export function decodeResourceId(value: unknown): string {
  const result = uuidParamsSchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "A valid resource id is required.");
  }
  return result.data.id;
}

export function decodeResearchExportFormat(value: unknown): ResearchExportFormat {
  const result = researchExportQuerySchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "A valid research export format is required.");
  }
  return result.data.format;
}

export function decodeDocumentVersionList(value: unknown): string {
  const result = versionListQuerySchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "A valid source file is required.");
  }
  return result.data.sourceFile;
}

export function decodeDocumentVersionComparison(value: unknown): {
  current: string;
  previous: string;
} {
  const result = versionComparisonQuerySchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "Two distinct document version ids are required.");
  }
  return result.data;
}

export function decodeResearchFeedback(value: unknown): {
  citationId: string | null;
  comment: string | null;
  dimension: "answer-usefulness" | "citation-correctness" | "retrieval-relevance";
  rating: -1 | 1;
  turnId: string;
} {
  const result = researchFeedbackSchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "Research feedback is invalid.");
  }
  if (result.data.dimension === "citation-correctness" && result.data.citationId === null) {
    throw new WebRequestError(400, "Citation correctness feedback requires a citation.");
  }
  return result.data;
}

export function decodeResearchFeedbackSummary(value: unknown): {
  citationId: string | null;
  dimension: "answer-usefulness" | "citation-correctness" | "retrieval-relevance";
  turnId: string;
} {
  const result = researchFeedbackSummarySchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "Research feedback summary is invalid.");
  }
  return result.data;
}

export function decodeSpeechRequest(value: unknown): SpeechRequest {
  const result = speechRequestSchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "Speech answer document is invalid.");
  }
  return result.data;
}

export function readSourceDiscoveryRequest(value: unknown): SourceDiscoveryRequest {
  try {
    return decodeSourceDiscoveryRequest(value);
  } catch {
    throw new WebRequestError(400, "Source discovery request is invalid.");
  }
}

export function decodeRetryIngestionRequest(value: unknown): RetryIngestionRequest {
  const result = retryIngestionRequestSchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "A valid stored source file is required.");
  }
  return result.data;
}

export function decodeIngestionControlRequest(value: unknown): IngestionControlRequest {
  const result = ingestionControlRequestSchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "A valid stored source file is required.");
  }
  return result.data;
}

export function decodeApplicationSettingsUpdate(
  value: unknown,
): UpdateApplicationSettingsRequest {
  const result = updateApplicationSettingsSchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "The settings update is invalid.");
  }
  const changes: NormalizedRuntimeSettingChange[] = [];
  const changedKeys = new Set<string>();
  for (const change of result.data.changes) {
    let reference: RuntimeSettingBoundaryReference;
    try {
      reference = readRuntimeSettingBoundaryReference(change.key);
    } catch {
      throw new WebRequestError(400, `Unknown runtime setting: ${change.key}.`);
    }
    if (changedKeys.has(reference.storageKey)) {
      throw new WebRequestError(
        400,
        `Runtime setting was changed twice: ${reference.browserKey}.`,
      );
    }
    if (isProviderManagedRuntimeSetting(reference.storageKey)) {
      throw new WebRequestError(
        400,
        `Provider-managed setting must use provider changes: ${reference.browserKey}.`,
      );
    }
    changedKeys.add(reference.storageKey);
    if (change.action === "reset") {
      changes.push({ key: reference.storageKey, reset: true });
      continue;
    }
    try {
      const settingValue = decodeRuntimeSettingBoundaryValue(
        reference,
        change.value,
      );
      changes.push({ key: reference.storageKey, value: settingValue });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Setting value is invalid.";
      throw new WebRequestError(400, message);
    }
  }
  for (const change of result.data.providerChanges) {
    let providerId: ProviderId | null;
    let capability: ProviderCapability;
    if (change.action === "route") {
      providerId = change.providerId;
      capability = change.capability;
    } else if (change.action === "feature") {
      providerId = change.configuration.providerId;
      capability = change.configuration.capability;
    } else {
      continue;
    }
    if (
      providerId !== null
      && !providerSupportsCapability(providerId, capability)
    ) {
      throw new WebRequestError(
        400,
        `Provider ${providerId} does not support ${formatProviderCapability(capability)}.`,
      );
    }
  }
  return {
    changes,
    expectedVersion: result.data.expectedVersion,
    providerChanges: result.data.providerChanges,
  };
}

export function decodeEmbeddingInputFormatDefinition(
  value: unknown,
): EmbeddingInputFormatDefinition {
  try {
    return readEmbeddingInputFormatDefinition(value);
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : "The embedding input format is invalid.";
    throw new WebRequestError(400, message);
  }
}

export function decodeCopyEmbeddingInputFormatRequest(
  value: unknown,
): CopyEmbeddingInputFormatRequest {
  const result = copyEmbeddingInputFormatSchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(
      400,
      "A valid name is required for the copied embedding input format.",
    );
  }
  return result.data;
}

function formatProviderCapability(
  capability: ProviderCapability,
): string {
  if (capability === "answer") {
    return "answer generation";
  }
  if (capability === "chat") {
    return "chat";
  }
  if (capability === "speechToText") {
    return "speech-to-text";
  }
  if (capability === "textToSpeech") {
    return "text-to-speech";
  }
  return capability;
}

export function decodeReindexDocumentRequest(
  params: unknown,
  body: unknown,
): ReindexDocumentRequest {
  const paramsResult = reindexDocumentParamsSchema.safeParse(params);
  const bodyResult = reindexDocumentBodySchema.safeParse(body);
  if (!paramsResult.success || !bodyResult.success) {
    throw new WebRequestError(400, "A valid indexed document is required.");
  }
  return {
    documentId: paramsResult.data.documentId,
    sourceFile: bodyResult.data.sourceFile,
  };
}

export function decodeUpdateDocumentTagsRequest(
  params: unknown,
  body: unknown,
): UpdateDocumentTagsRequest {
  const paramsResult = reindexDocumentParamsSchema.safeParse(params);
  const bodyResult = updateDocumentTagsBodySchema.safeParse(body);
  if (!paramsResult.success || !bodyResult.success) {
    throw new WebRequestError(400, "Valid document tags are required.");
  }
  return {
    documentId: paramsResult.data.documentId,
    sourceFile: bodyResult.data.sourceFile,
    tags: [
      ...new Set(bodyResult.data.tags.map((tag) => tag.toLowerCase())),
    ].sort(),
  };
}

export function decodeDocumentFileRequest(
  params: unknown,
  query: unknown,
): ReadDocumentFileRequest {
  const paramsResult = reindexDocumentParamsSchema.safeParse(params);
  const queryResult = documentFileQuerySchema.safeParse(query);
  if (!paramsResult.success || !queryResult.success) {
    throw new WebRequestError(400, "A valid indexed document is required.");
  }
  return {
    documentId: paramsResult.data.documentId,
    sourceFile: queryResult.data.sourceFile,
  };
}

export function buildInlineContentDisposition(filename: string): string {
  const asciiFilename = filename
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_");
  const encodedFilename = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `inline; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`;
}

export function decodeDocumentCatalogQuery(
  value: unknown,
): BrowseDocumentCatalogRequest {
  const result = documentCatalogQuerySchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "Document catalog filters are invalid.");
  }
  return {
    collection: decodeDocumentCollection(result.data.collection),
    page: result.data.page,
    pageSize: readDocumentPageSize(result.data.pageSize),
    search: result.data.search.trim().toLowerCase(),
    sort: result.data.sort,
    status: result.data.status,
    tag: decodeOptionalTag(result.data.tag),
  };
}

export function decodeApplicationErrorQuery(
  value: unknown,
): ApplicationErrorPageRequest {
  const result = applicationErrorQuerySchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "Application error filters are invalid.");
  }
  return {
    area: result.data.area,
    page: result.data.page,
    pageSize: readApplicationErrorPageSize(result.data.pageSize),
  };
}

export function readErrorStatus(error: unknown): number {
  if (error instanceof WebRequestError) {
    return error.statusCode;
  }
  if (
    error instanceof ResearchRecordNotFoundError
    || error instanceof ResearchThreadNotFoundError
  ) {
    return 404;
  }
  if (error instanceof ResearchInputConflictError) {
    return 409;
  }
  if (error instanceof ChatNotFoundError) {
    return 404;
  }
  if (error instanceof ChatConflictError) {
    return 409;
  }
  const result = z.object({ statusCode: z.number().int().min(400).max(599) })
    .safeParse(error);
  return result.success ? result.data.statusCode : 500;
}

export function readServerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The request is invalid.";
}

function writeMultipartField(
  fields: MultipartFields,
  fieldName: string,
  value: unknown,
): void {
  const result = multipartFieldSchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, `Invalid multipart field: ${fieldName}`);
  }
  if (fieldName === "force" || fieldName === "tags") {
    if (fields[fieldName] !== null) {
      throw new WebRequestError(400, `Duplicate multipart field: ${fieldName}`);
    }
    fields[fieldName] = result.data;
    return;
  }
  throw new WebRequestError(400, `Unknown multipart field: ${fieldName}`);
}

function decodeIngestOptions(fields: MultipartFields): IngestOptions {
  return {
    enqueue: true,
    force: decodeBooleanField(fields.force, false, "force"),
    recursive: false,
    tags: decodeTags(fields.tags),
  };
}

function decodeTags(value: string | null): string[] {
  if (value === null || value.trim() === "") {
    return [];
  }
  const tags: string[] = [];
  for (const candidate of value.split(",")) {
    const result = tagSchema.safeParse(candidate);
    if (!result.success) {
      throw new WebRequestError(400, `Invalid tag: ${candidate.trim()}`);
    }
    tags.push(result.data.toLowerCase());
  }
  return [...new Set(tags)].sort();
}

function decodeBooleanField(
  value: string | null,
  defaultValue: boolean,
  fieldName: string,
): boolean {
  if (value === null) {
    return defaultValue;
  }
  const result = booleanFieldSchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, `${fieldName} must be true or false.`);
  }
  return result.data === "true";
}

function readUploadedFilename(value: string): string {
  const portablePath = value.replaceAll("\\", "/");
  const filename = basename(portablePath).normalize("NFC");
  if (filename === "" || filename === "." || filename === "..") {
    throw new WebRequestError(400, "Uploaded document filename is invalid.");
  }
  const extension = readUploadedExtension(filename);
  const stem = basename(filename, extname(filename))
    .replace(/[^\p{L}\p{N}._ -]+/gu, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  if (stem === "") {
    throw new WebRequestError(400, "Uploaded document filename is invalid.");
  }
  return `${stem}${extension}`;
}

export function readTranscriptionMediaType(value: string): TranscriptionMediaType {
  const segments = value.split(";");
  const baseMediaType = segments.shift()?.trim().toLowerCase() ?? "";
  const parameters = new Map<string, string>();
  for (const segment of segments) {
    const separator = segment.indexOf("=");
    if (separator <= 0) {
      throw new WebRequestError(415, "The recorded audio format is unsupported.");
    }
    const name = segment.slice(0, separator).trim().toLowerCase();
    const parameterValue = readMediaTypeParameter(
      segment.slice(separator + 1).trim(),
    );
    if (name !== "codecs" || parameters.has(name)) {
      throw new WebRequestError(415, "The recorded audio format is unsupported.");
    }
    parameters.set(name, parameterValue.toLowerCase());
  }

  const codec = parameters.get("codecs") ?? null;
  if (baseMediaType === "audio/webm" || baseMediaType === "audio/ogg") {
    if (codec !== null && codec !== "opus") {
      throw new WebRequestError(415, "The recorded audio format is unsupported.");
    }
    return baseMediaType;
  }
  if (baseMediaType === "audio/mp4") {
    if (codec !== null && codec !== "aac" && codec !== "mp4a.40.2") {
      throw new WebRequestError(415, "The recorded audio format is unsupported.");
    }
    return "audio/mp4";
  }
  if (baseMediaType === "audio/wav" || baseMediaType === "audio/x-wav") {
    if (codec !== null) {
      throw new WebRequestError(415, "The recorded audio format is unsupported.");
    }
    return "audio/wav";
  }
  throw new WebRequestError(415, "The recorded audio format is unsupported.");
}

async function readTranscriptionAudioBytes(
  stream: NodeJS.ReadableStream & { truncated?: boolean },
  maximumAudioBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) {
      throw new WebRequestError(400, "The transcription upload is malformed.");
    }
    totalBytes += chunk.byteLength;
    if (totalBytes > maximumAudioBytes) {
      throw new WebRequestError(413, "The recorded audio exceeds the configured size limit.");
    }
    chunks.push(chunk);
  }
  if (stream.truncated === true) {
    throw new WebRequestError(413, "The recorded audio exceeds the configured size limit.");
  }
  if (totalBytes === 0) {
    throw new WebRequestError(400, "The recorded audio is empty.");
  }
  return Buffer.concat(chunks, totalBytes);
}

function buildTranscriptionFilename(mediaType: TranscriptionMediaType): string {
  const extension = mediaType === "audio/webm"
    ? "webm"
    : mediaType === "audio/mp4"
      ? "mp4"
      : mediaType === "audio/ogg"
        ? "ogg"
        : "wav";
  return `recording-${randomUUID()}.${extension}`;
}

function readMediaTypeParameter(value: string): string {
  const unquoted = value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
  if (unquoted === "" || !/^[A-Za-z0-9._+-]+$/.test(unquoted)) {
    throw new WebRequestError(415, "The recorded audio format is unsupported.");
  }
  return unquoted;
}

function readTranscriptionMultipartError(error: unknown): WebRequestError {
  const result = multipartBoundaryErrorSchema.safeParse(error);
  if (
    result.success
    && (
      result.data.statusCode === 413
      || result.data.code === "FST_REQ_FILE_TOO_LARGE"
    )
  ) {
    return new WebRequestError(
      413,
      "The recorded audio exceeds the configured size limit.",
    );
  }
  return new WebRequestError(400, "The transcription upload is malformed.");
}

function readUploadedExtension(filename: string): DocumentExtension {
  try {
    return readDocumentFormat(filename).extension;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unsupported document format.";
    throw new WebRequestError(400, message);
  }
}

function decodeDocumentCollection(value: string): DocumentCollection {
  if (value === "all" || value === "uploads" || value === "untagged") {
    return { kind: value };
  }
  if (value.startsWith("tags:")) {
    const tags = decodeTags(value.slice(5));
    if (tags.length > 0) {
      return { kind: "tags", tags };
    }
  }
  if (value.startsWith("tag:")) {
    const result = tagSchema.safeParse(value.slice(4));
    if (result.success) {
      return { kind: "tag", tag: result.data.toLowerCase() };
    }
  }
  throw new WebRequestError(400, "Document collection is invalid.");
}

function decodeOptionalTag(value: string): string | null {
  if (value.trim() === "") {
    return null;
  }
  const result = tagSchema.safeParse(value);
  if (!result.success) {
    throw new WebRequestError(400, "Document tag filter is invalid.");
  }
  return result.data.toLowerCase();
}

function readDocumentPageSize(value: "25" | "50" | "100"): 25 | 50 | 100 {
  if (value === "25") {
    return 25;
  }
  if (value === "50") {
    return 50;
  }
  return 100;
}

function readApplicationErrorPageSize(
  value: "25" | "50" | "100",
): ApplicationErrorPageSize {
  if (value === "25") {
    return 25;
  }
  if (value === "50") {
    return 50;
  }
  return 100;
}
