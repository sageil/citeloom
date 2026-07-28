import { z } from "zod";

import type { SourceRegion } from "./source-elements.js";

export const contentIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

export const corpusDocumentFileNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*\.(?:docx|html?|jpe?g|pdf|png|webp)$/);

export const imageMediaTypeSchema = z
  .string()
  .regex(/^image\/[a-z0-9.+-]+$/i);

export const sourceRegionSchema: z.ZodType<SourceRegion> = z.object({
  boundingBox: z.object({
    bottom: z.number().finite(),
    left: z.number().finite(),
    right: z.number().finite(),
    top: z.number().finite(),
  }).strict(),
  characterSpan: z.object({
    end: z.number().int().nonnegative(),
    start: z.number().int().nonnegative(),
  }).strict(),
  pageNumber: z.number().int().positive(),
}).strict();

export const tagSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
