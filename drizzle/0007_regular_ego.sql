ALTER TYPE "public"."source_library_state" ADD VALUE 'deleting';--> statement-breakpoint
CREATE TABLE "source_library_deletion_sources" (
	"document_id" varchar(64) NOT NULL,
	"library_id" uuid NOT NULL,
	"source_file" text NOT NULL,
	CONSTRAINT "source_library_deletion_sources_library_id_source_file_document_id_pk" PRIMARY KEY("library_id","source_file","document_id")
);
--> statement-breakpoint
ALTER TABLE "workspaces" DROP CONSTRAINT "workspaces_slug_check";--> statement-breakpoint
DROP INDEX "workspaces_slug_idx";--> statement-breakpoint
ALTER TABLE "source_library_deletion_sources" ADD CONSTRAINT "source_library_deletion_sources_library_id_source_libraries_id_fk" FOREIGN KEY ("library_id") REFERENCES "public"."source_libraries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "source_library_deletion_sources_library_idx" ON "source_library_deletion_sources" USING btree ("library_id","source_file");--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "slug";