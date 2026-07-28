import { extname } from "node:path";

import { z } from "zod";

const knownDocumentExtensionSchema = z.enum([
  ".docx",
  ".htm",
  ".html",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".pptx",
  ".png",
  ".webp",
  ".xlsx",
]);
const plainTextDocumentExtensionSchema = z.string()
  .max(33)
  .refine(
    (extension) => extension === "" || /^\.[a-z0-9][a-z0-9._+-]{0,31}$/.test(extension),
    "Document extension must be empty or a lowercase ASCII extension up to 32 characters.",
  )
  .refine(
    (extension) => !knownDocumentExtensionSchema.safeParse(extension).success,
    "Known document extensions cannot be decoded as plain text.",
  )
  .brand<"PlainTextDocumentExtension">();
const documentExtensionSchema = z.union([
  knownDocumentExtensionSchema,
  plainTextDocumentExtensionSchema,
]);
const documentMediaTypeSchema = z.enum([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/html",
  "text/plain",
]);
const documentFormatSchema = z.object({
  extension: documentExtensionSchema,
  mediaType: documentMediaTypeSchema,
});

export type DocumentExtension = z.output<typeof documentExtensionSchema>;
export type DocumentMediaType = z.output<typeof documentMediaTypeSchema>;
type KnownDocumentExtension = z.output<typeof knownDocumentExtensionSchema>;

export interface DocumentFormat {
  extension: DocumentExtension;
  mediaType: DocumentMediaType;
}

interface DocumentSourceBase extends DocumentFormat {
  documentId: string;
  sourceFile: string;
}

export interface BufferedDocumentSource extends DocumentSourceBase {
  content: Buffer;
  kind: "buffer";
}

export interface FileDocumentSource extends DocumentSourceBase {
  byteLength: number;
  contentPath: string;
  kind: "file";
}

export type DocumentSource = BufferedDocumentSource | FileDocumentSource;

export const SUPPORTED_DOCUMENT_EXTENSIONS: readonly KnownDocumentExtension[] = [
  ".pdf",
  ".html",
  ".htm",
  ".docx",
  ".xlsx",
  ".pptx",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
];

const formatByExtension: ReadonlyMap<KnownDocumentExtension, DocumentFormat> = new Map([
  [".pdf", { extension: ".pdf", mediaType: "application/pdf" }],
  [".html", { extension: ".html", mediaType: "text/html" }],
  [".htm", { extension: ".htm", mediaType: "text/html" }],
  [
    ".pptx",
    {
      extension: ".pptx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
  ],
  [
    ".xlsx",
    {
      extension: ".xlsx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  ],
  [
    ".docx",
    {
      extension: ".docx",
      mediaType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
  ],
  [".png", { extension: ".png", mediaType: "image/png" }],
  [".jpg", { extension: ".jpg", mediaType: "image/jpeg" }],
  [".jpeg", { extension: ".jpeg", mediaType: "image/jpeg" }],
  [".webp", { extension: ".webp", mediaType: "image/webp" }],
]);

const standaloneImageExtensions: ReadonlySet<DocumentExtension> = new Set([
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);

export function isSupportedDocumentPath(filePath: string): boolean {
  return documentExtensionSchema.safeParse(extname(filePath).toLowerCase()).success;
}

export function readDocumentSourceByteLength(source: DocumentSource): number {
  return source.kind === "buffer" ? source.content.byteLength : source.byteLength;
}

export function readDocumentFormat(filePath: string): DocumentFormat {
  const extensionResult = documentExtensionSchema.safeParse(extname(filePath).toLowerCase());
  if (!extensionResult.success) {
    throw new Error(
      `Document filename extension is invalid for ${filePath}.`,
    );
  }
  const knownExtension = knownDocumentExtensionSchema.safeParse(extensionResult.data);
  if (knownExtension.success) {
    const format = formatByExtension.get(knownExtension.data);
    if (format === undefined) {
      throw new Error(`Document format is not configured: ${knownExtension.data}`);
    }
    return format;
  }
  return { extension: extensionResult.data, mediaType: "text/plain" };
}

export function decodeDocumentFormat(value: unknown): DocumentFormat {
  const result = documentFormatSchema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid document format: ${result.error.message}`);
  }
  const knownExtension = knownDocumentExtensionSchema.safeParse(result.data.extension);
  if (!knownExtension.success) {
    if (result.data.mediaType !== "text/plain") {
      throw new Error(
        `Media type ${result.data.mediaType} does not match plain-text extension ${result.data.extension || "<none>"}.`,
      );
    }
    return result.data;
  }
  const expected = formatByExtension.get(knownExtension.data);
  if (expected?.mediaType !== result.data.mediaType) {
    throw new Error(
      `Media type ${result.data.mediaType} does not match extension ${result.data.extension}.`,
    );
  }
  return result.data;
}

export function isStandaloneImageFormat(
  format: DocumentFormat,
): boolean {
  return standaloneImageExtensions.has(format.extension);
}

export function isPlainTextFormat(format: DocumentFormat): boolean {
  return format.mediaType === "text/plain";
}
