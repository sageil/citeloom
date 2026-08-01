UPDATE "application_settings"
SET
  "defaults" = jsonb_set(
    jsonb_set(
      "defaults",
      '{runtime,findSourcesPassagesPerDocument}',
      '3'::jsonb,
      true
    ),
    '{runtime,findSourcesResults}',
    '10'::jsonb,
    true
  ),
  "settings" = jsonb_set(
    jsonb_set(
      "settings",
      '{runtime,findSourcesPassagesPerDocument}',
      COALESCE(
        "settings"#>'{runtime,findSourcesPassagesPerDocument}',
        '3'::jsonb
      ),
      true
    ),
    '{runtime,findSourcesResults}',
    COALESCE(
      "settings"#>'{runtime,findSourcesResults}',
      '10'::jsonb
    ),
    true
  ),
  "updated_at" = now(),
  "version" = "version" + 1
WHERE
  "id" = 'runtime'
  AND (
    "defaults"#>'{runtime,findSourcesPassagesPerDocument}'
      IS DISTINCT FROM '3'::jsonb
    OR "defaults"#>'{runtime,findSourcesResults}'
      IS DISTINCT FROM '10'::jsonb
    OR "settings"#>'{runtime,findSourcesPassagesPerDocument}' IS NULL
    OR "settings"#>'{runtime,findSourcesResults}' IS NULL
  );
