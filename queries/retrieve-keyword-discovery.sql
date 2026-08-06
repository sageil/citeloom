WITH query_scope AS MATERIALIZED (
  SELECT document_id, generation_id, source_file
  FROM unnest(
    $3::varchar[],
    $4::uuid[],
    $5::text[]
  ) AS scope_target(document_id, generation_id, source_file)
), matches AS (
  SELECT
    -("content" <@> to_bm25query($1, 'retrieval_lexical_chunks_content_bm25_idx')) AS score,
    "retrieval_lexical_chunks"."document_id" AS document_id,
    "retrieval_lexical_chunks"."parent_id" AS parent_id,
    "retrieval_lexical_chunks"."source_file" AS source_file,
    "retrieval_lexical_chunks"."evidence_content"
  FROM "retrieval_lexical_chunks"
  INNER JOIN query_scope
    ON query_scope.document_id = "retrieval_lexical_chunks"."document_id"
    AND query_scope.generation_id = "retrieval_lexical_chunks"."generation_id"
    AND query_scope.source_file = "retrieval_lexical_chunks"."source_file"
  WHERE "retrieval_lexical_chunks"."embedding_space_id" = $2
    AND -("retrieval_lexical_chunks"."content" <@> to_bm25query($1, 'retrieval_lexical_chunks_content_bm25_idx')) > 0
), document_stats AS (
  SELECT
    document_id,
    source_file,
    max(score) AS best_score,
    count(*)::integer AS matching_passage_count
  FROM matches
  GROUP BY document_id, source_file
), paged_documents AS (
  SELECT
    document_id,
    source_file,
    best_score,
    matching_passage_count
  FROM document_stats
  ORDER BY best_score DESC, document_id, source_file
  LIMIT $6
  OFFSET $7
), ranked_passages AS (
  SELECT
    matches.document_id,
    matches.parent_id,
    matches.source_file,
    matches.evidence_content,
    paged_documents.best_score,
    paged_documents.matching_passage_count,
    row_number() OVER (
      PARTITION BY matches.document_id, matches.source_file
      ORDER BY matches.score DESC, matches.parent_id
    ) AS passage_rank
  FROM matches
  INNER JOIN paged_documents
    ON paged_documents.document_id = matches.document_id
    AND paged_documents.source_file = matches.source_file
), selected_passages AS (
  SELECT *
  FROM ranked_passages
  WHERE passage_rank <= $8
)
SELECT jsonb_build_object(
  'matches', COALESCE(
    (
      SELECT jsonb_agg(
        jsonb_build_object(
          'documentId', selected_passages.document_id,
          'matchingPassageCount', selected_passages.matching_passage_count,
          'parentId', selected_passages.parent_id,
          'sourceFile', selected_passages.source_file,
          'evidenceContent', selected_passages.evidence_content
        )
        ORDER BY
          selected_passages.best_score DESC,
          selected_passages.document_id,
          selected_passages.source_file,
          selected_passages.passage_rank
      )
      FROM selected_passages
    ),
    '[]'::jsonb
  ),
  'totalDocuments', (SELECT count(*) FROM document_stats)
) AS result;
