CREATE TYPE "public"."mcp_task_status" AS ENUM('working', 'input_required', 'completed', 'cancelled', 'failed');--> statement-breakpoint
CREATE TABLE "mcp_tasks" (
	"cancellation_requested_at" timestamp with time zone,
	"client_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" jsonb,
	"id" uuid PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"lease_owner" uuid,
	"request" jsonb NOT NULL,
	"result" jsonb,
	"status" "mcp_task_status" DEFAULT 'working' NOT NULL,
	"status_message" text,
	"subject" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	CONSTRAINT "mcp_tasks_identity_check" CHECK (length("mcp_tasks"."client_id") > 0
        AND length("mcp_tasks"."issuer") > 0
        AND "mcp_tasks"."issuer" = trim("mcp_tasks"."issuer")
        AND length("mcp_tasks"."subject") > 0
        AND "mcp_tasks"."subject" = trim("mcp_tasks"."subject")),
	CONSTRAINT "mcp_tasks_payload_check" CHECK ((
        "mcp_tasks"."status" = 'completed'
        AND "mcp_tasks"."result" IS NOT NULL
        AND "mcp_tasks"."error" IS NULL
      ) OR (
        "mcp_tasks"."status" = 'failed'
        AND "mcp_tasks"."result" IS NULL
        AND "mcp_tasks"."error" IS NOT NULL
      ) OR (
        "mcp_tasks"."status" NOT IN ('completed', 'failed')
        AND "mcp_tasks"."result" IS NULL
        AND "mcp_tasks"."error" IS NULL
      )),
	CONSTRAINT "mcp_tasks_lease_check" CHECK ((
        "mcp_tasks"."lease_owner" IS NULL
        AND "mcp_tasks"."lease_expires_at" IS NULL
      ) OR (
        "mcp_tasks"."status" = 'working'
        AND "mcp_tasks"."lease_owner" IS NOT NULL
        AND "mcp_tasks"."lease_expires_at" IS NOT NULL
      )),
	CONSTRAINT "mcp_tasks_cancellation_check" CHECK ("mcp_tasks"."cancellation_requested_at" IS NULL OR "mcp_tasks"."status" = 'working')
);
--> statement-breakpoint
ALTER TABLE "mcp_tasks" ADD CONSTRAINT "mcp_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tasks" ADD CONSTRAINT "mcp_tasks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_tasks_dispatch_idx" ON "mcp_tasks" USING btree ("status","lease_expires_at","created_at");--> statement-breakpoint
CREATE INDEX "mcp_tasks_owner_idx" ON "mcp_tasks" USING btree ("issuer","subject","workspace_id","created_at");