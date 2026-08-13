CREATE TYPE "public"."authentication_configuration_event_type" AS ENUM('staged', 'activated', 'disabled', 'recovered');--> statement-breakpoint
CREATE TYPE "public"."authentication_mode" AS ENUM('local', 'oauth');--> statement-breakpoint
CREATE TABLE "authentication_configuration_events" (
	"actor_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"event_type" "authentication_configuration_event_type" NOT NULL,
	"from_mode" "authentication_mode" NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"settings_version" integer NOT NULL,
	"to_mode" "authentication_mode" NOT NULL,
	CONSTRAINT "authentication_configuration_events_version_check" CHECK ("authentication_configuration_events"."settings_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "authentication_settings" (
	"active_oauth_configuration" jsonb,
	"activated_at" timestamp with time zone,
	"activated_by_user_id" uuid,
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"mode" "authentication_mode" DEFAULT 'local' NOT NULL,
	"staged_oauth_configuration" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "authentication_settings_singleton_check" CHECK ("authentication_settings"."id" = 'application' AND "authentication_settings"."version" > 0),
	CONSTRAINT "authentication_settings_active_configuration_check" CHECK (("authentication_settings"."mode" = 'local' AND "authentication_settings"."active_oauth_configuration" IS NULL)
        OR ("authentication_settings"."mode" = 'oauth' AND "authentication_settings"."active_oauth_configuration" IS NOT NULL)),
	CONSTRAINT "authentication_settings_staged_configuration_check" CHECK ("authentication_settings"."staged_oauth_configuration" IS NULL OR (
        jsonb_typeof("authentication_settings"."staged_oauth_configuration") = 'object'
        AND "authentication_settings"."staged_oauth_configuration"->>'schemaVersion' = '1'
      )),
	CONSTRAINT "authentication_settings_active_oauth_document_check" CHECK ("authentication_settings"."active_oauth_configuration" IS NULL OR (
        jsonb_typeof("authentication_settings"."active_oauth_configuration") = 'object'
        AND "authentication_settings"."active_oauth_configuration"->>'schemaVersion' = '1'
      ))
);
--> statement-breakpoint
INSERT INTO "authentication_settings" ("id", "mode", "version")
VALUES ('application', 'local', 1);
--> statement-breakpoint
ALTER TABLE "authentication_configuration_events" ADD CONSTRAINT "authentication_configuration_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authentication_settings" ADD CONSTRAINT "authentication_settings_activated_by_user_id_users_id_fk" FOREIGN KEY ("activated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authentication_settings" ADD CONSTRAINT "authentication_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authentication_configuration_events_created_idx" ON "authentication_configuration_events" USING btree ("created_at","id");
