CREATE TEMPORARY TABLE "retrieval_title_embeddings_384" ON COMMIT DROP AS
SELECT DISTINCT ON (
  "embedding_space_id",
  "generation_id",
  "document_id",
  "source_file"
)
  "embedding_space_id",
  "generation_id",
  "document_id",
  "source_file",
  "embedding"
FROM "retrieval_description_chunks_384"
WHERE "representation_type" = 'document-title'
  AND "embedding_space_id" LIKE '%:representations-v2'
ORDER BY
  "embedding_space_id",
  "generation_id",
  "document_id",
  "source_file",
  "id";--> statement-breakpoint
CREATE TEMPORARY TABLE "retrieval_title_embeddings_768" ON COMMIT DROP AS
SELECT DISTINCT ON (
  "embedding_space_id",
  "generation_id",
  "document_id",
  "source_file"
)
  "embedding_space_id",
  "generation_id",
  "document_id",
  "source_file",
  "embedding"
FROM "retrieval_description_chunks"
WHERE "representation_type" = 'document-title'
  AND "embedding_space_id" LIKE '%:representations-v2'
ORDER BY
  "embedding_space_id",
  "generation_id",
  "document_id",
  "source_file",
  "id";--> statement-breakpoint
CREATE TEMPORARY TABLE "retrieval_title_embeddings_1024" ON COMMIT DROP AS
SELECT DISTINCT ON (
  "embedding_space_id",
  "generation_id",
  "document_id",
  "source_file"
)
  "embedding_space_id",
  "generation_id",
  "document_id",
  "source_file",
  "embedding"
FROM "retrieval_description_chunks_1024"
WHERE "representation_type" = 'document-title'
  AND "embedding_space_id" LIKE '%:representations-v2'
ORDER BY
  "embedding_space_id",
  "generation_id",
  "document_id",
  "source_file",
  "id";--> statement-breakpoint
UPDATE "retrieval_chunks_384" AS "chunk"
SET "embedding" = array_to_vector(
  ARRAY(
    SELECT (0.9 * "content_value" + 0.1 * "title_value")::real
    FROM unnest(vector_to_float4("chunk"."embedding", 384, false))
      WITH ORDINALITY AS "content"("content_value", "ordinal")
    INNER JOIN unnest(vector_to_float4("title"."embedding", 384, false))
      WITH ORDINALITY AS "document_title"("title_value", "ordinal")
      USING ("ordinal")
    ORDER BY "ordinal"
  ),
  384,
  false
)
FROM "retrieval_title_embeddings_384" AS "title"
WHERE "chunk"."embedding_space_id" = "title"."embedding_space_id"
  AND "chunk"."generation_id" = "title"."generation_id"
  AND "chunk"."document_id" = "title"."document_id"
  AND "chunk"."source_file" = "title"."source_file";--> statement-breakpoint
UPDATE "retrieval_chunks" AS "chunk"
SET "embedding" = array_to_vector(
  ARRAY(
    SELECT (0.9 * "content_value" + 0.1 * "title_value")::real
    FROM unnest(vector_to_float4("chunk"."embedding", 768, false))
      WITH ORDINALITY AS "content"("content_value", "ordinal")
    INNER JOIN unnest(vector_to_float4("title"."embedding", 768, false))
      WITH ORDINALITY AS "document_title"("title_value", "ordinal")
      USING ("ordinal")
    ORDER BY "ordinal"
  ),
  768,
  false
)
FROM "retrieval_title_embeddings_768" AS "title"
WHERE "chunk"."embedding_space_id" = "title"."embedding_space_id"
  AND "chunk"."generation_id" = "title"."generation_id"
  AND "chunk"."document_id" = "title"."document_id"
  AND "chunk"."source_file" = "title"."source_file";--> statement-breakpoint
UPDATE "retrieval_chunks_1024" AS "chunk"
SET "embedding" = array_to_vector(
  ARRAY(
    SELECT (0.9 * "content_value" + 0.1 * "title_value")::real
    FROM unnest(vector_to_float4("chunk"."embedding", 1024, false))
      WITH ORDINALITY AS "content"("content_value", "ordinal")
    INNER JOIN unnest(vector_to_float4("title"."embedding", 1024, false))
      WITH ORDINALITY AS "document_title"("title_value", "ordinal")
      USING ("ordinal")
    ORDER BY "ordinal"
  ),
  1024,
  false
)
FROM "retrieval_title_embeddings_1024" AS "title"
WHERE "chunk"."embedding_space_id" = "title"."embedding_space_id"
  AND "chunk"."generation_id" = "title"."generation_id"
  AND "chunk"."document_id" = "title"."document_id"
  AND "chunk"."source_file" = "title"."source_file";--> statement-breakpoint
UPDATE "retrieval_description_chunks_384" AS "chunk"
SET "embedding" = array_to_vector(
  ARRAY(
    SELECT (0.9 * "content_value" + 0.1 * "title_value")::real
    FROM unnest(vector_to_float4("chunk"."embedding", 384, false))
      WITH ORDINALITY AS "content"("content_value", "ordinal")
    INNER JOIN unnest(vector_to_float4("title"."embedding", 384, false))
      WITH ORDINALITY AS "document_title"("title_value", "ordinal")
      USING ("ordinal")
    ORDER BY "ordinal"
  ),
  384,
  false
)
FROM "retrieval_title_embeddings_384" AS "title"
WHERE "chunk"."embedding_space_id" = "title"."embedding_space_id"
  AND "chunk"."generation_id" = "title"."generation_id"
  AND "chunk"."document_id" = "title"."document_id"
  AND "chunk"."source_file" = "title"."source_file"
  AND "chunk"."representation_type" IN ('image-description', 'table-description');--> statement-breakpoint
