WITH "candidates" AS MATERIALIZED (
  SELECT
    -(chunks."content" <@> to_bm25query($1, 'active_retrieval_lexical_bm25_idx')) AS "bm25Score",
    chunks."document_id",
    chunks."embedding_space_id",
    chunks."generation_id",
    chunks."representation_id",
    chunks."source_file"
  FROM "active_retrieval_lexical_chunks" AS chunks
  WHERE chunks."embedding_space_id" = $2
  ORDER BY
    chunks."content" <@> to_bm25query($1, 'active_retrieval_lexical_bm25_idx'),
    chunks."representation_id" ASC
  LIMIT $3
)
SELECT
  candidates."bm25Score",
  candidates."document_id" AS "documentId",
  publications."element_set_id" AS "elementSetId",
  CASE
    WHEN routes."evidence_mode" = 'parent-exact'
      THEN exact_evidence."evidence_content"
    ELSE direct_evidence."evidence_content"
  END AS "evidenceContent",
  CASE
    WHEN routes."evidence_mode" = 'parent-exact'
      THEN exact_evidence."evidence_id"
    ELSE direct_evidence."evidence_id"
  END AS "evidenceRetrievalId",
  candidates."generation_id" AS "generationId",
  routes."kind" AS "kind",
  routes."parent_id" AS "parentId",
  routes."representation_id" AS "representationId",
  routes."representation_content" AS "representationContent",
  routes."representation_type" AS "representationType",
  candidates."source_file" AS "sourceFile"
FROM candidates
INNER JOIN "active_retrieval_routes" AS routes
  ON routes."document_id" = candidates."document_id"
  AND routes."embedding_space_id" = candidates."embedding_space_id"
  AND routes."generation_id" = candidates."generation_id"
  AND routes."representation_id" = candidates."representation_id"
  AND routes."source_file" = candidates."source_file"
INNER JOIN "indexed_documents" AS publications
  ON publications."document_id" = routes."document_id"
  AND publications."source_file" = routes."source_file"
LEFT JOIN "active_retrieval_evidence" AS direct_evidence
  ON routes."evidence_mode" = 'direct'
  AND direct_evidence."document_id" = routes."document_id"
  AND direct_evidence."embedding_space_id" = routes."embedding_space_id"
  AND direct_evidence."generation_id" = routes."generation_id"
  AND direct_evidence."evidence_id" = routes."evidence_id"
  AND direct_evidence."source_file" = routes."source_file"
LEFT JOIN LATERAL (
  SELECT
    evidence."evidence_content",
    evidence."evidence_id"
  FROM "active_retrieval_lexical_chunks" AS exact_chunks
  INNER JOIN "active_retrieval_routes" AS exact_routes
    ON exact_routes."document_id" = exact_chunks."document_id"
    AND exact_routes."embedding_space_id" = exact_chunks."embedding_space_id"
    AND exact_routes."generation_id" = exact_chunks."generation_id"
    AND exact_routes."representation_id" = exact_chunks."representation_id"
    AND exact_routes."source_file" = exact_chunks."source_file"
  INNER JOIN "active_retrieval_evidence" AS evidence
    ON evidence."document_id" = exact_routes."document_id"
    AND evidence."embedding_space_id" = exact_routes."embedding_space_id"
    AND evidence."generation_id" = exact_routes."generation_id"
    AND evidence."evidence_id" = exact_routes."evidence_id"
    AND evidence."source_file" = exact_routes."source_file"
  WHERE routes."evidence_mode" = 'parent-exact'
    AND exact_routes."representation_type" = 'exact-window'
    AND exact_routes."document_id" = routes."document_id"
    AND exact_routes."embedding_space_id" = routes."embedding_space_id"
    AND exact_routes."generation_id" = routes."generation_id"
    AND exact_routes."parent_id" = routes."parent_id"
    AND exact_routes."source_file" = routes."source_file"
  ORDER BY
    exact_chunks."content" <@> to_bm25query($1, 'active_retrieval_lexical_bm25_idx'),
    exact_chunks."representation_id" ASC
  LIMIT 1
) AS exact_evidence ON TRUE
WHERE (
    routes."evidence_mode" = 'direct'
    AND direct_evidence."evidence_id" IS NOT NULL
  ) OR (
    routes."evidence_mode" = 'parent-exact'
    AND exact_evidence."evidence_id" IS NOT NULL
  )
ORDER BY candidates."bm25Score" DESC, candidates."representation_id" ASC;
