CREATE TABLE "oauth_user_identity_links" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"issuer" text NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "oauth_user_identity_links_issuer_subject_pk" PRIMARY KEY("issuer","subject"),
	CONSTRAINT "oauth_user_identity_links_issuer_check" CHECK (length("oauth_user_identity_links"."issuer") > 0 AND "oauth_user_identity_links"."issuer" = trim("oauth_user_identity_links"."issuer")),
	CONSTRAINT "oauth_user_identity_links_subject_check" CHECK (length("oauth_user_identity_links"."subject") > 0 AND "oauth_user_identity_links"."subject" = trim("oauth_user_identity_links"."subject"))
);
--> statement-breakpoint
CREATE TABLE "oauth_workspace_links" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by_user_id" uuid,
	"external_workspace_id" text NOT NULL,
	"issuer" text NOT NULL,
	"workspace_id" uuid NOT NULL,
	CONSTRAINT "oauth_workspace_links_issuer_external_workspace_id_pk" PRIMARY KEY("issuer","external_workspace_id"),
	CONSTRAINT "oauth_workspace_links_external_id_check" CHECK (length("oauth_workspace_links"."external_workspace_id") > 0 AND "oauth_workspace_links"."external_workspace_id" = trim("oauth_workspace_links"."external_workspace_id")),
	CONSTRAINT "oauth_workspace_links_issuer_check" CHECK (length("oauth_workspace_links"."issuer") > 0 AND "oauth_workspace_links"."issuer" = trim("oauth_workspace_links"."issuer"))
);
--> statement-breakpoint
ALTER TABLE "oauth_user_identity_links" ADD CONSTRAINT "oauth_user_identity_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_user_identity_links" ADD CONSTRAINT "oauth_user_identity_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_workspace_links" ADD CONSTRAINT "oauth_workspace_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_workspace_links" ADD CONSTRAINT "oauth_workspace_links_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_user_identity_links_issuer_user_idx" ON "oauth_user_identity_links" USING btree ("issuer","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_workspace_links_issuer_workspace_idx" ON "oauth_workspace_links" USING btree ("issuer","workspace_id");