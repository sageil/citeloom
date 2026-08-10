CREATE TABLE "source_content_migrations" (
	"active_slot" integer,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"copied_documents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error_message" text,
	"id" uuid PRIMARY KEY NOT NULL,
	"last_document_id" varchar(64),
	"lease_expires_at" timestamp with time zone,
	"lease_owner" uuid,
	"requested_by_user_id" uuid NOT NULL,
	"source_config" jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"state" varchar(32) NOT NULL,
	"target_config" jsonb NOT NULL,
	"total_documents" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"verified_documents" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "source_content_migrations_values_valid" CHECK ("source_content_migrations"."attempt_count" >= 0
        AND "source_content_migrations"."copied_documents" >= 0
        AND "source_content_migrations"."total_documents" >= 0
        AND "source_content_migrations"."verified_documents" >= 0
        AND ("source_content_migrations"."last_document_id" IS NULL OR "source_content_migrations"."last_document_id" ~ '^[a-f0-9]{64}$')
        AND jsonb_typeof("source_content_migrations"."source_config") = 'object'
        AND jsonb_typeof("source_content_migrations"."target_config") = 'object'
        AND "source_content_migrations"."state" IN (
          'queued',
          'validating',
          'copying',
          'cutover',
          'cancel_requested',
          'completed',
          'failed',
          'cancelled'
        )
        AND (
          (
            "source_content_migrations"."state" IN (
              'queued',
              'validating',
              'copying',
              'cutover',
              'cancel_requested'
            )
            AND "source_content_migrations"."active_slot" = 1
          )
          OR (
            "source_content_migrations"."state" IN ('completed', 'failed', 'cancelled')
            AND "source_content_migrations"."active_slot" IS NULL
          )
        )
        AND (
          ("source_content_migrations"."lease_owner" IS NULL AND "source_content_migrations"."lease_expires_at" IS NULL)
          OR ("source_content_migrations"."lease_owner" IS NOT NULL AND "source_content_migrations"."lease_expires_at" IS NOT NULL)
        )
        AND ("source_content_migrations"."completed_at" IS NULL OR "source_content_migrations"."completed_at" >= "source_content_migrations"."created_at")
        AND ("source_content_migrations"."started_at" IS NULL OR "source_content_migrations"."started_at" >= "source_content_migrations"."created_at"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "source_content_migrations_active_slot_idx" ON "source_content_migrations" USING btree ("active_slot") WHERE "source_content_migrations"."active_slot" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "source_content_migrations_state_lease_idx" ON "source_content_migrations" USING btree ("state","lease_expires_at");