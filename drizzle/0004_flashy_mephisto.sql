CREATE TABLE "workspace_settings" (
	"settings" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_user_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	CONSTRAINT "workspace_settings_document_check" CHECK (jsonb_typeof("workspace_settings"."settings") = 'object'
        AND jsonb_typeof("workspace_settings"."settings"->'providerFeatures') = 'array'
        AND jsonb_typeof("workspace_settings"."settings"->'runtime') = 'object'
        AND "workspace_settings"."settings"->>'schemaVersion' = '1'),
	CONSTRAINT "workspace_settings_version_check" CHECK ("workspace_settings"."version" > 0)
);
--> statement-breakpoint
INSERT INTO "workspace_settings" ("settings", "workspace_id")
SELECT
	'{"providerFeatures":[],"runtime":{},"schemaVersion":1}'::jsonb,
	"id"
FROM "workspaces";--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE TRIGGER "workspace_settings_publish_revision"
AFTER INSERT OR UPDATE OR DELETE ON "workspace_settings"
FOR EACH ROW EXECUTE FUNCTION "publish_application_revision"('settings');
