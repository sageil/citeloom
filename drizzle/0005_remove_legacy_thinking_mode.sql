WITH "normalized_settings" AS (
  SELECT
    "id",
    jsonb_set(
      jsonb_set(
        "defaults" #- '{runtime,inferenceThinkingMode}',
        '{providers,connections}',
        COALESCE(
          (
            SELECT jsonb_object_agg(
              "connection"."key",
              "connection"."value" || jsonb_build_object(
                'thinkingMode',
                'disabled'
              )
            )
            FROM jsonb_each(
              "defaults"#>'{providers,connections}'
            ) AS "connection"
          ),
          '{}'::jsonb
        ),
        false
      ),
      '{providers,featureOverrides}',
      COALESCE(
        (
          SELECT jsonb_object_agg(
            "feature"."key",
            CASE
              WHEN "feature"."key" = ANY (
                ARRAY[
                  'answer',
                  'chat',
                  'queryExpansion',
                  'summarization'
                ]
              ) THEN "feature"."value" || jsonb_build_object(
                'thinkingModeOverride',
                null
              )
              ELSE "feature"."value"
            END
          )
          FROM jsonb_each(
            "defaults"#>'{providers,featureOverrides}'
          ) AS "feature"
        ),
        '{}'::jsonb
      ),
      false
    ) AS "defaults",
    jsonb_set(
      jsonb_set(
        "settings" #- '{runtime,inferenceThinkingMode}',
        '{providers,connections}',
        COALESCE(
          (
            SELECT jsonb_object_agg(
              "connection"."key",
              "connection"."value" || jsonb_build_object(
                'thinkingMode',
                'disabled'
              )
            )
            FROM jsonb_each(
              "settings"#>'{providers,connections}'
            ) AS "connection"
          ),
          '{}'::jsonb
        ),
        false
      ),
      '{providers,featureOverrides}',
      COALESCE(
        (
          SELECT jsonb_object_agg(
            "feature"."key",
            CASE
              WHEN "feature"."key" = ANY (
                ARRAY[
                  'answer',
                  'chat',
                  'queryExpansion',
                  'summarization'
                ]
              ) THEN "feature"."value" || jsonb_build_object(
                'thinkingModeOverride',
                null
              )
              ELSE "feature"."value"
            END
          )
          FROM jsonb_each(
            "settings"#>'{providers,featureOverrides}'
          ) AS "feature"
        ),
        '{}'::jsonb
      ),
      false
    ) AS "settings"
  FROM "application_settings"
)
UPDATE "application_settings"
SET
  "defaults" = "normalized_settings"."defaults",
  "settings" = "normalized_settings"."settings"
FROM "normalized_settings"
WHERE "application_settings"."id" = "normalized_settings"."id";
