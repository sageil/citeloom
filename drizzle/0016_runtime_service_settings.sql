WITH additions AS (
  SELECT $settings$
    {
      "applicationErrorMaximumRows": 100000,
      "applicationErrorRetentionDays": 30,
      "databasePoolMax": 10,
      "doclingAdditionalServiceInstances": [],
      "doclingNumThreads": 4,
      "doclingPageBatchSize": 4,
      "doclingProfilePipelineTimings": false,
      "doclingQueueMaxSize": 8,
      "doclingServeEngineWorkers": 1,
      "doclingServeShareModels": false,
      "hhemMaxAttentionCells": 20000000,
      "hhemMaxPaddedTokens": 20000,
      "hhemModelBatchSize": 20,
      "hhemTorchThreads": 4,
      "maxUploadRequestMegabytes": 100,
      "publicOrigin": "https://localhost:3443",
      "secureSessionCookie": true,
      "trustProxy": false
    }
  $settings$::jsonb AS value
)
UPDATE "application_settings"
SET
  "defaults" = jsonb_set(
    "defaults",
    '{runtime}',
    additions.value || COALESCE("defaults"->'runtime', '{}'::jsonb),
    true
  ),
  "settings" = jsonb_set(
    "settings",
    '{runtime}',
    additions.value || COALESCE("settings"->'runtime', '{}'::jsonb),
    true
  ),
  "updated_at" = now(),
  "version" = "version" + 1
FROM additions
WHERE "application_settings"."id" = 'runtime';
