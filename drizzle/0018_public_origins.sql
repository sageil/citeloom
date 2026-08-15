UPDATE "application_settings"
SET
  "defaults" = jsonb_set(
    "defaults" #- '{runtime,publicOrigin}',
    '{runtime,publicOrigins}',
    jsonb_build_array("defaults"#>'{runtime,publicOrigin}'),
    true
  ),
  "settings" = jsonb_set(
    "settings" #- '{runtime,publicOrigin}',
    '{runtime,publicOrigins}',
    jsonb_build_array("settings"#>'{runtime,publicOrigin}'),
    true
  ),
  "updated_at" = now(),
  "version" = "version" + 1
WHERE
  "application_settings"."id" = 'runtime'
  AND "defaults"#>'{runtime,publicOrigin}' IS NOT NULL
  AND "settings"#>'{runtime,publicOrigin}' IS NOT NULL;
