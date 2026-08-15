ALTER TABLE "mcp_tasks" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "mcp_tasks"
SET "expires_at" = "created_at" + interval '30 days'
WHERE "expires_at" IS NULL;--> statement-breakpoint
ALTER TABLE "mcp_tasks" ALTER COLUMN "expires_at" SET NOT NULL;--> statement-breakpoint
UPDATE "application_settings"
SET
  "defaults" = jsonb_set(
    "defaults",
    '{runtime,mcpTaskRetentionDays}',
    COALESCE("defaults"#>'{runtime,mcpTaskRetentionDays}', '30'::jsonb),
    true
  ),
  "settings" = jsonb_set(
    "settings",
    '{runtime,mcpTaskRetentionDays}',
    COALESCE("settings"#>'{runtime,mcpTaskRetentionDays}', '30'::jsonb),
    true
  );--> statement-breakpoint
CREATE INDEX "mcp_tasks_retention_idx" ON "mcp_tasks" USING btree ("status","expires_at","id");--> statement-breakpoint
ALTER TABLE "mcp_tasks" ADD CONSTRAINT "mcp_tasks_expiry_check" CHECK ("mcp_tasks"."expires_at" > "mcp_tasks"."created_at");
