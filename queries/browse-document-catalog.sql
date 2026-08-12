WITH accessible_libraries AS (
  SELECT libraries.id
  FROM source_libraries AS libraries
  LEFT JOIN workspace_library_grants AS grants
    ON grants.library_id = libraries.id
    AND grants.workspace_id = NULLIF($9, '')::uuid
  WHERE libraries.state = 'active'
    AND (
      $9 = ''
      OR libraries.owner_workspace_id = NULLIF($9, '')::uuid
      OR (libraries.kind = 'shared' AND grants.workspace_id IS NOT NULL)
    )
), active_spaces AS (
  SELECT
    spaces.source_file,
    array_agg(spaces.embedding_space_id ORDER BY spaces.embedding_space_id) AS embedding_space_ids
  FROM indexed_document_spaces AS spaces
  INNER JOIN indexed_documents AS indexed
    ON indexed.source_file = spaces.source_file
    AND indexed.document_id = spaces.document_id
  GROUP BY spaces.source_file
), media_description_progress AS (
  SELECT
    descriptions.generation_id,
    count(*) FILTER (
      WHERE descriptions.description->>'kind' = 'image'
    )::integer AS completed_images,
    count(*) FILTER (
      WHERE descriptions.description->>'kind' = 'table'
    )::integer AS completed_tables
  FROM retrieval_description_artifacts AS descriptions
  INNER JOIN ingestion_jobs AS active_jobs
    ON active_jobs.generation_id = descriptions.generation_id
  GROUP BY descriptions.generation_id
), catalog AS (
  SELECT
    jobs.source_file,
    jobs.source_library_id,
    jobs.document_id,
    indexed.document_id AS active_document_id,
    indexed.version_id AS active_version_id,
    COALESCE(active_spaces.embedding_space_ids, ARRAY[]::text[]) AS embedding_space_ids,
    jobs.error_message,
    jobs.control_error,
    jobs.control_state::text AS control_state,
    jobs.attempt_count,
    jobs.max_attempts,
    jobs.next_attempt_at,
    jobs.images,
    jobs.indexing_activity::text AS indexing_activity,
    jobs.page_count,
    jobs.phase::text AS phase,
    jobs.state::text AS status,
    jobs.tables,
    jobs.tags,
    jobs.text_chunks,
    jobs.total_elements,
    manifest.completed AS embedding_completed,
    manifest.next_element_position AS embedded_elements,
    COALESCE(media_progress.completed_images, 0) AS completed_images,
    COALESCE(media_progress.completed_tables, 0) AS completed_tables,
    jobs.uploaded_by_user_id,
    jobs.updated_at,
    source.byte_length
  FROM ingestion_jobs AS jobs
  LEFT JOIN indexed_documents AS indexed
    ON indexed.source_file = jobs.source_file
  LEFT JOIN active_spaces
    ON active_spaces.source_file = jobs.source_file
  LEFT JOIN ingestion_embedding_manifests AS manifest
    ON manifest.generation_id = jobs.generation_id
  LEFT JOIN media_description_progress AS media_progress
    ON media_progress.generation_id = jobs.generation_id
  LEFT JOIN source_documents AS source
    ON source.document_id = jobs.document_id
  WHERE (
    jobs.source_library_id IN (SELECT id FROM accessible_libraries)
    OR ($9 = '' AND $10 = '' AND jobs.source_library_id IS NULL)
  )
    AND ($10 = '' OR jobs.source_library_id = NULLIF($10, '')::uuid)

  UNION ALL

  SELECT
    indexed.source_file,
    indexed.source_library_id,
    indexed.document_id,
    indexed.document_id AS active_document_id,
    indexed.version_id AS active_version_id,
    COALESCE(active_spaces.embedding_space_ids, ARRAY[]::text[]) AS embedding_space_ids,
    NULL::text AS error_message,
    NULL::text AS control_error,
    'active'::text AS control_state,
    NULL::integer AS attempt_count,
    NULL::integer AS max_attempts,
    NULL::timestamptz AS next_attempt_at,
    indexed.images,
    NULL::text AS indexing_activity,
    indexed.page_count,
    NULL::text AS phase,
    'ready'::text AS status,
    indexed.tables,
    indexed.tags,
    indexed.text_chunks,
    indexed.total_elements,
    TRUE AS embedding_completed,
    indexed.total_elements AS embedded_elements,
    indexed.images AS completed_images,
    indexed.tables AS completed_tables,
    NULL::uuid AS uploaded_by_user_id,
    indexed.indexed_at AS updated_at,
    source.byte_length
  FROM indexed_documents AS indexed
  LEFT JOIN active_spaces
    ON active_spaces.source_file = indexed.source_file
  LEFT JOIN source_documents AS source
    ON source.document_id = indexed.document_id
  WHERE (
    indexed.source_library_id IN (SELECT id FROM accessible_libraries)
    OR ($9 = '' AND $10 = '' AND indexed.source_library_id IS NULL)
  )
  AND ($10 = '' OR indexed.source_library_id = NULLIF($10, '')::uuid)
  AND NOT EXISTS (
    SELECT 1
    FROM ingestion_jobs AS jobs
    WHERE jobs.source_file = indexed.source_file
  )
), classified AS (
  SELECT
    catalog.*,
    CASE
      WHEN $1 = ANY(catalog.embedding_space_ids) THEN 'ready'
      WHEN catalog.status = 'ready' THEN 'reindex-required'
      ELSE catalog.status
    END AS query_status,
    CASE
      WHEN catalog.status IN ('pending', 'running', 'failed') THEN catalog.status
      WHEN $1 = ANY(catalog.embedding_space_ids) THEN 'ready'
      ELSE 'reindex-required'
    END AS display_status
  FROM catalog
), records AS (
  SELECT
    classified.*,
    jsonb_build_object(
      'activeDocumentId', classified.active_document_id,
      'activeVersionId', classified.active_version_id,
      'attemptCount', classified.attempt_count,
      'byteLength', classified.byte_length,
      'controlError', classified.control_error,
      'controlState', classified.control_state,
      'displayStatus', classified.display_status,
      'documentId', classified.document_id,
      'embeddingSpaceIds', classified.embedding_space_ids,
      'errorMessage', classified.error_message,
      'images', classified.images,
      'indexingActivity', classified.indexing_activity,
      'embeddingProgress', CASE
        WHEN classified.embedding_completed IS TRUE THEN jsonb_build_object(
          'completedElements', classified.embedded_elements,
          'state', 'complete',
          'totalElements', classified.total_elements
        )
        WHEN classified.embedded_elements IS NOT NULL THEN jsonb_build_object(
          'completedElements', classified.embedded_elements,
          'state', 'in-progress',
          'totalElements', classified.total_elements
        )
        ELSE jsonb_build_object('state', 'not-started')
      END,
      'maxAttempts', classified.max_attempts,
      'nextAttemptAt', classified.next_attempt_at,
      'pageCount', classified.page_count,
      'phase', classified.phase,
      'queryStatus', classified.query_status,
      'mediaDescriptionProgress', jsonb_build_object(
        'completedImages', classified.completed_images,
        'completedTables', classified.completed_tables
      ),
      'sourceFile', classified.source_file,
      'sourceLibraryId', classified.source_library_id,
      'status', classified.status,
      'tables', classified.tables,
      'tags', classified.tags,
      'textChunks', classified.text_chunks,
      'totalElements', classified.total_elements,
      'uploadedByUserId', classified.uploaded_by_user_id,
      'updatedAt', classified.updated_at
    ) AS document
  FROM classified
), filtered AS (
  SELECT records.*
  FROM records
  WHERE (
    $2 = ''
    OR records.source_file ILIKE ('%' || $2 || '%')
    OR array_to_string(records.tags, ' ') ILIKE ('%' || $2 || '%')
  )
  AND (
    $3 = 'all'
    OR (
      $3 = 'processing'
      AND records.display_status IN ('pending', 'running')
      AND records.control_state IN ('active', 'pause_requested')
    )
    OR ($3 = 'queryable' AND records.query_status = 'ready')
    OR records.display_status = $3
  )
  AND ($4 = '' OR $4 = ANY(records.tags))
  AND (
    $5 = 'all'
    OR ($5 = 'uploads' AND position('/uploads/' IN records.source_file) > 0)
    OR ($5 = 'untagged' AND cardinality(records.tags) = 0)
    OR (
      left($5, 4) = 'tag:'
      AND substring($5 FROM 5) = ANY(records.tags)
    )
    OR (
      left($5, 5) = 'tags:'
      AND records.tags && string_to_array(substring($5 FROM 6), ',')
    )
  )
), ordered AS (
  SELECT
    filtered.*,
    row_number() OVER (
      ORDER BY
        CASE WHEN $6 = 'updated-desc' THEN filtered.updated_at END DESC,
        CASE WHEN $6 = 'updated-asc' THEN filtered.updated_at END ASC,
        CASE WHEN $6 = 'name-desc' THEN lower(filtered.source_file) END DESC,
        CASE WHEN $6 = 'name-asc' THEN lower(filtered.source_file) END ASC,
        lower(filtered.source_file) ASC
    ) AS row_order
  FROM filtered
), paged AS (
  SELECT ordered.*
  FROM ordered
  WHERE ordered.row_order > $8
    AND ordered.row_order <= ($8 + $7)
), attention_ordered AS (
  SELECT
    records.*,
    row_number() OVER (
      ORDER BY
        CASE records.display_status
          WHEN 'failed' THEN 0
          WHEN 'running' THEN 1
          ELSE 2
        END,
        records.updated_at DESC,
        lower(records.source_file) ASC
    ) AS row_order
  FROM records
  WHERE records.display_status = 'failed'
    OR (
      records.display_status IN ('running', 'pending')
      AND records.control_state IN ('active', 'pause_requested', 'cleanup_failed')
    )
), tag_counts AS (
  SELECT
    tag,
    count(*) AS total
  FROM records
  CROSS JOIN LATERAL unnest(records.tags) AS tag
  GROUP BY tag
), queryable_tag_counts AS (
  SELECT
    tag,
    count(*) AS total
  FROM records
  CROSS JOIN LATERAL unnest(records.tags) AS tag
  WHERE records.query_status = 'ready'
  GROUP BY tag
)
SELECT jsonb_build_object(
  'attention', jsonb_build_object(
    'documents', COALESCE(
      (
        SELECT jsonb_agg(attention_ordered.document ORDER BY attention_ordered.row_order)
        FROM attention_ordered
        WHERE attention_ordered.row_order <= 3
      ),
      '[]'::jsonb
    ),
    'total', (SELECT count(*) FROM attention_ordered)
  ),
  'documents', COALESCE(
    (SELECT jsonb_agg(paged.document ORDER BY paged.row_order) FROM paged),
    '[]'::jsonb
  ),
  'facets', jsonb_build_object(
    'failed', (SELECT count(*) FROM records WHERE display_status = 'failed'),
    'pending', (SELECT count(*) FROM records WHERE display_status = 'pending'),
    'processing', (
      SELECT count(*)
      FROM records
      WHERE display_status IN ('pending', 'running')
        AND control_state IN ('active', 'pause_requested')
    ),
    'queryable', (SELECT count(*) FROM records WHERE query_status = 'ready'),
    'queryableTags', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object('count', queryable_tag_counts.total, 'tag', queryable_tag_counts.tag)
          ORDER BY queryable_tag_counts.total DESC, queryable_tag_counts.tag ASC
        )
        FROM queryable_tag_counts
      ),
      '[]'::jsonb
    ),
    'ready', (SELECT count(*) FROM records WHERE display_status = 'ready'),
    'reindexRequired', (
      SELECT count(*)
      FROM records
      WHERE display_status = 'reindex-required'
    ),
    'running', (SELECT count(*) FROM records WHERE display_status = 'running'),
    'tags', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object('count', tag_counts.total, 'tag', tag_counts.tag)
          ORDER BY tag_counts.total DESC, tag_counts.tag ASC
        )
        FROM tag_counts
      ),
      '[]'::jsonb
    ),
    'total', (SELECT count(*) FROM records),
    'untagged', (SELECT count(*) FROM records WHERE cardinality(tags) = 0),
    'uploads', (
      SELECT count(*)
      FROM records
      WHERE position('/uploads/' IN source_file) > 0
    )
  ),
  'page', (($8 / $7) + 1),
  'pageSize', $7,
  'total', (SELECT count(*) FROM filtered)
) AS result;
