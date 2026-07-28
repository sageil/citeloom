import { z } from "zod";

import type {
  ImageElement,
  SourceRegion,
  TableElement,
} from "./source-elements.js";

const substantiveStringSchema = z.string().trim().min(1);

export const tableRetrievalDescriptionSchema = z.object({
  keyFacts: z.array(substantiveStringSchema),
  keywords: z.array(substantiveStringSchema),
  retrievalText: substantiveStringSchema,
}).strict();

export const imageTypeSchema = z.enum([
  "chart",
  "diagram",
  "screenshot",
  "map",
  "photograph",
  "illustration",
  "other",
]);

export const imageRetrievalDescriptionSchema = z.object({
  imageType: imageTypeSchema,
  isSubstantive: z.boolean(),
  keyFacts: z.array(substantiveStringSchema),
  keywords: z.array(substantiveStringSchema),
  retrievalText: substantiveStringSchema,
  visibleText: z.array(substantiveStringSchema),
}).strict();

export const omittedRetrievalDescriptionSchema = z.object({
  reason: substantiveStringSchema,
  status: z.literal("omitted"),
}).strict();

export const tableRetrievalDescriptionResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      description: tableRetrievalDescriptionSchema,
      status: z.literal("described"),
    }).strict(),
    omittedRetrievalDescriptionSchema,
  ],
);

export const imageRetrievalDescriptionResultSchema = z.discriminatedUnion(
  "status",
  [
    z.object({
      description: imageRetrievalDescriptionSchema,
      status: z.literal("described"),
    }).strict(),
    omittedRetrievalDescriptionSchema,
  ],
);

export type TableRetrievalDescription = z.output<
  typeof tableRetrievalDescriptionSchema
>;
export type ImageRetrievalDescription = z.output<
  typeof imageRetrievalDescriptionSchema
>;
export type TableRetrievalDescriptionResult = z.output<
  typeof tableRetrievalDescriptionResultSchema
>;
export type ImageRetrievalDescriptionResult = z.output<
  typeof imageRetrievalDescriptionResultSchema
>;

interface RetrievalDescriptionRecordBase {
  documentId: string;
  id: string;
  inputFingerprint: string;
  pageNumber: number | null;
  pageNumbers: number[];
  parentId: string;
  regions: SourceRegion[];
  sectionPath: string[];
  sourceFile: string;
  sourceRefs: string[];
}

export interface TableRetrievalDescriptionRecord
  extends RetrievalDescriptionRecordBase {
  kind: TableElement["kind"];
  result: TableRetrievalDescriptionResult;
}

export interface ImageRetrievalDescriptionRecord
  extends RetrievalDescriptionRecordBase {
  kind: ImageElement["kind"];
  result: ImageRetrievalDescriptionResult;
}

export type RetrievalDescriptionRecord =
  | ImageRetrievalDescriptionRecord
  | TableRetrievalDescriptionRecord;
