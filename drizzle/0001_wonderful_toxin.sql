CREATE TABLE "embedding_input_formats" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"document_template" text NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"input_format_hash" varchar(64) NOT NULL,
	"name" varchar(100) NOT NULL,
	"query_template" text NOT NULL,
	"retired_at" timestamp with time zone,
	"schema_version" integer NOT NULL,
	CONSTRAINT "embedding_input_formats_values_valid" CHECK (length(trim("embedding_input_formats"."name")) > 0
        AND "embedding_input_formats"."schema_version" > 0
        AND length("embedding_input_formats"."document_template")
          - length(replace("embedding_input_formats"."document_template", '{{text}}', '')) = 8
        AND length("embedding_input_formats"."query_template")
          - length(replace("embedding_input_formats"."query_template", '{{text}}', '')) = 8
        AND "embedding_input_formats"."input_format_hash" ~ '^[a-f0-9]{64}$'
        AND ("embedding_input_formats"."retired_at" IS NULL OR "embedding_input_formats"."retired_at" >= "embedding_input_formats"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "embedding_space_gc_spaces" ADD COLUMN "input_format_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "embedding_space_gc_spaces" ADD COLUMN "input_format_name" varchar(100);--> statement-breakpoint
ALTER TABLE "embedding_spaces" ADD COLUMN "input_format_document_template" text;--> statement-breakpoint
ALTER TABLE "embedding_spaces" ADD COLUMN "input_format_hash" varchar(64);--> statement-breakpoint
ALTER TABLE "embedding_spaces" ADD COLUMN "input_format_id" uuid;--> statement-breakpoint
ALTER TABLE "embedding_spaces" ADD COLUMN "input_format_query_template" text;--> statement-breakpoint
ALTER TABLE "embedding_spaces" ADD COLUMN "input_format_schema_version" integer;--> statement-breakpoint
CREATE INDEX "embedding_input_formats_retired_name_idx" ON "embedding_input_formats" USING btree ("retired_at","name");--> statement-breakpoint
ALTER TABLE "embedding_spaces" ADD CONSTRAINT "embedding_spaces_input_format_id_embedding_input_formats_id_fk" FOREIGN KEY ("input_format_id") REFERENCES "public"."embedding_input_formats"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embedding_spaces" ADD CONSTRAINT "embedding_spaces_input_format_snapshot_valid" CHECK ((
          "embedding_spaces"."input_format_document_template" IS NULL
          AND "embedding_spaces"."input_format_hash" IS NULL
          AND "embedding_spaces"."input_format_id" IS NULL
          AND "embedding_spaces"."input_format_query_template" IS NULL
          AND "embedding_spaces"."input_format_schema_version" IS NULL
        ) OR (
          "embedding_spaces"."input_format_document_template" IS NOT NULL
          AND "embedding_spaces"."input_format_hash" ~ '^[a-f0-9]{64}$'
          AND "embedding_spaces"."input_format_id" IS NOT NULL
          AND "embedding_spaces"."input_format_query_template" IS NOT NULL
          AND "embedding_spaces"."input_format_schema_version" > 0
        ));