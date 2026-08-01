UPDATE "application_settings"
SET
  "defaults" = jsonb_set(
    "defaults",
    '{runtime,rerankDiscoveryMinimumScore}',
    '0.9'::jsonb,
    true
  ),
  "settings" = jsonb_set(
    "settings",
    '{runtime,rerankDiscoveryMinimumScore}',
    CASE
      WHEN
        "settings"#>'{runtime,rerankDiscoveryMinimumScore}' IS NULL
        OR "settings"#>'{runtime,rerankDiscoveryMinimumScore}'
          = "defaults"#>'{runtime,rerankDiscoveryMinimumScore}'
      THEN '0.9'::jsonb
      ELSE "settings"#>'{runtime,rerankDiscoveryMinimumScore}'
    END,
    true
  ),
  "updated_at" = now(),
  "version" = "version" + 1
WHERE
  "id" = 'runtime'
  AND (
    "defaults"#>'{runtime,rerankDiscoveryMinimumScore}'
      IS DISTINCT FROM '0.9'::jsonb
    OR "settings"#>'{runtime,rerankDiscoveryMinimumScore}' IS NULL
  );
