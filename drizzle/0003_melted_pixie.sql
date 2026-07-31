CREATE TYPE "public"."chat_verification_job_state" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "chat_verification_jobs" (
	"assistant_message_id" uuid PRIMARY KEY NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"state" "chat_verification_job_state" DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_verification_jobs_counts_check" CHECK ("chat_verification_jobs"."attempt_count" >= 0 AND "chat_verification_jobs"."failure_count" >= 0),
	CONSTRAINT "chat_verification_jobs_state_check" CHECK ((
          "chat_verification_jobs"."state" = 'pending'
          AND "chat_verification_jobs"."completed_at" IS NULL
          AND "chat_verification_jobs"."lease_expires_at" IS NULL
        ) OR (
          "chat_verification_jobs"."state" = 'running'
          AND "chat_verification_jobs"."completed_at" IS NULL
          AND "chat_verification_jobs"."lease_expires_at" IS NOT NULL
        ) OR (
          "chat_verification_jobs"."state" IN ('completed', 'failed')
          AND "chat_verification_jobs"."completed_at" IS NOT NULL
          AND "chat_verification_jobs"."lease_expires_at" IS NULL
        )),
	CONSTRAINT "chat_verification_jobs_error_check" CHECK (("chat_verification_jobs"."state" = 'failed' AND "chat_verification_jobs"."error_message" IS NOT NULL)
        OR "chat_verification_jobs"."state" <> 'failed')
);
--> statement-breakpoint
ALTER TABLE "chat_verification_jobs" ADD CONSTRAINT "chat_verification_jobs_assistant_message_id_chat_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_verification_jobs_dispatch_idx" ON "chat_verification_jobs" USING btree ("state","available_at","lease_expires_at");