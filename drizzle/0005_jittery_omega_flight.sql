UPDATE "workspaces"
SET "name" = 'DefaultSpace', "updated_at" = now()
WHERE "name" = 'CiteLoom' AND "slug" = 'citeloom';
--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_name_normalized_idx" ON "workspaces" USING btree (lower(trim("name")));
