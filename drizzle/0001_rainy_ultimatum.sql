ALTER TABLE "application_settings" DROP CONSTRAINT "application_settings_documents_valid";--> statement-breakpoint
ALTER TABLE "application_settings" ADD CONSTRAINT "application_settings_documents_valid" CHECK (jsonb_typeof("application_settings"."defaults") = 'object'
        AND jsonb_typeof("application_settings"."defaults"->'providers') = 'object'
        AND jsonb_typeof("application_settings"."defaults"->'runtime') = 'object'
        AND COALESCE(jsonb_typeof("application_settings"."defaults"->'sourceContent'), '') = 'object'
        AND (
          (
            COALESCE("application_settings"."defaults"#>>'{sourceContent,kind}', 'filesystem') = 'filesystem'
            AND COALESCE(jsonb_typeof("application_settings"."defaults"#>'{sourceContent,directory}'), '') = 'string'
            AND COALESCE("application_settings"."defaults"#>>'{sourceContent,directory}', '') <> ''
          )
          OR (
            "application_settings"."defaults"#>>'{sourceContent,kind}' = 's3'
            AND COALESCE("application_settings"."defaults"#>>'{sourceContent,bucket}', '') <> ''
            AND COALESCE("application_settings"."defaults"#>>'{sourceContent,endpointUrl}', '') <> ''
            AND COALESCE(jsonb_typeof("application_settings"."defaults"#>'{sourceContent,forcePathStyle}'), '') = 'boolean'
            AND COALESCE("application_settings"."defaults"#>>'{sourceContent,prefix}', '') <> ''
            AND COALESCE("application_settings"."defaults"#>>'{sourceContent,region}', '') <> ''
          )
        )
        AND "application_settings"."defaults"->>'schemaVersion' = '1'
        AND jsonb_typeof("application_settings"."settings") = 'object'
        AND jsonb_typeof("application_settings"."settings"->'providers') = 'object'
        AND jsonb_typeof("application_settings"."settings"->'runtime') = 'object'
        AND COALESCE(jsonb_typeof("application_settings"."settings"->'sourceContent'), '') = 'object'
        AND (
          (
            COALESCE("application_settings"."settings"#>>'{sourceContent,kind}', 'filesystem') = 'filesystem'
            AND COALESCE(jsonb_typeof("application_settings"."settings"#>'{sourceContent,directory}'), '') = 'string'
            AND COALESCE("application_settings"."settings"#>>'{sourceContent,directory}', '') <> ''
          )
          OR (
            "application_settings"."settings"#>>'{sourceContent,kind}' = 's3'
            AND COALESCE("application_settings"."settings"#>>'{sourceContent,bucket}', '') <> ''
            AND COALESCE("application_settings"."settings"#>>'{sourceContent,endpointUrl}', '') <> ''
            AND COALESCE(jsonb_typeof("application_settings"."settings"#>'{sourceContent,forcePathStyle}'), '') = 'boolean'
            AND COALESCE("application_settings"."settings"#>>'{sourceContent,prefix}', '') <> ''
            AND COALESCE("application_settings"."settings"#>>'{sourceContent,region}', '') <> ''
          )
        )
        AND "application_settings"."settings"->>'schemaVersion' = '1');