import { z } from "zod";

import {
  DOCLING_CONTENT_LAYERS,
  DOCLING_SERVE_VERSION,
  DOCLING_VERSION,
} from "./model.js";

const MAXIMUM_IMAGE_DIMENSION = 16_384;
const MAXIMUM_IMAGE_PIXELS = 50_000_000;
const MAXIMUM_IMAGE_BYTES = 32 * 1_024 * 1_024;
const MAXIMUM_IMAGE_DATA_URI_LENGTH =
  "data:image/jpeg;base64,".length + 4 * Math.ceil(MAXIMUM_IMAGE_BYTES / 3);
const doclingImageMediaTypeSchema = z.enum([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const referenceSchema = z.object({
  $ref: z.string().regex(/^#(?:\/[\w-]+(?:\/\d+)?)?$/),
});
const boundingBoxSchema = z.object({
  b: z.number(),
  coord_origin: z.enum(["BOTTOMLEFT", "TOPLEFT"]).default("TOPLEFT"),
  l: z.number(),
  r: z.number(),
  t: z.number(),
});
const characterSpanSchema = z
  .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
  .refine(([start, end]) => end >= start, "character span end precedes its start");
const provenanceSchema = z.object({
  bbox: boundingBoxSchema,
  charspan: characterSpanSchema,
  page_no: z.number().int().positive(),
});
const contentLayerSchema = z.enum(DOCLING_CONTENT_LAYERS);
const groupSchema = z.object({
  children: z.array(referenceSchema).default([]),
  content_layer: contentLayerSchema.default("body"),
  label: z.string().min(1),
  name: z.string().min(1),
  parent: referenceSchema.nullable(),
  self_ref: z.string().min(1),
}).loose();
const textItemSchema = z.object({
  children: z.array(referenceSchema).default([]),
  content_layer: contentLayerSchema.default("body"),
  label: z.string().min(1),
  orig: z.string(),
  parent: referenceSchema.nullable(),
  prov: z.array(provenanceSchema).default([]),
  self_ref: z.string().min(1),
  text: z.string(),
}).loose();
const imageReferenceSchema = z.object({
  dpi: z.number().int().positive(),
  mimetype: doclingImageMediaTypeSchema,
  size: z.object({
    height: z.number().positive().max(MAXIMUM_IMAGE_DIMENSION),
    width: z.number().positive().max(MAXIMUM_IMAGE_DIMENSION),
  }),
  uri: z.string().min(1).max(MAXIMUM_IMAGE_DATA_URI_LENGTH),
}).superRefine((image, context) => {
  if (image.size.width * image.size.height > MAXIMUM_IMAGE_PIXELS) {
    context.addIssue({
      code: "custom",
      message: `image exceeds the ${MAXIMUM_IMAGE_PIXELS} pixel limit`,
      path: ["size"],
    });
  }
});
const pictureItemSchema = z.object({
  captions: z.array(referenceSchema).default([]),
  children: z.array(referenceSchema).default([]),
  content_layer: contentLayerSchema.default("body"),
  image: imageReferenceSchema.nullable().default(null),
  label: z.string().min(1),
  parent: referenceSchema.nullable(),
  prov: z.array(provenanceSchema).default([]),
  self_ref: z.string().min(1),
}).loose();
const tableCellSchema = z.object({
  col_span: z.number().int().positive().default(1),
  column_header: z.boolean().default(false),
  end_col_offset_idx: z.number().int().nonnegative(),
  end_row_offset_idx: z.number().int().nonnegative(),
  row_header: z.boolean().default(false),
  row_section: z.boolean().default(false),
  row_span: z.number().int().positive().default(1),
  start_col_offset_idx: z.number().int().nonnegative(),
  start_row_offset_idx: z.number().int().nonnegative(),
  text: z.string(),
}).loose();
const tableItemSchema = z.object({
  captions: z.array(referenceSchema).default([]),
  children: z.array(referenceSchema).default([]),
  content_layer: contentLayerSchema.default("body"),
  data: z.object({
    num_cols: z.number().int().nonnegative(),
    num_rows: z.number().int().nonnegative(),
    table_cells: z.array(tableCellSchema),
  }).loose(),
  label: z.string().min(1),
  parent: referenceSchema.nullable(),
  prov: z.array(provenanceSchema).default([]),
  self_ref: z.string().min(1),
}).loose();
const pageItemSchema = z.object({
  image: imageReferenceSchema.nullable().default(null),
  page_no: z.number().int().positive(),
  size: z.object({
    height: z.number().positive(),
    width: z.number().positive(),
  }),
}).loose();
const doclingDocumentSchema = z.object({
  body: groupSchema,
  form_items: z.array(z.unknown()).default([]),
  furniture: groupSchema,
  groups: z.array(groupSchema),
  key_value_items: z.array(z.unknown()).default([]),
  name: z.string().min(1),
  pages: z.record(z.string(), pageItemSchema),
  pictures: z.array(pictureItemSchema),
  schema_name: z.string().min(1),
  tables: z.array(tableItemSchema),
  texts: z.array(textItemSchema),
  version: z.string().min(1),
}).loose();
const doclingFailureCategorySchema = z.enum([
  "policy",
  "capacity",
  "source_unavailable",
  "target_unavailable",
  "timeout",
  "internal",
  "backend_failure",
  "inference_failure",
  "unknown",
]);
const conversionErrorSchema = z.object({
  category: doclingFailureCategorySchema.default("unknown"),
  component_type: z.string().min(1),
  error_message: z.string().min(1),
  module_name: z.string().min(1),
  page_no: z.number().int().positive().nullable().default(null),
});
const profilingItemSchema = z.object({
  count: z.number().int().nonnegative().default(0),
  scope: z.enum(["page", "document"]),
  start_timestamps: z.array(z.iso.datetime()).max(100_000).default([]),
  times: z.array(z.number().nonnegative()).max(100_000).default([]),
}).superRefine((item, context) => {
  if (item.count !== item.times.length) {
    context.addIssue({
      code: "custom",
      message: "profiling count does not match the number of durations",
      path: ["count"],
    });
  }
});

export const conversionResponseSchema = z.object({
  document: z.object({
    filename: z.string().min(1),
    json_content: doclingDocumentSchema.nullable(),
  }).loose(),
  errors: z.array(conversionErrorSchema).default([]),
  processing_time: z.number().nonnegative(),
  status: z.enum([
    "failure",
    "partial_success",
    "pending",
    "skipped",
    "started",
    "success",
  ]),
  timings: z.record(z.string().min(1).max(200), profilingItemSchema).default({}),
}).loose();

export const versionResponseSchema = z.object({
  docling: z.literal(DOCLING_VERSION),
  "docling-core": z.string().min(1),
  "docling-ibm-models": z.string().min(1),
  "docling-jobkit": z.string().min(1),
  "docling-parse": z.string().min(1),
  "docling-serve": z.literal(DOCLING_SERVE_VERSION),
});

export type RawBoundingBox = z.output<typeof boundingBoxSchema>;
export type RawCharacterSpan = z.output<typeof characterSpanSchema>;
export type RawConversionError = z.output<typeof conversionErrorSchema>;
export type RawDoclingDocument = z.output<typeof doclingDocumentSchema>;
export type RawGroup = z.output<typeof groupSchema>;
export type RawImageReference = z.output<typeof imageReferenceSchema>;
export type RawPage = z.output<typeof pageItemSchema>;
export type RawPictureItem = z.output<typeof pictureItemSchema>;
export type RawProvenance = z.output<typeof provenanceSchema>;
export type RawProfilingItem = z.output<typeof profilingItemSchema>;
export type RawTableCell = z.output<typeof tableCellSchema>;
export type RawTableItem = z.output<typeof tableItemSchema>;
export type RawTextItem = z.output<typeof textItemSchema>;
