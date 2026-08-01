WITH "query_scope" AS MATERIALIZED (
  SELECT "document_id", "source_file"
  FROM unnest(
    $3::varchar[],
    $4::text[]
  ) AS "scope_target"("document_id", "source_file")
),
"candidates" AS MATERIALIZED (
  SELECT
    -("retrieval_lexical_chunks"."content" <@> to_bm25query($1, 'retrieval_lexical_chunks_content_bm25_idx')) AS "bm25Score",
    "retrieval_lexical_chunks".*
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
  ORDER BY
    "retrieval_lexical_chunks"."content" <@> to_bm25query($1, 'retrieval_lexical_chunks_content_bm25_idx'),
    "retrieval_lexical_chunks"."id" ASC
  LIMIT $5
)
SELECT
  "candidates"."bm25Score",
  "candidates"."document_id" AS "documentId",
  CASE
    WHEN "candidates"."representation_type" = 'table-description'
      THEN "exact_evidence"."evidence_content"
    ELSE "candidates"."evidence_content"
  END AS "evidenceContent",
  CASE
    WHEN "candidates"."representation_type" = 'table-description'
      THEN "exact_evidence"."id"
    WHEN "candidates"."representation_type" = 'image-description'
      THEN "candidates"."parent_id"
    ELSE "candidates"."id"
  END AS "evidenceRetrievalId",
  "candidates"."kind" AS "kind",
  "candidates"."parent_id" AS "parentId",
  "candidates"."id" AS "representationId",
  "candidates"."evidence_content" AS "representationContent",
  "candidates"."representation_type" AS "representationType",
  "candidates"."source_file" AS "sourceFile"
FROM "candidates"
LEFT JOIN LATERAL (
  SELECT
    "retrieval_lexical_chunks"."evidence_content",
    "retrieval_lexical_chunks"."id"
  FROM "retrieval_lexical_chunks"
  WHERE "candidates"."representation_type" = 'table-description'
    AND "retrieval_lexical_chunks"."representation_type" = 'exact-window'
    AND "retrieval_lexical_chunks"."document_id" = "candidates"."document_id"
    AND "retrieval_lexical_chunks"."source_file" = "candidates"."source_file"
    AND "retrieval_lexical_chunks"."embedding_space_id" = "candidates"."embedding_space_id"
    AND "retrieval_lexical_chunks"."generation_id" = "candidates"."generation_id"
    AND "retrieval_lexical_chunks"."parent_id" = "candidates"."parent_id"
  ORDER BY
    "retrieval_lexical_chunks"."content" <@> to_bm25query($1, 'retrieval_lexical_chunks_content_bm25_idx'),
    "retrieval_lexical_chunks"."id" ASC
  LIMIT 1
) AS "exact_evidence" ON TRUE
WHERE (
    "candidates"."representation_type" <> 'table-description'
    OR "exact_evidence"."id" IS NOT NULL
  )
ORDER BY
  "candidates"."bm25Score" DESC,
  "candidates"."id" ASC;
