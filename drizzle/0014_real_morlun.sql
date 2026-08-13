CREATE TABLE "mcp_api_keys" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"id" uuid PRIMARY KEY NOT NULL,
	"label" varchar(100),
	"revoked_at" timestamp with time zone,
	"revoked_by_user_id" uuid,
	"scopes" text[] NOT NULL,
	"token_digest" varchar(64) NOT NULL,
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	CONSTRAINT "mcp_api_keys_expiry_check" CHECK ("mcp_api_keys"."expires_at" > "mcp_api_keys"."created_at"),
	CONSTRAINT "mcp_api_keys_label_check" CHECK ("mcp_api_keys"."label" IS NULL OR length(trim("mcp_api_keys"."label")) > 0),
	CONSTRAINT "mcp_api_keys_scopes_check" CHECK (cardinality("mcp_api_keys"."scopes") > 0
        AND "mcp_api_keys"."scopes" <@ ARRAY['citeloom.search', 'citeloom.answer']::text[]),
	CONSTRAINT "mcp_api_keys_token_digest_check" CHECK ("mcp_api_keys"."token_digest" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "mcp_api_keys" ADD CONSTRAINT "mcp_api_keys_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_api_keys" ADD CONSTRAINT "mcp_api_keys_revoked_by_user_id_users_id_fk" FOREIGN KEY ("revoked_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_api_keys" ADD CONSTRAINT "mcp_api_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_api_keys" ADD CONSTRAINT "mcp_api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_api_keys_token_digest_idx" ON "mcp_api_keys" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "mcp_api_keys_user_workspace_idx" ON "mcp_api_keys" USING btree ("user_id","workspace_id","created_at");