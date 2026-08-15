ALTER TABLE "mcp_tasks" DROP CONSTRAINT "mcp_tasks_workspace_id_workspaces_id_fk";
--> statement-breakpoint
UPDATE "mcp_tasks" AS "task"
SET "result" = jsonb_build_object(
  'answer', "task"."result"->'structuredContent',
  'content', "task"."result"->'content',
  'resultType', 'complete',
  'workspaceIds', jsonb_build_array("task"."workspace_id")
)
WHERE "task"."result" IS NOT NULL;
--> statement-breakpoint
DROP INDEX "mcp_tasks_owner_idx";--> statement-breakpoint
CREATE INDEX "mcp_tasks_owner_idx" ON "mcp_tasks" USING btree ("issuer","subject","client_id","created_at");--> statement-breakpoint
ALTER TABLE "mcp_tasks" DROP COLUMN "workspace_id";