UPDATE "retrieval_description_chunks" AS "chunk"
SET "embedding" = array_to_vector(
  ARRAY(
    SELECT (0.9 * "content_value" + 0.1 * "title_value")::real
    FROM unnest(vector_to_float4("chunk"."embedding", 768, false))
      WITH ORDINALITY AS "content"("content_value", "ordinal")
    INNER JOIN unnest(vector_to_float4("title"."embedding", 768, false))
      WITH ORDINALITY AS "document_title"("title_value", "ordinal")
      USING ("ordinal")
    ORDER BY "ordinal"
  ),
  768,
  false
)
FROM "retrieval_title_embeddings_768" AS "title"
WHERE "chunk"."embedding_space_id" = "title"."embedding_space_id"
  AND "chunk"."generation_id" = "title"."generation_id"
  AND "chunk"."document_id" = "title"."document_id"
  AND "chunk"."source_file" = "title"."source_file"
  AND "chunk"."representation_type" IN ('image-description', 'table-description');--> statement-breakpoint
UPDATE "retrieval_description_chunks_1024" AS "chunk"
SET "embedding" = array_to_vector(
  ARRAY(
    SELECT (0.9 * "content_value" + 0.1 * "title_value")::real
    FROM unnest(vector_to_float4("chunk"."embedding", 1024, false))
      WITH ORDINALITY AS "content"("content_value", "ordinal")
    INNER JOIN unnest(vector_to_float4("title"."embedding", 1024, false))
      WITH ORDINALITY AS "document_title"("title_value", "ordinal")
      USING ("ordinal")
    ORDER BY "ordinal"
  ),
  1024,
  false
)
FROM "retrieval_title_embeddings_1024" AS "title"
WHERE "chunk"."embedding_space_id" = "title"."embedding_space_id"
  AND "chunk"."generation_id" = "title"."generation_id"
  AND "chunk"."document_id" = "title"."document_id"
  AND "chunk"."source_file" = "title"."source_file"
  AND "chunk"."representation_type" IN ('image-description', 'table-description');--> statement-breakpoint
DELETE FROM "retrieval_description_lexical_chunks"
WHERE "representation_type" IN ('document-title', 'section-outline')
  AND "embedding_space_id" LIKE '%:representations-v2';--> statement-breakpoint
DELETE FROM "retrieval_description_chunks_384"
WHERE "representation_type" IN ('document-title', 'section-outline')
  AND "embedding_space_id" LIKE '%:representations-v2';--> statement-breakpoint
DELETE FROM "retrieval_description_chunks"
WHERE "representation_type" IN ('document-title', 'section-outline')
  AND "embedding_space_id" LIKE '%:representations-v2';--> statement-breakpoint
DELETE FROM "retrieval_description_chunks_1024"
WHERE "representation_type" IN ('document-title', 'section-outline')
  AND "embedding_space_id" LIKE '%:representations-v2';--> statement-breakpoint
WITH "description_counts" AS (
  SELECT "embedding_space_id", "generation_id", count(*) AS "row_count"
  FROM "retrieval_description_chunks_384"
  GROUP BY "embedding_space_id", "generation_id"
  UNION ALL
  SELECT "embedding_space_id", "generation_id", count(*) AS "row_count"
  FROM "retrieval_description_chunks"
  GROUP BY "embedding_space_id", "generation_id"
  UNION ALL
  SELECT "embedding_space_id", "generation_id", count(*) AS "row_count"
  FROM "retrieval_description_chunks_1024"
  GROUP BY "embedding_space_id", "generation_id"
),
"generation_counts" AS (
  SELECT
    "embedding_space_id",
    "generation_id",
    sum("row_count")::integer AS "row_count"
  FROM "description_counts"
  GROUP BY "embedding_space_id", "generation_id"
)
UPDATE "ingestion_embedding_manifests" AS "manifest"
SET "description_representation_count" = COALESCE(
  "generation_counts"."row_count",
  0
)
FROM "generation_counts"
WHERE "manifest"."embedding_space_id" = "generation_counts"."embedding_space_id"
  AND "manifest"."generation_id" = "generation_counts"."generation_id";--> statement-breakpoint
UPDATE "ingestion_embedding_manifests" AS "manifest"
SET "description_representation_count" = 0
WHERE "manifest"."embedding_space_id" LIKE '%:representations-v2'
  AND NOT EXISTS (
    SELECT 1
    FROM "retrieval_description_chunks_384"
    WHERE "retrieval_description_chunks_384"."embedding_space_id" = "manifest"."embedding_space_id"
      AND "retrieval_description_chunks_384"."generation_id" = "manifest"."generation_id"
    UNION ALL
    SELECT 1
    FROM "retrieval_description_chunks"
    WHERE "retrieval_description_chunks"."embedding_space_id" = "manifest"."embedding_space_id"
      AND "retrieval_description_chunks"."generation_id" = "manifest"."generation_id"
    UNION ALL
    SELECT 1
    FROM "retrieval_description_chunks_1024"
    WHERE "retrieval_description_chunks_1024"."embedding_space_id" = "manifest"."embedding_space_id"
      AND "retrieval_description_chunks_1024"."generation_id" = "manifest"."generation_id"
  );
