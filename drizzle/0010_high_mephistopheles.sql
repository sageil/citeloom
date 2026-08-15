CREATE TABLE "oauth_resource_settings" (
	"enabled" boolean DEFAULT false NOT NULL,
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"issuer" text,
	"resource" text,
	"scopes" text[] DEFAULT '{}' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"workspace_claim" text,
	CONSTRAINT "oauth_resource_settings_singleton_check" CHECK ("oauth_resource_settings"."id" = 'resource' AND "oauth_resource_settings"."version" > 0),
	CONSTRAINT "oauth_resource_settings_issuer_check" CHECK ("oauth_resource_settings"."issuer" IS NULL OR (
        length("oauth_resource_settings"."issuer") > 0
        AND "oauth_resource_settings"."issuer" = trim("oauth_resource_settings"."issuer")
      )),
	CONSTRAINT "oauth_resource_settings_resource_check" CHECK ("oauth_resource_settings"."resource" IS NULL OR (
        length("oauth_resource_settings"."resource") > 0
        AND "oauth_resource_settings"."resource" = trim("oauth_resource_settings"."resource")
      )),
	CONSTRAINT "oauth_resource_settings_workspace_claim_check" CHECK ("oauth_resource_settings"."workspace_claim" IS NULL OR (
        length("oauth_resource_settings"."workspace_claim") > 0
        AND "oauth_resource_settings"."workspace_claim" = trim("oauth_resource_settings"."workspace_claim")
      )),
	CONSTRAINT "oauth_resource_settings_enabled_values_check" CHECK ((
		NOT "oauth_resource_settings"."enabled"
		AND "oauth_resource_settings"."issuer" IS NULL
		AND "oauth_resource_settings"."resource" IS NULL
		AND cardinality("oauth_resource_settings"."scopes") = 0
		AND "oauth_resource_settings"."workspace_claim" IS NULL
	) OR (
		"oauth_resource_settings"."issuer" IS NOT NULL
		AND "oauth_resource_settings"."resource" IS NOT NULL
		AND cardinality("oauth_resource_settings"."scopes") > 0
		AND "oauth_resource_settings"."workspace_claim" IS NOT NULL
      ))
);
--> statement-breakpoint
ALTER TABLE "oauth_resource_settings" ADD CONSTRAINT "oauth_resource_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
