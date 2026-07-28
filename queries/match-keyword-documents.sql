WITH "query_scope" AS MATERIALIZED (
  SELECT "document_id", "source_file"
  FROM unnest(
    $3::varchar[],
    $4::text[]
  ) AS "scope_target"("document_id", "source_file")
)
SELECT DISTINCT
  "retrieval_lexical_chunks"."document_id" AS "documentId",
  "retrieval_lexical_chunks"."source_file" AS "sourceFile"
FROM "retrieval_lexical_chunks"
INNER JOIN "indexed_document_spaces"
  ON "indexed_document_spaces"."document_id" = "retrieval_lexical_chunks"."document_id"
  AND "indexed_document_spaces"."source_file" = "retrieval_lexical_chunks"."source_file"
  AND "indexed_document_spaces"."embedding_space_id" = "retrieval_lexical_chunks"."embedding_space_id"
  AND "indexed_document_spaces"."generation_id" = "retrieval_lexical_chunks"."generation_id"
INNER JOIN "query_scope"
  ON "query_scope"."document_id" = "retrieval_lexical_chunks"."document_id"
  AND "query_scope"."source_file" = "retrieval_lexical_chunks"."source_file"
WHERE "retrieval_lexical_chunks"."embedding_space_id" = $2
  AND -("retrieval_lexical_chunks"."content" <@> to_bm25query($1, 'retrieval_lexical_chunks_content_bm25_idx')) > 0
ORDER BY "retrieval_lexical_chunks"."document_id", "retrieval_lexical_chunks"."source_file";
