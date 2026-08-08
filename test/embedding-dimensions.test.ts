import { readdir, readFile } from "node:fs/promises";

import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  chatMessageEmbeddings1536,
  chatMessageEmbeddings2048,
  retrievalChunks1536,
  retrievalChunks2048,
} from "../src/database/schema.js";
import {
  embeddingDimensionsSchema,
  readEmbeddingVector,
  SUPPORTED_EMBEDDING_DIMENSIONS,
} from "../src/embedding/dimensions.js";
import {
  CHAT_MESSAGE_EMBEDDING_TABLES,
  readChatMessageEmbeddingTable,
  readRetrievalVectorTable,
  RETRIEVAL_VECTOR_TABLES,
} from "../src/embedding/storage-tables.js";

describe("application embedding dimensions", () => {
  it("accepts exactly the dimensions supported by application storage", () => {
    expect(SUPPORTED_EMBEDDING_DIMENSIONS)
      .toEqual([384, 768, 1024, 1536, 2048]);
    for (const dimensions of SUPPORTED_EMBEDDING_DIMENSIONS) {
      expect(embeddingDimensionsSchema.parse(dimensions)).toBe(dimensions);
    }
    expect(embeddingDimensionsSchema.safeParse(512).success).toBe(false);
  });

  it("routes 1536 retrieval and chat embeddings to vector tables", () => {
    const retrievalTable = readRetrievalVectorTable(1_536);
    const chatTable = readChatMessageEmbeddingTable(1_536);

    expect(retrievalTable).toBe(retrievalChunks1536);
    expect(chatTable).toBe(chatMessageEmbeddings1536);
    expect(getTableName(retrievalTable)).toBe("retrieval_chunks_1536");
    expect(getTableName(chatTable)).toBe("chat_message_embeddings_1536");
    expect(getTableColumns(retrievalTable).embedding.getSQLType())
      .toBe("vector(1536)");
    expect(getTableColumns(chatTable).embedding.getSQLType())
      .toBe("vector(1536)");
  });

  it("validates a 2048-dimensional embedding", () => {
    const embedding = Array.from({ length: 2_048 }, () => 0);
    embedding[0] = 0.25;
    expect(readEmbeddingVector(embedding, 2_048, "test embedding"))
      .toEqual(embedding);
    expect(() => readEmbeddingVector(
      embedding.slice(0, -1),
      2_048,
      "test embedding",
    )).toThrow("expected 2048 finite numbers");
  });

  it("routes 2048 retrieval and chat embeddings to halfvec tables", () => {
    const retrievalTable = readRetrievalVectorTable(2_048);
    const chatTable = readChatMessageEmbeddingTable(2_048);

    expect(retrievalTable).toBe(retrievalChunks2048);
    expect(chatTable).toBe(chatMessageEmbeddings2048);
    expect(getTableName(retrievalTable)).toBe("retrieval_chunks_2048");
    expect(getTableName(chatTable)).toBe("chat_message_embeddings_2048");
    expect(getTableColumns(retrievalTable).embedding.getSQLType())
      .toBe("halfvec(2048)");
    expect(getTableColumns(chatTable).embedding.getSQLType())
      .toBe("halfvec(2048)");
  });

  it("registers one retrieval table for every supported dimension", () => {
    const tableNames = RETRIEVAL_VECTOR_TABLES.map((table) => {
      return getTableName(table);
    });
    expect(tableNames).toEqual([
      "retrieval_chunks_384",
      "retrieval_chunks",
      "retrieval_chunks_1024",
      "retrieval_chunks_1536",
      "retrieval_chunks_2048",
    ]);
    const chatTableNames = CHAT_MESSAGE_EMBEDDING_TABLES.map((table) => {
      return getTableName(table);
    });
    expect(chatTableNames).toEqual([
      "chat_message_embeddings_384",
      "chat_message_embeddings_768",
      "chat_message_embeddings_1024",
      "chat_message_embeddings_1536",
      "chat_message_embeddings_2048",
    ]);
  });

  it("keeps the complete vector schema in the baseline migration", async () => {
    const drizzleDirectory = new URL("../drizzle/", import.meta.url);
    const migrationFiles: string[] = [];
    const sqlFiles: string[] = [];
    for (const entry of await readdir(drizzleDirectory)) {
      if (entry.endsWith(".sql")) {
        sqlFiles.push(entry);
      }
      if (/^\d{4}_.+\.sql$/u.test(entry)) {
        migrationFiles.push(entry);
      }
    }
    sqlFiles.sort();
    expect(sqlFiles).toEqual([
      "0000_citeloom_schema.sql",
      "0001_add_research_verification_jobs.sql",
      "bootstrap.sql",
    ]);
    expect(migrationFiles).toEqual([
      "0000_citeloom_schema.sql",
      "0001_add_research_verification_jobs.sql",
    ]);

    const migration = await readFile(
      new URL("0000_citeloom_schema.sql", drizzleDirectory),
      "utf8",
    );
    expect(migration).toContain('CREATE TABLE "retrieval_chunks_2048"');
    expect(migration).toContain('CREATE TABLE "retrieval_chunks_1536"');
    expect(migration).toContain('"embedding" vector(1536) NOT NULL');
    expect(migration).toContain(
      '"retrieval_chunks_1536_embedding_hnsw_idx"',
    );
    expect(migration).toContain('"embedding" halfvec(2048) NOT NULL');
    expect(migration).toContain(
      '"retrieval_chunks_2048_embedding_hnsw_idx"',
    );
    expect(migration).toContain("halfvec_cosine_ops");

    const journal = await readFile(
      new URL("meta/_journal.json", drizzleDirectory),
      "utf8",
    );
    expect(journal).toContain('"tag": "0000_citeloom_schema"');
    expect(journal).toContain('"tag": "0001_add_research_verification_jobs"');
  });
});
