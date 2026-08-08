CREATE TYPE "public"."research_verification_job_state" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "research_verification_jobs" (
	"turn_id" uuid PRIMARY KEY NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"state" "research_verification_job_state" DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "research_verification_jobs_counts_check" CHECK ("research_verification_jobs"."attempt_count" >= 0 AND "research_verification_jobs"."failure_count" >= 0),
	CONSTRAINT "research_verification_jobs_state_check" CHECK ((
          "research_verification_jobs"."state" = 'pending'
          AND "research_verification_jobs"."completed_at" IS NULL
          AND "research_verification_jobs"."lease_expires_at" IS NULL
        ) OR (
          "research_verification_jobs"."state" = 'running'
          AND "research_verification_jobs"."completed_at" IS NULL
          AND "research_verification_jobs"."lease_expires_at" IS NOT NULL
        ) OR (
          "research_verification_jobs"."state" IN ('completed', 'failed')
          AND "research_verification_jobs"."completed_at" IS NOT NULL
          AND "research_verification_jobs"."lease_expires_at" IS NULL
        )),
	CONSTRAINT "research_verification_jobs_error_check" CHECK (("research_verification_jobs"."state" = 'failed' AND "research_verification_jobs"."error_message" IS NOT NULL)
        OR "research_verification_jobs"."state" <> 'failed')
);
--> statement-breakpoint
ALTER TABLE "research_verification_jobs" ADD CONSTRAINT "research_verification_jobs_turn_id_research_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."research_turns"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "research_verification_jobs_dispatch_idx" ON "research_verification_jobs" USING btree ("state","available_at","lease_expires_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "enforce_research_verification_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  "current_state" "research_output_state";
  "target_turn_id" uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    "target_turn_id" := OLD."turn_id";
  ELSE
    "target_turn_id" := NEW."turn_id";
  END IF;

  SELECT "output_state"
  INTO "current_state"
  FROM "research_turns"
  WHERE "id" = "target_turn_id";

  IF NOT FOUND AND TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  IF "current_state" = 'building' OR (
    "current_state" = 'published'
    AND EXISTS (
      SELECT 1
      FROM "research_verification_jobs"
      WHERE
        "turn_id" = "target_turn_id"
        AND "state" = 'running'
    )
  ) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Published research verification is immutable without a running job for turn %.', "target_turn_id"
    USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "research_claim_checks_immutable_after_publication"
ON "research_claim_checks";
CREATE TRIGGER "research_claim_checks_immutable_after_publication"
BEFORE INSERT OR UPDATE OR DELETE ON "research_claim_checks"
FOR EACH ROW
EXECUTE FUNCTION "enforce_research_verification_mutation"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "research_claim_evidence_units_immutable_after_publication"
ON "research_claim_evidence_units";
CREATE TRIGGER "research_claim_evidence_units_immutable_after_publication"
BEFORE INSERT OR UPDATE OR DELETE ON "research_claim_evidence_units"
FOR EACH ROW
EXECUTE FUNCTION "enforce_research_verification_mutation"();
