WITH "query_scope" AS MATERIALIZED (
  SELECT "document_id", "source_file"
  FROM unnest(
    $3::varchar[],
    $4::text[]
  ) AS "scope_target"("document_id", "source_file")
),
"description_candidates" AS MATERIALIZED (
  SELECT
    -("retrieval_description_lexical_chunks"."content" <@> to_bm25query($1, 'retrieval_description_lexical_chunks_content_bm25_idx')) AS "bm25Score",
    "retrieval_description_lexical_chunks".*
  FROM "retrieval_description_lexical_chunks"
  INNER JOIN "indexed_document_spaces"
    ON "indexed_document_spaces"."document_id" = "retrieval_description_lexical_chunks"."document_id"
    AND "indexed_document_spaces"."source_file" = "retrieval_description_lexical_chunks"."source_file"
    AND "indexed_document_spaces"."embedding_space_id" = "retrieval_description_lexical_chunks"."embedding_space_id"
    AND "indexed_document_spaces"."generation_id" = "retrieval_description_lexical_chunks"."generation_id"
  INNER JOIN "query_scope"
    ON "query_scope"."document_id" = "retrieval_description_lexical_chunks"."document_id"
    AND "query_scope"."source_file" = "retrieval_description_lexical_chunks"."source_file"
  WHERE "retrieval_description_lexical_chunks"."embedding_space_id" = $2
  ORDER BY
    "retrieval_description_lexical_chunks"."content" <@> to_bm25query($1, 'retrieval_description_lexical_chunks_content_bm25_idx'),
    "retrieval_description_lexical_chunks"."id" ASC
  LIMIT $5
)
SELECT
  "description_candidates"."bm25Score",
  "description_candidates"."document_id" AS "documentId",
  CASE
    WHEN "description_candidates"."kind" = 'image'
      THEN "description_candidates"."description"
    ELSE "exact_evidence"."evidence_content"
  END AS "evidenceContent",
  CASE
    WHEN "description_candidates"."kind" = 'image'
      THEN "description_candidates"."parent_id"
    ELSE "exact_evidence"."id"
  END AS "evidenceRetrievalId",
  "description_candidates"."kind" AS "kind",
  "description_candidates"."parent_id" AS "parentId",
  "description_candidates"."id" AS "representationId",
  "description_candidates"."description" AS "representationContent",
  "description_candidates"."source_file" AS "sourceFile"
FROM "description_candidates"
LEFT JOIN LATERAL (
  SELECT
    "retrieval_lexical_chunks"."evidence_content",
    "retrieval_lexical_chunks"."id"
  FROM "retrieval_lexical_chunks"
  WHERE "description_candidates"."kind" = 'table'
    AND "retrieval_lexical_chunks"."document_id" = "description_candidates"."document_id"
    AND "retrieval_lexical_chunks"."source_file" = "description_candidates"."source_file"
    AND "retrieval_lexical_chunks"."embedding_space_id" = "description_candidates"."embedding_space_id"
    AND "retrieval_lexical_chunks"."generation_id" = "description_candidates"."generation_id"
    AND "retrieval_lexical_chunks"."parent_id" = "description_candidates"."parent_id"
  ORDER BY
    "retrieval_lexical_chunks"."content" <@> to_bm25query($1, 'retrieval_lexical_chunks_content_bm25_idx'),
    "retrieval_lexical_chunks"."id" ASC
  LIMIT 1
) AS "exact_evidence" ON TRUE
WHERE (
    "description_candidates"."kind" = 'image'
    OR "exact_evidence"."id" IS NOT NULL
  )
ORDER BY
  "description_candidates"."bm25Score" DESC,
  "description_candidates"."id" ASC;
