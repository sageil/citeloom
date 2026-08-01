CREATE TABLE "retrieval_toc_artifacts" (
	"artifact" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_id" varchar(64) NOT NULL,
	"element_set_id" varchar(64) NOT NULL,
	"generation_id" uuid PRIMARY KEY NOT NULL,
	"source_file" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retrieval_toc_artifacts" ADD CONSTRAINT "retrieval_toc_artifacts_element_set_id_document_element_sets_id_fk" FOREIGN KEY ("element_set_id") REFERENCES "public"."document_element_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "retrieval_toc_document_idx" ON "retrieval_toc_artifacts" USING btree ("document_id");
--> statement-breakpoint
UPDATE "application_settings"
SET
	"defaults" = jsonb_set(
		"defaults",
		'{runtime,doclingTocEnabled}',
		'true'::jsonb,
		true
	),
	"settings" = jsonb_set(
		"settings",
		'{runtime,doclingTocEnabled}',
		COALESCE(
			"settings"#>'{runtime,doclingTocEnabled}',
			'true'::jsonb
		),
		true
	),
	"updated_at" = now(),
	"version" = "version" + 1
WHERE "id" = 'runtime'
	AND (
		"defaults"#>'{runtime,doclingTocEnabled}' IS NULL
		OR "settings"#>'{runtime,doclingTocEnabled}' IS NULL
	);
