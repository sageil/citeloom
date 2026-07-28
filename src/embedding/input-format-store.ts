import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";
import { z } from "zod";

import type { CiteLoomDatabase } from "../database/client.js";
import { embeddingInputFormats } from "../database/schema.js";
import {
  createEmbeddingInputFormatContract,
  readEmbeddingInputFormatContract,
  readEmbeddingInputFormatDefinition,
  type EmbeddingInputFormatContract,
  type EmbeddingInputFormatDefinition,
} from "./input-format-model.js";

const embeddingInputFormatRowSchema = z.object({
  createdAt: z.date(),
  documentTemplate: z.string(),
  id: z.uuid(),
  inputFormatHash: z.string(),
  name: z.string(),
  queryTemplate: z.string(),
  retiredAt: z.date().nullable(),
  schemaVersion: z.number().int(),
}).strict();

export interface EmbeddingInputFormatRecord
  extends EmbeddingInputFormatContract {
  createdAt: Date;
  retiredAt: Date | null;
}

export class EmbeddingInputFormatStore {
  public constructor(private readonly database: CiteLoomDatabase) {}

  public async create(
    value: EmbeddingInputFormatDefinition,
  ): Promise<EmbeddingInputFormatRecord> {
    const definition = readEmbeddingInputFormatDefinition(value);
    const contract = createEmbeddingInputFormatContract(
      randomUUID(),
      definition,
    );
    const rows = await this.database
      .insert(embeddingInputFormats)
      .values({
        documentTemplate: contract.documentTemplate,
        id: contract.id,
        inputFormatHash: contract.inputFormatHash,
        name: contract.name,
        queryTemplate: contract.queryTemplate,
        schemaVersion: contract.schemaVersion,
      })
      .returning();
    return decodeEmbeddingInputFormatRow(rows[0]);
  }

  public async list(): Promise<EmbeddingInputFormatRecord[]> {
    const rows = await this.database
      .select()
      .from(embeddingInputFormats)
      .orderBy(
        asc(embeddingInputFormats.retiredAt),
        asc(embeddingInputFormats.name),
        asc(embeddingInputFormats.createdAt),
      );
    const formats: EmbeddingInputFormatRecord[] = [];
    for (const row of rows) {
      formats.push(decodeEmbeddingInputFormatRow(row));
    }
    return formats;
  }

  public async read(id: string): Promise<EmbeddingInputFormatRecord | null> {
    const rows = await this.database
      .select()
      .from(embeddingInputFormats)
      .where(eq(embeddingInputFormats.id, id))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : decodeEmbeddingInputFormatRow(row);
  }
}

function decodeEmbeddingInputFormatRow(
  value: unknown,
): EmbeddingInputFormatRecord {
  const result = embeddingInputFormatRowSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `Invalid embedding input-format row: ${result.error.message}`,
    );
  }
  const contract = readEmbeddingInputFormatContract({
    documentTemplate: result.data.documentTemplate,
    id: result.data.id,
    inputFormatHash: result.data.inputFormatHash,
    name: result.data.name,
    queryTemplate: result.data.queryTemplate,
    schemaVersion: result.data.schemaVersion,
  });
  return {
    ...contract,
    createdAt: result.data.createdAt,
    retiredAt: result.data.retiredAt,
  };
}
