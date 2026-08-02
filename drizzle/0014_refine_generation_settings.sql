UPDATE "application_settings"
SET
  "defaults" = jsonb_set(
    "defaults" #- '{runtime,retrievalVariantConcurrency}',
    '{runtime,chatTemperature}',
    COALESCE(
      "defaults"#>'{runtime,chatTemperature}',
      "defaults"#>'{runtime,answerTemperature}',
      '0'::jsonb
    ),
    true
  ),
  "settings" = jsonb_set(
    "settings" #- '{runtime,retrievalVariantConcurrency}',
    '{runtime,chatTemperature}',
    COALESCE(
      "settings"#>'{runtime,chatTemperature}',
      "settings"#>'{runtime,answerTemperature}',
      '0'::jsonb
    ),
    true
  ),
  "updated_at" = now(),
  "version" = "version" + 1
WHERE
  "id" = 'runtime'
  AND (
    "defaults"#>'{runtime,retrievalVariantConcurrency}' IS NOT NULL
    OR "settings"#>'{runtime,retrievalVariantConcurrency}' IS NOT NULL
    OR "defaults"#>'{runtime,chatTemperature}' IS NULL
    OR "settings"#>'{runtime,chatTemperature}' IS NULL
  );--> statement-breakpoint

ALTER TABLE "research_turns" DISABLE TRIGGER "research_turns_publish";--> statement-breakpoint
ALTER TABLE "research_turns" DISABLE TRIGGER "research_turns_require_published";--> statement-breakpoint

UPDATE "research_turns"
SET "run_configuration" = "run_configuration" #- '{retrieval,variantConcurrency}'
WHERE "run_configuration"#>'{retrieval,variantConcurrency}' IS NOT NULL;--> statement-breakpoint

ALTER TABLE "research_turns" ENABLE TRIGGER "research_turns_require_published";--> statement-breakpoint
ALTER TABLE "research_turns" ENABLE TRIGGER "research_turns_publish";--> statement-breakpoint

UPDATE "chat_runs"
SET "run_configuration" = "run_configuration" #- '{retrieval,variantConcurrency}'
WHERE "run_configuration"#>'{retrieval,variantConcurrency}' IS NOT NULL;
