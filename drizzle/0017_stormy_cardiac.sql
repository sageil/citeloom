DELETE FROM "mcp_tasks" WHERE "issuer" = 'citeloom:mcp-api-key';--> statement-breakpoint
DELETE FROM "mcp_api_keys";--> statement-breakpoint
ALTER TABLE "mcp_api_keys" DROP CONSTRAINT "mcp_api_keys_workspace_id_workspaces_id_fk";
--> statement-breakpoint
DROP INDEX "mcp_api_keys_user_workspace_idx";--> statement-breakpoint
CREATE INDEX "mcp_api_keys_user_created_idx" ON "mcp_api_keys" USING btree ("user_id","created_at");--> statement-breakpoint
ALTER TABLE "mcp_api_keys" DROP COLUMN "workspace_id";
