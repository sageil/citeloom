import { z } from "zod";

import type { TableStructure } from "./source-elements.js";

export type CitationEvidence =
  | {
    excerpt: string;
    kind: "text";
  }
  | {
    content: string;
    kind: "table";
    table: TableStructure;
  }
  | {
    kind: "image";
    mimeType: string;
  };

const citationTableCellSchema = z.object({
  columnHeader: z.boolean(),
  columnSpan: z.number().int().positive(),
  endColumn: z.number().int().positive(),
  endRow: z.number().int().positive(),
  rowHeader: z.boolean(),
  rowSection: z.boolean(),
  rowSpan: z.number().int().positive(),
  startColumn: z.number().int().nonnegative(),
  startRow: z.number().int().nonnegative(),
  text: z.string(),
}).strict();

const citationTableStructureSchema: z.ZodType<TableStructure> = z.object({
  cells: z.array(citationTableCellSchema),
  columnCount: z.number().int().positive(),
  rowCount: z.number().int().positive(),
  rowEnd: z.number().int().positive(),
  rowStart: z.number().int().nonnegative(),
}).strict();

export const citationEvidenceSchema: z.ZodType<CitationEvidence> =
  z.discriminatedUnion("kind", [
    z.object({
      excerpt: z.string().min(1),
      kind: z.literal("text"),
    }).strict(),
    z.object({
      content: z.string().min(1),
      kind: z.literal("table"),
      table: citationTableStructureSchema,
    }).strict(),
    z.object({
      kind: z.literal("image"),
      mimeType: z.string().min(1),
    }).strict(),
  ]);
