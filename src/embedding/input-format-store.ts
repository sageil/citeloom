import { randomUUID } from "node:crypto";

import { asc, count, eq, sql } from "drizzle-orm";
import { z } from "zod";

import type { CiteLoomDatabase } from "../database/client.js";
import {
  applicationSettings,
  embeddingInputFormats,
  embeddingSpaces,
} from "../database/schema.js";
import { parseStoredApplicationSettings } from "../providers/settings-persistence.js";
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
const embeddingInputFormatSpaceCountRowSchema = z.object({
  embeddingSpaceCount: z.number().int().nonnegative(),
  inputFormatId: z.uuid(),
}).strict();

export interface EmbeddingInputFormatRecord
  extends EmbeddingInputFormatContract {
  createdAt: Date;
  retiredAt: Date | null;
}

export interface EmbeddingInputFormatRecordWithUsage
  extends EmbeddingInputFormatRecord {
  embeddingSpaceCount: number;
}

export class EmbeddingInputFormatNotFoundError extends Error {
  public constructor() {
    super("The embedding input format does not exist.");
    this.name = "EmbeddingInputFormatNotFoundError";
  }
}

export class EmbeddingInputFormatInUseError extends Error {
  public constructor(public readonly references: readonly string[]) {
    super(`The embedding input format is still in use by ${references.join(" and ")}.`);
    this.name = "EmbeddingInputFormatInUseError";
  }
}

type EmbeddingInputFormatDatabase = Pick<
  CiteLoomDatabase,
  "insert" | "select"
>;

export class EmbeddingInputFormatStore {
  public constructor(private readonly database: EmbeddingInputFormatDatabase) {}

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
        sql`${embeddingInputFormats.retiredAt} IS NOT NULL`,
        asc(embeddingInputFormats.name),
        asc(embeddingInputFormats.createdAt),
      );
    const formats: EmbeddingInputFormatRecord[] = [];
    for (const row of rows) {
      formats.push(decodeEmbeddingInputFormatRow(row));
    }
    return formats;
  }

  public async listWithEmbeddingSpaceCounts(): Promise<
    EmbeddingInputFormatRecordWithUsage[]
  > {
    const formats = await this.list();
    const rows = await this.database
      .select({
        embeddingSpaceCount: count(),
        inputFormatId: embeddingSpaces.inputFormatId,
      })
      .from(embeddingSpaces)
      .groupBy(embeddingSpaces.inputFormatId);
    const counts = new Map<string, number>();
    for (const row of rows) {
      const result = embeddingInputFormatSpaceCountRowSchema.safeParse(row);
      if (!result.success) {
        throw new Error(
          "Embedding space input-format usage is invalid.",
        );
      }
      counts.set(
        result.data.inputFormatId,
        result.data.embeddingSpaceCount,
      );
    }
    const formatsWithUsage: EmbeddingInputFormatRecordWithUsage[] = [];
    for (const format of formats) {
      formatsWithUsage.push({
        ...format,
        embeddingSpaceCount: counts.get(format.id) ?? 0,
      });
    }
    return formatsWithUsage;
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

export async function copyEmbeddingInputFormat(
  database: CiteLoomDatabase,
  sourceId: string,
  name: string,
): Promise<EmbeddingInputFormatRecord> {
  const store = new EmbeddingInputFormatStore(database);
  const source = await store.read(sourceId);
  if (source === null) {
    throw new EmbeddingInputFormatNotFoundError();
  }
  return store.create({
    documentTemplate: source.documentTemplate,
    name,
    queryTemplate: source.queryTemplate,
    schemaVersion: source.schemaVersion,
  });
}

export async function reviseEmbeddingInputFormat(
  database: CiteLoomDatabase,
  sourceId: string,
  definition: EmbeddingInputFormatDefinition,
): Promise<EmbeddingInputFormatRecord> {
  const store = new EmbeddingInputFormatStore(database);
  const source = await store.read(sourceId);
  if (source === null) {
    throw new EmbeddingInputFormatNotFoundError();
  }
  return store.create(definition);
}

export async function retireEmbeddingInputFormat(
  database: CiteLoomDatabase,
  id: string,
): Promise<EmbeddingInputFormatRecord> {
  return database.transaction(async (transaction) => {
    const rows = await transaction
      .select()
      .from(embeddingInputFormats)
      .where(eq(embeddingInputFormats.id, id))
      .limit(1)
      .for("update");
    const row = rows[0];
    if (row === undefined) {
      throw new EmbeddingInputFormatNotFoundError();
    }
    const format = decodeEmbeddingInputFormatRow(row);
    if (format.retiredAt !== null) {
      return format;
    }
    const references = await readEmbeddingInputFormatReferences(
      transaction,
      format.id,
    );
    if (references.length > 0) {
      throw new EmbeddingInputFormatInUseError(references);
    }
    const retiredAt = new Date();
    const updatedRows = await transaction
      .update(embeddingInputFormats)
      .set({ retiredAt })
      .where(eq(embeddingInputFormats.id, format.id))
      .returning();
    return decodeEmbeddingInputFormatRow(updatedRows[0]);
  });
}

type EmbeddingInputFormatTransaction = Parameters<
  Parameters<CiteLoomDatabase["transaction"]>[0]
>[0];

async function readEmbeddingInputFormatReferences(
  transaction: EmbeddingInputFormatTransaction,
  id: string,
): Promise<string[]> {
  const references: string[] = [];
  const spaceRows = await transaction
    .select({ id: embeddingSpaces.id })
    .from(embeddingSpaces)
    .where(eq(embeddingSpaces.inputFormatId, id))
    .limit(1);
  if (spaceRows.length > 0) {
    references.push("an embedding space");
  }
  const settingsRows = await transaction
    .select({
      defaults: applicationSettings.defaults,
      settings: applicationSettings.settings,
    })
    .from(applicationSettings)
    .where(eq(applicationSettings.id, "runtime"))
    .limit(1)
    .for("update");
  const settingsRow = settingsRows[0];
  if (settingsRow === undefined) {
    return references;
  }
  const defaults = parseStoredApplicationSettings(settingsRow.defaults);
  if (defaults.runtime.embeddingInputFormatId === id) {
    references.push("the application default");
  }
  const settings = parseStoredApplicationSettings(settingsRow.settings);
  if (settings.runtime.embeddingInputFormatId === id) {
    references.push("the selected application setting");
  }
  return references;
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
