import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import type { EmbeddingSpaceConfig } from "../../config/index.js";
import type { CiteLoomDatabase } from "../../database/client.js";
import { embeddingSpaces } from "../../database/schema.js";
import { EMBEDDING_DIMENSIONS } from "../../embedding/dimensions.js";

const SHARED_ACTIVE_PROJECTION_TABLES = [
  "active_retrieval_evidence",
  "active_retrieval_lexical_chunks",
  "active_retrieval_routes",
] as const;

const ACTIVE_VECTOR_TABLE_BY_DIMENSIONS = {
  [EMBEDDING_DIMENSIONS.DIMENSION_384]: "active_retrieval_chunks_384",
  [EMBEDDING_DIMENSIONS.DIMENSION_768]: "active_retrieval_chunks",
  [EMBEDDING_DIMENSIONS.DIMENSION_1024]: "active_retrieval_chunks_1024",
  [EMBEDDING_DIMENSIONS.DIMENSION_1536]: "active_retrieval_chunks_1536",
  [EMBEDDING_DIMENSIONS.DIMENSION_2048]: "active_retrieval_chunks_2048",
} as const;

export async function ensureActiveRetrievalSpacePartitions(
  database: CiteLoomDatabase,
  space: EmbeddingSpaceConfig,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.execute(sql`
      SELECT pg_advisory_xact_lock(hashtextextended(${space.id}, 0))
    `);
    const literalRows = await transaction.select({
      value: sql<string>`quote_literal(${space.id})`,
    })
      .from(embeddingSpaces)
      .limit(1);
    const spaceLiteral = literalRows[0]?.value;
    if (spaceLiteral === undefined || spaceLiteral.length === 0) {
      throw new Error(`Cannot quote embedding space identifier ${space.id}.`);
    }
    const tableNames: string[] = [...SHARED_ACTIVE_PROJECTION_TABLES];
    tableNames.push(ACTIVE_VECTOR_TABLE_BY_DIMENSIONS[space.dimensions]);
    for (const tableName of tableNames) {
      const partitionName = createPartitionName(tableName, space.id);
      await transaction.execute(sql`
        CREATE TABLE IF NOT EXISTS ${sql.identifier(partitionName)}
        PARTITION OF ${sql.identifier(tableName)}
        FOR VALUES IN (${sql.raw(spaceLiteral)})
      `);
    }
  });
}

export function createActiveRetrievalPartitionName(
  tableName: string,
  embeddingSpaceId: string,
): string {
  return createPartitionName(tableName, embeddingSpaceId);
}

function createPartitionName(
  tableName: string,
  embeddingSpaceId: string,
): string {
  const suffix = createHash("md5")
    .update(embeddingSpaceId)
    .digest("hex")
    .slice(0, 16);
  return `${tableName}_p_${suffix}`;
}
