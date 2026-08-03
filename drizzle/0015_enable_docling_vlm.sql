UPDATE "application_settings"
SET
  "defaults" = jsonb_set(
    "defaults",
    '{runtime}',
    COALESCE("defaults"->'runtime', '{}'::jsonb) || jsonb_build_object(
      'doclingPipeline', 'standard',
      'doclingVlmProviderId', 'ollama',
      'doclingVlmModelOverride', 'frob/unlimited-ocr:q8_0',
      'doclingVlmPrompt', 'document parsing.',
      'doclingVlmMaxOutputTokens', 32768
    ),
    true
  ),
  "settings" = jsonb_set(
    "settings",
    '{runtime}',
    COALESCE("settings"->'runtime', '{}'::jsonb) || jsonb_build_object(
      'doclingPipeline', COALESCE(
        "settings"#>'{runtime,doclingPipeline}',
        to_jsonb('standard'::text)
      ),
      'doclingVlmProviderId', COALESCE(
        "settings"#>'{runtime,doclingVlmProviderId}',
        to_jsonb('ollama'::text)
      ),
      'doclingVlmModelOverride', COALESCE(
        "settings"#>'{runtime,doclingVlmModelOverride}',
        to_jsonb('frob/unlimited-ocr:q8_0'::text)
      ),
      'doclingVlmPrompt', COALESCE(
        "settings"#>'{runtime,doclingVlmPrompt}',
        to_jsonb('document parsing.'::text)
      ),
      'doclingVlmMaxOutputTokens', COALESCE(
        "settings"#>'{runtime,doclingVlmMaxOutputTokens}',
        '32768'::jsonb
      )
    ),
    true
  ),
  "updated_at" = now(),
  "version" = "version" + 1
WHERE
  "id" = 'runtime'
  AND (
    "defaults"#>'{runtime,doclingPipeline}'
      IS DISTINCT FROM to_jsonb('standard'::text)
    OR "defaults"#>'{runtime,doclingVlmProviderId}'
      IS DISTINCT FROM to_jsonb('ollama'::text)
    OR "defaults"#>'{runtime,doclingVlmModelOverride}'
      IS DISTINCT FROM to_jsonb('frob/unlimited-ocr:q8_0'::text)
    OR "defaults"#>'{runtime,doclingVlmPrompt}'
      IS DISTINCT FROM to_jsonb('document parsing.'::text)
    OR "defaults"#>'{runtime,doclingVlmMaxOutputTokens}'
      IS DISTINCT FROM '32768'::jsonb
    OR "settings"#>'{runtime,doclingPipeline}' IS NULL
    OR "settings"#>'{runtime,doclingVlmProviderId}' IS NULL
    OR "settings"#>'{runtime,doclingVlmModelOverride}' IS NULL
    OR "settings"#>'{runtime,doclingVlmPrompt}' IS NULL
    OR "settings"#>'{runtime,doclingVlmMaxOutputTokens}' IS NULL
  );
