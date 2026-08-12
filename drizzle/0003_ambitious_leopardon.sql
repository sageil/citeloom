CREATE TYPE "public"."global_role" AS ENUM('global_admin', 'standard');--> statement-breakpoint
CREATE TYPE "public"."source_library_access" AS ENUM('use', 'manage');--> statement-breakpoint
CREATE TYPE "public"."source_library_kind" AS ENUM('private', 'shared');--> statement-breakpoint
CREATE TYPE "public"."source_library_state" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."workspace_state" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TABLE "source_libraries" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" "source_library_kind" NOT NULL,
	"name" text NOT NULL,
	"owner_workspace_id" uuid,
	"state" "source_library_state" DEFAULT 'active' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "source_libraries_owner_check" CHECK (("source_libraries"."kind" = 'private' AND "source_libraries"."owner_workspace_id" IS NOT NULL)
        OR ("source_libraries"."kind" = 'shared' AND "source_libraries"."owner_workspace_id" IS NULL)),
	CONSTRAINT "source_libraries_name_check" CHECK (length(trim("source_libraries"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_audit_events" (
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" varchar(100) NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	CONSTRAINT "workspace_audit_events_type_check" CHECK (length(trim("workspace_audit_events"."event_type")) > 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_library_grants" (
	"access" "source_library_access" DEFAULT 'use' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"library_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	CONSTRAINT "workspace_library_grants_workspace_id_library_id_pk" PRIMARY KEY("workspace_id","library_id")
);
--> statement-breakpoint
ALTER TABLE "indexed_documents" ADD COLUMN "source_library_id" uuid;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD COLUMN "source_library_id" uuid;--> statement-breakpoint
ALTER TABLE "research_threads" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "global_role" "global_role" DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "state" "workspace_state" DEFAULT 'active' NOT NULL;--> statement-breakpoint
INSERT INTO "source_libraries" (
	"id",
	"kind",
	"name",
	"owner_workspace_id",
	"state"
)
SELECT
	gen_random_uuid(),
	'private',
	workspace."name" || ' sources',
	workspace."id",
	'active'
FROM "workspaces" AS workspace
ON CONFLICT DO NOTHING;--> statement-breakpoint
WITH original_workspace AS (
	SELECT "id"
	FROM "workspaces"
	ORDER BY "created_at", "id"
	LIMIT 1
), original_library AS (
	SELECT library."id"
	FROM "source_libraries" AS library
	INNER JOIN original_workspace
		ON original_workspace."id" = library."owner_workspace_id"
	WHERE library."kind" = 'private'
)
UPDATE "indexed_documents"
SET "source_library_id" = original_library."id"
FROM original_library
WHERE "indexed_documents"."source_library_id" IS NULL;--> statement-breakpoint
WITH original_workspace AS (
	SELECT "id"
	FROM "workspaces"
	ORDER BY "created_at", "id"
	LIMIT 1
), original_library AS (
	SELECT library."id"
	FROM "source_libraries" AS library
	INNER JOIN original_workspace
		ON original_workspace."id" = library."owner_workspace_id"
	WHERE library."kind" = 'private'
)
UPDATE "ingestion_jobs"
SET "source_library_id" = original_library."id"
FROM original_library
WHERE "ingestion_jobs"."source_library_id" IS NULL;--> statement-breakpoint
WITH original_workspace AS (
	SELECT "id"
	FROM "workspaces"
	ORDER BY "created_at", "id"
	LIMIT 1
)
UPDATE "research_threads"
SET "workspace_id" = original_workspace."id"
FROM original_workspace
WHERE "research_threads"."workspace_id" IS NULL;--> statement-breakpoint
UPDATE "users" AS application_user
SET "global_role" = 'global_admin'
WHERE EXISTS (
		SELECT 1
		FROM "workspace_memberships" AS membership
		WHERE membership."user_id" = application_user."id"
			AND membership."role" = 'admin'
	);--> statement-breakpoint
ALTER TABLE "source_libraries" ADD CONSTRAINT "source_libraries_owner_workspace_id_workspaces_id_fk" FOREIGN KEY ("owner_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_audit_events" ADD CONSTRAINT "workspace_audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_audit_events" ADD CONSTRAINT "workspace_audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_library_grants" ADD CONSTRAINT "workspace_library_grants_library_id_source_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."source_libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_library_grants" ADD CONSTRAINT "workspace_library_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "source_libraries_private_workspace_idx" ON "source_libraries" USING btree ("owner_workspace_id") WHERE "source_libraries"."kind" = 'private';--> statement-breakpoint
CREATE INDEX "source_libraries_owner_idx" ON "source_libraries" USING btree ("owner_workspace_id","state");--> statement-breakpoint
CREATE INDEX "workspace_audit_events_workspace_idx" ON "workspace_audit_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "workspace_library_grants_library_idx" ON "workspace_library_grants" USING btree ("library_id","workspace_id");--> statement-breakpoint
ALTER TABLE "indexed_documents" ADD CONSTRAINT "indexed_documents_source_library_id_source_libraries_id_fk" FOREIGN KEY ("source_library_id") REFERENCES "public"."source_libraries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_source_library_id_source_libraries_id_fk" FOREIGN KEY ("source_library_id") REFERENCES "public"."source_libraries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_threads" ADD CONSTRAINT "research_threads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "indexed_documents_library_idx" ON "indexed_documents" USING btree ("source_library_id","source_file");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_library_idx" ON "ingestion_jobs" USING btree ("source_library_id","source_file");--> statement-breakpoint
CREATE INDEX "research_threads_workspace_updated_idx" ON "research_threads" USING btree ("workspace_id","updated_at");
