WITH "query_scope" AS MATERIALIZED (
  SELECT "document_id", "generation_id", "source_file"
  FROM unnest(
    $3::varchar[],
    $4::uuid[],
    $5::text[]
  ) AS "scope_target"("document_id", "generation_id", "source_file")
)
SELECT DISTINCT
  chunks."document_id" AS "documentId",
  chunks."source_file" AS "sourceFile"
FROM "retrieval_lexical_chunks" AS chunks
INNER JOIN "query_scope" AS scope
  ON scope."document_id" = chunks."document_id"
  AND scope."generation_id" = chunks."generation_id"
  AND scope."source_file" = chunks."source_file"
WHERE chunks."embedding_space_id" = $2
  AND -(chunks."content" <@> to_bm25query($1, 'retrieval_lexical_chunks_content_bm25_idx')) > 0
ORDER BY chunks."document_id", chunks."source_file";
